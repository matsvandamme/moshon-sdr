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

/// Direct-form-I biquad. Used in stereo WFM for the narrow pilot and 38 kHz
/// reference BPFs — much cheaper than a long FIR at the equivalent Q.
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    /// RBJ-cookbook bandpass (constant skirt gain). `f_center_hz` and
    /// `sample_rate_hz` in the obvious units; `q` is the quality factor
    /// (higher = narrower).
    fn bandpass(f_center_hz: f32, sample_rate_hz: f32, q: f32) -> Self {
        let w0 = 2.0 * PI * f_center_hz / sample_rate_hz;
        let alpha = w0.sin() / (2.0 * q);
        let cos_w0 = w0.cos();
        let a0 = 1.0 + alpha;
        Self {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: -2.0 * cos_w0 / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
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
// WFM demodulator (B6a mono · M2.0 stereo)
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
/// Stereo pilot tone frequency.
const WFM_PILOT_HZ: f32 = 19_000.0;
/// Stereo L-R DSB-SC suppressed carrier (= 2 × pilot).
const WFM_LR_CARRIER_HZ: f32 = 38_000.0;
/// Pilot detection threshold on the smoothed |pilot| envelope. Empirical
/// — typical pilots run ~5-15 % of full MPX amplitude.
const WFM_PILOT_THRESHOLD: f32 = 0.02;
/// Smoothing for the pilot envelope. Lower = faster lock / faster drop.
const WFM_PILOT_ENV_ALPHA: f32 = 0.001;
/// Audio de-emphasis time constant. 50 µs in ITU Region 1 (Europe), 75 µs
/// in North America. We target R1 by default — see the open question in
/// MEMORY.md about exposing this as a user knob.
const WFM_DEEMPH_TAU_S: f32 = 50e-6;

/// Wideband-FM demodulator with optional stereo MPX decode.
///
/// Chain:
///   1. 2.4 MS/s IQ → 240 kS/s IF via 10:1 windowed-sinc decimation.
///   2. FM discriminator → real-valued MPX at 240 kS/s.
///   3a. MPX → audio LPF + 5:1 decimation → 48 kS/s L+R sum.
///   3b. If stereo detected: pilot biquad-BPF → square → biquad-BPF at 38 kHz
///       → multiply MPX by this coherent reference → audio LPF + 5:1
///       decimation → 48 kS/s L-R difference.
///   4. L = sum + diff, R = sum - diff. 50 µs de-emphasis per channel.
///   5. Output interleaved L,R `Float32Array` at 48 kS/s.
///
/// When the pilot is absent or stereo is disabled, the output is still
/// interleaved with L = R = mono so the caller doesn't need to switch ring
/// layouts mid-stream.
#[wasm_bindgen]
pub struct WfmDemod {
    iq_decim: ComplexDecimator,
    sum_decim: RealDecimator,
    diff_decim: RealDecimator,
    last_z: Complex<f32>,
    audio_scale: f32,

    // Stereo path
    stereo_enabled: bool,
    pilot_bpf: Biquad,
    bpf38: Biquad,
    pilot_env: f32,
    deemph_alpha: f32,
    deemph_l: f32,
    deemph_r: f32,
    /// True when the smoothed pilot envelope is above threshold.
    stereo_locked: bool,

    // Scratch buffers (reused to avoid alloc each call).
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    mpx: Vec<f32>,
    diff_mix: Vec<f32>,
    sum_audio: Vec<f32>,
    diff_audio: Vec<f32>,
    output: Vec<f32>,
}

#[wasm_bindgen]
impl WfmDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> WfmDemod {
        // First stage: 31-tap LPF with cutoff at ~100 kHz / 2.4 MHz = 0.042.
        // Pass band covers the full WFM signal (±100 kHz around DC after mixing).
        let iq_taps = lowpass_taps(31, 0.042);
        // Audio stage: 47-tap LPF with cutoff at 15 kHz / 240 kHz = 0.0625.
        // Pass band covers the broadcast-FM mono audio (50 Hz – 15 kHz). We
        // build TWO independent decimators so the sum (L+R) and difference
        // (L-R) paths can have separate filter history.
        let audio_taps_sum = lowpass_taps(47, 0.0625);
        let audio_taps_diff = lowpass_taps(47, 0.0625);

        let audio_scale = WFM_IF_RATE / (PI * WFM_DEVIATION);

        // De-emphasis: y[n] = (1-α)·x[n] + α·y[n-1], with α = exp(-1/(τ·fs)).
        let deemph_alpha = (-1.0 / (WFM_DEEMPH_TAU_S * AUDIO_RATE)).exp();

        WfmDemod {
            iq_decim: ComplexDecimator::new(WFM_IF_DECIM, iq_taps),
            sum_decim: RealDecimator::new(WFM_AUDIO_DECIM, audio_taps_sum),
            diff_decim: RealDecimator::new(WFM_AUDIO_DECIM, audio_taps_diff),
            last_z: Complex { re: 1.0, im: 0.0 },
            audio_scale,

            stereo_enabled: true,
            pilot_bpf: Biquad::bandpass(WFM_PILOT_HZ, WFM_IF_RATE, 50.0),
            bpf38: Biquad::bandpass(WFM_LR_CARRIER_HZ, WFM_IF_RATE, 25.0),
            pilot_env: 0.0,
            deemph_alpha,
            deemph_l: 0.0,
            deemph_r: 0.0,
            stereo_locked: false,

            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / WFM_IF_DECIM + 16),
            mpx: Vec::with_capacity(65_536 / WFM_IF_DECIM + 16),
            diff_mix: Vec::with_capacity(65_536 / WFM_IF_DECIM + 16),
            sum_audio: Vec::with_capacity(65_536 / (WFM_IF_DECIM * WFM_AUDIO_DECIM) + 16),
            diff_audio: Vec::with_capacity(65_536 / (WFM_IF_DECIM * WFM_AUDIO_DECIM) + 16),
            output: Vec::with_capacity(2 * (65_536 / (WFM_IF_DECIM * WFM_AUDIO_DECIM) + 16)),
        }
    }

    /// Whether to attempt stereo decode when the 19 kHz pilot is present.
    /// When disabled, output is L=R=mono regardless of the pilot.
    pub fn set_stereo_enabled(&mut self, enabled: bool) {
        self.stereo_enabled = enabled;
        if !enabled {
            self.stereo_locked = false;
        }
    }

    /// True when the smoothed pilot envelope exceeds the threshold AND
    /// stereo decoding is enabled. Updated each `process()` call.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn is_stereo_locked(&self) -> bool {
        self.stereo_locked
    }

    /// Process a chunk of 8-bit unsigned IQ at 2.4 MS/s. Returns interleaved
    /// stereo audio (L, R, L, R, …) at 48 kS/s.
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

        // 3) FM discriminator → MPX. Per-sample we also drive the pilot
        // biquad and the squared-pilot biquad so the 38 kHz reference
        // available on the diff path is in lock with the carrier.
        self.mpx.clear();
        self.mpx.reserve(self.iq_if.len());
        self.diff_mix.clear();
        self.diff_mix.reserve(self.iq_if.len());

        for &z in &self.iq_if {
            let prod = z * self.last_z.conj();
            let phase = prod.im.atan2(prod.re);
            let m = phase * self.audio_scale;
            self.last_z = z;

            // Pilot biquad → squared → 38 kHz BPF gives a coherent local
            // oscillator at the suppressed-carrier frequency. Phase tracks
            // automatically since squaring a clean tone gives 2× freq at 2θ.
            let pilot = self.pilot_bpf.process(m);
            let ref38 = self.bpf38.process(pilot * pilot);

            // Smoothed pilot envelope for the stereo-lock decision.
            self.pilot_env =
                (1.0 - WFM_PILOT_ENV_ALPHA) * self.pilot_env + WFM_PILOT_ENV_ALPHA * pilot.abs();

            self.mpx.push(m);
            // Coherent demod of L-R: multiply MPX by 38 kHz reference, then
            // let the audio LPF below reject everything but the baseband.
            // The squared-pilot reference has amplitude ∝ (pilot envelope)²,
            // so we dynamically renormalize: target sum / diff gain equality
            // independent of pilot strength. Derivation: pilot p(t)=A·sin(ωt)
            // → p²(t) = A²/2·(1-cos(2ωt)); bpf38 → A²/2·cos(2ωt). |p| mean = 2A/π
            // (smoothed pilot_env). So 1/ref38_amp = 2/A² = 8/(π·pilot_env)².
            let env2 = self.pilot_env * self.pilot_env;
            let norm = if env2 > 1e-6 {
                8.0 / (PI * PI * env2)
            } else {
                0.0
            };
            self.diff_mix.push(m * ref38 * norm);
        }

        // 4) Audio-rate filtering + decimation. Sum path uses raw MPX; diff
        // path uses the mixed signal. Both share the same audio LPF shape
        // but keep independent histories.
        self.sum_audio.clear();
        self.sum_decim.process(&self.mpx, &mut self.sum_audio);

        self.diff_audio.clear();
        self.diff_decim
            .process(&self.diff_mix, &mut self.diff_audio);

        // 5) Decide stereo lock based on the smoothed pilot envelope. The
        // hysteresis is built in by the slow envelope (~1 ms time constant)
        // — flip-flopping between mono/stereo is rare in practice.
        self.stereo_locked = self.stereo_enabled && self.pilot_env > WFM_PILOT_THRESHOLD;

        // 6) Build interleaved stereo output. L = sum + diff, R = sum - diff.
        // When stereo is not locked (no pilot or user disabled it), output
        // L = R = mono so the audio ring layout is always the same.
        let n_audio = self.sum_audio.len().min(self.diff_audio.len());
        self.output.clear();
        self.output.reserve(n_audio * 2);
        if self.stereo_locked {
            for i in 0..n_audio {
                let sum = self.sum_audio[i];
                let diff = self.diff_audio[i];
                let l = sum + diff;
                let r = sum - diff;
                // 50 µs de-emphasis per channel.
                self.deemph_l = (1.0 - self.deemph_alpha) * l + self.deemph_alpha * self.deemph_l;
                self.deemph_r = (1.0 - self.deemph_alpha) * r + self.deemph_alpha * self.deemph_r;
                self.output.push(self.deemph_l);
                self.output.push(self.deemph_r);
            }
        } else {
            for i in 0..n_audio {
                let mono = self.sum_audio[i];
                self.deemph_l =
                    (1.0 - self.deemph_alpha) * mono + self.deemph_alpha * self.deemph_l;
                // Drive R from the same de-emphasis state for L=R behavior.
                self.deemph_r = self.deemph_l;
                self.output.push(self.deemph_l);
                self.output.push(self.deemph_r);
            }
        }
        self.output.clone()
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

        // Output is interleaved stereo (L, R, L, R, ...) at 48 kHz, so the
        // total length is 2× the mono sample count. ~480 mono samples → ~960.
        assert!(
            audio.len() >= 800 && audio.len() <= 1040,
            "unexpected audio length: {}",
            audio.len()
        );

        // No pilot in this synthetic signal → demod must stay in mono mode
        // (L = R). 50 µs de-emphasis attenuates a 1 kHz tone by ~3 dB so the
        // expected peak comes in lower than the raw discriminator output —
        // 0.05 is a safe floor.
        assert!(!demod.is_stereo_locked(), "false pilot lock");
        let max = audio.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!(
            max > 0.05,
            "demod output looks like silence (max abs = {max})"
        );
        assert!(max < 2.0, "demod output overshoots (max abs = {max})");

        // Mono guarantee: L and R must match sample-for-sample.
        for ch in audio.chunks_exact(2) {
            assert!((ch[0] - ch[1]).abs() < 1e-6, "mono path L != R");
        }
    }

    /// Stereo MPX synthesis: build a multiplex with 90% sum + pilot + L-R
    /// suppressed-carrier and feed it through the demod. After the chain
    /// the L and R channels should be distinguishable (one tone present,
    /// the other near silent) and the demod should report stereo lock.
    #[test]
    fn wfm_demod_locks_to_stereo_pilot() {
        // Build a real-valued MPX at 240 kS/s directly, then FM-modulate it
        // up to a complex IQ signal at 2.4 MS/s. This is more controllable
        // than synthesising a real stereo broadcast.
        let chunk_samples = 240_000usize; // 100 ms at 2.4 MS/s
        let mut iq = vec![0u8; chunk_samples * 2];
        let mut phase = 0.0f32;
        let amp = 100.0_f32;
        // MPX content: 1 kHz on L (only). With L=tone, R=0 we have
        //   sum = (L+R)/2 = 0.5·tone     (audible at base band)
        //   diff = (L-R)/2 = 0.5·tone    (on 38 kHz suppressed carrier)
        for n in 0..chunk_samples {
            let t = n as f32 / WFM_INPUT_RATE;
            let tone = (2.0 * PI * 1_000.0 * t).sin();
            let sum_baseband = 0.45 * tone;
            // CCIR Rec 450: pilot is coherent with the suppressed carrier.
            // Using cos for both keeps that phase relationship intact, so
            // the receiver's squared-pilot reference comes out in phase
            // with the DSB-SC modulating carrier.
            let diff_dsbsc = 0.45 * tone * (2.0 * PI * 38_000.0 * t).cos();
            let pilot = 0.10 * (2.0 * PI * 19_000.0 * t).cos();
            let mpx = sum_baseband + pilot + diff_dsbsc;

            // FM modulate MPX onto a complex carrier with 75 kHz peak deviation.
            let inst_freq = 75_000.0 * mpx;
            phase += 2.0 * PI * inst_freq / WFM_INPUT_RATE;
            iq[2 * n] = f32_to_u8(amp * phase.cos() + 127.5);
            iq[2 * n + 1] = f32_to_u8(amp * phase.sin() + 127.5);
        }

        let mut demod = WfmDemod::new();
        // Warm-up pass for biquad/decimator transients to settle.
        let _ = demod.process(&iq);
        let audio = demod.process(&iq);

        assert!(demod.is_stereo_locked(), "pilot not detected");

        // Split interleaved L/R and check L >> R amplitude (we put tone on L only).
        let mut max_l = 0.0f32;
        let mut max_r = 0.0f32;
        for ch in audio.chunks_exact(2) {
            max_l = max_l.max(ch[0].abs());
            max_r = max_r.max(ch[1].abs());
        }
        assert!(max_l > 0.05, "L channel silent (max = {max_l})");
        assert!(
            max_l > 2.0 * max_r,
            "stereo separation poor: L max = {max_l}, R max = {max_r}",
        );
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
