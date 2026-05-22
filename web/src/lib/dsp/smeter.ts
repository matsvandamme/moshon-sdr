/**
 * Crude S-meter — peak dBFS in the center channel.
 *
 * The DSP worker delivers `fftSize` log-magnitude bins per frame, fftshifted
 * (DC at the middle). We take the peak over the bins spanning the demod's
 * channel bandwidth. Real S-units calibration vs the dongle hardware is
 * left for a future pass — see the calibration TODO in MEMORY.md.
 *
 * The result is a dBFS reading (≤ 0). UI code can map this to a colored
 * bar or S-number label downstream.
 */

export function peakDbInChannel(
  bins: Float32Array,
  sampleRate: number,
  bandwidthHz: number,
): number {
  if (!bins || bins.length === 0) return Number.NEGATIVE_INFINITY;
  const center = bins.length / 2;
  // How many bins on each side of DC the channel covers.
  const halfBinsRaw = (bandwidthHz / 2) * (bins.length / sampleRate);
  // Always look at at least one bin on each side (for very narrow CW etc).
  const half = Math.max(1, Math.round(halfBinsRaw));
  const lo = Math.max(0, Math.floor(center - half));
  const hi = Math.min(bins.length, Math.ceil(center + half));
  let peak = Number.NEGATIVE_INFINITY;
  for (let i = lo; i < hi; i++) {
    const v = bins[i];
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Map a dBFS peak to a rough "S" indicator on a 0..9 + S9+10/+20/+30 scale.
 * Calibration is arbitrary; the curve is monotonic and the breakpoints are
 * sensible for an RTL-SDR at moderate gain. Revisit after on-air measurements.
 */
export function dbToSUnit(db: number): { sNumber: number; plus: number } {
  // Below -100 dBFS = effectively no signal.
  if (!Number.isFinite(db)) return { sNumber: 0, plus: 0 };
  // Each S-unit = 6 dB conventionally. Anchor S9 at -50 dBFS.
  const s9Db = -50;
  const delta = db - s9Db;
  if (delta >= 0) {
    // Plus reading above S9.
    const plus = Math.min(60, Math.round(delta / 10) * 10);
    return { sNumber: 9, plus };
  }
  const sNumber = Math.max(0, 9 + Math.round(delta / 6));
  return { sNumber, plus: 0 };
}
