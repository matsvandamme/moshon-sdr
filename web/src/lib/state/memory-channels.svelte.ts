/**
 * Memory channels — user-named saved tuning presets.
 *
 * Persisted in `localStorage` under MOSHON_CHANNELS_KEY. Schema-versioned
 * so future additions (e.g. squelch, gain mode) can migrate cleanly.
 */

import type { Mode } from './tuning.svelte';

const STORAGE_KEY = 'moshon.channels.v1';
const MAX_CHANNELS = 50;

export type Channel = {
  /** Stable id. Generated client-side; never reused. */
  id: string;
  /** User-given label. */
  name: string;
  /** Tuned frequency in Hz. */
  freq: number;
  mode: Mode;
  /** Channel filter bandwidth in Hz. */
  bandwidth: number;
};

type Persisted = {
  version: 1;
  channels: Channel[];
};

function loadPersisted(): Channel[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.channels)) {
      return [];
    }
    return parsed.channels.filter(isValidChannel);
  } catch {
    return [];
  }
}

function savePersisted(channels: Channel[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: Persisted = { version: 1, channels };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable (private mode, quota). Drop silently —
    // memory channels are nice-to-have, not load-bearing.
  }
}

function isValidChannel(c: unknown): c is Channel {
  if (!c || typeof c !== 'object') return false;
  const ch = c as Record<string, unknown>;
  return (
    typeof ch.id === 'string' &&
    typeof ch.name === 'string' &&
    typeof ch.freq === 'number' &&
    Number.isFinite(ch.freq) &&
    typeof ch.mode === 'string' &&
    typeof ch.bandwidth === 'number' &&
    Number.isFinite(ch.bandwidth)
  );
}

function makeId(): string {
  // Plain enough for collision-free local use; doesn't need to be a UUID.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createStore() {
  let channels = $state<Channel[]>(loadPersisted());

  return {
    get all(): readonly Channel[] {
      return channels;
    },

    add(input: Omit<Channel, 'id'>): Channel | null {
      if (channels.length >= MAX_CHANNELS) return null;
      const ch: Channel = { ...input, id: makeId() };
      channels = [...channels, ch];
      savePersisted(channels);
      return ch;
    },

    remove(id: string): void {
      const before = channels.length;
      channels = channels.filter((c) => c.id !== id);
      if (channels.length !== before) savePersisted(channels);
    },

    rename(id: string, name: string): void {
      let changed = false;
      channels = channels.map((c) => {
        if (c.id !== id) return c;
        changed = true;
        return { ...c, name };
      });
      if (changed) savePersisted(channels);
    },

    /** Wipe all stored channels. Intended for tests / settings reset. */
    clear(): void {
      channels = [];
      savePersisted(channels);
    },
  };
}

export const memoryChannels = createStore();
export type MemoryChannels = typeof memoryChannels;
