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

/// Non-decimating complex FIR (real taps applied to I and Q). Single-sample
/// `filter(z) -> z` API for use inside a per-sample loop.
struct ComplexFir {
    taps: Vec<f32>,
    history: Vec<Complex<f32>>,
    hist_pos: usize,
}

impl ComplexFir {
    fn new(taps: Vec<f32>) -> Self {
        let history = vec![Complex { re: 0.0, im: 0.0 }; taps.len()];
        Self {
            taps,
            history,
            hist_pos: 0,
        }
    }

    fn filter(&mut self, x: Complex<f32>) -> Complex<f32> {
        let n = self.taps.len();
        self.history[self.hist_pos] = x;
        self.hist_pos = (self.hist_pos + 1) % n;
        let mut acc_re = 0.0f32;
        let mut acc_im = 0.0f32;
        for k in 0..n {
            let h_idx = (self.hist_pos + k) % n;
            let s = self.history[h_idx];
            acc_re += s.re * self.taps[k];
            acc_im += s.im * self.taps[k];
        }
        Complex {
            re: acc_re,
            im: acc_im,
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
// Narrowband-FM + AM demodulators (B6b)
// ──────────────────────────────────────────────────────────────────────────
//
// Both NFM and AM share the same two-stage channelizer: a 31-tap stage-1
// LPF decimates 2.4 MS/s → 240 kS/s (same anti-alias as WFM), then a
// 63-tap stage-2 LPF *with cutoff matched to the demod bandwidth* decimates
// 240 kS/s → 48 kS/s. After stage 2 the IQ is at audio rate and we apply
// either an FM discriminator (NFM) or an envelope detector + DC block (AM).

/// Stage-1 decimation factor for the narrow demods: 2.4 MS/s → 240 kS/s.
const NARROW_IF_DECIM: usize = 10;
/// Stage-1 sample rate after the wide anti-alias filter.
const NARROW_IF_RATE: f32 = 240_000.0;
/// Stage-2 decimation factor: 240 kS/s → 48 kS/s.
const NARROW_AUDIO_DECIM: usize = 5;
/// Default NFM peak deviation for the audio scaling. Typical ham 2 m / 70 cm.
const NFM_DEFAULT_DEVIATION: f32 = 5_000.0;
/// Single-pole DC-block coefficient for AM. ~24 Hz HPF at 48 kHz output.
const AM_DC_ALPHA: f32 = 0.995;
/// Clamp range for user-set channel bandwidth. Narrower than 1.5 kHz makes
/// the FIR ringing dominate; wider than ~40 % of `NARROW_IF_RATE` aliases.
const NARROW_BW_MIN: f32 = 1_500.0;
const NARROW_BW_MAX: f32 = NARROW_IF_RATE * 0.4;

fn build_stage1_iq_taps() -> Vec<f32> {
    // Same as WFM's first stage — wide enough that the channel filter does
    // the real selectivity job downstream.
    lowpass_taps(31, 0.042)
}

fn build_stage2_iq_taps(bandwidth_hz: f32) -> Vec<f32> {
    let bw = bandwidth_hz.clamp(NARROW_BW_MIN, NARROW_BW_MAX);
    let cutoff = (bw / 2.0) / NARROW_IF_RATE;
    lowpass_taps(63, cutoff)
}

fn u8_iq_to_complex(iq_bytes: &[u8], out: &mut Vec<Complex<f32>>) {
    let n = iq_bytes.len() / 2;
    out.clear();
    out.reserve(n);
    for i in 0..n {
        let re = (f32::from(iq_bytes[2 * i]) - 127.5) / 127.5;
        let im = (f32::from(iq_bytes[2 * i + 1]) - 127.5) / 127.5;
        out.push(Complex { re, im });
    }
}

/// Narrowband-FM demodulator. Default bandwidth 12.5 kHz (typical ham
/// voice channel). Decimates 2.4 MS/s → 240 kS/s → 48 kS/s, then runs an
/// FM discriminator on the 48 kS/s IQ stream.
#[wasm_bindgen]
pub struct NfmDemod {
    iq_decim: ComplexDecimator,
    chan_decim: ComplexDecimator,
    last_z: Complex<f32>,
    audio_scale: f32,
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    iq_chan: Vec<Complex<f32>>,
}

#[wasm_bindgen]
impl NfmDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(bandwidth_hz: f32) -> NfmDemod {
        let stage1 = build_stage1_iq_taps();
        let stage2 = build_stage2_iq_taps(bandwidth_hz);
        // Scale: with peak deviation `f_dev` and output sample rate `f_s`, peak
        // phase change per sample is `2π·f_dev/f_s`. Choosing scale = f_s /
        // (π·f_dev) gives a peak output of ~2.0 at full deviation, matching
        // the WFM convention.
        let audio_scale = AUDIO_RATE / (PI * NFM_DEFAULT_DEVIATION);
        NfmDemod {
            iq_decim: ComplexDecimator::new(NARROW_IF_DECIM, stage1),
            chan_decim: ComplexDecimator::new(NARROW_AUDIO_DECIM, stage2),
            last_z: Complex { re: 1.0, im: 0.0 },
            audio_scale,
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / NARROW_IF_DECIM + 16),
            iq_chan: Vec::with_capacity(65_536 / (NARROW_IF_DECIM * NARROW_AUDIO_DECIM) + 16),
        }
    }

    #[must_use]
    pub fn process(&mut self, iq_bytes: &[u8]) -> Vec<f32> {
        u8_iq_to_complex(iq_bytes, &mut self.iq_in);

        self.iq_if.clear();
        self.iq_decim.process(&self.iq_in, &mut self.iq_if);

        self.iq_chan.clear();
        self.chan_decim.process(&self.iq_if, &mut self.iq_chan);

        let mut audio = Vec::with_capacity(self.iq_chan.len());
        for &z in &self.iq_chan {
            let prod = z * self.last_z.conj();
            let phase = prod.im.atan2(prod.re);
            audio.push(phase * self.audio_scale);
            self.last_z = z;
        }
        audio
    }
}

impl Default for NfmDemod {
    fn default() -> Self {
        Self::new(12_500.0)
    }
}

/// AM envelope-detector demodulator. Default bandwidth 9 kHz (broadcast AM).
/// Decimates 2.4 MS/s → 240 kS/s → 48 kS/s with a channel filter, then
/// envelope-detects (|z|) and removes the carrier DC with a single-pole
/// IIR high-pass.
#[wasm_bindgen]
pub struct AmDemod {
    iq_decim: ComplexDecimator,
    chan_decim: ComplexDecimator,
    /// DC-block state. y[n] = x[n] − x[n−1] + α·y[n−1].
    dc_x_prev: f32,
    dc_y_prev: f32,
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    iq_chan: Vec<Complex<f32>>,
}

#[wasm_bindgen]
impl AmDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(bandwidth_hz: f32) -> AmDemod {
        let stage1 = build_stage1_iq_taps();
        let stage2 = build_stage2_iq_taps(bandwidth_hz);
        AmDemod {
            iq_decim: ComplexDecimator::new(NARROW_IF_DECIM, stage1),
            chan_decim: ComplexDecimator::new(NARROW_AUDIO_DECIM, stage2),
            dc_x_prev: 0.0,
            dc_y_prev: 0.0,
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / NARROW_IF_DECIM + 16),
            iq_chan: Vec::with_capacity(65_536 / (NARROW_IF_DECIM * NARROW_AUDIO_DECIM) + 16),
        }
    }

    #[must_use]
    pub fn process(&mut self, iq_bytes: &[u8]) -> Vec<f32> {
        u8_iq_to_complex(iq_bytes, &mut self.iq_in);

        self.iq_if.clear();
        self.iq_decim.process(&self.iq_in, &mut self.iq_if);

        self.iq_chan.clear();
        self.chan_decim.process(&self.iq_if, &mut self.iq_chan);

        let mut audio = Vec::with_capacity(self.iq_chan.len());
        for &z in &self.iq_chan {
            let env = (z.re * z.re + z.im * z.im).sqrt();
            // Single-pole DC-block strips the carrier component.
            let y = env - self.dc_x_prev + AM_DC_ALPHA * self.dc_y_prev;
            self.dc_x_prev = env;
            self.dc_y_prev = y;
            audio.push(y);
        }
        audio
    }
}

impl Default for AmDemod {
    fn default() -> Self {
        Self::new(9_000.0)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// SSB demodulator — Weaver method (B6c)
// ──────────────────────────────────────────────────────────────────────────
//
// Receiver flow:
//   2.4 MS/s IQ
//     → stage-1 wide LPF (≈100 kHz) → 240 kS/s
//     → stage-2 channel LPF, cutoff = bandwidth_hz → 48 kS/s
//     → Weaver: shift desired sideband to DC, real LPF at bw/2 to kill the
//       image, shift back, take Re{} as audio.
//
// Sign convention: with the user tuned to the suppressed carrier, USB
// occupies +0..+bandwidth in baseband IQ, LSB occupies −bandwidth..0.
// For USB the Weaver NCO shifts DOWN by bandwidth/2 (then back UP);
// for LSB it shifts UP (then back DOWN). A single sideband-sign multiplier
// captures both.

/// Minimum SSB passband. Anything narrower than 500 Hz gives filter ringing
/// that dwarfs the desired signal.
const SSB_BW_MIN: f32 = 500.0;
/// Default SSB passband. Standard amateur voice bandwidth.
const SSB_DEFAULT_BW: f32 = 2_400.0;

/// Weaver-method single-sideband demodulator.
#[wasm_bindgen]
pub struct SsbDemod {
    iq_decim: ComplexDecimator,
    chan_decim: ComplexDecimator,
    /// Weaver mixer phase accumulator (radians).
    nco_phase: f32,
    /// Phase increment per 48 kHz output sample = 2π·(bw/2)/48000.
    nco_step: f32,
    /// +1.0 = USB (shift DOWN, back UP). −1.0 = LSB (shift UP, back DOWN).
    sideband_sign: f32,
    /// Half-bandwidth LPF applied to the shifted IQ; kills the image sideband.
    weaver_lpf: ComplexFir,
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    iq_chan: Vec<Complex<f32>>,
}

#[wasm_bindgen]
impl SsbDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(bandwidth_hz: f32, lsb: bool) -> SsbDemod {
        let bw = bandwidth_hz.clamp(SSB_BW_MIN, NARROW_BW_MAX);
        let stage1 = build_stage1_iq_taps();
        // Stage 2 cutoff = full audio width (not half) — we want both sidebands
        // at this point; the Weaver LPF downstream picks one.
        let stage2 = lowpass_taps(63, bw / NARROW_IF_RATE);
        // Weaver LPF cutoff = bw/2 at the 48 kHz audio rate.
        let weaver_taps = lowpass_taps(47, (bw / 2.0) / AUDIO_RATE);
        let nco_step = 2.0 * PI * (bw / 2.0) / AUDIO_RATE;
        let sideband_sign = if lsb { -1.0 } else { 1.0 };
        SsbDemod {
            iq_decim: ComplexDecimator::new(NARROW_IF_DECIM, stage1),
            chan_decim: ComplexDecimator::new(NARROW_AUDIO_DECIM, stage2),
            nco_phase: 0.0,
            nco_step,
            sideband_sign,
            weaver_lpf: ComplexFir::new(weaver_taps),
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / NARROW_IF_DECIM + 16),
            iq_chan: Vec::with_capacity(65_536 / (NARROW_IF_DECIM * NARROW_AUDIO_DECIM) + 16),
        }
    }

    #[must_use]
    pub fn process(&mut self, iq_bytes: &[u8]) -> Vec<f32> {
        u8_iq_to_complex(iq_bytes, &mut self.iq_in);

        self.iq_if.clear();
        self.iq_decim.process(&self.iq_in, &mut self.iq_if);

        self.iq_chan.clear();
        self.chan_decim.process(&self.iq_if, &mut self.iq_chan);

        let mut audio = Vec::with_capacity(self.iq_chan.len());
        let s = self.sideband_sign;
        for &z in &self.iq_chan {
            let (sin_p, cos_p) = self.nco_phase.sin_cos();
            // Shift by ∓bw/2: multiply by e^(∓j·φ).
            let nco_down = Complex {
                re: cos_p,
                im: -s * sin_p,
            };
            let z_shifted = z * nco_down;
            // Kill the image sideband.
            let z_filt = self.weaver_lpf.filter(z_shifted);
            // Shift back: multiply by e^(±j·φ). Take Re{} for audio.
            let nco_back = Complex {
                re: cos_p,
                im: s * sin_p,
            };
            audio.push((z_filt * nco_back).re);

            self.nco_phase += self.nco_step;
            if self.nco_phase >= 2.0 * PI {
                self.nco_phase -= 2.0 * PI;
            }
        }
        audio
    }
}

impl Default for SsbDemod {
    fn default() -> Self {
        Self::new(SSB_DEFAULT_BW, false)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// CW demodulator (B6d)
// ──────────────────────────────────────────────────────────────────────────
//
// CW is essentially a narrow filter plus a fixed BFO offset: the user tunes
// the dial so the keyed carrier zero-beats against the BFO frequency, which
// produces an audible tone whenever the carrier is keyed on. We channelize
// 2.4 MS/s → 240 kS/s → 48 kS/s with a narrow channel filter and then mix
// the resulting complex baseband up by the BFO offset, taking Re{} for
// audio.

/// Default BFO offset (Hz). Comfortable mid-range pitch for most listeners.
const CW_BFO_HZ: f32 = 700.0;
/// Minimum bandwidth for the CW channel filter. Anything below 80 Hz mostly
/// rings.
const CW_BW_MIN: f32 = 80.0;
/// Default CW bandwidth — fairly narrow but wide enough that high-speed
/// morse keying doesn't get smeared by filter group delay.
const CW_DEFAULT_BW: f32 = 500.0;

#[wasm_bindgen]
pub struct CwDemod {
    iq_decim: ComplexDecimator,
    chan_decim: ComplexDecimator,
    bfo_phase: f32,
    bfo_step: f32,
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    iq_chan: Vec<Complex<f32>>,
}

#[wasm_bindgen]
impl CwDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(bandwidth_hz: f32) -> CwDemod {
        let bw = bandwidth_hz.clamp(CW_BW_MIN, NARROW_BW_MAX);
        let stage1 = build_stage1_iq_taps();
        // Narrow CW filtering wants a long FIR — 127 taps at a low cutoff
        // gives a usable rolloff without becoming the dominant cost.
        let stage2 = lowpass_taps(127, (bw / 2.0) / NARROW_IF_RATE);
        let bfo_step = 2.0 * PI * CW_BFO_HZ / AUDIO_RATE;
        CwDemod {
            iq_decim: ComplexDecimator::new(NARROW_IF_DECIM, stage1),
            chan_decim: ComplexDecimator::new(NARROW_AUDIO_DECIM, stage2),
            bfo_phase: 0.0,
            bfo_step,
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / NARROW_IF_DECIM + 16),
            iq_chan: Vec::with_capacity(65_536 / (NARROW_IF_DECIM * NARROW_AUDIO_DECIM) + 16),
        }
    }

    #[must_use]
    pub fn process(&mut self, iq_bytes: &[u8]) -> Vec<f32> {
        u8_iq_to_complex(iq_bytes, &mut self.iq_in);

        self.iq_if.clear();
        self.iq_decim.process(&self.iq_in, &mut self.iq_if);

        self.iq_chan.clear();
        self.chan_decim.process(&self.iq_if, &mut self.iq_chan);

        let mut audio = Vec::with_capacity(self.iq_chan.len());
        for &z in &self.iq_chan {
            let (sin_p, cos_p) = self.bfo_phase.sin_cos();
            // Re{z · e^(+j·ω_bfo·t)} = z.re·cos − z.im·sin.
            audio.push(z.re * cos_p - z.im * sin_p);
            self.bfo_phase += self.bfo_step;
            if self.bfo_phase >= 2.0 * PI {
                self.bfo_phase -= 2.0 * PI;
            }
        }
        audio
    }
}

impl Default for CwDemod {
    fn default() -> Self {
        Self::new(CW_DEFAULT_BW)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::similar_names
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

    /// Synthesize a narrowband-FM signal at baseband (DC-centred) with
    /// ±3 kHz deviation modulated by a 1 kHz audio tone. After NFM demod
    /// the output should have meaningful amplitude (not silence) and
    /// stay below 2.0 (matches the WFM-style scaling).
    #[test]
    fn nfm_demod_recovers_modulated_tone() {
        let chunk_samples = 48_000usize; // 20 ms at 2.4 MS/s
        let mut iq = vec![0u8; chunk_samples * 2];
        let mut phase = 0.0f32;
        let dev = 3_000.0_f32;
        let mod_freq = 1_000.0_f32;
        let amp = 100.0_f32;
        for n in 0..chunk_samples {
            let t = n as f32 / WFM_INPUT_RATE;
            let inst_freq = dev * (2.0 * PI * mod_freq * t).cos();
            phase += 2.0 * PI * inst_freq / WFM_INPUT_RATE;
            iq[2 * n] = f32_to_u8(amp * phase.cos() + 127.5);
            iq[2 * n + 1] = f32_to_u8(amp * phase.sin() + 127.5);
        }

        let mut demod = NfmDemod::new(12_500.0);
        // First pass warms the channel filter + discriminator state. During
        // the filter transient atan2 output can swing the full ±π and we
        // want a settled signal before checking peak amplitude.
        let _ = demod.process(&iq);
        let audio = demod.process(&iq);

        // 48_000 / (10 * 5) = 960 samples (20 ms at 48 kHz).
        assert!(
            audio.len() >= 900 && audio.len() <= 1000,
            "unexpected audio length: {}",
            audio.len()
        );

        let max = audio.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!(
            max > 0.1,
            "NFM demod output looks like silence (max = {max})"
        );
        assert!(max < 2.0, "NFM demod overshoots (max = {max})");
    }

    /// Synthesize an AM signal: unmodulated carrier at DC plus a sinusoidal
    /// amplitude envelope. After AM demod the DC component should be
    /// removed and a 1 kHz tone should be present.
    #[test]
    fn am_demod_recovers_envelope_tone() {
        let chunk_samples = 48_000usize;
        let mut iq = vec![0u8; chunk_samples * 2];
        let mod_freq = 1_000.0_f32;
        let depth = 0.7_f32;
        let carrier_amp = 100.0_f32;
        for n in 0..chunk_samples {
            let t = n as f32 / WFM_INPUT_RATE;
            // AM signal at DC: complex carrier with amplitude modulated.
            let env = 1.0 + depth * (2.0 * PI * mod_freq * t).sin();
            // Keep the carrier static (zero IF) — no phase rotation needed.
            iq[2 * n] = f32_to_u8(carrier_amp * env + 127.5);
            iq[2 * n + 1] = f32_to_u8(127.5);
        }

        let mut demod = AmDemod::new(9_000.0);
        // Warm the DC block + filter history with a first pass; the first
        // few hundred samples carry the carrier step.
        let _ = demod.process(&iq);
        let audio = demod.process(&iq);

        assert!(
            audio.len() >= 900 && audio.len() <= 1000,
            "unexpected audio length: {}",
            audio.len()
        );

        let max = audio.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!(
            max > 0.05,
            "AM demod output looks like silence (max = {max})"
        );
        assert!(max < 2.0, "AM demod overshoots (max = {max})");

        // After DC-block the mean should be near zero.
        let mean: f32 = audio.iter().copied().sum::<f32>() / audio.len() as f32;
        assert!(
            mean.abs() < 0.05,
            "AM output not DC-blocked (mean = {mean})"
        );
    }

    /// Synthesize a pure complex tone at +1 kHz (USB side). The USB demod
    /// should recover an audible 1 kHz tone; the LSB demod, fed the same
    /// signal, should be at least 6 dB down (= half-amplitude) because the
    /// +1 kHz tone is outside the LSB passband.
    #[test]
    fn ssb_demod_separates_sidebands() {
        let chunk_samples = 96_000usize; // 40 ms — long enough for two warm-up passes plus measurement
        let mut iq = vec![0u8; chunk_samples * 2];
        let tone_freq = 1_000.0_f32;
        let amp = 100.0_f32;
        for n in 0..chunk_samples {
            let t = n as f32 / WFM_INPUT_RATE;
            let phase = 2.0 * PI * tone_freq * t;
            iq[2 * n] = f32_to_u8(amp * phase.cos() + 127.5);
            iq[2 * n + 1] = f32_to_u8(amp * phase.sin() + 127.5);
        }

        let mut usb = SsbDemod::new(2_400.0, false);
        let _ = usb.process(&iq);
        let audio_usb = usb.process(&iq);

        let mut lsb = SsbDemod::new(2_400.0, true);
        let _ = lsb.process(&iq);
        let audio_lsb = lsb.process(&iq);

        // 96_000 / 50 = 1920 audio samples.
        assert!(
            audio_usb.len() >= 1850 && audio_usb.len() <= 1950,
            "unexpected USB audio length: {}",
            audio_usb.len()
        );

        let max_usb = audio_usb.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        let max_lsb = audio_lsb.iter().fold(0.0f32, |a, &b| a.max(b.abs()));

        assert!(
            max_usb > 0.1,
            "USB demod silent on USB tone (max = {max_usb})"
        );
        assert!(max_usb < 2.0, "USB demod overshoots (max = {max_usb})");
        // Sideband suppression: the +1 kHz tone in the USB band must produce
        // a much smaller signal on the LSB demod than on the USB demod.
        assert!(
            max_lsb < 0.5 * max_usb,
            "LSB suppression failed: USB max = {max_usb}, LSB max = {max_lsb}",
        );
    }

    /// Synthesize a zero-beat carrier (constant complex value in baseband
    /// IQ). The CW demod should produce a tone at the BFO offset (~700 Hz).
    /// We verify by counting zero-crossings and comparing to the expected
    /// rate for a 700 Hz sinusoid sampled at 48 kHz.
    #[test]
    fn cw_demod_makes_zero_beat_audible() {
        let chunk_samples = 96_000usize;
        let mut iq = vec![0u8; chunk_samples * 2];
        // Constant carrier at DC: I = max amplitude, Q = 0.
        let amp = 100.0_f32;
        for n in 0..chunk_samples {
            iq[2 * n] = f32_to_u8(amp + 127.5);
            iq[2 * n + 1] = f32_to_u8(127.5);
        }

        let mut demod = CwDemod::new(500.0);
        let _ = demod.process(&iq); // warm-up
        let audio = demod.process(&iq);

        let max = audio.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!(
            max > 0.1,
            "CW demod silent on zero-beat carrier (max = {max})"
        );
        assert!(max < 2.0, "CW demod overshoots (max = {max})");

        // Count zero crossings. For a 700 Hz sinusoid sampled at 48 kHz
        // over `audio.len()` samples we expect approximately
        // 2 * 700 * audio.len() / 48000 crossings.
        let audio_rate = 48_000.0_f32;
        let bfo = 700.0_f32;
        let expected_crossings = 2.0 * bfo * (audio.len() as f32) / audio_rate;

        let mut crossings = 0usize;
        for w in audio.windows(2) {
            if (w[0] >= 0.0) != (w[1] >= 0.0) {
                crossings += 1;
            }
        }
        let crossings_f = crossings as f32;
        // Allow ±20 % tolerance — DC bias, transients, and filter group
        // delay can perturb the count.
        assert!(
            crossings_f > 0.8 * expected_crossings && crossings_f < 1.2 * expected_crossings,
            "CW BFO frequency off: expected ~{expected_crossings} crossings, got {crossings}",
        );
    }
}
