<script lang="ts">
  import { Star, Plus, X } from 'lucide-svelte';
  import { memoryChannels } from '../state/memory-channels.svelte';
  import { tuning, formatHz, MODE_INFO } from '../state/tuning.svelte';

  let nameInput = $state('');

  function onSave() {
    const trimmed = nameInput.trim();
    if (trimmed.length === 0) return;
    memoryChannels.add({
      name: trimmed,
      freq: tuning.centerFreq,
      mode: tuning.mode,
      bandwidth: tuning.bandwidth,
    });
    nameInput = '';
  }

  function recall(id: string) {
    const c = memoryChannels.all.find((x) => x.id === id);
    if (!c) return;
    tuning.mode = c.mode;
    tuning.bandwidth = c.bandwidth;
    tuning.centerFreq = c.freq;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSave();
    }
  }
</script>

<section
  class="rounded-md border border-neutral-800 bg-neutral-900 p-3 text-xs font-mono"
  aria-label="Memory channels"
>
  <header class="flex items-center justify-between mb-2">
    <div class="flex items-center gap-1.5 text-neutral-400 uppercase">
      <Star size={12} />
      <span>Channels</span>
    </div>
    <span class="text-neutral-600">{memoryChannels.all.length} saved</span>
  </header>

  <div class="flex items-center gap-2 mb-2">
    <input
      type="text"
      bind:value={nameInput}
      onkeydown={onKeydown}
      placeholder="Name current tuning…"
      class="flex-1 min-w-0 rounded border border-neutral-700 bg-neutral-950 px-2 py-1
             text-neutral-200 placeholder:text-neutral-600 focus:outline-none
             focus:border-(--color-accent)"
      maxlength="40"
    />
    <button
      type="button"
      onclick={onSave}
      disabled={nameInput.trim().length === 0}
      class="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1
             hover:border-neutral-500 cursor-pointer disabled:opacity-50
             disabled:cursor-not-allowed"
      title="Save current frequency / mode / bandwidth"
    >
      <Plus size={12} />
      <span>Save</span>
    </button>
  </div>

  {#if memoryChannels.all.length === 0}
    <p class="text-neutral-600 italic text-center py-2">No channels saved yet.</p>
  {:else}
    <ul class="max-h-48 overflow-y-auto -mr-1 pr-1">
      {#each memoryChannels.all as c (c.id)}
        <li
          class="group flex items-center gap-2 py-1 border-b border-neutral-800/60 last:border-0"
        >
          <button
            type="button"
            onclick={() => recall(c.id)}
            class="flex-1 min-w-0 text-left flex items-baseline gap-2 hover:text-(--color-accent)
                   cursor-pointer"
            title="Recall {c.name}"
          >
            <span class="truncate text-neutral-200">{c.name}</span>
            <span class="text-neutral-500 text-[10px] flex-shrink-0">
              {formatHz(c.freq)} · {MODE_INFO[c.mode].label}
            </span>
          </button>
          <button
            type="button"
            onclick={() => memoryChannels.remove(c.id)}
            class="text-neutral-600 hover:text-amber-400 cursor-pointer opacity-0
                   group-hover:opacity-100 transition-opacity"
            title="Delete {c.name}"
            aria-label="Delete {c.name}"
          >
            <X size={12} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
