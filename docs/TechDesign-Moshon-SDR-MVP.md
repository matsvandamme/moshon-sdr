# Technical Design — Moshon SDR (MVP)

> Implementation plan for a browser-based SDR receiver. Companion to [research-moshon-sdr.md](research-moshon-sdr.md) and [PRD-Moshon-SDR-MVP.md](PRD-Moshon-SDR-MVP.md).

- **Status:** Draft v1
- **Owner:** Matthieu Van Damme
- **Date:** 2026-05-22

---

## 1. Recommended Approach

A monorepo with three subprojects under one MIT-licensed GitHub repo:

```
moshon-sdr/
├── web/                  # Svelte 5 + Vite SPA — the receiver UI
├── dsp/                  # Rust crate compiled to WebAssembly — FFT + demod
├── bridge/               # Go daemon — WebSocket ↔ rtl_tcp proxy
├── docs/                 # Research, PRD, tech design, decisions
└── .github/workflows/    # CI (test) + CD (Pages, Releases)
```

The web app is a single static page hosted on **Cloudflare Pages** with `_headers` setting COOP/COEP for SharedArrayBuffer. The bridge daemon ships as prebuilt binaries on GitHub Releases — users run it on their own host alongside an `rtl_tcp` server. No backend you operate.

**Why this layout, not alternatives:**

- **Monorepo over multi-repo:** Three subprojects, one author, tightly coupled releases. Multi-repo adds version-pinning overhead without a clear win at this size.
- **No pnpm workspaces:** Each subproject has its own native toolchain (npm/pnpm for `web`, cargo for `dsp`, go for `bridge`). Workspaces buy nothing here.
- **Svelte 5 over SolidJS:** Both fit. Svelte's runes + reactive `$state` model maps cleanly to "current tuning → URL hash → component reactivity" without ceremony. SolidJS is the runner-up.
- **No SvelteKit:** We have one page, no routing, no SSR. SvelteKit is overkill.
- **Rust+WASM over C++/Emscripten or AssemblyScript:** Better tooling (`wasm-pack`, `wasm-bindgen`), best-in-class FFT (`rustfft`), SIMD-128 support, and the broadest community for WASM-DSP today.
- **Go for the bridge over Rust:** Cross-compilation matrix in CI is one line for Go; Rust's six-target matrix is workable but more painful. Bridge code is trivial — ~150 LOC. Don't add Rust complexity here.

---

## 2. Alternative Options Considered

| Decision | Recommended | Alternative considered | Why not |
|---|---|---|---|
| UI framework | Svelte 5 | SolidJS | Comparable performance; Svelte has better state-management story for this app shape |
| UI framework | Svelte 5 | React | Reconciler overhead is wasteful at 60 fps; ecosystem advantage doesn't apply to a single-page SDR |
| UI framework | Svelte 5 | Vanilla TS | Doable but you'll reinvent reactive state; not worth it |
| Styling | Tailwind 4 | CSS Modules / vanilla CSS | Tailwind iteration speed beats both for a single dev |
| Styling | Tailwind 4 | UnoCSS | Smaller win; Tailwind 4 is the mainstream and well-documented choice |
| FFT | RustFFT | KissFFT (via PulseFFT WASM) | RustFFT is faster, native to the Rust DSP crate |
| FFT | RustFFT | PFFFT WASM | Similar perf; RustFFT integrates cleanly with the rest of the DSP code |
| Bridge | Go | Rust | More CI complexity; we already pay the Rust cost for DSP |
| Bridge | Go | Node.js | Node deployment story (asar packaging, etc.) is worse than a single Go binary |
| RTL-SDR USB | depend on `webrtlsdr` | Write from scratch | 1-2 week savings; Apache-2.0 is MIT-compatible |
| RTL-SDR USB | depend on `webrtlsdr` | Fork `rtlsdrjs` | rtlsdrjs is older, less actively maintained |
| RTL-SDR USB | depend on `webrtlsdr` | Read BrowSDR for inspiration | **AGPL contagion risk** — strict no-read policy |
| Hosting | Cloudflare Pages | Netlify | Both fine; Pages has slightly cleaner header config and free analytics |
| Hosting | Cloudflare Pages | Vercel | Free tier exists but Cloudflare's CDN is broader |
| Hosting | Cloudflare Pages | GitHub Pages | **Does not allow COOP/COEP headers** — disqualified |
| State/URL sync | Hand-rolled | nanostores, jotai, etc. | <50 LOC needed; no dependency justified |
| Tests | Vitest + Playwright | Jest, Cypress | Vitest is faster + native ESM; Playwright > Cypress for WebUSB scenarios |

---

## 3. Project Setup — Step-by-Step Checklist

Order matters here. Do not skip the COOP/COEP step.

### One-time toolchain installs

- [ ] **Node** 22.x LTS (via [Volta](https://volta.sh) or fnm so it pins per-project)
- [ ] **pnpm** 9.x (`corepack enable && corepack prepare pnpm@latest --activate`)
- [ ] **Rust** stable via `rustup`; add `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- [ ] **wasm-pack** (`cargo install wasm-pack`)
- [ ] **Go** 1.23+ (only needed when working on the bridge)
- [ ] **GoReleaser** (only needed to cut a bridge release; runs in CI normally)
- [ ] **Cloudflare account** + create a Pages project linked to the GitHub repo
- [ ] **Cloudflare API token** with `Pages: Edit` scope — added as `CLOUDFLARE_API_TOKEN` GitHub Actions secret

### Initial repo scaffolding (one PR — `feat: project scaffold`)

- [ ] Add MIT `LICENSE` file (replace template's if present)
- [ ] Replace `README.md` with a stub: name, tagline, "WIP" notice, link to docs/
- [ ] Add `.gitignore` covering `node_modules/`, `target/`, `pkg/`, `dist/`, `.DS_Store`, `*.local`, `bridge/dist/`
- [ ] Add `.editorconfig`
- [ ] Add `.nvmrc` pinning Node 22
- [ ] Add `rust-toolchain.toml` pinning the channel
- [ ] Scaffold `web/` with `pnpm create vite@latest web -- --template svelte-ts`
- [ ] Scaffold `dsp/` with `cargo new --lib dsp` and set `crate-type = ["cdylib"]`
- [ ] Scaffold `bridge/` with `go mod init github.com/matsvandamme/moshon-sdr/bridge`
- [ ] Add empty placeholder workflows under `.github/workflows/`

### First-feature foundation (one PR — `feat(web): COOP/COEP + WASM loader`)

- [ ] Add `web/public/_headers` (Cloudflare Pages format):
      ```
      /*
        Cross-Origin-Opener-Policy: same-origin
        Cross-Origin-Embedder-Policy: require-corp
      ```
- [ ] Configure Vite dev server to serve the same headers (`vite.config.ts`: `server.headers`)
- [ ] Add `dsp/build.rs` or a `scripts/build-wasm.mjs` that runs `wasm-pack build --target web` and copies the output into `web/src/lib/dsp/wasm/`
- [ ] Wire `pnpm dev` to build WASM once if missing, then run Vite
- [ ] Smoke test: page loads, WASM module instantiates, console logs `wasm ready`

---

## 4. Feature Implementation Plan

This maps PRD must-haves (M1.1–M1.13) to concrete modules and milestones. Each milestone is a commit-set, not a multi-PR mega-task.

### Milestone B1 — Static page + WASM (PR 1)

- Vite SPA renders
- Rust DSP crate compiles to WASM
- WASM module loads in the browser; calls a `fft_test(input: Float32Array) -> Float32Array` smoke function

### Milestone B2 — RTL-SDR device & raw IQ (PR 2)  → M1.1

- Add `webrtlsdr` as a dependency
- In `web/src/workers/usb-worker.ts`: claim device, configure rate (default 2.4 MS/s), set center freq + gain
- Stream raw 8-bit IQ via SharedArrayBuffer ring (4 MB)
- Main thread reads bytes, displays "X samples/s" counter — proves the pipeline works

### Milestone B3 — FFT + spectrum + waterfall (PR 3)  → M1.2, M1.4

- DSP worker reads SAB ring, runs RustFFT (size 2048, Hann window), publishes bins to main via a separate SAB
- Main thread renders spectrum (Canvas 2D, top 1/3) and waterfall (Canvas 2D, bottom 2/3)
- Color map: 3 presets (viridis, magma, gqrx-classic). dB range and history controls
- **Benchmark**: must hit 30 fps at 2.4 MS/s + 2048-bin FFT on author's laptop (S5)

### Milestone B4 — Tuning UI (PR 4)  → M1.5, M1.6

- Frequency entry: `F` hotkey → modal with digit-by-digit + step-size editor
- Hotkeys: `M`, `B`, `,` `.`, `[` `]`, `Space`, `G`, `?` modal
- Mouse: click-drag waterfall to set center; scroll wheel to fine-tune; virtual VFO dial component
- All tuning routes through one `useTuning()` reactive store

### Milestone B5 — Demods (PR 5)  → M1.3

- Rust: `fm.rs` (W/NFM), `am.rs`, `ssb.rs` (Weaver), each with filter widths from the PRD
- Channelizer + decimator → demod → 48 kHz PCM out
- AudioWorklet plays the PCM in real time
- Mode selector in UI

### Milestone B6 — URL hash + memory channels + S-meter + band overlay (PR 6)  → M1.7, M1.8, M1.9, M1.10

- URL hash codec: `freq=14230000&mode=usb&bw=2400&sr=2400000&gain=20`
- Memory channel CRUD in localStorage; import/export JSON
- IARU Region 1 band plan baked in (constant); region selector in settings; render shaded overlays on the spectrum
- S-meter: dBFS readout + S-units (S0 = -127/-147 dBm for HF/VHF), per-device offset config

### Milestone B7 — First-run onboarding (PR 7)  → M1.11

- Detect platform via `navigator.userAgent` + `navigator.usb` availability
- Show per-OS WebUSB setup instructions (Windows → Zadig walkthrough; Linux → udev rules; macOS → no setup)
- Persistent "dismissed" flag

### Milestone B8 — Network IQ + Bridge daemon (PR 8 web + PR 9 bridge)  → M1.12, M1.13

**Web side:**

- New "source" abstraction: `interface IQSource { start, stop, samples$ }` implemented by `WebUsbRtlSource` and `RtlTcpWsSource`
- `RtlTcpWsSource` opens a WebSocket to the bridge, sends rtl_tcp command frames (set_freq=0x01, set_sample_rate=0x02, set_gain=0x04, etc.), receives raw IQ in binary frames
- UI: source picker in header dropdown (`RTL-SDR (USB)` / `Network (rtl_tcp)`)

**Bridge daemon:**

- Go binary `moshon-bridge` (~150 LOC)
- Flags: `--listen :9090`, `--rtltcp 127.0.0.1:1234`, `--cors-origin https://moshon-sdr.pages.dev`
- Accepts a single WS client; bidirectionally proxies bytes to/from `rtl_tcp`
- Binary WS messages downstream (raw IQ); structured upstream (4-byte command header)
- Health: `GET /health` → 200 if rtl_tcp reachable
- GoReleaser config builds for: darwin-amd64, darwin-arm64, linux-amd64, linux-arm64, linux-arm, windows-amd64

### Milestone B9 — Definition-of-Done validation (PR 10)

- Run the PRD's success criteria S1–S5 with instrumented checks
- Update README with installation, hotkeys, FAQ
- Tag `v0.1.0`

### M2 features (should-have)

Schedule after M1 ships. Each is roughly a single PR:

- B10: HackRF One driver
- B11: ADS-B mode (1090 MHz, separate app route `/adsb`, lazy-loaded WASM)
- B12: RDS decode (extends WFM module)
- B13: Audio + IQ recording
- B14: CW filter + decoder
- B15: Mobile-responsive audit

---

## 5. Design Implementation

### Component inventory (minimal)

Build directly — no UI library beyond Tailwind + lucide-svelte:

| Component | Purpose |
|---|---|
| `<App />` | layout shell |
| `<Header />` | source picker, play/pause, settings/help/gear buttons |
| `<Spectrum />` | Canvas 2D spectrum strip |
| `<Waterfall />` | Canvas 2D waterfall with color map + dB range |
| `<TuningBar />` | freq display, mode, BW, gain, S-meter |
| `<VfoDial />` | draggable virtual dial |
| `<MemoryPanel />` | bookmark list with add/edit/delete |
| `<HotkeyModal />` | reference card shown on `?` |
| `<SettingsDrawer />` | source, region, calibration, theme |
| `<FreqEntry />` | numeric/expression freq entry triggered by `F` |
| `<OnboardingWizard />` | first-run platform-specific setup |
| `<SourcePicker />` | dropdown for USB vs Network |

### Design system

- **Palette**: dark default (`bg-neutral-950`, `text-neutral-200`), accent `#7dd3fc` (overrideable). Light theme follows Tailwind `neutral` + same accent.
- **Fonts**: Inter (UI), JetBrains Mono (numerics) — both via Google Fonts subset; **self-host** to avoid extra cross-origin requests under COEP.
- **Icons**: `lucide-svelte` (tree-shakable). No emojis in UI.
- **Spacing**: Tailwind defaults; 4 px radius max; one accent color globally.
- **Motion**: deliberately minimal. Tuning changes are immediate; no decorative transitions. Waterfall scroll uses `requestAnimationFrame`.

### Responsive

- ≥ 1024 px: spectrum + waterfall vertically stacked, memory panel docked right
- 640–1023 px: memory panel collapses into a drawer
- < 640 px: bottom-sheet for controls, full-screen waterfall, hotkeys disabled

---

## 6. State, Storage, and Schemas

No database. Everything lives client-side.

### localStorage keys

```
moshon:settings    → JSON, version-tagged
moshon:memory      → JSON array of memory channels
moshon:onboarded   → "1" once first-run wizard dismissed
```

### Settings shape

```ts
type Settings = {
  schemaVersion: 1;
  theme: 'dark' | 'light' | 'system';
  bandPlanRegion: 1 | 2 | 3;          // IARU
  sMeter: {
    offsetDbHf: number;               // per-device, defaults to -127
    offsetDbVhf: number;              // defaults to -147
  };
  audio: { gain: number; muted: boolean };
  waterfall: {
    colorMap: 'viridis' | 'magma' | 'classic';
    dbMin: number;
    dbMax: number;
    historySec: 5 | 30 | 120;
  };
  network: { lastBridgeUrl?: string };  // never persisted to URL hash
};
```

### Memory channel shape

```ts
type MemoryChannel = {
  id: string;          // ulid
  name: string;
  freq: number;        // Hz
  mode: 'wfm'|'nfm'|'am'|'usb'|'lsb'|'cw';
  bw: number;          // Hz
  gain?: number;       // optional override
};
```

### URL hash codec

Encoded as `URLSearchParams`. Fields: `freq` (Hz integer), `mode`, `bw` (Hz), `sr` (sample rate), `gain` (dB).

**Never** in URL: bridge address (could leak network info), API tokens (none anyway), localStorage data.

Example: `https://moshon-sdr.pages.dev/#freq=14230000&mode=usb&bw=2400&sr=2400000&gain=20` (≈ 75 chars — under the 120-char chat-shareability target in the PRD).

---

## 7. DSP Architecture (Rust → WASM)

```
┌──────────────────────────┐
│  web/src/workers         │
│  usb-worker.ts (or       │
│  net-worker.ts)          │  USB transferIn / WS recv → SAB
└──────────┬───────────────┘
           │ Int8 IQ samples via SharedArrayBuffer ring
           ▼
┌──────────────────────────┐
│  web/src/workers         │
│  dsp-worker.ts           │  → instantiates WASM module
│    ↳ dsp.wasm (Rust)     │
│      • channelize        │
│      • decimate          │
│      • FFT (RustFFT)     │
│      • demod (mode)      │
└──────────┬───────────────┘
           │
   ┌───────┴────────┐
   ▼                ▼
FFT bins         48k PCM
(SAB)            (SAB)
   │                │
   ▼                ▼
Spectrum/         AudioWorklet
Waterfall         → speakers
```

### Rust crate layout (`dsp/`)

```
dsp/
├── Cargo.toml          # crate-type = ["cdylib"], wasm-bindgen, rustfft
├── src/
│   ├── lib.rs          # wasm-bindgen exports
│   ├── ring.rs         # SAB-backed ring buffer access
│   ├── fft.rs          # window + plan cache
│   ├── channelize.rs   # mixer + halfband decimation chain
│   ├── filter.rs       # FIR filter primitives
│   ├── meter.rs        # dBFS → S-units conversion
│   └── demod/
│       ├── mod.rs
│       ├── am.rs
│       ├── fm_wide.rs
│       ├── fm_narrow.rs
│       └── ssb.rs      # Weaver method
└── tests/              # cargo test with synthesized IQ
```

### Worker protocol

`postMessage` only for control. Sample streams use SAB.

```ts
// dsp-worker.ts
type Cmd =
  | { kind: 'init'; iqSab: SharedArrayBuffer; fftSab: SharedArrayBuffer; audioSab: SharedArrayBuffer; }
  | { kind: 'tune'; mode: Mode; bandwidth: number; ifFreq: number; }
  | { kind: 'window'; window: 'hann' | 'hamming' | 'blackman-harris'; fftSize: 1024|2048|4096|8192; };
```

### Performance budget

| Stage | Budget per 2.4 MS/s block (1024 samples) |
|---|---|
| USB transfer | <1 ms |
| Channelize+decimate | <5 ms |
| FFT (2048 Hann) | <2 ms |
| Demod | <2 ms |
| Audio render | <1 ms |
| **Total** | **<11 ms** (90 fps headroom against the 30 fps spectrum target) |

Profile with `performance.now()` instrumented via a `perf` feature flag.

---

## 8. Bridge Daemon (`bridge/`)

### Behaviour

```
$ moshon-bridge --listen :9090 --rtltcp 192.168.1.50:1234
[moshon-bridge] listening on :9090, proxying rtl_tcp at 192.168.1.50:1234
[moshon-bridge] /health -> ok
[moshon-bridge] client connected from 192.168.1.42 — proxying
```

### Protocol

- One WS endpoint at `/`. Single client at a time.
- Downstream (server → client): binary frames containing raw rtl_tcp byte stream (8-bit unsigned IQ pairs).
- Upstream (client → server): binary frames containing rtl_tcp commands (5-byte frames per [rtl_tcp protocol](https://github.com/osmocom/rtl-sdr/blob/master/src/rtl_tcp.c#L294)).
- First frame downstream is the 12-byte `dongle_info` block from rtl_tcp.
- CORS: configurable `--cors-origin`, defaulting to `https://moshon-sdr.pages.dev`.

### Files

```
bridge/
├── main.go          # flag parsing, server start
├── proxy.go         # ws ↔ tcp goroutines
├── proxy_test.go    # mock tcp server, verify byte-for-byte fidelity
├── health.go        # /health endpoint
├── go.mod
└── .goreleaser.yaml
```

### Release flow

- Tag `bridge-v0.1.0` on main → `.github/workflows/bridge-release.yml` runs GoReleaser → publishes a GitHub Release with 6 binaries + checksums.
- Web UI links to "Download bridge" pointing to `https://github.com/matsvandamme/moshon-sdr/releases/latest`.

---

## 9. AI Coding Strategy

This is an OSS side project — keep AI assistance pragmatic, not religious.

| Task | AI Tool | Why |
|---|---|---|
| Day-to-day coding | **Claude Code** in VS Code | Already in use; tight feedback loop; can read/edit files and run tests |
| Long-running review or refactor | `/ultrareview` (multi-agent cloud review) | When you want a deeper pass on a big PR before merging |
| GitHub PR review on every PR | **Claude Code GitHub Action** — `@claude` mention triggers a review | Catches issues you missed; free with your existing Claude subscription |
| DSP precision spot-checks | Manual + Claude Code to write A/B test fixtures | DSP correctness is hard to bullshit; always verify with synthesized signals |
| Generating commit messages | Claude Code (it already does this in this workflow) | Conventional Commits style; you control the message before commit |
| **Don't** delegate | License decisions, scope cuts, anything regulatory | Author judgment only |

### CLAUDE.md / AGENTS.md

Generated in step 4 (`/vibe-agents`). Will codify:
- Project structure
- Coding conventions (TypeScript strict, no `any`, ESLint+Prettier; Rust clippy `pedantic` deny; Go `golangci-lint`)
- Test conventions (Vitest for DSP precision, Playwright for one happy-path e2e)
- Commit-message style (Conventional Commits)
- "Do not lift AGPL code from BrowSDR" rule
- Performance budgets from §7

---

## 10. Deployment Plan

### Web app — Cloudflare Pages

- Pages project: `moshon-sdr`, linked to `matsvandamme/moshon-sdr`, build command `pnpm -C web build`, output `web/dist/`
- `web/public/_headers` provides COOP/COEP
- Preview deploys on every PR; production deploys on push to `main`
- Custom domain: optional. `moshon-sdr.pages.dev` for v0.1; consider `moshon-sdr.app` later (~$15/yr at Cloudflare Registrar).

### Bridge daemon — GitHub Releases

- Tag-driven release via GoReleaser
- Binaries: darwin-amd64, darwin-arm64, linux-amd64, linux-arm64, linux-arm, windows-amd64
- Each artifact is a single static binary (CGO disabled)
- README on the repo's homepage tells users how to install + run

### Backup / fallback

- If Cloudflare Pages goes down: the same `web/dist/` can be served from any static host (Netlify, Vercel, S3+CloudFront). The `_headers` file becomes a `netlify.toml` equivalent if you switch. Migration takes <30 min.
- If GitHub Releases is unavailable: bridge is small enough that users can `go install github.com/matsvandamme/moshon-sdr/bridge@latest` themselves.

---

## 11. CI/CD

### `.github/workflows/ci.yml` (PR + push)

- Matrix: `ubuntu-latest`, `windows-latest`
- Steps:
  1. Checkout
  2. Setup Node 22 + pnpm (cached)
  3. Setup Rust + `wasm32-unknown-unknown` (cached via `Swatinem/rust-cache`)
  4. Setup Go (only if `bridge/**` changed)
  5. `pnpm -C web install --frozen-lockfile`
  6. `pnpm -C web run wasm:build`
  7. `pnpm -C web run check` (svelte-check + tsc)
  8. `pnpm -C web run lint`
  9. `pnpm -C web run test` (Vitest)
  10. `(cd dsp && cargo test)`
  11. `(cd dsp && cargo clippy --all-targets -- -D warnings)` + `(cd dsp && cargo fmt -- --check)`
  12. If `bridge/**` changed: `cd bridge && go test ./... && go vet ./...`
  13. Playwright e2e against the `pnpm dev` server (Linux only)

### `.github/workflows/deploy.yml` (push to main)

- Build `web/`
- Deploy to Cloudflare Pages via `cloudflare/wrangler-action@v3`
- Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets

### `.github/workflows/bridge-release.yml` (tag `bridge-v*`)

- Setup Go
- Run `goreleaser release --clean`
- Uses `GITHUB_TOKEN` (auto-provided)

### `.github/workflows/claude-review.yml` (PR comment trigger)

- Mention `@claude` on a PR → Claude Code reviews the diff
- Standard Anthropic-provided workflow

---

## 12. Security, Privacy, Compliance

| Concern | Handling |
|---|---|
| **Authentication** | None. App is local. |
| **API keys / secrets** | None client-side. CI secrets are scoped per-workflow. |
| **PII** | None collected, none stored. |
| **Telemetry** | None in v1. If added, self-hosted (Plausible/Umami) and disclosed in README. |
| **URL hash content** | Tuning state only. No bridge addresses, no IPs. |
| **localStorage** | Memory channels, settings only. No tokens. |
| **WebUSB** | Browser-mediated; user explicitly authorizes each device once. |
| **WS bridge** | The user runs it themselves. Default binds to all interfaces — README must call out to restrict to LAN if needed. CORS check is the only origin gating. |
| **Regulatory** | Receive-only. No transmit. No spectrum regulation impact. |
| **GDPR / CCPA** | N/A — no personal data collected. |
| **Licensing** | MIT for our code. Apache-2.0 from `webrtlsdr` is compatible (preserve their copyright notice). MIT-licensed `lucide-svelte`, `rustfft`, etc. **No AGPL code in our tree, ever.** |

---

## 13. Cost Breakdown

### Development (out-of-pocket)

| Item | Cost |
|---|---|
| Author's time | The actual cost — ~120–180 hrs over 3 months |
| Hardware | $0 — already owned |
| Optional new HackRF for M2 testing | $0 (skipped) or ~$320 |
| Tools (Claude Code, IDE, etc.) | Already paid for |
| **Total cash** | **$0** |

### Production / running

| Item | Cost |
|---|---|
| Cloudflare Pages | $0 (free tier covers any plausible OSS-app traffic) |
| GitHub (public repo) | $0 |
| Domain (optional `moshon-sdr.app`) | ~$15/yr |
| **Total** | **$0–15/yr** |

### Cost guardrails

- Don't add an analytics SaaS — kills the free-forever pitch.
- Don't add image hosting / asset CDN — Pages handles it.
- Don't add a backend "just for stats" — anti-goal.

---

## 14. Scaling Path

This is a client-side app — each user runs their own. Traditional scaling doesn't apply. What scales:

| Dimension | At 100 users | At 1,000 users | At 10,000 users |
|---|---|---|---|
| Hosting (Pages) | Free | Free | Free (until you blow past 100k requests/day, which is fine for a static SPA) |
| Bridge daemon | Each user runs their own. Zero op cost on your side. | Same. | Same. |
| GH Releases bandwidth | Trivial | Trivial | Possibly noticeable; not a 2026 concern |
| Issue triage | Manageable solo | Strained solo — consider a CONTRIBUTING.md and tag for "good first issue" | Need 1-2 maintainers; consider a Discord/Matrix room |
| Feature requests | Linear in users | Drive a public roadmap (GitHub Projects) | Lock M3 features behind community votes |

**There is no v1 work to do for scale.** It's the wrong instinct for this product. The PRD's success metric is *personal daily-driver* — scale is a happy side effect.

---

## 15. Limitations

Be honest about these in the README so users self-select correctly.

- **Chromium browsers only** for full functionality. Network IQ works in Firefox/Safari too (no WebUSB needed there), but USB does not.
- **No SDRplay support** — closed-source binary driver. Direct users to native software.
- **No transmit.** Receive-only by design.
- **No LoRa** (yet). No mature browser CSS demod implementation exists; estimated several weeks of focused DSP work. Tracked as v2.
- **8-bit IQ** from RTL-SDR (and HackRF in M2). Same as native software using these dongles — not a Moshon limitation per se.
- **Single VFO in v1**. Multi-VFO is M3 / v2.
- **Per-OS WebUSB setup is real**. Windows users still need Zadig the first time. We document it, but we can't eliminate it from the browser side.
- **AudioWorklet latency floor** is ~5-10 ms even in best case. Not noticeable for receive use; would matter for transmit (which we don't do).
- **Bridge daemon is a separate install.** "Pure static site" applies to the *web app*. Network IQ users must run the bridge somewhere — usually the same host as their `rtl_tcp` server. README must be crystal clear about this.

---

## 16. Open Questions (resolve before B6)

- [ ] **S-meter calibration table for RTL-SDR v3 vs v4** — empirically derive on author's hardware. Default offsets are guesses until measured.
- [ ] **WFM RDS** — implement in M1 alongside WFM, or punt to M2? Currently scheduled M2 to keep M1 lean. Reconsider after B5.
- [ ] **Custom domain** — `moshon-sdr.app` ($15/yr) vs stay on `*.pages.dev` for v0.1? Lean toward staying on `.pages.dev` until v1.0.
- [ ] **Cloudflare Pages or Workers** for hosting? Pages is the right call for pure static; Workers only if we ever need a tiny edge function (we don't).

---

## 17. Sanity check (before moving to AGENTS.md)

- [x] Tech stack fits the $0/yr budget
- [x] Timeline is plausible: 10 milestones × ~1 week each = 10 weeks ≈ author's stated 3-month part-time window
- [x] Security/privacy: no PII, no backend, no analytics, no surprises
- [x] Performance budget is achievable (§7) with margin
- [x] Build/CI is conventional — no exotic infra to learn
- [x] No AGPL contagion path; license is MIT-clean

Ready for `/vibe-agents`.
