/**
 * HackRF Worker — owns the HackRF One USBDevice, drives the bulk-IN
 * sample stream, and writes IQ to the SAB ring in the same offset-binary
 * u8 layout the RTL-SDR path produces, so the DSP worker doesn't need to
 * know which dongle is feeding it.
 *
 * Lifecycle mirrors `usb-worker.ts`:
 *   - main thread grants USB permission via requestDevice(), passes
 *     identifiers + ring SAB here;
 *   - we look the device up via navigator.usb.getDevices() (USBDevice
 *     isn't transferable to workers), open it, configure it via vendor
 *     control transfers, then loop on transferIn bulk transfers;
 *   - each chunk of signed-int8 samples is shifted to offset-binary u8
 *     (`s + 128`) before being pushed into the ring.
 */

import { SabRing } from '../lib/ring/sab-ring';
import {
  HACKRF_DEFAULT_GAIN,
  HRF_MODE,
  HRF_REQ,
  HACKRF_INTERFACE,
  HACKRF_RX_ENDPOINT,
  clampLnaDb,
  clampVgaDb,
  distributeGain,
  packSampleRatePayload,
  packSetFreqPayload,
  vendorIn1Byte,
  vendorOutNoData,
  vendorOutWithData,
  type HackRfGain,
} from '../lib/usb/hackrf-protocol';

type InboundInit = {
  kind: 'init';
  vendorId: number;
  productId: number;
  serialNumber?: string;
  sampleRate: number;
  centerFreq: number;
  gain: number | null;
  /** Optional per-stage override. If present, takes precedence over `gain`. */
  hackrfGain?: HackRfGain;
  iqRing: SharedArrayBuffer;
  statsIntervalMs: number;
};
type InboundRetune = {
  kind: 'retune';
  centerFreq?: number;
  gain?: number | null;
};
type InboundSetStageGain = {
  kind: 'setHackrfGain';
  gain: HackRfGain;
};
type InboundStop = { kind: 'stop' };
type InboundClose = { kind: 'close' };
type Inbound =
  | InboundInit
  | InboundRetune
  | InboundSetStageGain
  | InboundStop
  | InboundClose;

type OutboundStarted = {
  kind: 'started';
  actualSampleRate: number;
  actualFrequency: number;
};
type OutboundStats = {
  kind: 'stats';
  bytesWritten: number;
  bytesDropped: number;
  time: number;
};
type OutboundStopped = { kind: 'stopped' };
type OutboundError = { kind: 'error'; message: string };
type Outbound = OutboundStarted | OutboundStats | OutboundStopped | OutboundError;

/** Transfer size for bulk reads. 32 KB is the libhackrf reference default
 *  and matches HackRF One's USB block size. */
const TRANSFER_BYTES = 32_768;


let device: USBDevice | null = null;
let ring: SabRing | null = null;
let running = false;
let bytesWrittenTotal = 0;
let statsIntervalMs = 250;
let statsTimer: ReturnType<typeof setInterval> | null = null;

function postOut(msg: Outbound) {
  self.postMessage(msg);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function init(opts: InboundInit) {
  try {
    if (!('usb' in navigator)) {
      throw new Error('WebUSB not available in this Worker context');
    }
    const granted = await navigator.usb.getDevices();
    const usbDevice = granted.find(
      (d) =>
        d.vendorId === opts.vendorId &&
        d.productId === opts.productId &&
        (opts.serialNumber === undefined || d.serialNumber === opts.serialNumber),
    );
    if (!usbDevice) {
      throw new Error(
        `HackRF ${opts.vendorId.toString(16)}:${opts.productId.toString(16)} not found in granted devices`,
      );
    }

    ring = new SabRing(opts.iqRing);
    ring.reset();
    bytesWrittenTotal = 0;
    statsIntervalMs = opts.statsIntervalMs;

    device = usbDevice;
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }
    await device.claimInterface(HACKRF_INTERFACE);

    // Defensive reset: a previously-bad session might have left the device
    // in TX or SWEEP mode. SET_TRANSCEIVER_MODE = OFF is always safe.
    await vendorOutNoData(device, HRF_REQ.SET_TRANSCEIVER_MODE, HRF_MODE.OFF, 0);

    // Configure the device. Order matches the libhackrf hackrf_start_rx
    // sequence: rate first, then frequency, then gain, then mode = RX.
    await vendorOutWithData(
      device,
      HRF_REQ.SAMPLE_RATE_SET,
      0,
      0,
      packSampleRatePayload(opts.sampleRate),
    );
    // Baseband filter: pick the next supported value above sampleRate * 0.75.
    // The list of valid bandwidths is fixed in firmware (1.75, 2.5, 3.5, 5,
    // 5.5, 6, 7, 8, 9, 10, 12, 14, 15, 20, 24, 28 MHz). 1.75 MHz covers
    // 2.4 MS/s nicely with anti-alias margin.
    const bbFilterHz = pickBasebandFilter(opts.sampleRate);
    await vendorOutNoData(
      device,
      HRF_REQ.BASEBAND_FILTER_BANDWIDTH_SET,
      bbFilterHz & 0xffff,
      (bbFilterHz >>> 16) & 0xffff,
    );

    await applyFrequency(opts.centerFreq);
    const stages = opts.hackrfGain
      ?? (opts.gain === null ? HACKRF_DEFAULT_GAIN : distributeGain(opts.gain));
    await applyStageGain(stages);

    // Start the RX stream.
    await vendorOutNoData(device, HRF_REQ.SET_TRANSCEIVER_MODE, HRF_MODE.RX, 0);

    postOut({
      kind: 'started',
      actualSampleRate: opts.sampleRate,
      actualFrequency: opts.centerFreq,
    });

    statsTimer = setInterval(emitStats, statsIntervalMs);
    running = true;
    void readLoop();
  } catch (err) {
    postOut({ kind: 'error', message: errMessage(err) });
  }
}

function pickBasebandFilter(sampleRate: number): number {
  // From libhackrf hackrf_compute_baseband_filter_bw_round_down_lt.
  const valid = [
    1_750_000, 2_500_000, 3_500_000, 5_000_000, 5_500_000, 6_000_000,
    7_000_000, 8_000_000, 9_000_000, 10_000_000, 12_000_000, 14_000_000,
    15_000_000, 20_000_000, 24_000_000, 28_000_000,
  ];
  const target = sampleRate * 0.75;
  for (const bw of valid) {
    if (bw >= target) return bw;
  }
  return valid[valid.length - 1];
}

async function applyFrequency(freqHz: number): Promise<void> {
  if (!device) return;
  await vendorOutWithData(device, HRF_REQ.SET_FREQ, 0, 0, packSetFreqPayload(freqHz));
}

async function applyStageGain(stages: HackRfGain): Promise<void> {
  if (!device) return;
  // AMP: OUT, no data; wValue = 0 or 1.
  await vendorOutNoData(device, HRF_REQ.AMP_ENABLE, stages.ampOn ? 1 : 0, 0);
  // LNA + VGA: actually IN transfers per libhackrf — the device returns a
  // 1-byte ack. Sending these as OUT triggers a STALL on Chromium WebUSB.
  // The gain value lives in wIndex; wValue is reserved (zero).
  await vendorIn1Byte(device, HRF_REQ.SET_LNA_GAIN, 0, clampLnaDb(stages.lnaDb));
  await vendorIn1Byte(device, HRF_REQ.SET_VGA_GAIN, 0, clampVgaDb(stages.vgaDb));
}

async function applyLegacyGain(gain: number | null): Promise<void> {
  const stages = gain === null ? HACKRF_DEFAULT_GAIN : distributeGain(gain);
  await applyStageGain(stages);
}

async function readLoop() {
  if (!device || !ring) return;
  // Shared scratch for the int8→u8 repack. Reused per transfer to avoid
  // per-loop allocation pressure (32 KB × ~70 transfers/sec at 2.4 MS/s).
  const repacked = new Uint8Array(TRANSFER_BYTES);

  while (running && device && ring) {
    let result: USBInTransferResult;
    try {
      result = await device.transferIn(HACKRF_RX_ENDPOINT, TRANSFER_BYTES);
    } catch (err) {
      if (!running) return; // stop() bailed us out
      postOut({ kind: 'error', message: `HackRF transferIn: ${errMessage(err)}` });
      running = false;
      return;
    }
    if (result.status !== 'ok' || !result.data) {
      postOut({ kind: 'error', message: `HackRF transferIn status=${result.status}` });
      running = false;
      return;
    }

    // Repack signed i8 → offset-binary u8 in-place into the scratch buffer
    // (DSP chain expects u8 with bias 128; HackRF emits -128..127).
    const src = new Int8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    const n = src.length;
    const view = repacked.subarray(0, n);
    for (let i = 0; i < n; i++) {
      view[i] = src[i] + 128;
    }
    ring.write(view);
    bytesWrittenTotal += n;
  }
}

function emitStats() {
  if (!ring) return;
  postOut({
    kind: 'stats',
    bytesWritten: bytesWrittenTotal,
    bytesDropped: ring.getDropped(),
    time: performance.now(),
  });
}

async function retune(opts: InboundRetune) {
  if (!device) return;
  try {
    if (typeof opts.centerFreq === 'number') {
      await applyFrequency(opts.centerFreq);
    }
    if (opts.gain !== undefined) {
      await applyLegacyGain(opts.gain);
    }
  } catch (err) {
    postOut({ kind: 'error', message: errMessage(err) });
  }
}

async function setStageGain(stages: HackRfGain): Promise<void> {
  if (!device) return;
  try {
    await applyStageGain(stages);
  } catch (err) {
    postOut({ kind: 'error', message: errMessage(err) });
  }
}

async function stop() {
  running = false;
  if (statsTimer !== null) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  if (device) {
    try {
      await vendorOutNoData(device, HRF_REQ.SET_TRANSCEIVER_MODE, HRF_MODE.OFF, 0);
    } catch {
      // ignore — best-effort shutdown
    }
  }
  emitStats();
  postOut({ kind: 'stopped' });
}

async function close() {
  running = false;
  if (statsTimer !== null) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  if (device) {
    try {
      await vendorOutNoData(device, HRF_REQ.SET_TRANSCEIVER_MODE, HRF_MODE.OFF, 0);
    } catch {
      // ignore
    }
    try {
      await device.releaseInterface(HACKRF_INTERFACE);
    } catch {
      // ignore
    }
    try {
      await device.close();
    } catch {
      // ignore
    } finally {
      device = null;
    }
  }
  ring = null;
}

self.onmessage = (e: MessageEvent<Inbound>) => {
  const msg = e.data;
  switch (msg.kind) {
    case 'init':
      void init(msg);
      break;
    case 'retune':
      void retune(msg);
      break;
    case 'setHackrfGain':
      void setStageGain(msg.gain);
      break;
    case 'stop':
      void stop();
      break;
    case 'close':
      void close();
      break;
  }
};
