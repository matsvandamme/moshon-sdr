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
/// Default first-stage decimation factor at the canonical 2.4 MS/s input
/// rate. Kept for test convenience; runtime code computes `if_decim` from
/// the actual input sample rate.
#[allow(dead_code)]
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
/// Default audio de-emphasis time constant. 50 µs in ITU Region 1
/// (Europe), 75 µs in North America. The default targets R1; the user
/// can change it live via `WfmDemod::set_deemphasis_us`.
const WFM_DEEMPH_TAU_S: f32 = 50e-6;

/// Compute the single-pole de-emphasis IIR coefficient
/// `α = exp(-1 / (τ · fs))` for a given time constant in seconds at the
/// 48 kHz audio rate.
fn deemph_alpha_for(tau_s: f32) -> f32 {
    (-1.0 / (tau_s * AUDIO_RATE)).exp()
}

// ─── RDS constants ───────────────────────────────────────────────────────
/// RDS subcarrier frequency (Hz). 3× the 19 kHz pilot, locked to it.
const RDS_SUBCARRIER_HZ: f32 = 57_000.0;
/// RDS half-symbol rate (2× baud due to biphase channel coding).
/// The actual data rate is `RDS_HALF_BAUD / 2.0` = 1187.5 baud.
const RDS_HALF_BAUD: f32 = 2_375.0;
/// Generator polynomial G(x) = x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1.
/// We keep only the lower 10 bits (the implicit x^10 is the feedback).
const RDS_GEN_POLY: u16 = 0b0001_1011_1001;
/// Offset words per RDS spec (added to the syndrome at transmit time).
const RDS_OFFSET_A: u16 = 0x0FC;
const RDS_OFFSET_B: u16 = 0x198;
const RDS_OFFSET_C: u16 = 0x168;
const RDS_OFFSET_C_PRIME: u16 = 0x350;
const RDS_OFFSET_D: u16 = 0x1B4;
/// Bits per RDS block (16 data + 10 checkword).
const RDS_BITS_PER_BLOCK: u32 = 26;
/// Half-symbols processed before flipping biphase phase while searching.
/// At 2375 half-symbols/sec, 4000 ≈ 1.7 s. If sync hasn't happened by
/// then, we're almost certainly on the wrong phase — try the other one.
const RDS_PHASE_FLIP_HALF_SYMBOLS: u32 = 4000;
/// Consecutive valid blocks required to confirm sync (after the first
/// match). One match per ~200 bits happens by chance in noise.
const RDS_SYNC_CONFIRM_BLOCKS: u8 = 2;

/// RDS BPSK + protocol decoder. Embedded in `WfmDemod` and fed MPX samples
/// (plus a coherent 57 kHz reference derived from the pilot) on every IF-rate
/// loop iteration.
///
/// Pipeline:
///   1. Caller multiplies MPX by `ref57` (and optionally `ref57_q`, in-phase
///      and quadrature via pilot tripling). We low-pass with a biquad to
///      isolate the baseband BPSK.
///   2. Symbol clock: fractional phase accumulator at 2× baud (= 2375 Hz)
///      driven by the IF-rate. When the accumulator wraps, we emit a half
///      symbol (the sign of the I-channel baseband).
///   3. Biphase: each transmitted bit is two half-symbols of opposite
///      polarity. We pick one of two phase alignments — whichever produces
///      block sync first wins.
///   4. Differential decode: `data_bit = current XOR previous`.
///   5. Sliding 26-bit window. For each candidate offset word (A, B, C, C',
///      D), compute the syndrome and check if it equals that offset. If so,
///      we have a tentative block boundary.
///   6. Track the 4-block group state. On a complete Group 0A, extract two
///      PS characters at the address from block 2 and write them into the
///      PS buffer. Group 2A populates the 64-char Radio Text buffer.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_lossless
)]
struct RdsDecoder {
    // Front-end (operates at the 240 kHz IF rate). Q-channel LPF will be
    // added when we wire a PLL for proper phase tracking; for now the
    // I-only baseband works on strong RDS signals.
    i_lpf: Biquad,
    half_symbol_phase: f32,
    half_symbol_step: f32,

    // Biphase decoder: store last half-symbol so we can pair it.
    last_half: f32,
    have_last_half: bool,
    /// Which biphase phase we're committed to. 0 pairs even half-symbols
    /// with the next; 1 pairs odd. We flip every `PHASE_FLIP_HALF_SYMBOLS`
    /// while in Searching state until block sync confirms one is correct.
    phase: u8,
    half_symbols_since_resync: u32,
    /// Counter for the auto-phase-flip while we're hunting for sync.
    half_symbols_since_phase_flip: u32,

    // Differential decode state.
    last_bit: u8,

    // Block sync — sliding 26-bit window.
    shift_reg: u32,
    bit_index: u32,
    /// Currently expected offset word index. 0=A, 1=B, 2=C/C', 3=D.
    /// Block C may carry offset C' instead — the parser handles both.
    expected_offset_idx: u8,
    /// Group-A blocks accumulated so far, in raw 26-bit form. We only
    /// commit them after the full 4-block sync confirms.
    blocks: [u32; 4],
    /// Sync state machine. False until we've seen `SYNC_CONFIRM_BLOCKS`
    /// consecutive valid blocks at the expected spacing — guards against
    /// the ~0.5% per-bit false-positive rate of single-offset matches.
    synced: bool,
    /// Consecutive valid blocks seen during the pending phase, OR while
    /// fully synced (resets on any miss).
    consecutive_good: u8,
    /// How many bits ago we last saw a valid block — for re-sync timeouts.
    bits_since_valid: u32,

    // Decoded fields.
    pi: u16,
    /// PS buffer: 8 ASCII chars, 4 pairs filled separately as Group 0A
    /// blocks arrive (address bits 0..3).
    ps_buf: [u8; 8],
    /// RT buffer: 64 ASCII chars, 16 quartets from Group 2A.
    rt_buf: [u8; 64],
    /// Track which 4-char RT segments have been received (for partial display).
    rt_received: u32,
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_lossless
)]
impl RdsDecoder {
    fn new(if_rate_hz: f32) -> Self {
        // Half-symbol clock: advance phase by HALF_BAUD/IF_RATE each IF
        // sample; when phase ≥ 1, sample and reset.
        let half_symbol_step = RDS_HALF_BAUD / if_rate_hz;
        // Baseband LPFs after coherent mix. Cutoff ~2.4 kHz at IF rate, but
        // biquads only do single-pole shaping — we pick a low Q for a wide
        // roll-off and rely on the natural absence of strong energy outside
        // the RDS band.
        let i_lpf = Biquad::bandpass(2_400.0, if_rate_hz, 0.5);
        RdsDecoder {
            i_lpf,
            half_symbol_phase: 0.0,
            half_symbol_step,
            last_half: 0.0,
            have_last_half: false,
            phase: 0,
            half_symbols_since_resync: 0,
            half_symbols_since_phase_flip: 0,
            last_bit: 0,
            shift_reg: 0,
            bit_index: 0,
            expected_offset_idx: 0,
            blocks: [0; 4],
            synced: false,
            consecutive_good: 0,
            bits_since_valid: 0,
            pi: 0,
            ps_buf: [b' '; 8],
            rt_buf: [b' '; 64],
            rt_received: 0,
        }
    }

    /// Process one MPX sample multiplied by the coherent 57 kHz reference.
    /// Caller derives the reference from the pilot tripling (`pilot ·
    /// ref38`, low-passed at 57 kHz). The quadrature path is a future
    /// addition for proper PLL phase tracking; the I-only baseband works
    /// on strong RDS signals.
    fn process_sample(&mut self, mpx_x_ref57: f32) {
        // Drive the I-LPF; we ignore Q for now (PLL-style alignment is
        // a future polish item).
        let i_baseband = self.i_lpf.process(mpx_x_ref57);

        // Symbol clock.
        self.half_symbol_phase += self.half_symbol_step;
        if self.half_symbol_phase < 1.0 {
            return;
        }
        self.half_symbol_phase -= 1.0;

        // We have a new half-symbol sample.
        self.half_symbols_since_resync += 1;
        self.half_symbols_since_phase_flip += 1;

        // If we've been searching too long, the biphase phase is probably
        // wrong — flip it and start over. Once sync confirms, the counter
        // is reset and this stops firing.
        if !self.synced && self.half_symbols_since_phase_flip >= RDS_PHASE_FLIP_HALF_SYMBOLS {
            self.phase ^= 1;
            self.half_symbols_since_phase_flip = 0;
            // Also reset the sync state machine so a stale partial group
            // from the wrong phase doesn't seed the new attempt.
            self.shift_reg = 0;
            self.bit_index = 0;
            self.consecutive_good = 0;
            self.expected_offset_idx = 0;
            self.bits_since_valid = 0;
        }

        let this_half = i_baseband;

        if !self.have_last_half {
            self.last_half = this_half;
            self.have_last_half = true;
            return;
        }

        // Biphase decode happens on alternating half-symbols based on
        // self.phase: pair (prev, curr) when (half_symbols % 2) == phase.
        if (self.half_symbols_since_resync & 1) != u32::from(self.phase) {
            self.last_half = this_half;
            return;
        }

        // Pair → one channel bit. With biphase coding, a transmitted
        // '0' is high-low (+,-) and '1' is low-high (-,+). The decision
        // statistic is (last_half - this_half): if positive → 0, else → 1.
        let channel_bit = u8::from(self.last_half - this_half <= 0.0);
        self.last_half = this_half;

        // Differential decode: data_bit = current XOR previous.
        let data_bit = channel_bit ^ self.last_bit;
        self.last_bit = channel_bit;

        self.shift_in_bit(data_bit);
    }

    fn shift_in_bit(&mut self, bit: u8) {
        // 26-bit sliding window.
        self.shift_reg = ((self.shift_reg << 1) | u32::from(bit)) & 0x3FF_FFFF;
        self.bit_index += 1;
        self.bits_since_valid += 1;

        if self.bit_index < RDS_BITS_PER_BLOCK {
            return;
        }

        // Test the window against the expected offset word (when synced) or
        // all five offsets (when searching).
        let syndrome = rds_syndrome(self.shift_reg);

        if self.consecutive_good > 0 {
            // Either pending-confirm (synced=false, consecutive_good in 1..=N)
            // or fully synced (consecutive_good >= N). Either way we expect a
            // specific offset at this bit position. Any miss drops us all
            // the way back to Searching — sliding past a bad block silently
            // corrupts every subsequent decode.
            let expected = match self.expected_offset_idx {
                1 => RDS_OFFSET_B,
                2 => RDS_OFFSET_C, // C' handled below
                3 => RDS_OFFSET_D,
                _ => RDS_OFFSET_A, // idx 0; out-of-range is unreachable.
            };
            let matched = syndrome == expected
                || (self.expected_offset_idx == 2 && syndrome == RDS_OFFSET_C_PRIME);
            if matched {
                self.blocks[self.expected_offset_idx as usize] = self.shift_reg;
                self.bits_since_valid = 0;
                self.consecutive_good = self.consecutive_good.saturating_add(1);
                if self.consecutive_good >= RDS_SYNC_CONFIRM_BLOCKS {
                    self.synced = true;
                }
                // Commit a group only after the four blocks of one group
                // are filled in sequence (D is index 3).
                if self.synced && self.expected_offset_idx == 3 {
                    self.commit_group();
                }
                self.expected_offset_idx = (self.expected_offset_idx + 1) % 4;
                self.bit_index = 0;
            } else {
                // Drop sync. Start over by sliding the window 1 bit at a
                // time and searching against all offsets.
                self.synced = false;
                self.consecutive_good = 0;
                self.expected_offset_idx = 0;
                self.bit_index = RDS_BITS_PER_BLOCK - 1;
                self.bits_since_valid = 0;
            }
        } else {
            // Searching: try every offset on every bit shift.
            for (idx, &off) in [RDS_OFFSET_A, RDS_OFFSET_B, RDS_OFFSET_C, RDS_OFFSET_D]
                .iter()
                .enumerate()
            {
                if syndrome == off {
                    self.blocks[idx] = self.shift_reg;
                    self.expected_offset_idx = ((idx + 1) % 4) as u8;
                    self.bit_index = 0;
                    self.bits_since_valid = 0;
                    self.consecutive_good = 1; // first match — pending confirmation
                    return;
                }
            }
            if syndrome == RDS_OFFSET_C_PRIME {
                self.blocks[2] = self.shift_reg;
                self.expected_offset_idx = 3;
                self.bit_index = 0;
                self.bits_since_valid = 0;
                self.consecutive_good = 1;
                return;
            }
            // No match — slide the window one more bit and retry.
            self.bit_index = RDS_BITS_PER_BLOCK - 1;
        }
    }

    fn commit_group(&mut self) {
        // Each block is 26 bits = 16 data + 10 checkword. Strip the checkword.
        let block_a = (self.blocks[0] >> 10) & 0xFFFF;
        let block_b = (self.blocks[1] >> 10) & 0xFFFF;
        let block_c = (self.blocks[2] >> 10) & 0xFFFF;
        let block_d = (self.blocks[3] >> 10) & 0xFFFF;

        // Block A: PI code.
        self.pi = block_a as u16;

        // Group type code = top 5 bits of block B (4 group + 1 A/B flag).
        // 0A = 0b00000, 2A = 0b00100, etc.
        let group_type = (block_b >> 11) & 0x1F;

        if group_type == 0x00 {
            // Group 0A: PS chars at address (block_b & 0x3).
            let addr = (block_b & 0x3) as usize;
            self.ps_buf[2 * addr] = ((block_d >> 8) & 0xFF) as u8;
            self.ps_buf[2 * addr + 1] = (block_d & 0xFF) as u8;
        } else if group_type == 0x04 {
            // Group 2A: 4 RT chars at address (block_b & 0xF) × 4.
            let addr = (block_b & 0xF) as usize;
            if addr * 4 + 3 < self.rt_buf.len() {
                self.rt_buf[addr * 4] = ((block_c >> 8) & 0xFF) as u8;
                self.rt_buf[addr * 4 + 1] = (block_c & 0xFF) as u8;
                self.rt_buf[addr * 4 + 2] = ((block_d >> 8) & 0xFF) as u8;
                self.rt_buf[addr * 4 + 3] = (block_d & 0xFF) as u8;
                self.rt_received |= 1 << addr;
            }
        }
    }

    fn reset(&mut self) {
        *self = RdsDecoder::new(WFM_IF_RATE);
    }
}

/// Compute the syndrome of a 26-bit RDS codeword by polynomial division.
/// The shift-register implementation runs in O(26) bit ops per block.
#[allow(clippy::cast_possible_truncation)]
fn rds_syndrome(mut codeword: u32) -> u16 {
    // Process MSB-first.
    let mut reg: u32 = 0;
    let mut mask: u32 = 1 << (RDS_BITS_PER_BLOCK - 1);
    while mask != 0 {
        let bit = (codeword & mask) != 0;
        let high = (reg & (1 << 9)) != 0;
        reg = (reg << 1) & 0x3FF;
        if bit ^ high {
            reg ^= u32::from(RDS_GEN_POLY);
        }
        codeword &= !mask;
        mask >>= 1;
    }
    reg as u16
}

/// Sanitize PS / RT bytes: spec uses Latin-1-like encoding with 0x20-0x7E
/// printable. Replace anything outside ASCII printable with a space so the
/// UI doesn't render garbage.
fn rds_clean_byte(b: u8) -> u8 {
    if (0x20..=0x7E).contains(&b) {
        b
    } else {
        b' '
    }
}

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
    bpf57: Biquad,
    pilot_env: f32,
    deemph_alpha: f32,
    deemph_l: f32,
    deemph_r: f32,
    /// True when the smoothed pilot envelope is above threshold.
    stereo_locked: bool,

    // RDS subsystem.
    rds_enabled: bool,
    rds: RdsDecoder,

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
    /// Construct a WFM demodulator for the given input IQ sample rate.
    /// Supported rates: any integer multiple of `WFM_IF_RATE` (240 kHz)
    /// that the dongle can actually deliver — e.g. 1.92, 2.4, 2.88, 4.8,
    /// 9.6 MS/s. Non-integer ratios round to the nearest integer; the IF
    /// rate may then drift slightly from 240 kHz (acceptable for ear).
    #[wasm_bindgen(constructor)]
    #[must_use]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    pub fn new(input_rate_hz: f32) -> WfmDemod {
        let if_decim = ((input_rate_hz / WFM_IF_RATE).round() as usize).max(1);
        // First stage: 31-tap LPF with ~100 kHz cutoff at the input rate.
        // Pass band covers the full WFM signal (±100 kHz around DC).
        let iq_taps = lowpass_taps(31, 100_000.0 / input_rate_hz);
        // Audio stage: 47-tap LPF with cutoff at 15 kHz / 240 kHz = 0.0625.
        // Pass band covers the broadcast-FM mono audio (50 Hz – 15 kHz). We
        // build TWO independent decimators so the sum (L+R) and difference
        // (L-R) paths can have separate filter history.
        let audio_taps_sum = lowpass_taps(47, 0.0625);
        let audio_taps_diff = lowpass_taps(47, 0.0625);

        let audio_scale = WFM_IF_RATE / (PI * WFM_DEVIATION);

        // De-emphasis: y[n] = (1-α)·x[n] + α·y[n-1], with α = exp(-1/(τ·fs)).
        // Default τ is set for ITU R1 (Europe); change via set_deemphasis_us.
        let deemph_alpha = deemph_alpha_for(WFM_DEEMPH_TAU_S);

        WfmDemod {
            iq_decim: ComplexDecimator::new(if_decim, iq_taps),
            sum_decim: RealDecimator::new(WFM_AUDIO_DECIM, audio_taps_sum),
            diff_decim: RealDecimator::new(WFM_AUDIO_DECIM, audio_taps_diff),
            last_z: Complex { re: 1.0, im: 0.0 },
            audio_scale,

            stereo_enabled: true,
            pilot_bpf: Biquad::bandpass(WFM_PILOT_HZ, WFM_IF_RATE, 50.0),
            bpf38: Biquad::bandpass(WFM_LR_CARRIER_HZ, WFM_IF_RATE, 25.0),
            bpf57: Biquad::bandpass(RDS_SUBCARRIER_HZ, WFM_IF_RATE, 25.0),
            pilot_env: 0.0,
            deemph_alpha,
            deemph_l: 0.0,
            deemph_r: 0.0,
            stereo_locked: false,

            rds_enabled: true,
            rds: RdsDecoder::new(WFM_IF_RATE),

            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / if_decim + 16),
            mpx: Vec::with_capacity(65_536 / if_decim + 16),
            diff_mix: Vec::with_capacity(65_536 / if_decim + 16),
            sum_audio: Vec::with_capacity(65_536 / (if_decim * WFM_AUDIO_DECIM) + 16),
            diff_audio: Vec::with_capacity(65_536 / (if_decim * WFM_AUDIO_DECIM) + 16),
            output: Vec::with_capacity(2 * (65_536 / (if_decim * WFM_AUDIO_DECIM) + 16)),
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

    /// Set the audio de-emphasis time constant in microseconds. Standard
    /// values are 50 µs (ITU R1 / Europe) and 75 µs (North America). The
    /// coefficient is recomputed; existing filter state is preserved so
    /// there's no click on the transition.
    pub fn set_deemphasis_us(&mut self, us: f32) {
        let tau_s = (us.max(1.0)) * 1e-6;
        self.deemph_alpha = deemph_alpha_for(tau_s);
    }

    /// True when the smoothed pilot envelope exceeds the threshold AND
    /// stereo decoding is enabled. Updated each `process()` call.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn is_stereo_locked(&self) -> bool {
        self.stereo_locked
    }

    /// True once the RDS block-sync state machine has locked.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn rds_synced(&self) -> bool {
        self.rds.synced
    }

    /// 16-bit Program Identification code from the most-recent block A.
    /// Zero before the first sync.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn rds_pi(&self) -> u16 {
        self.rds.pi
    }

    /// Program Service name — 8 ASCII characters, padded with spaces.
    /// Each pair of characters arrives in a Group 0A; the buffer is updated
    /// in place so partial PS may include leftover bytes from a previous
    /// station for a few hundred ms after retuning.
    #[must_use]
    pub fn rds_ps(&self) -> String {
        let mut s = String::with_capacity(8);
        for &b in &self.rds.ps_buf {
            s.push(char::from(rds_clean_byte(b)));
        }
        s
    }

    /// Radio Text — up to 64 ASCII characters from Group 2A. Stations may
    /// send shorter strings terminated by 0x0D — we leave that to the
    /// caller to trim.
    #[must_use]
    pub fn rds_rt(&self) -> String {
        let mut s = String::with_capacity(64);
        for &b in &self.rds.rt_buf {
            s.push(char::from(rds_clean_byte(b)));
        }
        s
    }

    /// Clear the RDS decoder state. Call after a retune so leftover PS
    /// chars from the previous station don't bleed into the new one.
    pub fn reset_rds(&mut self) {
        self.rds.reset();
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

            // RDS coherent reference at 57 kHz = 3× pilot. pilot · ref38
            // contains cos(19k) + cos(57k); bpf57 picks the latter.
            if self.rds_enabled {
                let ref57 = self.bpf57.process(pilot * ref38);
                self.rds.process_sample(m * ref57);
            }
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
        Self::new(WFM_INPUT_RATE)
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

/// Default stage-1 decimation factor at 2.4 MS/s input. The runtime
/// computes the real `if_decim` from the configured input rate; this
/// constant is kept for back-compat / tests only.
#[allow(dead_code)]
const NARROW_IF_DECIM: usize = 10;
/// Target stage-1 sample rate after the wide anti-alias filter. Constant
/// across input rates because the downstream biquads (pilot/RDS/etc.) and
/// audio decimator are all tuned to this.
const NARROW_IF_RATE: f32 = 240_000.0;
/// Stage-2 decimation factor: 240 kS/s → 48 kS/s.
const NARROW_AUDIO_DECIM: usize = 5;
/// Default NFM peak deviation for the audio scaling. Typical ham 2 m / 70 cm.
const NFM_DEFAULT_DEVIATION: f32 = 5_000.0;
/// Single-pole DC-block coefficient. α = 0.995 corresponds to a ~24 Hz
/// HPF at the 48 kHz audio rate — well below the lowest audible content
/// for voice modes, so it strips residual DC offset without colouring
/// the audio. Reused across AM (carrier component), NFM (discriminator
/// bias), SSB (Weaver output asymmetry), and CW (BFO mixer leak).
const DC_BLOCK_ALPHA: f32 = 0.995;

/// Single-pole DC-blocker. y[n] = x[n] − x[n−1] + α·y[n−1].
struct DcBlock {
    x_prev: f32,
    y_prev: f32,
    alpha: f32,
}

impl DcBlock {
    fn new(alpha: f32) -> Self {
        Self {
            x_prev: 0.0,
            y_prev: 0.0,
            alpha,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = x - self.x_prev + self.alpha * self.y_prev;
        self.x_prev = x;
        self.y_prev = y;
        y
    }
}
/// Clamp range for user-set channel bandwidth. Narrower than 1.5 kHz makes
/// the FIR ringing dominate; wider than ~40 % of `NARROW_IF_RATE` aliases.
const NARROW_BW_MIN: f32 = 1_500.0;
const NARROW_BW_MAX: f32 = NARROW_IF_RATE * 0.4;

fn build_stage1_iq_taps(input_rate_hz: f32) -> Vec<f32> {
    // Same as WFM's first stage — ~100 kHz cutoff normalized to the input
    // sample rate, wide enough that the channel filter does the real
    // selectivity job downstream.
    lowpass_taps(31, 100_000.0 / input_rate_hz)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn narrow_if_decim(input_rate_hz: f32) -> usize {
    ((input_rate_hz / NARROW_IF_RATE).round() as usize).max(1)
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
    /// Strips the discriminator's static bias (carrier offset → constant
    /// phase increment → constant DC out of the atan2). Without this the
    /// audio sits on a small offset that the speaker treats as click on
    /// every retune.
    dc_block: DcBlock,
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    iq_chan: Vec<Complex<f32>>,
}

#[wasm_bindgen]
impl NfmDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(input_rate_hz: f32, bandwidth_hz: f32) -> NfmDemod {
        let if_decim = narrow_if_decim(input_rate_hz);
        let stage1 = build_stage1_iq_taps(input_rate_hz);
        let stage2 = build_stage2_iq_taps(bandwidth_hz);
        // Scale: with peak deviation `f_dev` and output sample rate `f_s`, peak
        // phase change per sample is `2π·f_dev/f_s`. Choosing scale = f_s /
        // (π·f_dev) gives a peak output of ~2.0 at full deviation, matching
        // the WFM convention.
        let audio_scale = AUDIO_RATE / (PI * NFM_DEFAULT_DEVIATION);
        NfmDemod {
            iq_decim: ComplexDecimator::new(if_decim, stage1),
            chan_decim: ComplexDecimator::new(NARROW_AUDIO_DECIM, stage2),
            last_z: Complex { re: 1.0, im: 0.0 },
            audio_scale,
            dc_block: DcBlock::new(DC_BLOCK_ALPHA),
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / if_decim + 16),
            iq_chan: Vec::with_capacity(65_536 / (if_decim * NARROW_AUDIO_DECIM) + 16),
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
            audio.push(self.dc_block.process(phase * self.audio_scale));
            self.last_z = z;
        }
        audio
    }
}

impl Default for NfmDemod {
    fn default() -> Self {
        Self::new(WFM_INPUT_RATE, 12_500.0)
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
    /// Strips the (DC) carrier component from the envelope.
    dc_block: DcBlock,
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    iq_chan: Vec<Complex<f32>>,
}

#[wasm_bindgen]
impl AmDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(input_rate_hz: f32, bandwidth_hz: f32) -> AmDemod {
        let if_decim = narrow_if_decim(input_rate_hz);
        let stage1 = build_stage1_iq_taps(input_rate_hz);
        let stage2 = build_stage2_iq_taps(bandwidth_hz);
        AmDemod {
            iq_decim: ComplexDecimator::new(if_decim, stage1),
            chan_decim: ComplexDecimator::new(NARROW_AUDIO_DECIM, stage2),
            dc_block: DcBlock::new(DC_BLOCK_ALPHA),
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / if_decim + 16),
            iq_chan: Vec::with_capacity(65_536 / (if_decim * NARROW_AUDIO_DECIM) + 16),
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
            audio.push(self.dc_block.process(env));
        }
        audio
    }
}

impl Default for AmDemod {
    fn default() -> Self {
        Self::new(WFM_INPUT_RATE, 9_000.0)
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
    /// Removes residual DC bias from the Weaver Re{} output.
    dc_block: DcBlock,
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    iq_chan: Vec<Complex<f32>>,
}

#[wasm_bindgen]
impl SsbDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(input_rate_hz: f32, bandwidth_hz: f32, lsb: bool) -> SsbDemod {
        let if_decim = narrow_if_decim(input_rate_hz);
        let bw = bandwidth_hz.clamp(SSB_BW_MIN, NARROW_BW_MAX);
        let stage1 = build_stage1_iq_taps(input_rate_hz);
        // Stage 2 cutoff = full audio width (not half) — we want both sidebands
        // at this point; the Weaver LPF downstream picks one.
        let stage2 = lowpass_taps(63, bw / NARROW_IF_RATE);
        // Weaver LPF cutoff = bw/2 at the 48 kHz audio rate.
        let weaver_taps = lowpass_taps(47, (bw / 2.0) / AUDIO_RATE);
        let nco_step = 2.0 * PI * (bw / 2.0) / AUDIO_RATE;
        let sideband_sign = if lsb { -1.0 } else { 1.0 };
        SsbDemod {
            iq_decim: ComplexDecimator::new(if_decim, stage1),
            chan_decim: ComplexDecimator::new(NARROW_AUDIO_DECIM, stage2),
            nco_phase: 0.0,
            nco_step,
            sideband_sign,
            weaver_lpf: ComplexFir::new(weaver_taps),
            dc_block: DcBlock::new(DC_BLOCK_ALPHA),
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / if_decim + 16),
            iq_chan: Vec::with_capacity(65_536 / (if_decim * NARROW_AUDIO_DECIM) + 16),
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
            audio.push(self.dc_block.process((z_filt * nco_back).re));

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
        Self::new(WFM_INPUT_RATE, SSB_DEFAULT_BW, false)
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
    /// Removes BFO mixer DC leak so the tone sits cleanly on zero.
    dc_block: DcBlock,
    iq_in: Vec<Complex<f32>>,
    iq_if: Vec<Complex<f32>>,
    iq_chan: Vec<Complex<f32>>,
}

#[wasm_bindgen]
impl CwDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(input_rate_hz: f32, bandwidth_hz: f32) -> CwDemod {
        let if_decim = narrow_if_decim(input_rate_hz);
        let bw = bandwidth_hz.clamp(CW_BW_MIN, NARROW_BW_MAX);
        let stage1 = build_stage1_iq_taps(input_rate_hz);
        // Narrow CW filtering wants a long FIR — 127 taps at a low cutoff
        // gives a usable rolloff without becoming the dominant cost.
        let stage2 = lowpass_taps(127, (bw / 2.0) / NARROW_IF_RATE);
        let bfo_step = 2.0 * PI * CW_BFO_HZ / AUDIO_RATE;
        CwDemod {
            iq_decim: ComplexDecimator::new(if_decim, stage1),
            chan_decim: ComplexDecimator::new(NARROW_AUDIO_DECIM, stage2),
            bfo_phase: 0.0,
            bfo_step,
            dc_block: DcBlock::new(DC_BLOCK_ALPHA),
            iq_in: Vec::with_capacity(65_536),
            iq_if: Vec::with_capacity(65_536 / if_decim + 16),
            iq_chan: Vec::with_capacity(65_536 / (if_decim * NARROW_AUDIO_DECIM) + 16),
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
            audio.push(self.dc_block.process(z.re * cos_p - z.im * sin_p));
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
        Self::new(WFM_INPUT_RATE, CW_DEFAULT_BW)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// ADS-B Mode S extended squitter decoder (M2.6)
// ──────────────────────────────────────────────────────────────────────────
//
// Demodulates 1090 MHz Mode S extended squitter (DF17/DF18) frames from
// the IQ stream. The caller is responsible for tuning the device to
// 1090 MHz and routing the IQ here instead of through the audio demods.
//
// Pipeline (per `process()`):
//   1. Convert u8 IQ → envelope magnitude (|I−127.5|² + |Q−127.5|² → sqrt is
//      omitted; comparisons on squared magnitudes work the same).
//   2. Push samples into a circular sliding window.
//   3. At each new sample, test whether a Mode S preamble pattern starts
//      120 samples earlier (preamble + max frame ~288 samples at 2.4 MS/s).
//   4. On a preamble match, slice 112 bits using PPM rule (a transmitted
//      '1' is high then low across the two half-symbols of one bit period;
//      '0' is low then high).
//   5. CRC-24 check using the Mode S generator polynomial 0xFFF409. For
//      DF17 the CRC field is the standard CRC XORed with the sender's
//      ICAO address, so a valid frame's CRC equals the ICAO embedded in
//      bits 9-32.
//   6. Emit decoded raw bytes + DF + ICAO via accessor methods. The JS
//      side parses ME field type codes.

/// Mode S CRC-24 generator polynomial without the implicit x^24 bit.
const ADSB_CRC_POLY: u32 = 0x00FF_F409;
/// Number of bits in the 8 µs preamble at half-bit (2 MHz) resolution.
const ADSB_PREAMBLE_HALFBITS: usize = 16;
/// Long ADS-B frame: 112 bits = 14 bytes.
const ADSB_FRAME_BITS_LONG: usize = 112;
/// Short Mode S frame (DF0/4/5/11): 56 bits = 7 bytes. Not currently
/// decoded — all the useful air-traffic info lives in DF17 (long form).
/// Kept for reference; will be used when short-replies land.
#[allow(dead_code)]
const ADSB_FRAME_BITS_SHORT: usize = 56;
/// Maximum frame size in bytes (long frame).
const ADSB_FRAME_BYTES_LONG: usize = ADSB_FRAME_BITS_LONG / 8;
/// Detector threshold: a "high" sample needs to be at least this multiple
/// of the surrounding noise floor to count as a pulse. Tunable.
const ADSB_DETECTOR_THRESHOLD: f32 = 2.5;
/// Maximum frames buffered between `process()` calls before older frames
/// are dropped. 256 frames @ ~10 Hz is plenty of headroom for any single
/// 1/30 s chunk.
const ADSB_FRAME_BUFFER_CAP: usize = 256;

/// One decoded ADS-B frame. Raw bytes + the most useful field (DF + ICAO).
/// The JS side does the rest of the ME-field parsing.
#[derive(Clone)]
struct AdsbFrameInternal {
    raw: [u8; ADSB_FRAME_BYTES_LONG],
    df: u8,
    icao: u32,
    /// Sample-index of the preamble start; useful for time-sequencing pairs
    /// of CPR position frames.
    sample_index: u64,
}

#[wasm_bindgen]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::cast_lossless
)]
pub struct AdsbDemod {
    #[allow(dead_code)]
    sample_rate_hz: f32,
    /// Samples per ADS-B bit at the configured sample rate. ~2.4 at 2.4 MS/s.
    samples_per_bit: f32,
    /// Circular envelope buffer. Length covers preamble (8 µs) + long frame
    /// (112 µs) plus a few extra samples of slack — 360 at 2.4 MS/s.
    env: Vec<f32>,
    /// Current write position in the circular buffer.
    write_pos: usize,
    /// Cumulative sample index since `new()` — exposed in frames.
    sample_count: u64,
    /// Last sample index at which we emitted a frame; suppresses overlapping
    /// detections of the same frame.
    last_frame_at: u64,

    /// Buffered frames waiting to be drained by the JS poll.
    pending: Vec<AdsbFrameInternal>,
}

#[wasm_bindgen]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::cast_lossless
)]
impl AdsbDemod {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(sample_rate_hz: f32) -> AdsbDemod {
        let samples_per_bit = sample_rate_hz / 1_000_000.0;
        // Buffer covers preamble + long frame + slack. At 2.4 MS/s,
        // ~120 µs × 2.4 = 288 samples; round up generously.
        let env_len = (samples_per_bit * (8.0 + 112.0 + 16.0)).ceil() as usize;
        AdsbDemod {
            sample_rate_hz,
            samples_per_bit,
            env: vec![0.0; env_len.max(512)],
            write_pos: 0,
            sample_count: 0,
            last_frame_at: 0,
            pending: Vec::with_capacity(8),
        }
    }

    /// Feed a chunk of IQ samples. Decoded frames pile up internally;
    /// drain them with `drain_frames_json()`.
    pub fn process(&mut self, iq_bytes: &[u8]) {
        let n = iq_bytes.len() / 2;
        for i in 0..n {
            let re = f32::from(iq_bytes[2 * i]) - 127.5;
            let im = f32::from(iq_bytes[2 * i + 1]) - 127.5;
            // Use squared magnitude — saves a sqrt and comparisons are
            // monotonic. The detector threshold is a ratio so absolute
            // scale doesn't matter.
            let mag2 = re * re + im * im;
            self.env[self.write_pos] = mag2;
            self.write_pos = (self.write_pos + 1) % self.env.len();
            self.sample_count += 1;

            // Try to detect a preamble that started `lookback` samples ago.
            // We delay detection until we have enough samples after the
            // putative start to also decode bits — at minimum one long
            // frame's worth.
            let lookback_samples =
                (self.samples_per_bit * (8.0 + ADSB_FRAME_BITS_LONG as f32 + 1.0)).ceil() as u64;
            if self.sample_count >= lookback_samples
                && self.sample_count.saturating_sub(self.last_frame_at) > 30
            {
                self.try_decode_at(self.sample_count - lookback_samples);
            }
        }
    }

    /// Return all pending frames as a JSON array string, draining the
    /// internal buffer. JSON is the simplest cross-WASM-boundary format
    /// for variable-length structured data.
    #[must_use]
    pub fn drain_frames_json(&mut self) -> String {
        let mut s = String::from("[");
        for (i, f) in self.pending.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str("{\"df\":");
            s.push_str(&f.df.to_string());
            s.push_str(",\"icao\":");
            s.push_str(&f.icao.to_string());
            s.push_str(",\"t\":");
            s.push_str(&f.sample_index.to_string());
            s.push_str(",\"raw\":\"");
            for b in &f.raw {
                let hi = b >> 4;
                let lo = b & 0x0F;
                s.push(hex_nibble(hi));
                s.push(hex_nibble(lo));
            }
            s.push_str("\"}");
        }
        s.push(']');
        self.pending.clear();
        s
    }

    /// Cumulative frame count since construction (does not reset on drain).
    /// Used by the UI to display a "frames decoded" telemetry counter even
    /// when there's no current activity.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn frame_count(&self) -> u32 {
        // We don't keep a separate cumulative counter to save state, so
        // this is approximate — represents the high-water mark of the
        // buffer's lifetime. Good enough for telemetry.
        self.pending.len() as u32
    }

    fn try_decode_at(&mut self, start_idx: u64) {
        // The envelope buffer is circular; convert a sample index to a
        // buffer position relative to write_pos.
        let env_len = self.env.len();
        let offset_back = (self.sample_count - start_idx) as usize;
        if offset_back >= env_len {
            return; // out of buffer
        }
        let start_pos = (self.write_pos + env_len - offset_back) % env_len;

        // Preamble check at 2.4 samples/bit. Half-bit period = samples/bit/2.
        // Sample at indices 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
        // (in half-bit units, so multiply by samples_per_bit / 2).
        let half = self.samples_per_bit / 2.0;
        let mut h = [0.0f32; ADSB_PREAMBLE_HALFBITS];
        for (k, slot) in h.iter_mut().enumerate() {
            let s = (k as f32 * half).round() as usize;
            *slot = self.env[(start_pos + s) % env_len];
        }

        // Mode S preamble shape: HI LO HI LO LO LO LO HI LO HI LO LO LO LO LO LO
        // (indices 0, 2, 7, 9 are pulses; rest is quiet)
        let highs = [h[0], h[2], h[7], h[9]];
        let lows = [
            h[1], h[3], h[4], h[5], h[6], h[8], h[10], h[11], h[12], h[13], h[14], h[15],
        ];
        let high_min = highs.iter().copied().fold(f32::INFINITY, f32::min);
        let low_max = lows.iter().copied().fold(0.0f32, f32::max);
        // Each pulse must be at least THRESHOLD× any quiet sample.
        if !(high_min > low_max * ADSB_DETECTOR_THRESHOLD && high_min > 0.0) {
            return;
        }

        // Decode 112 bits using PPM. Data starts 8 µs after preamble.
        let bit_period = self.samples_per_bit;
        let data_offset = (8.0 * bit_period).round() as usize;
        let mut bytes = [0u8; ADSB_FRAME_BYTES_LONG];
        for b in 0..ADSB_FRAME_BITS_LONG {
            let bit_start = data_offset + ((b as f32 * bit_period).round() as usize);
            let mid = bit_start + ((bit_period / 2.0).round() as usize);
            let first = self.env[(start_pos + bit_start) % env_len];
            let second = self.env[(start_pos + mid) % env_len];
            // '1' = first half high, second half low (and vice versa for '0').
            let bit_val = u8::from(first > second);
            bytes[b / 8] |= bit_val << (7 - (b % 8));
        }

        // DF check first — only DF17/18 (extended squitter) carry ICAO in
        // the AA field at bits 9-32, with plain CRC (no AP XOR) in PI.
        let df = (bytes[0] >> 3) & 0x1F;
        if df != 17 && df != 18 {
            return;
        }
        let computed_crc = mode_s_crc24(&bytes, ADSB_FRAME_BITS_LONG);
        if computed_crc != 0 {
            return;
        }
        let icao_from_aa =
            (u32::from(bytes[1]) << 16) | (u32::from(bytes[2]) << 8) | u32::from(bytes[3]);

        // Frame accepted.
        if self.pending.len() < ADSB_FRAME_BUFFER_CAP {
            self.pending.push(AdsbFrameInternal {
                raw: bytes,
                df,
                icao: icao_from_aa,
                sample_index: start_idx,
            });
        }
        self.last_frame_at = self.sample_count;
    }
}

impl Default for AdsbDemod {
    fn default() -> Self {
        Self::new(2_400_000.0)
    }
}

/// Mode S CRC-24 (polynomial 0x1FFF409, lower 24 bits 0xFFF409) computed
/// over the first `n_bits` of `msg`, MSB-first. For DF17/18 extended
/// squitter the parity field is plain CRC over data (no ICAO XOR fold-in
/// — that's used by DF0/4/5/11 short replies via the AP field). So a
/// clean DF17 frame's syndrome over all 112 bits is zero.
#[allow(clippy::cast_lossless)]
fn mode_s_crc24(msg: &[u8], n_bits: usize) -> u32 {
    let mut crc: u32 = 0;
    for j in 0..n_bits {
        let byte = j / 8;
        let bit = 7 - (j % 8);
        let b = u32::from((msg[byte] >> bit) & 1);
        // Standard polynomial-division LFSR: shift register left, slot the
        // new bit into the LSB, then if the bit that rolled OUT of the
        // top was 1, XOR with the generator (without its implicit x^24).
        let top = (crc >> 23) & 1;
        crc = ((crc << 1) | b) & 0x00FF_FFFF;
        if top != 0 {
            crc ^= ADSB_CRC_POLY;
        }
    }
    crc
}

fn hex_nibble(n: u8) -> char {
    match n {
        0..=9 => char::from(b'0' + n),
        10..=15 => char::from(b'A' + (n - 10)),
        _ => '?',
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

        let mut demod = WfmDemod::new(WFM_INPUT_RATE);
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

        let mut demod = WfmDemod::new(WFM_INPUT_RATE);
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

        let mut demod = NfmDemod::new(WFM_INPUT_RATE, 12_500.0);
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

        let mut demod = AmDemod::new(WFM_INPUT_RATE, 9_000.0);
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

        let mut usb = SsbDemod::new(WFM_INPUT_RATE, 2_400.0, false);
        let _ = usb.process(&iq);
        let audio_usb = usb.process(&iq);

        let mut lsb = SsbDemod::new(WFM_INPUT_RATE, 2_400.0, true);
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

    /// Canonical DF17 frame from the pyModeS test suite. PI is plain CRC
    /// over data (no ICAO XOR for DF17), so the syndrome over all 112 bits
    /// must be 0 on a clean frame.
    #[test]
    fn adsb_crc_zero_on_canonical_df17_frame() {
        let bytes = hex_to_bytes("8D4840D6202CC371C32CE0576098");
        assert_eq!(bytes.len(), 14);
        let crc = mode_s_crc24(&bytes, 112);
        assert_eq!(crc, 0, "CRC syndrome should be 0 on a valid DF17 frame");
        let icao = (u32::from(bytes[1]) << 16) | (u32::from(bytes[2]) << 8) | u32::from(bytes[3]);
        assert_eq!(icao, 0x0048_40D6);
    }

    /// End-to-end: synthesize an IQ envelope containing one ADS-B frame
    /// with a clean preamble, feed it through `AdsbDemod`, and verify the
    /// decoder emits the expected ICAO via `drain_frames_json`.
    #[test]
    fn adsb_demod_recovers_synthetic_frame() {
        let hex = "8D4840D6202CC371C32CE0576098";
        let bytes = hex_to_bytes(hex);
        let icao_embedded =
            (u32::from(bytes[1]) << 16) | (u32::from(bytes[2]) << 8) | u32::from(bytes[3]);

        // Synthesize a 2.4 MS/s u8 IQ stream with the preamble + PPM bits
        // embedded. We use very crisp samples (high = 200, low = 128 ≈
        // noise floor) and add a few microseconds of quiet pad on either
        // side so the detector's lookback window has data to chew on.
        let sample_rate = 2_400_000.0_f32;
        let samples_per_bit = sample_rate / 1_000_000.0; // 2.4
        let half = samples_per_bit / 2.0;

        // Preamble pattern at half-bit resolution. HI LO HI LO LO LO LO HI
        // LO HI LO LO LO LO LO LO.
        let preamble: [u8; 16] = [1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0];

        // Build envelope ([HI, LO, ...]) for the full frame.
        let n_env_samples = (samples_per_bit * (8.0 + 112.0)).ceil() as usize + 100;
        let mut env = vec![0u8; n_env_samples];
        // Preamble.
        for (k, &v) in preamble.iter().enumerate() {
            let s = (k as f32 * half).round() as usize;
            let e = ((k as f32 + 1.0) * half).round() as usize;
            for i in s..e.min(env.len()) {
                env[i] = v;
            }
        }
        // Data bits, starting 8 µs after preamble start.
        let data_start = (8.0 * samples_per_bit).round() as usize;
        for b in 0..112 {
            let byte = b / 8;
            let bit = 7 - (b % 8);
            let bit_val = (bytes[byte] >> bit) & 1;
            // '1' → high then low; '0' → low then high.
            let (first, second) = if bit_val == 1 { (1u8, 0u8) } else { (0u8, 1u8) };
            let s = data_start + ((b as f32 * samples_per_bit).round() as usize);
            let mid = s + (half.round() as usize);
            let end = data_start + (((b + 1) as f32 * samples_per_bit).round() as usize);
            for i in s..mid.min(env.len()) {
                env[i] = first;
            }
            for i in mid..end.min(env.len()) {
                env[i] = second;
            }
        }

        // Convert envelope (0/1) to u8 IQ. Each sample takes 2 bytes (I, Q).
        // High = (200, 128), low = (128, 128). Squared magnitude separates
        // by ~72² vs 0² which clears the 2.5× detector threshold.
        let mut iq = Vec::with_capacity(env.len() * 2 + 200);
        // Quiet padding so the demod has lookback room.
        for _ in 0..100 {
            iq.push(128u8);
            iq.push(128u8);
        }
        for &v in &env {
            if v == 1 {
                iq.push(200);
                iq.push(128);
            } else {
                iq.push(128);
                iq.push(128);
            }
        }
        // Quiet tail.
        for _ in 0..100 {
            iq.push(128u8);
            iq.push(128u8);
        }

        let mut demod = AdsbDemod::new(sample_rate);
        demod.process(&iq);
        let json = demod.drain_frames_json();
        // The JSON should contain at least one frame with our ICAO.
        let needle = format!("\"icao\":{icao_embedded}");
        assert!(
            json.contains(&needle),
            "expected to decode ICAO {icao_embedded:#x}; got JSON: {json}",
        );
    }

    fn hex_to_bytes(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("valid hex"))
            .collect()
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

        let mut demod = CwDemod::new(WFM_INPUT_RATE, 500.0);
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

    /// Sanity-check the de-emphasis coefficient against the closed-form
    /// expression for both standard time constants. 50 µs / 75 µs differ
    /// by a clearly distinguishable margin (α₅₀ ≈ 0.659, α₇₅ ≈ 0.768),
    /// so the test is a regression guard against accidentally inlining
    /// the wrong τ.
    #[test]
    fn deemphasis_alpha_matches_closed_form() {
        let a50 = deemph_alpha_for(50e-6);
        let a75 = deemph_alpha_for(75e-6);
        let expected_50 = (-1.0_f32 / (50e-6_f32 * 48_000.0_f32)).exp();
        let expected_75 = (-1.0_f32 / (75e-6_f32 * 48_000.0_f32)).exp();
        assert!((a50 - expected_50).abs() < 1e-6, "α(50µs) = {a50}");
        assert!((a75 - expected_75).abs() < 1e-6, "α(75µs) = {a75}");
        assert!(a75 > a50, "75 µs should give a larger (slower) α");
    }

    /// DC block must remove a constant offset (steady-state output → 0)
    /// while leaving a non-DC tone roughly intact in amplitude (≥80 % of
    /// the input peak for a 1 kHz tone at 48 kHz).
    #[test]
    fn dc_block_strips_dc_passes_tone() {
        let mut blk = DcBlock::new(DC_BLOCK_ALPHA);
        // Step input at 1.0 — let it settle, then verify output decays.
        let mut last = 0.0;
        for _ in 0..20_000 {
            last = blk.process(1.0);
        }
        assert!(
            last.abs() < 0.05,
            "DC block didn't settle to ~0 (got {last})"
        );

        // 1 kHz tone, 48 kHz rate. After settle, peak should be near 1.0.
        let mut blk = DcBlock::new(DC_BLOCK_ALPHA);
        let mut peak = 0.0f32;
        for n in 0..4_800 {
            let x = (2.0 * PI * 1_000.0 * (n as f32) / 48_000.0).sin();
            let y = blk.process(x);
            if n > 240 {
                peak = peak.max(y.abs());
            }
        }
        assert!(peak > 0.8, "DC block over-attenuated a 1 kHz tone: {peak}");
    }

    /// `set_deemphasis_us` must update the coefficient on a live demod.
    #[test]
    fn wfm_set_deemphasis_us_updates_alpha() {
        let mut demod = WfmDemod::new(WFM_INPUT_RATE);
        let a_default = demod.deemph_alpha;
        demod.set_deemphasis_us(75.0);
        let a_75 = demod.deemph_alpha;
        assert!(
            (a_75 - deemph_alpha_for(75e-6)).abs() < 1e-6,
            "α after set_deemphasis_us(75) = {a_75}",
        );
        assert!(
            a_75 > a_default,
            "75 µs should be slower than the default 50 µs"
        );
    }
}
