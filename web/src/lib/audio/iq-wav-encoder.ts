/**
 * WAV encoder for raw IQ captures (SDR# / HDSDR / SDRangel compatible).
 *
 * Wire format inside the file:
 *   - RIFF/WAVE container
 *   - `fmt ` chunk: PCM, 2 channels, 8-bit unsigned, sample rate = IQ rate
 *   - `auxi` chunk: SDR# metadata (center freq, ADC sample rate, timestamps)
 *   - `data` chunk: interleaved I,Q bytes exactly as produced by the worker
 *
 * The 8-bit-unsigned offset-binary form (128 = zero) is the wire layout
 * RTL-SDR produces and the HackRF path repacks to. So this encoder is a
 * pass-through on the IQ bytes — no conversion needed.
 *
 * The auxi chunk lets SDR# / HDSDR pick up the center frequency
 * automatically. Tools that don't recognise auxi still get a valid WAV
 * they can demod manually (and the filename also embeds the freq).
 */

const RIFF_HEADER_BYTES = 12; // "RIFF" + size + "WAVE"
const FMT_CHUNK_BYTES = 8 + 16; // header + body
const AUXI_CHUNK_BYTES = 8 + 68; // header + body
const DATA_HEADER_BYTES = 8; // "data" + size
const TOTAL_HEADER_BYTES =
  RIFF_HEADER_BYTES + FMT_CHUNK_BYTES + AUXI_CHUNK_BYTES + DATA_HEADER_BYTES;

export type IqWavParams = {
  /** IQ sample rate, e.g. 2_400_000. */
  sampleRate: number;
  /** RF center frequency in Hz at the time the capture started. */
  centerFreqHz: number;
  /** Capture start time (defaults to first chunk arrival). */
  startTime?: Date;
  /** Capture stop time (defaults to now). */
  stopTime?: Date;
};

/**
 * Build a WAV `Blob` from chunks of raw u8 IQ bytes. Chunks are
 * concatenated in order; no resampling, no metadata loss.
 */
export function encodeIqWav(chunks: Uint8Array[], params: IqWavParams): Blob {
  const dataBytes = chunks.reduce((acc, c) => acc + c.length, 0);
  const buffer = new ArrayBuffer(TOTAL_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, TOTAL_HEADER_BYTES + dataBytes - 8, true);
  writeAscii(view, 8, 'WAVE');

  // fmt chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // body size
  view.setUint16(20, 1, true); // format = 1 (PCM)
  view.setUint16(22, 2, true); // channels = 2 (I, Q)
  view.setUint32(24, params.sampleRate, true);
  view.setUint32(28, params.sampleRate * 2, true); // byte rate (8-bit × 2ch)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 8, true); // bits per sample

  // auxi chunk (SDR# metadata format)
  writeAscii(view, 36, 'auxi');
  view.setUint32(40, 68, true); // body size
  // StartTime SYSTEMTIME (16 bytes) @ offset 44
  writeSystemTime(view, 44, params.startTime ?? new Date());
  // StopTime SYSTEMTIME (16 bytes) @ offset 60
  writeSystemTime(view, 60, params.stopTime ?? new Date());
  // CenterFreq (4) @ 76
  view.setUint32(76, params.centerFreqHz >>> 0, true);
  // ADFrequency (4) @ 80 — ADC sample rate, same as IQ rate
  view.setUint32(80, params.sampleRate, true);
  // IFFrequency (4) @ 84 — zero-IF
  view.setUint32(84, 0, true);
  // Bandwidth (4) @ 88
  view.setUint32(88, 0, true);
  // IQOffset (4) @ 92
  view.setUint32(92, 0, true);
  // Unused2..5 (16 bytes) @ 96-112
  for (let i = 96; i < 112; i++) view.setUint8(i, 0);

  // data chunk
  writeAscii(view, 112, 'data');
  view.setUint32(116, dataBytes, true);

  // payload — copy chunks straight in
  const bytes = new Uint8Array(buffer);
  let offset = TOTAL_HEADER_BYTES;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}

function writeSystemTime(view: DataView, offset: number, d: Date) {
  view.setUint16(offset + 0, d.getFullYear(), true);
  view.setUint16(offset + 2, d.getMonth() + 1, true);
  view.setUint16(offset + 4, d.getDay(), true);
  view.setUint16(offset + 6, d.getDate(), true);
  view.setUint16(offset + 8, d.getHours(), true);
  view.setUint16(offset + 10, d.getMinutes(), true);
  view.setUint16(offset + 12, d.getSeconds(), true);
  view.setUint16(offset + 14, d.getMilliseconds(), true);
}
