# MEMORY.md — Project memory

Long-running notes that should survive across sessions but don't belong in the formal docs.

> **Not a substitute for docs.** Architecture goes in [docs/](docs/). Code conventions in [agent_docs/](agent_docs/). This file is for *transient but persistent* things: half-done explorations, calibration measurements, weird gotchas, deferred decisions.

---

## Project state snapshot

**As of 2026-05-22:**

- Phase: end of Step 4 (Agent Config) in the vibe-coding workflow.
- Repo: https://github.com/matsvandamme/moshon-sdr (private).
- Code: none yet. Only docs.
- Next milestone: **B1 — Project scaffold.**
- Hardware on hand: (to be confirmed by author)

## Open empirical questions (resolve in code, not in docs)

- [ ] S-meter calibration for RTL-SDR v3 vs v4 — measure on a known reference signal once we have receive working
- [ ] WFM RDS — implement in M1 alongside WFM, or punt to M2? Re-decide after B6.
- [ ] Does Vite dev server respect `_headers`-style files, or do we need the explicit `server.headers` config? (TechDesign assumes the explicit config; verify in B2.)
- [ ] Confirm `webrtlsdr` Apache-2.0 license claim from the README — read `LICENSE` file once the dependency is in `package.json`.

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
