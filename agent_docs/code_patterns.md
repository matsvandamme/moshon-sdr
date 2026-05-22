# Code Patterns

## Repository layout

```
moshon-sdr/
├── web/                 # Svelte 5 SPA
│   ├── src/
│   │   ├── lib/
│   │   │   ├── usb/       # WebUSB drivers (rtl-sdr, hackrf-m2)
│   │   │   ├── net/       # rtl_tcp WebSocket client
│   │   │   ├── dsp/       # TS bindings to WASM
│   │   │   ├── audio/     # AudioWorklet glue
│   │   │   ├── state/     # tuning, settings, memory channels
│   │   │   └── ui/        # Svelte components
│   │   ├── workers/       # usb-worker.ts, dsp-worker.ts, audio-worklet.ts
│   │   └── App.svelte
│   ├── public/_headers    # COOP/COEP
│   └── vite.config.ts
├── dsp/                 # Rust crate
│   ├── src/
│   │   ├── lib.rs          # wasm-bindgen exports
│   │   ├── fft.rs
│   │   ├── channelize.rs
│   │   ├── filter.rs
│   │   ├── meter.rs
│   │   └── demod/
│   └── tests/
├── bridge/              # Go daemon
│   ├── main.go
│   ├── proxy.go
│   └── .goreleaser.yaml
├── docs/                # PRD, Tech Design, research, decisions
├── agent_docs/          # this directory
└── .github/workflows/   # ci, deploy, bridge-release, claude-review
```

## Naming

**Files:**
- TS/Svelte: `kebab-case.ts`, `PascalCase.svelte` for components, `kebab-case.svelte` for views
- Rust: `snake_case.rs`
- Go: `snake_case.go` or `lowercase.go` (idiomatic)

**Identifiers:**
- TS: `camelCase` vars/fns, `PascalCase` types, `SCREAMING_SNAKE` constants
- Rust: `snake_case` everywhere except types (`PascalCase`) and consts (`SCREAMING_SNAKE`)
- Go: `camelCase` (unexported) / `PascalCase` (exported)

**Domain names — use these consistently:**

| Concept | Name |
|---|---|
| Sample rate (Hz) | `sampleRate` (TS), `sample_rate` (Rust), `SampleRate` (Go) |
| Center frequency (Hz) | `centerFreq` |
| Tuning offset within IF | `ifOffset` |
| Mode | `'wfm' \| 'nfm' \| 'am' \| 'usb' \| 'lsb' \| 'cw'` |
| Bandwidth (Hz) | `bandwidth` |
| Bins (FFT output) | `bins` |
| dBFS (relative to full scale) | `dbfs` |

## TypeScript

- `strict: true`. No `any`, no implicit any. Use `unknown` + narrowing.
- No default exports (named only).
- Prefer `type` over `interface` for object shapes; use `interface` for things that get extended.
- No `enum` — use `as const` unions:
  ```ts
  export const MODES = ['wfm', 'nfm', 'am', 'usb', 'lsb', 'cw'] as const;
  export type Mode = (typeof MODES)[number];
  ```
- Result types over throwing for expected failures (see [tech_stack.md](tech_stack.md)).
- Async work belongs in `lib/`, not in components. Components render and dispatch.

## Svelte 5

- Use runes (`$state`, `$derived`, `$effect`, `$props`) for new components.
- One reactive store per concern; do not combine unrelated state.
- State files live in `src/lib/state/`, exported as factories:
  ```ts
  // src/lib/state/tuning.svelte.ts
  function createTuning() {
    let freq = $state(7074000);
    let mode = $state<Mode>('usb');
    return {
      get freq() { return freq; },
      set freq(v) { freq = v; },
      get mode() { return mode; },
      set mode(v) { mode = v; },
    };
  }
  export const tuning = createTuning();
  ```
- URL hash sync lives in a single `$effect` at app root, not scattered.
- Components: `<script>` first, markup, scoped `<style>` only if Tailwind can't express it.

## Rust (DSP)

- `#![forbid(unsafe_code)]` in `lib.rs`, lift selectively where SAB requires it.
- `clippy -- -D warnings` is the floor; `clippy::pedantic` aspirational.
- No `unwrap` on input data; use `?` with a typed error (`thiserror`).
- Allocations during hot DSP loop are a perf bug — preallocate, reuse.
- Public WASM-exposed functions:
  ```rust
  #[wasm_bindgen]
  pub fn fft_2048(input: &[f32], output: &mut [f32]) -> Result<(), JsError> {
      // ...
  }
  ```

## Go (bridge)

- `gofmt` enforced via CI; non-negotiable.
- Standard library first. Single allowed external dep: `nhooyr.io/websocket`.
- Flags via the standard `flag` package. No Cobra/Viper.
- Errors are returned, not panicked, except in `main()` initialization.
- Log to stderr with `log.Printf` (no structured logger needed at this size).

## Worker / WASM boundary

- Streaming data: SharedArrayBuffer ring buffers. Single producer, single consumer per ring.
- Control messages: `postMessage` with typed `Cmd` discriminated unions.
- Never `transferOwnership` for streams — re-allocate cost > SAB overhead.

## Commit messages (Conventional Commits)

Format: `<type>(<scope>): <subject>`

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`.

Scopes (prefer these): `web`, `dsp`, `bridge`, `ci`, `docs`.

Subject: imperative, lowercase, no period, ≤72 chars.

Body (optional): wrap at 72; explain *why*, not *what*; reference milestone ID (`B6`) and PRD requirement (`M1.7`) where relevant.

Examples:
```
feat(web): URL-hash sync for tuning state (B7, M1.9)

Encode freq/mode/bw/sr/gain in location.hash; bidirectional sync.
Debounced 200ms to avoid history spam during tuning.
```

```
perf(dsp): switch FFT plan cache to per-size HashMap

Reduces alloc churn at mode-switch time. Profiled: -3ms p99
at 2048 bin on author's i7-1165G7.
```

## PR descriptions

Three sections, always:

```markdown
## Summary
One paragraph: what changed and why.

## Test plan
- [ ] `pnpm -C web run check` passes
- [ ] `pnpm -C web run test` passes
- [ ] `(cd dsp && cargo test)` passes
- [ ] Manual: <what you actually clicked/tuned/listened to>
- [ ] If perf-relevant: numbers before/after

## Linked
PRD: M1.X · Milestone: BX
```

## Anti-patterns (do not do these)

- Reaching into Svelte component internals via DOM queries
- Catching errors and rethrowing as `Error` (lose stack)
- `setInterval` for animation (use `requestAnimationFrame`)
- `JSON.parse` inside hot DSP path
- Importing AGPL libraries (license check is part of `pnpm install` story)
- Bundling untranspiled BigInt math in WASM exports (Safari/Chrome divergence)
