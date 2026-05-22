/**
 * Main-thread API for an RTL-SDR source. Spawns a Web Worker (see
 * usb-worker.ts) that owns the USBDevice and runs the readSamples loop
 * off-main-thread. The main thread only receives sample chunks via
 * postMessage and dispatches them to listeners.
 *
 * navigator.usb.requestDevice() must happen on the main thread inside a
 * user-gesture handler (Workers cannot trigger it), so connect() runs there
 * and transfers the USBDevice to the worker on start().
 *
 * Underlying driver: @jtarrio/webrtlsdr (Apache-2.0), MIT-compatible.
 */

/** USB vendor/product IDs of RTL2832U-class devices. Mirrors webrtlsdr's TUNERS. */
const RTL2832U_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0bda, productId: 0x2832 },
  { vendorId: 0x0bda, productId: 0x2838 },
];

const DEFAULT_CHUNK_SAMPLES = 65_536;

export type RtlSdrStatus = 'idle' | 'connecting' | 'connected' | 'streaming' | 'closing' | 'error';

export type StreamOptions = {
  sampleRate: number;
  centerFreq: number;
  gain: number | null;
};

export type SampleEvent = {
  /** Raw IQ samples — sequence of (U8, U8) pairs (I then Q). */
  data: ArrayBuffer;
  /** Tuned frequency when these samples were captured (Hz). */
  frequency: number;
  directSampling: boolean;
};

export type SamplesCallback = (evt: SampleEvent) => void;

type WorkerOutboundStarted = {
  kind: 'started';
  actualSampleRate: number;
  actualFrequency: number;
};
type WorkerOutboundSamples = {
  kind: 'samples';
  data: ArrayBuffer;
  frequency: number;
  directSampling: boolean;
};
type WorkerOutboundStopped = { kind: 'stopped' };
type WorkerOutboundError = { kind: 'error'; message: string };
type WorkerOutbound =
  | WorkerOutboundStarted
  | WorkerOutboundSamples
  | WorkerOutboundStopped
  | WorkerOutboundError;

export class RtlSdrSource {
  private worker: Worker | null = null;
  private device: USBDevice | null = null;
  private listeners = new Set<SamplesCallback>();
  /** Resolved when the worker confirms it started streaming, or rejected on error. */
  private startResolver: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private stopResolver: { resolve: () => void } | null = null;

  /**
   * Opens a device. Must be called inside a user-gesture handler (button click).
   * Shows the WebUSB device picker and stores the user's selection.
   */
  async connect(): Promise<void> {
    if (this.device) return;
    if (!('usb' in navigator)) {
      throw new Error('WebUSB is not available in this browser. Use Chrome, Edge, or Brave.');
    }
    this.device = await navigator.usb.requestDevice({ filters: RTL2832U_FILTERS });
  }

  /**
   * Spawns the USB worker (if needed) and starts streaming. The device the
   * user picked in connect() is permitted at the origin level, so the worker
   * can look it up via navigator.usb.getDevices() — we only pass identifiers.
   */
  async start(opts: StreamOptions): Promise<void> {
    if (!this.device) throw new Error('connect() before start()');

    if (!this.worker) {
      this.worker = new Worker(new URL('../../workers/usb-worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (e: MessageEvent<WorkerOutbound>) => this.handleMessage(e.data);
      this.worker.onerror = (e) => {
        this.startResolver?.reject(new Error(e.message || 'USB worker crashed'));
        this.startResolver = null;
      };
    }

    const startPromise = new Promise<void>((resolve, reject) => {
      this.startResolver = { resolve, reject };
    });

    this.worker.postMessage({
      kind: 'init',
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      serialNumber: this.device.serialNumber,
      sampleRate: opts.sampleRate,
      centerFreq: opts.centerFreq,
      gain: opts.gain,
      chunkSamples: DEFAULT_CHUNK_SAMPLES,
    });

    return startPromise;
  }

  /** Asks the worker to stop streaming. Device remains open until disconnect(). */
  async stop(): Promise<void> {
    if (!this.worker) return;
    const stopPromise = new Promise<void>((resolve) => {
      this.stopResolver = { resolve };
    });
    this.worker.postMessage({ kind: 'stop' });
    return stopPromise;
  }

  /** Stops streaming, closes the device, and terminates the worker. */
  async disconnect(): Promise<void> {
    if (this.worker) {
      this.worker.postMessage({ kind: 'close' });
      this.worker.terminate();
      this.worker = null;
    }
    this.device = null;
    this.startResolver = null;
    this.stopResolver = null;
  }

  /** Subscribe to sample chunks. Returns an unsubscribe function. */
  onSamples(cb: SamplesCallback): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private handleMessage(msg: WorkerOutbound) {
    switch (msg.kind) {
      case 'started':
        this.startResolver?.resolve();
        this.startResolver = null;
        break;
      case 'samples':
        for (const listener of this.listeners) {
          listener({
            data: msg.data,
            frequency: msg.frequency,
            directSampling: msg.directSampling,
          });
        }
        break;
      case 'stopped':
        this.stopResolver?.resolve();
        this.stopResolver = null;
        break;
      case 'error': {
        const err = new Error(msg.message);
        this.startResolver?.reject(err);
        this.startResolver = null;
        // No clean way to surface mid-stream errors from here; the listener-
        // less API means UIs poll for state. B4b will revisit when there's
        // more to react to.
        break;
      }
    }
  }
}
