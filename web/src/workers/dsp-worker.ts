/**
 * DSP Worker — reads IQ samples from a `SharedArrayBuffer` ring (fed by the
 * USB worker), runs a windowed FFT for the spectrum/waterfall AND a
 * mode-specific demodulator for audio. FFT bins are postMessaged to main
 * (throttled to a target frame rate); audio samples flow through a separate
 * SAB ring to the AudioWorklet.
 *
 * Demod modes implemented:
 *   - WFM (B6a)   — broadcast FM mono
 *   - NFM (B6b)   — narrowband FM, user-set bandwidth
 *   - AM  (B6b)   — envelope detector, user-set bandwidth
 *   - USB (B6c)   — Weaver SSB, upper sideband
 *   - LSB (B6c)   — Weaver SSB, lower sideband
 *   - CW  (B6d)   — narrow channel filter + 700 Hz BFO offset
 */

import init, {
  AmDemod,
  CwDemod,
  FftContext,
  NfmDemod,
  SsbDemod,
  WfmDemod,
} from '../lib/dsp/wasm/moshon_dsp.js';
import { SabRing } from '../lib/ring/sab-ring';

export type DemodMode = 'wfm' | 'nfm' | 'am' | 'usb' | 'lsb' | 'cw';

type InboundInit = {
  kind: 'init';
  iqRing: SharedArrayBuffer;
  audioRing: SharedArrayBuffer;
  fftSize: number;
  /** Target rate of FFT frames posted to main, in Hz. */
  postRateHz: number;
  mode: DemodMode;
  bandwidthHz: number;
};
type InboundSetMode = { kind: 'setMode'; mode: DemodMode; bandwidthHz: number };
type InboundStop = { kind: 'stop' };
type Inbound = InboundInit | InboundSetMode | InboundStop;

type OutboundReady = { kind: 'ready' };
type OutboundFft = { kind: 'fft'; bins: Float32Array; time: number };
type OutboundError = { kind: 'error'; message: string };
type Outbound = OutboundReady | OutboundFft | OutboundError;

type Demod = {
  process(iq: Uint8Array): Float32Array;
  free(): void;
};

let iqRing: SabRing | null = null;
let audioRing: SabRing | null = null;
let fft: FftContext | null = null;
let demod: Demod | null = null;
let currentMode: DemodMode = 'wfm';
let currentBandwidth = 200_000;
let iqBufferForFft: Uint8Array | null = null;
let running = false;
let minPostIntervalMs = 33;
let lastPostMs = 0;

function postOut(msg: Outbound, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer });
}

function buildDemod(mode: DemodMode, bandwidthHz: number): Demod {
  switch (mode) {
    case 'wfm':
      return new WfmDemod();
    case 'am':
      return new AmDemod(bandwidthHz);
    case 'nfm':
      return new NfmDemod(bandwidthHz);
    case 'usb':
      return new SsbDemod(bandwidthHz, false);
    case 'lsb':
      return new SsbDemod(bandwidthHz, true);
    case 'cw':
      return new CwDemod(bandwidthHz);
    default:
      return new WfmDemod();
  }
}

function rebuildDemod(mode: DemodMode, bandwidthHz: number) {
  demod?.free();
  demod = buildDemod(mode, bandwidthHz);
  currentMode = mode;
  currentBandwidth = bandwidthHz;
}

async function setup(opts: InboundInit) {
  try {
    await init();
    fft = new FftContext(opts.fftSize);
    rebuildDemod(opts.mode, opts.bandwidthHz);
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

  while (running && iqRing && audioRing && fft && demod && iqBufferForFft) {
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

    // Run demod on the same chunk we just FFT'd.
    let audio: Float32Array;
    try {
      audio = demod.process(iqBufferForFft);
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

    // Drain AT MOST one backlog chunk per iteration. Draining the entire
    // backlog inline (old behaviour) made each iteration take ~30 ms when
    // multiple chunks were queued, which pushed the FFT post rate down to
    // ~18 Hz and produced audio underruns at the worker's CPU ceiling.
    // Consumer rate with one chunk drained per ~12 ms iteration is still
    // ~6.8 MS/s — comfortably faster than the 2.4 MS/s producer — so any
    // startup backlog clears within a second or so.
    if (iqRing.available() >= demodScratch.length) {
      iqRing.read(demodScratch);
      try {
        const audioMore = demod.process(demodScratch);
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
    case 'setMode':
      if (msg.mode !== currentMode || msg.bandwidthHz !== currentBandwidth) {
        rebuildDemod(msg.mode, msg.bandwidthHz);
      }
      break;
    case 'stop':
      running = false;
      break;
  }
};
