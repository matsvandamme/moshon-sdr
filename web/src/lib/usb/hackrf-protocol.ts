/**
 * HackRF One WebUSB driver.
 *
 * Protocol constants and command helpers, ported from libhackrf's
 * `hackrf.h` / `hackrf.c`. The wire format is plain WebUSB:
 *
 *   - Vendor-specific control transfers (recipient=device, type=vendor)
 *     drive the device state machine (sample rate, frequency, gain,
 *     transceiver mode).
 *   - Bulk IN on endpoint 0x81 carries the RX I/Q stream as interleaved
 *     signed 8-bit samples (I, Q, I, Q, …). To plug into the existing
 *     RTL-SDR-shaped DSP chain we repack to offset-binary u8 in the
 *     worker before writing to the SAB ring.
 *
 * USB IDs we accept (per libhackrf):
 *   1d50:6089  HackRF One (production)
 *   1d50:604b  HackRF Jellybean (preproduction; rare, but cheap to allow)
 *   1d50:cc15  HackRF One rad1o (CCC variant)
 *
 * Endpoints and interface come from the device descriptor we read at
 * `connect()` time; the values below are the documented defaults.
 */

export const HACKRF_USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x1d50, productId: 0x6089 },
  { vendorId: 0x1d50, productId: 0x604b },
  { vendorId: 0x1d50, productId: 0xcc15 },
];

/** Bulk-IN endpoint for receive samples. */
export const HACKRF_RX_ENDPOINT = 1; // address 0x81 → in-endpoint number 1
/** USB interface number for the streaming endpoints. */
export const HACKRF_INTERFACE = 0;

/** Vendor-request opcodes (from `enum hackrf_vendor_request` in hackrf.h). */
export const HRF_REQ = {
  SET_TRANSCEIVER_MODE: 1,
  MAX2837_WRITE: 2,
  MAX2837_READ: 3,
  SI5351C_WRITE: 4,
  SI5351C_READ: 5,
  SAMPLE_RATE_SET: 6,
  BASEBAND_FILTER_BANDWIDTH_SET: 7,
  RFFC5071_WRITE: 8,
  RFFC5071_READ: 9,
  SPIFLASH_ERASE: 10,
  SPIFLASH_WRITE: 11,
  SPIFLASH_READ: 12,
  BOARD_ID_READ: 14,
  VERSION_STRING_READ: 15,
  SET_FREQ: 16,
  AMP_ENABLE: 17,
  BOARD_PARTID_SERIALNO_READ: 18,
  SET_LNA_GAIN: 19,
  SET_VGA_GAIN: 20,
  SET_TXVGA_GAIN: 21,
  ANTENNA_ENABLE: 23,
} as const;

/** Modes accepted by SET_TRANSCEIVER_MODE. We only use OFF and RX. */
export const HRF_MODE = {
  OFF: 0,
  RX: 1,
  TX: 2,
  SWEEP: 5,
} as const;

/** Pack a frequency (Hz) into the 8-byte payload SET_FREQ wants:
 *  4 bytes little-endian MHz integer, 4 bytes little-endian remainder Hz.
 *  We return ArrayBuffer (not Uint8Array) so WebUSB's `BufferSource`
 *  parameter type matches without a cast on strict TS settings. */
export function packSetFreqPayload(freqHz: number): ArrayBuffer {
  const mhz = Math.floor(freqHz / 1_000_000);
  const remainder = Math.round(freqHz - mhz * 1_000_000);
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint32(0, mhz, true);
  v.setUint32(4, remainder, true);
  return buf;
}

/** Pack a sample rate into the 8-byte payload SAMPLE_RATE_SET expects:
 *  4 bytes LE numerator (freq Hz), 4 bytes LE divider. Setting divider=1
 *  gives us exact rate; the device's PLL handles non-integer ratios. */
export function packSampleRatePayload(rateHz: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint32(0, Math.round(rateHz), true);
  v.setUint32(4, 1, true);
  return buf;
}

/** Send a vendor-out control transfer with no data payload. */
export async function vendorOutNoData(
  device: USBDevice,
  request: number,
  value: number,
  index: number,
): Promise<void> {
  const r = await device.controlTransferOut({
    requestType: 'vendor',
    recipient: 'device',
    request,
    value,
    index,
  });
  if (r.status !== 'ok') {
    throw new Error(`HackRF control_out request ${request} failed: ${r.status}`);
  }
}

/** Send a vendor-out control transfer with a small data payload. */
export async function vendorOutWithData(
  device: USBDevice,
  request: number,
  value: number,
  index: number,
  data: BufferSource,
): Promise<void> {
  const r = await device.controlTransferOut(
    {
      requestType: 'vendor',
      recipient: 'device',
      request,
      value,
      index,
    },
    data,
  );
  if (r.status !== 'ok') {
    throw new Error(`HackRF control_out (with data) request ${request} failed: ${r.status}`);
  }
}

// ─── High-level helpers ──────────────────────────────────────────────────

/** Clamp LNA gain to the device's 0..40 dB grid (8 dB steps). */
export function clampLnaDb(db: number): number {
  const stepped = Math.round(db / 8) * 8;
  return Math.max(0, Math.min(40, stepped));
}

/** Clamp VGA (baseband) gain to the 0..62 dB grid (2 dB steps). */
export function clampVgaDb(db: number): number {
  const stepped = Math.round(db / 2) * 2;
  return Math.max(0, Math.min(62, stepped));
}

/**
 * Map a single user-facing gain in dB (0..~75) to the HackRF's three
 * gain stages. AMP adds a flat ~14 dB pre-amp; LNA covers 0..40 in 8 dB
 * steps; VGA covers 0..62 in 2 dB steps. We split greedily so the user
 * just sees "gain" and we pick a sensible distribution.
 *
 *   amp:  on iff userDb >= 50 (cabling/antenna noise figure is usually OK
 *         without amp below 50 dB total gain)
 *   lna:  cap LNA before VGA — LNA is lower noise figure
 *   vga:  fill the remainder
 */
export type HackRfGain = { ampOn: boolean; lnaDb: number; vgaDb: number };

export function distributeGain(userDb: number): HackRfGain {
  const ampOn = userDb >= 50;
  const remaining = userDb - (ampOn ? 14 : 0);
  // Greedy LNA first
  const lnaDb = clampLnaDb(Math.min(40, Math.max(0, remaining)));
  const afterLna = Math.max(0, remaining - lnaDb);
  const vgaDb = clampVgaDb(Math.min(62, afterLna));
  return { ampOn, lnaDb, vgaDb };
}
