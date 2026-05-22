/**
 * ADS-B Mode S extended squitter parser. Consumes raw 14-byte frames
 * (DF17/18 long form, CRC-verified Rust-side) and extracts the fields
 * that matter for a flight-tracker UI: callsign, altitude, position,
 * heading, ground speed.
 *
 * References:
 *   - ICAO Annex 10 Vol IV (Mode S spec)
 *   - https://mode-s.org/decode/content/ads-b/ (the readable companion)
 *   - dump1090 source for cross-check
 *
 * We do CPR (Compact Position Reporting) globally-unambiguous decoding
 * when we have a paired even+odd frame within a 10-second window.
 */

export type AdsbRawFrame = {
  /** Hex-encoded 14-byte frame as decoded by the Rust DSP. */
  raw: string;
  /** Downlink format. 17 = ADS-B; 18 = TIS-B / non-transponder. */
  df: number;
  /** 24-bit ICAO aircraft address. */
  icao: number;
  /** Worker-local sample index — used for CPR pairing window. */
  t: number;
};

export type AdsbMessage =
  | { kind: 'identification'; icao: number; callsign: string; category: number }
  | {
      kind: 'airborne_position';
      icao: number;
      altitudeFt: number | null;
      cprFmt: 0 | 1; // 0 = even, 1 = odd
      cprLat: number;
      cprLon: number;
      t: number;
    }
  | {
      kind: 'velocity';
      icao: number;
      groundSpeedKts: number | null;
      trackDeg: number | null;
      verticalRateFpm: number | null;
    }
  | { kind: 'other'; icao: number; typeCode: number };

const CHARSET =
  '#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

/** Get bit `pos` (1-indexed, MSB-first) from a Mode S byte array. */
function getBit(bytes: Uint8Array, pos: number): number {
  const p = pos - 1;
  return (bytes[p >> 3] >> (7 - (p & 7))) & 1;
}

/** Read an n-bit unsigned integer starting at bit `pos` (1-indexed). */
function getBits(bytes: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = (v << 1) | getBit(bytes, pos + i);
  return v;
}

export function parseFrame(f: AdsbRawFrame): AdsbMessage {
  const bytes = hexToBytes(f.raw);
  // ME field is bits 33-88 (8 bits TC + 51 bits payload, total 56 bits =
  // 7 bytes). TC is the top 5 bits of byte 4 (zero-indexed).
  const tc = bytes[4] >> 3;

  if (tc >= 1 && tc <= 4) {
    return parseIdentification(bytes, f.icao, tc);
  }
  if (tc >= 9 && tc <= 18) {
    return parseAirbornePosition(bytes, f.icao, tc, f.t);
  }
  if (tc === 19) {
    return parseVelocity(bytes, f.icao);
  }
  return { kind: 'other', icao: f.icao, typeCode: tc };
}

function parseIdentification(
  bytes: Uint8Array,
  icao: number,
  tc: number,
): AdsbMessage {
  // ME starts at bit 33. TC = 5 bits, CAT = 3 bits, then 8 × 6-bit chars.
  // Bit positions: callsign starts at bit 41.
  const category = getBits(bytes, 38, 3);
  let callsign = '';
  for (let i = 0; i < 8; i++) {
    const c = getBits(bytes, 41 + i * 6, 6);
    callsign += CHARSET[c] ?? '#';
  }
  return {
    kind: 'identification',
    icao,
    callsign: callsign.replace(/[#_]/g, '').trim(),
    category,
  };
}

function parseAirbornePosition(
  bytes: Uint8Array,
  icao: number,
  tc: number,
  t: number,
): AdsbMessage {
  // Bit positions inside the 56-bit ME:
  //   33-37  TC
  //   38-39  Surveillance status
  //   40     Single antenna flag
  //   41-52  Altitude (12 bits)
  //   53     Time flag
  //   54     CPR format (0 even / 1 odd)
  //   55-71  Encoded latitude (17 bits)
  //   72-88  Encoded longitude (17 bits)
  const altRaw = getBits(bytes, 41, 12);
  const cprFmt = getBit(bytes, 54) as 0 | 1;
  const cprLat = getBits(bytes, 55, 17);
  const cprLon = getBits(bytes, 72, 17);
  const altitudeFt = decodeAltitude(altRaw, tc);
  return {
    kind: 'airborne_position',
    icao,
    altitudeFt,
    cprFmt,
    cprLat,
    cprLon,
    t,
  };
}

/** Type codes 9-18 use the Q-bit altitude encoding (TC 20-22 use GNSS,
 *  not supported in v1). */
function decodeAltitude(alt12: number, tc: number): number | null {
  if (tc < 9 || tc > 18) return null;
  const qBit = (alt12 >> 4) & 1;
  if (qBit === 1) {
    // Q=1: lower 11 bits give altitude in 25-ft increments minus 1000 ft.
    const n = ((alt12 & 0xfe0) >> 1) | (alt12 & 0x0f);
    return n * 25 - 1000;
  }
  // Q=0: gillham code, used above 50_000 ft. Skip for v1.
  return null;
}

function parseVelocity(bytes: Uint8Array, icao: number): AdsbMessage {
  // Subtype 1/2 = airspeed (ground/airspeed difference); we handle subtype
  // 1 (ground velocity, EW/NS components).
  const subtype = getBits(bytes, 38, 3);
  if (subtype !== 1 && subtype !== 2) {
    return { kind: 'velocity', icao, groundSpeedKts: null, trackDeg: null, verticalRateFpm: null };
  }
  // 39 = intent change flag, 40 = reserved, 41 = NUCr, 42 = NACv flag...
  // Velocity payload at bits 46-65 (10 bits each for EW and NS).
  const ewSign = getBit(bytes, 46);
  const ewVel = getBits(bytes, 47, 10);
  const nsSign = getBit(bytes, 57);
  const nsVel = getBits(bytes, 58, 10);
  if (ewVel === 0 && nsVel === 0) {
    return { kind: 'velocity', icao, groundSpeedKts: null, trackDeg: null, verticalRateFpm: null };
  }
  // Subtype 2 has a 4× speed multiplier for supersonic aircraft.
  const speedMul = subtype === 2 ? 4 : 1;
  const vEw = (ewSign ? -1 : 1) * (ewVel - 1) * speedMul;
  const vNs = (nsSign ? -1 : 1) * (nsVel - 1) * speedMul;
  const groundSpeedKts = Math.round(Math.sqrt(vEw * vEw + vNs * vNs));
  let trackDeg = (Math.atan2(vEw, vNs) * 180) / Math.PI;
  if (trackDeg < 0) trackDeg += 360;
  // Vertical rate at bits 69-77.
  const vrSign = getBit(bytes, 69);
  const vrRaw = getBits(bytes, 70, 9);
  const verticalRateFpm =
    vrRaw === 0 ? null : (vrSign ? -1 : 1) * (vrRaw - 1) * 64;
  return {
    kind: 'velocity',
    icao,
    groundSpeedKts,
    trackDeg: Math.round(trackDeg),
    verticalRateFpm,
  };
}

// ─── CPR position decoding ──────────────────────────────────────────────
//
// Globally-unambiguous CPR needs a paired even+odd frame. We cache the
// latest even and odd CPR records per aircraft; when both are present and
// the time delta is small enough, we solve for the (lat, lon) globally.

const D_LAT_EVEN = 360 / 60;
const D_LAT_ODD = 360 / 59;
/** Maximum sample-index delta between paired even/odd frames. At 2.4 MS/s
 *  → 24 million samples ≈ 10 seconds. */
const CPR_PAIR_MAX_SAMPLES = 24_000_000;

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

function nl(lat: number): number {
  // Number-of-longitudes lookup per ICAO Annex 10. The closed-form is
  // exact and dump1090 uses it directly.
  if (lat < 0) lat = -lat;
  if (lat === 0) return 59;
  if (lat === 87) return 2;
  if (lat > 87) return 1;
  const NZ = 15;
  const a =
    1 -
    Math.cos(Math.PI / (2 * NZ));
  const b = Math.cos((Math.PI * lat) / 180) ** 2;
  return Math.floor((2 * Math.PI) / Math.acos(1 - a / b));
}

export type CprFix = { lat: number; lon: number };

export function decodeCpr(
  even: { cprLat: number; cprLon: number; t: number },
  odd: { cprLat: number; cprLon: number; t: number },
): CprFix | null {
  if (Math.abs(even.t - odd.t) > CPR_PAIR_MAX_SAMPLES) return null;

  const lat0 = even.cprLat / 131072;
  const lat1 = odd.cprLat / 131072;
  const j = Math.floor(59 * lat0 - 60 * lat1 + 0.5);

  let latEven = D_LAT_EVEN * (mod(j, 60) + lat0);
  let latOdd = D_LAT_ODD * (mod(j, 59) + lat1);
  if (latEven >= 270) latEven -= 360;
  if (latOdd >= 270) latOdd -= 360;

  // Pick the latitude from whichever was the most recent frame; both
  // even-bound and odd-bound formulas should agree on NL but we verify.
  const useEven = even.t >= odd.t;
  const lat = useEven ? latEven : latOdd;
  const nlEven = nl(latEven);
  const nlOdd = nl(latOdd);
  if (nlEven !== nlOdd) return null; // NL mismatch — ambiguous, wait

  const ni = useEven ? Math.max(1, nlEven) : Math.max(1, nlEven - 1);
  const dLon = 360 / ni;
  const lon0 = even.cprLon / 131072;
  const lon1 = odd.cprLon / 131072;
  const m = Math.floor(lon0 * (nlEven - 1) - lon1 * nlEven + 0.5);
  let lon = dLon * (mod(m, ni) + (useEven ? lon0 : lon1));
  if (lon >= 180) lon -= 360;
  return { lat, lon };
}
