/**
 * Audio pipeline — manages the AudioContext, the AudioWorklet that consumes
 * PCM samples from a SAB ring, and the gain/mute controls.
 *
 * Created lazily on the first user gesture (Start). The AudioWorklet module
 * is loaded from /audio-processor.js (served from web/public/).
 */

import { SabRing } from '../ring/sab-ring';

const AUDIO_PROCESSOR_URL = '/audio-processor.js';
const AUDIO_RATE = 48_000;

/** PCM ring capacity in bytes. 48000 floats × 4 = 192 kB, ~1 sec of audio. */
const PCM_RING_CAPACITY = 192_000;

export type AudioStats = {
  samplesPlayed: number;
  samplesUnderrun: number;
  ringUsedBytes: number;
};

export type AudioStatsCallback = (s: AudioStats) => void;

export class AudioPipeline {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  ring: SabRing | null = null;
  private ready = false;
  private statsListeners = new Set<AudioStatsCallback>();
  private workletReady = false;
  private contextSampleRate: number | null = null;

  /** True once the pipeline is constructed and connected. */
  get isReady(): boolean {
    return this.ready;
  }

  /** True once the AudioWorklet processor confirmed it constructed correctly. */
  get isWorkletReady(): boolean {
    return this.workletReady;
  }

  get sampleRate(): number {
    return this.contextSampleRate ?? AUDIO_RATE;
  }

  onStats(cb: AudioStatsCallback): () => void {
    this.statsListeners.add(cb);
    return () => {
      this.statsListeners.delete(cb);
    };
  }

  /**
   * Initialize the AudioContext + Worklet. Must be called from a user
   * gesture (the AudioContext starts suspended otherwise). Idempotent.
   */
  async init(): Promise<void> {
    if (this.ready) return;
    this.ring = SabRing.create(PCM_RING_CAPACITY);

    // Don't pin the sample rate. Trying to force 48 kHz on a 44.1 kHz-only
    // system throws NotSupportedError. Accept whatever the system gives us;
    // a slight pitch shift is far less bad than silence. (Resampler can land
    // in B6b if it matters.)
    this.ctx = new AudioContext();
    this.contextSampleRate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule(AUDIO_PROCESSOR_URL);

    this.workletNode = new AudioWorkletNode(this.ctx, 'moshon-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sab: this.ring.buffer },
    });
    this.workletNode.port.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'ready') {
        this.workletReady = true;
      } else if (m.kind === 'stats') {
        for (const cb of this.statsListeners) {
          cb({
            samplesPlayed: m.samplesPlayed,
            samplesUnderrun: m.samplesUnderrun,
            ringUsedBytes: m.ringUsedBytes,
          });
        }
      }
    };
    this.workletNode.connect(this.ctx.destination);

    // AudioContexts start suspended in some browsers — explicitly resume.
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.ready = true;
  }

  setVolume(v: number): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ volume: Math.max(0, Math.min(1, v)) });
  }

  setMuted(m: boolean): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ muted: m });
  }

  async close(): Promise<void> {
    try {
      this.workletNode?.disconnect();
    } catch {
      // ignore
    }
    this.workletNode = null;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        // ignore
      }
      this.ctx = null;
    }
    this.ring = null;
    this.ready = false;
  }
}
