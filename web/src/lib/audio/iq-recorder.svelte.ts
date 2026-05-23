/**
 * IQ recorder — accumulates raw IQ chunks tapped from the DSP worker
 * and on stop emits an SDR#-compatible WAV (auxi chunk with center
 * frequency). The IQ stream is the same offset-binary u8 wire format
 * the workers already use, so encoding is a pass-through copy.
 *
 * Memory bound: hard cap at MAX_BYTES below. The IQ rate matters here
 * — at 2.4 MS/s the cap holds ~53 s; at 8 MS/s ~16 s; at 20 MS/s ~6 s.
 * That's enough for "I want to review what just happened" but not for
 * long captures — if you want hours, swap this for the File System
 * Access API streaming-to-disk pattern.
 */

import { encodeIqWav } from './iq-wav-encoder';
import { formatHz, tuning, MODE_INFO } from '../state/tuning.svelte';

/** Hard upper bound on retained IQ bytes. 256 MB. */
const MAX_BYTES = 256 * 1024 * 1024;

function createIqRecorder() {
  let recording = $state(false);
  let totalBytes = $state(0);
  let startedAt = $state<number | null>(null);
  let elapsedMs = $state(0);
  /** Wallclock at first push — used as the WAV auxi StartTime. */
  let startedWallclock: Date | null = null;
  /** IQ sample rate at the moment recording started. */
  let sampleRate = 0;
  /** Center frequency at the moment recording started. */
  let centerFreqHz = 0;
  let chunks: Uint8Array[] = [];
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
    get totalBytes() {
      return totalBytes;
    },
    get elapsedMs() {
      return elapsedMs;
    },
    /** Approximate seconds captured (only valid if `sampleRate > 0`). */
    get seconds(): number {
      if (sampleRate <= 0) return 0;
      // 2 bytes per IQ sample pair.
      return totalBytes / (sampleRate * 2);
    },
    get atCap(): boolean {
      return totalBytes >= MAX_BYTES;
    },
    get capMb(): number {
      return MAX_BYTES / (1024 * 1024);
    },

    /** Start a new capture. Caller passes the current stream params so
     *  the WAV header reflects what was actually captured. */
    start(opts: { sampleRate: number; centerFreqHz: number }) {
      if (recording) return;
      chunks = [];
      totalBytes = 0;
      sampleRate = opts.sampleRate;
      centerFreqHz = opts.centerFreqHz;
      startedAt = performance.now();
      startedWallclock = new Date();
      elapsedMs = 0;
      recording = true;
      tick();
    },

    /** Append a chunk of raw u8 IQ bytes. Returns false if the cap was
     *  reached (caller should stop). */
    push(bytes: Uint8Array): boolean {
      if (!recording) return false;
      if (totalBytes + bytes.length > MAX_BYTES) {
        const room = MAX_BYTES - totalBytes;
        if (room > 0) {
          chunks.push(bytes.subarray(0, room));
          totalBytes += room;
        }
        return false;
      }
      chunks.push(bytes);
      totalBytes += bytes.length;
      return true;
    },

    /** Stop, encode to a WAV blob, trigger a download. Returns seconds. */
    stopAndDownload(): number {
      if (!recording) return 0;
      cancelAnimationFrame(tickHandle);
      recording = false;
      const seconds = sampleRate > 0 ? totalBytes / (sampleRate * 2) : 0;

      const blob = encodeIqWav(chunks, {
        sampleRate,
        centerFreqHz,
        startTime: startedWallclock ?? undefined,
        stopTime: new Date(),
      });
      chunks = []; // release before fetching

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = makeFilename(centerFreqHz, sampleRate);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1_000);

      return seconds;
    },

    cancel() {
      cancelAnimationFrame(tickHandle);
      recording = false;
      chunks = [];
      totalBytes = 0;
      elapsedMs = 0;
      startedAt = null;
      startedWallclock = null;
    },
  };
}

function makeFilename(centerFreqHz: number, sampleRate: number): string {
  // moshon-iq-100100000Hz-2400000sps-WFM-2026-05-24T00-30-00.wav
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const freq = centerFreqHz > 0 ? formatHz(centerFreqHz).replace(/\s+/g, '') : 'unkHz';
  const sps = sampleRate > 0 ? `${sampleRate}sps` : 'unksps';
  const mode = MODE_INFO[tuning.mode].label;
  return `moshon-iq-${freq}-${sps}-${mode}-${ts}.wav`;
}

export const iqRecorder = createIqRecorder();
export type IqRecorder = typeof iqRecorder;
