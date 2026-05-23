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
  /** WFM audio de-emphasis time constant in microseconds. 50 (ITU R1 /
   *  Europe) or 75 (Americas / Japan). Defaults to 50 if omitted. */
  deemphasisUs?: number;
  /** Initial squelch threshold (dBFS) for NFM / AM. Pass -120 (or
   *  omit) to disable. */
  squelchDb?: number;
  /** Audio AGC on at startup. Default off. */
  agcOn?: boolean;
};
type InboundSetMode = { kind: 'setMode'; mode: DemodMode; bandwidthHz: number };
type InboundStop = { kind: 'stop' };
type InboundSetRecording = { kind: 'setRecording'; on: boolean };
type InboundSetDeemphasis = { kind: 'setDeemphasis'; us: number };
type InboundSetSquelch = { kind: 'setSquelch'; db: number };
type InboundSetAgc = { kind: 'setAgc'; on: boolean };
type InboundSetIqRecording = { kind: 'setIqRecording'; on: boolean };
type Inbound =
  | InboundInit
  | InboundSetMode
  | InboundStop
  | InboundSetRecording
  | InboundSetDeemphasis
  | InboundSetSquelch
  | InboundSetAgc
  | InboundSetIqRecording;

type OutboundReady = { kind: 'ready' };
type OutboundFft = { kind: 'fft'; bins: Float32Array; time: number };
type OutboundAudio = { kind: 'audio'; samples: Float32Array; time: number };
type OutboundCwText = { kind: 'cwText'; text: string; wpm: number };
type OutboundAdsb = { kind: 'adsbFrames'; framesJson: string };
type OutboundSquelch = { kind: 'squelch'; open: boolean };
type OutboundIq = { kind: 'iq'; samples: Uint8Array; time: number };
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
  | OutboundSquelch
  | OutboundIq
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

/** Soft-limit each sample to ±1.0 in-place. Linear pass-through below
 *  ±LIMIT_KNEE; smooth tanh-style roll-off above. Prevents speaker-pop
 *  on transient peaks (a strong signal kicking the demod, an unsquelched
 *  noise spike, etc.) without colouring nominal-level audio. */
const LIMIT_KNEE = 0.85;
const LIMIT_HEADROOM = 1 - LIMIT_KNEE;
function softLimitInPlace(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const ax = x < 0 ? -x : x;
    if (ax <= LIMIT_KNEE) continue;
    const s = x < 0 ? -1 : 1;
    const over = (ax - LIMIT_KNEE) / LIMIT_HEADROOM;
    buf[i] = s * (LIMIT_KNEE + LIMIT_HEADROOM * Math.tanh(over));
  }
}

/** Simple feed-forward AGC keyed off the mid-channel RMS. Levels
 *  inter-station volume so one user doesn't have to keep riding the
 *  volume slider. Asymmetric attack / release: gain comes DOWN fast on
 *  a loud signal, but goes UP slowly so quiet passages aren't pumped.
 *  Off by default; the limiter still catches whatever the AGC misses. */
class AudioAgc {
  enabled = false;
  private rmsSq = 1e-4;
  private gain = 1.0;
  /** Target RMS post-AGC. ≈ -12 dBFS leaves comfortable headroom above
   *  the limiter knee. */
  private static readonly TARGET = 0.25;
  private static readonly MIN_GAIN = 0.5;
  private static readonly MAX_GAIN = 8.0;
  /** RMS smoothing: ~30 ms at 48 kHz so syllables don't trigger fast
   *  swings. α = exp(-1/(0.030 × 48000)). */
  private static readonly RMS_ALPHA = 0.9993;
  /** Gain-down (attack) smoothing: ~5 ms. */
  private static readonly ATTACK_ALPHA = 0.996;
  /** Gain-up (release) smoothing: ~500 ms. */
  private static readonly RELEASE_ALPHA = 0.99996;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.gain = 1.0;
      this.rmsSq = 1e-4;
    }
  }

  /** Apply AGC to an interleaved stereo Float32Array in place. */
  applyInPlace(stereo: Float32Array): void {
    if (!this.enabled) return;
    const n = stereo.length;
    let rmsSq = this.rmsSq;
    let gain = this.gain;
    for (let i = 0; i < n; i += 2) {
      const l = stereo[i];
      const r = stereo[i + 1];
      const mid = (l + r) * 0.5;
      rmsSq = AudioAgc.RMS_ALPHA * rmsSq + (1 - AudioAgc.RMS_ALPHA) * (mid * mid);
      const rms = Math.sqrt(rmsSq);
      let target = AudioAgc.TARGET / Math.max(rms, 1e-5);
      if (target < AudioAgc.MIN_GAIN) target = AudioAgc.MIN_GAIN;
      else if (target > AudioAgc.MAX_GAIN) target = AudioAgc.MAX_GAIN;
      const alpha = target < gain ? AudioAgc.ATTACK_ALPHA : AudioAgc.RELEASE_ALPHA;
      gain = alpha * gain + (1 - alpha) * target;
      stereo[i] = l * gain;
      stereo[i + 1] = r * gain;
    }
    this.rmsSq = rmsSq;
    this.gain = gain;
  }
}

const audioAgc = new AudioAgc();

let iqRing: SabRing | null = null;
let audioRing: SabRing | null = null;
let fft: FftContext | null = null;
let demod: Demod | null = null;
let currentMode: DemodMode = 'wfm';
let currentSampleRate = 2_400_000;
let currentBandwidth = 200_000;
/** WFM audio de-emphasis time constant in microseconds. Applied at
 *  WfmDemod construction time. Default 50 (Europe). */
let currentDeemphasisUs = 50;
/** Squelch threshold in dBFS for NFM / AM. -120 (or any value ≤ that)
 *  means the gate is disabled and audio always passes. */
let currentSquelchDb = -120;
let iqBufferForFft: Uint8Array | null = null;
let running = false;
let minPostIntervalMs = 33;
let lastPostMs = 0;
let recording = false;
let iqRecording = false;
let cwDecoder: CwDecoder | null = null;
let adsbDemod: AdsbDemod | null = null;
let wfmDemodRef: WfmDemod | null = null;
let nfmDemodRef: NfmDemod | null = null;
let amDemodRef: AmDemod | null = null;
let squelchTickerHandle: ReturnType<typeof setInterval> | null = null;
let lastSquelchOpen: boolean | null = null;
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

/**
 * Forward a copy of the raw IQ bytes to main if IQ recording is on.
 * Copy is unavoidable — the worker reuses its IQ scratch buffer across
 * the FFT, demod, and (when on) ADS-B paths.
 */
function maybeTapIqForRecording(bytes: Uint8Array) {
  if (!iqRecording || bytes.length === 0) return;
  const copy = new Uint8Array(bytes);
  postOut({ kind: 'iq', samples: copy, time: performance.now() }, [copy.buffer]);
}

function buildDemod(mode: DemodMode, bandwidthHz: number, sampleRate: number): Demod {
  switch (mode) {
    case 'wfm': {
      const w = new WfmDemod(sampleRate);
      w.set_deemphasis_us(currentDeemphasisUs);
      wfmDemodRef = w;
      return w;
    }
    case 'am': {
      const a = new AmDemod(sampleRate, bandwidthHz);
      a.set_squelch_db(currentSquelchDb);
      amDemodRef = a;
      return a;
    }
    case 'nfm': {
      const n = new NfmDemod(sampleRate, bandwidthHz);
      n.set_squelch_db(currentSquelchDb);
      nfmDemodRef = n;
      return n;
    }
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
  if (mode !== 'nfm') nfmDemodRef = null;
  if (mode !== 'am') amDemodRef = null;
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
  startOrStopSquelchTicker();
}

function startOrStopSquelchTicker() {
  // Poll the active demod's squelch state at 10 Hz while in NFM / AM
  // mode. Only post when the state changes so we don't spam main.
  const needsTicker =
    (currentMode === 'nfm' && nfmDemodRef !== null) ||
    (currentMode === 'am' && amDemodRef !== null);
  if (needsTicker && !squelchTickerHandle) {
    squelchTickerHandle = setInterval(() => {
      const d = currentMode === 'nfm' ? nfmDemodRef : amDemodRef;
      if (!d) return;
      const open = d.is_squelch_open;
      if (open !== lastSquelchOpen) {
        lastSquelchOpen = open;
        postOut({ kind: 'squelch', open });
      }
    }, 100);
  } else if (!needsTicker && squelchTickerHandle) {
    clearInterval(squelchTickerHandle);
    squelchTickerHandle = null;
    if (lastSquelchOpen !== null) {
      lastSquelchOpen = null;
      // Mode left NFM/AM: tell UI to drop the indicator.
      postOut({ kind: 'squelch', open: true });
    }
  }
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
    if (typeof opts.deemphasisUs === 'number' && opts.deemphasisUs > 0) {
      currentDeemphasisUs = opts.deemphasisUs;
    }
    if (typeof opts.squelchDb === 'number') {
      currentSquelchDb = opts.squelchDb;
    }
    if (typeof opts.agcOn === 'boolean') {
      audioAgc.setEnabled(opts.agcOn);
    }
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
    maybeTapIqForRecording(iqBufferForFft);

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
        maybeTapIqForRecording(demodScratch);
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
        maybeTapIqForRecording(demodScratch);
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
      audioAgc.applyInPlace(stereo);
      softLimitInPlace(stereo);
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
      maybeTapIqForRecording(demodScratch);
      try {
        const audioMore = demod.process(demodScratch);
        if (audioMore.length > 0) {
          const stereoMore =
            currentMode === 'wfm' ? audioMore : monoToInterleavedStereo(audioMore);
          audioAgc.applyInPlace(stereoMore);
          softLimitInPlace(stereoMore);
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
    case 'setDeemphasis':
      if (typeof msg.us === 'number' && msg.us > 0) {
        currentDeemphasisUs = msg.us;
        // Apply live if we're currently demodulating WFM. Other modes
        // pick the new value up on their next WFM construction.
        if (wfmDemodRef) wfmDemodRef.set_deemphasis_us(msg.us);
      }
      break;
    case 'setSquelch':
      if (typeof msg.db === 'number') {
        currentSquelchDb = msg.db;
        if (nfmDemodRef) nfmDemodRef.set_squelch_db(msg.db);
        if (amDemodRef) amDemodRef.set_squelch_db(msg.db);
      }
      break;
    case 'setAgc':
      audioAgc.setEnabled(msg.on);
      break;
    case 'setIqRecording':
      iqRecording = msg.on;
      break;
    case 'stop':
      running = false;
      if (rdsTickerHandle) {
        clearInterval(rdsTickerHandle);
        rdsTickerHandle = null;
      }
      if (squelchTickerHandle) {
        clearInterval(squelchTickerHandle);
        squelchTickerHandle = null;
      }
      break;
  }
};
