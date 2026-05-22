/**
 * URL hash state — shareable links that encode tuning state.
 *
 * Format: `#f=145300000&m=nfm&bw=12500&g=AGC`
 *   f  — center frequency in Hz (integer)
 *   m  — mode (`wfm`/`nfm`/`am`/`usb`/`lsb`/`cw`)
 *   bw — bandwidth in Hz (integer)
 *   g  — gain: `AGC` for null, otherwise a decimal number
 *
 * Per [[no-bridge-in-hash]] in MEMORY.md: the bridge address NEVER goes
 * in the URL hash. Privacy: bridge URLs can leak LAN/WAN topology.
 */

import { MODES, type Mode } from './tuning.svelte';

export type HashState = {
  centerFreq?: number;
  mode?: Mode;
  bandwidth?: number;
  gain?: number | null;
};

export function encode(state: HashState): string {
  const parts: string[] = [];
  if (state.centerFreq !== undefined && Number.isFinite(state.centerFreq)) {
    parts.push(`f=${Math.round(state.centerFreq)}`);
  }
  if (state.mode !== undefined) {
    parts.push(`m=${state.mode}`);
  }
  if (state.bandwidth !== undefined && Number.isFinite(state.bandwidth)) {
    parts.push(`bw=${Math.round(state.bandwidth)}`);
  }
  if (state.gain !== undefined) {
    parts.push(`g=${state.gain === null ? 'AGC' : state.gain}`);
  }
  return parts.join('&');
}

export function decode(hash: string): HashState {
  const out: HashState = {};
  const stripped = hash.startsWith('#') ? hash.slice(1) : hash;
  if (stripped.length === 0) return out;
  for (const kv of stripped.split('&')) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    switch (k) {
      case 'f': {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out.centerFreq = n;
        break;
      }
      case 'm':
        if ((MODES as readonly string[]).includes(v)) {
          out.mode = v as Mode;
        }
        break;
      case 'bw': {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out.bandwidth = n;
        break;
      }
      case 'g':
        if (v === 'AGC' || v === '') {
          out.gain = null;
        } else {
          const n = Number(v);
          if (Number.isFinite(n)) out.gain = n;
        }
        break;
    }
  }
  return out;
}

export function writeHash(state: HashState): void {
  if (typeof window === 'undefined') return;
  const next = encode(state);
  const target = next.length === 0 ? '' : `#${next}`;
  // history.replaceState avoids polluting the back stack while the user
  // drags the dial.
  history.replaceState(null, '', `${location.pathname}${location.search}${target}`);
}

export function readHash(): HashState {
  if (typeof window === 'undefined') return {};
  return decode(location.hash);
}
