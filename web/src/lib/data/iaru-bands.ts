/**
 * IARU Region 1 amateur radio band plan (the user is in Belgium → R1).
 *
 * Coverage focuses on the bands that an RTL-SDR R820T2 / R828D can actually
 * receive (no HF below 24 MHz for the standard R820T2 without direct-sampling
 * mod). Frequencies in Hz.
 *
 * Source: IARU Region 1 HF/VHF/UHF band plan. Some segments are
 * simplified — for the spectrum overlay we only need rough boundaries and
 * a mode hint.
 */

import type { Mode } from '../state/tuning.svelte';

export type IaruBand = {
  /** Lower edge (Hz). */
  low: number;
  /** Upper edge (Hz). */
  high: number;
  /** Display label. */
  label: string;
  /** Suggested demod when tuning into this band. */
  suggestedMode: Mode;
};

export const IARU_R1_BANDS: IaruBand[] = [
  // HF bands the RTL-SDR can only reach with the v3/v4 direct-sampling
  // path. Included so the overlay still works if/when that's wired up.
  { low: 1_810_000, high: 2_000_000, label: '160 m', suggestedMode: 'lsb' },
  { low: 3_500_000, high: 3_800_000, label: '80 m', suggestedMode: 'lsb' },
  { low: 7_000_000, high: 7_200_000, label: '40 m', suggestedMode: 'lsb' },
  { low: 10_100_000, high: 10_150_000, label: '30 m', suggestedMode: 'cw' },
  { low: 14_000_000, high: 14_350_000, label: '20 m', suggestedMode: 'usb' },
  { low: 18_068_000, high: 18_168_000, label: '17 m', suggestedMode: 'usb' },
  { low: 21_000_000, high: 21_450_000, label: '15 m', suggestedMode: 'usb' },
  { low: 24_890_000, high: 24_990_000, label: '12 m', suggestedMode: 'usb' },
  { low: 28_000_000, high: 29_700_000, label: '10 m', suggestedMode: 'usb' },

  // VHF / UHF — directly reachable by R820T2.
  { low: 50_000_000, high: 52_000_000, label: '6 m', suggestedMode: 'usb' },
  { low: 70_000_000, high: 70_500_000, label: '4 m', suggestedMode: 'usb' }, // R1-only allocation in some countries
  { low: 144_000_000, high: 146_000_000, label: '2 m', suggestedMode: 'nfm' },
  { low: 430_000_000, high: 440_000_000, label: '70 cm', suggestedMode: 'nfm' },
  { low: 1_240_000_000, high: 1_300_000_000, label: '23 cm', suggestedMode: 'nfm' },

  // Other interesting non-amateur ranges that hams listen to a lot.
  { low: 87_500_000, high: 108_000_000, label: 'FM broadcast', suggestedMode: 'wfm' },
  { low: 108_000_000, high: 137_000_000, label: 'Aircraft AM', suggestedMode: 'am' },
  { low: 156_000_000, high: 162_000_000, label: 'Marine VHF', suggestedMode: 'nfm' },
];

/**
 * Return the bands that overlap the visible spectrum window
 * `[centerHz − sampleRate/2, centerHz + sampleRate/2]`.
 */
export function bandsInWindow(centerHz: number, sampleRate: number): IaruBand[] {
  const lo = centerHz - sampleRate / 2;
  const hi = centerHz + sampleRate / 2;
  return IARU_R1_BANDS.filter((b) => b.high >= lo && b.low <= hi);
}
