# AGENTS.md — Master Plan for Moshon SDR

## Project Overview

**App:** Moshon SDR
**Overview:** Browser-based SDR receiver for amateur radio operators. Tunes RTL-SDR / HackRF hardware over WebUSB *or* a remote `rtl_tcp` server via WebSocket bridge. Static site, no backend.
**Primary user:** Active ham radio operator (validated daily-driver use case).
**Stack:** Svelte 5 + Vite + TypeScript (web) · Rust → WebAssembly via `wasm-pack` + RustFFT (DSP) · Go single-binary WebSocket-to-rtl_tcp proxy (bridge) · Tailwind CSS 4 · pnpm · Cloudflare Pages.

## Source of truth

Read these in order when you're not sure about scope, intent, or design decisions:

1. [docs/PRD-Moshon-SDR-MVP.md](docs/PRD-Moshon-SDR-MVP.md) — *what* we're building and the acceptance criteria
2. [docs/TechDesign-Moshon-SDR-MVP.md](docs/TechDesign-Moshon-SDR-MVP.md) — *how* we're building it, including module structure, performance budget, and CI
3. [docs/research-moshon-sdr.md](docs/research-moshon-sdr.md) — the *why*: market landscape, hardware feasibility, competitor analysis

Detailed agent context (load only when relevant):

- [agent_docs/tech_stack.md](agent_docs/tech_stack.md) — exact libraries, versions, setup commands
- [agent_docs/code_patterns.md](agent_docs/code_patterns.md) — TS/Rust/Go conventions, error handling, commit style
- [agent_docs/project_brief.md](agent_docs/project_brief.md) — product vision, persona, anti-goals
- [agent_docs/product_requirements.md](agent_docs/product_requirements.md) — MoSCoW summary
- [agent_docs/testing.md](agent_docs/testing.md) — Vitest, Playwright, perf benchmarks

## Setup & commands

Standard workflows. Do not invent variants.

```bash
# First-time toolchain (see docs/TechDesign-Moshon-SDR-MVP.md §3)
corepack enable && corepack prepare pnpm@latest --activate
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# Daily web dev
pnpm -C web install
pnpm -C web run wasm:build       # builds dsp/ → web/src/lib/dsp/wasm/
pnpm -C web run dev              # Vite dev server with COOP/COEP headers
pnpm -C web run check            # svelte-check + tsc
pnpm -C web run lint
pnpm -C web run test             # Vitest

# DSP crate (Rust) — run from inside dsp/. Mirror what CI does.
cd dsp
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cd ..

# Bridge daemon (Go) — Go's -C flag is stable
go -C bridge test ./...
go -C bridge build -o ../dist/moshon-bridge ./

# E2E
pnpm -C web run test:e2e         # Playwright
```

## Plan → Execute → Verify

For every change touching more than one file:

1. **Plan:** State the goal, list the files you'll touch, and call out any rule from "What NOT to do" that's adjacent to your change. If anything's ambiguous, ask before coding.
2. **Execute:** One milestone at a time (see Roadmap below). Don't combine milestones into one PR.
3. **Verify:** Run the relevant commands above. Fix until green. Then commit.

For typo fixes or single-file tweaks, the plan step is implicit — just make the change and verify.

## Roadmap

Each phase ends with a tagged commit. Each milestone is roughly one PR.

### Phase 1 — Foundation (week 0)
- [x] **B1** Project scaffold: `web/`, `dsp/`, `bridge/`, CI workflows, MIT LICENSE, README stub, Vite + WASM end-to-end build (Rust→WASM `smoke()` returns 42)
- [x] **B2** COOP/COEP headers (folded into B1 — set in both `vite.config.ts` and `web/public/_headers`)

### Phase 2 — M1 must-haves (weeks 1–9)
- [x] **B3** RTL-SDR WebUSB driver via `@jtarrio/webrtlsdr` (Apache-2.0).
- [x] **B4a** USB I/O moved to a Web Worker (verified — rate approaches 2.40 MS/s).
- [x] **B4b** SAB ring buffer between USB + DSP workers; RustFFT (2048-bin, Hann window) via WASM in DSP worker; spectrum + waterfall Canvas 2D renderers; viridis/magma/classic colormaps; adjustable dB range. Target 30 fps at 2048-bin FFT (PRD M1.2, M1.4).
- [x] **B5** Tuning UI: keyboard hotkeys (`F`/`M`/`B`/`G`/`,`/`.`/`[`/`]`/`Space`/`?`); virtual VFO dial (click-drag horizontally to fine-tune, scroll-wheel to step); click anywhere on spectrum/waterfall to tune to that frequency; live frequency-axis labels above the waterfall. Live retune-while-streaming via worker `retune` message. (PRD M1.5, M1.6)
- [x] **B6a** Audio pipeline + WFM mono demod: Rust `WfmDemod` (2.4 MS/s → 240 kS/s IF decimation → FM discriminator → 48 kS/s audio decimation, all with windowed-sinc FIRs); SAB-backed PCM ring; AudioWorklet (`web/public/audio-processor.js`); AudioContext at 48 kHz; volume slider + mute toggle (Space). NFM/AM/SSB/CW are mode-cycle UI only — actual demod for those lands in B6b–B6d. (PRD M1.3 partial)
- [x] **B6b** NFM + AM demods: Rust `NfmDemod` (quadrature FM discriminator) and `AmDemod` (envelope detector + single-pole DC block) sharing a two-stage channelizer (2.4 MS/s → 240 kS/s wide LPF → 48 kS/s channel filter at `bandwidth/2`). DSP worker dispatches on `mode` via a `setMode` message; the UI's `M`/`B` hotkeys live-retune the demod without restarting the stream. SSB/CW still fall back to NFM until B6c–B6d. (PRD M1.3 partial)
- [x] **B6c** SSB (USB + LSB) via Weaver's method: Rust `SsbDemod` shifts the desired sideband to DC, applies a real-coefficient LPF at `bandwidth/2` to kill the image sideband, then shifts back and takes the real part. Single struct with an `lsb: bool` constructor arg; worker maps `usb`/`lsb` modes to the two configurations. CW falls back to a narrow USB until B6d. (PRD M1.3 partial)
- [x] **B6d** CW: Rust `CwDemod` — 127-tap narrow channel filter at `bandwidth/2` (default 500 Hz) and a fixed 700 Hz BFO mixer that turns the zero-beat carrier into an audible tone. Worker dispatches `cw` mode to the new demod. (PRD M1.3 complete) ✅
- [x] **B6** Demods: WFM (mono+stereo), NFM, AM, SSB (USB/LSB via Weaver), CW (PRD M1.3) — stereo WFM deferred to M2.
- [x] **B7** URL hash state (`#f=…&m=…&bw=…&g=…` restored on load via `history.replaceState`); localStorage memory channels (save/recall current tuning, max 50); IARU Region 1 band overlay strip above the spectrum frequency axis; peak-dBFS S-meter with rough S-unit mapping. (PRD M1.7–M1.10)
- [x] **B8** First-run onboarding modal with per-OS WebUSB setup steps (Windows/Zadig, macOS, Linux/udev). Detects OS from `navigator.userAgent` and defaults to that tab. Dismissal persisted in `localStorage` under `moshon.onboarding.dismissed.v1`. Header has a "Setup" button to re-open. (PRD M1.11)
- [ ] **B9** Network IQ source: `rtl_tcp` over WebSocket bridge + Go bridge daemon released for 6 platforms (PRD M1.12, M1.13)
- [ ] **B10** Definition-of-Done validation: PRD success criteria S1–S5 confirmed. Tag `v0.1.0`.

### Phase 3 — M2 should-haves (weeks 10+)
- [ ] HackRF One driver
- [ ] ADS-B mode (`/adsb` route, lazy WASM)
- [ ] RDS for WFM
- [ ] Audio + IQ recording
- [ ] CW filter + decoder
- [ ] Mobile-responsive audit on Android Chrome

### Phase 4 — Polish & launch
- [ ] README full pass (WebUSB-per-OS, hotkey reference, SDRplay FAQ, bridge setup)
- [ ] Lighthouse: Performance ≥90, Accessibility ≥95
- [ ] Optional custom domain
- [ ] Public announcement (rtl-sdr.com submission, Hacker News)

## Performance budget

Per 1024-sample block at 2.4 MS/s, total budget **< 11 ms**:

| Stage | Budget |
|---|---|
| USB transfer | < 1 ms |
| Channelize + decimate | < 5 ms |
| FFT (2048 Hann) | < 2 ms |
| Demod | < 2 ms |
| Audio render | < 1 ms |

If a change risks exceeding this, add a `performance.now()` probe in DSP-worker and report the actual numbers in the PR description.

## Protected areas

Do NOT modify these without explicit approval from the human:

- `LICENSE` — MIT is fixed for v1. Don't switch to anything else.
- `.github/workflows/*.yml` — CI changes deserve their own dedicated PR with a clear "why".
- `docs/PRD-*.md`, `docs/TechDesign-*.md`, `docs/research-*.md` — these are the contract. Update only via a dedicated docs PR with rationale.
- `_headers` (Cloudflare Pages) — wrong values here silently break SharedArrayBuffer.
- `bridge/.goreleaser.yaml` — release matrix changes need a human in the loop.

## What NOT to do (the strict rules)

These are non-negotiable. Violating any of them is a stop-the-line event.

1. **No AGPL code in the tree.** Specifically, **do not read [BrowSDR](https://github.com/jLynx/BrowSDR)'s source for inspiration or copy patterns from it.** Reading AGPL code creates contagion risk for our MIT codebase. You may reference BrowSDR's *features* (from public docs / their README) but not their *implementation*. Safe references: `webrtlsdr` (Apache-2.0), `rtlsdrjs` (MIT), `rustfft` (MIT/Apache-2.0).
2. **No transmit.** Receive-only. Don't add TX-capable code paths even if the hardware (HackRF) supports it.
3. **No SDRplay support.** The driver is closed-binary and has no browser path. Don't try to reverse-engineer it.
4. **No LoRa in v1.** Move to M3 / v2. CSS demod is multi-week work that doesn't belong in MVP.
5. **No backend you operate.** The bridge daemon runs on the *user's* machine. We do not host a network IQ relay.
6. **No analytics, telemetry, or PII collection in v1.** If a future feature needs analytics, propose it explicitly in a docs PR first.
7. **No multi-VFO in v1.** Single demod chain. Multi-VFO is M3.
8. **Don't break the performance budget without flagging it.** If a change makes the per-block time exceed 11 ms, the PR description must say so.
9. **Don't skip the COOP/COEP headers.** SharedArrayBuffer is required; the headers must be present in dev and prod.
10. **Don't `git push --force` to `main`.** Always create new commits.

## Current state

**Last updated:** 2026-05-22
**Workflow phase:** Step 5 (Build) — milestone B1 in progress.
**Completed:**
- Research, PRD, Tech Design committed
- B1a: cleanup + project identity (LICENSE, README, .gitignore, etc.)
- B1c: scaffold `web/` (Svelte 5 + Vite + Tailwind 4 + lucide-svelte), `dsp/` (Cargo crate stub with `smoke()` export), `bridge/` (Go module + stub main.go)
- B1d: four GitHub Actions workflows (ci, deploy, bridge-release, claude-review) + GoReleaser config
**Currently working on:** B8 shipped (first-run WebUSB onboarding). Ready for B9 (network IQ via rtl_tcp + Go bridge daemon).
**Blocked by:** None.
**Verification pending:** (1) B6 hardware tests for all six modes; (2) URL share — copy hash to incognito and confirm tuning restores; (3) memory channel survives reload; (4) S-meter responds to a known signal; (5) onboarding modal opens on first visit and dismisses cleanly.

## Agent behavior baseline

Applies to any AI coding assistant working on this repo (Claude Code, Cursor, Copilot, etc.):

1. **Plan before execution.** Multi-file changes require a brief plan first.
2. **Refactor over rewrite.** Prefer incremental improvements to large block rewrites.
3. **Iterative verification.** Run tests/linters after each logical change.
4. **Honest progress.** If a milestone isn't truly done (failing test, perf regression, etc.), say so — don't mark it complete.
5. **Conventional Commits** for messages: `feat(web): ...`, `fix(dsp): ...`, `docs: ...`, `chore: ...`, `test: ...`.
6. **No drive-by changes.** If you notice an unrelated bug, file an issue or note it — don't bundle it with the current PR.
