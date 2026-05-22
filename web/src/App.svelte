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
    HelpCircle,
    Usb,
    Wifi,
    Circle,
    Download,
  } from 'lucide-svelte';
  import { onMount, onDestroy } from 'svelte';
  import init, { smoke } from './lib/dsp/wasm/moshon_dsp.js';
  import { RtlSdrSource, type RtlSdrStatus } from './lib/usb/rtlsdr-source';
  import { RtlTcpSource } from './lib/usb/rtltcp-source';
  import { HackRfSource } from './lib/usb/hackrf-source';
  import { HACKRF_DEFAULT_GAIN, HACKRF_AMP_DB } from './lib/usb/hackrf-protocol';
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
  import MemoryChannels from './lib/ui/MemoryChannels.svelte';
  import Onboarding from './lib/ui/Onboarding.svelte';
  import NetworkConnect from './lib/ui/NetworkConnect.svelte';
  import { AudioPipeline } from './lib/audio/audio-pipeline';
  import { recorder } from './lib/audio/recorder.svelte';
  import { readHash, writeHash } from './lib/state/url-hash';
  import { peakDbInChannel, dbToSUnit } from './lib/dsp/smeter';

  // ---- WASM smoke (B1) ----
  type WasmStatus = 'pending' | 'ready' | 'error';
  let wasmStatus = $state<WasmStatus>('pending');
  let wasmError = $state<string | null>(null);
  let smokeResult = $state<number | null>(null);

  // ---- RTL-SDR fixed config ----
  const SAMPLE_RATE = 2_400_000;
  const FFT_SIZE = 2048;
  const FFT_RATE_HZ = 30;

  // Three sources: RTL-SDR via WebUSB, HackRF One via WebUSB, and
  // rtl_tcp-over-WebSocket (remote bridge). They all expose the same
  // listener surface, so the rest of App.svelte can poll activeSource()
  // without caring which physical link is feeding it.
  const usbSource = new RtlSdrSource();
  const hackrfSource = new HackRfSource();
  const netSource = new RtlTcpSource();
  type InputMode = 'usb' | 'hackrf' | 'network';
  let inputMode = $state<InputMode>('usb');
  let bridgeUrl = $state('http://127.0.0.1:9090');
  let rtlTcpTarget = $state('');

  // HackRF per-stage gain (AMP/LNA/VGA). Defaults match the official docs:
  // RF=off, IF=16, BB=16. Persisted to localStorage so settings survive
  // reloads independent of the unified `tuning.gain`.
  let hrfAmpOn = $state(HACKRF_DEFAULT_GAIN.ampOn);
  let hrfLnaDb = $state(HACKRF_DEFAULT_GAIN.lnaDb);
  let hrfVgaDb = $state(HACKRF_DEFAULT_GAIN.vgaDb);

  function activeSource(): RtlSdrSource | HackRfSource | RtlTcpSource {
    if (inputMode === 'hackrf') return hackrfSource;
    if (inputMode === 'network') return netSource;
    return usbSource;
  }

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
  let onboardingOpen = $state(false);

  let unsubRecAudio: (() => void) | null = null;
  let unsubCwText: (() => void) | null = null;
  let unsubRds: (() => void) | null = null;
  let cwDecodedText = $state('');
  let cwDecodedWpm = $state(0);

  let rdsSynced = $state(false);
  let rdsPi = $state(0);
  let rdsPs = $state('');
  let rdsRt = $state('');
  let rdsStereo = $state(false);

  // ---- Lifecycle ----

  onMount(async () => {
    // First-run onboarding: auto-open the modal unless the user dismissed
    // it on a prior visit.
    try {
      if (localStorage.getItem('moshon.onboarding.dismissed.v1') !== '1') {
        onboardingOpen = true;
      }
      const savedBridgeUrl = localStorage.getItem('moshon.bridgeUrl.v1');
      if (savedBridgeUrl) bridgeUrl = savedBridgeUrl;
      const savedTarget = localStorage.getItem('moshon.rtltcpTarget.v1');
      if (savedTarget !== null) rtlTcpTarget = savedTarget;
      const savedMode = localStorage.getItem('moshon.inputMode.v1');
      if (savedMode === 'usb' || savedMode === 'hackrf' || savedMode === 'network') {
        inputMode = savedMode;
      }
      const savedHrf = localStorage.getItem('moshon.hackrfGain.v1');
      if (savedHrf) {
        const parsed = JSON.parse(savedHrf) as Partial<typeof HACKRF_DEFAULT_GAIN>;
        if (typeof parsed.ampOn === 'boolean') hrfAmpOn = parsed.ampOn;
        if (typeof parsed.lnaDb === 'number') hrfLnaDb = parsed.lnaDb;
        if (typeof parsed.vgaDb === 'number') hrfVgaDb = parsed.vgaDb;
      }
    } catch {
      // localStorage unavailable — skip onboarding entirely rather than
      // forcing it on every load.
    }

    // Restore tuning state from URL hash before anything else touches it.
    // Order matters: mode setter overwrites bandwidth and stepSize, so
    // apply mode first, then bandwidth, then frequency / gain.
    const hashState = readHash();
    if (hashState.mode) tuning.mode = hashState.mode;
    if (hashState.bandwidth) tuning.bandwidth = hashState.bandwidth;
    if (hashState.centerFreq) tuning.centerFreq = hashState.centerFreq;
    if (hashState.gain !== undefined) tuning.gain = hashState.gain;

    try {
      await init();
      smokeResult = smoke();
      wasmStatus = 'ready';
    } catch (err) {
      wasmStatus = 'error';
      wasmError = err instanceof Error ? err.message : String(err);
    }
  });

  // Mirror tuning into the URL hash so the page is shareable. Debounced via
  // history.replaceState so dragging the dial doesn't trash the back stack.
  $effect(() => {
    writeHash({
      centerFreq: tuning.centerFreq,
      mode: tuning.mode,
      bandwidth: tuning.bandwidth,
      gain: tuning.gain,
    });
  });

  // Persist bridge connection inputs. Bridge URL/target intentionally live in
  // localStorage and NOT the URL hash — see the no-bridge-in-hash decision
  // in MEMORY.md.
  $effect(() => {
    const url = bridgeUrl;
    const tgt = rtlTcpTarget;
    const mode = inputMode;
    try {
      localStorage.setItem('moshon.bridgeUrl.v1', url);
      localStorage.setItem('moshon.rtltcpTarget.v1', tgt);
      localStorage.setItem('moshon.inputMode.v1', mode);
    } catch {
      // ignore
    }
  });

  // Persist HackRF per-stage gain + push live changes to the worker.
  $effect(() => {
    const amp = hrfAmpOn;
    const lna = hrfLnaDb;
    const vga = hrfVgaDb;
    try {
      localStorage.setItem(
        'moshon.hackrfGain.v1',
        JSON.stringify({ ampOn: amp, lnaDb: lna, vgaDb: vga }),
      );
    } catch {
      // ignore
    }
    if (inputMode === 'hackrf' && rtlStatus === 'streaming') {
      hackrfSource.setHackrfGain({ ampOn: amp, lnaDb: lna, vgaDb: vga });
    }
  });

  onDestroy(() => {
    cancelAnimationFrame(rafHandle);
    unsubStats?.();
    unsubFft?.();
    void usbSource.disconnect();
    void hackrfSource.disconnect();
    void netSource.disconnect();
    void audio.close();
  });

  // Push volume / mute into the audio worklet whenever they change.
  // IMPORTANT: read the reactive state UNCONDITIONALLY before the ready
  // gate, otherwise Svelte 5 short-circuits and never tracks the dep — the
  // effect runs once at mount (when audio isn't ready), reads nothing
  // reactive, and is then dead. Capture into a local first.
  $effect(() => {
    const v = volume;
    if (audio.isReady) audio.setVolume(v);
  });
  $effect(() => {
    const m = tuning.muted;
    if (audio.isReady) audio.setMuted(m);
  });

  // ---- Retune effects ----
  // When centerFreq or gain change while streaming, push them to whichever
  // source is currently active without restarting the stream.
  $effect(() => {
    const f = tuning.centerFreq;
    if (rtlStatus === 'streaming') activeSource().retune({ centerFreq: f });
  });
  $effect(() => {
    const g = tuning.gain;
    if (rtlStatus === 'streaming') activeSource().retune({ gain: g });
  });

  // Push mode + bandwidth changes to the DSP worker without restarting.
  // Capture both reactive reads BEFORE the streaming gate so Svelte tracks
  // them as dependencies even on the first (non-streaming) tick.
  $effect(() => {
    const m = tuning.mode;
    const bw = tuning.bandwidth;
    if (rtlStatus === 'streaming') activeSource().setMode(m, bw);
  });

  // ---- Render loop (now just for elapsed timer) ----

  function tick() {
    if (streamStartMs !== null) {
      elapsedMs = performance.now() - streamStartMs;
    }
    rafHandle = requestAnimationFrame(tick);
  }

  // ---- Button actions ----

  function resetStreamCounters() {
    rtlError = null;
    bytesWritten = 0;
    bytesDropped = 0;
    fftFramesRendered = 0;
    streamStartMs = performance.now();
    elapsedMs = 0;
  }

  function wireStreamListeners() {
    const src = activeSource();
    unsubStats?.();
    unsubFft?.();
    unsubRecAudio?.();
    unsubStats = src.onStats((s) => {
      bytesWritten = s.bytesWritten;
      bytesDropped = s.bytesDropped;
    });
    unsubFft = src.onFft((evt) => {
      latestBins = evt.bins;
      fftFramesRendered++;
    });
    unsubRecAudio = src.onAudio((evt) => {
      const fits = recorder.push(evt.samples);
      if (!fits) {
        // Hit the memory cap — finalize the recording for the user.
        onRecordToggle();
      }
    });
    unsubCwText = src.onCwText((evt) => {
      // Cap the visible window so the buffer doesn't grow unbounded on
      // long sessions. Keep the most recent ~1500 chars.
      cwDecodedText = (cwDecodedText + evt.text).slice(-1500);
      cwDecodedWpm = evt.wpm;
    });
    unsubRds = src.onRds((evt) => {
      rdsSynced = evt.synced;
      rdsPi = evt.pi;
      rdsPs = evt.ps;
      rdsRt = evt.rt;
      rdsStereo = evt.stereo;
    });
  }

  async function startAudio() {
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
  }

  function clearStreamCleanup() {
    cancelAnimationFrame(rafHandle);
    unsubStats?.();
    unsubFft?.();
    unsubAudio?.();
    unsubRecAudio?.();
    unsubCwText?.();
    unsubRds?.();
    unsubStats = null;
    unsubFft = null;
    unsubAudio = null;
    unsubRecAudio = null;
    unsubCwText = null;
    unsubRds = null;
    // If a recording was in progress, save what we have.
    if (recorder.recording) recorder.stopAndDownload();
  }

  // Wipe the decoded buffer whenever the user leaves CW mode so they don't
  // see stale text next time they tune back.
  $effect(() => {
    if (tuning.mode !== 'cw') {
      cwDecodedText = '';
      cwDecodedWpm = 0;
    }
  });

  function onRecordToggle() {
    if (recorder.recording) {
      activeSource().setRecording(false);
      recorder.stopAndDownload();
    } else {
      recorder.start();
      activeSource().setRecording(true);
    }
  }

  async function onConnect() {
    // Local-USB path (RTL-SDR or HackRF). The WebUSB picker needs a user
    // gesture, so each click reopens whichever device matches the
    // current inputMode.
    rtlError = null;
    rtlStatus = 'connecting';
    try {
      if (inputMode === 'hackrf') {
        await hackrfSource.connect();
      } else {
        await usbSource.connect();
      }
      rtlStatus = 'connected';
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onStart() {
    resetStreamCounters();
    wireStreamListeners();
    rafHandle = requestAnimationFrame(tick);

    try {
      await startAudio();
      rtlStatus = 'streaming';
      const baseOpts = {
        sampleRate: SAMPLE_RATE,
        centerFreq: tuning.centerFreq,
        gain: tuning.gain,
        fftSize: FFT_SIZE,
        fftRateHz: FFT_RATE_HZ,
        mode: tuning.mode,
        bandwidthHz: tuning.bandwidth,
        audioRing: audio.ring!.buffer,
      };
      if (inputMode === 'hackrf') {
        await hackrfSource.start({
          ...baseOpts,
          hackrfGain: { ampOn: hrfAmpOn, lnaDb: hrfLnaDb, vgaDb: hrfVgaDb },
        });
      } else {
        await usbSource.start(baseOpts);
      }
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
      clearStreamCleanup();
    }
  }

  async function onConnectNetwork() {
    resetStreamCounters();
    wireStreamListeners();
    rafHandle = requestAnimationFrame(tick);
    rtlStatus = 'connecting';

    try {
      await startAudio();
      await netSource.start({
        bridgeUrl,
        rtlTcpTarget: rtlTcpTarget.trim() || undefined,
        sampleRate: SAMPLE_RATE,
        centerFreq: tuning.centerFreq,
        gain: tuning.gain,
        fftSize: FFT_SIZE,
        fftRateHz: FFT_RATE_HZ,
        mode: tuning.mode,
        bandwidthHz: tuning.bandwidth,
        audioRing: audio.ring!.buffer,
      });
      rtlStatus = 'streaming';
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
      clearStreamCleanup();
    }
  }

  async function onStop() {
    cancelAnimationFrame(rafHandle);
    rtlStatus = 'closing';
    try {
      const src = activeSource();
      await src.stop();
      await src.disconnect();
      rtlStatus = 'idle';
    } catch (err) {
      rtlStatus = 'error';
      rtlError = err instanceof Error ? err.message : String(err);
    } finally {
      clearStreamCleanup();
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
      await activeSource().disconnect();
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

  // ---- S-meter (B7) ----
  // Peak dBFS across the bins covering the channel bandwidth. Refreshes
  // on every FFT frame via the latestBins reactive dep.
  let signalDb = $derived(
    latestBins
      ? peakDbInChannel(latestBins, SAMPLE_RATE, tuning.bandwidth)
      : Number.NEGATIVE_INFINITY,
  );
  let signalS = $derived(dbToSUnit(signalDb));

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
<Onboarding bind:open={onboardingOpen} />

<main class="min-h-full flex flex-col items-center px-3 sm:px-4 py-4 sm:py-8 gap-4 sm:gap-6">
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
    class="w-full max-w-5xl rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 sm:p-5"
  >
    <header class="flex items-center justify-between flex-wrap gap-2 mb-4">
      <h2 class="text-sm font-medium text-neutral-300 uppercase tracking-wide">
        {inputMode === 'hackrf'
          ? 'HackRF'
          : inputMode === 'network'
            ? 'Network'
            : 'RTL-SDR'} · Spectrum &amp; Waterfall
      </h2>
      <div class="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onclick={() => (onboardingOpen = true)}
          class="inline-flex items-center gap-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 px-2 py-1 text-xs font-mono cursor-pointer"
          title="Show WebUSB setup help"
        >
          <HelpCircle size={12} />
          <span>Setup</span>
        </button>
        <button
          type="button"
          onclick={() => (helpOpen = true)}
          class="inline-flex items-center gap-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 px-2 py-1 text-xs font-mono cursor-pointer"
          title="Show keyboard shortcuts (?)"
        >
          <Keyboard size={12} />
          <span>?</span>
        </button>
        <span class="hidden sm:inline font-mono text-xs text-neutral-500">B3..B9 · M2</span>
      </div>
    </header>

    {#if rtlStatus === 'idle'}
      <!-- Input mode picker. RTL-SDR and HackRF are both WebUSB; the
           network tab proxies a remote rtl_tcp via the moshon-bridge
           daemon. -->
      <div class="flex gap-1 mb-4 text-xs font-mono flex-wrap">
        <button
          type="button"
          onclick={() => (inputMode = 'usb')}
          class="inline-flex items-center gap-1.5 rounded px-3 py-1.5 cursor-pointer"
          class:bg-neutral-800={inputMode === 'usb'}
          class:border-neutral-600={inputMode === 'usb'}
          class:text-neutral-100={inputMode === 'usb'}
          class:bg-neutral-950={inputMode !== 'usb'}
          class:border-neutral-800={inputMode !== 'usb'}
          class:text-neutral-400={inputMode !== 'usb'}
          style="border-width: 1px; border-style: solid;"
          aria-pressed={inputMode === 'usb'}
        >
          <Usb size={12} />
          RTL-SDR
        </button>
        <button
          type="button"
          onclick={() => (inputMode = 'hackrf')}
          class="inline-flex items-center gap-1.5 rounded px-3 py-1.5 cursor-pointer"
          class:bg-neutral-800={inputMode === 'hackrf'}
          class:border-neutral-600={inputMode === 'hackrf'}
          class:text-neutral-100={inputMode === 'hackrf'}
          class:bg-neutral-950={inputMode !== 'hackrf'}
          class:border-neutral-800={inputMode !== 'hackrf'}
          class:text-neutral-400={inputMode !== 'hackrf'}
          style="border-width: 1px; border-style: solid;"
          aria-pressed={inputMode === 'hackrf'}
        >
          <Usb size={12} />
          HackRF
        </button>
        <button
          type="button"
          onclick={() => (inputMode = 'network')}
          class="inline-flex items-center gap-1.5 rounded px-3 py-1.5 cursor-pointer"
          class:bg-neutral-800={inputMode === 'network'}
          class:border-neutral-600={inputMode === 'network'}
          class:text-neutral-100={inputMode === 'network'}
          class:bg-neutral-950={inputMode !== 'network'}
          class:border-neutral-800={inputMode !== 'network'}
          class:text-neutral-400={inputMode !== 'network'}
          style="border-width: 1px; border-style: solid;"
          aria-pressed={inputMode === 'network'}
        >
          <Wifi size={12} />
          Network (rtl_tcp)
        </button>
      </div>

      {#if inputMode === 'usb'}
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
      {:else if inputMode === 'hackrf'}
        <p class="text-sm text-neutral-400 mb-4">
          Plug in a HackRF One (or compatible). 1 MHz – 6 GHz tuning range,
          wider passband than RTL-SDR. The first connection takes a moment
          while we configure the device's filter and PLL.
        </p>
        <button
          type="button"
          onclick={onConnect}
          class="inline-flex items-center gap-2 rounded-md bg-(--color-accent) text-neutral-950 px-4 py-2 text-sm font-medium hover:bg-(--color-accent-strong) cursor-pointer"
        >
          <Plug size={16} />
          Connect HackRF
        </button>
      {:else}
        <NetworkConnect
          bind:bridgeUrl
          bind:rtlTcpTarget
          onConnect={onConnectNetwork}
        />
      {/if}
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
            <dd class="text-neutral-200">
              {#if inputMode === 'hackrf'}
                {hrfAmpOn ? `+${HACKRF_AMP_DB}` : '–'} / {hrfLnaDb} / {hrfVgaDb} dB
              {:else}
                {gainLabel(tuning.gain)}
              {/if}
            </dd>
          </div>
        </dl>
      </div>

      <div class="rounded-md overflow-hidden border border-neutral-800 mb-3 bg-black">
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

      <!-- RDS (M2.4) — only relevant in WFM mode. Shows up as soon as the
           block sync state machine locks; PS / RT fields fill in over a few
           seconds as the four 0A / 2A address slots come in. -->
      {#if tuning.mode === 'wfm' && rtlStatus === 'streaming' && (rdsSynced || rdsStereo)}
        <div
          class="mb-3 rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs"
          aria-label="RDS"
        >
          <div class="flex items-center justify-between mb-1.5 text-neutral-500 uppercase">
            <span class="flex items-center gap-2">
              <span>RDS</span>
              {#if rdsSynced}
                <span class="text-emerald-400 text-[10px]">locked</span>
              {:else}
                <span class="text-neutral-600 text-[10px]">searching…</span>
              {/if}
              {#if rdsStereo}
                <span class="text-(--color-accent) text-[10px]">stereo</span>
              {/if}
            </span>
            {#if rdsSynced && rdsPi > 0}
              <span class="tabular-nums text-neutral-400">
                PI 0x{rdsPi.toString(16).toUpperCase().padStart(4, '0')}
              </span>
            {/if}
          </div>
          {#if rdsSynced}
            <div class="flex items-baseline gap-2 mb-1">
              <span class="text-neutral-500 text-[10px] uppercase w-6">PS</span>
              <span class="text-(--color-accent) text-base tracking-wide">{rdsPs}</span>
            </div>
            {#if rdsRt.trim().length > 0}
              <div class="flex items-start gap-2">
                <span class="text-neutral-500 text-[10px] uppercase w-6 mt-0.5">RT</span>
                <span class="text-neutral-300 break-words flex-1">{rdsRt}</span>
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      <!-- CW decoder (M2.3) -->
      {#if tuning.mode === 'cw' && rtlStatus === 'streaming'}
        <div
          class="mb-3 rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs"
          aria-label="CW decode"
        >
          <div class="flex items-center justify-between mb-1.5 text-neutral-500 uppercase">
            <span>CW decode</span>
            <span class="tabular-nums">
              {cwDecodedWpm > 0 ? `~${cwDecodedWpm.toFixed(0)} WPM` : ''}
              <button
                type="button"
                onclick={() => (cwDecodedText = '')}
                class="ml-2 text-neutral-600 hover:text-neutral-200 cursor-pointer"
                title="Clear decoded text"
              >clear</button>
            </span>
          </div>
          <div
            class="max-h-24 overflow-y-auto text-(--color-accent) leading-relaxed whitespace-pre-wrap break-words"
          >
            {cwDecodedText || '…listening…'}
          </div>
        </div>
      {/if}

      <!-- S-meter (B7) -->
      {#if rtlStatus === 'streaming' && Number.isFinite(signalDb)}
        <div
          class="flex items-center gap-3 mb-4 rounded-md border border-neutral-800
                 bg-neutral-900 px-3 py-2 font-mono text-xs"
          aria-label="Signal strength"
        >
          <span class="text-neutral-500 uppercase">Signal</span>
          <span class="text-(--color-accent) text-sm tabular-nums">
            S{signalS.sNumber}{#if signalS.plus > 0}+{signalS.plus}{/if}
          </span>
          <span class="text-neutral-400 tabular-nums">
            {signalDb.toFixed(1)} dBFS
          </span>
          <div class="flex-1 h-1.5 rounded bg-neutral-800 overflow-hidden">
            <div
              class="h-full bg-(--color-accent)"
              style="width: {Math.max(0, Math.min(100, ((signalDb + 100) / 100) * 100))}%"
            ></div>
          </div>
        </div>
      {/if}

      <!-- Audio: volume slider + mute + record. Wraps to a second row on
           narrow viewports so the slider always gets a sensible width. -->
      <div class="flex items-center flex-wrap gap-2 sm:gap-3 mb-4 text-xs font-mono">
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
        <label class="order-3 sm:order-none basis-full sm:basis-auto flex-1 flex items-center gap-3 min-w-0">
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

        <!-- Recorder (M2.1) -->
        <button
          type="button"
          onclick={onRecordToggle}
          disabled={rtlStatus !== 'streaming'}
          class="inline-flex items-center gap-2 rounded border px-3 py-1.5 cursor-pointer
                 disabled:opacity-40 disabled:cursor-not-allowed"
          class:bg-rose-950={recorder.recording}
          class:border-rose-700={recorder.recording}
          class:text-rose-300={recorder.recording}
          class:border-neutral-700={!recorder.recording}
          class:text-neutral-300={!recorder.recording}
          aria-pressed={recorder.recording}
          title={recorder.recording
            ? `Stop & download (${recorder.seconds.toFixed(0)} s captured, cap ${recorder.capMinutes} min)`
            : 'Record demodulated audio to WAV'}
        >
          {#if recorder.recording}
            <Circle size={10} fill="currentColor" class="animate-pulse" />
            <span class="tabular-nums">{recorder.seconds.toFixed(0)}s</span>
          {:else}
            <Download size={14} />
            <span>Rec</span>
          {/if}
        </button>
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

      <!-- HackRF gain stages (M2.5b). Three independent controls per the
           official docs. Start values are RF=off, IF=16, BB=16; adjust
           IF and BB roughly together and only enable RF if signals are
           weak. Changes apply live to the device. -->
      {#if inputMode === 'hackrf'}
        <div
          class="mb-4 rounded-md border border-neutral-800 bg-neutral-900 p-3 font-mono text-xs"
          aria-label="HackRF gain stages"
        >
          <header class="flex items-center justify-between mb-2 text-neutral-500 uppercase">
            <span>HackRF gain</span>
            <span class="text-neutral-600 normal-case">
              total ≈ {(hrfAmpOn ? HACKRF_AMP_DB : 0) + hrfLnaDb + hrfVgaDb} dB
            </span>
          </header>

          <div class="flex items-center gap-3 mb-2">
            <button
              type="button"
              onclick={() => (hrfAmpOn = !hrfAmpOn)}
              class="rounded border px-2 py-1 cursor-pointer"
              class:bg-amber-950={hrfAmpOn}
              class:border-amber-700={hrfAmpOn}
              class:text-amber-300={hrfAmpOn}
              class:border-neutral-700={!hrfAmpOn}
              class:text-neutral-400={!hrfAmpOn}
              aria-pressed={hrfAmpOn}
              title="RF amplifier (~+11 dB). Use only for weak signals."
            >
              RF +{HACKRF_AMP_DB} dB · {hrfAmpOn ? 'ON' : 'off'}
            </button>
            <span class="text-neutral-600 text-[10px]">
              pre-amp before LNA — adds noise, use sparingly
            </span>
          </div>

          <label class="flex items-center gap-3 mb-1.5">
            <span class="text-neutral-500 uppercase text-[10px] w-8">IF</span>
            <input
              type="range"
              min="0"
              max="40"
              step="8"
              bind:value={hrfLnaDb}
              class="flex-1"
            />
            <span class="text-(--color-accent) w-12 text-right tabular-nums">
              {hrfLnaDb} dB
            </span>
          </label>

          <label class="flex items-center gap-3">
            <span class="text-neutral-500 uppercase text-[10px] w-8">BB</span>
            <input
              type="range"
              min="0"
              max="62"
              step="2"
              bind:value={hrfVgaDb}
              class="flex-1"
            />
            <span class="text-(--color-accent) w-12 text-right tabular-nums">
              {hrfVgaDb} dB
            </span>
          </label>
        </div>
      {/if}

      <!-- Memory channels (B7) -->
      <div class="mb-4">
        <MemoryChannels />
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
    v0.1.1 · M2 in flight · Press <kbd class="font-mono text-neutral-300">?</kbd> for shortcuts.
    <br />
    <a
      href="https://github.com/matsvandamme/moshon-sdr/blob/main/AGENTS.md"
      class="underline decoration-dotted hover:text-(--color-accent)"
      target="_blank"
      rel="noreferrer">Roadmap</a
    >
  </p>
</main>
