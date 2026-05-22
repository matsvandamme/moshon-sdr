<script lang="ts">
  import { X } from 'lucide-svelte';
  import { parseFrequency, formatHz } from '../state/tuning.svelte';

  let {
    open = $bindable(false),
    initialValue = '',
    onSubmit,
  }: {
    open: boolean;
    initialValue?: string;
    onSubmit: (hz: number) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let raw = $state(initialValue);
  let inputEl: HTMLInputElement | null = $state(null);

  let parsed = $derived(parseFrequency(raw));
  let valid = $derived(parsed !== null);

  // svelte-ignore state_referenced_locally
  $effect(() => {
    if (open) {
      raw = initialValue;
      queueMicrotask(() => inputEl?.focus());
    }
  });

  function submit() {
    if (parsed === null) return;
    onSubmit(parsed);
    open = false;
  }

  function close() {
    open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore state_referenced_locally -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-24"
    role="dialog"
    aria-modal="true"
    aria-label="Enter frequency"
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
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-medium text-neutral-200 uppercase tracking-wide">
          Frequency
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

      <input
        bind:this={inputEl}
        bind:value={raw}
        onkeydown={onKey}
        type="text"
        inputmode="decimal"
        placeholder="e.g. 100.5, 144M, 14230k, 7074000"
        autocomplete="off"
        spellcheck="false"
        class="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2
               text-neutral-100 font-mono text-lg focus:outline-none
               focus:border-(--color-accent)"
        class:border-amber-700={raw !== '' && !valid}
      />

      <div class="mt-2 text-xs font-mono">
        {#if valid && parsed !== null}
          <span class="text-emerald-400">→ {formatHz(parsed)}</span>
        {:else if raw !== ''}
          <span class="text-amber-400">Couldn't parse — try 100.5, 144M, 7074000…</span>
        {:else}
          <span class="text-neutral-500">
            Default unit is MHz. Suffix with k / M / G or "Hz" to override.
          </span>
        {/if}
      </div>

      <div class="mt-4 flex justify-end gap-2 text-sm">
        <button
          type="button"
          onclick={close}
          class="px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={submit}
          disabled={!valid}
          class="px-3 py-1.5 rounded bg-(--color-accent) text-neutral-950
                 hover:bg-(--color-accent-strong) disabled:opacity-50
                 disabled:cursor-not-allowed cursor-pointer"
        >
          Tune
        </button>
      </div>
    </div>
  </div>
{/if}
