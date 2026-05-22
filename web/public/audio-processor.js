/**
 * Moshon SDR audio worklet — pulls 48 kHz mono PCM samples from a
 * SharedArrayBuffer ring fed by the DSP worker and writes them to the
 * audio output.
 *
 * Lives in /public/ (served verbatim) because AudioWorkletProcessor files
 * load via `audioContext.audioWorklet.addModule(url)` and need a stable
 * URL. No imports here — the audio thread runs an isolated global scope.
 *
 * Ring buffer layout (must match web/src/lib/ring/sab-ring.ts):
 *   bytes 0..3 : writePos (Int32, mod 2 * capacity)
 *   bytes 4..7 : readPos  (Int32, mod 2 * capacity)
 *   bytes 8..n : body of `capacity` bytes
 *
 * Each PCM frame is one 4-byte f32 little-endian.
 */

const HEADER_BYTES = 8;
const WRITE_POS = 0;
const READ_POS = 1;
const F32_BYTES = 4;

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

    // Telemetry — surface to main so the UI can show whether the audio
    // pipeline is alive. Posted ~every 100 ms.
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

    // Tell main we're alive. processorOptions arrived intact, ring is wired.
    this.port.postMessage({ kind: 'ready', capacityBytes: this.capacityBytes });
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const wantSamples = out.length;
    const wantBytes = wantSamples * F32_BYTES;

    const w = Atomics.load(this.header, WRITE_POS);
    const r = Atomics.load(this.header, READ_POS);
    const used = (w - r + this.modBytes) % this.modBytes;
    const availSamples = Math.floor(used / F32_BYTES);
    const takeSamples = Math.min(wantSamples, availSamples);

    const gain = this.muted ? 0 : this.volume;

    if (takeSamples > 0) {
      const rIdxBytes = r % this.capacityBytes;
      const rIdxF32 = rIdxBytes / F32_BYTES;
      const tail = Math.min(takeSamples, (this.capacityBytes - rIdxBytes) / F32_BYTES);
      // First part (up to end of buffer)
      for (let i = 0; i < tail; i++) {
        out[i] = this.bodyF32[rIdxF32 + i] * gain;
      }
      // Wrap-around part
      for (let i = tail; i < takeSamples; i++) {
        out[i] = this.bodyF32[i - tail] * gain;
      }
      Atomics.store(
        this.header,
        READ_POS,
        (r + takeSamples * F32_BYTES) % this.modBytes,
      );
    }

    // Underrun — pad rest of buffer with silence.
    for (let i = takeSamples; i < wantSamples; i++) {
      out[i] = 0;
    }

    // Telemetry
    this.samplesPlayed += takeSamples;
    this.samplesUnderrun += wantSamples - takeSamples;
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
