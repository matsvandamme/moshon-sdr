<script lang="ts">
  /**
   * "VFO dial" — big numeric frequency display with click-and-drag tuning.
   * Drag horizontally to fine-tune by stepSize per pixel. Scroll-wheel
   * also steps. Doubles as the canonical tuning indicator.
   */
  import { formatHzDigits, formatHz } from '../state/tuning.svelte';

  let {
    centerFreq = $bindable(0),
    stepSize,
    onChange,
  }: {
    centerFreq: number;
    stepSize: number;
    onChange?: (hz: number) => void;
  } = $props();

  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartFreq = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartFreq = centerFreq;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const next = dragStartFreq + dx * stepSize;
    centerFreq = next;
    onChange?.(next);
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    const next = centerFreq + direction * stepSize;
    centerFreq = next;
    onChange?.(next);
  }
</script>

<div
  class="relative select-none cursor-ew-resize rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3"
  class:cursor-grabbing={dragging}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onwheel={onWheel}
  role="slider"
  aria-label="Tuning dial"
  aria-valuenow={centerFreq}
  aria-valuetext={formatHz(centerFreq)}
  tabindex="0"
>
  <div class="flex items-baseline gap-2 justify-center font-mono">
    <span class="text-(--color-accent) text-3xl tracking-tight tabular-nums">
      {formatHzDigits(centerFreq)}
    </span>
    <span class="text-neutral-500 text-sm">Hz</span>
  </div>
  <div class="mt-1 text-center text-xs text-neutral-500 font-mono">
    drag = ±{formatHz(stepSize)} / px · scroll = ±{formatHz(stepSize)} / tick
  </div>
</div>
