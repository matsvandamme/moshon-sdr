<script lang="ts">
  import { Activity, Play, Square } from 'lucide-svelte';
  import { formatHz } from '../state/tuning.svelte';

  /**
   * Sweep panel — orchestrates a wide-spectrum scan by retuning the source
   * through a frequency range and stitching together the FFT snapshots.
   *
   * The parent (App.svelte) handles the actual retune calls and the FFT
   * listener. This component owns the UI (config inputs, progress, the
   * wide canvas) and exposes start/stop/click-to-tune callbacks.
   */

  type SweepSegment = {
    /** Center frequency this segment was captured at (Hz). */
    centerHz: number;
    /** FFT bins (already in dBFS, fftshifted). */
    bins: Float32Array;
  };

  let {
    sampleRate,
    /** Most recent FFT bins from the parent. Used to grab a snapshot
     *  during the dwell phase of each step. */
    latestBins,
    onRetune,
    onCancel,
    onPickFrequency,
  }: {
    sampleRate: number;
    latestBins: Float32Array | null;
    onRetune: (hz: number) => void;
    onCancel: () => void;
    onPickFrequency: (hz: number) => void;
  } = $props();

  let startMHz = $state(88);
  let stopMHz = $state(108);
  /** Wait this long after each retune before grabbing a snapshot. RTL-SDR
   *  needs ~50-100 ms to settle on a new frequency. */
  let dwellMs = $state(120);

  let active = $state(false);
  let progress = $state(0);
  let segments = $state<SweepSegment[]>([]);
  let cancelRequested = false;

  let canvas: HTMLCanvasElement | null = $state(null);

  function frequencyStep(): number {
    // Each step covers 80 % of the IQ bandwidth — gives a little overlap
    // so we don't miss signals straddling step boundaries.
    return sampleRate * 0.8;
  }

  function totalSteps(): number {
    const span = stopMHz * 1e6 - startMHz * 1e6;
    return Math.max(1, Math.ceil(span / frequencyStep()));
  }

  async function startSweep() {
    if (active) return;
    if (stopMHz <= startMHz) return;
    active = true;
    cancelRequested = false;
    progress = 0;
    segments = [];
    const step = frequencyStep();
    const start = startMHz * 1e6;
    const stop = stopMHz * 1e6;
    let i = 0;
    for (let center = start + step / 2; center < stop && !cancelRequested; center += step) {
      onRetune(center);
      await sleep(dwellMs);
      if (latestBins && latestBins.length > 0) {
        segments = [...segments, { centerHz: center, bins: new Float32Array(latestBins) }];
        drawCanvas();
      }
      i++;
      progress = i / totalSteps();
    }
    active = false;
    onCancel();
  }

  function stopSweep() {
    cancelRequested = true;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Canvas rendering ────────────────────────────────────────────────

  /** Min / max dB for the colour map. */
  const DB_MIN = -90;
  const DB_MAX = -20;

  function drawCanvas() {
    if (!canvas || segments.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);

    const startHz = startMHz * 1e6;
    const stopHz = stopMHz * 1e6;
    const span = stopHz - startHz;
    if (span <= 0) return;

    // Each segment covers `sampleRate` of bandwidth centered on centerHz.
    // We render only the central 80 % of each segment (= sampleRate × 0.8)
    // to skip the noisy filter edges.
    const usableFrac = 0.8;

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();

    let firstPoint = true;
    for (const seg of segments) {
      const binCount = seg.bins.length;
      const usableBins = Math.floor(binCount * usableFrac);
      const startBin = (binCount - usableBins) >> 1;
      const usableBw = sampleRate * usableFrac;
      const segLeftHz = seg.centerHz - usableBw / 2;
      for (let b = 0; b < usableBins; b++) {
        const binHz = segLeftHz + (b / usableBins) * usableBw;
        if (binHz < startHz || binHz > stopHz) continue;
        const x = ((binHz - startHz) / span) * w;
        const db = seg.bins[startBin + b];
        const yFrac = 1 - Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));
        const y = yFrac * h;
        if (firstPoint) {
          ctx.moveTo(x, y);
          firstPoint = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
    }
    ctx.stroke();

    // Frequency axis ticks: 5 ticks at 0, 25, 50, 75, 100 %.
    ctx.fillStyle = '#525252';
    ctx.font = '10px monospace';
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const hz = startHz + frac * span;
      const x = frac * w;
      ctx.fillRect(x - 0.5, h - 4, 1, 4);
      ctx.fillText(`${(hz / 1e6).toFixed(1)} MHz`, x + 2, h - 6);
    }
  }

  function onCanvasClick(e: MouseEvent) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = x / rect.width;
    const hz = startMHz * 1e6 + frac * (stopMHz * 1e6 - startMHz * 1e6);
    onPickFrequency(hz);
  }

  // Redraw if `segments` or canvas dims change.
  $effect(() => {
    if (segments.length > 0) drawCanvas();
  });
</script>

<section
  class="rounded-md border border-neutral-800 bg-neutral-900 p-3 text-xs font-mono"
  aria-label="Spectrum sweep"
>
  <header class="flex items-center justify-between mb-2 text-neutral-500 uppercase">
    <span class="flex items-center gap-1.5">
      <Activity size={12} />
      <span>Spectrum sweep</span>
    </span>
    {#if active}
      <span class="text-(--color-accent) tabular-nums">
        {Math.round(progress * 100)}% · {segments.length} segments
      </span>
    {/if}
  </header>

  <p class="text-neutral-500 leading-relaxed mb-2 text-[10px]">
    Software sweep: the source retunes through the range and we stitch
    together the FFTs. RTL-SDR's tuner needs ~100 ms to settle per step;
    sweeping 100 MHz takes a few seconds. Click a peak to tune to it.
  </p>

  <div class="grid grid-cols-3 gap-2 mb-2">
    <label class="flex flex-col gap-1">
      <span class="text-neutral-500 uppercase text-[10px]">Start MHz</span>
      <input
        type="number"
        bind:value={startMHz}
        min="0"
        max="6000"
        step="0.1"
        disabled={active}
        class="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-200
               disabled:opacity-60 disabled:cursor-not-allowed"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-neutral-500 uppercase text-[10px]">Stop MHz</span>
      <input
        type="number"
        bind:value={stopMHz}
        min="0"
        max="6000"
        step="0.1"
        disabled={active}
        class="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-200
               disabled:opacity-60 disabled:cursor-not-allowed"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-neutral-500 uppercase text-[10px]">Dwell ms</span>
      <input
        type="number"
        bind:value={dwellMs}
        min="50"
        max="1000"
        step="10"
        disabled={active}
        class="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-200
               disabled:opacity-60 disabled:cursor-not-allowed"
      />
    </label>
  </div>

  <div class="flex items-center gap-2 mb-3">
    {#if active}
      <button
        type="button"
        onclick={stopSweep}
        class="inline-flex items-center gap-2 rounded-md bg-amber-600 text-white px-3 py-1.5 hover:bg-amber-500 cursor-pointer"
      >
        <Square size={14} />
        Stop sweep
      </button>
    {:else}
      <button
        type="button"
        onclick={startSweep}
        disabled={stopMHz <= startMHz}
        class="inline-flex items-center gap-2 rounded-md bg-(--color-accent) text-neutral-950 px-3 py-1.5
               font-medium hover:bg-(--color-accent-strong) cursor-pointer
               disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Play size={14} />
        Start sweep
      </button>
    {/if}
    <span class="text-neutral-600 text-[10px]">
      {totalSteps()} steps · {((stopMHz - startMHz) / (sampleRate * 0.8 / 1e6)).toFixed(0)} retunes ·
      est. {((totalSteps() * dwellMs) / 1000).toFixed(1)} s
    </span>
  </div>

  <canvas
    bind:this={canvas}
    width={1200}
    height={200}
    class="w-full block bg-black border border-neutral-800 rounded cursor-crosshair"
    style="aspect-ratio: 1200 / 200;"
    onclick={onCanvasClick}
    role="button"
    aria-label="Wide spectrum — click to tune"
    tabindex="-1"
  ></canvas>
</section>
