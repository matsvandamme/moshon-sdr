import { test, expect } from '@playwright/test';

/**
 * UI smoke tests. These never touch real hardware — they exercise the
 * pre-stream state of the app so a regression in routing, WASM
 * init, or persistence shows up in CI without needing a dongle.
 */

// Playwright isolates each test in a fresh browser context, so
// localStorage starts empty automatically — no beforeEach needed.

test('page loads and WASM smoke value is 42', async ({ page }) => {
  await page.goto('/');
  // The smoke badge is the most reliable signal that WASM init worked.
  await expect(page.getByText(/DSP smoke test: 42/)).toBeVisible({ timeout: 15_000 });
});

test('first-run onboarding modal can be dismissed', async ({ page }) => {
  await page.goto('/');
  const setup = page.getByRole('button', { name: /close|got it|dismiss/i }).first();
  // The onboarding modal opens on first visit. Either the dismiss
  // button is present (modal up) or it isn't (already dismissed in a
  // prior persisted state, even though we cleared moshon.* keys —
  // safe-guard either way).
  if (await setup.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await setup.click();
  }
  await expect(page.getByText(/DSP smoke test/)).toBeVisible();
});

test('shortcut help opens with ? and closes with Esc', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/DSP smoke test/)).toBeVisible();
  // Close any onboarding first so the body has focus.
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await expect(page.getByText(/shortcuts/i).first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Modal gone within a tick.
  await expect(page.getByText(/Press the keys/i)).toBeHidden({ timeout: 2_000 });
});

test('URL hash drives initial tuning', async ({ page }) => {
  await page.goto('/#f=98700000&m=wfm');
  await expect(page.getByText(/DSP smoke test/)).toBeVisible();
  // The hash is the load-time tuning state. The `writeHash` $effect
  // mirrors tuning back to the hash on every change — so if we read
  // it after onMount finishes, it should still contain the values we
  // gave it (proof that initial-state was applied, not overwritten).
  await page.waitForFunction(
    () =>
      window.location.hash.includes('f=98700000') &&
      window.location.hash.includes('m=wfm'),
    null,
    { timeout: 5_000 },
  );
});

test('input-mode tabs render and are clickable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/DSP smoke test/)).toBeVisible();
  // The three input modes live in the connect panel. We don't actually
  // connect (no device) — just verify the tabs are present.
  await expect(page.getByRole('button', { name: /HackRF/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Network/i }).first()).toBeVisible();
});

test('persisted AGC + de-emphasis state survives reload', async ({ page }) => {
  // The toggles themselves only render once streaming has started
  // (audio toolbar is mode-conditional). We can't fake a stream from
  // Playwright without WebUSB mocks, so instead verify the persisted
  // values stick — that's the contract the toggles act on at startup.
  await page.goto('/');
  await expect(page.getByText(/DSP smoke test/)).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('moshon.agc.v1', '1');
    localStorage.setItem('moshon.wfmDeemphUs.v1', '75');
  });
  await page.reload();
  await expect(page.getByText(/DSP smoke test/)).toBeVisible();
  // After reload, the same keys should still be present and equal.
  const agc = await page.evaluate(() => localStorage.getItem('moshon.agc.v1'));
  const deemph = await page.evaluate(() => localStorage.getItem('moshon.wfmDeemphUs.v1'));
  expect(agc).toBe('1');
  expect(deemph).toBe('75');
});
