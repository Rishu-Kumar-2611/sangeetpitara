import { test, expect } from '@playwright/test';

async function createRoom(page, name) {
  await page.goto('/');
  await page.locator('[data-open-screen="create"]').click();
  await page.getByLabel('Your display name').fill(name);
  await page.getByLabel('Room name', { exact: true }).fill('Chat extras');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-view')).toBeVisible();
  return (await page.locator('#room-code-display').textContent()).trim();
}

async function join(browser, code, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('[data-open-screen="join"]').click();
  await page.getByLabel('Your display name').fill(name);
  await page.getByLabel('Room code', { exact: true }).fill(code);
  await page.locator('#join-room').click();
  await expect(page.locator('#room-view')).toBeVisible();
  return { context, page };
}

test('the light appearance is the default for new visitors', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('unread chat messages show a count on the Chat tab until it is opened', async ({ page, browser }) => {
  const code = await createRoom(page, 'Badge host');
  const { context, page: listener } = await join(browser, code, 'Badge listener');
  try {
    const badge = listener.locator('#chat-unread-badge');
    await expect(badge).toBeHidden();
    await page.locator('#room-tab-chat').click();
    for (const text of ['First hello', 'Second hello']) {
      await page.getByLabel('Message the room').fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    }
    await expect(badge).toHaveText('2');
    await expect(listener.locator('#room-tab-chat')).toHaveAttribute('aria-label', 'Chat, 2 unread');
    // Your own messages never count.
    await expect(page.locator('#chat-unread-badge')).toBeHidden();
    await listener.locator('#room-tab-chat').click();
    await expect(badge).toBeHidden();
    // While Chat is open, new messages are seen at once.
    await page.getByLabel('Message the room').fill('Third hello');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(listener.locator('#chat-feed')).toContainText('Third hello');
    await expect(badge).toBeHidden();
  } finally { await context.close(); }
});

test('room music pauses while a voice message plays and returns after it', async ({ page, browser }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(); const osc = context.createOscillator(); const dest = context.createMediaStreamDestination();
      osc.connect(dest); osc.start(); return dest.stream;
    };
  });
  const code = await createRoom(page, 'Voice host');
  const { context, page: listener } = await join(browser, code, 'Voice listener');
  try {
    await page.locator('#room-tab-chat').click();
    await page.getByRole('button', { name: 'Record voice', exact: true }).click();
    await expect(page.locator('.chat-voice-preview')).toContainText('Recording 2 / 30 sec', { timeout: 6000 });
    await page.getByRole('button', { name: 'Stop and send voice', exact: true }).click();
    await listener.locator('#room-tab-chat').click();
    const audio = listener.locator('#chat-feed audio');
    await expect(audio).toHaveCount(1);
    await expect(listener.locator('#room-view')).not.toHaveAttribute('data-voice-playing', 'true');
    await audio.evaluate((element) => element.play());
    await expect(listener.locator('#room-view')).toHaveAttribute('data-voice-playing', 'true');
    // When the message ends, the music comes back.
    await expect(listener.locator('#room-view')).not.toHaveAttribute('data-voice-playing', 'true', { timeout: 10_000 });
  } finally { await context.close(); }
});
