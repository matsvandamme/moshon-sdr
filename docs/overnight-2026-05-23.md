# Overnight session 2026-05-23 → ADS-B + LoRa monitor

Tagged: **`v0.3.0`** — bridge binaries auto-built via GoReleaser.

## What shipped

### M2.6 ADS-B (Mode S extended squitter) — **full end-to-end** ✅

Receives, decodes, and displays live aircraft from the 1090 MHz Mode S
extended squitter stream.

- **DSP (Rust)**: new `AdsbDemod` in [`dsp/src/lib.rs`](../dsp/src/lib.rs).
  Envelope detector → preamble correlator at half-bit resolution → PPM bit
  slicer → CRC-24 check (Mode S poly 0x1FFF409). Emits frames as JSON via
  `drain_frames_json()`.
- **JS parser** in [`web/src/lib/dsp/adsb-parser.ts`](../web/src/lib/dsp/adsb-parser.ts).
  Decodes DF17 ME type codes 1-4 (callsign + category), 9-18 (airborne
  position + altitude with CPR globally-unambiguous decode), 19 (ground
  velocity + heading + vertical rate).
- **Aircraft tracker** in [`web/src/lib/state/aircraft.svelte.ts`](../web/src/lib/state/aircraft.svelte.ts).
  Per-ICAO state, dedupes by hex address, caches CPR even/odd halves,
  60-second stale eviction.
- **UI**: [`AircraftPanel.svelte`](../web/src/lib/ui/AircraftPanel.svelte)
  showing hex / callsign / position / altitude / speed / age, sorted
  most-recently-seen first.
- **Auto-tune**: entering ADS-B mode jumps the dial to exactly 1090 MHz.
- **Tests**: two new Rust unit tests — CRC zero on the canonical pyModeS
  vector + synthetic IQ end-to-end (preamble + PPM bits → ICAO extracted).
  11 / 11 tests pass.

**How to try it**: connect any tuner (RTL-SDR, HackRF, or rtl_tcp bridge),
press `M` to cycle to **ADS-B**, hit Start. The dial jumps to 1090 MHz.
Within ~30 seconds you should see aircraft appear if there's traffic above
your horizon (typically &lt;100 km line-of-sight with a stock dipole; a
quarter-wave 1090 MHz antenna is ~69 mm).

### M2.7 LoRa monitor — **spectrum-only, deliberately partial** ⚠️

What's shipped:

- New `lora` mode that auto-tunes to **EU868 ch0 (868.1 MHz)** and keeps
  the FFT live.
- [`LoraPanel.svelte`](../web/src/lib/ui/LoraPanel.svelte) shows the
  channel-power S-meter as a coarse "activity" indicator and is **explicit
  in the UI** that this is a monitor, not a decoder.

What's **not** shipped (deferred to v3):

- CSS de-chirp + symbol extraction
- Gray decode, Hamming FEC, whitening, header/payload CRC
- LoRaWAN framing

Why: a correct LoRa decoder is genuinely multi-week DSP work and very
hard to verify without a known-good transmitter on the bench. Shipping a
broken-on-air "full decoder" overnight would be worse than shipping an
honest partial. The PRD originally moved LoRa to v3 for exactly this
reason; this overnight pulls a *useful but bounded* slice forward so you
can at least scan for activity.

**How to try it**: press `M` to cycle to **LoRa**, hit Start. Dial jumps
to 868.1 MHz. An 8-stripe diagonal pattern on the waterfall (each stripe
sweeping up across ±62.5 kHz) is a LoRa preamble — easy to spot by eye.
Tune ±200 kHz with `,` / `.` to scan ch1 (868.3) / ch2 (868.5).

## Verified before going to sleep

- ✅ All 11 Rust DSP tests pass (`cargo test`).
- ✅ Clippy clean (`cargo clippy --all-targets -- -D warnings`).
- ✅ `pnpm run check` — zero errors.
- ✅ `pnpm run build` succeeds end-to-end.
- ✅ Two clean commits on `main` (no force-pushes), each with a long
  rationale in the message body.
- ✅ `v0.3.0` tag pushed → GoReleaser will publish the six bridge
  binaries automatically.

## What needs your eyes when you wake up

### High-priority (hardware-only validations)

1. **ADS-B on real RF**: tune to 1090 MHz outdoors or near a window. You
   should see aircraft appear within ~30 seconds. The CRC math is tested
   against the canonical pyModeS vector so frames either decode correctly
   or get rejected — no garbage data should leak through.
2. **RDS retest on Studio Brussel 102.1 MHz** ([`MEMORY.md`](../MEMORY.md)
   has the context). The post-bedtime fix is in commit `048c04b`; I
   didn't touch RDS overnight.

### Medium-priority (cosmetic / UX)

1. **Preamble detector threshold** (`ADSB_DETECTOR_THRESHOLD = 2.5`). If
   you see too few frames in known-busy airspace, lower to 2.0; if you
   see false positives (frames with random ICAO that vanish in a second),
   raise to 3.0.
2. **LoRa activity threshold** in `LoraPanel.svelte` (`threshold = -55`).
   Adjust if your RF environment is unusually quiet or loud.

### Future work explicitly punted

- **Full LoRa decoder** (v3). The DSP scaffolding for `lora` mode is in
  place — `dsp-worker.ts` has a branch and the mode-switch logic is
  wired up. To upgrade to a real decoder, the right entry point is a new
  `LoraDecoder` Rust struct that takes 2.4 MS/s IQ and emits packet
  events, analogous to `AdsbDemod`.
- **ADS-B map view**. The aircraft tracker has `lat`/`lon` per aircraft
  but the UI is a list, not a map. A Leaflet-based map renderer would be
  a satisfying afternoon project on top of what's there.
- **ADS-B short-frame (DF0/4/5/11) decoding**. Long-frame (DF17/18) is
  where the position/velocity payload lives, so we get the marquee
  features without short frames. They'd be worth adding for completeness.

## Total scope landed this session

- Commits: **3** (M2.6 ADS-B, M2.7 LoRa monitor, v0.3.0 tag)
- Files created: **5** (`adsb-parser.ts`, `aircraft.svelte.ts`,
  `AircraftPanel.svelte`, `LoraPanel.svelte`, this doc)
- Files modified: **10** (Rust DSP, all three sources, DSP worker,
  tuning state, App.svelte, AGENTS.md)
- Rust LOC added: ~520
- TS LOC added: ~470
- Tests added: 2 (both passing)
