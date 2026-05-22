//! Moshon SDR DSP core.
//!
//! Compiles to WebAssembly via `wasm-pack build --target web`. Consumed by
//! the DSP worker in `web/src/workers/dsp-worker.ts`.

#![forbid(unsafe_code)]
#![warn(clippy::pedantic)]
#![allow(clippy::cast_precision_loss)]

use std::f32::consts::PI;
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use wasm_bindgen::prelude::*;

// ──────────────────────────────────────────────────────────────────────────
// Smoke test (kept from B1)
// ──────────────────────────────────────────────────────────────────────────

#[wasm_bindgen]
#[must_use]
pub fn smoke() -> u32 {
    42
}

// ──────────────────────────────────────────────────────────────────────────
// FFT context (B4b)
// ──────────────────────────────────────────────────────────────────────────

/// One-shot FFT processor: takes a contiguous block of 8-bit unsigned IQ
/// samples (interleaved I, Q, I, Q, …), applies a window, runs an FFT, and
/// returns a vector of log-magnitudes in dBFS — fftshifted so DC is at the
/// centre.
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

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn size(&self) -> usize {
        self.size
    }

    /// Process exactly `size` IQ samples (= `size * 2` bytes).
    /// Returns a `Float32Array` of log-magnitudes in dBFS, fftshifted.
    /// Returns an empty array if `iq.len() < size * 2`.
    #[must_use]
    pub fn process(&mut self, iq: &[u8]) -> Vec<f32> {
        let needed = self.size * 2;
        if iq.len() < needed {
            return Vec::new();
        }

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

        let norm = self.window.iter().sum::<f32>().max(1.0);
        for i in 0..self.size {
            let m = self.buf[i].norm();
            let db = if m > 0.0 {
                20.0 * (m / norm).log10()
            } else {
                -120.0
            };
            self.out[i] = db.max(-120.0);
        }

        let half = self.size / 2;
        let mut shifted = vec![0.0f32; self.size];
        shifted[..half].copy_from_slice(&self.out[half..]);
        shifted[half..].copy_from_slice(&self.out[..half]);
        shifted
    }
}

// ──────────────────────────────────────────────────────────────────────────
// FIR utilities (B6)
// ──────────────────────────────────────────────────────────────────────────

/// Hann window, length `n`, in `[0, 1]`.
fn hann_window(n: usize) -> Vec<f32> {
    let nf = n as f32;
    (0..n)
        .map(|i| {
            let x = PI * (i as f32) / (nf - 1.0);
            x.sin().powi(2)
        })
        .collect()
}

/// Hamming window, length `n`, in `[0.08, 1]`. Better sidelobes than Hann for FIR.
fn hamming_window(n: usize) -> Vec<f32> {
    let nf = n as f32;
    (0..n)
        .map(|i| 0.54 - 0.46 * (2.0 * PI * (i as f32) / (nf - 1.0)).cos())
        .collect()
}

/// Generate a windowed-sinc low-pass FIR of length `n_taps` (odd preferred),
/// with cutoff `fc` normalised to the input sample rate (0 < fc < 0.5).
fn lowpass_taps(n_taps: usize, fc: f32) -> Vec<f32> {
    let window = hamming_window(n_taps);
    let mid = (n_taps as f32 - 1.0) / 2.0;
    let mut taps = vec![0.0f32; n_taps];
    let mut sum = 0.0f32;
    for i in 0..n_taps {
        let x = (i as f32) - mid;
        let sinc = if x.abs() < 1e-7 {
            2.0 * fc
        } else {
            ((2.0 * PI * fc * x).sin()) / (PI * x)
        };
        taps[i] = sinc * window[i];
        sum += taps[i];
    }
    if sum > 0.0 {
        for t in &mut taps {
            *t /= sum;
        }
    }
    taps
}

/// Real-valued FIR decimator: takes `factor` input samples per output sample.
struct RealDecimator {
    factor: usize,
    taps: Vec<f32>,
    history: Vec<f32>,
    hist_pos: usize,
    drop_count: usize,
}

impl RealDecimator {
    fn new(factor: usize, taps: Vec<f32>) -> Self {
        let history = vec![0.0f32; taps.len()];
        Self {
            factor,
            taps,
            history,
            hist_pos: 0,
            drop_count: 0,
        }
    }

    /// Process `input` samples and append decimated output to `out`.
    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let n = self.taps.len();
        for &x in input {
            self.history[self.hist_pos] = x;
            self.hist_pos = (self.hist_pos + 1) % n;

            self.drop_count += 1;
            if self.drop_count >= self.factor {
                self.drop_count = 0;
                // Convolution: oldest history first.
                let mut acc = 0.0f32;
                for k in 0..n {
                    let h_idx = (self.hist_pos + k) % n;
                    acc += self.history[h_idx] * self.taps[k];
                }
                out.push(acc);
            }
        }
    }
}

/// Complex-valued FIR decimator (separate I and Q sub-filters sharing taps).
struct ComplexDecimator {
    factor: usize,
    taps: Vec<f32>,
    history: Vec<Complex<f32>>,
    hist_pos: usize,
    drop_count: usize,
}

impl ComplexDecimator {
    fn new(factor: usize, taps: Vec<f32>) -> Self {
        let history = vec![Complex { re: 0.0, im: 0.0 }; taps.len()];
        Self {
            factor,
            taps,
            history,
            hist_pos: 0,
            drop_count: 0,
        }
    }

    fn process(&mut self, input: &[Complex<f32>], out: &mut Vec<Complex<f32>>) {
        let n = self.taps.len();
        for &x in input {
            self.history[self.hist_pos] = x;
            self.hist_pos = (self.hist_pos + 1) % n;

            self.drop_count += 1;
            if self.drop_count >= self.factor {
                self.drop_count = 0;
                let mut acc_re = 0.0f32;
                let mut acc_im = 0.0f32;
                for k in 0..n {
                    let h_idx = (self.hist_pos + k) % n;
                    let s = self.history[h_idx];
                    acc_re += s.re * self.taps[k];
                    acc_im += s.im * self.taps[k];
                }
                out.push(Complex {
                    re: acc_re,
                    im: acc_im,
                });
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// WFM demodulator (B6a)
// ──────────────────────────────────────────────────────────────────────────

/// Input sample rate the demodulator is configured for. Used by tests; may
/// be useful for future callers that need to know this without hardcoding.
#[allow(dead_code)]
const WFM_INPUT_RATE: f32 = 2_400_000.0;
/// Intermediate sample rate after the first decimation stage. 240 kS/s is
/// generous for a 200 kHz-wide WFM signal.
const WFM_IF_RATE: f32 = 240_000.0;
/// Audio output rate. Must match the `AudioContext`. Documented here so the
/// scale factor and filter cutoff stay in sync with it.
#[allow(dead_code)]
const AUDIO_RATE: f32 = 48_000.0;
/// First-stage decimation factor: 2.4 MS/s → 240 kS/s (= 10).
const WFM_IF_DECIM: usize = 10;
/// Second-stage decimation factor: 240 kS/s → 48 kS/s (= 5).
const WFM_AUDIO_DECIM: usize = 5;
/// Standard broadcast FM peak deviation.
const WFM_DEVIATION: f32 = 75_000.0;

/// Wideband-FM mono demodulator. Decimates 2.4 MS/s IQ to 240 kS/s,
/// runs an FM discriminator, then decimates to 48 kS/s audio with a
/// 15 kHz audio low-pass.
#[wasm_bindgen]
pub struct WfmDemod {
    iq_decim: ComplexDecimator,
    audio_decim: RealDecimator,
    last_z: Complex<f32>,
    /// Audio scale: makes a unit-deviation tone read ~±1 at the output.
    audio_scale: f32,

    // Scratch buffers (reused to avoid alloc each call).
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    discrim_out: Vec<f32>,
}

#[wasm_bindgen]
impl WfmDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> WfmDemod {
        // First stage: 31-tap LPF with cutoff at ~100 kHz / 2.4 MHz = 0.042.
        // Pass band covers the full WFM signal (±100 kHz around DC after mixing).
        let iq_taps = lowpass_taps(31, 0.042);
        // Second stage: 47-tap LPF with cutoff at 15 kHz / 240 kHz = 0.0625.
        // Pass band covers the broadcast-FM mono audio (50 Hz – 15 kHz).
        let audio_taps = lowpass_taps(47, 0.0625);

        let audio_scale = WFM_IF_RATE / (PI * WFM_DEVIATION);

        WfmDemod {
            iq_decim: ComplexDecimator::new(WFM_IF_DECIM, iq_taps),
            audio_decim: RealDecimator::new(WFM_AUDIO_DECIM, audio_taps),
            last_z: Complex { re: 1.0, im: 0.0 },
            audio_scale,
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / WFM_IF_DECIM + 16),
            discrim_out: Vec::with_capacity(65_536 / WFM_IF_DECIM + 16),
        }
    }

    /// Process a chunk of 8-bit unsigned IQ at 2.4 MS/s. Returns the audio
    /// samples produced for this chunk (variable length — `input_samples /
    /// (WFM_IF_DECIM * WFM_AUDIO_DECIM)`, modulo decimator phase).
    #[must_use]
    pub fn process(&mut self, iq_bytes: &[u8]) -> Vec<f32> {
        // 1) U8 IQ → Complex<f32>, offset-binary normalised.
        let n_samples = iq_bytes.len() / 2;
        self.iq_in.clear();
        self.iq_in.reserve(n_samples);
        for i in 0..n_samples {
            let re = (f32::from(iq_bytes[2 * i]) - 127.5) / 127.5;
            let im = (f32::from(iq_bytes[2 * i + 1]) - 127.5) / 127.5;
            self.iq_in.push(Complex { re, im });
        }

        // 2) Decimate IQ 10:1 → 240 kS/s.
        self.iq_if.clear();
        self.iq_decim.process(&self.iq_in, &mut self.iq_if);

        // 3) FM discriminator: phase difference between consecutive samples.
        //    arg(z[n] * conj(z[n-1])) = atan2(Im(z·z*'), Re(z·z*'))
        self.discrim_out.clear();
        self.discrim_out.reserve(self.iq_if.len());
        for &z in &self.iq_if {
            let prod = z * self.last_z.conj();
            let phase = prod.im.atan2(prod.re);
            self.discrim_out.push(phase * self.audio_scale);
            self.last_z = z;
        }

        // 4) Decimate audio 5:1 → 48 kS/s and return.
        let mut audio_out = Vec::with_capacity(self.discrim_out.len() / WFM_AUDIO_DECIM + 1);
        self.audio_decim.process(&self.discrim_out, &mut audio_out);
        audio_out
    }
}

impl Default for WfmDemod {
    fn default() -> Self {
        Self::new()
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
mod tests {
    use super::*;

    fn f32_to_u8(x: f32) -> u8 {
        x.round().clamp(0.0, 255.0) as u8
    }

    #[test]
    fn smoke_returns_known_value() {
        assert_eq!(smoke(), 42);
    }

    #[test]
    fn fft_recovers_tone_at_known_bin() {
        let size = 1024usize;
        let mut iq = vec![0u8; size * 2];
        for i in 0..size {
            let phase = 2.0 * PI * (i as f32) / 8.0;
            iq[2 * i] = f32_to_u8((phase.cos() * 100.0) + 127.5);
            iq[2 * i + 1] = f32_to_u8((phase.sin() * 100.0) + 127.5);
        }

        let mut ctx = FftContext::new(size);
        let bins = ctx.process(&iq);
        assert_eq!(bins.len(), size);

        let expected = size / 2 + size / 8;
        let (peak_idx, peak_val) =
            bins.iter()
                .enumerate()
                .fold((0usize, f32::NEG_INFINITY), |(bi, bv), (i, v)| {
                    if *v > bv {
                        (i, *v)
                    } else {
                        (bi, bv)
                    }
                });

        assert!(
            peak_idx.abs_diff(expected) <= 2,
            "expected peak near bin {expected}, got {peak_idx} (value {peak_val} dB)",
        );
    }

    #[test]
    fn fft_floor_doesnt_blow_up_on_zeros() {
        let size = 256;
        let iq = vec![127u8; size * 2];
        let mut ctx = FftContext::new(size);
        let bins = ctx.process(&iq);
        for b in bins {
            assert!(b.is_finite(), "found non-finite bin: {b}");
            assert!(b >= -121.0, "bin below floor: {b}");
        }
    }

    #[test]
    fn wfm_demod_recovers_modulated_tone() {
        // Synthesize a WFM signal: a complex carrier whose instantaneous
        // frequency is modulated by a 1 kHz sinusoid with ±50 kHz deviation.
        // After demod we should see roughly a 1 kHz tone in the audio output.
        let chunk_samples = 24_000usize; // 10 ms at 2.4 MS/s
        let mut iq = vec![0u8; chunk_samples * 2];
        let mut phase = 0.0f32;
        let dev = 50_000.0_f32; // ±50 kHz deviation
        let mod_freq = 1_000.0_f32; // 1 kHz audio tone
        let amp = 100.0_f32;
        for n in 0..chunk_samples {
            let t = n as f32 / WFM_INPUT_RATE;
            let inst_freq = dev * (2.0 * PI * mod_freq * t).cos();
            phase += 2.0 * PI * inst_freq / WFM_INPUT_RATE;
            iq[2 * n] = f32_to_u8(amp * phase.cos() + 127.5);
            iq[2 * n + 1] = f32_to_u8(amp * phase.sin() + 127.5);
        }

        let mut demod = WfmDemod::new();
        let audio = demod.process(&iq);

        // Expect roughly chunk_samples / (WFM_IF_DECIM * WFM_AUDIO_DECIM)
        // = 24_000 / 50 ≈ 480 samples (10 ms at 48 kHz).
        assert!(
            audio.len() >= 400 && audio.len() <= 520,
            "unexpected audio length: {}",
            audio.len()
        );

        // Output should have meaningful amplitude (not silence). With 50/75 of
        // full-scale deviation and proper scaling, peak should be on the
        // order of 0.5–1.0.
        let max = audio.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!(
            max > 0.1,
            "demod output looks like silence (max abs = {max})"
        );
        assert!(max < 2.0, "demod output overshoots (max abs = {max})");
    }
}
