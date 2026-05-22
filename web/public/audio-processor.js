/**
 * Moshon SDR audio worklet — pulls 48 kHz INTERLEAVED STEREO PCM from a
 * SharedArrayBuffer ring fed by the DSP worker and writes to a 2-channel
 * output.
 *
 * The ring stores interleaved L,R,L,R,... f32 samples. One "frame" =
 * 2 floats = 8 bytes. Non-WFM demods produce L=R (so the audio is still
 * mono-equivalent) but the layout is consistent so the worklet never has
 * to switch modes.
 *
 * Ring buffer layout (must match web/src/lib/ring/sab-ring.ts):
 *   bytes 0..3 : writePos (Int32, mod 2 * capacity)
 *   bytes 4..7 : readPos  (Int32, mod 2 * capacity)
 *   bytes 8..n : body of `capacity` bytes
 */

const HEADER_BYTES = 8;
const WRITE_POS = 0;
const READ_POS = 1;
const F32_BYTES = 4;
const CHANNELS = 2;
const FRAME_BYTES = CHANNELS * F32_BYTES; // 8

class PcmRingPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sab = options.processorOptions.sab;
    this.header = new Int32Array(sab, 0, 2);
    this.body = new Uint8Array(sab, HEADER_BYTES);
    this.bodyF32 = new Float32Array(sab, HEADER_BYTES, this.body.length / F32_BYTES);
    this.capacityBytes = this.body.length;
    this.modBytes = this.capacityBytes * 2;

    this.volume = 1;
    this.muted = false;

    this.samplesPlayed = 0;
    this.samplesUnderrun = 0;
    this.lastStatsPost = currentTime;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && typeof m === 'object') {
        if (typeof m.volume === 'number') this.volume = m.volume;
        if (typeof m.muted === 'boolean') this.muted = m.muted;
      }
    };

    this.port.postMessage({ kind: 'ready', capacityBytes: this.capacityBytes });
  }

  process(_inputs, outputs) {
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1] ?? outL;
    if (!outL) return true;
    const wantFrames = outL.length;

    const w = Atomics.load(this.header, WRITE_POS);
    const r = Atomics.load(this.header, READ_POS);
    const used = (w - r + this.modBytes) % this.modBytes;
    const availFrames = Math.floor(used / FRAME_BYTES);
    const takeFrames = Math.min(wantFrames, availFrames);

    const gain = this.muted ? 0 : this.volume;

    if (takeFrames > 0) {
      // rIdxBytes points at the next byte to read. Each frame is 8 bytes
      // (L, R as f32 LE). We compute the f32 index for indexing bodyF32
      // directly — this is cheap because the body was created as Float32Array.
      const rIdxBytes = r % this.capacityBytes;
      const rIdxF32 = rIdxBytes / F32_BYTES;
      // How many frames before we wrap the ring.
      const framesUntilWrap = (this.capacityBytes - rIdxBytes) / FRAME_BYTES;
      const tailFrames = Math.min(takeFrames, framesUntilWrap);
      // First part
      for (let i = 0; i < tailFrames; i++) {
        outL[i] = this.bodyF32[rIdxF32 + i * CHANNELS] * gain;
        outR[i] = this.bodyF32[rIdxF32 + i * CHANNELS + 1] * gain;
      }
      // Wrap part
      for (let i = tailFrames; i < takeFrames; i++) {
        const j = (i - tailFrames) * CHANNELS;
        outL[i] = this.bodyF32[j] * gain;
        outR[i] = this.bodyF32[j + 1] * gain;
      }
      Atomics.store(
        this.header,
        READ_POS,
        (r + takeFrames * FRAME_BYTES) % this.modBytes,
      );
    }

    // Underrun — pad with silence on both channels.
    for (let i = takeFrames; i < wantFrames; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }

    // Telemetry. We report frames (not float samples) so "Played" stays
    // intuitive — one "sample" = one moment in time, regardless of channel
    // count.
    this.samplesPlayed += takeFrames;
    this.samplesUnderrun += wantFrames - takeFrames;
    if (currentTime - this.lastStatsPost >= 0.1) {
      this.lastStatsPost = currentTime;
      this.port.postMessage({
        kind: 'stats',
        samplesPlayed: this.samplesPlayed,
        samplesUnderrun: this.samplesUnderrun,
        ringUsedBytes: (w - r + this.modBytes) % this.modBytes,
      });
    }

    return true;
  }
}

registerProcessor('moshon-pcm-player', PcmRingPlayer);
