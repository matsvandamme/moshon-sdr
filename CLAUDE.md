# CLAUDE.md — Claude Code instructions

## Read first

**Always start with [AGENTS.md](AGENTS.md).** It contains the project plan, roadmap, performance budget, and the strict "What NOT to do" rules. Don't skip it.

Detailed context is in [agent_docs/](agent_docs/). Load files lazily — pull in `tech_stack.md` when you need a specific dependency version, `code_patterns.md` when you're writing new code, `testing.md` when you're touching tests, etc.

## Operating mode

This project is a 1-person OSS side project with a clear PRD and Tech Design. You should:

- **Be decisive.** The big choices are already made (Svelte 5, Rust→WASM, Go bridge, MIT, Cloudflare Pages). Don't relitigate them in commits.
- **Stay scoped to the current milestone.** The roadmap in AGENTS.md is the source of truth for "what's next". Don't drift into M2 features while M1 isn't done.
- **Move on small things; pause on big things.** Typo fix → just do it. Adding a new dependency → propose first and explain why.
- **Be brief in commits and PR descriptions.** Conventional Commits style. A one-line subject + 3 lines of body is usually enough.

## Critical rules (full list in AGENTS.md)

The five most likely to trip you up:

1. **Do not read BrowSDR's source.** AGPL contagion. Use `webrtlsdr` (Apache-2.0) or `rtlsdrjs` (MIT) instead.
2. **Performance budget: <11 ms per 1024-sample block** at 2.4 MS/s. Profile when in doubt.
3. **COOP/COEP headers must be present** in `web/public/_headers` and Vite dev config. Without them, SharedArrayBuffer breaks.
4. **No analytics / telemetry / PII** in v1.
5. **No `git push --force`** to main.

## Commands you'll run

```bash
# Web
pnpm -C web install
pnpm -C web run wasm:build
pnpm -C web run dev          # COOP/COEP-enabled dev server
pnpm -C web run check        # svelte-check + tsc
pnpm -C web run lint
pnpm -C web run test
pnpm -C web run test:e2e     # Playwright

# DSP (Rust) — cargo's -C flag is unstable; cd into dsp/ first
cd dsp; cargo test; cargo clippy -- -D warnings; cd ..

# Bridge (Go) — Go's -C is stable
go -C bridge test ./...
go -C bridge build -o ../dist/moshon-bridge ./
```

## Plan → Execute → Verify

Standard loop for multi-file changes:

1. Plan: state goal + files touched + adjacent rules from "What NOT to do"
2. Execute: one milestone per PR; don't combine
3. Verify: run the relevant commands above; commit only when green

For single-file or typo changes, plan is implicit.

## Style notes

- TypeScript strict, no `any`. Use `unknown` and narrow.
- Rust: `#![deny(clippy::pedantic)]` aspirational; at minimum `clippy -- -D warnings` must pass.
- Go: `gofmt` + `go vet`; idiomatic standard library where possible (no needless deps).
- Svelte 5 runes (`$state`, `$derived`, `$effect`) over legacy stores where it's cleaner.
- Tailwind 4 utility classes. No CSS-in-JS.
- No comments that just restate the code. Comments explain *why*.

## Memory & context

If you need to remember something across sessions (project decisions, gotchas, weird workarounds), write it to [MEMORY.md](MEMORY.md). Don't bloat AGENTS.md with transient state.

The auto-memory system (in `~/.claude/projects/...`) is separate and managed automatically — use that for user/feedback/reference memories about Matthieu, not for project state.

## When in doubt

Read PRD → Tech Design → research, in that order. If the answer still isn't there, ask in chat. Don't guess on regulatory, license, or architectural questions.
