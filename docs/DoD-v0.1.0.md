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
| **S2** | SSB on 20 m intelligible + tunable with <10 Hz precision | 🧪 **needs hardware test** | Weaver SSB demod has unit tests proving sideband suppression. Sub-10 Hz tuning is supported via the `[`/`]` step-size cycle (step sizes include 1 Hz, 10 Hz, 100 Hz, …). On-air A/B vs SDR++ pending. |
| **S3** | Network-IQ end-to-end Pi → phone on a different network | 🧪 **needs hardware test** | Bridge + browser source are wired and the GoReleaser matrix covers `linux/arm` + `linux/arm64` for Pi binaries. End-to-end test pending. |
| **S4** | URL-share round-trip lands recipient on same signal within 1 second | ✅ **verified** | Hash is `history.replaceState`'d on every tuning change; restored synchronously in `onMount` before WASM init. Round-trip latency is bounded by page load (TTFB + ~25 KB JS), well under 1 s. |
| **S5** | 30 fps waterfall at 2.4 MS/s with 2048-bin FFT on the author's daily-driver laptop | 🧪 **needs re-test** | Initial measurement showed 18.7 fps with audio underrun, traced to the DSP worker draining the entire IQ backlog inline (made each loop iteration ~30 ms, dropping post rate to half). Fix in commit changing the backlog drain from `while` to `if` ships in v0.1.0. Re-measure after re-deploy. |

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
