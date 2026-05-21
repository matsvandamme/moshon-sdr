# PRD — Moshon SDR (MVP)

> Browser-based SDR receiver, built for hams, ships as a static site.

- **Status:** Draft v1
- **Owner:** Matthieu Van Damme
- **Date:** 2026-05-22
- **Source research:** [research-moshon-sdr.md](research-moshon-sdr.md)
- **Target launch:** ~2026-08-15 (≈3 months part-time from start)

---

## 1. Product Overview

**Name:** Moshon SDR
**Tagline:** A ham's SDR receiver. In your browser. No install.
**One-line description:** Open-source browser-based SDR receiver optimized for amateur radio operators, with direct USB and remote-network inputs.

**Goal of MVP:** Become the author's daily driver for ham radio listening — replacing SDR++ for routine HF/VHF receive — and serve as a public OSS reference for browser-based SDR.

**License:** MIT.

---

## 2. Target Users

### Primary persona — "Active ham radio operator"

| | |
|---|---|
| **Who** | Licensed amateur (any class). Has at least one RTL-SDR Blog v3/v4 or HackRF One. May also operate from multiple physical locations (shack, attic, remote site). |
| **Current tools** | SDR++, SDRangel, GQRX, Quisk on Linux; SDR# on Windows. Possibly KiwiSDR or OpenWebRX server somewhere. |
| **Frustrations** | (a) Setting up SDR drivers on a new machine is annoying. (b) No clean "tune from anywhere" story unless they run a heavy OpenWebRX server. (c) Sharing a tuning state with another ham requires a screenshot or coordinates over chat. (d) Mobile listening is broken in every native app. |
| **Comfort** | High technical comfort. Comfortable installing a 1-binary helper daemon, editing a config file, reading a GitHub README. Will not tolerate broken SSB or imprecise tuning. |

### Secondary personas (not optimized for in v1)

- **SWL / broadcast hobbyist** — gets WFM/AM "for free" but isn't the design center.
- **Remote-only user** — covered by the network-IQ path, but isn't the primary persona until v2.

### Explicit non-users (v1)

- SDRplay owners (no driver path)
- Transmit operators
- Users without a Chromium-family browser

---

## 3. Problem Statement

Browser-based SDR receivers exist (BrowSDR, CyberRadio Blast, several single-purpose tools), but none of them are *for the active ham operator* who needs:

1. **Clean SSB on HF**, not just WFM-broadcast-as-a-demo.
2. **A working network input path** so they can tune from anywhere — not just on the machine the dongle is plugged into.
3. **Shareable tuning state** so they can send "tune here" links to other hams without screenshots.
4. **Both keyboard-first and mouse/dial tuning**, because ham operators have wildly different operating styles.

Moshon SDR is the receiver that respects all four of those needs at once, on a license (MIT) that doesn't restrict commercial reuse.

---

## 4. User Stories

| # | Story | Notes |
|---|---|---|
| **US-1** | As a ham, I want to plug in my RTL-SDR Blog v4, hit the website, and be receiving 7.074 MHz USB within 30 seconds, so I can casually listen to FT8 without booting my Linux box. | Includes WinUSB/Zadig onboarding for first-time Windows users (linked instructions, not in-app). |
| **US-2** | As a ham with a Pi + RTL-SDR in my attic running `rtl_tcp`, I want to enter the IP:port of my remote receiver and tune from my phone in the kitchen, so I'm not tethered to the shack. | Requires the bridge daemon running on the Pi (or on a router/NUC near it). |
| **US-3** | As a ham listening to an interesting net, I want to copy a URL that encodes my current freq/mode/bandwidth and paste it in a Discord chat, so the recipient opens it and lands on the same signal. | URL hash stores: freq, mode, bandwidth, sample rate, gain. Not source (privacy/security). |
| **US-4** | As a power user, I want hotkeys for frequency entry (`F`), mode cycling (`M`), bandwidth (`B`), step size (`,` / `.`), so I never need to leave the keyboard during a contest. | Hotkey reference accessible via `?` modal. |
| **US-5** | As a casual user, I want to click-drag the waterfall to tune and scroll-wheel to fine-tune, so I don't need to learn hotkeys. | Mouse-only path must reach feature parity with keyboard. |
| **US-6** | As a ham, I want to bookmark `145.500 MHz NFM` and `14.230 MHz USB` as memory channels, with optional ham band overlays on the spectrum (40m, 20m, 2m, 70cm shaded), so I navigate by band rather than absolute frequency. | Band plan: IARU Region 1 default; switchable Region 2/3 in settings. |
| **US-7** | As a ham with weak signals, I want an S-meter that reads in S-units with calibration for my dongle (RTL-SDR Blog v4 default offset), so signal reports are at least directionally accurate. | "Directionally accurate", not lab-grade. Document the calibration. |

---

## 5. MVP Features (MoSCoW)

### Must have (M1) — required for "Matthieu uses this instead of SDR++"

| ID | Feature | Acceptance criteria |
|---|---|---|
| **M1.1** | RTL-SDR Blog v3/v4 WebUSB driver | Detects, claims, configures sample rate (240k / 1.024M / 1.4M / 1.8M / 2.048M / 2.4M / 2.56M / 2.88M / 3.2M), sets center freq, gain (auto + 0–49.6 dB in tuner steps), bias-T toggle. Supports direct sampling Q-branch for HF on v4. |
| **M1.2** | DSP pipeline | RustFFT-backed FFT, configurable size (1024 / 2048 / 4096 / 8192), configurable window (Hann default + Hamming / Blackman-Harris). Channelizer + demod runs in a dedicated Web Worker. Audio out at 48 kHz via AudioWorklet. |
| **M1.3** | Demod modes | WFM (mono + stereo + RDS-ready hook, RDS itself can be M2), NFM (5/8/12.5/25 kHz filters), AM (4/6/9/10 kHz filters), USB, LSB (1.8/2.4/2.7/3.0 kHz filters). All modes user-selectable filter widths. |
| **M1.4** | Spectrum + Waterfall | Canvas 2D, configurable history (5 s / 30 s / 2 min), adjustable color map (3 presets), adjustable dB range. Min 30 fps on a mid-range laptop at 2048-bin FFT and 2.4 MS/s. |
| **M1.5** | Tuning controls — keyboard | `F` opens freq entry, `M` cycles mode, `B` cycles bandwidth presets, `,` / `.` step down/up, `[` / `]` change step size, `Space` mute, `G` cycles gain. All listed in a `?` hotkey modal. |
| **M1.6** | Tuning controls — mouse | Click on waterfall/spectrum sets center; drag pans; scroll-wheel fine-tunes; visible virtual VFO dial that can be click-dragged. Feature parity with keyboard. |
| **M1.7** | Memory channels | Up to 100 named entries with freq, mode, BW, optional gain. Persisted in localStorage. Import/export as JSON. |
| **M1.8** | Ham band overlays | Shaded regions on the spectrum and frequency display. IARU Region 1 default; settings toggle Region 2 / Region 3. |
| **M1.9** | URL-shareable state | URL hash encodes freq, mode, bandwidth, sample rate, gain. On load with hash, app restores state (after device selection). Hash updates as the user tunes (debounced). |
| **M1.10** | S-meter | dBFS readout + calibrated S-units (S0 = -127 dBm reference for HF, -147 dBm for VHF/UHF; offset adjustable per device). Peak hold, decay. |
| **M1.11** | First-run onboarding | If no SDR detected: explain WebUSB requirements (Chromium, HTTPS, OS driver setup) with platform-specific links (Windows → Zadig instructions; Linux → udev rules; macOS → no setup needed). |
| **M1.12** | Network input — rtl_tcp via bridge | Settings panel accepts `ws://host:port` for the bridge. App receives 8-bit IQ from rtl_tcp via WebSocket. Same demod pipeline. Tuning commands sent back over the same WebSocket. |
| **M1.13** | Bridge daemon | Single Go binary, `moshon-bridge` — listens on a configurable WebSocket port, forwards to a configurable rtl_tcp host:port. Released as static binaries for `darwin-amd64`, `darwin-arm64`, `linux-amd64`, `linux-arm64`, `linux-arm`, `windows-amd64`. Documented as "run on the same machine as your rtl_tcp server". |

### Should have (M2) — adds polish and reach but not blockers

| ID | Feature |
|---|---|
| **M2.1** | HackRF One WebUSB driver (single-channel RX only) |
| **M2.2** | ADS-B decode mode (1090 MHz, 2 MS/s, PPM decode → JSON message list + simple map overlay if data allows) |
| **M2.3** | RDS decode for WFM stereo (station name, song info) |
| **M2.4** | Audio recording to WAV (File System Access API where available, blob download elsewhere) |
| **M2.5** | IQ recording (short clips, capped at ~30 s to manage memory) |
| **M2.6** | CW filter + decoder (≥15 wpm) |
| **M2.7** | Mobile-responsive layout audit (already responsive by design, but explicit pass on Android Chrome) |

### Could have (M3) — explicit "not yet, but maybe"

| ID | Feature |
|---|---|
| **M3.1** | `sdr-server` protocol (open-source SpyServer alternative) |
| **M3.2** | OpenWebRX server as a network source |
| **M3.3** | WebGPU waterfall renderer for high-bin / long-history use |
| **M3.4** | Plugin API for community decoders |
| **M3.5** | Airspy HF+ Discovery WebUSB |
| **M3.6** | POCSAG / FLEX pager decode |
| **M3.7** | Multi-VFO (more than one active demod simultaneously) |
| **M3.8** | Live demo deployed at `moshon-sdr.app` (or similar) |

### Won't have (v1)

- SDRplay (RSP) — closed driver, no browser path
- LoRa decode — multi-week research project, no browser precedent
- Transmit — out of scope, regulatory hassle
- Multi-user serving — Moshon is a client, not a hosted-receiver service
- Native apps (Electron, Tauri) — defeats the "no install" pitch

---

## 6. Success Metrics

The success metric is **personal daily-driver adoption**, deliberately narrow. OSS popularity is a bonus, not a goal.

### Primary success criteria (must all be true at launch)

| # | Criterion | How measured |
|---|---|---|
| **S1** | The author reaches for Moshon SDR for 5 consecutive ham sessions without switching back to SDR++. | Self-reported in the project changelog. |
| **S2** | SSB on 20m is intelligible and tunable with `<10 Hz` precision. | Manual A/B with SDR++ on the same dongle and antenna. |
| **S3** | Network-IQ path works end-to-end from a remote Pi to a phone on another network. | Demo session recorded in `docs/`. |
| **S4** | URL-share link round-trip lands the recipient on the same signal within 1 second. | Manual test, two browsers. |
| **S5** | 30 fps waterfall at 2.4 MS/s + 2048-bin FFT on the author's daily-driver laptop. | Performance.now() instrumentation in dev mode. |

### Secondary (nice to have, not blocking launch)

- ≥25 GitHub stars (organic, no promotion)
- ≥1 external contributor PR merged
- A mention on [rtl-sdr.com](https://rtl-sdr.com) or [hackaday.com](https://hackaday.com)

### Anti-metrics (we are explicitly NOT chasing these)

- Hosted user count (no backend, can't measure, don't care)
- Feature count parity with SDR++ (we are a different shape)
- Mobile-app install equivalents

---

## 7. Design Direction

### Visual vibe

**Modern minimal**, Linear/Vercel-adjacent. Specifically:

- Dark theme default (`#0a0a0a` background, `#e5e5e5` text); optional light theme.
- Single accent color (proposal: a soft cyan `#7dd3fc` — feels "RF" without being garish). Adjustable.
- Geist Mono or JetBrains Mono for numerics (frequency, dB, time); Inter for prose UI.
- Generous spacing. The waterfall + spectrum is the hero; controls are subordinate.
- Sharp edges, 4 px corner radius max. No skeuomorphism (no analog dials, no fake brushed metal).
- Iconography: [Lucide](https://lucide.dev/) (already MIT, matches the aesthetic).

### Key screens

```
┌─────────────────────────────────────────────────────────────┐
│  Moshon SDR    [source: RTL-SDR v4 ▾]    [⏯]    [⚙]   [?]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│    SPECTRUM  (1/3 height)                                   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│    WATERFALL  (2/3 height)                                  │
│                                                             │
│       ░░▒▒▓▓ band overlay (20m) ▓▓▒▒░░                      │
│                                                             │
├──────────────────────────────────────────┬──────────────────┤
│ 14.230.000 USB  BW 2.4k  S7 -85 dBm      │  MEMORY          │
│                                          │  ▸ 7.074 USB     │
│  [F]req  [M]ode  [B]w  [G]ain   ⊙ dial   │  ▸ 14.230 USB    │
│                                          │  ▸ 145.500 NFM   │
└──────────────────────────────────────────┴──────────────────┘
```

Three screens total:

1. **Main receiver** (above) — single screen, no nav.
2. **First-run onboarding** — full-page wizard: pick "USB device" or "Network", per-OS driver setup links.
3. **Settings** — slide-out drawer: device prefs, ham band region, S-meter calibration, theme.

### Mobile responsive

Below 768 px wide:

- Waterfall takes most of the screen
- Bottom sheet for controls (drag up for memory, settings, freq entry)
- Hotkeys disabled on mobile (no kbd assumption)
- Touch-drag tuning, pinch to zoom span

---

## 8. Technical Considerations

> Full architecture goes in the Tech Design doc (next step). This section names hard requirements.

| Concern | Requirement |
|---|---|
| **Browser** | Chromium 91+ on desktop and Android. WebUSB-gated features hidden in Firefox/Safari (network IQ still works there). |
| **Hosting** | Cloudflare Pages with COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) for SharedArrayBuffer. |
| **HTTPS** | Required by WebUSB. Local development uses Vite's `--host` + a self-signed cert script, documented in README. |
| **Performance budget** | First contentful paint <1.5 s on cable. End-to-end USB→audio latency <250 ms. DSP worker CPU <40% on a 2020-class laptop at 2.4 MS/s. |
| **Bundle size** | <500 KB gzipped JS+WASM for the main path. Lazy-load HackRF and ADS-B modules. |
| **Accessibility** | Color contrast WCAG AA. Keyboard navigable. Screen reader: at minimum, frequency display and mode are announced on change. Hotkey modal is screen-reader friendly. |
| **Security** | No backend, no PII, no telemetry. URL hash never contains source IP for the network case. localStorage is the only persistence. |
| **i18n** | English-only for MVP. UI strings extracted so v2 can translate. |
| **Privacy** | No analytics in v1. If added in v2, must be self-hosted (Plausible/Umami) and disclosed. |

---

## 9. Risks

(See research doc §5 for full list — these are the PRD-visible subset.)

| Risk | Status | Owner action |
|---|---|---|
| BrowSDR is good enough → I never differentiate | Live | Ham-focus (SSB precision, memory channels, band overlays) + network input from day one |
| WebUSB latency causes SSB audio artifacts | Live | Big ring buffer, AudioWorklet thread, profile early |
| S-meter calibration is meaningless across dongles | Live | Document the limitation; ship sane defaults per device |
| URL-share link too long to share in chat | Low | Hash-encode minimally; <120 chars is the target |
| Author scope-creeps into LoRa/SDRplay | Real | This PRD says won't-have; tech-design says won't-have; do not relitigate |

---

## 10. Constraints

| | |
|---|---|
| **Timeline** | ≈3 months part-time, ~10–15 hrs/week → ~120–180 hrs total |
| **Budget** | $0 recurring. ~$15/yr optional domain. Hardware already owned. |
| **Team** | 1 developer (author), with AI coding assistant |
| **Stack constraints** | Must be Chromium-compatible browser tech; must be a static site; must be open source under MIT |
| **Compliance** | Receive-only — no transmit regulations. No GDPR (no PII collection). No COPPA (no kids' data) |

---

## 11. Definition of Done (launch checklist)

- [ ] All M1 features pass acceptance criteria
- [ ] Author has used Moshon SDR for 5 consecutive ham sessions (S1)
- [ ] SSB intelligibility A/B confirmed against SDR++ (S2)
- [ ] Network-IQ end-to-end demo recorded (S3)
- [ ] URL-share round-trip verified (S4)
- [ ] 30 fps waterfall benchmark passes on author's machine (S5)
- [ ] Bridge daemon binaries released for all 6 platforms
- [ ] README covers: WebUSB requirements per OS, bridge daemon setup, hotkey reference, FAQ on SDRplay
- [ ] License is MIT, `LICENSE` file present
- [ ] Repository public on GitHub
- [ ] Deployed to Cloudflare Pages with verified COOP/COEP headers
- [ ] Mobile responsive sanity-check on real Android Chrome
- [ ] Lighthouse: Performance ≥90, Accessibility ≥95

---

## 12. Out of scope for v1 (be firm)

- **SDRplay** — closed driver, no path. Honest README explanation.
- **LoRa decode** — research project on its own.
- **Transmit** — separate regulatory + safety scope.
- **Multi-user serving** — we're a client, not a host.
- **Multi-VFO** — single demod chain in v1.
- **AGPL parts** — must not lift code from BrowSDR or other AGPL projects.
- **Native packaging** — Electron/Tauri defeats the pitch.
- **Server-side anything** — bridge daemon excepted, and it runs on the user's machine.
