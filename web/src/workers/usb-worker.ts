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
import { SabRing } from '../lib/ring/sab-ring';

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
};
type InboundStop = { kind: 'stop' };
type InboundClose = { kind: 'close' };
type Inbound = InboundInit | InboundStop | InboundClose;

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

    await usbDevice.open();
    device = await RTL2832U.open(usbDevice);
    const actualSampleRate = await device.setSampleRate(opts.sampleRate);
    const actualFrequency = await device.setCenterFrequency(opts.centerFreq);
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
    ring.write(bytes);
    bytesWrittenTotal += bytes.length;
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
    case 'stop':
      void stop();
      break;
    case 'close':
      void close();
      break;
  }
};
