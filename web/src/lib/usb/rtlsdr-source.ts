/**
 * Main-thread API for an RTL-SDR source.
 *
 * Topology:
 *   [Main thread]
 *     ├─ requestDevice() (user gesture)
 *     ├─ creates SAB ring (IQ)
 *     ├─ spawns USB Worker  ──── writes IQ ──► SAB
 *     └─ spawns DSP Worker  ◄─── reads IQ ──── SAB
 *                            ──► postMessage(FFT frame) ──► main
 *
 * The main thread doesn't see raw IQ; it only receives FFT frames (for
 * spectrum/waterfall) and lightweight stats (sample counts). The two workers
 * run in parallel and don't compete with the UI for CPU.
 *
 * Underlying driver: @jtarrio/webrtlsdr (Apache-2.0).
 */

import { SabRing } from '../ring/sab-ring';
import type { DemodMode } from '../../workers/dsp-worker';

const RTL2832U_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0bda, productId: 0x2832 },
  { vendorId: 0x0bda, productId: 0x2838 },
];

const DEFAULT_CHUNK_SAMPLES = 65_536;
/** SAB ring capacity (bytes). At 2.4 MS/s × 2 bytes/sample = 4.8 MB/s, 8 MB gives ~1.7 s buffer. */
const IQ_RING_CAPACITY_BYTES = 8 * 1024 * 1024;
const STATS_INTERVAL_MS = 250;

export type RtlSdrStatus = 'idle' | 'connecting' | 'connected' | 'streaming' | 'closing' | 'error';

export type StreamOptions = {
  sampleRate: number;
  centerFreq: number;
  gain: number | null;
  /** FFT bin count (power of two, 64..16384). Default 2048. */
  fftSize?: number;
  /** Target rate of FFT frames delivered to listeners (Hz). Default 30. */
  fftRateHz?: number;
  /** Demodulator mode the DSP worker should run on this stream. */
  mode: DemodMode;
  /** Channel filter bandwidth in Hz (used by NFM/AM, ignored by WFM). */
  bandwidthHz: number;
  /**
   * SharedArrayBuffer the DSP worker writes 48 kHz mono f32 PCM into,
   * to be consumed by an AudioWorklet on the main thread.
   */
  audioRing: SharedArrayBuffer;
};

export type StatsEvent = {
  /** Bytes of IQ written by the USB worker (cumulative across the stream). */
  bytesWritten: number;
  /** Bytes dropped because the SAB ring was full. */
  bytesDropped: number;
  /** performance.now() timestamp at which stats were sampled. */
  time: number;
};

export type FftEvent = {
  /** Log-magnitude per bin in dBFS, length = fftSize, fftshifted (DC at centre). */
  bins: Float32Array;
  /** performance.now() timestamp of when the FFT was computed in the DSP worker. */
  time: number;
};

export type StatsCallback = (evt: StatsEvent) => void;
export type FftCallback = (evt: FftEvent) => void;

// USB-worker outbound message shapes (mirror usb-worker.ts).
type UsbStarted = { kind: 'started'; actualSampleRate: number; actualFrequency: number };
type UsbStats = { kind: 'stats'; bytesWritten: number; bytesDropped: number; time: number };
type UsbStopped = { kind: 'stopped' };
type UsbErr = { kind: 'error'; message: string };
type UsbOutbound = UsbStarted | UsbStats | UsbStopped | UsbErr;

// DSP-worker outbound message shapes (mirror dsp-worker.ts).
type DspReady = { kind: 'ready' };
type DspFft = { kind: 'fft'; bins: Float32Array; time: number };
type DspErr = { kind: 'error'; message: string };
type DspOutbound = DspReady | DspFft | DspErr;

export class RtlSdrSource {
  private usbWorker: Worker | null = null;
  private dspWorker: Worker | null = null;
  private ring: SabRing | null = null;
  private device: USBDevice | null = null;

  private startResolver: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private stopResolver: { resolve: () => void } | null = null;

  private statsListeners = new Set<StatsCallback>();
  private fftListeners = new Set<FftCallback>();

  /**
   * Opens a device via the WebUSB picker. Must be called inside a user-gesture
   * handler (button click). The chosen device is recorded; the actual USB
   * `open` + configure happens inside the USB worker on `start()`.
   */
  async connect(): Promise<void> {
    if (this.device) return;
    if (!('usb' in navigator)) {
      throw new Error('WebUSB is not available in this browser. Use Chrome, Edge, or Brave.');
    }
    this.device = await navigator.usb.requestDevice({ filters: RTL2832U_FILTERS });
  }

  /** Spawns both workers, gives them the SAB ring, and starts streaming. */
  async start(opts: StreamOptions): Promise<void> {
    if (!this.device) throw new Error('connect() before start()');

    this.ring = SabRing.create(IQ_RING_CAPACITY_BYTES);

    const fftSize = opts.fftSize ?? 2048;
    const fftRateHz = opts.fftRateHz ?? 30;

    this.spawnWorkers();

    const startPromise = new Promise<void>((resolve, reject) => {
      this.startResolver = { resolve, reject };
    });

    // DSP worker boots first so it's ready to drain the ring as soon as USB
    // worker starts writing.
    this.dspWorker!.postMessage({
      kind: 'init',
      iqRing: this.ring.buffer,
      audioRing: opts.audioRing,
      fftSize,
      postRateHz: fftRateHz,
      mode: opts.mode,
      bandwidthHz: opts.bandwidthHz,
    });

    this.usbWorker!.postMessage({
      kind: 'init',
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      serialNumber: this.device.serialNumber,
      sampleRate: opts.sampleRate,
      centerFreq: opts.centerFreq,
      gain: opts.gain,
      chunkSamples: DEFAULT_CHUNK_SAMPLES,
      iqRing: this.ring.buffer,
      statsIntervalMs: STATS_INTERVAL_MS,
    });

    return startPromise;
  }

  /**
   * Retune the device without restarting the stream. Pass any subset of the
   * mutable parameters. Safe to call rapidly (e.g. from a drag handler) —
   * the worker queues them in postMessage order.
   */
  retune(opts: { centerFreq?: number; gain?: number | null }): void {
    if (!this.usbWorker) return;
    this.usbWorker.postMessage({
      kind: 'retune',
      ...opts,
    });
  }

  /**
   * Switch the demodulator without restarting the stream. The DSP worker
   * disposes the old demod and constructs a new one in-place; the IQ ring
   * is unaffected so audio resumes within a frame.
   */
  setMode(mode: DemodMode, bandwidthHz: number): void {
    if (!this.dspWorker) return;
    this.dspWorker.postMessage({ kind: 'setMode', mode, bandwidthHz });
  }

  /** Stops streaming. Device remains permitted but the workers shut down. */
  async stop(): Promise<void> {
    if (!this.usbWorker) return;
    const stopPromise = new Promise<void>((resolve) => {
      this.stopResolver = { resolve };
    });
    this.usbWorker.postMessage({ kind: 'stop' });
    this.dspWorker?.postMessage({ kind: 'stop' });
    return stopPromise;
  }

  async disconnect(): Promise<void> {
    if (this.usbWorker) {
      this.usbWorker.postMessage({ kind: 'close' });
      this.usbWorker.terminate();
      this.usbWorker = null;
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

  private spawnWorkers(): void {
    if (!this.usbWorker) {
      this.usbWorker = new Worker(new URL('../../workers/usb-worker.ts', import.meta.url), {
        type: 'module',
      });
      this.usbWorker.onmessage = (e: MessageEvent<UsbOutbound>) => this.handleUsb(e.data);
      this.usbWorker.onerror = (e) => {
        const msg = e.message || 'USB worker crashed';
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

  private handleUsb(msg: UsbOutbound): void {
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
        // DSP is up; USB worker can start writing whenever it wants.
        break;
      case 'fft':
        for (const cb of this.fftListeners) {
          cb({ bins: msg.bins, time: msg.time });
        }
        break;
      case 'error':
        // Surface via the same error path as USB worker errors.
        this.startResolver?.reject(new Error(msg.message));
        this.startResolver = null;
        break;
    }
  }
}
