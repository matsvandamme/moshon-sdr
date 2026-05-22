/**
 * Aircraft tracker — merges incoming parsed ADS-B messages per ICAO and
 * exposes a reactive list for the UI. Tracks last-seen time per aircraft
 * and drops stale entries (no DF17 in the last 60 s).
 */

import { parseFrame, decodeCpr, type AdsbRawFrame } from '../dsp/adsb-parser';

export type Aircraft = {
  icao: number;
  hex: string;
  callsign?: string;
  altitudeFt?: number;
  groundSpeedKts?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  lat?: number;
  lon?: number;
  /** Sample-index of the most recent message. Used for stale eviction. */
  lastSeenT: number;
  /** Wall-clock at last update (ms). */
  lastSeenWall: number;
  /** Cached half of the CPR pair (the other half completes a fix). */
  cprEven?: { cprLat: number; cprLon: number; t: number };
  cprOdd?: { cprLat: number; cprLon: number; t: number };
};

/** Drop aircraft idle for longer than this many wall-ms. */
const STALE_MS = 60_000;

function createAircraftTracker() {
  let aircraft = $state(new Map<number, Aircraft>());

  function upsert(icao: number, t: number): Aircraft {
    const existing = aircraft.get(icao);
    if (existing) {
      existing.lastSeenT = t;
      existing.lastSeenWall = Date.now();
      return existing;
    }
    const fresh: Aircraft = {
      icao,
      hex: icao.toString(16).toUpperCase().padStart(6, '0'),
      lastSeenT: t,
      lastSeenWall: Date.now(),
    };
    aircraft.set(icao, fresh);
    return fresh;
  }

  function ingest(frame: AdsbRawFrame): void {
    const msg = parseFrame(frame);
    const a = upsert(frame.icao, frame.t);
    switch (msg.kind) {
      case 'identification':
        if (msg.callsign.length > 0) a.callsign = msg.callsign;
        break;
      case 'velocity':
        if (msg.groundSpeedKts !== null) a.groundSpeedKts = msg.groundSpeedKts;
        if (msg.trackDeg !== null) a.trackDeg = msg.trackDeg;
        if (msg.verticalRateFpm !== null) a.verticalRateFpm = msg.verticalRateFpm;
        break;
      case 'airborne_position': {
        if (msg.altitudeFt !== null) a.altitudeFt = msg.altitudeFt;
        if (msg.cprFmt === 0) {
          a.cprEven = { cprLat: msg.cprLat, cprLon: msg.cprLon, t: msg.t };
        } else {
          a.cprOdd = { cprLat: msg.cprLat, cprLon: msg.cprLon, t: msg.t };
        }
        // Try CPR fix if we have both halves.
        if (a.cprEven && a.cprOdd) {
          const fix = decodeCpr(a.cprEven, a.cprOdd);
          if (fix) {
            a.lat = fix.lat;
            a.lon = fix.lon;
          }
        }
        break;
      }
      case 'other':
        break;
    }
    // Re-set in the map to nudge Svelte's reactivity.
    aircraft.set(frame.icao, a);
  }

  function evictStale(): void {
    const cutoff = Date.now() - STALE_MS;
    let changed = false;
    for (const [icao, a] of aircraft) {
      if (a.lastSeenWall < cutoff) {
        aircraft.delete(icao);
        changed = true;
      }
    }
    if (changed) {
      // Force Svelte to notice — re-assign reference.
      // eslint-disable-next-line no-self-assign
      aircraft = aircraft;
    }
  }

  function clear(): void {
    aircraft = new Map();
  }

  return {
    get all(): Aircraft[] {
      // Most-recently-seen first.
      return [...aircraft.values()].sort((a, b) => b.lastSeenT - a.lastSeenT);
    },
    get count(): number {
      return aircraft.size;
    },
    ingest,
    evictStale,
    clear,
  };
}

export const aircraftTracker = createAircraftTracker();
export type AircraftTracker = typeof aircraftTracker;
