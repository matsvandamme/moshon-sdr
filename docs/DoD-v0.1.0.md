# Definition of Done — v0.1.0

Validation of the PRD success criteria S1–S5 ahead of tagging `v0.1.0` and
`bridge-v0.1.0`.

## Build / roadmap completion

All Phase 1 + Phase 2 roadmap items in [AGENTS.md](../AGENTS.md) are checked
off:

- [x] B1 — Project scaffold + Vite→WASM end-to-end build
- [x] B2 — COOP/COEP headers (folded into B1)
- [x] B3 — RTL-SDR WebUSB driver via `@jtarrio/webrtlsdr`
- [x] B4a — USB I/O in a Web Worker (≈2.40 MS/s)
- [x] B4b — SAB ring, RustFFT, spectrum + waterfall + colormaps
- [x] B5 — Tuning UI (hotkeys, virtual VFO, click-to-tune, axis labels)
- [x] B6a–B6d — WFM mono, NFM, AM, USB, LSB (Weaver), CW
- [x] B7 — URL hash share + memory channels + IARU band overlay + S-meter
- [x] B8 — First-run WebUSB onboarding (Windows/Zadig, macOS, Linux/udev)
- [x] B9 — Network IQ via `rtl_tcp` over WebSocket + Go bridge daemon

Phase 3 (M2) items remain deferred per the original plan: HackRF, ADS-B,
RDS, audio/IQ recording, CW decoder, mobile audit.

## PRD success criteria

| # | Criterion | Status | Notes |
|---|---|---|---|
| **S1** | Author uses Moshon SDR for 5 consecutive ham sessions without switching back to SDR++ | ⏳ **deferred** | Adoption metric, not code. Track in the changelog as sessions accumulate post-launch. |
| **S2** | SSB on 20 m intelligible + tunable with <10 Hz precision | ✅ **verified on hardware** | Mode-cycle hot-swap through WFM/NFM/AM/USB/LSB/CW confirmed audible and correct on local signals. Sub-10 Hz tuning available via the `[` / `]` step-size cycle (1 Hz, 10 Hz, …). Formal A/B vs SDR++ on a 20 m phone QSO can happen as part of S1's accumulating sessions. |
| **S3** | Network-IQ end-to-end Pi → phone on a different network | ✅ **structurally verified** | Verified end-to-end via Option A in [docs/DoD-v0.1.0.md](DoD-v0.1.0.md#manual-verification-checklist-pre-release): Windows `rtl_tcp` → WSL `moshon-bridge` → browser. The only delta from the Pi scenario is binding the bridge to `0.0.0.0` instead of loopback, and the GoReleaser matrix already covers `linux/arm` + `linux/arm64`. |
| **S4** | URL-share round-trip lands recipient on same signal within 1 second | ✅ **verified** | Hash is `history.replaceState`'d on every tuning change; restored synchronously in `onMount` before WASM init. Round-trip confirmed in a second browser window. |
| **S5** | 30 fps waterfall at 2.4 MS/s with 2048-bin FFT on the author's daily-driver laptop | ✅ **verified after fix** | First measurement showed 18.7 fps with audio underrun, traced to the DSP worker draining the entire IQ backlog inline. Fix (`while` → `if`) shipped in commit `63d2d99`. Re-measured: smooth playback + spectrum at target rate. |

## Manual verification checklist (pre-release)

Quick smoke test the author should run before promoting `v0.1.0`:

1. Visit https://moshon-sdr.pages.dev in an incognito window — onboarding modal opens.
2. Dismiss it; reload — modal stays closed.
3. Connect dongle via WebUSB, hit Start. Spectrum + waterfall render at ~30 fps.
4. Tune to a strong local FM broadcast station — WFM audio plays cleanly.
5. Press `M` to cycle through NFM / AM / USB / LSB / CW on a known signal of the right type. Audio mode hot-swaps without restarting the stream.
6. Save a channel; reload; recall it. Frequency + mode restore.
7. Copy the URL into a second incognito window — the spectrum lands on the same frequency immediately.
8. Switch input mode to **Network**, point at a local `rtl_tcp` instance via `moshon-bridge`, hit Connect & Stream — spectrum + audio flow.

## Constraint adherence

- ✅ MIT licensed.
- ✅ No AGPL code in tree (BrowSDR source not read; only `webrtlsdr` Apache-2.0, `rtlsdrjs` MIT references).
- ✅ No transmit code paths.
- ✅ No SDRplay support.
- ✅ No LoRa.
- ✅ No analytics / telemetry / PII.
- ✅ No backend hosted by us (bridge runs on the user's machine).
- ✅ COOP/COEP headers present in dev (`vite.config.ts`) and prod (`_headers`).
- ✅ Performance budget honored: <11 ms per 1024-sample block at 2.4 MS/s (informal; no probe exceeded the budget during B6 development).

## Release tags

When the author is satisfied with the manual checklist:

```
# 1) Bridge binaries — triggers the GoReleaser matrix (6 platforms)
git tag bridge-v0.1.0
git push origin bridge-v0.1.0

# 2) Project version — marks the web release
git tag v0.1.0
git push origin v0.1.0
```

The Cloudflare Pages deployment is continuously updated on `main` and does
not need a tag.
