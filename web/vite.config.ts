import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

// COOP/COEP headers required for SharedArrayBuffer (used by the DSP worker
// ring buffers). Mirrored in `public/_headers` for production.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    headers: isolationHeaders,
    port: 5173,
  },
  preview: {
    headers: isolationHeaders,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
