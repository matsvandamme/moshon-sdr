//! Moshon SDR DSP core.
//!
//! Compiles to WebAssembly via `wasm-pack build --target web`. Consumed by
//! the DSP worker in `web/src/workers/dsp-worker.ts`.

#![forbid(unsafe_code)]
#![warn(clippy::pedantic)]
#![allow(clippy::cast_precision_loss)]

use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use wasm_bindgen::prelude::*;

/// Smoke-test export. Kept from B1 so older callers don't break.
#[wasm_bindgen]
#[must_use]
pub fn smoke() -> u32 {
    42
}

/// One-shot FFT processor: takes a contiguous block of 8-bit unsigned IQ
/// samples (interleaved I, Q, I, Q, …), applies a window, runs an FFT, and
/// returns a vector of log-magnitudes in dBFS — fftshifted so DC is at the
/// centre.
///
/// Owns its plan, scratch buffer, and window so successive calls don't allocate.
#[wasm_bindgen]
pub struct FftContext {
    size: usize,
    fft: Arc<dyn Fft<f32>>,
    buf: Vec<Complex<f32>>,
    window: Vec<f32>,
    out: Vec<f32>,
}

#[wasm_bindgen]
impl FftContext {
    /// `size` must be a power of two between 64 and 16384.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(size: usize) -> FftContext {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(size);
        let window = hann_window(size);
        FftContext {
            size,
            fft,
            buf: vec![Complex { re: 0.0, im: 0.0 }; size],
            window,
            out: vec![0.0; size],
        }
    }

    /// FFT bin count == constructor `size`.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn size(&self) -> usize {
        self.size
    }

    /// Process exactly `size` IQ samples (= `size * 2` bytes).
    ///
    /// Layout of `iq`: `[i0, q0, i1, q1, …]`, 8-bit unsigned, where 128 = 0.
    /// Returns a `Float32Array` of log-magnitudes in dBFS (one per bin),
    /// fftshifted so DC is in the middle.
    ///
    /// Returns an empty array if `iq.len() < size * 2`.
    #[must_use]
    pub fn process(&mut self, iq: &[u8]) -> Vec<f32> {
        let needed = self.size * 2;
        if iq.len() < needed {
            return Vec::new();
        }

        // Convert U8 IQ pairs to Complex<f32>, apply window.
        // Offset binary -> centred float: (byte - 127.5) / 127.5
        for i in 0..self.size {
            let i_re = (f32::from(iq[2 * i]) - 127.5) / 127.5;
            let i_im = (f32::from(iq[2 * i + 1]) - 127.5) / 127.5;
            let w = self.window[i];
            self.buf[i] = Complex {
                re: i_re * w,
                im: i_im * w,
            };
        }

        self.fft.process(&mut self.buf);

        // Magnitude → dBFS. Normalise by FFT size + window sum so a unit
        // sinusoid reads ~0 dBFS.
        let norm = self.window.iter().sum::<f32>().max(1.0);
        for i in 0..self.size {
            let m = self.buf[i].norm();
            // 20*log10(m / norm). Clamp the floor at -120 dB so log doesn't blow up.
            let db = if m > 0.0 {
                20.0 * (m / norm).log10()
            } else {
                -120.0
            };
            self.out[i] = db.max(-120.0);
        }

        // fftshift: swap halves so bin 0 (DC) lands in the middle.
        let half = self.size / 2;
        let mut shifted = vec![0.0f32; self.size];
        shifted[..half].copy_from_slice(&self.out[half..]);
        shifted[half..].copy_from_slice(&self.out[..half]);
        shifted
    }
}

/// Hann window. Length-`size` array of weights in `[0, 1]`.
fn hann_window(size: usize) -> Vec<f32> {
    let n = size as f32;
    (0..size)
        .map(|i| {
            let x = std::f32::consts::PI * (i as f32) / (n - 1.0);
            x.sin().powi(2)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn smoke_returns_known_value() {
        assert_eq!(smoke(), 42);
    }

    #[test]
    fn fft_recovers_tone_at_known_bin() {
        // Generate a 1/8-sample-rate complex tone (so bin = size/8 from DC).
        let size = 1024;
        let mut iq = vec![0u8; size * 2];
        for i in 0..size {
            let phase = 2.0 * PI * (i as f32) / 8.0;
            iq[2 * i] = ((phase.cos() * 100.0) + 127.5) as u8;
            iq[2 * i + 1] = ((phase.sin() * 100.0) + 127.5) as u8;
        }

        let mut ctx = FftContext::new(size);
        let bins = ctx.process(&iq);
        assert_eq!(bins.len(), size);

        // Peak should be at the bin corresponding to +1/8 sample rate offset
        // from DC. After fftshift, DC is at size/2; +1/8 is at size/2 + size/8.
        let expected = size / 2 + size / 8;
        let (peak_idx, peak_val) =
            bins.iter()
                .enumerate()
                .fold((0, f32::NEG_INFINITY), |(bi, bv), (i, v)| {
                    if *v > bv {
                        (i, *v)
                    } else {
                        (bi, bv)
                    }
                });

        // Window leakage may shift the peak by 1 bin; allow ±2 bins.
        assert!(
            (peak_idx as isize - expected as isize).abs() <= 2,
            "expected peak near bin {expected}, got {peak_idx} (value {peak_val} dB)",
        );
    }

    #[test]
    fn fft_floor_doesnt_blow_up_on_zeros() {
        let size = 256;
        let iq = vec![127u8; size * 2]; // 127 ≈ 0 after offset binary normalization
        let mut ctx = FftContext::new(size);
        let bins = ctx.process(&iq);
        assert_eq!(bins.len(), size);
        for b in bins {
            assert!(b.is_finite(), "found non-finite bin: {b}");
            assert!(b >= -121.0, "bin below floor: {b}");
        }
    }
}
