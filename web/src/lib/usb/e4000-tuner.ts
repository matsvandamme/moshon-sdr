/**
 * Elonics E4000 tuner driver.
 *
 * Used by the Nooelec NeSDR Smartee XTR and a handful of older RTL2832U
 * dongles. Ported from osmocom rtl-sdr's `tuner_e4k.c` (LGPL-2.1+, with the
 * note that osmocom's headers explicitly allow linking from MIT projects).
 *
 * The chip is a zero-IF direct-conversion receiver, so the IF frequency is
 * 0. PLL math is fractional-N: F_lo = (fosc · Z + fosc · X / 65536) / R,
 * where R is a divider picked from a lookup table based on the desired LO.
 *
 * Communication goes through the RTL2832U's I²C bridge, exposed via the
 * `RtlCom` class from webrtlsdr.
 */

import type { RtlCom } from '@jtarrio/webrtlsdr/rtlsdr/rtlcom.js';
import type { Tuner } from '@jtarrio/webrtlsdr/rtlsdr/tuner.js';

/** I²C address of the E4000 in the same 8-bit form librtlsdr uses
 *  (`#define E4K_I2C_ADDR 0xc8` in osmocom's tuner_e4k.h). The 7-bit
 *  address is 0x64, but webrtlsdr's `setI2CReg(addr, …)` plumbs the
 *  value straight into the RTL2832U's USB control message wValue —
 *  the same path librtlsdr uses — so we have to match librtlsdr's
 *  constant byte-for-byte. Passing the 7-bit form silently fails to
 *  find the chip. */
const E4K_I2C_ADDR = 0xc8;
/** Identification register and expected value used to detect the chip
 *  (also from tuner_e4k.h). */
const E4K_CHECK_ADDR = 0x02;
const E4K_CHECK_VAL = 0x40;
/** Fractional divider denominator in the PLL math. */
const E4K_PLL_Y = 65536;

// ─── Register addresses (from osmocom's tuner_e4k.h) ─────────────────────
const REG = {
  MASTER1: 0x00,
  CLK_INP: 0x05,
  REF_CLK: 0x06,
  SYNTH1: 0x07,
  SYNTH3: 0x09,
  SYNTH4: 0x0a,
  SYNTH5: 0x0b,
  SYNTH7: 0x0d,
  FILT1: 0x10,
  FILT2: 0x11,
  FILT3: 0x12,
  GAIN1: 0x14,
  GAIN2: 0x15,
  GAIN3: 0x16,
  GAIN4: 0x17,
  AGC1: 0x1a,
  AGC4: 0x1d,
  AGC5: 0x1e,
  AGC6: 0x1f,
  AGC7: 0x20,
  AGC11: 0x24,
  DC5: 0x2d,
  DCTIME1: 0x70,
  DCTIME2: 0x71,
  BIAS: 0x78,
  CLKOUT_PWDN: 0x7a,
} as const;

/** PLL divider table — (max freq, synth7 reg value, divider R). */
const PLL_VARS: readonly { maxHz: number; synth7: number; r: number }[] = [
  { maxHz:    72_400_000, synth7: (1 << 3) | 7, r: 48 },
  { maxHz:    81_200_000, synth7: (1 << 3) | 6, r: 40 },
  { maxHz:   108_300_000, synth7: (1 << 3) | 5, r: 32 },
  { maxHz:   162_500_000, synth7: (1 << 3) | 4, r: 24 },
  { maxHz:   216_600_000, synth7: (1 << 3) | 3, r: 16 },
  { maxHz:   325_000_000, synth7: (1 << 3) | 2, r: 12 },
  { maxHz:   350_000_000, synth7: (1 << 3) | 1, r:  8 },
  { maxHz:   432_000_000, synth7: (0 << 3) | 3, r:  8 },
  { maxHz:   667_000_000, synth7: (0 << 3) | 2, r:  6 },
  { maxHz: 1_200_000_000, synth7: (0 << 3) | 1, r:  4 },
];

/** LNA gain table: user-facing dB → register value (lower 4 bits of GAIN1).
 *  Lifted from librtlsdr's `lnagain[]`. */
const LNA_GAIN_DB: readonly { db: number; reg: number }[] = [
  { db:  -5.0, reg: 0x0 },
  { db:  -2.5, reg: 0x1 },
  { db:   0.0, reg: 0x4 },
  { db:   2.5, reg: 0x5 },
  { db:   5.0, reg: 0x6 },
  { db:   7.5, reg: 0x7 },
  { db:  10.0, reg: 0x8 },
  { db:  12.5, reg: 0x9 },
  { db:  15.0, reg: 0xa },
  { db:  17.5, reg: 0xb },
  { db:  20.0, reg: 0xc },
  { db:  25.0, reg: 0xd },
  { db:  30.0, reg: 0xe },
];

/** IF channel-filter table, indexed 0..31. Bandwidth in Hz. */
const IFCH_FILTER_BW = [
  5_500_000, 5_300_000, 5_000_000, 4_800_000, 4_600_000, 4_400_000, 4_300_000,
  4_100_000, 3_900_000, 3_800_000, 3_700_000, 3_600_000, 3_400_000, 3_300_000,
  3_200_000, 3_100_000, 3_000_000, 2_950_000, 2_900_000, 2_800_000, 2_750_000,
  2_700_000, 2_600_000, 2_550_000, 2_500_000, 2_450_000, 2_400_000, 2_300_000,
  2_280_000, 2_240_000, 2_200_000, 2_150_000,
];

/** Mixer filter table (FILT2 [7:4]). */
const MIX_FILTER_BW = [
  27_000_000, 27_000_000, 27_000_000, 27_000_000, 27_000_000, 27_000_000,
  27_000_000, 27_000_000, 4_600_000, 4_200_000, 3_800_000, 3_400_000,
  3_300_000, 2_700_000, 2_300_000, 1_900_000,
];

/** IF RC filter table (FILT2 [3:0]). */
const IFRC_FILTER_BW = [
  21_400_000, 21_000_000, 17_600_000, 14_700_000, 12_400_000, 10_600_000,
  9_000_000, 7_700_000, 6_400_000, 5_300_000, 4_400_000, 3_400_000,
  2_600_000, 1_800_000, 1_200_000, 1_000_000,
];

function closestIndex(table: readonly number[], target: number): number {
  let best = 0;
  let bestDelta = Math.abs(table[0] - target);
  for (let i = 1; i < table.length; i++) {
    const d = Math.abs(table[i] - target);
    if (d < bestDelta) {
      best = i;
      bestDelta = d;
    }
  }
  return best;
}

/**
 * E4000 tuner driver. Constructed by `E4000.maybeInit()` after the
 * RTL2832U has been initialised; the caller manages I²C-bridge open/close
 * around its method calls (same pattern as webrtlsdr's R820T).
 */
export class E4000 implements Tuner {
  private com: RtlCom;
  private xtalFreq = 28_800_000;
  private currentFreq = 0;

  /** Detect E4000 by probing the magic identification register. The caller
   *  is responsible for opening/closing the I²C bridge before/after — same
   *  convention as `R820T.check`. */
  static async check(com: RtlCom): Promise<boolean> {
    await com.openI2C();
    let found = false;
    try {
      const v = await com.getI2CReg(E4K_I2C_ADDR, E4K_CHECK_ADDR);
      found = v === E4K_CHECK_VAL;
    } catch {
      // I²C transaction failed — chip absent or wrong address.
    }
    await com.closeI2C();
    return found;
  }

  /** Detect + initialise. Returns the tuner or null if not present. */
  static async maybeInit(com: RtlCom): Promise<E4000 | null> {
    if (!(await E4000.check(com))) return null;
    const tuner = new E4000(com);
    await tuner.open();
    return tuner;
  }

  constructor(com: RtlCom) {
    this.com = com;
  }

  // ─── Tuner interface ───────────────────────────────────────────────

  setXtalFrequency(xtalFreq: number): void {
    this.xtalFreq = xtalFreq;
  }

  /** E4000 is a zero-IF / direct-conversion receiver. */
  getIntermediateFrequency(): number {
    return 0;
  }

  /** Specified low edge of the chip's RF range. The chip's actual minimum
   *  depends on the PLL divider in use; 52 MHz is a safe practical floor
   *  that matches what Smartee XTR / NeSDR datasheets advertise. */
  getMinimumFrequency(): number {
    return 52_000_000;
  }

  async open(): Promise<void> {
    await this.com.openI2C();
    try {
      await this.initSequence();
    } finally {
      await this.com.closeI2C();
    }
  }

  async close(): Promise<void> {
    // Power down by writing the standby bit. The RTL2832U init re-enables
    // the chip via a hard reset on next open.
    await this.com.openI2C();
    try {
      await this.com.setI2CReg(E4K_I2C_ADDR, REG.MASTER1, 0x00);
    } catch {
      // ignore — chip might already be off / unplugged
    } finally {
      await this.com.closeI2C();
    }
  }

  async setFrequency(freq: number): Promise<number> {
    await this.com.openI2C();
    try {
      const actual = await this.tuneTo(freq);
      this.currentFreq = actual;
      return actual;
    } finally {
      await this.com.closeI2C();
    }
  }

  async setAutoGain(): Promise<void> {
    await this.com.openI2C();
    try {
      // AGC1 bit 0: enable LNA auto-gain. Clear bit 4 of AGC7 to enable
      // mixer auto-gain too.
      await this.setMask(REG.AGC1, 0x01, 0x01);
      await this.setMask(REG.AGC7, 0x10, 0x10);
    } finally {
      await this.com.closeI2C();
    }
  }

  async setManualGain(gain: number): Promise<void> {
    await this.com.openI2C();
    try {
      // Force LNA into manual mode (clear AGC1 bit 0).
      await this.setMask(REG.AGC1, 0x01, 0x00);
      await this.setMask(REG.AGC7, 0x10, 0x00);
      // Pick the closest entry from the LNA dB table.
      let best = LNA_GAIN_DB[0];
      let bestDelta = Math.abs(best.db - gain);
      for (const entry of LNA_GAIN_DB) {
        const d = Math.abs(entry.db - gain);
        if (d < bestDelta) {
          best = entry;
          bestDelta = d;
        }
      }
      await this.setMask(REG.GAIN1, 0x0f, best.reg);
    } finally {
      await this.com.closeI2C();
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  /** Read-modify-write a register's masked bits without touching the rest. */
  private async setMask(reg: number, mask: number, value: number): Promise<void> {
    const cur = await this.com.getI2CReg(E4K_I2C_ADDR, reg);
    const next = (cur & ~mask) | (value & mask);
    if (next !== cur) {
      await this.com.setI2CReg(E4K_I2C_ADDR, reg, next);
    }
  }

  /** Run the full init sequence from librtlsdr's e4k_init(). I²C bridge
   *  must already be open. */
  private async initSequence(): Promise<void> {
    // Hard reset + leave in normal standby + enable power-on detector.
    // From E4K_MASTER1_{RESET|NORM_STBY|POR_DET} = 0x05 (bits 0, 2).
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.MASTER1, 0x05);

    await this.com.setI2CReg(E4K_I2C_ADDR, REG.CLK_INP, 0x00);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.REF_CLK, 0x00);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.CLKOUT_PWDN, 0x96);

    // Undocumented but mandatory writes per Realtek's reference.
    await this.com.setI2CReg(E4K_I2C_ADDR, 0x7e, 0x01);
    await this.com.setI2CReg(E4K_I2C_ADDR, 0x7f, 0xfe);
    await this.com.setI2CReg(E4K_I2C_ADDR, 0x82, 0x00);
    await this.com.setI2CReg(E4K_I2C_ADDR, 0x86, 0x50);
    await this.com.setI2CReg(E4K_I2C_ADDR, 0x87, 0x20);
    await this.com.setI2CReg(E4K_I2C_ADDR, 0x88, 0x01);
    await this.com.setI2CReg(E4K_I2C_ADDR, 0x9f, 0x7f);
    await this.com.setI2CReg(E4K_I2C_ADDR, 0xa0, 0x07);

    // AGC configuration — values verbatim from e4k_init().
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.AGC4, 0x10);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.AGC5, 0x04);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.AGC6, 0x1a);
    // AGC1 mode bits [1:0] = 0 (serial mode).
    await this.setMask(REG.AGC1, 0x03, 0x00);
    // AGC7 bit 4 = manual mixer gain.
    await this.setMask(REG.AGC7, 0x10, 0x00);

    // Start in auto-gain. The caller will switch to manual via setManualGain.
    await this.setMask(REG.AGC1, 0x01, 0x01);
    await this.setMask(REG.AGC7, 0x10, 0x10);

    // IF gains — defaults from librtlsdr: stage 1 = 6 dB, 2-4 = 0, 5-6 = 9 dB.
    // GAIN3 layout: [0]=stage1, [2:1]=stage2, [4:3]=stage3, [6:5]=stage4.
    // GAIN4 layout: [2:0]=stage5, [5:3]=stage6.
    // Encoding: stage1 6 dB = bit 1; stage5/6 9 dB = code 2 (bits 010).
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.GAIN3, 0b0000_0001);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.GAIN4, 0b00_010_010);

    // IF filters — defaults from librtlsdr.
    await this.setIfFilter('mix', 1_900_000);
    await this.setIfFilter('rc', 1_000_000);
    await this.setIfFilter('chan', 2_150_000);
    // Enable channel filter (FILT3 bit 5 = 0 → enabled).
    await this.setMask(REG.FILT3, 0x20, 0x00);

    // DC offset calibration — leave timing/loop on defaults.
    await this.setMask(REG.DC5, 0x03, 0x00);
    await this.setMask(REG.DCTIME1, 0x03, 0x00);
    await this.setMask(REG.DCTIME2, 0x03, 0x00);
  }

  private async setIfFilter(kind: 'mix' | 'rc' | 'chan', bwHz: number): Promise<void> {
    if (kind === 'mix') {
      const idx = closestIndex(MIX_FILTER_BW, bwHz);
      await this.setMask(REG.FILT2, 0xf0, (idx & 0x0f) << 4);
    } else if (kind === 'rc') {
      const idx = closestIndex(IFRC_FILTER_BW, bwHz);
      await this.setMask(REG.FILT2, 0x0f, idx & 0x0f);
    } else {
      const idx = closestIndex(IFCH_FILTER_BW, bwHz);
      await this.setMask(REG.FILT3, 0x1f, idx & 0x1f);
    }
  }

  /** Compute PLL parameters + write SYNTH registers + set the band. */
  private async tuneTo(freq: number): Promise<number> {
    // Pick divider R from the PLL table.
    let synth7 = (0 << 3) | 1;
    let r = 4;
    for (const entry of PLL_VARS) {
      if (freq < entry.maxHz) {
        synth7 = entry.synth7;
        r = entry.r;
        break;
      }
    }

    const fosc = this.xtalFreq;
    const fvco = freq * r;
    const z = Math.floor(fvco / fosc);
    const remainder = fvco - fosc * z;
    const x = Math.floor((remainder * E4K_PLL_Y) / fosc);
    const flo = Math.floor((fosc * z + (fosc * x) / E4K_PLL_Y) / r);

    // Write the PLL registers. SYNTH3 = Z (integer part), SYNTH4/5 = X
    // (fractional), SYNTH7 = R selector.
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.SYNTH7, synth7);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.SYNTH3, z & 0xff);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.SYNTH4, x & 0xff);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.SYNTH5, (x >> 8) & 0xff);

    // Band selection based on the actual LO. SYNTH1 [2:1] = band, plus
    // BIAS register value.
    let band: number;
    let bias: number;
    if (flo < 140_000_000) {
      band = 0; // VHF2
      bias = 3;
    } else if (flo < 350_000_000) {
      band = 1; // VHF3
      bias = 3;
    } else if (flo < 1_135_000_000) {
      band = 2; // UHF
      bias = 3;
    } else {
      band = 3; // L
      bias = 0;
    }
    await this.setMask(REG.SYNTH1, 0x06, (band & 0x03) << 1);
    await this.com.setI2CReg(E4K_I2C_ADDR, REG.BIAS, bias);

    return flo;
  }
}
