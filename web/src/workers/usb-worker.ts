/**
 * USB Worker — owns the RTL-SDR USBDevice and runs the readSamples loop.
 *
 * The main thread grants device permission via requestDevice() and sends us
 * the identifiers + a SharedArrayBuffer ring. We look up the device by
 * VID/PID/serial via navigator.usb.getDevices() (USBDevice isn't
 * transferable to Workers), open it, configure it, then write IQ samples
 * into the ring as fast as the device produces them. A separate DSP worker
 * consumes the ring.
 *
 * Stats (sample count, dropped count) are posted back to main periodically
 * for the live counter UI.
 */

import { RTL2832U, type RtlDevice, type SampleBlock } from '@jtarrio/webrtlsdr/rtlsdr.js';
import { DirectSampling } from '@jtarrio/webrtlsdr/rtlsdr.js';
import { SabRing } from '../lib/ring/sab-ring';
import { NcoShifter } from '../lib/usb/nco-shift';

export type DirectSamplingMode = 'off' | 'i' | 'q';

type InboundInit = {
  kind: 'init';
  vendorId: number;
  productId: number;
  serialNumber?: string;
  sampleRate: number;
  centerFreq: number;
  gain: number | null;
  chunkSamples: number;
  iqRing: SharedArrayBuffer;
  statsIntervalMs: number;
  /** Software offset-tuning shift in Hz (0 = disabled). The dongle is
   *  actually tuned to centerFreq + offsetHz; we shift the IQ stream
   *  back by -offsetHz so the desired signal lands at DC and the DC
   *  spike sits at +offsetHz, out of the demod's passband. */
  offsetHz?: number;
  /** Crystal correction in parts-per-million. */
  ppmCorrection?: number;
  /** Enable the SDR's bias-T (powers external LNAs / preamps via the
   *  coax). RTL-SDR Blog v3+ and similar. */
  biasT?: boolean;
  /** Direct-sampling mode: 'off' (normal RF path), 'i' or 'q' (HF via
   *  the RTL2832 ADC pins, bypassing the tuner — works below ~24 MHz). */
  directSampling?: DirectSamplingMode;
};
type InboundRetune = {
  kind: 'retune';
  centerFreq?: number;
  gain?: number | null;
  offsetHz?: number;
};
type InboundAdvanced = {
  kind: 'advanced';
  ppmCorrection?: number;
  biasT?: boolean;
  directSampling?: DirectSamplingMode;
};
type InboundStop = { kind: 'stop' };
type InboundClose = { kind: 'close' };
type Inbound = InboundInit | InboundRetune | InboundAdvanced | InboundStop | InboundClose;

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

let device: RtlDevice | null = null;
let ring: SabRing | null = null;
let running = false;
let chunkSize = 65_536;
let bytesWrittenTotal = 0;
let statsIntervalMs = 250;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let currentSampleRate = 2_400_000;
let currentDialFreq = 100_000_000;
let currentOffsetHz = 0;
const nco = new NcoShifter();

function postOut(msg: Outbound) {
  self.postMessage(msg);
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
        `Device ${opts.vendorId.toString(16)}:${opts.productId.toString(16)} not found in granted devices`,
      );
    }

    ring = new SabRing(opts.iqRing);
    ring.reset();
    bytesWrittenTotal = 0;
    chunkSize = opts.chunkSamples;
    statsIntervalMs = opts.statsIntervalMs;
    currentSampleRate = opts.sampleRate;
    currentDialFreq = opts.centerFreq;
    currentOffsetHz = opts.offsetHz ?? 0;
    nco.configure(currentOffsetHz, currentSampleRate);

    await usbDevice.open();
    device = await RTL2832U.open(usbDevice);
    // Apply advanced settings BEFORE sample rate / frequency so the
    // first read isn't on a half-configured device.
    if (typeof opts.ppmCorrection === 'number') {
      await device.setFrequencyCorrection(opts.ppmCorrection);
    }
    if (opts.directSampling && opts.directSampling !== 'off') {
      const mode = opts.directSampling === 'i' ? DirectSampling.I : DirectSampling.Q;
      await device.setDirectSamplingMethod(mode);
    } else if (opts.directSampling === 'off') {
      await device.setDirectSamplingMethod(DirectSampling.Off);
    }
    if (typeof opts.biasT === 'boolean') {
      await device.enableBiasTee(opts.biasT);
    }
    const actualSampleRate = await device.setSampleRate(opts.sampleRate);
    // Offset-tune: tune physical LO above the dial freq by `offsetHz`,
    // and let the NCO shift bring it back. Skip if direct sampling is on
    // (the bias-T / DC-spike concerns don't apply there).
    const physicalFreq = currentDialFreq + currentOffsetHz;
    const actualFrequency = await device.setCenterFrequency(physicalFreq);
    await device.setGain(opts.gain);
    await device.resetBuffer();

    postOut({ kind: 'started', actualSampleRate, actualFrequency });

    statsTimer = setInterval(emitStats, statsIntervalMs);
    running = true;
    void readLoop();
  } catch (err) {
    postOut({ kind: 'error', message: errMessage(err) });
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

async function readLoop() {
  while (running && device && ring) {
    let block: SampleBlock;
    try {
      block = await device.readSamples(chunkSize);
    } catch (err) {
      running = false;
      postOut({ kind: 'error', message: errMessage(err) });
      return;
    }
    const bytes = new Uint8Array(block.data);
    // Software offset tuning: shift the IQ stream by -offsetHz so the
    // physical-offset dongle frequency lands at DC in the SAB ring.
    if (currentOffsetHz !== 0) nco.shiftInPlace(bytes);
    ring.write(bytes);
    bytesWrittenTotal += bytes.length;
  }
}

async function retune(opts: InboundRetune) {
  if (!device) return;
  try {
    if (typeof opts.offsetHz === 'number' && opts.offsetHz !== currentOffsetHz) {
      currentOffsetHz = opts.offsetHz;
      nco.configure(currentOffsetHz, currentSampleRate);
      // Re-issue the tune so the physical LO follows the new offset.
      await device.setCenterFrequency(currentDialFreq + currentOffsetHz);
    }
    if (typeof opts.centerFreq === 'number') {
      currentDialFreq = opts.centerFreq;
      await device.setCenterFrequency(currentDialFreq + currentOffsetHz);
    }
    if (opts.gain !== undefined) {
      await device.setGain(opts.gain);
    }
  } catch (err) {
    postOut({ kind: 'error', message: errMessage(err) });
  }
}

async function applyAdvanced(opts: InboundAdvanced) {
  if (!device) return;
  try {
    if (typeof opts.ppmCorrection === 'number') {
      await device.setFrequencyCorrection(opts.ppmCorrection);
    }
    if (opts.directSampling !== undefined) {
      const mode =
        opts.directSampling === 'i'
          ? DirectSampling.I
          : opts.directSampling === 'q'
            ? DirectSampling.Q
            : DirectSampling.Off;
      await device.setDirectSamplingMethod(mode);
    }
    if (typeof opts.biasT === 'boolean') {
      await device.enableBiasTee(opts.biasT);
    }
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
      await device.close();
    } catch {
      // device may already be gone — ignore
    } finally {
      device = null;
    }
  }
  ring = null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    case 'advanced':
      void applyAdvanced(msg);
      break;
    case 'stop':
      void stop();
      break;
    case 'close':
      void close();
      break;
  }
};
