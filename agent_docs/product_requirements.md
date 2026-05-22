# Product Requirements (compressed)

Full PRD: [docs/PRD-Moshon-SDR-MVP.md](../docs/PRD-Moshon-SDR-MVP.md).
Tech mapping: [docs/TechDesign-Moshon-SDR-MVP.md](../docs/TechDesign-Moshon-SDR-MVP.md) §4.

This is the agent's quick reference.

## v1 (M1) — must-have

| ID | Feature | Milestone |
|---|---|---|
| M1.1 | RTL-SDR Blog v3/v4 WebUSB driver — config sample rate (240k–3.2M), tune, gain, bias-T, direct sampling Q for HF on v4 | B3 |
| M1.2 | DSP pipeline: RustFFT, window (Hann default), Worker thread, AudioWorklet at 48 kHz | B4 |
| M1.3 | Demods: WFM (mono+stereo, RDS-ready hook), NFM (5/8/12.5/25 kHz), AM (4/6/9/10 kHz), USB/LSB (1.8/2.4/2.7/3.0 kHz), all with selectable filter widths | B6 |
| M1.4 | Spectrum + Canvas 2D waterfall with 3 color presets, configurable dB range, 5/30/120-second history. **≥30 fps at 2.4 MS/s + 2048-bin FFT.** | B4 |
| M1.5 | Keyboard tuning: `F` freq entry, `M` mode, `B` BW, `, .` step, `[ ]` step-size, `Space` mute, `G` gain, `?` hotkey modal | B5 |
| M1.6 | Mouse tuning: click waterfall to set center, drag to pan, scroll-wheel fine-tune, virtual VFO dial | B5 |
| M1.7 | Memory channels — up to 100 named, persisted in localStorage, JSON import/export | B7 |
| M1.8 | IARU band overlays (Region 1 default; 2/3 switchable in settings) | B7 |
| M1.9 | URL-shareable state — hash codec for freq/mode/bw/sr/gain (≤120 chars target) | B7 |
| M1.10 | S-meter — dBFS + calibrated S-units, per-device offset, peak hold with decay | B7 |
| M1.11 | First-run onboarding — per-OS WebUSB setup (Windows/Zadig, Linux/udev, macOS/none) | B8 |
| M1.12 | Network input — `rtl_tcp` via WebSocket bridge URL; tuning commands routed back over the same WS | B9 |
| M1.13 | Bridge daemon — Go single binary, 6-platform release matrix, `--listen` / `--rtltcp` / `--cors-origin` flags | B9 |

## v1 (M2) — should-have

- HackRF One driver
- ADS-B mode (`/adsb` route, 2 MS/s PPM decode, basic map)
- RDS decode for WFM
- Audio + IQ recording
- CW filter + decoder
- Mobile-responsive audit on Android Chrome

## v2 (M3) — could-have

- `sdr-server` protocol
- OpenWebRX as a network source
- WebGPU waterfall
- Plugin API for community decoders
- Airspy HF+ Discovery
- POCSAG / FLEX pager decode
- Multi-VFO
- Public live demo at `moshon-sdr.app`

## Won't have (v1)

| Excluded | Why |
|---|---|
| SDRplay | Closed binary driver, no browser path |
| LoRa | No mature browser CSS demod; multi-week DSP work |
| Transmit | Out of scope + regulatory complexity |
| Multi-user hosted receivers | We're a client, not a host |
| Native packaging (Electron/Tauri) | Defeats the "no install" pitch |

## User stories (full text in PRD §4)

- **US-1** — Plug in RTL-SDR, hit URL, hear 7.074 USB in 30 seconds (B3+B6+B8)
- **US-2** — Tune attic-Pi `rtl_tcp` from kitchen phone (B9)
- **US-3** — Copy URL, paste in Discord, recipient lands on same signal (B7)
- **US-4** — Contest-speed hotkey tuning, no mouse needed (B5)
- **US-5** — Casual user click-drags waterfall (B5)
- **US-6** — Memory channels + ham band overlays (B7)
- **US-7** — S-meter readout in S-units (B7)

## Success criteria (must all be true for `v0.1.0`)

| ID | Criterion |
|---|---|
| S1 | Author reaches for Moshon SDR over SDR++ for 5 consecutive ham sessions |
| S2 | SSB on 20m: intelligible + <10 Hz tuning precision (A/B vs. SDR++) |
| S3 | Remote Pi → phone-on-other-network: live demo recording |
| S4 | URL-share link round-trip lands on same signal in <1 s |
| S5 | 30 fps waterfall at 2.4 MS/s + 2048-bin FFT on author's daily-driver laptop |

## Non-functional requirements

| | |
|---|---|
| Performance | <250 ms USB→audio latency; <11 ms per 1024-sample block; <500 KB gzipped JS+WASM main bundle |
| Browsers | Chromium 91+; WebUSB-gated features hidden in Firefox/Safari |
| Hosting | Cloudflare Pages with COOP/COEP |
| Accessibility | WCAG AA contrast; keyboard navigable; SR-friendly hotkey modal |
| i18n | English only v1 |
| Security | No backend, no PII, no telemetry; URL hash never carries source IP |
| License | MIT throughout; no AGPL anywhere |
