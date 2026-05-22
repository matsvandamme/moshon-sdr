/**
 * Audio recorder — accumulates demodulated audio batches forwarded from
 * the DSP worker, and on stop emits a 16-bit PCM WAV download.
 *
 * Memory bound: ~5 minutes of stereo 48 kHz f32 = 115 MB. We cap at
 * MAX_SAMPLES below; recording auto-stops when reached and the user is
 * prompted to download whatever was captured.
 *
 * The recorder taps the DSP path (pre-volume / pre-mute), so muting the
 * UI while recording is fine — the file contains the demodulated audio
 * at unity gain.
 */

import { encodeWav } from './wav-encoder';
import { formatHz, tuning, MODE_INFO } from '../state/tuning.svelte';

const AUDIO_RATE = 48_000;
const CHANNELS = 2;
const MAX_MINUTES = 5;
const MAX_SAMPLES = AUDIO_RATE * CHANNELS * 60 * MAX_MINUTES;

function createRecorder() {
  let recording = $state(false);
  let totalSamples = $state(0);
  let startedAt = $state<number | null>(null);
  let elapsedMs = $state(0);
  let chunks: Float32Array[] = [];
  let tickHandle = 0;

  function tick() {
    if (startedAt !== null) {
      elapsedMs = performance.now() - startedAt;
    }
    if (recording) {
      tickHandle = requestAnimationFrame(tick);
    }
  }

  return {
    get recording() {
      return recording;
    },
    /** Total interleaved-sample count (not seconds). */
    get totalSamples() {
      return totalSamples;
    },
    get elapsedMs() {
      return elapsedMs;
    },
    /** Approximate seconds of audio captured. */
    get seconds(): number {
      return totalSamples / (AUDIO_RATE * CHANNELS);
    },
    /** Hit at `MAX_MINUTES`. */
    get atCap(): boolean {
      return totalSamples >= MAX_SAMPLES;
    },
    /** Cap, exposed for UI display. */
    get capMinutes(): number {
      return MAX_MINUTES;
    },

    start() {
      if (recording) return;
      chunks = [];
      totalSamples = 0;
      startedAt = performance.now();
      elapsedMs = 0;
      recording = true;
      tick();
    },

    /**
     * Append a batch of interleaved L,R f32 samples. Returns false if the
     * cap was reached (caller should call stop()).
     */
    push(samples: Float32Array): boolean {
      if (!recording) return false;
      if (totalSamples + samples.length > MAX_SAMPLES) {
        // Take what we can fit, drop the rest.
        const room = MAX_SAMPLES - totalSamples;
        if (room > 0) {
          chunks.push(samples.subarray(0, room));
          totalSamples += room;
        }
        return false;
      }
      chunks.push(samples);
      totalSamples += samples.length;
      return true;
    },

    /**
     * Stop recording, encode as WAV, trigger a download, reset state.
     * Returns the duration in seconds for UI feedback.
     */
    stopAndDownload(): number {
      if (!recording) return 0;
      cancelAnimationFrame(tickHandle);
      recording = false;
      const seconds = totalSamples / (AUDIO_RATE * CHANNELS);

      const blob = encodeWav(chunks, { sampleRate: AUDIO_RATE, channels: CHANNELS });
      chunks = []; // release memory ASAP after the Blob has been built

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = makeFilename();
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Give the browser a moment to fetch the blob before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 1_000);

      return seconds;
    },

    /** Drop accumulated samples without saving. */
    cancel() {
      cancelAnimationFrame(tickHandle);
      recording = false;
      chunks = [];
      totalSamples = 0;
      elapsedMs = 0;
      startedAt = null;
    },
  };
}

function makeFilename(): string {
  // moshon-145300000Hz-NFM-2026-05-22T19-58-12.wav
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const freq = formatHz(tuning.centerFreq).replace(/\s+/g, '');
  const mode = MODE_INFO[tuning.mode].label;
  return `moshon-${freq}-${mode}-${ts}.wav`;
}

export const recorder = createRecorder();
export type Recorder = typeof recorder;
