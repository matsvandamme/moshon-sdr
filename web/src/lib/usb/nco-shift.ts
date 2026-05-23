/**
 * Software offset tuning — frequency-shift u8 IQ bytes in-place.
 *
 * The DC spike is an artifact of imperfect IQ mixers; it sits at exactly
 * the LO frequency you tune to. Offset tuning works around it by tuning
 * the dongle to (desired ± offset) and then digitally shifting the IQ
 * stream by ∓offset back to baseband. After the shift, the desired
 * signal lands at DC but the DC spike has moved to the offset frequency
 * — out of band as long as your demod bandwidth is narrower than the
 * offset.
 *
 * Implementation notes:
 *   - Operates on the same offset-binary u8 IQ format that the RTL-SDR
 *     and HackRF producers use, so the SAB ring layout is unchanged.
 *   - Uses a trig-recurrence NCO instead of `Math.cos`/`Math.sin` per
 *     sample: at 2.4 MS/s a naive per-sample sin/cos eats ~10 % of a
 *     core. The recurrence is 4 multiplies + 2 adds per sample.
 *   - Long-running phase drift is kept bounded by periodic resync to
 *     `Math.sin`/`Math.cos` every `RESYNC_SAMPLES` samples.
 */

const RESYNC_SAMPLES = 65_536;

export class NcoShifter {
  /** Step size in radians per sample. Negative when we want to shift the
   *  spectrum DOWN by `offsetHz`. */
  private dphi = 0;
  /** Cached cos/sin of the per-sample phase increment. */
  private cosDphi = 1;
  private sinDphi = 0;
  /** Running NCO state. */
  private cosPhi = 1;
  private sinPhi = 0;
  /** Sample counter since last trig resync. */
  private sinceResync = 0;
  /** Total cumulative phase (only used at resync time). */
  private phi = 0;

  /** Configure with the desired spectral shift in Hz at the given sample
   *  rate. Positive `offsetHz` means "shift the spectrum DOWN by offsetHz"
   *  (i.e., the dongle is tuned `offsetHz` ABOVE the desired signal and we
   *  bring it back). Reset internal state. */
  configure(offsetHz: number, sampleRateHz: number): void {
    this.dphi = (-2 * Math.PI * offsetHz) / sampleRateHz;
    this.cosDphi = Math.cos(this.dphi);
    this.sinDphi = Math.sin(this.dphi);
    this.phi = 0;
    this.cosPhi = 1;
    this.sinPhi = 0;
    this.sinceResync = 0;
  }

  /** In-place shift of an offset-binary u8 IQ buffer (interleaved
   *  I, Q, I, Q, …). No-op if offset is exactly zero. */
  shiftInPlace(buf: Uint8Array): void {
    if (this.dphi === 0) return;
    const n = buf.length >> 1;
    for (let i = 0; i < n; i++) {
      const re = (buf[2 * i] - 127.5) / 127.5;
      const im = (buf[2 * i + 1] - 127.5) / 127.5;
      // (re + j·im) · (cosφ + j·sinφ) = (re·cosφ − im·sinφ) + j·(re·sinφ + im·cosφ)
      const newRe = re * this.cosPhi - im * this.sinPhi;
      const newIm = re * this.sinPhi + im * this.cosPhi;
      // Clamp + scale back to u8 offset-binary.
      const ri = newRe * 127.5 + 127.5;
      const ii = newIm * 127.5 + 127.5;
      buf[2 * i] = ri < 0 ? 0 : ri > 255 ? 255 : ri | 0;
      buf[2 * i + 1] = ii < 0 ? 0 : ii > 255 ? 255 : ii | 0;
      // Advance NCO via trig recurrence (cheap).
      const nextCos = this.cosPhi * this.cosDphi - this.sinPhi * this.sinDphi;
      const nextSin = this.sinPhi * this.cosDphi + this.cosPhi * this.sinDphi;
      this.cosPhi = nextCos;
      this.sinPhi = nextSin;
      this.sinceResync++;
      if (this.sinceResync >= RESYNC_SAMPLES) {
        // Drift correction: re-evaluate cos/sin from total cumulative phase.
        this.phi = (this.phi + this.dphi * this.sinceResync) % (2 * Math.PI);
        this.cosPhi = Math.cos(this.phi);
        this.sinPhi = Math.sin(this.phi);
        this.sinceResync = 0;
      }
    }
  }
}
