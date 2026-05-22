# MEMORY.md — Project memory

Long-running notes that should survive across sessions but don't belong in the formal docs.

> **Not a substitute for docs.** Architecture goes in [docs/](docs/). Code conventions in [agent_docs/](agent_docs/). This file is for *transient but persistent* things: half-done explorations, calibration measurements, weird gotchas, deferred decisions.

---

## Project state snapshot

**As of 2026-05-22 (end of B1):**

- Phase: Step 5 (Build), B1 + B2 complete.
- Repo: https://github.com/matsvandamme/moshon-sdr (private).
- Subprojects scaffolded: `web/` (Svelte 5 + Vite + Tailwind 4), `dsp/` (Rust→WASM, builds via `wasm-pack`), `bridge/` (Go).
- End-to-end build verified locally: `pnpm -C web build` produces ~30 KB gzipped including a real WASM module that exports `smoke()`.
- End-to-end **deploy** verified at https://moshon-sdr.pages.dev — green "DSP module ready" badge confirms Rust→WASM→Vite→Cloudflare→browser pipeline works. COOP/COEP headers serving correctly.
- Toolchains installed on author's Win11 machine: Node 24, pnpm 11, Rust 1.95 + cargo, Go 1.26.3, wasm-pack 0.15, VS Build Tools 2022.
- Cloudflare Pages project `moshon-sdr` exists; deploy workflow self-bootstraps via `pages project create` (idempotent).
- Next milestone (at the time): B3 — has since been completed along with B4.

**As of B4b (deployed and live):**
- B3 + B4a + B4b shipped. Live at https://moshon-sdr.pages.dev.
- Hardware verified: SDR ADS-B dongle (R820T2) confirmed working — WebUSB → Worker → SAB → DSP worker → RustFFT → spectrum + waterfall.
- Nooelec Smartee XTR (E4000) NOT supported by `webrtlsdr` (R820/828/860 only). Future work.
- Deploy CI: API-probe project existence (no more red badges); ASCII `--commit-message` (Cloudflare rejects some Unicode in commit messages — keep commit subjects/bodies ASCII for clean deploys, OR use the explicit override in `.github/workflows/deploy.yml`).
- B4b known UI issue: colormap dropdown + dB sliders weren't visibly applying. Fixed by re-applying settings on every rAF tick instead of trusting `$effect` to fire when renderer instances (plain vars, not `$state`) aren't reactive deps.
- Next milestone: **B5 — tuning UI** (keyboard hotkeys: `F`/`M`/`B`/`G`/`,`/`.`/`[`/`]`/`Space`/`?`; mouse: click waterfall to set center, scroll-wheel fine-tune, virtual VFO dial; PRD says both paths must reach parity).

**As of B6a (live, audio working):**
- B5 + B6a shipped. https://moshon-sdr.pages.dev plays broadcast FM (WFM mono).
- Audio pipeline: Rust `WfmDemod` (2.4 MS/s → 240 kS/s IF via 10:1 windowed-sinc FIR → FM discriminator → 48 kS/s audio via 5:1 windowed-sinc FIR) → SAB-backed PCM ring → AudioWorklet (`web/public/audio-processor.js`) → speakers. AudioContext sample rate left at system default (no hard pin to 48 kHz — some systems reject that).
- Worklet telemetry: posts `{kind:'ready'}` on construction and `{kind:'stats'}` every ~100ms with `samplesPlayed`, `samplesUnderrun`, `ringUsedBytes`. UI shows a 4-cell row when streaming.
- **Svelte 5 reactivity gotcha** (bit me in B6a): `$effect(() => { if (audio.isReady) audio.setVolume(volume); })` short-circuits when `audio.isReady` is false on first run, never reads `volume`, never tracks it as a dep, becomes permanently dead. Fix: capture reactive state into a local FIRST, then gate. Pattern: `const v = volume; if (audio.isReady) audio.setVolume(v);`
- NFM/AM/SSB/CW are mode-cycle UI only — actual demod lands in B6b–B6d.
- Next milestone: **B6b** — NFM + AM demods (much simpler than WFM; single-stage envelope/quadrature demods on the existing channelizer chain).

**As of B6d (all modes live — B6 complete):**
- B6d shipped. `CwDemod` (Rust) gives CW its own demod path instead of the B6c fallback to narrow USB.
- Implementation: 127-tap channel filter at `bandwidth/2` cutoff (default 500 Hz BW = ±250 Hz around DC), then a fixed 700 Hz BFO mixer that shifts the (real audio = `Re{z·e^(+jω_bfo·t)}`) so a zero-beat carrier in IQ becomes an audible 700 Hz tone.
- Test pattern: synthesize a DC carrier in IQ, demod, count zero-crossings in the output. Expected crossings = `2·700·N/48000`, ±20% tolerance for transients.
- BFO offset is fixed at 700 Hz for now. Future B7+ work could expose it as a user-tunable parameter for pitch preference, but most CW ops are happy with 600-800 Hz.
- 127-tap filter at 240 kHz rate = ~30 M multiplies/sec for channel filtering. Well under budget for a single mode.
- All PRD M1.3 modes are now shipped: WFM mono, NFM, AM, USB, LSB, CW. Stereo WFM stays deferred to M2.
- Next milestone: **B7** — URL hash state + memory channels + IARU band overlay on spectrum + S-meter readout.

**As of B6c (SSB live):**
- B6c shipped. `SsbDemod` (Weaver method) handles both USB and LSB via a single struct with an `lsb: bool` constructor arg. Worker maps modes accordingly.
- Weaver chain at 48 kHz: shift desired sideband to DC via complex NCO at ±BW/2 → real-coefficient LPF at BW/2 (kills image sideband) → shift back → take Re{} for audio.
- Stage-2 channel filter cutoff is set to the full audio bandwidth (`bandwidth_hz`) instead of `bandwidth/2` like NFM/AM, because the Weaver LPF picks the sideband — the channel filter just needs to admit both possible sidebands.
- New utility: `ComplexFir` (non-decimating single-sample-API FIR for complex samples) — used by the Weaver LPF.
- Test pattern: a +1 kHz complex tone is in the USB passband. USB demod recovers it; LSB demod produces at least 6 dB lower amplitude on the same input. Same warm-up-pass trick as NFM (filter transients dominate one pass on a cold demod).
- CW (B6d) is the last remaining mode; currently falls back to a narrow USB.
- Next milestone: **B6d** — proper CW with BFO offset, narrow filter, optional auto-decode.

**As of B6b (NFM + AM live):**
- B6b shipped. `NfmDemod` (quadrature FM) and `AmDemod` (envelope + DC block) added to [dsp/src/lib.rs](dsp/src/lib.rs). Both share a two-stage channelizer: 2.4 MS/s → 240 kS/s (31-tap stage-1 LPF, same as WFM) → 48 kS/s (63-tap channel filter with cutoff at `bandwidth/2`).
- DSP worker now holds a single `Demod` slot and rebuilds it on a `setMode` message. `RtlSdrSource.setMode(mode, bandwidthHz)` exposes that to the UI. App.svelte fires it from a single `$effect` watching `tuning.mode` + `tuning.bandwidth`.
- Mode-switch is hot — no stream restart, no re-tune, audio resumes within a frame because the IQ ring keeps flowing while the new demod's filter history warms up.
- **NFM test gotcha**: discriminator atan2 output can swing ±π during the channel-filter transient (~63 taps = 1.3 ms at 48 kHz), so a single-pass test on a fresh demod shows max ≈ 9.6 (= π × audio_scale). Fix: warm with a discard pass first, then measure on the second pass. Same warm-up pattern the AM test already uses for DC-block convergence.
- SSB (`usb`/`lsb`) and CW still fall back to NFM at the worker level. UI mode labels are correct but the demodulator is wrong — fine for now, fixed in B6c–B6d.
- Next milestone: **B6c** — SSB via Weaver (USB/LSB). Adds a second low-rate mixer + Hilbert-like phasing inside the channelizer.

## Open empirical questions (resolve in code, not in docs)

- [ ] S-meter calibration for RTL-SDR v3 vs v4 — measure on a known reference signal once we have receive working
- [ ] WFM RDS — implement in M1 alongside WFM, or punt to M2? Re-decide after B6.
- [x] Does Vite dev server respect `_headers`-style files, or do we need the explicit `server.headers` config? **Resolved (B1): Vite needs explicit `server.headers` — `_headers` is Cloudflare-only. Both are configured now.**
- [x] Confirm `webrtlsdr` Apache-2.0 license claim. **Verified (B3): `web/node_modules/@jtarrio/webrtlsdr/LICENSE` is Apache-2.0, package.json confirms.**
- [ ] **E4000 tuner is not supported by `@jtarrio/webrtlsdr`** (R820/828/860 only). Nooelec Smartee XTR users would need a separate driver path. Defer to v2 or never — author can use their SDR ADS-B (R820T2) dongle for now.
- [ ] Track [wasm-pack#1442](https://github.com/rustwasm/wasm-pack/issues/1442) — once wasm-pack ships a newer bundled `wasm-opt`, re-enable wasm-opt in `dsp/Cargo.toml` for the ~5-10% size win.
- [x] **Cargo's `-C` flag is unstable on stable Rust 1.95.** Use `(cd dsp && cargo ...)` everywhere. Documented in all agent docs.

## Decisions log

When a decision is made *during implementation* (not in the docs), record it here with date + rationale. Sync into `docs/` if it materially affects the design.

| Date | Decision | Why | Affects |
|---|---|---|---|
| 2026-05-22 | Use `webrtlsdr` (Apache-2.0) instead of `rtlsdrjs` for the RTL-SDR USB layer | More actively maintained; cleaner TS types; spinoff of Google's `radioreceiver`. License is MIT-compatible. | B3 |
| 2026-05-22 | URL hash NEVER carries the bridge address | Privacy: bridge URLs may leak LAN/WAN info or auth context. | B7, B9 |
| 2026-05-22 | "Modern minimal" UI vibe, not retro/skeuomorphic | User pick. Easier to ship; matches Vercel/Linear aesthetic. | B5 |

## Gotchas to remember

- **COOP/COEP both required for SharedArrayBuffer.** Forgetting one silently breaks DSP perf. Verify in browser DevTools Network tab.
- **Vite dev server's `server.headers` config doesn't propagate to the preview server** — use `preview.headers` separately if you ever run `vite preview`.
- **Windows + RTL-SDR + WebUSB requires Zadig** to install the WinUSB driver. Document this clearly; can't fix it from the browser side.
- **AudioWorklet must be instantiated from the main thread** even though it runs on the audio thread. Init order matters.
- **Don't read [BrowSDR](https://github.com/jLynx/BrowSDR)'s source.** AGPL contagion. (Repeated in [AGENTS.md](AGENTS.md) but worth restating.)

## Calibration data (fill in as measured)

| Device | Tuner | Reference signal | dBFS reading | Inferred offset for S-meter |
|---|---|---|---|---|
| RTL-SDR Blog v4 | R828D | TBD | TBD | TBD |
| RTL-SDR Blog v3 | R820T2 | TBD | TBD | TBD |
| HackRF One | MAX2837 | TBD | TBD | TBD |

## Recent context (for fresh sessions)

If you're an agent picking up this project mid-stream and lack conversation context, read these in order:

1. [docs/PRD-Moshon-SDR-MVP.md](docs/PRD-Moshon-SDR-MVP.md) — what to build
2. [docs/TechDesign-Moshon-SDR-MVP.md](docs/TechDesign-Moshon-SDR-MVP.md) — how to build it
3. [AGENTS.md](AGENTS.md) — current state, roadmap, do-not rules
4. This file — for the latest moving pieces

Latest important context: **The author wants Moshon SDR to replace SDR++ for their personal ham radio use.** That's the success metric. OSS popularity is bonus.
