/**
 * DSP Worker — reads IQ samples from a `SharedArrayBuffer` ring (fed by the
 * USB worker), runs a windowed FFT for the spectrum/waterfall AND a
 * mode-specific demodulator for audio. FFT bins are postMessaged to main
 * (throttled to a target frame rate); audio samples flow through a separate
 * SAB ring to the AudioWorklet.
 *
 * Demod modes implemented in B6a: WFM mono only. NFM/AM/SSB/CW land in
 * B6b–B6d.
 */

import init, { FftContext, WfmDemod } from '../lib/dsp/wasm/moshon_dsp.js';
import { SabRing } from '../lib/ring/sab-ring';

type InboundInit = {
  kind: 'init';
  iqRing: SharedArrayBuffer;
  audioRing: SharedArrayBuffer;
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

let iqRing: SabRing | null = null;
let audioRing: SabRing | null = null;
let fft: FftContext | null = null;
let wfm: WfmDemod | null = null;
let iqBufferForFft: Uint8Array | null = null;
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
    wfm = new WfmDemod();
    iqRing = new SabRing(opts.iqRing);
    audioRing = new SabRing(opts.audioRing);
    iqBufferForFft = new Uint8Array(opts.fftSize * 2);
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
  const yieldStep = () => new Promise<void>((resolve) => setTimeout(resolve, 4));
  // Local scratch buffer for draining bigger chunks for the demod path.
  // 1/30 s of IQ at 2.4 MS/s ≈ 80 000 samples × 2 bytes = 160 000 bytes.
  const demodScratch = new Uint8Array(160_000);

  while (running && iqRing && audioRing && fft && wfm && iqBufferForFft) {
    // --- FFT path: needs exactly fftSize samples (fftSize*2 bytes). ---
    if (iqRing.available() < iqBufferForFft.length) {
      await yieldStep();
      continue;
    }
    iqRing.read(iqBufferForFft);

    // Run FFT first (throttled).
    let bins: Float32Array | null = null;
    try {
      bins = fft.process(iqBufferForFft);
    } catch (err) {
      running = false;
      postOut({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Run WFM demod on the same chunk we just FFT'd.
    let audio: Float32Array;
    try {
      audio = wfm.process(iqBufferForFft);
    } catch (err) {
      running = false;
      postOut({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Push audio bytes into the audio ring (zero-copy via Uint8Array view).
    if (audio.length > 0) {
      const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
      audioRing.write(bytes);
    }

    // Drain extra IQ to keep the FFT/demod up with the producer. We
    // additionally process any backlog past one FFT chunk so the demod
    // doesn't fall behind.
    while (iqRing.available() >= demodScratch.length) {
      iqRing.read(demodScratch);
      try {
        const audioMore = wfm.process(demodScratch);
        if (audioMore.length > 0) {
          const moreBytes = new Uint8Array(
            audioMore.buffer,
            audioMore.byteOffset,
            audioMore.byteLength,
          );
          audioRing.write(moreBytes);
        }
      } catch (err) {
        running = false;
        postOut({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    // Post FFT frame to main, throttled.
    const now = performance.now();
    if (now - lastPostMs >= minPostIntervalMs) {
      lastPostMs = now;
      postOut({ kind: 'fft', bins, time: now }, [bins.buffer]);
    }
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
