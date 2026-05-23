<!--
  Collapsible sidebar section. Title row + chevron + sliding body.
  Used by the SDR++-style left sidebar so each control group can be
  hidden when not in use without losing its scroll position.

  Defaults to open. Pass `open={false}` for "advanced" / situational
  sections that shouldn't take vertical space until the user asks.
-->
<script lang="ts">
  import { ChevronDown, ChevronRight } from 'lucide-svelte';

  type Props = {
    title: string;
    /** Open state, two-way bindable via `bind:open` */
    open?: boolean;
    /** Optional dense mode — smaller padding for tightly-packed groups */
    dense?: boolean;
    /** Optional right-aligned status badge (e.g. mode label, signal lock) */
    badge?: string;
    children?: import('svelte').Snippet;
  };

  let {
    title,
    open = $bindable(true),
    dense = false,
    badge = '',
    children,
  }: Props = $props();
</script>

<section
  class="border-b border-neutral-800 last:border-b-0"
  data-section-title={title}
>
  <button
    type="button"
    class="w-full flex items-center gap-2 text-left px-3 py-2 text-[11px] uppercase tracking-wide
           text-neutral-400 hover:text-neutral-200 cursor-pointer"
    onclick={() => (open = !open)}
    aria-expanded={open}
  >
    {#if open}
      <ChevronDown size={12} />
    {:else}
      <ChevronRight size={12} />
    {/if}
    <span class="flex-1 font-mono">{title}</span>
    {#if badge}
      <span class="text-[10px] text-neutral-500 normal-case tracking-normal">{badge}</span>
    {/if}
  </button>
  {#if open}
    <div class={dense ? 'px-3 pb-2' : 'px-3 pb-3'}>
      {@render children?.()}
    </div>
  {/if}
</section>
