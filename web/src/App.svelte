<script lang="ts">
  import {
    Radio,
    CircleCheck,
    CircleAlert,
    Loader2,
    Plug,
    Play,
    Square,
    Unplug,
  } from 'lucide-svelte';
  import { onMount, onDestroy } from 'svelte';
  import init, { smoke } from './lib/dsp/wasm/moshon_dsp.js';
  import { RtlSdrSource, type RtlSdrStatus } from './lib/usb/rtlsdr-source';

  // ---- WASM smoke test (B1) ----
  type WasmStatus = 'pending' | 'ready' | 'error';
  let wasmStatus = $state<WasmStatus>('pending');
  let wasmError = $state<string | null>(null);
  let smokeResult = $state<number | null>(null);

  // ---- RTL-SDR (B3) ----
  const SAMPLE_RATE = 2_400_000;
  const CENTER_FREQ = 100_000_000; // 100 MHz — FM broadcast band
  const BYTES_PER_SAMPLE = 2; // 8-bit I + 8-bit Q

  const source = new RtlSdrSource();
  let rtlStatus = $state<RtlSdrStatus>('idle');
  let rtlError = $state<string | null>(null);
  let samplesTotal = $state(0); // running count of IQ samples received
  let streamStartMs = $state<number | null>(null); // timestamp of stream start
  let elapsedMs = $state(0); // ticked from rAF for live display
  let rafHandle = 0;
  let unsubscribeSamples: (() => void) | null = null;

  onMount(async () => {
    try {
      await init();
      smokeResult = smoke();
      wasmStatus = 'ready';
    } catch (err) {
      wasmStatus = 'error';
      wasmError = err instanceof Error ? err.message : String(err);
    }
  });

  onDestroy(() => {
    cancelAnimationFrame(rafHandle);
    void source.disconnect();
  });

  function tickElapsed() {
    if (streamStartMs !== null) {
      elapsedMs = performance.now() - streamStartMs;
    }
    rafHandle = requestAnimationFrame(tickElapsed);
  }

  async function onConnect() {
    rtlError = null;
    rtlStatus = 'connecting';
    try {
      await source.connect();
      rtlStatus = 'connected';
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onStart() {
    rtlError = null;
    samplesTotal = 0;
    streamStartMs = performance.now();
    elapsedMs = 0;

    unsubscribeSamples?.();
    unsubscribeSamples = source.onSamples((evt) => {
      samplesTotal += evt.data.byteLength / BYTES_PER_SAMPLE;
    });

    rafHandle = requestAnimationFrame(tickElapsed);

    try {
      rtlStatus = 'streaming';
      await source.start({
        sampleRate: SAMPLE_RATE,
        centerFreq: CENTER_FREQ,
        gain: null, // AGC
      });
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
      unsubscribeSamples?.();
      unsubscribeSamples = null;
      cancelAnimationFrame(rafHandle);
    }
  }

  async function onStop() {
    cancelAnimationFrame(rafHandle);
    rtlStatus = 'closing';
    try {
      await source.stop();
      // After stop, the device stays open but the worker no longer holds a
      // reference we can re-use. Treat stop+restart as a full re-connect.
      await source.disconnect();
      rtlStatus = 'idle';
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribeSamples?.();
      unsubscribeSamples = null;
    }
  }

  async function onDisconnect() {
    cancelAnimationFrame(rafHandle);
    unsubscribeSamples?.();
    unsubscribeSamples = null;
    rtlStatus = 'closing';
    try {
      await source.disconnect();
      rtlStatus = 'idle';
      samplesTotal = 0;
      streamStartMs = null;
      elapsedMs = 0;
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
    }
  }

  function formatHz(hz: number): string {
    if (hz >= 1e9) return `${(hz / 1e9).toFixed(3)} GHz`;
    if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
    if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`;
    return `${hz} Hz`;
  }

  function formatMSamples(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MS`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kS`;
    return `${n} S`;
  }

  let rateMSps = $derived(
    elapsedMs > 0 ? (samplesTotal / 1e6) / (elapsedMs / 1000) : 0
  );
</script>

<main class="min-h-full flex flex-col items-center justify-center px-6 py-10 text-center gap-8">
  <div>
    <div class="flex items-center gap-3 text-(--color-accent)">
      <Radio size={32} strokeWidth={1.5} />
      <h1 class="text-3xl font-medium tracking-tight">Moshon SDR</h1>
    </div>
    <p class="mt-3 text-neutral-400 max-w-md">
      A ham's SDR receiver. In your browser. No install.
    </p>
  </div>

  <!-- WASM smoke test (B1) -->
  <div
    class="inline-flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs"
  >
    {#if wasmStatus === 'pending'}
      <Loader2 size={14} class="animate-spin text-neutral-400" />
      <span class="text-neutral-400">Loading DSP module…</span>
    {:else if wasmStatus === 'ready'}
      <CircleCheck size={14} class="text-emerald-400" />
      <span class="text-neutral-300">
        DSP smoke test: <span class="text-(--color-accent)">{smokeResult}</span>
      </span>
    {:else}
      <CircleAlert size={14} class="text-amber-400" />
      <span class="text-amber-400">DSP failed: {wasmError}</span>
    {/if}
  </div>

  <!-- RTL-SDR (B3) -->
  <section
    class="w-full max-w-xl rounded-lg border border-neutral-800 bg-neutral-950/60 p-5 text-left"
  >
    <header class="flex items-center justify-between mb-4">
      <h2 class="text-sm font-medium text-neutral-300 uppercase tracking-wide">
        RTL-SDR (WebUSB)
      </h2>
      <span class="font-mono text-xs text-neutral-500">B3 · M1.1</span>
    </header>

    {#if rtlStatus === 'idle'}
      <p class="text-sm text-neutral-400 mb-4">
        Plug in an RTL-SDR Blog v3/v4 dongle, then click Connect. The browser
        will show a device picker — pick your dongle.
      </p>
      <button
        type="button"
        onclick={onConnect}
        class="inline-flex items-center gap-2 rounded-md bg-(--color-accent) text-neutral-950 px-4 py-2 text-sm font-medium hover:bg-(--color-accent-strong) cursor-pointer"
      >
        <Plug size={16} />
        Connect RTL-SDR
      </button>
    {:else if rtlStatus === 'connecting'}
      <div class="flex items-center gap-2 text-sm text-neutral-300">
        <Loader2 size={16} class="animate-spin" />
        Waiting for device picker…
      </div>
    {:else if rtlStatus === 'connected' || rtlStatus === 'streaming' || rtlStatus === 'closing'}
      <dl class="grid grid-cols-2 gap-x-6 gap-y-2 mb-4 text-sm font-mono">
        <dt class="text-neutral-500">Center frequency</dt>
        <dd class="text-neutral-200">{formatHz(CENTER_FREQ)}</dd>
        <dt class="text-neutral-500">Sample rate</dt>
        <dd class="text-neutral-200">{(SAMPLE_RATE / 1e6).toFixed(3)} MS/s</dd>
        <dt class="text-neutral-500">Gain</dt>
        <dd class="text-neutral-200">AGC</dd>
      </dl>

      {#if rtlStatus === 'streaming' || (rtlStatus === 'closing' && samplesTotal > 0)}
        <dl
          class="grid grid-cols-3 gap-2 mb-4 rounded-md border border-neutral-800 bg-neutral-900 p-3 font-mono text-sm"
        >
          <div>
            <dt class="text-xs text-neutral-500">Received</dt>
            <dd class="text-(--color-accent) text-base">{formatMSamples(samplesTotal)}</dd>
          </div>
          <div>
            <dt class="text-xs text-neutral-500">Rate</dt>
            <dd class="text-neutral-200 text-base">{rateMSps.toFixed(2)} MS/s</dd>
          </div>
          <div>
            <dt class="text-xs text-neutral-500">Elapsed</dt>
            <dd class="text-neutral-200 text-base">{(elapsedMs / 1000).toFixed(1)} s</dd>
          </div>
        </dl>
      {/if}

      <div class="flex gap-2">
        {#if rtlStatus === 'connected'}
          <button
            type="button"
            onclick={onStart}
            class="inline-flex items-center gap-2 rounded-md bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-500 cursor-pointer"
          >
            <Play size={16} />
            Start streaming
          </button>
        {:else if rtlStatus === 'streaming'}
          <button
            type="button"
            onclick={onStop}
            class="inline-flex items-center gap-2 rounded-md bg-amber-600 text-white px-4 py-2 text-sm font-medium hover:bg-amber-500 cursor-pointer"
          >
            <Square size={16} />
            Stop
          </button>
        {/if}
        <button
          type="button"
          onclick={onDisconnect}
          disabled={rtlStatus === 'closing'}
          class="inline-flex items-center gap-2 rounded-md border border-neutral-700 text-neutral-300 px-4 py-2 text-sm font-medium hover:border-neutral-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Unplug size={16} />
          Disconnect
        </button>
      </div>
    {:else if rtlStatus === 'error'}
      <div
        class="rounded-md border border-amber-700 bg-amber-950/30 p-3 mb-4 text-sm text-amber-300"
      >
        <div class="flex items-start gap-2">
          <CircleAlert size={16} class="mt-0.5 shrink-0" />
          <div>
            <p class="font-medium">Error</p>
            <p class="font-mono text-xs mt-1 break-words">{rtlError}</p>
          </div>
        </div>
      </div>
      <button
        type="button"
        onclick={() => {
          rtlStatus = 'idle';
          rtlError = null;
        }}
        class="inline-flex items-center gap-2 rounded-md border border-neutral-700 text-neutral-300 px-4 py-2 text-sm font-medium hover:border-neutral-500 cursor-pointer"
      >
        Reset
      </button>
    {/if}
  </section>

  <p class="text-xs text-neutral-500 max-w-lg">
    Pre-alpha · B3 complete · Next: B4 (DSP worker + waterfall).
    <br />
    <a
      href="https://github.com/matsvandamme/moshon-sdr/blob/main/AGENTS.md"
      class="underline decoration-dotted hover:text-(--color-accent)"
      target="_blank"
      rel="noreferrer">Roadmap</a
    >
  </p>
</main>
