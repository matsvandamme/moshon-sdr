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
    Keyboard,
    Volume2,
    VolumeX,
  } from 'lucide-svelte';
  import { onMount, onDestroy } from 'svelte';
  import init, { smoke } from './lib/dsp/wasm/moshon_dsp.js';
  import { RtlSdrSource, type RtlSdrStatus } from './lib/usb/rtlsdr-source';
  import type { ColormapName } from './lib/visualizer/spectrum-waterfall';
  import {
    tuning,
    formatHz,
    MODE_INFO,
    GAIN_STEPS,
  } from './lib/state/tuning.svelte';
  import HotkeyHelp from './lib/ui/HotkeyHelp.svelte';
  import FrequencyEntry from './lib/ui/FrequencyEntry.svelte';
  import VfoDial from './lib/ui/VfoDial.svelte';
  import SpectrumWaterfall from './lib/ui/SpectrumWaterfall.svelte';
  import { AudioPipeline } from './lib/audio/audio-pipeline';

  // ---- WASM smoke (B1) ----
  type WasmStatus = 'pending' | 'ready' | 'error';
  let wasmStatus = $state<WasmStatus>('pending');
  let wasmError = $state<string | null>(null);
  let smokeResult = $state<number | null>(null);

  // ---- RTL-SDR fixed config ----
  const SAMPLE_RATE = 2_400_000;
  const FFT_SIZE = 2048;
  const FFT_RATE_HZ = 30;

  const source = new RtlSdrSource();
  const audio = new AudioPipeline();
  let volume = $state(0.6);

  let rtlStatus = $state<RtlSdrStatus>('idle');
  let rtlError = $state<string | null>(null);
  let bytesWritten = $state(0);
  let bytesDropped = $state(0);
  let streamStartMs = $state<number | null>(null);
  let elapsedMs = $state(0);
  let fftFramesRendered = $state(0);

  let dbMin = $state(-80);
  let dbMax = $state(-20);
  let colormap = $state<ColormapName>('viridis');

  let latestBins = $state<Float32Array | null>(null);
  let rafHandle = 0;
  let unsubStats: (() => void) | null = null;
  let unsubFft: (() => void) | null = null;
  let unsubAudio: (() => void) | null = null;

  let audioSamplesPlayed = $state(0);
  let audioUnderrun = $state(0);
  let audioRingUsed = $state(0);
  let audioWorkletReady = $state(false);

  let helpOpen = $state(false);
  let freqEntryOpen = $state(false);

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

  onDestroy(() => {
    cancelAnimationFrame(rafHandle);
    unsubStats?.();
    unsubFft?.();
    void source.disconnect();
    void audio.close();
  });

  // Push volume / mute into the audio worklet whenever they change.
  $effect(() => {
    if (audio.isReady) audio.setVolume(volume);
  });
  $effect(() => {
    if (audio.isReady) audio.setMuted(tuning.muted);
  });

  // ---- Retune effects ----
  // When centerFreq or gain change while streaming, push them to the USB
  // worker without restarting the stream. The initial values are set by
  // start() so this only fires on subsequent changes.
  $effect(() => {
    const f = tuning.centerFreq;
    if (rtlStatus === 'streaming') source.retune({ centerFreq: f });
  });
  $effect(() => {
    const g = tuning.gain;
    if (rtlStatus === 'streaming') source.retune({ gain: g });
  });

  // ---- Render loop (now just for elapsed timer) ----

  function tick() {
    if (streamStartMs !== null) {
      elapsedMs = performance.now() - streamStartMs;
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
      latestBins = evt.bins;
      fftFramesRendered++;
    });

    rafHandle = requestAnimationFrame(tick);

    try {
      // AudioContext can only be created from a user gesture, so do it here
      // (inside the Start click handler). Idempotent if already up.
      await audio.init();
      audio.setVolume(volume);
      audio.setMuted(tuning.muted);

      unsubAudio?.();
      unsubAudio = audio.onStats((s) => {
        audioSamplesPlayed = s.samplesPlayed;
        audioUnderrun = s.samplesUnderrun;
        audioRingUsed = s.ringUsedBytes;
        audioWorkletReady = audio.isWorkletReady;
      });

      rtlStatus = 'streaming';
      await source.start({
        sampleRate: SAMPLE_RATE,
        centerFreq: tuning.centerFreq,
        gain: tuning.gain,
        fftSize: FFT_SIZE,
        fftRateHz: FFT_RATE_HZ,
        audioRing: audio.ring!.buffer,
      });
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
      cancelAnimationFrame(rafHandle);
      unsubStats?.();
      unsubFft?.();
      unsubAudio?.();
      unsubStats = null;
      unsubFft = null;
      unsubAudio = null;
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
      unsubAudio?.();
      unsubStats = null;
      unsubFft = null;
      unsubAudio = null;
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

  function onClickToTune(hz: number) {
    tuning.centerFreq = hz;
  }

  // ---- Keyboard hotkeys ----
  function onWindowKey(e: KeyboardEvent) {
    // Don't hijack typing in inputs / textareas / contenteditable.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    switch (e.key) {
      case 'f':
      case 'F':
        e.preventDefault();
        freqEntryOpen = true;
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        tuning.cycleMode();
        break;
      case 'b':
      case 'B':
        e.preventDefault();
        tuning.cycleBandwidth();
        break;
      case 'g':
      case 'G':
        e.preventDefault();
        tuning.cycleGain();
        break;
      case ',':
      case '<':
        e.preventDefault();
        tuning.stepDown();
        break;
      case '.':
      case '>':
        e.preventDefault();
        tuning.stepUp();
        break;
      case '[':
      case '{':
        e.preventDefault();
        tuning.cycleStepSize(-1);
        break;
      case ']':
      case '}':
        e.preventDefault();
        tuning.cycleStepSize(1);
        break;
      case ' ':
        e.preventDefault();
        tuning.toggleMute();
        break;
      case '?':
        e.preventDefault();
        helpOpen = true;
        break;
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

  function formatMSamples(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MS`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kS`;
    return `${n} S`;
  }

  function gainLabel(g: number | null): string {
    return g === null ? 'AGC' : `${g} dB`;
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<HotkeyHelp bind:open={helpOpen} />
<FrequencyEntry
  bind:open={freqEntryOpen}
  initialValue={(tuning.centerFreq / 1e6).toString()}
  onSubmit={(hz) => (tuning.centerFreq = hz)}
/>

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
        RTL-SDR · Spectrum &amp; Waterfall
      </h2>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={() => (helpOpen = true)}
          class="inline-flex items-center gap-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 px-2 py-1 text-xs font-mono cursor-pointer"
          title="Show keyboard shortcuts (?)"
        >
          <Keyboard size={12} />
          <span>?</span>
        </button>
        <span class="font-mono text-xs text-neutral-500">B3 · B4 · B5</span>
      </div>
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
      <!-- VFO dial + mode/bw/gain row -->
      <div class="mb-4 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-end">
        <VfoDial
          centerFreq={tuning.centerFreq}
          stepSize={tuning.stepSize}
          onChange={(hz) => (tuning.centerFreq = hz)}
        />
        <dl class="grid grid-cols-4 lg:grid-cols-1 gap-x-4 gap-y-1 text-xs font-mono">
          <div class="lg:flex lg:items-baseline lg:gap-2">
            <dt class="text-neutral-500 uppercase">Mode</dt>
            <dd class="text-neutral-200">{MODE_INFO[tuning.mode].label}</dd>
          </div>
          <div class="lg:flex lg:items-baseline lg:gap-2">
            <dt class="text-neutral-500 uppercase">BW</dt>
            <dd class="text-neutral-200">{formatHz(tuning.bandwidth)}</dd>
          </div>
          <div class="lg:flex lg:items-baseline lg:gap-2">
            <dt class="text-neutral-500 uppercase">Step</dt>
            <dd class="text-neutral-200">{formatHz(tuning.stepSize)}</dd>
          </div>
          <div class="lg:flex lg:items-baseline lg:gap-2">
            <dt class="text-neutral-500 uppercase">Gain</dt>
            <dd class="text-neutral-200">{gainLabel(tuning.gain)}</dd>
          </div>
        </dl>
      </div>

      <div class="rounded-md overflow-hidden border border-neutral-800 mb-4 bg-black">
        <SpectrumWaterfall
          bins={latestBins}
          centerFreq={tuning.centerFreq}
          sampleRate={SAMPLE_RATE}
          {dbMin}
          {dbMax}
          {colormap}
          stepSize={tuning.stepSize}
          onTune={onClickToTune}
        />
      </div>

      <!-- Audio: volume slider + mute -->
      <div class="flex items-center gap-3 mb-4 text-xs font-mono">
        <button
          type="button"
          onclick={() => tuning.toggleMute()}
          class="inline-flex items-center gap-2 rounded border border-neutral-700 px-3 py-1.5 hover:border-neutral-500 cursor-pointer"
          class:bg-amber-950={tuning.muted}
          class:border-amber-700={tuning.muted}
          class:text-amber-300={tuning.muted}
          class:text-neutral-300={!tuning.muted}
          aria-pressed={tuning.muted}
          title="Mute (Space)"
        >
          {#if tuning.muted}
            <VolumeX size={14} />
            <span>Muted</span>
          {:else}
            <Volume2 size={14} />
            <span>Audio</span>
          {/if}
        </button>
        <label class="flex-1 flex items-center gap-3">
          <span class="text-neutral-500 uppercase text-[10px]">Vol</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            bind:value={volume}
            class="flex-1"
          />
          <span class="text-neutral-300 w-10 text-right tabular-nums">
            {Math.round(volume * 100)}%
          </span>
        </label>
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
          class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2 rounded-md border border-neutral-800 bg-neutral-900 p-3 font-mono text-xs"
        >
          <div>
            <dt class="text-neutral-500">USB rate</dt>
            <dd class="text-(--color-accent) text-sm">{rateMSps.toFixed(2)} MS/s</dd>
          </div>
          <div>
            <dt class="text-neutral-500">Spectrum</dt>
            <dd class="text-neutral-200 text-sm">{renderFps.toFixed(1)} fps</dd>
          </div>
          <div>
            <dt class="text-neutral-500">Elapsed</dt>
            <dd class="text-neutral-200 text-sm">{(elapsedMs / 1000).toFixed(1)} s</dd>
          </div>
          <div>
            <dt class="text-neutral-500">USB drop</dt>
            <dd class="text-neutral-200 text-sm">{bytesDropped} B</dd>
          </div>
        </dl>
        <!-- Audio telemetry: lets us see whether the demod-to-speaker chain
             is actually alive. If "played" is 0 the worklet isn't running;
             if "ring" stays at 0 the DSP worker isn't writing; if "ring"
             grows without bound the worklet isn't reading. -->
        <dl
          class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 rounded-md border border-neutral-800 bg-neutral-900 p-3 font-mono text-xs"
        >
          <div>
            <dt class="text-neutral-500">Audio</dt>
            <dd class="text-sm" class:text-emerald-400={audioWorkletReady} class:text-amber-400={!audioWorkletReady}>
              {audioWorkletReady ? 'worklet ready' : 'waiting'}
            </dd>
          </div>
          <div>
            <dt class="text-neutral-500">Played</dt>
            <dd class="text-(--color-accent) text-sm">{formatMSamples(audioSamplesPlayed)}</dd>
          </div>
          <div>
            <dt class="text-neutral-500">Ring</dt>
            <dd class="text-neutral-200 text-sm">{Math.round(audioRingUsed / 4)} S</dd>
          </div>
          <div>
            <dt class="text-neutral-500">Underrun</dt>
            <dd class="text-neutral-200 text-sm" class:text-amber-400={audioUnderrun > 100}>
              {formatMSamples(audioUnderrun)}
            </dd>
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
    Pre-alpha · B5 complete · Press <kbd class="font-mono text-neutral-300">?</kbd> for shortcuts.
    <br />
    <a
      href="https://github.com/matsvandamme/moshon-sdr/blob/main/AGENTS.md"
      class="underline decoration-dotted hover:text-(--color-accent)"
      target="_blank"
      rel="noreferrer">Roadmap</a
    >
  </p>
</main>
