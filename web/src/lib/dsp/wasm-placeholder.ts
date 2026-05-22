/**
 * Placeholder DSP module for the B1 smoke test.
 *
 * Once the real Rust→WASM crate at `dsp/` is built via `pnpm run wasm:build`,
 * this file is replaced by the generated bindings at `web/src/lib/dsp/wasm/`.
 * Until then, this stub exists only so App.svelte's smoke test has something
 * to import and call.
 *
 * Remove this file once the real WASM bindings are wired up (planned: B3/B4).
 */

export function smoke(): number {
  // Returns a deterministic value the UI can echo to prove the import worked.
  return 42;
}
