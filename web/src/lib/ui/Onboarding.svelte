<script lang="ts">
  import { X, ExternalLink, Monitor, Apple, Terminal } from 'lucide-svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  type Os = 'windows' | 'mac' | 'linux';
  function detectOs(): Os {
    if (typeof navigator === 'undefined') return 'windows';
    const ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return 'mac';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return 'windows';
  }

  let activeOs = $state<Os>(detectOs());

  function close() {
    open = false;
  }

  function dontShowAgain() {
    try {
      localStorage.setItem('moshon.onboarding.dismissed.v1', '1');
    } catch {
      // localStorage unavailable — fine, dismissal is non-critical.
    }
    close();
  }

  function onBackdropKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    onkeydown={onBackdropKey}
    role="dialog"
    aria-modal="true"
    aria-labelledby="onboarding-title"
    tabindex="-1"
  >
    <div
      class="relative w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-950
             shadow-2xl"
    >
      <button
        type="button"
        onclick={close}
        class="absolute top-3 right-3 text-neutral-500 hover:text-neutral-200
               cursor-pointer"
        aria-label="Close"
      >
        <X size={16} />
      </button>

      <div class="p-6">
        <h2 id="onboarding-title" class="text-lg font-medium text-neutral-100 mb-1">
          Welcome to Moshon SDR
        </h2>
        <p class="text-sm text-neutral-400 mb-4">
          To use a USB-connected RTL-SDR dongle, your browser needs the right driver
          on your OS. Pick yours below.
        </p>

        <div class="flex gap-2 mb-4 text-xs font-mono">
          {#each [['windows', 'Windows', Monitor], ['mac', 'macOS', Apple], ['linux', 'Linux', Terminal]] as const as [id, label, Icon] (id)}
            <button
              type="button"
              onclick={() => (activeOs = id)}
              class="flex-1 inline-flex items-center justify-center gap-1.5 rounded
                     border px-3 py-1.5 cursor-pointer"
              class:bg-neutral-900={activeOs !== id}
              class:border-neutral-700={activeOs !== id}
              class:text-neutral-400={activeOs !== id}
              class:bg-neutral-800={activeOs === id}
              class:border-neutral-600={activeOs === id}
              class:text-neutral-100={activeOs === id}
            >
              <Icon size={12} />
              <span>{label}</span>
            </button>
          {/each}
        </div>

        <div class="rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-300 space-y-3">
          {#if activeOs === 'windows'}
            <p>
              Windows ships a generic driver for the RTL2832U that blocks WebUSB. Replace
              it with WinUSB using <strong>Zadig</strong>.
            </p>
            <ol class="list-decimal list-inside space-y-1 text-neutral-400">
              <li>
                Download Zadig:
                <a
                  href="https://zadig.akeo.ie/"
                  target="_blank"
                  rel="noreferrer"
                  class="text-(--color-accent) hover:underline inline-flex items-center gap-1"
                >
                  zadig.akeo.ie
                  <ExternalLink size={11} />
                </a>
              </li>
              <li>Plug in your RTL-SDR dongle.</li>
              <li>In Zadig: Options → List All Devices.</li>
              <li>Select <code class="text-neutral-200">Bulk-In, Interface (Interface 0)</code>.</li>
              <li>Set the target driver to <code class="text-neutral-200">WinUSB</code> and click Replace Driver.</li>
              <li>Reload this page and click <em>Connect RTL-SDR</em>.</li>
            </ol>
          {:else if activeOs === 'mac'}
            <p>
              macOS lets Chrome / Edge / Brave talk to the dongle directly — no driver
              install needed in most cases.
            </p>
            <ol class="list-decimal list-inside space-y-1 text-neutral-400">
              <li>Plug in your RTL-SDR dongle.</li>
              <li>Use Chrome, Edge, or Brave (Safari doesn't support WebUSB).</li>
              <li>Click <em>Connect RTL-SDR</em> below and pick your device.</li>
              <li>
                If the picker shows no devices, quit any other SDR app that might
                hold the device open (e.g. CubicSDR, SDR++, GQRX).
              </li>
            </ol>
          {:else}
            <p>
              Linux needs a udev rule so a non-root user can open the dongle, and the
              kernel <code class="text-neutral-200">dvb_usb_rtl28xxu</code> driver must
              not claim it.
            </p>
            <ol class="list-decimal list-inside space-y-1 text-neutral-400">
              <li>
                Blacklist the kernel driver:
                <pre class="mt-1 p-2 bg-neutral-950 rounded text-[11px] text-neutral-300 whitespace-pre-wrap font-mono">echo 'blacklist dvb_usb_rtl28xxu' \
  | sudo tee /etc/modprobe.d/no-rtl.conf</pre>
              </li>
              <li>
                Add a udev rule:
                <pre class="mt-1 p-2 bg-neutral-950 rounded text-[11px] text-neutral-300 whitespace-pre-wrap font-mono">echo 'SUBSYSTEM=="usb", ATTRS&#123;idVendor&#125;=="0bda", ATTRS&#123;idProduct&#125;=="2832", MODE="0660", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/20-rtlsdr.rules
sudo udevadm control --reload-rules</pre>
              </li>
              <li>
                Add yourself to plugdev:
                <code class="text-neutral-200 text-[11px]">sudo usermod -aG plugdev $USER</code>
                (log out + back in).
              </li>
              <li>Plug in the dongle and click <em>Connect RTL-SDR</em>.</li>
            </ol>
          {/if}
        </div>

        <p class="mt-4 text-xs text-neutral-500">
          More detail in the
          <a
            href="https://github.com/matsvandamme/moshon-sdr#hardware-setup"
            target="_blank"
            rel="noreferrer"
            class="text-neutral-300 hover:text-(--color-accent) underline decoration-dotted"
          >README</a>.
        </p>

        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onclick={dontShowAgain}
            class="rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200
                   px-3 py-1.5 text-xs font-mono cursor-pointer"
          >
            Don't show again
          </button>
          <button
            type="button"
            onclick={close}
            class="rounded bg-(--color-accent) text-neutral-950 px-3 py-1.5 text-xs
                   font-medium hover:bg-(--color-accent-strong) cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
