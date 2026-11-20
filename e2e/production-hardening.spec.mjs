import { test, expect } from '@playwright/test';

async function hostRoom(page, name) {
  await page.goto('/');
  await page.locator('[data-open-screen="create"]').click();
  await page.getByLabel('Your display name').fill('Hardening host');
  await page.getByLabel('Room name', { exact: true }).fill(name);
  await page.locator('#create-room').click();
  await expect(page.locator('#room-view')).toBeVisible();
  return (await page.locator('#room-code-display').textContent()).trim();
}

test('readiness and audio recovery explain their limits and keep the room usable', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-open-screen="create"]').click();
  await page.locator('.connection-check summary').click();
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.locator('#connection-check-result')).toContainText('Server ready.');
  await expect(page.locator('#connection-check-result')).toContainText('No sound has been captured');
  await page.getByLabel('Your display name').fill('Recovery host');
  await page.getByLabel('Room name', { exact: true }).fill('Recovery controls');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-view')).toBeVisible();
  await page.locator('#room-tab-health').click();
  await page.getByRole('button', { name: 'Recover audio', exact: true }).click();
  await expect(page.locator('#room-view')).toBeVisible();
  await page.locator('#settings-button').click();
  await page.locator('#room-settings').click();
  await expect(page.locator('.settings-modal')).not.toContainText('up to 10 people');
  await expect(page.locator('.settings-modal')).toContainText('Extra tabs count as connections');
});

test('guest reporting and slow mode work while moderators can remove a participant message', async ({ page, browser }) => {
  const code = await hostRoom(page, 'Moderation controls');
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const guest = await context.newPage();
    await guest.goto('/');
    await guest.locator('[data-open-screen="join"]').click();
    await guest.getByLabel('Your display name').fill('Hardening guest');
    await guest.getByLabel('Room code', { exact: true }).fill(code);
    await guest.locator('#join-room').click();
    await expect(guest.locator('#room-view')).toBeVisible();
    await page.locator('#settings-button').click();
    await page.locator('#room-settings').click();
    await page.getByLabel('Chat slow mode', { exact: true }).selectOption('5');
    await page.locator('.settings-modal .modal-close').click();
    await guest.locator('#room-tab-chat').click();
    await guest.locator('#chat-input').fill('First allowed message');
    await guest.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(guest.locator('#chat-feed')).toContainText('First allowed message');
    await guest.locator('#chat-input').fill('Second message should wait');
    await guest.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(guest.getByText(/Chat slow mode is on/).last()).toBeVisible();
    await guest.locator('#room-tab-people').click();
    await guest.getByRole('button', { name: 'Actions for Hardening host', exact: true }).click();
    await guest.getByRole('button', { name: 'Report to owner', exact: true }).click();
    await guest.getByLabel('What happened?', { exact: true }).fill('Synthetic report used to verify the local moderation flow.');
    await guest.getByRole('button', { name: 'Send report', exact: true }).click();
    await expect(guest.getByText('Report sent privately to the owner for review.', { exact: true }).last()).toBeVisible();
    await page.locator('#room-tab-chat').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.chat-message').filter({ hasText: 'First allowed message' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(guest.locator('#chat-feed')).toContainText('Message removed by a moderator');
  } finally { await context.close(); }
});

test('owner password form checks confirmation and clears credentials after a successful change', async ({ page }) => {
  let submitted = 0;
  const counts = { users: 0, onlineMs: 0, listeningMs: 0, roomsCreated: 0, sessions: 0, reconnects: 0, dropped: 0 };
  await page.route('**/api/admin/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/password') {
      submitted++;
      expect(route.request().postDataJSON().newPassword).toBe('Synthetic replacement password 2026');
      await route.fulfill({ json: { ok: true, signedOut: true } });
    } else if (path === '/api/admin/analytics') {
      await route.fulfill({ json: { live: { users: 0, sessions: 0, rooms: 0, streams: 0, version: '1.1.27' }, totals: counts,
        lifetime: counts, daily: [], platforms: [], durable: true, updatedAt: new Date().toISOString() } });
    } else { await route.fulfill({ json: { ok: true } }); }
  });
  await page.goto('/admin');
  await expect(page.locator('#dashboard')).toBeVisible();
  const form = page.locator('#change-password');
  await form.getByLabel('Current password', { exact: true }).fill('Synthetic current password 2026');
  await form.getByLabel('New password', { exact: true }).fill('Synthetic replacement password 2026');
  await form.getByLabel('Confirm new password', { exact: true }).fill('A different synthetic password');
  await form.getByLabel('Fresh authenticator or recovery code', { exact: true }).fill('123456');
  await form.getByRole('button').click();
  await expect(page.locator('#status')).toContainText('do not match');
  expect(submitted).toBe(0);
  await form.getByLabel('Confirm new password', { exact: true }).fill('Synthetic replacement password 2026');
  await form.getByRole('button').click();
  await expect(page.locator('#login-panel')).toBeVisible();
  expect(submitted).toBe(1);
  await expect(form.getByLabel('New password', { exact: true })).toHaveValue('');
});
