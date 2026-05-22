/**
 * CW (morse) decoder — listens to the audio output of `CwDemod` and emits
 * ASCII text.
 *
 * Pipeline per 48 kHz sample:
 *   1. Rolling RMS over a ~5 ms window → envelope.
 *   2. Leaky-peak / leaky-floor tracking gives an adaptive threshold.
 *   3. Threshold-crossing edges define key-down / key-up durations.
 *   4. Compare durations against a running dit-length estimate to classify
 *      each key-down as `.` or `-`, and each key-up as intra-letter / inter-
 *      letter / inter-word silence.
 *   5. On letter or word boundaries, look up the accumulated dot-dash
 *      pattern in MORSE and emit the character (or `?` if unknown).
 *
 * The decoder is JS-side because the audio is already at 48 kHz and the
 * cost is trivial — a few multiplies per sample. Living outside the WASM
 * boundary also means we can iterate the heuristics without rebuilding.
 */

/** Map of morse pattern → ASCII. Standard ITU morse plus a handful of
 *  punctuation hams actually use. Unknown patterns return null. */
const MORSE: Record<string, string> = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
  '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
  '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
  '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
  '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
  '--..': 'Z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
  '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
  '.-.-.-': '.', '--..--': ',', '..--..': '?', '-..-.': '/',
  '-.-.--': '!', '-...-': '=', '.-.-.': '+', '-....-': '-',
  '...-..-': '$', '.--.-.': '@', '...-.-': '<SK>', '-.-.-': '<KA>',
  '-.--.': '(', '-.--.-': ')',
};

const AUDIO_RATE = 48_000;
const RMS_WINDOW_SAMPLES = 240; // 5 ms
/** Initial dit length guess: 15 WPM → 80 ms. Dit adjusts to incoming signal. */
const INITIAL_DIT_MS = 80;
/** Clamp range so a stuck key or static doesn't corrupt the WPM estimate. */
const DIT_MS_MIN = 30; // ~40 WPM upper bound
const DIT_MS_MAX = 240; // ~5 WPM lower bound
/** Smoothing for the leaky envelope trackers. */
const PEAK_DECAY = 0.9995;
const FLOOR_GROW = 1.0005;
const FLOOR_ADD = 1e-7;
/** Maximum letter-pattern length we'll consider before giving up. */
const MAX_PATTERN_LEN = 8;
/** Flush a pending letter (emit it) when off-time exceeds this many dits. */
const LETTER_GAP_DITS = 2.5;
/** Emit a space when off-time exceeds this many dits. */
const WORD_GAP_DITS = 5.0;
/** Dit vs dah threshold (in multiples of the estimated dit length). */
const DIT_DAH_THRESHOLD_DITS = 2.0;

export class CwDecoder {
  private rmsAcc = 0;
  private rmsCount = 0;
  private peakRms = 0.01;
  private floorRms = 0.001;
  /** 'on' = key-down (tone present), 'off' = silence. */
  private state: 'on' | 'off' = 'off';
  /** How many envelope windows we've spent in the current state. */
  private windowsInState = 0;
  /** Whether we've flushed the pending letter for the current off-run. */
  private letterEmittedThisGap = false;
  private ditMs = INITIAL_DIT_MS;
  private pattern = '';

  /**
   * Feed a batch of audio samples (mono — caller picks the channel). Returns
   * the text decoded by this batch. May be empty.
   */
  process(audio: Float32Array): string {
    let out = '';
    for (let i = 0; i < audio.length; i++) {
      const s = audio[i];
      this.rmsAcc += s * s;
      this.rmsCount++;
      if (this.rmsCount < RMS_WINDOW_SAMPLES) continue;

      const rms = Math.sqrt(this.rmsAcc / this.rmsCount);
      this.rmsAcc = 0;
      this.rmsCount = 0;

      // Track signal envelope with separate decay rates for peak / floor.
      this.peakRms = Math.max(rms, this.peakRms * PEAK_DECAY);
      this.floorRms = Math.min(rms, this.floorRms * FLOOR_GROW + FLOOR_ADD);
      // Bail if the envelope hasn't separated yet — keeps us from latching
      // onto noise before any key-down has happened.
      const separation = this.peakRms - this.floorRms;
      if (separation < 0.005) {
        this.windowsInState++;
        continue;
      }
      const threshold = this.floorRms + separation * 0.4;
      const isOn = rms > threshold;

      // State transition?
      if (isOn !== (this.state === 'on')) {
        const durationMs =
          (this.windowsInState * RMS_WINDOW_SAMPLES * 1000) / AUDIO_RATE;
        if (this.state === 'on') {
          // End of a tone — classify as dit or dah.
          const isDit = durationMs < this.ditMs * DIT_DAH_THRESHOLD_DITS;
          if (isDit) {
            this.pattern += '.';
            // Use confirmed dits to refine the dit-length estimate.
            this.ditMs = clamp(
              this.ditMs * 0.85 + durationMs * 0.15,
              DIT_MS_MIN,
              DIT_MS_MAX,
            );
          } else {
            this.pattern += '-';
          }
        }
        this.state = isOn ? 'on' : 'off';
        this.windowsInState = 0;
        this.letterEmittedThisGap = false;
      } else {
        this.windowsInState++;
      }

      // Decide whether the current off-run has ended a letter or word.
      if (this.state === 'off') {
        const offMs =
          (this.windowsInState * RMS_WINDOW_SAMPLES * 1000) / AUDIO_RATE;
        if (!this.letterEmittedThisGap && offMs >= this.ditMs * LETTER_GAP_DITS) {
          if (this.pattern.length > 0) {
            out += MORSE[this.pattern] ?? '?';
            this.pattern = '';
          }
          this.letterEmittedThisGap = true;
        }
        if (
          this.letterEmittedThisGap &&
          offMs >= this.ditMs * WORD_GAP_DITS
        ) {
          // Only emit one space per gap — bump the flag again-state next on.
          if (!out.endsWith(' ')) out += ' ';
        }
      }

      // Drop runaway pattern (long static run pretending to be one letter).
      if (this.pattern.length > MAX_PATTERN_LEN) {
        this.pattern = '';
      }
    }
    return out;
  }

  /** Current estimated dit length in milliseconds — exposed for telemetry. */
  get currentDitMs(): number {
    return this.ditMs;
  }

  /** Estimated words per minute. PARIS = 50 dit-units → WPM = 1200 / ditMs. */
  get currentWpm(): number {
    return 1200 / this.ditMs;
  }

  reset(): void {
    this.rmsAcc = 0;
    this.rmsCount = 0;
    this.peakRms = 0.01;
    this.floorRms = 0.001;
    this.state = 'off';
    this.windowsInState = 0;
    this.letterEmittedThisGap = false;
    this.ditMs = INITIAL_DIT_MS;
    this.pattern = '';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
