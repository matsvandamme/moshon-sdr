# Testing Strategy

## Philosophy

DSP correctness is hard to fake — tests are the safety net for the math.
UI correctness is mostly self-evident — one end-to-end happy path is enough.
This is a side project, not Google. We **don't** TDD. We **do** test the hard parts.

## What we test

| Layer | Tool | Coverage target |
|---|---|---|
| Rust DSP (`dsp/`) | `cargo test` + `cargo clippy` | High — every demod, filter, FFT path with synthesized IQ |
| TS bindings to WASM (`web/src/lib/dsp`) | Vitest | Boundary correctness — does WASM input/output round-trip cleanly? |
| TS pure logic (URL codec, memory channels, S-meter formula) | Vitest | High |
| Svelte components | None automated | Manual + Playwright happy path |
| Go bridge (`bridge/`) | `go test ./...` | High — byte-for-byte fidelity of WS↔TCP proxy |
| End-to-end | Playwright | One happy path: load app → network IQ source → spectrum shows signal |

## What we explicitly DON'T test

- Visual regression (no Chromatic/Percy — too heavy for a side project)
- Cross-browser matrix (we ship Chromium-only for full features)
- Load testing (no backend to load)
- WebUSB device tests in CI (no hardware in GitHub runners — manual only)
- Mobile in CI (manual Android Chrome pass before each release)

## DSP test pattern (Rust)

Synthesize a known signal, run it through the pipeline, assert spectral properties.

```rust
#[test]
fn fm_demod_recovers_1khz_tone() {
    // 1 kHz tone, FM-modulated at 75 kHz deviation, 240 kS/s
    let iq = synth::fm_tone(1_000.0, 75_000.0, 240_000, 4096);
    let mut audio = vec![0.0f32; 4096];
    fm::demodulate_wide(&iq, &mut audio, 240_000);

    let peak_bin = spectral::peak_frequency(&audio, 48_000);
    assert!((peak_bin - 1_000.0).abs() < 5.0, "expected 1 kHz, got {} Hz", peak_bin);
}
```

Rule of thumb: every demod must have one "recovers a known tone" test. Every filter must have one "blocks out-of-band" test.

## TS test pattern (Vitest)

```ts
import { describe, it, expect } from 'vitest';
import { encodeUrlState, decodeUrlState } from '$lib/state/url-codec';

describe('URL state codec', () => {
  it('round-trips a typical ham tuning', () => {
    const state = { freq: 14_230_000, mode: 'usb', bw: 2_400, sampleRate: 2_400_000, gain: 20 };
    const decoded = decodeUrlState(encodeUrlState(state));
    expect(decoded).toEqual(state);
  });

  it('produces hash under 120 chars', () => {
    const state = { freq: 14_230_000, mode: 'usb', bw: 2_400, sampleRate: 2_400_000, gain: 20 };
    expect(encodeUrlState(state).length).toBeLessThan(120);
  });
});
```

## Performance benchmarks

Not unit tests, but live behind a `pnpm -C web run bench` script. Run manually before any PR that touches DSP. Reports per-stage timing as a single line.

```
[bench] usb=0.4ms  channelize=3.1ms  fft=1.4ms  demod=1.7ms  audio=0.6ms  TOTAL=7.2ms (budget: 11ms) ✓
```

If a PR pushes any stage over budget, the PR description must include numbers and a justification.

## Bridge daemon tests (Go)

```go
func TestProxy_RoundTrip(t *testing.T) {
    fakeRtlTcp := newFakeRtlTcpServer(t)
    defer fakeRtlTcp.Close()

    bridge := startBridge(t, fakeRtlTcp.Addr)
    defer bridge.Close()

    client := wsDial(t, bridge.URL)
    defer client.Close()

    // Send rtl_tcp tune command
    cmd := []byte{0x01, 0x00, 0xE2, 0x95, 0xF0} // 14_900_000 Hz
    writeBinaryMessage(t, client, cmd)

    // Verify TCP side received it byte-for-byte
    received := fakeRtlTcp.WaitForBytes(t, len(cmd))
    if !bytes.Equal(received, cmd) {
        t.Fatalf("tune command corrupted: got %x, want %x", received, cmd)
    }
}
```

## E2E (Playwright)

One happy path. No more. Run in CI on Linux only.

```ts
test('loads, connects to mock rtl_tcp bridge, shows spectrum', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Network (rtl_tcp)' }).click();
  await page.getByLabel('Bridge URL').fill('ws://localhost:9091');  // bench fixture
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('canvas[data-role="spectrum"]')).toBeVisible();
  await page.waitForTimeout(2000); // let some FFT frames flow
  // Sanity: spectrum should have non-zero variance after data flows
  const variance = await page.evaluate(() => window.__moshon_perf?.spectrumVariance ?? 0);
  expect(variance).toBeGreaterThan(0);
});
```

The `window.__moshon_perf` probe is dev-mode-only and gated behind a Vite flag.

## CI integration

`.github/workflows/ci.yml` runs in matrix `[ubuntu-latest, windows-latest]`:

1. Install Node/pnpm/Rust (cached)
2. `pnpm -C web install --frozen-lockfile`
3. `pnpm -C web run wasm:build`
4. `pnpm -C web run check`
5. `pnpm -C web run lint`
6. `pnpm -C web run test`
7. `cargo -C dsp test`
8. `cargo -C dsp clippy -- -D warnings`
9. If `bridge/**` changed: `cd bridge && go test ./... && go vet ./...`
10. (Linux only) `pnpm -C web run test:e2e`

## Verification loop for each milestone

Don't mark a milestone complete until:

- [ ] All listed acceptance criteria from PRD §5 pass
- [ ] All CI checks green
- [ ] Manual smoke test for any UI-visible change
- [ ] Perf bench within budget (DSP-touching PRs only)
- [ ] No new `TODO`/`FIXME`/`XXX` without an accompanying issue

## Pre-commit (optional but recommended)

Husky + lint-staged is overkill for a side project. Use a simple `.git/hooks/pre-commit` instead:

```bash
#!/bin/sh
set -e
pnpm -C web run lint --silent
pnpm -C web run check --silent
```

Documented in README. Each contributor opts in by symlinking it.
