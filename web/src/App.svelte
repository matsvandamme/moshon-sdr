<script lang="ts">
  import { Radio, CircleCheck, CircleAlert, Loader2 } from 'lucide-svelte';
  import { onMount } from 'svelte';

  type WasmStatus = 'pending' | 'ready' | 'error';

  let wasmStatus = $state<WasmStatus>('pending');
  let wasmError = $state<string | null>(null);
  let smokeResult = $state<number | null>(null);

  onMount(async () => {
    try {
      // B1 smoke test: load the DSP WASM module and call a known export.
      // The real module lives in dsp/ and is built via `pnpm run wasm:build`.
      // Until B3 wires it up, we surface a friendly "pending" state.
      const mod = await import('./lib/dsp/wasm-placeholder');
      smokeResult = mod.smoke();
      wasmStatus = 'ready';
    } catch (err) {
      wasmStatus = 'error';
      wasmError = err instanceof Error ? err.message : String(err);
    }
  });
</script>

<main class="min-h-full flex flex-col items-center justify-center px-6 text-center">
  <div class="flex items-center gap-3 text-(--color-accent)">
    <Radio size={32} strokeWidth={1.5} />
    <h1 class="text-3xl font-medium tracking-tight">Moshon SDR</h1>
  </div>

  <p class="mt-3 text-neutral-400 max-w-md">
    A ham's SDR receiver. In your browser. No install.
  </p>

  <div
    class="mt-10 inline-flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm"
  >
    {#if wasmStatus === 'pending'}
      <Loader2 size={16} class="animate-spin text-neutral-400" />
      <span class="text-neutral-400">Loading DSP module…</span>
    {:else if wasmStatus === 'ready'}
      <CircleCheck size={16} class="text-emerald-400" />
      <span class="text-neutral-200">
        DSP module ready — smoke test returned <span class="text-(--color-accent)">{smokeResult}</span>
      </span>
    {:else}
      <CircleAlert size={16} class="text-amber-400" />
      <span class="text-amber-400">DSP module failed to load: {wasmError}</span>
    {/if}
  </div>

  <p class="mt-12 text-xs text-neutral-500 max-w-lg">
    Pre-alpha. Scaffolding in progress. Next milestones: B3 (RTL-SDR WebUSB driver),
    B4 (DSP worker + waterfall), B5–B9.
    <br />
    <a
      href="https://github.com/matsvandamme/moshon-sdr/blob/main/AGENTS.md"
      class="underline decoration-dotted hover:text-(--color-accent)"
      target="_blank"
      rel="noreferrer">Roadmap</a
    >
  </p>
</main>
