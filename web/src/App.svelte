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
  import {
    SpectrumRenderer,
    WaterfallRenderer,
    type ColormapName,
  } from './lib/visualizer/spectrum-waterfall';

  // ---- WASM smoke (B1) ----
  type WasmStatus = 'pending' | 'ready' | 'error';
  let wasmStatus = $state<WasmStatus>('pending');
  let wasmError = $state<string | null>(null);
  let smokeResult = $state<number | null>(null);

  // ---- RTL-SDR (B3 + B4) ----
  const SAMPLE_RATE = 2_400_000;
  const CENTER_FREQ = 100_000_000; // 100 MHz — FM broadcast band
  const FFT_SIZE = 2048;
  const FFT_RATE_HZ = 30;

  const SPECTRUM_W = 1024;
  const SPECTRUM_H = 200;
  const WATERFALL_W = 1024;
  const WATERFALL_H = 400;

  const source = new RtlSdrSource();

  let rtlStatus = $state<RtlSdrStatus>('idle');
  let rtlError = $state<string | null>(null);
  let bytesWritten = $state(0);
  let bytesDropped = $state(0);
  let streamStartMs = $state<number | null>(null);
  let elapsedMs = $state(0);
  let fftFramesRendered = $state(0);

  let dbMin = $state(-100);
  let dbMax = $state(-20);
  let colormap = $state<ColormapName>('viridis');

  let spectrumCanvas: HTMLCanvasElement | undefined = $state();
  let waterfallCanvas: HTMLCanvasElement | undefined = $state();
  let spectrumRenderer: SpectrumRenderer | null = null;
  let waterfallRenderer: WaterfallRenderer | null = null;

  let latestBins: Float32Array | null = null;
  let rafHandle = 0;
  let unsubStats: (() => void) | null = null;
  let unsubFft: (() => void) | null = null;

  // ---- Lifecycle ----

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

  // Wire renderers once the canvases land in the DOM, and re-wire if dbMin/
  // dbMax/colormap change.
  $effect(() => {
    if (spectrumCanvas && !spectrumRenderer) {
      spectrumRenderer = new SpectrumRenderer(spectrumCanvas, { dbMin, dbMax });
    }
    if (waterfallCanvas && !waterfallRenderer) {
      waterfallRenderer = new WaterfallRenderer(waterfallCanvas, { dbMin, dbMax, colormap });
    }
  });

  $effect(() => {
    spectrumRenderer?.setRange(dbMin, dbMax);
    waterfallRenderer?.setRange(dbMin, dbMax);
  });

  $effect(() => {
    waterfallRenderer?.setColormap(colormap);
  });

  onDestroy(() => {
    cancelAnimationFrame(rafHandle);
    unsubStats?.();
    unsubFft?.();
    void source.disconnect();
  });

  // ---- Render loop ----

  function tick() {
    if (streamStartMs !== null) {
      elapsedMs = performance.now() - streamStartMs;
    }
    if (latestBins) {
      spectrumRenderer?.draw(latestBins);
      waterfallRenderer?.push(latestBins);
      latestBins = null;
      fftFramesRendered++;
    }
    rafHandle = requestAnimationFrame(tick);
  }

  // ---- Button actions ----

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
    bytesWritten = 0;
    bytesDropped = 0;
    fftFramesRendered = 0;
    streamStartMs = performance.now();
    elapsedMs = 0;

    unsubStats?.();
    unsubFft?.();
    unsubStats = source.onStats((s) => {
      bytesWritten = s.bytesWritten;
      bytesDropped = s.bytesDropped;
    });
    unsubFft = source.onFft((evt) => {
      // Keep only the latest frame; the rAF tick drains it. If FFTs arrive
      // faster than rAF, intermediate frames are dropped (intentional).
      latestBins = evt.bins;
    });

    rafHandle = requestAnimationFrame(tick);

    try {
      rtlStatus = 'streaming';
      await source.start({
        sampleRate: SAMPLE_RATE,
        centerFreq: CENTER_FREQ,
        gain: null,
        fftSize: FFT_SIZE,
        fftRateHz: FFT_RATE_HZ,
      });
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
      cancelAnimationFrame(rafHandle);
      unsubStats?.();
      unsubFft?.();
      unsubStats = null;
      unsubFft = null;
    }
  }

  async function onStop() {
    cancelAnimationFrame(rafHandle);
    rtlStatus = 'closing';
    try {
      await source.stop();
      await source.disconnect();
      rtlStatus = 'idle';
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
    } finally {
      unsubStats?.();
      unsubFft?.();
      unsubStats = null;
      unsubFft = null;
    }
  }

  async function onDisconnect() {
    cancelAnimationFrame(rafHandle);
    unsubStats?.();
    unsubFft?.();
    unsubStats = null;
    unsubFft = null;
    rtlStatus = 'closing';
    try {
      await source.disconnect();
      rtlStatus = 'idle';
      bytesWritten = 0;
      bytesDropped = 0;
      fftFramesRendered = 0;
      streamStartMs = null;
      elapsedMs = 0;
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- Derived display values ----

  const BYTES_PER_SAMPLE = 2;
  let samplesTotal = $derived(bytesWritten / BYTES_PER_SAMPLE);
  let rateMSps = $derived(
    elapsedMs > 0 ? samplesTotal / 1e6 / (elapsedMs / 1000) : 0,
  );
  let renderFps = $derived(
    elapsedMs > 0 ? fftFramesRendered / (elapsedMs / 1000) : 0,
  );

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
</script>

<main class="min-h-full flex flex-col items-center px-4 py-8 gap-6">
  <header class="text-center">
    <div class="flex items-center gap-3 text-(--color-accent) justify-center">
      <Radio size={32} strokeWidth={1.5} />
      <h1 class="text-3xl font-medium tracking-tight">Moshon SDR</h1>
    </div>
    <p class="mt-2 text-neutral-400 max-w-md">
      A ham's SDR receiver. In your browser. No install.
    </p>
    <div
      class="mt-4 inline-flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs"
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
  </header>

  <section
    class="w-full max-w-5xl rounded-lg border border-neutral-800 bg-neutral-950/60 p-5"
  >
    <header class="flex items-center justify-between mb-4">
      <h2 class="text-sm font-medium text-neutral-300 uppercase tracking-wide">
        RTL-SDR (WebUSB) · Spectrum &amp; Waterfall
      </h2>
      <span class="font-mono text-xs text-neutral-500">B3 · B4 · M1.1–1.4</span>
    </header>

    {#if rtlStatus === 'idle'}
      <p class="text-sm text-neutral-400 mb-4">
        Plug in an RTL-SDR Blog v3/v4 dongle and click Connect.
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
      <dl class="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 mb-4 text-sm font-mono">
        <div>
          <dt class="text-neutral-500 text-xs">Center</dt>
          <dd class="text-neutral-200">{formatHz(CENTER_FREQ)}</dd>
        </div>
        <div>
          <dt class="text-neutral-500 text-xs">Sample rate</dt>
          <dd class="text-neutral-200">{(SAMPLE_RATE / 1e6).toFixed(3)} MS/s</dd>
        </div>
        <div>
          <dt class="text-neutral-500 text-xs">FFT</dt>
          <dd class="text-neutral-200">{FFT_SIZE} bins · {FFT_RATE_HZ} Hz</dd>
        </div>
        <div>
          <dt class="text-neutral-500 text-xs">Gain</dt>
          <dd class="text-neutral-200">AGC</dd>
        </div>
      </dl>

      <div class="rounded-md overflow-hidden border border-neutral-800 mb-4 bg-black">
        <canvas
          bind:this={spectrumCanvas}
          width={SPECTRUM_W}
          height={SPECTRUM_H}
          class="block w-full"
          style="aspect-ratio: {SPECTRUM_W} / {SPECTRUM_H}"
        ></canvas>
        <canvas
          bind:this={waterfallCanvas}
          width={WATERFALL_W}
          height={WATERFALL_H}
          class="block w-full"
          style="aspect-ratio: {WATERFALL_W} / {WATERFALL_H}"
        ></canvas>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 text-xs font-mono">
        <label class="flex flex-col gap-1">
          <span class="text-neutral-500 uppercase">Colormap</span>
          <select
            bind:value={colormap}
            class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200"
          >
            <option value="viridis">Viridis</option>
            <option value="magma">Magma</option>
            <option value="classic">Classic</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-neutral-500 uppercase">dB min ({dbMin})</span>
          <input
            type="range"
            min="-120"
            max="-40"
            step="1"
            bind:value={dbMin}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-neutral-500 uppercase">dB max ({dbMax})</span>
          <input
            type="range"
            min="-60"
            max="0"
            step="1"
            bind:value={dbMax}
          />
        </label>
      </div>

      {#if rtlStatus === 'streaming' || (rtlStatus === 'closing' && bytesWritten > 0)}
        <dl
          class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4 rounded-md border border-neutral-800 bg-neutral-900 p-3 font-mono text-xs"
        >
          <div>
            <dt class="text-neutral-500">Received</dt>
            <dd class="text-(--color-accent) text-sm">{formatMSamples(samplesTotal)}</dd>
          </div>
          <div>
            <dt class="text-neutral-500">USB rate</dt>
            <dd class="text-neutral-200 text-sm">{rateMSps.toFixed(2)} MS/s</dd>
          </div>
          <div>
            <dt class="text-neutral-500">Render</dt>
            <dd class="text-neutral-200 text-sm">{renderFps.toFixed(1)} fps</dd>
          </div>
          <div>
            <dt class="text-neutral-500">Elapsed</dt>
            <dd class="text-neutral-200 text-sm">{(elapsedMs / 1000).toFixed(1)} s</dd>
          </div>
          <div>
            <dt class="text-neutral-500">Dropped</dt>
            <dd class="text-neutral-200 text-sm">{bytesDropped} B</dd>
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

  <p class="text-xs text-neutral-500 max-w-lg text-center">
    Pre-alpha · B4 complete · Next: B5 (tuning UI: keyboard + dial).
    <br />
    <a
      href="https://github.com/matsvandamme/moshon-sdr/blob/main/AGENTS.md"
      class="underline decoration-dotted hover:text-(--color-accent)"
      target="_blank"
      rel="noreferrer">Roadmap</a
    >
  </p>
</main>
