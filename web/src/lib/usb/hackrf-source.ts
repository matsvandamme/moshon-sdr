/**
 * Main-thread API for a HackRF One source. Public surface matches
 * `RtlSdrSource` so the App.svelte input-mode switcher can drive either
 * dongle without caring which is which.
 *
 * Topology (identical to the RTL-SDR path):
 *   [Main thread]
 *     ├─ requestDevice() (user gesture)
 *     ├─ creates SAB ring (IQ)
 *     ├─ spawns HackRF Worker  ── writes offset-binary u8 IQ ──► SAB
 *     └─ spawns DSP Worker     ◄── reads IQ ──── SAB
 *                              ──► postMessage(FFT, audio, cwText, rds) ──► main
 */

import { SabRing } from '../ring/sab-ring';
import type { Mode } from '../state/tuning.svelte';
import { HACKRF_USB_FILTERS } from './hackrf-protocol';
import type { DemodMode } from '../../workers/dsp-worker';

const IQ_RING_CAPACITY_BYTES = 8 * 1024 * 1024;
const STATS_INTERVAL_MS = 250;

export type HackRfStatus = 'idle' | 'connecting' | 'connected' | 'streaming' | 'closing' | 'error';

export type StreamOptions = {
  sampleRate: number;
  centerFreq: number;
  gain: number | null;
  mode: Mode;
  bandwidthHz: number;
  fftSize?: number;
  fftRateHz?: number;
  audioRing: SharedArrayBuffer;
};

export type StatsEvent = { bytesWritten: number; bytesDropped: number; time: number };
export type FftEvent = { bins: Float32Array; time: number };
export type AudioEvent = { samples: Float32Array; time: number };
export type CwTextEvent = { text: string; wpm: number };
export type RdsEvent = {
  synced: boolean;
  pi: number;
  ps: string;
  rt: string;
  stereo: boolean;
};

export type StatsCallback = (evt: StatsEvent) => void;
export type FftCallback = (evt: FftEvent) => void;
export type AudioCallback = (evt: AudioEvent) => void;
export type CwTextCallback = (evt: CwTextEvent) => void;
export type RdsCallback = (evt: RdsEvent) => void;

// Mirror messages from hackrf-worker.ts.
type HrfStarted = { kind: 'started'; actualSampleRate: number; actualFrequency: number };
type HrfStats = { kind: 'stats'; bytesWritten: number; bytesDropped: number; time: number };
type HrfStopped = { kind: 'stopped' };
type HrfErr = { kind: 'error'; message: string };
type HrfOutbound = HrfStarted | HrfStats | HrfStopped | HrfErr;

// Mirror DSP worker.
type DspReady = { kind: 'ready' };
type DspFft = { kind: 'fft'; bins: Float32Array; time: number };
type DspAudio = { kind: 'audio'; samples: Float32Array; time: number };
type DspCwText = { kind: 'cwText'; text: string; wpm: number };
type DspRds = {
  kind: 'rds';
  synced: boolean;
  pi: number;
  ps: string;
  rt: string;
  stereo: boolean;
};
type DspErr = { kind: 'error'; message: string };
type DspOutbound = DspReady | DspFft | DspAudio | DspCwText | DspRds | DspErr;

export class HackRfSource {
  private hrfWorker: Worker | null = null;
  private dspWorker: Worker | null = null;
  private ring: SabRing | null = null;
  private device: USBDevice | null = null;

  private startResolver: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private stopResolver: { resolve: () => void } | null = null;

  private statsListeners = new Set<StatsCallback>();
  private fftListeners = new Set<FftCallback>();
  private audioListeners = new Set<AudioCallback>();
  private cwTextListeners = new Set<CwTextCallback>();
  private rdsListeners = new Set<RdsCallback>();

  async connect(): Promise<void> {
    if (this.device) return;
    if (!('usb' in navigator)) {
      throw new Error('WebUSB is not available in this browser. Use Chrome, Edge, or Brave.');
    }
    this.device = await navigator.usb.requestDevice({ filters: HACKRF_USB_FILTERS });
  }

  async start(opts: StreamOptions): Promise<void> {
    if (!this.device) throw new Error('connect() before start()');

    this.ring = SabRing.create(IQ_RING_CAPACITY_BYTES);
    const fftSize = opts.fftSize ?? 2048;
    const fftRateHz = opts.fftRateHz ?? 30;

    this.spawnWorkers();
    const startPromise = new Promise<void>((resolve, reject) => {
      this.startResolver = { resolve, reject };
    });

    this.dspWorker!.postMessage({
      kind: 'init',
      iqRing: this.ring.buffer,
      audioRing: opts.audioRing,
      fftSize,
      postRateHz: fftRateHz,
      mode: opts.mode,
      bandwidthHz: opts.bandwidthHz,
    });

    this.hrfWorker!.postMessage({
      kind: 'init',
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      serialNumber: this.device.serialNumber,
      sampleRate: opts.sampleRate,
      centerFreq: opts.centerFreq,
      gain: opts.gain,
      iqRing: this.ring.buffer,
      statsIntervalMs: STATS_INTERVAL_MS,
    });

    return startPromise;
  }

  retune(opts: { centerFreq?: number; gain?: number | null }): void {
    if (!this.hrfWorker) return;
    this.hrfWorker.postMessage({ kind: 'retune', ...opts });
  }

  setMode(mode: DemodMode, bandwidthHz: number): void {
    if (!this.dspWorker) return;
    this.dspWorker.postMessage({ kind: 'setMode', mode, bandwidthHz });
  }

  setRecording(on: boolean): void {
    if (!this.dspWorker) return;
    this.dspWorker.postMessage({ kind: 'setRecording', on });
  }

  async stop(): Promise<void> {
    if (!this.hrfWorker) return;
    const stopPromise = new Promise<void>((resolve) => {
      this.stopResolver = { resolve };
    });
    this.hrfWorker.postMessage({ kind: 'stop' });
    this.dspWorker?.postMessage({ kind: 'stop' });
    return stopPromise;
  }

  async disconnect(): Promise<void> {
    if (this.hrfWorker) {
      this.hrfWorker.postMessage({ kind: 'close' });
      this.hrfWorker.terminate();
      this.hrfWorker = null;
    }
    if (this.dspWorker) {
      this.dspWorker.postMessage({ kind: 'stop' });
      this.dspWorker.terminate();
      this.dspWorker = null;
    }
    this.ring = null;
    this.device = null;
    this.startResolver = null;
    this.stopResolver = null;
  }

  onStats(cb: StatsCallback): () => void {
    this.statsListeners.add(cb);
    return () => {
      this.statsListeners.delete(cb);
    };
  }

  onFft(cb: FftCallback): () => void {
    this.fftListeners.add(cb);
    return () => {
      this.fftListeners.delete(cb);
    };
  }

  onAudio(cb: AudioCallback): () => void {
    this.audioListeners.add(cb);
    return () => {
      this.audioListeners.delete(cb);
    };
  }

  onCwText(cb: CwTextCallback): () => void {
    this.cwTextListeners.add(cb);
    return () => {
      this.cwTextListeners.delete(cb);
    };
  }

  onRds(cb: RdsCallback): () => void {
    this.rdsListeners.add(cb);
    return () => {
      this.rdsListeners.delete(cb);
    };
  }

  private spawnWorkers(): void {
    if (!this.hrfWorker) {
      this.hrfWorker = new Worker(new URL('../../workers/hackrf-worker.ts', import.meta.url), {
        type: 'module',
      });
      this.hrfWorker.onmessage = (e: MessageEvent<HrfOutbound>) => this.handleHrf(e.data);
      this.hrfWorker.onerror = (e) => {
        const msg = e.message || 'HackRF worker crashed';
        this.startResolver?.reject(new Error(msg));
        this.startResolver = null;
      };
    }
    if (!this.dspWorker) {
      this.dspWorker = new Worker(new URL('../../workers/dsp-worker.ts', import.meta.url), {
        type: 'module',
      });
      this.dspWorker.onmessage = (e: MessageEvent<DspOutbound>) => this.handleDsp(e.data);
      this.dspWorker.onerror = (e) => {
        const msg = e.message || 'DSP worker crashed';
        this.startResolver?.reject(new Error(msg));
        this.startResolver = null;
      };
    }
  }

  private handleHrf(msg: HrfOutbound): void {
    switch (msg.kind) {
      case 'started':
        this.startResolver?.resolve();
        this.startResolver = null;
        break;
      case 'stats':
        for (const cb of this.statsListeners) {
          cb({ bytesWritten: msg.bytesWritten, bytesDropped: msg.bytesDropped, time: msg.time });
        }
        break;
      case 'stopped':
        this.stopResolver?.resolve();
        this.stopResolver = null;
        break;
      case 'error':
        this.startResolver?.reject(new Error(msg.message));
        this.startResolver = null;
        break;
    }
  }

  private handleDsp(msg: DspOutbound): void {
    switch (msg.kind) {
      case 'ready':
        break;
      case 'fft':
        for (const cb of this.fftListeners) {
          cb({ bins: msg.bins, time: msg.time });
        }
        break;
      case 'audio':
        for (const cb of this.audioListeners) {
          cb({ samples: msg.samples, time: msg.time });
        }
        break;
      case 'cwText':
        for (const cb of this.cwTextListeners) {
          cb({ text: msg.text, wpm: msg.wpm });
        }
        break;
      case 'rds':
        for (const cb of this.rdsListeners) {
          cb({ synced: msg.synced, pi: msg.pi, ps: msg.ps, rt: msg.rt, stereo: msg.stereo });
        }
        break;
      case 'error':
        this.startResolver?.reject(new Error(msg.message));
        this.startResolver = null;
        break;
    }
  }
}
