/**
 * Thin wrapper around @jtarrio/webrtlsdr that gives us a stable internal
 * API for B3+ milestones. Keeps the rest of the app insulated from the
 * underlying library so we can swap implementations (or add a mock source)
 * without churning UI code.
 *
 * Apache-2.0 dependency, MIT-compatible.
 */

import { RTL2832U_Provider, type RtlDevice, type SampleBlock } from '@jtarrio/webrtlsdr/rtlsdr.js';

export type RtlSdrStatus = 'idle' | 'connecting' | 'connected' | 'streaming' | 'closing' | 'error';

export type StreamOptions = {
  /** Samples per second. Typical RTL-SDR values: 240k, 1.024M, 1.4M, 1.8M, 2.048M, 2.4M, 2.56M, 2.88M, 3.2M. */
  sampleRate: number;
  /** Center frequency in Hz. */
  centerFreq: number;
  /** Tuner gain in dB, or `null` for automatic gain control (AGC). */
  gain: number | null;
};

export type SamplesCallback = (block: SampleBlock) => void;

const READ_CHUNK_SAMPLES = 65_536;

/**
 * Wraps a single RTL-SDR device. Lifecycle: idle → connecting → connected
 * → streaming → connected (after stop) → closing → idle (after disconnect).
 *
 * connect() must be called from a user-gesture handler (e.g. button click)
 * because it triggers `navigator.usb.requestDevice()` which is gated by the
 * browser to require user activation.
 */
export class RtlSdrSource {
  private provider = new RTL2832U_Provider();
  private device: RtlDevice | null = null;
  private running = false;
  private listeners = new Set<SamplesCallback>();
  private loopPromise: Promise<void> | null = null;

  /** Opens a device. Must be called inside a user-gesture handler. */
  async connect(): Promise<void> {
    if (this.device) return;
    this.device = await this.provider.get();
  }

  /** Configures the device and begins streaming samples. */
  async start(opts: StreamOptions): Promise<void> {
    if (!this.device) throw new Error('connect() before start()');
    if (this.running) return;

    await this.device.setSampleRate(opts.sampleRate);
    await this.device.setCenterFrequency(opts.centerFreq);
    await this.device.setGain(opts.gain);
    await this.device.resetBuffer();

    this.running = true;
    this.loopPromise = this.readLoop();
  }

  /** Stops the streaming loop. Does NOT close the device — call disconnect() for that. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } finally {
        this.loopPromise = null;
      }
    }
  }

  /** Stops streaming if needed, then releases the device. */
  async disconnect(): Promise<void> {
    await this.stop();
    if (this.device) {
      try {
        await this.device.close();
      } finally {
        this.device = null;
      }
    }
  }

  /** Subscribe to sample blocks. Returns an unsubscribe function. */
  onSamples(cb: SamplesCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get isConnected(): boolean {
    return this.device !== null;
  }

  get isStreaming(): boolean {
    return this.running;
  }

  private async readLoop(): Promise<void> {
    while (this.running && this.device) {
      let block: SampleBlock;
      try {
        block = await this.device.readSamples(READ_CHUNK_SAMPLES);
      } catch (err) {
        // Device unplugged, USB error, etc. Surface via an empty notify; the
        // UI sets its own error state by observing isStreaming flipping.
        this.running = false;
        throw err;
      }
      for (const listener of this.listeners) listener(block);
    }
  }
}
