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
  AdsbDemod,
  AmDemod,
  CwDemod,
  FftContext,
  NfmDemod,
  SsbDemod,
  WfmDemod,
} from '../lib/dsp/wasm/moshon_dsp.js';
import { SabRing } from '../lib/ring/sab-ring';
import { CwDecoder } from '../lib/dsp/cw-decoder';

export type DemodMode = 'wfm' | 'nfm' | 'am' | 'usb' | 'lsb' | 'cw' | 'adsb' | 'lora';

type InboundInit = {
  kind: 'init';
  iqRing: SharedArrayBuffer;
  audioRing: SharedArrayBuffer;
  fftSize: number;
  /** Target rate of FFT frames posted to main, in Hz. */
  postRateHz: number;
  mode: DemodMode;
  bandwidthHz: number;
  /** IQ sample rate the demods should configure for. Required field;
   *  defaulting hides bugs when the source forgets to pass it. */
  sampleRate: number;
};
type InboundSetMode = { kind: 'setMode'; mode: DemodMode; bandwidthHz: number };
type InboundStop = { kind: 'stop' };
type InboundSetRecording = { kind: 'setRecording'; on: boolean };
type Inbound = InboundInit | InboundSetMode | InboundStop | InboundSetRecording;

type OutboundReady = { kind: 'ready' };
type OutboundFft = { kind: 'fft'; bins: Float32Array; time: number };
type OutboundAudio = { kind: 'audio'; samples: Float32Array; time: number };
type OutboundCwText = { kind: 'cwText'; text: string; wpm: number };
type OutboundAdsb = { kind: 'adsbFrames'; framesJson: string };
type OutboundRds = {
  kind: 'rds';
  synced: boolean;
  pi: number;
  ps: string;
  rt: string;
  stereo: boolean;
};
type OutboundError = { kind: 'error'; message: string };
type Outbound =
  | OutboundReady
  | OutboundFft
  | OutboundAudio
  | OutboundCwText
  | OutboundAdsb
  | OutboundRds
  | OutboundError;

type Demod = {
  process(iq: Uint8Array): Float32Array;
  free(): void;
};

/**
 * Build a stereo (interleaved L,R,L,R,…) Float32Array from a mono input.
 * WfmDemod already produces interleaved output; every other demod returns
 * mono, so we duplicate each sample into both channels here. The audio
 * ring layout is always stereo.
 */
function monoToInterleavedStereo(mono: Float32Array): Float32Array {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    out[2 * i] = mono[i];
    out[2 * i + 1] = mono[i];
  }
  return out;
}

let iqRing: SabRing | null = null;
let audioRing: SabRing | null = null;
let fft: FftContext | null = null;
let demod: Demod | null = null;
let currentMode: DemodMode = 'wfm';
let currentSampleRate = 2_400_000;
let currentBandwidth = 200_000;
let iqBufferForFft: Uint8Array | null = null;
let running = false;
let minPostIntervalMs = 33;
let lastPostMs = 0;
let recording = false;
let cwDecoder: CwDecoder | null = null;
let adsbDemod: AdsbDemod | null = null;
let wfmDemodRef: WfmDemod | null = null;
let rdsTickerHandle: ReturnType<typeof setInterval> | null = null;
let lastRdsPi = -1;
let lastRdsPs = '';
let lastRdsRt = '';
let lastRdsSynced = false;
let lastRdsStereo = false;

function postOut(msg: Outbound, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer });
}

/**
 * If recording is on, ship a transferable copy of `stereo` (interleaved L,R
 * f32) back to main. We copy because the original is also being pushed into
 * the audio SAB ring — transferring would empty it.
 */
function maybeTapForRecording(stereo: Float32Array) {
  if (!recording || stereo.length === 0) return;
  const copy = new Float32Array(stereo);
  postOut({ kind: 'audio', samples: copy, time: performance.now() }, [copy.buffer]);
}

function buildDemod(mode: DemodMode, bandwidthHz: number, sampleRate: number): Demod {
  switch (mode) {
    case 'wfm': {
      const w = new WfmDemod(sampleRate);
      wfmDemodRef = w;
      return w;
    }
    case 'am':
      return new AmDemod(sampleRate, bandwidthHz);
    case 'nfm':
      return new NfmDemod(sampleRate, bandwidthHz);
    case 'usb':
      return new SsbDemod(sampleRate, bandwidthHz, false);
    case 'lsb':
      return new SsbDemod(sampleRate, bandwidthHz, true);
    case 'cw':
      return new CwDemod(sampleRate, bandwidthHz);
    case 'adsb':
    case 'lora':
      // Neither ADS-B nor LoRa uses the audio demod path — the loop
      // branches above. Return a sentinel that's never called.
      return ADSB_NULL_DEMOD;
    default:
      return new WfmDemod(sampleRate);
  }
}

/** Sentinel returned for ADS-B mode. process_loop never calls .process()
 *  on it; the ADS-B path runs `adsbDemod.process()` instead. */
const ADSB_NULL_DEMOD: Demod = {
  process: () => new Float32Array(0),
  free: () => {},
};

function rebuildDemod(mode: DemodMode, bandwidthHz: number) {
  demod?.free();
  if (mode !== 'wfm') wfmDemodRef = null;
  demod = buildDemod(mode, bandwidthHz, currentSampleRate);
  currentMode = mode;
  currentBandwidth = bandwidthHz;
  // Reset the CW decoder state on mode change so leftover patterns from a
  // previous CW session don't bleed into the next one.
  cwDecoder?.reset();
  // (Re)create ADS-B decoder only when entering ADS-B mode.
  if (mode === 'adsb') {
    adsbDemod?.free();
    adsbDemod = new AdsbDemod(currentSampleRate);
  } else if (adsbDemod) {
    adsbDemod.free();
    adsbDemod = null;
  }
  // Clear cached RDS for the new mode so the UI clears immediately.
  lastRdsPi = -1;
  lastRdsPs = '';
  lastRdsRt = '';
  lastRdsSynced = false;
  lastRdsStereo = false;
  startOrStopRdsTicker();
}

function startOrStopRdsTicker() {
  // Poll the WfmDemod's RDS accessors at 2 Hz when in WFM mode. Only post
  // if something actually changed to keep main-thread work down.
  if (currentMode === 'wfm' && !rdsTickerHandle) {
    rdsTickerHandle = setInterval(() => {
      if (!wfmDemodRef) return;
      const synced = wfmDemodRef.rds_synced;
      const pi = wfmDemodRef.rds_pi;
      const ps = wfmDemodRef.rds_ps();
      const rt = wfmDemodRef.rds_rt();
      const stereo = wfmDemodRef.is_stereo_locked;
      if (
        synced !== lastRdsSynced ||
        pi !== lastRdsPi ||
        ps !== lastRdsPs ||
        rt !== lastRdsRt ||
        stereo !== lastRdsStereo
      ) {
        lastRdsSynced = synced;
        lastRdsPi = pi;
        lastRdsPs = ps;
        lastRdsRt = rt;
        lastRdsStereo = stereo;
        postOut({ kind: 'rds', synced, pi, ps, rt, stereo });
      }
    }, 500);
  } else if (currentMode !== 'wfm' && rdsTickerHandle) {
    clearInterval(rdsTickerHandle);
    rdsTickerHandle = null;
    // Send a final empty event so the UI clears its panel.
    postOut({ kind: 'rds', synced: false, pi: 0, ps: '', rt: '', stereo: false });
  }
}

/**
 * Feed a mono Float32Array (or the L channel of an interleaved stereo
 * buffer) into the CW decoder. Posts a `cwText` message if any characters
 * were produced.
 */
function maybeDecodeCw(mono: Float32Array) {
  if (currentMode !== 'cw' || mono.length === 0) return;
  if (!cwDecoder) cwDecoder = new CwDecoder();
  const text = cwDecoder.process(mono);
  if (text.length > 0) {
    postOut({ kind: 'cwText', text, wpm: cwDecoder.currentWpm });
  }
}

async function setup(opts: InboundInit) {
  try {
    await init();
    const sr = Number(opts.sampleRate);
    if (!Number.isFinite(sr) || sr <= 0) {
      throw new Error(`DSP worker: invalid sampleRate ${String(opts.sampleRate)}`);
    }
    currentSampleRate = sr;
    fft = new FftContext(opts.fftSize);
    rebuildDemod(opts.mode, opts.bandwidthHz);
    iqRing = new SabRing(opts.iqRing);
    audioRing = new SabRing(opts.audioRing);
    iqBufferForFft = new Uint8Array(opts.fftSize * 2);
    minPostIntervalMs = 1000 / Math.max(1, opts.postRateHz);
    lastPostMs = 0;
    running = true;
    startOrStopRdsTicker();
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

    // LoRa monitor: spectrum-only. We don't have a payload decoder yet
    // (CSS demod is multi-week work scheduled for v3); the mode just
    // keeps the FFT live at the tuned ISM frequency so the user can see
    // chirp activity. Drain the backlog to avoid falling behind.
    if (currentMode === 'lora') {
      while (iqRing.available() >= demodScratch.length) {
        iqRing.read(demodScratch);
      }
      const nowL = performance.now();
      if (nowL - lastPostMs >= minPostIntervalMs) {
        lastPostMs = nowL;
        postOut({ kind: 'fft', bins, time: nowL }, [bins.buffer]);
      }
      continue;
    }

    // ADS-B branch: feed IQ to AdsbDemod, drain any frames, skip audio.
    if (currentMode === 'adsb' && adsbDemod) {
      try {
        adsbDemod.process(iqBufferForFft);
      } catch (err) {
        running = false;
        postOut({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        return;
      }
      // Also drain the backlog so we don't fall behind at 4.8 MB/s.
      while (iqRing.available() >= demodScratch.length) {
        iqRing.read(demodScratch);
        try {
          adsbDemod.process(demodScratch);
        } catch (err) {
          running = false;
          postOut({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
          return;
        }
      }
      // Post the FFT (throttled) and drained frames.
      const framesJson = adsbDemod.drain_frames_json();
      if (framesJson !== '[]') {
        postOut({ kind: 'adsbFrames', framesJson });
      }
      const now = performance.now();
      if (now - lastPostMs >= minPostIntervalMs) {
        lastPostMs = now;
        postOut({ kind: 'fft', bins, time: now }, [bins.buffer]);
      }
      continue;
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

    // Push audio bytes into the audio ring. WFM returns interleaved stereo
    // already; everything else returns mono and we duplicate to L=R here.
    if (audio.length > 0) {
      const stereo =
        currentMode === 'wfm' ? audio : monoToInterleavedStereo(audio);
      const bytes = new Uint8Array(stereo.buffer, stereo.byteOffset, stereo.byteLength);
      audioRing.write(bytes);
      maybeTapForRecording(stereo);
      // CW is always mono-from-demod (we duplicated above to L=R); feed
      // the raw mono buffer to the decoder.
      if (currentMode === 'cw') maybeDecodeCw(audio);
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
          const stereoMore =
            currentMode === 'wfm' ? audioMore : monoToInterleavedStereo(audioMore);
          const moreBytes = new Uint8Array(
            stereoMore.buffer,
            stereoMore.byteOffset,
            stereoMore.byteLength,
          );
          audioRing.write(moreBytes);
          maybeTapForRecording(stereoMore);
          if (currentMode === 'cw') maybeDecodeCw(audioMore);
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
    case 'setRecording':
      recording = msg.on;
      break;
    case 'stop':
      running = false;
      if (rdsTickerHandle) {
        clearInterval(rdsTickerHandle);
        rdsTickerHandle = null;
      }
      break;
  }
};
