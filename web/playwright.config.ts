import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — UI-only smoke checks for moshon-sdr.
 *
 * What this DOES test:
 *   - Page loads, DSP smoke value is 42 (WASM init succeeded)
 *   - Critical UI elements render
 *   - URL hash state survives a reload
 *   - localStorage persistence (memory channels, sample rate, etc.)
 *   - Mode-conditional controls show / hide correctly
 *
 * What this does NOT test:
 *   - Any WebUSB / WebSocket flow (no real hardware, no realistic mocks
 *     for navigator.usb in this project yet)
 *   - Audio output (AudioContext is gated on user-gesture and there's no
 *     bytes flowing without a source anyway)
 *
 * Hardware-level verification lives in [hardware-test-plan.md](../docs/hardware-test-plan.md).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
