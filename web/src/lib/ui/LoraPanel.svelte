<script lang="ts">
  import { Radio } from 'lucide-svelte';

  let {
    /** Current peak-dBFS in the LoRa channel (from the parent's S-meter). */
    channelDb,
    /** Activity threshold — above this, we show "active". */
    threshold = -55,
  }: {
    channelDb: number;
    threshold?: number;
  } = $props();

  const ACTIVE = $derived(Number.isFinite(channelDb) && channelDb > threshold);
</script>

<section
  class="rounded-md border border-neutral-800 bg-neutral-900 p-3 text-xs font-mono"
  aria-label="LoRa monitor"
>
  <header class="flex items-center justify-between mb-2 text-neutral-500 uppercase">
    <span class="flex items-center gap-1.5">
      <Radio size={12} />
      <span>LoRa monitor (EU 868 MHz)</span>
    </span>
    <span class:text-emerald-400={ACTIVE} class:text-neutral-600={!ACTIVE} class="text-[10px]">
      {ACTIVE ? 'activity' : 'quiet'}
    </span>
  </header>

  <div class="flex items-center gap-3 mb-3">
    <span class="text-neutral-500 uppercase text-[10px]">Channel</span>
    <span class="text-(--color-accent) tabular-nums">
      {Number.isFinite(channelDb) ? `${channelDb.toFixed(1)} dBFS` : '—'}
    </span>
    <div class="flex-1 h-1.5 rounded bg-neutral-800 overflow-hidden">
      <div
        class="h-full"
        class:bg-emerald-500={ACTIVE}
        class:bg-(--color-accent)={!ACTIVE}
        style="width: {Math.max(0, Math.min(100, ((channelDb + 100) / 100) * 100))}%"
      ></div>
    </div>
  </div>

  <p class="text-neutral-500 leading-relaxed">
    <strong class="text-neutral-300">Spectrum-only monitor.</strong> CSS de-chirp
    + symbol decoding (full LoRa payload parsing) is genuinely multi-week work
    and is scheduled for a future release. For now this mode keeps the FFT
    live at EU868 ch0 (868.1 MHz) so you can <em>see</em> chirp activity on the
    waterfall — eight diagonal stripes ramping up in frequency is a LoRa
    preamble. Tune ±200 kHz with <kbd class="text-neutral-300">,</kbd>/<kbd class="text-neutral-300">.</kbd>
    to scan adjacent channels (868.3, 868.5).
  </p>
</section>
