/**
 * Main-thread API for a remote rtl_tcp source over a WebSocket bridge.
 *
 * Topology:
 *   [Main thread]
 *     ├─ creates SAB IQ ring
 *     ├─ spawns Network Worker  ── reads WS bytes, writes IQ to SAB
 *     └─ spawns DSP Worker      ── reads IQ from SAB, posts FFT + audio
 *
 * Same SAB ring layout as `RtlSdrSource`. The bridge URL is supplied by the
 * user (privacy: per MEMORY.md decisions, the URL is NEVER stored in the
 * URL hash — it stays in localStorage at most).
 */

import { SabRing } from '../ring/sab-ring';
import type { Mode } from '../state/tuning.svelte';

/** SAB ring capacity (bytes). Matches RtlSdrSource for parity. */
const IQ_RING_CAPACITY_BYTES = 8 * 1024 * 1024;

export type RtlTcpStatus = 'idle' | 'connecting' | 'streaming' | 'closing' | 'error';

export type StreamOptions = {
  bridgeUrl: string;
  /** Optional override of the bridge's default rtl_tcp target. host:port. */
  rtlTcpTarget?: string;
  sampleRate: number;
  centerFreq: number;
  gain: number | null;
  mode: Mode;
  bandwidthHz: number;
  fftSize?: number;
  fftRateHz?: number;
  audioRing: SharedArrayBuffer;
};

export type StatsEvent = {
  bytesWritten: number;
  bytesDropped: number;
  time: number;
};

export type FftEvent = {
  bins: Float32Array;
  time: number;
};

export type AudioEvent = {
  samples: Float32Array;
  time: number;
};

export type CwTextEvent = {
  text: string;
  wpm: number;
};

export type StatsCallback = (evt: StatsEvent) => void;
export type FftCallback = (evt: FftEvent) => void;
export type AudioCallback = (evt: AudioEvent) => void;
export type CwTextCallback = (evt: CwTextEvent) => void;

// Mirror outbound shapes from network-worker.ts.
type NetStarted = { kind: 'started'; tunerType: number; tunerGainCount: number };
type NetStats = { kind: 'stats'; bytesWritten: number; bytesDropped: number; time: number };
type NetStopped = { kind: 'stopped' };
type NetErr = { kind: 'error'; message: string };
type NetOutbound = NetStarted | NetStats | NetStopped | NetErr;

// Mirror DSP worker.
type DspReady = { kind: 'ready' };
type DspFft = { kind: 'fft'; bins: Float32Array; time: number };
type DspAudio = { kind: 'audio'; samples: Float32Array; time: number };
type DspCwText = { kind: 'cwText'; text: string; wpm: number };
type DspErr = { kind: 'error'; message: string };
type DspOutbound = DspReady | DspFft | DspAudio | DspCwText | DspErr;

export class RtlTcpSource {
  private netWorker: Worker | null = null;
  private dspWorker: Worker | null = null;
  private ring: SabRing | null = null;

  private startResolver: { resolve: () => void; reject: (err: Error) => void } | null = null;

  private statsListeners = new Set<StatsCallback>();
  private fftListeners = new Set<FftCallback>();
  private audioListeners = new Set<AudioCallback>();
  private cwTextListeners = new Set<CwTextCallback>();

  /** Construct the WebSocket URL from a bridge base URL + optional target. */
  static buildWsUrl(bridgeUrl: string, rtlTcpTarget?: string): string {
    const trimmed = bridgeUrl.trim().replace(/\/+$/, '');
    if (trimmed.length === 0) throw new Error('Bridge URL is empty');
    // Accept http(s)://, ws(s)://, or bare host:port.
    let base = trimmed;
    if (/^https?:\/\//i.test(base)) {
      base = base.replace(/^http/i, 'ws');
    } else if (!/^wss?:\/\//i.test(base)) {
      base = `ws://${base}`;
    }
    const url = `${base}/ws`;
    if (rtlTcpTarget && rtlTcpTarget.trim().length > 0) {
      return `${url}?target=${encodeURIComponent(rtlTcpTarget.trim())}`;
    }
    return url;
  }

  async start(opts: StreamOptions): Promise<void> {
    this.ring = SabRing.create(IQ_RING_CAPACITY_BYTES);

    const fftSize = opts.fftSize ?? 2048;
    const fftRateHz = opts.fftRateHz ?? 30;
    const wsUrl = RtlTcpSource.buildWsUrl(opts.bridgeUrl, opts.rtlTcpTarget);

    this.spawnWorkers();

    const startPromise = new Promise<void>((resolve, reject) => {
      this.startResolver = { resolve, reject };
    });

    // DSP worker boots first so it's ready to drain.
    this.dspWorker!.postMessage({
      kind: 'init',
      iqRing: this.ring.buffer,
      audioRing: opts.audioRing,
      fftSize,
      postRateHz: fftRateHz,
      mode: opts.mode,
      bandwidthHz: opts.bandwidthHz,
    });

    this.netWorker!.postMessage({
      kind: 'init',
      url: wsUrl,
      iqRing: this.ring.buffer,
      sampleRate: opts.sampleRate,
      centerFreq: opts.centerFreq,
      gain: opts.gain,
    });

    return startPromise;
  }

  retune(opts: { centerFreq?: number; gain?: number | null }): void {
    if (!this.netWorker) return;
    this.netWorker.postMessage({ kind: 'retune', ...opts });
  }

  setMode(mode: Mode, bandwidthHz: number): void {
    if (!this.dspWorker) return;
    this.dspWorker.postMessage({ kind: 'setMode', mode, bandwidthHz });
  }

  setRecording(on: boolean): void {
    if (!this.dspWorker) return;
    this.dspWorker.postMessage({ kind: 'setRecording', on });
  }

  async stop(): Promise<void> {
    this.netWorker?.postMessage({ kind: 'stop' });
    this.dspWorker?.postMessage({ kind: 'stop' });
  }

  async disconnect(): Promise<void> {
    if (this.netWorker) {
      this.netWorker.postMessage({ kind: 'stop' });
      this.netWorker.terminate();
      this.netWorker = null;
    }
    if (this.dspWorker) {
      this.dspWorker.postMessage({ kind: 'stop' });
      this.dspWorker.terminate();
      this.dspWorker = null;
    }
    this.ring = null;
    this.startResolver = null;
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

  private spawnWorkers(): void {
    if (!this.netWorker) {
      this.netWorker = new Worker(
        new URL('../../workers/network-worker.ts', import.meta.url),
        { type: 'module' },
      );
      this.netWorker.onmessage = (e: MessageEvent<NetOutbound>) => this.handleNet(e.data);
      this.netWorker.onerror = (e) => {
        const msg = e.message || 'Network worker crashed';
        this.startResolver?.reject(new Error(msg));
        this.startResolver = null;
      };
    }
    if (!this.dspWorker) {
      this.dspWorker = new Worker(
        new URL('../../workers/dsp-worker.ts', import.meta.url),
        { type: 'module' },
      );
      this.dspWorker.onmessage = (e: MessageEvent<DspOutbound>) => this.handleDsp(e.data);
      this.dspWorker.onerror = (e) => {
        const msg = e.message || 'DSP worker crashed';
        this.startResolver?.reject(new Error(msg));
        this.startResolver = null;
      };
    }
  }

  private handleNet(msg: NetOutbound): void {
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
      case 'error':
        this.startResolver?.reject(new Error(msg.message));
        this.startResolver = null;
        break;
    }
  }
}
