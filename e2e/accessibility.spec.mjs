import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// WCAG 2.1 A/AA checks on every main screen, in both appearances. Third-party
// ad frames are not ours to fix, so they are left out of the scan.
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function audit(page, label) {
  // Measure settled colours, not a frame halfway through a fade or theme change.
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const results = await new AxeBuilder({ page }).withTags(WCAG).exclude('iframe').analyze();
  const summary = results.violations.map((violation) => ({
    screen: label,
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.slice(0, 5).map((node) => `${node.target.join(' ')} | ${(node.any[0]?.message || node.failureSummary || '').slice(0, 180)}`),
  }));
  expect(summary, `${label}: ${JSON.stringify(summary, null, 2)}`).toEqual([]);
}

async function useTheme(page, theme) {
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

// One room for both appearances: the server limits how many rooms one
// address may create, and later specs need their share of that budget.
test('main screens pass WCAG 2.1 AA checks in both appearances', async ({ page }) => {
  await page.goto('/');
  for (const theme of ['dark', 'light']) {
    await useTheme(page, theme);
    await audit(page, `welcome (${theme})`);
  }

  if (await page.locator('#welcome-actions').isVisible()) await page.locator('[data-open-screen="join"]').click();
  await expect(page.getByLabel('Room code', { exact: true })).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await useTheme(page, theme);
    await audit(page, `join (${theme})`);
  }

  await page.goto('/');
  if (await page.locator('#welcome-actions').isVisible()) await page.locator('[data-open-screen="create"]').click();
  else await page.locator('[data-entry-tab="create"]').click();
  await expect(page.getByLabel('Room name', { exact: true })).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await useTheme(page, theme);
    await audit(page, `create (${theme})`);
  }

  await page.getByLabel('Your display name').fill('Access host');
  await page.getByLabel('Room name', { exact: true }).fill('Access check');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-title')).toHaveText('Access check');
  for (const tab of ['listen', 'chat', 'people', 'health']) {
    const button = page.locator(`#room-tab-${tab}`);
    if (!(await button.count()) || !(await button.isVisible())) continue;
    await button.click();
    for (const theme of ['dark', 'light']) {
      await useTheme(page, theme);
      await audit(page, `room ${tab} (${theme})`);
    }
  }
});

test('invite links open the join form with the code filled in', async ({ page }) => {
  await page.goto('/join/abcd-2345');
  await expect(page).toHaveURL(/\/\?room=ABCD2345$/);
  await expect(page.getByLabel('Room code', { exact: true })).toHaveValue(/ABCD.?2345/);
  const links = await (await page.request.get('/.well-known/assetlinks.json')).json();
  expect(links[0].target.package_name).toBe('com.roomsound.android');
  expect(links[0].target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});
