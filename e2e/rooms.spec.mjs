import { test, expect } from '@playwright/test';

test('browser room creation, separate listener, chat, reconnect and leaving', async ({ page, browser }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Get SangeetPitara for Android')).toBeVisible();
  await expect(page.locator('#cookie-banner')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('landing.png'), fullPage: true });
  await page.getByLabel('Your display name').fill('Browser host');
  await page.getByLabel('Room name', { exact: true }).fill('Production check');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-title')).toHaveText('Production check');
  const code = (await page.locator('#room-code-display').textContent()).trim();
  const listenerContext = await browser.newContext();
  try {
    const listener = await listenerContext.newPage();
    await listener.goto('/');
    await listener.getByLabel('Your display name').fill('Browser listener');
    await listener.locator('#join-tab').click();
    await listener.getByLabel('Room code', { exact: true }).fill(code);
    await listener.locator('#join-room').click();
    await expect(listener.locator('#room-title')).toHaveText('Production check');
    await page.getByLabel('Message the room').fill('Hello from the browser regression');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(listener.locator('#chat-feed')).toContainText('Hello from the browser regression');
    await page.reload();
    // Reload returns to entry; the persisted capability lets the host rejoin.
    await page.getByLabel('Your display name').fill('Browser host');
    await page.locator('#join-tab').click();
    await page.getByLabel('Room code', { exact: true }).fill(code);
    await page.locator('#join-room').click();
    await expect(page.locator('#room-title')).toHaveText('Production check');
    await page.locator('#settings-button').click();
    await page.locator('#leave-room').click();
    const dialog = page.getByRole('dialog', { name: 'Leave this room?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Stay in room', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Leave room', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Leave room', exact: true }).click();
    await expect(page.locator('#landing-view')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await listenerContext.close(); }
});

test('room creation remains usable when localStorage is denied', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
    get() { throw new DOMException('Storage denied', 'SecurityError'); },
  }));
  await page.goto('/');
  await page.getByLabel('Your display name').fill('Transient guest');
  await page.getByLabel('Room name', { exact: true }).fill('Transient room');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-title')).toHaveText('Transient room');
});
