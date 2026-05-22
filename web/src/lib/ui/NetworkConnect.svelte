<script lang="ts">
  import { Wifi } from 'lucide-svelte';

  let {
    bridgeUrl = $bindable(''),
    rtlTcpTarget = $bindable(''),
    onConnect,
    disabled = false,
  }: {
    bridgeUrl?: string;
    rtlTcpTarget?: string;
    onConnect: () => void;
    disabled?: boolean;
  } = $props();

  function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    onConnect();
  }
</script>

<form
  onsubmit={onSubmit}
  class="space-y-3"
  aria-label="Connect to rtl_tcp via bridge"
>
  <p class="text-sm text-neutral-400">
    Run <code class="text-neutral-300 font-mono">moshon-bridge</code> on the machine
    that hosts your dongle, then point this page at it. The bridge proxies a local
    <code class="text-neutral-300 font-mono">rtl_tcp</code> server through a WebSocket.
  </p>

  <label class="block text-xs font-mono">
    <span class="text-neutral-500 uppercase mb-1 block">Bridge URL</span>
    <input
      type="text"
      bind:value={bridgeUrl}
      {disabled}
      placeholder="http://127.0.0.1:9090"
      class="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5
             text-neutral-200 placeholder:text-neutral-600 focus:outline-none
             focus:border-(--color-accent) disabled:opacity-60"
      autocomplete="off"
      spellcheck="false"
    />
  </label>

  <label class="block text-xs font-mono">
    <span class="text-neutral-500 uppercase mb-1 block">
      rtl_tcp target <span class="lowercase">(optional override)</span>
    </span>
    <input
      type="text"
      bind:value={rtlTcpTarget}
      {disabled}
      placeholder="127.0.0.1:1234"
      class="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5
             text-neutral-200 placeholder:text-neutral-600 focus:outline-none
             focus:border-(--color-accent) disabled:opacity-60"
      autocomplete="off"
      spellcheck="false"
    />
    <span class="text-neutral-600 mt-1 block">
      Leave blank to use the bridge's default target.
    </span>
  </label>

  <button
    type="submit"
    disabled={disabled || bridgeUrl.trim().length === 0}
    class="inline-flex items-center gap-2 rounded-md bg-(--color-accent)
           text-neutral-950 px-4 py-2 text-sm font-medium
           hover:bg-(--color-accent-strong) cursor-pointer
           disabled:opacity-50 disabled:cursor-not-allowed"
  >
    <Wifi size={16} />
    Connect &amp; Stream
  </button>
</form>
