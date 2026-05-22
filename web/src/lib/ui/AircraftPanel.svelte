<script lang="ts">
  import { Plane } from 'lucide-svelte';
  import { aircraftTracker } from '../state/aircraft.svelte';

  function formatAlt(ft: number | undefined): string {
    if (ft === undefined) return '—';
    return `${ft.toLocaleString('en-US')} ft`;
  }

  function formatSpeed(kts: number | undefined): string {
    if (kts === undefined) return '—';
    return `${kts} kts`;
  }

  function formatPos(lat: number | undefined, lon: number | undefined): string {
    if (lat === undefined || lon === undefined) return '—';
    return `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  }

  function formatTrack(deg: number | undefined): string {
    if (deg === undefined) return '—';
    return `${deg}°`;
  }

  function ageSeconds(lastSeenWall: number): number {
    return Math.round((Date.now() - lastSeenWall) / 1000);
  }
</script>

<section
  class="rounded-md border border-neutral-800 bg-neutral-900 p-3 text-xs font-mono"
  aria-label="ADS-B aircraft list"
>
  <header class="flex items-center justify-between mb-2 text-neutral-500 uppercase">
    <span class="flex items-center gap-1.5">
      <Plane size={12} />
      <span>Aircraft</span>
    </span>
    <span class="text-neutral-600">
      {aircraftTracker.count} tracked
    </span>
  </header>

  {#if aircraftTracker.count === 0}
    <p class="text-neutral-600 italic text-center py-4">
      Waiting for frames. Tune to 1090 MHz and ensure your antenna is suitable
      (¼-wave at 1090 MHz ≈ 69 mm). Reception is typically &lt;100 km line-of-sight.
    </p>
  {:else}
    <ul class="max-h-64 overflow-y-auto -mr-1 pr-1">
      {#each aircraftTracker.all as a (a.icao)}
        <li class="grid grid-cols-[5rem_5rem_1fr_4rem_4rem_3rem] gap-2 py-1 border-b border-neutral-800/60 last:border-0 items-baseline">
          <span class="text-(--color-accent)">{a.hex}</span>
          <span class="text-neutral-200 truncate">{a.callsign || '—'}</span>
          <span class="text-neutral-400 text-[10px] truncate">{formatPos(a.lat, a.lon)}</span>
          <span class="text-neutral-300 text-right tabular-nums">{formatAlt(a.altitudeFt)}</span>
          <span class="text-neutral-300 text-right tabular-nums">{formatSpeed(a.groundSpeedKts)}</span>
          <span class="text-neutral-600 text-right tabular-nums text-[10px]">{ageSeconds(a.lastSeenWall)}s</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
