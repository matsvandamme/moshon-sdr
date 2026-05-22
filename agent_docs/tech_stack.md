# Tech Stack & Tools

Full details in [docs/TechDesign-Moshon-SDR-MVP.md](../docs/TechDesign-Moshon-SDR-MVP.md). This is the compressed reference for agents.

## Languages & toolchains

| Subproject | Language | Toolchain | Pin |
|---|---|---|---|
| `web/` | TypeScript | Node 22 LTS + pnpm 9 | `.nvmrc`, `package.json#engines` |
| `dsp/` | Rust (stable) | rustup + `wasm-pack` | `rust-toolchain.toml` |
| `bridge/` | Go | 1.23+ | `go.mod` |

## Web (`web/`)

| Library | Why |
|---|---|
| **Svelte 5** | Reactive single-page app; runes for state |
| **Vite** | Dev server + bundler; configurable headers for COOP/COEP |
| **TypeScript** strict | No `any`; type all module boundaries |
| **Tailwind CSS 4** | Modern minimal vibe; zero-config v4 |
| **lucide-svelte** | Icons (MIT) |
| **webrtlsdr** | RTL-SDR USB layer (Apache-2.0). Reuse — do not fork. |
| **Vitest** | Unit tests, esp. DSP TS bindings |
| **Playwright** | E2E happy-path test |
| **ESLint + Prettier + svelte-check** | Lint/format |

## DSP (`dsp/`)

| Crate | Why |
|---|---|
| `wasm-bindgen` | JS↔Rust bridge |
| `wasm-pack` | Build orchestration |
| `rustfft` | Best-in-class FFT, SIMD-128 in WASM |
| `web-sys` | SAB access from Rust |

Cargo.toml essentials:
```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
rustfft = "6"
js-sys = "0.3"
web-sys = { version = "0.3", features = ["SharedArrayBuffer"] }
```

## Bridge (`bridge/`)

| Module | Why |
|---|---|
| `net/http` + `nhooyr.io/websocket` | Standard, no heavy framework |
| `net` (TCP) | rtl_tcp client |
| GoReleaser | 6-platform binary release matrix |

Target list (GoReleaser):
- `darwin-amd64`, `darwin-arm64`
- `linux-amd64`, `linux-arm64`, `linux-arm`
- `windows-amd64`

## Hosting & deployment

- **Cloudflare Pages** — production + preview deploys
- **GitHub Releases** — bridge binaries via tag `bridge-v*`
- **Custom domain** — optional (`moshon-sdr.app` candidate)

## Required headers (Cloudflare Pages `_headers`)

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

Vite dev server (`vite.config.ts`):
```ts
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

## Error-handling pattern (TS)

Surface, don't swallow. Errors propagate to the UI as `ErrorState` objects, not toast-and-ignore.

```ts
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export async function tryClaimDevice(device: USBDevice): Promise<Result<void>> {
  try {
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
```

## Error-handling pattern (Rust DSP)

Use `thiserror` for crate-level errors; never `unwrap()` on input data; assertions OK for internal invariants.

```rust
#[derive(thiserror::Error, Debug)]
pub enum DspError {
    #[error("invalid sample rate: {0}")]
    InvalidSampleRate(u32),
    #[error("buffer too small: need {need}, got {got}")]
    BufferTooSmall { need: usize, got: usize },
}
```

## Component sketch (Svelte 5)

```svelte
<script lang="ts">
  import { Radio } from 'lucide-svelte';
  import { tuning } from '$lib/state/tuning.svelte';

  let { onTune }: { onTune: (hz: number) => void } = $props();
  let display = $derived(formatHz(tuning.freq));
</script>

<button
  type="button"
  class="flex items-center gap-2 rounded px-3 py-2 bg-neutral-900 hover:bg-neutral-800 font-mono"
  onclick={() => onTune(tuning.freq)}
>
  <Radio size={16} />
  {display}
</button>
```

## Versions

We **do not pin exact versions** in agent docs — the source of truth is `package.json` / `Cargo.toml` / `go.mod`. Match the live versions when generating examples.
