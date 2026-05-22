# Moshon SDR

> A ham's SDR receiver. In your browser. No install.

[![Live demo](https://img.shields.io/badge/demo-moshon--sdr.pages.dev-22c55e?style=flat-square)](https://moshon-sdr.pages.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

Moshon SDR is a browser-based Software-Defined Radio receiver built around
amateur-radio operating habits: precise SSB tuning, keyboard-first frequency
entry, memory channels, IARU band overlays, S-meter, and two equally
first-class input paths — **local USB dongle (WebUSB)** and **remote network
IQ (`rtl_tcp` over WebSocket bridge)**.

**Status:** Pre-alpha. The MVP (v0.1.0) is feature-complete; awaiting on-air
verification.

## Why another SDR receiver?

There are excellent native SDR receivers (SDR++, SDRangel, GQRX). There are
excellent browser-based receivers (WebSDR, OpenWebRX). Moshon SDR sits in a
slightly different spot:

- **Ham-first UX** — SSB precision, memory channels, band overlays are
  first-class, not afterthoughts.
- **Network IQ on day one** — your antenna lives in the attic, your dongle
  lives on a Pi, you tune from anywhere via a small bridge daemon.
- **URL-shareable receiver state** — paste a link, the recipient lands on
  the same signal.
- **MIT-licensed**, not AGPL.
- **Static site** — host it anywhere, runs offline once cached.

## Quick start

### Try the hosted version

Visit **https://moshon-sdr.pages.dev** in Chrome, Edge, or Brave.

- **Local USB dongle:** plug in an RTL-SDR (R820T2 / R828D), click *Connect*,
  pick the device. (Windows needs Zadig first — see below.)
- **Network IQ:** start `moshon-bridge` (below) and an `rtl_tcp` server, pick
  the *Network (rtl_tcp)* tab, enter the bridge URL, hit *Connect & Stream*.

### Hardware setup

| OS | WebUSB driver work | Notes |
|---|---|---|
| **Windows** | Run [Zadig](https://zadig.akeo.ie/) once: Options → List All Devices → select `Bulk-In, Interface (Interface 0)` → set target to `WinUSB` → Replace Driver. | Without this the page can't see the dongle. |
| **macOS** | Nothing — Chrome/Edge/Brave can open the dongle directly. | Safari has no WebUSB. |
| **Linux** | Blacklist the kernel DVB driver and add a udev rule. | See the in-app *Setup* dialog or [docs](#linux-setup). |

The in-app **Setup** button in the header re-opens the per-OS onboarding any
time.

### Linux setup

```bash
# 1. Stop the kernel DVB driver from claiming the dongle
echo 'blacklist dvb_usb_rtl28xxu' \
  | sudo tee /etc/modprobe.d/no-rtl.conf

# 2. Allow plugdev to open it via WebUSB
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", MODE="0660", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/20-rtlsdr.rules
sudo udevadm control --reload-rules

# 3. Make sure your user is in plugdev
sudo usermod -aG plugdev $USER  # log out + back in
```

## Network IQ — `moshon-bridge`

`moshon-bridge` is a single Go binary that proxies a local `rtl_tcp` server
through a WebSocket the browser can speak. It runs on **your** machine; we
don't host it.

```bash
# Download for your platform from GitHub Releases (bridge-v* tags),
# then in two terminals:

# Terminal 1 — your dongle's rtl_tcp server (any platform / install)
rtl_tcp -a 127.0.0.1

# Terminal 2 — the WebSocket bridge
./moshon-bridge --listen 127.0.0.1:9090

# In Moshon SDR, switch to the Network tab and use:
#   Bridge URL: http://127.0.0.1:9090
```

### Bridge flags

| Flag | Default | Use |
|---|---|---|
| `--listen` | `127.0.0.1:9090` | Where the bridge binds. Use `0.0.0.0:9090` to expose on the LAN. |
| `--rtltcp` | `127.0.0.1:1234` | Default upstream `rtl_tcp`. Can be overridden per-connection. |
| `--cors-origin` | Pages URL | Allowed `Origin` for WebSocket upgrades. Use `*` only on trusted LANs. |
| `--dial-timeout` | `5s` | Upstream TCP dial timeout. |
| `--version` | — | Print version + exit. |

### Pi setup (attic-dongle / shack scenario)

`moshon-bridge` ships pre-built for `linux/arm` and `linux/arm64` — drop the
binary on a Raspberry Pi, run it alongside `rtl_tcp`, point your phone or
laptop's browser at the Pi's IP.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `F` | Frequency entry (typed input, accepts `144.5M`, `7074000`, etc.) |
| `M` | Cycle mode (WFM → NFM → AM → USB → LSB → CW) |
| `B` | Cycle bandwidth preset for current mode |
| `G` | Cycle gain (AGC → 0 dB → 10 dB → … → AGC) |
| `,` / `.` | Tune down / up by one step |
| `[` / `]` | Cycle step size (1 Hz, 10 Hz, …, 1 MHz) |
| `Space` | Mute toggle |
| `?` | Show shortcut help |

Mouse: click anywhere on the spectrum or waterfall to tune there; scroll the
wheel for fine-tune at the current step size; click-drag the virtual VFO dial.

## Stack

| Layer | Tech |
|---|---|
| Web app | Svelte 5 + Vite + TypeScript + Tailwind 4 |
| DSP | Rust → WebAssembly via `wasm-pack`, RustFFT |
| Network bridge | Go single-binary `rtl_tcp` ↔ WebSocket proxy |
| Hosting | Cloudflare Pages (with COOP/COEP for `SharedArrayBuffer`) |
| License | MIT |

## Supported hardware

- **RTL-SDR Blog v3 / v4** (R820T2 / R828D tuners) — local via WebUSB
- **Any `rtl_tcp`-compatible source** — remote via the bridge

**Not supported in v0.1.0:**
- **SDRplay** — closed binary driver, no browser path. Not on the roadmap.
- **HackRF One** — planned for M2.
- **Airspy** — planned for M3.
- **Transmit** — out of scope. Moshon SDR is receive-only.
- **Nooelec Smartee XTR (E4000 tuner)** — the underlying driver
  ([`@jtarrio/webrtlsdr`](https://github.com/jtarrio/radioreceiver)) only
  supports R820/R828D/R860 tuners. Tracked as future work.

## Demodulation modes

WFM mono, Narrow FM, AM, USB, LSB (both via Weaver's method), CW (700 Hz
BFO with narrow channel filter). Stereo WFM + ADS-B + RDS land in M2.

## Browser requirements

- **Chromium-family** (Chrome, Edge, Brave) — required for the WebUSB path.
- **Firefox, Safari** — fine for the network-IQ path; the USB path is hidden.
- **`SharedArrayBuffer`** requires COOP/COEP headers; the Cloudflare Pages
  deploy serves them.

## Documentation

- [`docs/PRD-Moshon-SDR-MVP.md`](docs/PRD-Moshon-SDR-MVP.md) — Product
  Requirements
- [`docs/TechDesign-Moshon-SDR-MVP.md`](docs/TechDesign-Moshon-SDR-MVP.md) —
  Technical Design
- [`docs/research-moshon-sdr.md`](docs/research-moshon-sdr.md) — Market &
  feasibility research
- [`docs/DoD-v0.1.0.md`](docs/DoD-v0.1.0.md) — Definition of Done report for
  v0.1.0
- [`AGENTS.md`](AGENTS.md) — Master plan for AI coding agents
- [`agent_docs/`](agent_docs/) — Detailed specs (tech stack, code patterns,
  testing)

## Contributing

Issues and PRs welcome — but please read [AGENTS.md](AGENTS.md) first for the
roadmap, the "what NOT to do" rules (e.g. no AGPL code, no transmit), and the
performance budget.

## License

MIT — see [LICENSE](LICENSE).

This project bootstrapped from the
[vibe-coding-prompt-template](https://github.com/KhazP/vibe-coding-prompt-template)
workflow.
