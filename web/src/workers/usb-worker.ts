/**
 * USB Worker — owns the RTL-SDR USBDevice and runs the readSamples loop.
 *
 * Receives a USBDevice from the main thread (transferred, not copied — the
 * main thread loses access after the postMessage). Runs `readSamples` in
 * a tight async loop, posting each chunk back to the main thread with the
 * ArrayBuffer marked transferable to avoid copying.
 *
 * Decoupling USB I/O from the main thread is what B4a buys us: the read loop
 * is no longer fighting Svelte re-renders for CPU. B4b will replace
 * postMessage with a SharedArrayBuffer ring + a dedicated DSP worker.
 */

import { RTL2832U, type RtlDevice, type SampleBlock } from '@jtarrio/webrtlsdr/rtlsdr.js';

type InboundInit = {
  kind: 'init';
  device: USBDevice;
  sampleRate: number;
  centerFreq: number;
  gain: number | null;
  chunkSamples: number;
};

type InboundStop = { kind: 'stop' };
type InboundClose = { kind: 'close' };
type Inbound = InboundInit | InboundStop | InboundClose;

type OutboundStarted = {
  kind: 'started';
  actualSampleRate: number;
  actualFrequency: number;
};
type OutboundSamples = {
  kind: 'samples';
  data: ArrayBuffer;
  frequency: number;
  directSampling: boolean;
};
type OutboundStopped = { kind: 'stopped' };
type OutboundError = { kind: 'error'; message: string };
type Outbound = OutboundStarted | OutboundSamples | OutboundStopped | OutboundError;

let device: RtlDevice | null = null;
let running = false;
let chunkSize = 65_536;

function postOut(msg: Outbound, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer });
}

async function init(opts: InboundInit) {
  try {
    device = await RTL2832U.open(opts.device);
    const actualSampleRate = await device.setSampleRate(opts.sampleRate);
    const actualFrequency = await device.setCenterFrequency(opts.centerFreq);
    await device.setGain(opts.gain);
    await device.resetBuffer();
    chunkSize = opts.chunkSamples;

    postOut({ kind: 'started', actualSampleRate, actualFrequency });

    running = true;
    void readLoop();
  } catch (err) {
    postOut({ kind: 'error', message: errMessage(err) });
  }
}

async function readLoop() {
  while (running && device) {
    let block: SampleBlock;
    try {
      block = await device.readSamples(chunkSize);
    } catch (err) {
      running = false;
      postOut({ kind: 'error', message: errMessage(err) });
      return;
    }
    postOut(
      {
        kind: 'samples',
        data: block.data,
        frequency: block.frequency,
        directSampling: block.directSampling,
      },
      [block.data]
    );
  }
}

async function stop() {
  running = false;
  postOut({ kind: 'stopped' });
}

async function close() {
  running = false;
  if (device) {
    try {
      await device.close();
    } catch {
      // Ignore close errors — device may already be gone.
    } finally {
      device = null;
    }
  }
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
