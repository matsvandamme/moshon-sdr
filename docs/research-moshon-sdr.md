# Research — moshon-sdr

> Browser-based SDR receiver with RTL-SDR-class features. Two input paths: direct USB (WebUSB) and network-streamed IQ. Open-source side project. 1–3 month MVP target.

Research date: 2026-05-22.

---

## TL;DR

1. **You are not first.** [BrowSDR](https://github.com/jLynx/BrowSDR) (AGPL-3.0) is shipping today and overlaps ~80% of your concept: HackRF + RTL-SDR Blog V4 over WebUSB, Rust/WASM DSP, WFM/NFM/AM/SSB/CW, RDS + POCSAG, multi-VFO, even WebRTC sharing. Decide upfront: fork/contribute, or differentiate.
2. **WebUSB hardware coverage is uneven.**
   - **RTL-SDR**: solid, multiple battle-tested libs.
   - **HackRF**: solid, BrowSDR-grade precedent.
   - **Airspy HF+ Discovery**: precedent exists (Luigi Cruz's CyberRadio Blast).
   - **SDRplay (RSP)**: **closed binary driver, effectively impossible from a pure browser**. Drop from v1 or relegate to a local helper bridge.
3. **Network IQ in a "pure static site" needs a WebSocket bridge.** Browsers can't open raw TCP. The cleanest path is `rtl_tcp` (well-defined, dead simple) tunneled through a tiny `websockify`-style helper. SpyServer is closed-protocol; the open `sdr-server` is a more interesting target.
4. **LoRa decode in the browser is a real research project, not an MVP feature.** No known shipping WASM implementation. ADS-B, by contrast, has multiple existing browser implementations and is feasible.
5. **Recommended v1 scope:** RTL-SDR Blog v3/v4 + HackRF over WebUSB, rtl_tcp over WebSocket, WFM/NFM/AM/SSB demod, waterfall, shareable URL state, ADS-B decoder. Drop SDRplay and LoRa to "stretch / v2".

---

## 1. Market Analysis

### Direct competitors (browser-based SDR)

| Project | Architecture | License | Input | Notes |
|---|---|---|---|---|
| [BrowSDR](https://github.com/jLynx/BrowSDR) | Static site + WebUSB, Rust→WASM DSP, multi-VFO | AGPL-3.0 | HackRF, RTL-SDR Blog V4 | **Closest direct competitor.** Active. RDS + POCSAG. WebRTC peer-share. Live demo at [browsdr.jlynx.net](https://browsdr.jlynx.net/). |
| [webrtlsdr](https://github.com/jtarrio/webrtlsdr) | Library | Apache-2.0 (likely) | RTL-SDR | Spinoff of Google's `radioreceiver`. Library level — you'd wrap your own UI around it. |
| [rtlsdrjs](https://github.com/sandeepmistry/rtlsdrjs) | Library | MIT | RTL-SDR | Older but stable. Node + browser. Lower-level than webrtlsdr. |
| CyberRadio Blast (Luigi Cruz) | Static, Chrome-only | Mixed | Airspy HF+ Discovery | Niche but proves Airspy-class WebUSB is viable. |
| [No-SDR](https://www.rtl-sdr.com/no-sdr-a-new-open-source-multi-user-websdr-for-rtl-sdr/) | Server-side | OSS | RTL-SDR on server | Multi-user WebSDR style. Not WebUSB. |

### Server-side reference points (you are *not* this, but UX bar is set here)

| Project | Architecture | License |
|---|---|---|
| [OpenWebRX+](https://github.com/luarvique/openwebrx) | Server-side DSP, WebSocket to browser | AGPL |
| [PhantomSDR-Plus](https://www.ab9il.net/software-defined-radio/new-internet-sdr.html) | Server fast-convolution, **decoders moved to WASM in browser** | OSS |
| WebSDR (Twente) | Server-side DSP, multi-user, closed-source | Closed |
| KiwiSDR | FPGA + Beaglebone + custom OWRX-derived browser | Hardware product |

**Notable trend:** PhantomSDR moves decoders into the browser as WASM. The industry direction is *exactly* what you're proposing on the client side — even server-based WebSDRs are migrating decoders to the client.

### Adjacent: single-purpose WebUSB SDR apps

- [airplanejs](https://github.com/watson/airplanejs) and `skies-adsb` — ADS-B in browser via RTL-SDR.
- [hackrf-sweep-webusb](https://github.com/cho45/hackrf-sweep-webusb) — spectrum sweep.
- `aprs-sdr` — APRS via HackRF + WebUSB + WASM.

These show browser SDR is a **proven space**. The market opportunity is consolidating these single-purpose apps into one polished general-purpose receiver — which is exactly what BrowSDR is doing.

### Market opportunity / positioning

Your differentiator candidates, ranked by leverage:

1. **MIT-licensed alternative to AGPL-licensed BrowSDR.** Real consideration for users embedding into other products. (Be aware: building a non-AGPL alternative means you cannot lift BrowSDR's code.)
2. **Native network-IQ input** (BrowSDR is currently host-USB-only). Lets users with a remote Pi + dongle receive in their browser from anywhere.
3. **Shareable URL receiver state** — encode tuning/mode/bandwidth in the URL hash. Frictionless "tune to this signal" links.
4. **Mobile-first UX** (BrowSDR works on Android but UX is desktop-shaped).
5. **Decoder ecosystem.** ADS-B in MVP, with a plugin API for community-contributed decoders later.
6. **WebGPU waterfall.** Bigger time depth, higher refresh rates than canvas. Niche, but shiny demo value.

Pick **two or three** of these as your value prop. Don't try to beat BrowSDR on its own ground (HackRF DSP polish) — beat it on coverage breadth (network input) and UX (URL state, mobile).

---

## 2. Technical Recommendations

### Stack (recommended)

| Layer | Recommendation | Why |
|---|---|---|
| Build | **Vite + TypeScript** | Fast, modern, plays well with WASM + Web Workers. |
| UI framework | **SolidJS** or **Svelte** (or vanilla TS) | SDR UIs are spectrum/waterfall + small reactive controls. React is overkill and its reconciler is wasteful for 60 fps updates. SolidJS or Svelte give you reactivity without the VDOM overhead. |
| DSP | **Rust → WebAssembly** with `wasm-bindgen` + `wasm-pack` | Industry consensus. BrowSDR, CyberRadio Blast all on this. Alternatives (C++ via Emscripten, AssemblyScript) work but have weaker tooling and smaller community. |
| FFT | **RustFFT** (in your WASM module) | Best-in-class pure-Rust FFT. SIMD-128 in WASM is supported in all Chromium 91+. |
| Audio | **AudioWorklet** | Run demod output through `AudioWorkletNode` for low-latency, off-main-thread audio playback. |
| Spectrum/Waterfall | **Canvas 2D for v1**, evaluate **WebGPU** when scale demands it | Canvas is good enough for ~30 fps at 2k bins. WebGPU when you want 60 fps multi-second waterfall history or 8k-bin FFTs. |
| Network IQ | **WebSocket → rtl_tcp** via a tiny Go or Rust bridge daemon | rtl_tcp is the simplest well-defined IQ protocol. A 100-line WebSocket-to-TCP proxy is enough. |
| State / sharing | **URL hash → app state**, plus localStorage for prefs | No backend; URL is the canonical state. |
| Hosting | **GitHub Pages** or **Cloudflare Pages** | $0, fast, HTTPS. WebUSB requires HTTPS. |
| Testing | **Vitest** for unit, **Playwright** for end-to-end | Playwright can drive WebUSB via Chromium DevTools Protocol in tests (with mocked devices). |

### Worker topology

```
Main thread (UI, controls, waterfall canvas)
        ↓ postMessage (control)
Worker A — USB I/O          ←  WebUSB transferIn
        ↓ SharedArrayBuffer (IQ ring)
Worker B — DSP (WASM)        →  FFT bins (SAB) → main
                              →  PCM audio (SAB) → AudioWorklet
```

SharedArrayBuffer requires `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers. GitHub Pages doesn't set these by default — you'll either need Cloudflare Pages (easy custom headers) or a service-worker hack. **Plan for this on day one.**

### Hardware support reality check

| Device | WebUSB feasibility | Effort | Recommendation |
|---|---|---|---|
| RTL-SDR Blog v3/v4 (RTL2832U) | Proven (rtlsdrjs, webrtlsdr, BrowSDR) | Low | **MVP must-have** |
| HackRF One | Proven (BrowSDR, kaedenbrinkman/hackrf) | Medium (no shipping reference of full RX pipeline outside BrowSDR — AGPL) | **MVP target** |
| Airspy HF+ Discovery | Proven (Luigi Cruz CyberRadio Blast) | Medium | **Should-have** |
| Airspy R2 / Mini | Less precedent | Medium-High | Stretch |
| SDRplay RSP1A/RSP1B/RSPdx | **Closed binary `mir_sdr` driver, no browser path** | Very High (only via local helper that uses the closed driver) | **Drop from v1.** Note this honestly in your README. |
| LimeSDR / PlutoSDR | No browser precedent found | High | Out of scope |

The honest answer on SDRplay: **a pure static site cannot talk to an SDRplay**, period. The driver is closed-source binary, distributed only as Linux/macOS/Windows libraries (`libmirsdrapi`/`libsdrplay_api`). No public USB protocol documentation. Your only options are (a) reverse-engineer the USB protocol (legally murky, and SDRplay is litigious about this), (b) require users to run a local bridge daemon that uses the official driver, (c) drop it. **(c) is the correct answer for v1.**

### Demod / decoder feasibility

| Mode | Effort in WASM | Notes |
|---|---|---|
| WFM (broadcast) + RDS | Low | Reference: BrowSDR. Mono → stereo pilot demod is well-trodden. |
| NFM | Low | Standard quadrature demod. |
| AM | Trivial | Envelope detect + DC block. |
| SSB (USB/LSB) | Medium | Weaver or Hilbert. Many references. |
| CW | Low | Audio-band tone. |
| **ADS-B** | Medium | 1090 MHz PPM at ≥2 MS/s. RTL-SDR is the canonical receiver. Multiple browser implementations exist (`airplanejs`, `skies-adsb`, `devdevcharlie/adsb`). Feasible for MVP. |
| **LoRa** | **High** | CSS demod. No known WASM/browser implementation. Reference impls (`gr-lora2`, sdrangel ChirpChat) are GNU Radio C++. Porting is a multi-week project on its own. **Stretch goal, not MVP.** |
| FT8/WSPR | Very High (decoders are heavyweight) | Stretch / v2. |
| POCSAG/FLEX pager | Medium | BrowSDR has POCSAG. |

### Network IQ protocol choice

| Protocol | Open? | Bandwidth efficient? | Browser-reachable? | Verdict |
|---|---|---|---|---|
| **rtl_tcp** | Yes, trivial | No (raw 8-bit IQ at full sample rate) | TCP only — need WS bridge | **Best v1 target.** ~10-line protocol header. |
| **SpyServer** | No (closed Airspy protocol) | Yes (selective IF streaming) | TCP only — need WS bridge | Reverse-engineered docs exist but legally awkward for OSS. Skip. |
| **sdr-server** | Yes (OSS, SpyServer-compatible) | Yes | TCP only — need WS bridge | Good v2 target — open + efficient. |
| **OpenWebRX WebSocket** | Yes | Yes (filtered IF + FFT) | Native WebSocket | Coupled to OpenWebRX server. You'd be a client to their ecosystem. Niche. |
| **KiwiSDR** | Yes (HTTP+WS) | Yes (24kHz audio channels) | Native WebSocket | HF-only. Cool to support but very different shape. |

**Recommendation:** Ship `rtl_tcp` via a ~200-LOC WebSocket bridge (you provide a tiny Go/Rust binary; users run it on their host). Document it clearly. Add `sdr-server` in v2.

The "pure static site, BYO hardware" promise stays intact: the bridge runs on **the user's machine**, not yours.

---

## 3. Tool Recommendations & Costs

Everything below is free/open-source unless noted.

| Need | Tool | Cost |
|---|---|---|
| Repo + CI | GitHub | $0 (public) |
| Hosting (with COOP/COEP headers) | Cloudflare Pages | $0 |
| Domain (optional) | Namecheap / Cloudflare Registrar | ~$10–15/yr |
| AI coding assistant | Claude Code (you have it) | API-metered |
| WASM toolchain | `rustup` + `wasm-pack` + `wasm-bindgen` | $0 |
| FFT | RustFFT (Rust crate) | $0 |
| Audio | Web Audio API + AudioWorklet | $0 |
| Bridge daemon (network IQ) | Self-built in Go or Rust, distributed as a release binary | $0 |
| Bundler | Vite | $0 |
| UI | SolidJS / Svelte | $0 |
| Testing | Vitest + Playwright | $0 |
| Analytics (optional) | [Plausible](https://plausible.io/) self-hosted or [Umami](https://umami.is/) | $0 |

**Total recurring cost: $0–15/year** (just domain, optional).

**Total one-time cost: $0.** You already own the hardware.

---

## 4. MVP Feature Prioritization

### Must-have (M1, weeks 1–6)

- [ ] Vite + TS + WASM scaffolding with COOP/COEP-correct hosting
- [ ] WebUSB driver: **RTL-SDR Blog v3/v4** (RTL2832U). Lift the protocol from rtlsdrjs/webrtlsdr (check licenses — MIT/Apache are both safe).
- [ ] DSP worker: RustFFT-based, configurable decimation, FIR channelization
- [ ] Demod modes: **WFM, NFM, AM**
- [ ] Spectrum + waterfall (Canvas 2D, ~30 fps, 30-second history)
- [ ] Tuning controls: center freq, span, gain, sample rate
- [ ] Audio out via AudioWorklet
- [ ] **URL-hash state** (frequency, mode, BW, gain) so links are shareable
- [ ] Preset/bookmark list in localStorage

### Should-have (M2, weeks 6–10)

- [ ] **HackRF One** WebUSB driver
- [ ] **SSB (USB/LSB)** demod
- [ ] **Network IQ via rtl_tcp** + your WebSocket bridge daemon (Go or Rust, distributed via GH releases)
- [ ] **ADS-B decoder** (separate "app mode" within the same site)
- [ ] Mobile-responsive layout (test on Android Chrome)
- [ ] Recording: dump IQ or demod audio to WAV (`File System Access API`)

### Stretch (post-MVP / v2)

- [ ] Airspy HF+ Discovery
- [ ] `sdr-server` protocol support
- [ ] OpenWebRX server client
- [ ] WebGPU waterfall
- [ ] POCSAG / pager decode
- [ ] LoRa decoder
- [ ] Plugin API for community decoders

### Explicitly not in scope

- SDRplay (closed driver)
- Transmit (you said RX; HackRF TX would be a separate, regulated can of worms)
- Multi-user serving (you're a client, not a server)
- WebRTC peer-sharing of your dongle (BrowSDR has this; not a great use of your time when 80% of users want simpler)

---

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| BrowSDR is already "good enough" and absorbs your audience | High | High | Differentiate hard on (a) network input, (b) URL-shareable state, (c) MIT license. Don't replicate; complement. |
| WebUSB OS friction (Windows requires WinUSB driver via Zadig; Linux requires udev rules) | Certain | Medium | Document onboarding clearly per OS. Provide a "first-time setup" page that detects platform and shows the right instructions. |
| COOP/COEP headers fail you in some hosting context | Medium | High (no SharedArrayBuffer = bad DSP perf) | Choose Cloudflare Pages from day 1. Verify headers in CI. |
| WebUSB latency causes audio glitches | Medium | Medium | Bulk transfers + big ring buffer + AudioWorklet (which is real-time priority). Plan for ~200ms total budget. |
| DSP performance ceiling on mid-range mobile | Medium | Medium | Decimate early, FFT in chunks, profile on a real $200 Android phone before declaring done. |
| AGPL licensing trap if you read BrowSDR's source for "inspiration" | Medium | High (forces your project AGPL) | Use only the MIT/Apache references (rtlsdrjs, webrtlsdr) for code. Look at BrowSDR only for feature ideas/UX, not implementation. |
| SDRplay users complain | Certain | Low | README "Why no SDRplay?" section linking to this research. Honest is better than promised-and-broken. |
| LoRa demod underestimated | High (if scoped to MVP) | High | Move LoRa to v2. Stay firm. |
| Cross-Origin requirements break embedding in other sites | Medium | Low | Document that the app must be served as a top-level page, not in an iframe. |

---

## 6. Cost Estimates

### Development time (assuming part-time, ~10–15 hrs/week)

| Phase | Time |
|---|---|
| Scaffolding, WebUSB RTL-SDR, basic spectrum + WFM | 2–3 weeks |
| WASM DSP pipeline, NFM/AM, waterfall | 2–3 weeks |
| HackRF support + SSB | 2 weeks |
| Network IQ + WS bridge | 1–2 weeks |
| ADS-B mode | 1–2 weeks |
| Polish, mobile, docs, release | 2 weeks |
| **Total to MVP** | **10–14 weeks** ≈ 2.5–3.5 months |

This is on the upper end of your stated 1–3 month window. If you're closer to 1 month, **drop ADS-B and HackRF** from M1.

### Running costs

- Hosting: **$0** (Cloudflare Pages)
- Domain: **$0–15/yr**
- Bridge daemon binaries (released via GitHub Releases): **$0**

### Hidden costs

- Cross-platform WebUSB onboarding documentation: ~1 week
- Test hardware: you need at least RTL-SDR + HackRF in hand. If you don't have HackRF, that's **~$300–350** for a HackRF One.

---

## 7. Next Steps

1. **Decide on differentiation.** Pick 2–3 of: network input / URL-share / MIT license / mobile-first / WebGPU / decoder plugin API. Without a clear answer, you'll spend the project drifting toward "worse BrowSDR".
2. **Decide on license.** MIT is the obvious choice for an OSS receiver. Apache-2.0 if you want patent grants. **Not AGPL** unless you intentionally want to constrain commercial reuse.
3. **Decide whether to keep ADS-B and LoRa in MVP** based on this doc. My recommendation: ADS-B yes, LoRa no.
4. **Run `/vibe-prd`** to turn this into a PRD with concrete user stories, acceptance criteria, and a build sequence. The PRD will use this research as input.

---

## Sources

### Direct competitors / browser SDR projects
- [BrowSDR (GitHub)](https://github.com/jLynx/BrowSDR) — closest competitor, AGPL-3.0
- [BrowSDR live demo](https://browsdr.jlynx.net/)
- [RTL-SDR.com on BrowSDR](https://www.rtl-sdr.com/browsdr-turn-your-hackrf-or-rtl-sdr-into-a-browser-based-remote-websdr/)
- [Hackaday — RTL-SDR With Only A Browser](https://hackaday.com/2025/03/23/rtl-sdr-with-only-a-browser/)
- [Luigi Cruz CyberRadio Blast (Airspy WebUSB)](https://www.hackster.io/news/luigi-cruz-s-cyberradio-blast-puts-airspy-hf-discovery-sdr-control-right-in-your-browser-window-8882dc98e5f3)
- [No-SDR: Multi-User WebSDR](https://www.rtl-sdr.com/no-sdr-a-new-open-source-multi-user-websdr-for-rtl-sdr/)

### Libraries
- [jtarrio/webrtlsdr (GitHub)](https://github.com/jtarrio/webrtlsdr)
- [sandeepmistry/rtlsdrjs (GitHub)](https://github.com/sandeepmistry/rtlsdrjs)
- [cho45/hackrf-sweep-webusb (GitHub)](https://github.com/cho45/hackrf-sweep-webusb)
- [kaedenbrinkman/hackrf (GitHub)](https://github.com/kaedenbrinkman/hackrf)

### Server-side reference
- [OpenWebRX+ (luarvique fork, DeepWiki)](https://deepwiki.com/luarvique/openwebrx)
- [OpenWebRX waterfall display (DeepWiki)](https://deepwiki.com/jketterl/openwebrx/2.2-waterfall-display)
- [owrx_connector (GitHub)](https://github.com/jketterl/owrx_connector) — OpenWebRX↔SDR connector layer
- [PhantomSDR Plus](https://www.ab9il.net/software-defined-radio/new-internet-sdr.html)
- [PhantomSDR overview (RTL-SDR.com)](https://www.rtl-sdr.com/phantomsdr-websdr-software-for-the-rx888-mkii-and-other-sdrs/)
- [KiwiSDR vs RaspberrySDR (Hackaday)](https://hackaday.com/2020/09/30/kiwisdr-vs-raspberrysdr-a-tale-of-two-sdrs/)

### Network protocols
- [websockify (GitHub)](https://github.com/novnc/websockify) — WS↔TCP bridge reference
- [SpyServer 2.0 — efficient streaming](https://www.rtl-sdr.com/spyserver-2-0-released-efficient-streaming-airspy-rtl-sdr/)
- [sdr-server (open SpyServer alternative)](https://www.rtl-sdr.com/sdr-server-an-advanced-open-source-rtl-sdr-streaming-server/)
- [SegDSP — distributed SDR over SpyServer](https://www.rtl-sdr.com/segdsp-distributed-cloud-based-sdr-with-spyserver/)

### DSP / WASM
- [pffft.wasm (GitHub)](https://github.com/JorenSix/pffft.wasm)
- [PulseFFT (kissFFT in WASM)](https://github.com/AWSM-WASM/PulseFFT)
- [web-dsp (shamadee)](https://github.com/shamadee/web-dsp)
- [Faust → WebAssembly](https://faustdoc.grame.fr/manual/deploying/)
- [Casey Primozic — FM synth Rust+WASM+SIMD](https://cprimozic.net/blog/fm-synth-rust-wasm-simd/)

### SDRplay specifics
- [SDRplay ArchWiki](https://wiki.archlinux.org/title/SDRplay)
- [SDRplay & SoapySDR (sdrangel wiki)](https://github.com/f4exb/sdrangel/wiki/SDRPlay-and-SoapySDR-(obsolete))
- [dj0abr WebSDR for SDRplay RSP1A/B](https://github.com/dj0abr/WebSDR) — server-side, not WebUSB

### ADS-B (browser)
- [WebUSB ADS-B decoder (RTL-SDR.com)](https://www.rtl-sdr.com/a-webusb-based-rtl-sdr-aircraft-ads-b-decoder/)
- [airplanejs (GitHub)](https://github.com/watson/airplanejs)
- [skies-adsb 3D ADS-B](https://www.rtl-sdr.com/) (search "skies-adsb")

### LoRa demod (no browser implementations found)
- [Decoding LoRa: Realizing a Modern LPWAN with SDR (Knight)](https://pubs.gnuradio.org/index.php/grcon/article/download/8/7/)
- [gr-lora2 (GitHub)](https://github.com/alexmrqt/gr-lora2)
- [sdrangel ChirpChat plugin](https://github.com/f4exb/sdrangel/blob/master/plugins/channelrx/demodchirpchat/readme.md)
- [SDR-LoRa paper (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S1389128624000264)
- [LoRa/CSS overview (Gyujun Jeong)](https://gyulab.github.io/lora/)
