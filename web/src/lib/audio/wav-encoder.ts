/**
 * Tiny WAV encoder — 16-bit PCM, stereo, 48 kHz.
 *
 * Takes the raw interleaved L,R Float32Array chunks accumulated by the
 * recorder and produces a Blob ready for download. We keep this scoped
 * narrow on purpose: no resampling, no metadata chunks, no 24-bit support.
 * If the user wants those, a v2 can add them.
 */

const RIFF_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;

export type WavParams = {
  /** Sample rate of each channel, e.g. 48000. */
  sampleRate: number;
  /** Number of channels. 1 = mono, 2 = stereo. */
  channels: number;
};

/**
 * Encode interleaved float samples (range typically [-1, 1]) as a single
 * 16-bit PCM WAV `Blob`. Out-of-range samples are clipped, not normalized —
 * the caller decides whether to scale.
 */
export function encodeWav(chunks: Float32Array[], params: WavParams): Blob {
  const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0);
  const dataBytes = totalSamples * 2; // 16-bit = 2 bytes per sample
  const buffer = new ArrayBuffer(RIFF_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // file size minus 8
  writeAscii(view, 8, 'WAVE');

  // fmt chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = 1 (PCM)
  view.setUint16(22, params.channels, true);
  view.setUint32(24, params.sampleRate, true);
  view.setUint32(
    28,
    params.sampleRate * params.channels * (BITS_PER_SAMPLE / 8),
    true,
  ); // byte rate
  view.setUint16(32, params.channels * (BITS_PER_SAMPLE / 8), true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);

  // data chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  // Samples — clip + convert f32 → int16.
  let offset = RIFF_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      // Asymmetric scaling (max amplitude = 32767, min = -32768) so a unity
      // negative peak doesn't wrap.
      const v = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, v | 0, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}
