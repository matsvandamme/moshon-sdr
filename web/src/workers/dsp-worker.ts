/**
 * DSP Worker — reads IQ samples from a SharedArrayBuffer ring (fed by the
 * USB worker), runs a windowed FFT via the Rust→WASM module, and posts
 * the resulting log-magnitude bin vector back to the main thread for
 * spectrum/waterfall rendering.
 *
 * The Worker spins in an async loop: when there are enough bytes in the
 * ring for one FFT block, take them and process. Otherwise yield briefly.
 * postMessage is throttled to a target frame interval so we don't drown
 * the main thread when FFT output rate >> render rate.
 */

import init, { FftContext } from '../lib/dsp/wasm/moshon_dsp.js';
import { SabRing } from '../lib/ring/sab-ring';

type InboundInit = {
  kind: 'init';
  iqRing: SharedArrayBuffer;
  fftSize: number;
  /** Target rate of FFT frames posted to main, in Hz. */
  postRateHz: number;
};
type InboundStop = { kind: 'stop' };
type Inbound = InboundInit | InboundStop;

type OutboundReady = { kind: 'ready' };
type OutboundFft = { kind: 'fft'; bins: Float32Array; time: number };
type OutboundError = { kind: 'error'; message: string };
type Outbound = OutboundReady | OutboundFft | OutboundError;

let ring: SabRing | null = null;
let fft: FftContext | null = null;
let iqBuffer: Uint8Array | null = null;
let running = false;
let minPostIntervalMs = 33;
let lastPostMs = 0;

function postOut(msg: Outbound, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer });
}

async function setup(opts: InboundInit) {
  try {
    await init();
    fft = new FftContext(opts.fftSize);
    ring = new SabRing(opts.iqRing);
    iqBuffer = new Uint8Array(opts.fftSize * 2);
    minPostIntervalMs = 1000 / Math.max(1, opts.postRateHz);
    lastPostMs = 0;
    running = true;
    postOut({ kind: 'ready' });
    void processLoop();
  } catch (err) {
    postOut({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

async function processLoop() {
  // Yield cooperatively when the ring is empty so we don't spin the worker
  // and eat a CPU core. A tiny await also gives the worker's microtask queue
  // a chance to process incoming control messages.
  const yieldStep = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

  while (running && ring && fft && iqBuffer) {
    if (ring.available() < iqBuffer.length) {
      await yieldStep();
      continue;
    }
    ring.read(iqBuffer);

    let bins: Float32Array;
    try {
      // Rust returns Vec<f32> as a fresh Float32Array via wasm-bindgen.
      bins = fft.process(iqBuffer);
    } catch (err) {
      running = false;
      postOut({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const now = performance.now();
    if (now - lastPostMs < minPostIntervalMs) {
      // Drop this frame to honour the post-rate cap; the DSP loop keeps
      // draining the ring so we don't fall behind.
      continue;
    }
    lastPostMs = now;
    postOut({ kind: 'fft', bins, time: now }, [bins.buffer]);
  }
}

self.onmessage = (e: MessageEvent<Inbound>) => {
  const msg = e.data;
  switch (msg.kind) {
    case 'init':
      void setup(msg);
      break;
    case 'stop':
      running = false;
      break;
  }
};
