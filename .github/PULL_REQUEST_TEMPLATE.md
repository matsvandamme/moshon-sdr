## Summary
<!-- One paragraph: what changed and why. -->

## Test plan
- [ ] `pnpm -C web run check` passes
- [ ] `pnpm -C web run test` passes
- [ ] If `dsp/` changed: `cargo -C dsp test` + `cargo -C dsp clippy -- -D warnings` pass
- [ ] If `bridge/` changed: `go -C bridge test ./...` + `go vet ./...` pass
- [ ] Manual: <what you actually clicked, tuned, listened to>
- [ ] If perf-relevant: numbers before/after

## Linked
PRD: M1.X · Milestone: BX
