<script lang="ts">
  import {
    SpectrumRenderer,
    WaterfallRenderer,
    type ColormapName,
  } from '../visualizer/spectrum-waterfall';
  import { formatHz } from '../state/tuning.svelte';
  import { bandsInWindow, type IaruBand } from '../data/iaru-bands';

  let {
    bins,
    centerFreq,
    sampleRate,
    dbMin,
    dbMax,
    colormap,
    stepSize,
    spectrumW = 1024,
    spectrumH = 200,
    waterfallW = 1024,
    waterfallH = 400,
    onTune,
  }: {
    bins: Float32Array | null;
    centerFreq: number;
    sampleRate: number;
    dbMin: number;
    dbMax: number;
    colormap: ColormapName;
    stepSize: number;
    spectrumW?: number;
    spectrumH?: number;
    waterfallW?: number;
    waterfallH?: number;
    onTune?: (hz: number) => void;
  } = $props();

  let spectrumCanvas: HTMLCanvasElement | null = $state(null);
  let waterfallCanvas: HTMLCanvasElement | null = $state(null);
  let spectrumRenderer: SpectrumRenderer | null = null;
  let waterfallRenderer: WaterfallRenderer | null = null;

  $effect(() => {
    if (spectrumCanvas && !spectrumRenderer) {
      spectrumRenderer = new SpectrumRenderer(spectrumCanvas, { dbMin, dbMax });
    }
    if (waterfallCanvas && !waterfallRenderer) {
      waterfallRenderer = new WaterfallRenderer(waterfallCanvas, {
        dbMin,
        dbMax,
        colormap,
      });
    }
  });

  // Each time bins changes (new FFT frame from worker), apply current
  // dbMin/dbMax/colormap and redraw both canvases.
  $effect(() => {
    if (!bins || !spectrumRenderer || !waterfallRenderer) return;
    spectrumRenderer.setRange(dbMin, dbMax);
    waterfallRenderer.setRange(dbMin, dbMax);
    waterfallRenderer.setColormap(colormap);
    spectrumRenderer.draw(bins);
    waterfallRenderer.push(bins);
  });

  /** Convert a click position (x in 0..1 of canvas width) to absolute Hz. */
  function xFracToHz(xFrac: number): number {
    return centerFreq + (xFrac - 0.5) * sampleRate;
  }

  function onCanvasClick(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const newFreq = xFracToHz(Math.max(0, Math.min(1, xFrac)));
    onTune?.(newFreq);
  }

  function onCanvasWheel(e: WheelEvent) {
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    onTune?.(centerFreq + direction * stepSize);
  }

  // ---- Axis labels (5 ticks: -50% / -25% / 0 / +25% / +50% of sample rate) ----
  type Tick = { pct: number; hz: number };
  let ticks = $derived<Tick[]>(
    [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
      pct,
      hz: xFracToHz(pct),
    })),
  );

  // ---- IARU band overlay ----
  type VisibleBand = {
    band: IaruBand;
    leftPct: number;
    widthPct: number;
  };
  let visibleBands = $derived<VisibleBand[]>(
    bandsInWindow(centerFreq, sampleRate)
      .map((band) => {
        const lo = centerFreq - sampleRate / 2;
        const hi = centerFreq + sampleRate / 2;
        const leftPct = Math.max(0, (band.low - lo) / sampleRate);
        const rightPct = Math.min(1, (band.high - lo) / sampleRate);
        return {
          band,
          leftPct,
          widthPct: Math.max(0, rightPct - leftPct),
        };
      })
      .filter((b) => b.widthPct > 0.001),
  );
</script>

<div class="relative">
  <canvas
    bind:this={spectrumCanvas}
    width={spectrumW}
    height={spectrumH}
    class="block w-full cursor-crosshair"
    style="aspect-ratio: {spectrumW} / {spectrumH}"
    role="button"
    aria-label="Spectrum — click to tune"
    tabindex="-1"
    onclick={onCanvasClick}
    onwheel={onCanvasWheel}
  ></canvas>

  <!-- IARU band overlay above the frequency axis -->
  {#if visibleBands.length > 0}
    <div
      class="relative h-3 bg-neutral-950 border-t border-neutral-800 overflow-hidden"
      aria-label="IARU bands overlay"
    >
      {#each visibleBands as v (v.band.label + v.band.low)}
        <div
          class="absolute top-0 bottom-0 bg-(--color-accent)/15 border-x border-(--color-accent)/40
                 text-[9px] font-mono text-(--color-accent) px-1 leading-3 overflow-hidden
                 whitespace-nowrap"
          style="left: {v.leftPct * 100}%; width: {v.widthPct * 100}%;"
          title="{v.band.label} — suggested {v.band.suggestedMode.toUpperCase()}"
        >
          {v.band.label}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Frequency axis between the two canvases -->
  <div
    class="relative h-5 bg-neutral-950 border-y border-neutral-800
           text-[10px] font-mono text-neutral-500"
  >
    {#each ticks as t (t.pct)}
      <span
        class="absolute top-0.5"
        style="left: {t.pct * 100}%; transform: translateX(-50%);"
        class:font-medium={t.pct === 0.5}
        class:text-neutral-300={t.pct === 0.5}
      >
        {formatHz(t.hz)}
      </span>
    {/each}
  </div>

  <canvas
    bind:this={waterfallCanvas}
    width={waterfallW}
    height={waterfallH}
    class="block w-full cursor-crosshair"
    style="aspect-ratio: {waterfallW} / {waterfallH}"
    role="button"
    aria-label="Waterfall — click to tune"
    tabindex="-1"
    onclick={onCanvasClick}
    onwheel={onCanvasWheel}
  ></canvas>
</div>
