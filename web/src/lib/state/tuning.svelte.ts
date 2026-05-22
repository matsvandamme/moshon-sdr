/**
 * Reactive tuning state, format helpers, and mode tables.
 *
 * The receiver's runtime knobs (center freq, mode, bandwidth, step, gain,
 * mute) live in a single Svelte 5 `$state`-backed store exported as
 * `tuning`. UI components read and mutate it directly; the App.svelte
 * effect chain propagates changes to the USB worker via RtlSdrSource.
 */

// ────────────────────────────────────────────────────────────────────────
// Mode table
// ────────────────────────────────────────────────────────────────────────

export const MODES = ['wfm', 'nfm', 'am', 'usb', 'lsb', 'cw', 'adsb'] as const;
export type Mode = (typeof MODES)[number];

export type ModeInfo = {
  label: string;
  /** Available filter bandwidths in Hz; first entry is the default. */
  bandwidths: number[];
  /** Default tuning step size in Hz when entering this mode. */
  defaultStep: number;
};

export const MODE_INFO: Record<Mode, ModeInfo> = {
  wfm: { label: 'WFM', bandwidths: [200_000], defaultStep: 100_000 },
  nfm: { label: 'NFM', bandwidths: [12_500, 25_000, 8_000, 5_000], defaultStep: 12_500 },
  am: { label: 'AM', bandwidths: [9_000, 6_000, 4_000, 10_000], defaultStep: 9_000 },
  usb: { label: 'USB', bandwidths: [2_400, 1_800, 2_700, 3_000], defaultStep: 100 },
  lsb: { label: 'LSB', bandwidths: [2_400, 1_800, 2_700, 3_000], defaultStep: 100 },
  cw: { label: 'CW', bandwidths: [500, 200], defaultStep: 50 },
  adsb: { label: 'ADS-B', bandwidths: [2_400_000], defaultStep: 1_000_000 },
};

/** Tuning step sizes the user can cycle through with `[` / `]`. */
export const STEP_SIZES = [
  1, 10, 100, 1_000, 5_000, 10_000, 25_000, 100_000, 1_000_000,
] as const;

/** Gain steps to cycle through with `G`. `null` = AGC. */
export const GAIN_STEPS: Array<number | null> = [null, 0, 10, 20, 30, 40, 49];

// ────────────────────────────────────────────────────────────────────────
// Frequency parse / format
// ────────────────────────────────────────────────────────────────────────

/** Format a frequency in Hz with appropriate unit + 3 decimal places. */
export function formatHz(hz: number): string {
  if (!Number.isFinite(hz)) return '—';
  const abs = Math.abs(hz);
  if (abs >= 1e9) return `${(hz / 1e9).toFixed(3)} GHz`;
  if (abs >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (abs >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz} Hz`;
}

/** Format Hz as a 9-digit-style display (e.g. "100.000.000" for 1e8). */
export function formatHzDigits(hz: number): string {
  const i = Math.round(Math.abs(hz));
  const s = i.toString().padStart(9, '0');
  // group in 3s from the right
  return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}`;
}

/**
 * Parse a frequency string. Accepts things like:
 *   "100.5", "100.5M", "100.5 MHz", "144MHz", "14.230 USB", "7074000",
 *   "433.92e6", "144,000,000"
 * Default unit when no suffix: **MHz** (most common case for hams in this app).
 * Returns Hz, or null if the input can't be parsed.
 */
export function parseFrequency(input: string): number | null {
  if (typeof input !== 'string') return null;
  // Strip everything except digits, decimal, e, +/-, and unit letters.
  const stripped = input.replace(/[, _]/g, '').trim();
  if (stripped === '') return null;
  const re = /^([+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*([gmkh]?(?:hz)?)?/i;
  const m = stripped.match(re);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const suffix = (m[2] ?? '').toLowerCase();
  let multiplier = 1e6; // default = MHz
  if (suffix === '' && Math.abs(num) >= 1e5) {
    // Bare number that's large enough to be Hz on its own.
    multiplier = 1;
  } else if (suffix.startsWith('g')) {
    multiplier = 1e9;
  } else if (suffix.startsWith('m')) {
    multiplier = 1e6;
  } else if (suffix.startsWith('k')) {
    multiplier = 1e3;
  } else if (suffix === 'hz' || suffix === 'h') {
    multiplier = 1;
  }
  return Math.round(num * multiplier);
}

// ────────────────────────────────────────────────────────────────────────
// Tuning store
// ────────────────────────────────────────────────────────────────────────

function createTuning() {
  let centerFreq = $state(100_000_000);
  let mode = $state<Mode>('wfm');
  let bandwidth = $state(MODE_INFO.wfm.bandwidths[0]);
  let stepSize = $state(100_000);
  let gain = $state<number | null>(null);
  let muted = $state(false);

  return {
    get centerFreq() {
      return centerFreq;
    },
    set centerFreq(hz: number) {
      centerFreq = clampFreq(hz);
    },

    get mode() {
      return mode;
    },
    set mode(m: Mode) {
      mode = m;
      bandwidth = MODE_INFO[m].bandwidths[0];
      stepSize = MODE_INFO[m].defaultStep;
    },

    get bandwidth() {
      return bandwidth;
    },
    set bandwidth(bw: number) {
      bandwidth = bw;
    },

    get stepSize() {
      return stepSize;
    },
    set stepSize(step: number) {
      stepSize = step;
    },

    get gain() {
      return gain;
    },
    set gain(g: number | null) {
      gain = g;
    },

    get muted() {
      return muted;
    },
    set muted(m: boolean) {
      muted = m;
    },

    /** Step the frequency up by stepSize. */
    stepUp() {
      centerFreq = clampFreq(centerFreq + stepSize);
    },
    /** Step the frequency down by stepSize. */
    stepDown() {
      centerFreq = clampFreq(centerFreq - stepSize);
    },

    /** Cycle to the next mode in MODES order. */
    cycleMode() {
      const i = MODES.indexOf(mode);
      const next = MODES[(i + 1) % MODES.length];
      this.mode = next;
    },

    /** Cycle to the next bandwidth preset for the current mode. */
    cycleBandwidth() {
      const bws = MODE_INFO[mode].bandwidths;
      const i = bws.indexOf(bandwidth);
      const next = bws[(i + 1) % bws.length];
      bandwidth = next;
    },

    /** Cycle to the next step size (1, 10, 100, ..., 1 MHz). */
    cycleStepSize(direction: 1 | -1 = 1) {
      const i = STEP_SIZES.indexOf(stepSize as (typeof STEP_SIZES)[number]);
      const len = STEP_SIZES.length;
      const next = i === -1 ? 0 : (i + direction + len) % len;
      stepSize = STEP_SIZES[next];
    },

    /** Cycle to the next gain step (AGC → 0 → 10 → 20 → ... → AGC). */
    cycleGain() {
      const i = GAIN_STEPS.findIndex((g) => g === gain);
      const next = GAIN_STEPS[(i + 1) % GAIN_STEPS.length];
      gain = next;
    },

    toggleMute() {
      muted = !muted;
    },
  };
}

/** RTL-SDR R820T2 tunable range is roughly 24 MHz – 1766 MHz. We clamp to a
 * looser envelope so direct sampling mode (HF) can be wired later without
 * recompiling the bounds. */
const MIN_FREQ = 0;
const MAX_FREQ = 3_000_000_000;
function clampFreq(hz: number): number {
  if (!Number.isFinite(hz)) return 0;
  return Math.max(MIN_FREQ, Math.min(MAX_FREQ, Math.round(hz)));
}

export const tuning = createTuning();
export type Tuning = typeof tuning;
