# REVIEW-CHECKLIST.md

Run through this before opening a PR or hitting "merge". Most checks are mechanical — let CI catch them — but the *Judgment* section needs human (or careful agent) thought.

## Mechanical (CI handles these; verify they actually ran)

- [ ] `pnpm -C web run check` — svelte-check + tsc, zero warnings
- [ ] `pnpm -C web run lint` — ESLint + Prettier, zero warnings
- [ ] `pnpm -C web run test` — Vitest, all green
- [ ] If `dsp/` changed: `cargo -C dsp test` + `clippy -- -D warnings`
- [ ] If `bridge/` changed: `go -C bridge test ./...` + `go vet ./...`
- [ ] If user-visible: Playwright happy path passes (`pnpm -C web run test:e2e`)
- [ ] No new dependencies without a one-paragraph rationale in PR description
- [ ] Bundle size still under 500 KB gzipped (for main path)

## Scope discipline

- [ ] PR touches only one milestone (B1–B9 or M2/M3 item)
- [ ] No drive-by changes unrelated to the milestone
- [ ] No "while I'm here" refactors mixed with feature code (separate PRs)
- [ ] Commit messages are Conventional Commits with scope tag

## Strict rules — verify none are violated

- [ ] No AGPL-licensed code or AGPL-derived patterns added
- [ ] No transmit code path introduced
- [ ] No SDRplay-specific code introduced
- [ ] No LoRa demod (or chirp spread spectrum primitives reusable for it) in v1
- [ ] No analytics, telemetry, or PII collection
- [ ] No new backend service we'd have to operate
- [ ] `git push --force` not used on `main`

## Performance

- [ ] If touching DSP: ran `pnpm -C web run bench`; numbers in PR description
- [ ] Total per-block stays under 11 ms at 2.4 MS/s
- [ ] No new allocations in hot loops (DSP)
- [ ] No `setInterval` for animations (use `requestAnimationFrame`)

## Documentation

- [ ] README updated if user-facing setup changed
- [ ] If a decision was made during implementation: logged in [MEMORY.md](MEMORY.md)
- [ ] If architecture changed: PR to update [docs/TechDesign-Moshon-SDR-MVP.md](docs/TechDesign-Moshon-SDR-MVP.md) (separate PR)
- [ ] No undocumented breaking changes to URL hash codec (would break shareable links)
- [ ] No undocumented changes to bridge protocol (would break existing bridge binaries)

## Security

- [ ] No secrets/tokens committed (scan via `git diff` before push)
- [ ] No new permissions requested from the browser without UI explanation
- [ ] CORS settings on bridge daemon unchanged or justified
- [ ] localStorage keys namespaced under `moshon:` only

## Judgment (the part CI can't help with)

- [ ] Does this PR move us toward the success criteria (S1–S5)?
- [ ] Did I take the simplest approach? Is there a 30-LOC version I'm not seeing?
- [ ] Are the abstractions earning their keep, or am I generalizing prematurely?
- [ ] Would a fresh agent reading this code in 3 months understand it without context?
- [ ] Is anything in this PR a workaround that should be a `TODO` + issue?
- [ ] Is the test coverage *meaningful* (asserts behavior) or *cosmetic* (asserts trivially-true)?

## Before merging to main

- [ ] All CI checks green
- [ ] No "blocked-by" notes in PR description
- [ ] Squash-merge or rebase-merge (keep `main` linear)
- [ ] Tag if it's a milestone completion: `v0.X.Y` for web, `bridge-v0.X.Y` for the daemon
