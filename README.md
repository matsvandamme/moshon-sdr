# Moshon SDR

> A ham's SDR receiver. In your browser. No install.

Moshon SDR is a browser-based Software-Defined Radio receiver built around
amateur-radio operating habits: precise SSB tuning, keyboard-first frequency
entry, memory channels, IARU band overlays, calibrated S-meter, and two
equally first-class input paths — **local USB dongle (WebUSB)** and **remote
network IQ (`rtl_tcp` over WebSocket bridge)**.

**Status:** Pre-alpha. Repository is being scaffolded.

## Why another SDR receiver?

There are excellent native SDR receivers (SDR++, SDRangel, GQRX). There are
excellent browser-based receivers ([BrowSDR](https://github.com/jLynx/BrowSDR),
WebSDR, OpenWebRX). Moshon SDR sits in a slightly different spot:

- **Ham-first UX** — SSB precision, memory channels, band overlays are first
  class, not afterthoughts.
- **Network-IQ on day one** — your antenna lives in the attic, your dongle
  lives on a Pi, you tune from anywhere via a small bridge daemon.
- **URL-shareable receiver state** — paste a link, the recipient lands on the
  same signal.
- **MIT-licensed**, not AGPL.
- **Static site** — host it anywhere, run it offline once cached.

## Stack

| Layer | Tech |
|---|---|
| Web app | Svelte 5 + Vite + TypeScript + Tailwind 4 |
| DSP | Rust → WebAssembly via `wasm-pack`, RustFFT |
| Network bridge | Go single-binary `rtl_tcp` ↔ WebSocket proxy |
| Hosting | Cloudflare Pages (with COOP/COEP for `SharedArrayBuffer`) |
| License | MIT |

## Supported hardware (planned for v1)

- **RTL-SDR Blog v3 / v4** (RTL2832U) — local via WebUSB
- **HackRF One** — local via WebUSB (M2)
- **Any** `rtl_tcp`-compatible source — remote via WebSocket bridge

**Not supported in v1:** SDRplay (closed driver), Airspy (planned M3),
transmit (out of scope).

## Demodulation modes (planned for v1)

WFM (mono+stereo), Narrow FM, AM, USB, LSB, CW. ADS-B as a separate mode in M2.

## Browser requirements

- Chromium-family browser (Chrome, Edge, Brave) for full features. WebUSB is
  Chromium-only.
- Firefox and Safari work for the network-IQ path; USB features are hidden.
- On Windows, RTL-SDR dongles need [Zadig](https://zadig.akeo.ie/) for the
  WinUSB driver — see in-app onboarding.

## Running it

Coming soon. Once we have a first build, this section will cover:

- The hosted version on Cloudflare Pages
- How to install the `moshon-bridge` daemon for network IQ
- Per-OS WebUSB setup

## Documentation

- [`docs/PRD-Moshon-SDR-MVP.md`](docs/PRD-Moshon-SDR-MVP.md) — Product Requirements
- [`docs/TechDesign-Moshon-SDR-MVP.md`](docs/TechDesign-Moshon-SDR-MVP.md) — Technical Design
- [`docs/research-moshon-sdr.md`](docs/research-moshon-sdr.md) — Market & feasibility research
- [`AGENTS.md`](AGENTS.md) — Master plan for AI coding agents
- [`agent_docs/`](agent_docs/) — Detailed specs (tech stack, code patterns, testing)

## Contributing

Once it's actually running, contributions will be welcome. For now, the
project is in the scaffolding phase. See [AGENTS.md](AGENTS.md) for the
roadmap.

## License

MIT — see [LICENSE](LICENSE).

This project bootstrapped from the
[vibe-coding-prompt-template](https://github.com/KhazP/vibe-coding-prompt-template)
workflow. Thanks to that project for the structure.
