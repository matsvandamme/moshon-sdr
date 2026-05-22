# Project Brief

## Vision (one paragraph)

Moshon SDR is the browser-based SDR receiver built around ham radio operating habits: precise SSB tuning, keyboard-first frequency entry, memory channels, IARU band overlays, and — most importantly — **two equally first-class input paths**: local USB dongle (WebUSB) and a remote `rtl_tcp` server reached through a lightweight WebSocket bridge daemon. It's MIT-licensed, runs as a static site on Cloudflare Pages, and asks nothing of you except a Chromium-family browser.

## Primary persona

Active ham radio operator. Owns at least one RTL-SDR Blog v3/v4 or HackRF One. Comfortable with udev rules, Zadig on Windows, running a daemon on a Pi. Will not tolerate broken SSB or imprecise tuning.

## Success criterion

The author (Matthieu) reaches for Moshon SDR instead of SDR++ for 5 consecutive ham sessions. Everything else is bonus.

## Non-goals (explicit)

- Be everything SDR++ is. We are not. We're the *browser* alternative for hams.
- Support every dongle. We support RTL-SDR + HackRF in v1; everything else is roadmap or "won't have".
- Solve transmit. Receive-only by design.
- Host receivers as a service. Bridge runs on the user's machine.
- Be a contest-ready logging app. Not our turf.

## Quality gates (each PR must clear these)

1. `pnpm -C web run check` (svelte-check + tsc) — green
2. `pnpm -C web run lint` — green
3. `pnpm -C web run test` — green
4. If `dsp/` changed: `(cd dsp && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo test)` — green. `--all-targets` matters — without it clippy skips test code (and CI catches it for you).
5. If `bridge/` changed: `go -C bridge test ./...` + `go vet ./...` — green
6. If user-visible: Playwright happy path passes (`pnpm -C web run test:e2e`)
7. If perf-relevant: include before/after numbers in PR description
8. Conventional commit messages
9. No new dependencies without a one-paragraph rationale in the PR

## Decision log

Decisions made before code was written. Don't relitigate without a docs PR.

| # | Decision | Source |
|---|---|---|
| D-001 | Svelte 5 over SolidJS/React | [TechDesign §1–§2](../docs/TechDesign-Moshon-SDR-MVP.md) |
| D-002 | Rust + WASM for DSP (not C++/Emscripten) | TechDesign §2 |
| D-003 | Go for the bridge daemon | TechDesign §1 |
| D-004 | MIT license (not AGPL/Apache) | PRD §1 |
| D-005 | Cloudflare Pages over GitHub Pages | TechDesign §10 (GH Pages can't do COOP/COEP) |
| D-006 | `webrtlsdr` as USB layer dependency | TechDesign §2 |
| D-007 | Drop SDRplay from v1 | Research §2, PRD §5 |
| D-008 | Defer LoRa to v2 | Research §2, PRD §5 |
| D-009 | Drop multi-VFO from v1 | PRD §5 |
| D-010 | Bridge ships as Go binaries via GoReleaser | TechDesign §8 |
| D-011 | URL hash carries tuning state only — never bridge addresses | TechDesign §6 |
| D-012 | No analytics, no telemetry, no PII in v1 | TechDesign §12 |
| D-013 | "Modern minimal" UI (Linear/Vercel-adjacent) | PRD §7 |
| D-014 | Tuning UX is keyboard-first AND mouse/dial — equal weight | PRD §4 (US-4, US-5) |

## Risks we're actively watching

| Risk | Trigger | Response |
|---|---|---|
| Performance budget breach (>11 ms/block) | Any DSP change | Profile, optimize, or revert |
| WebUSB latency causing SSB artifacts | First SSB tests | Ring buffer size tuning, AudioWorklet priority |
| BrowSDR releases the killer feature we wanted | Any time | Focus on *our* differentiators (network IQ, URL share, ham focus) |
| Scope creep toward LoRa/SDRplay/transmit | Author enthusiasm | Re-read this brief |

## Definition of Done — v0.1.0 (M1)

See [docs/PRD-Moshon-SDR-MVP.md §11](../docs/PRD-Moshon-SDR-MVP.md). Don't tag `v0.1.0` until every checkbox is real.

## How to navigate this repo

- **What and why** → `docs/`
- **How** → `AGENTS.md`, `agent_docs/`, source code
- **What's next** → roadmap in `AGENTS.md`
- **What's persistent across sessions** → `MEMORY.md`
