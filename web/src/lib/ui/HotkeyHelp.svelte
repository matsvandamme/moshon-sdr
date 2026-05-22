<script lang="ts">
  import { X } from 'lucide-svelte';

  let { open = $bindable(false) }: { open: boolean } = $props();

  const hotkeys: Array<{ key: string; desc: string }> = [
    { key: 'F', desc: 'Enter frequency' },
    { key: 'M', desc: 'Cycle mode (WFM → NFM → AM → USB → LSB → CW)' },
    { key: 'B', desc: 'Cycle filter bandwidth for current mode' },
    { key: ', / .', desc: 'Step down / up by current step size' },
    { key: '[ / ]', desc: 'Cycle step size down / up' },
    { key: 'G', desc: 'Cycle gain (AGC, 0, 10, 20, 30, 40 dB)' },
    { key: 'Space', desc: 'Mute / unmute audio' },
    { key: '?', desc: 'Open this hotkey reference' },
    { key: 'Esc', desc: 'Close modals' },
  ];

  function close() {
    open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
</script>

<svelte:window onkeydown={open ? onKey : null} />

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Hotkey reference"
    onclick={close}
    onkeydown={(e) => e.key === 'Escape' && close()}
    tabindex="-1"
  >
    <div
      class="bg-neutral-950 border border-neutral-800 rounded-lg max-w-md w-full p-5"
      role="document"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-medium text-neutral-200 uppercase tracking-wide">
          Keyboard shortcuts
        </h3>
        <button
          type="button"
          onclick={close}
          class="text-neutral-500 hover:text-neutral-200 cursor-pointer"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {#each hotkeys as h (h.key)}
          <dt
            class="font-mono text-(--color-accent) text-right whitespace-nowrap"
          >
            {h.key}
          </dt>
          <dd class="text-neutral-300">{h.desc}</dd>
        {/each}
      </dl>
    </div>
  </div>
{/if}
