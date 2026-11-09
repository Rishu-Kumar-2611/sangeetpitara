import { test, expect } from '@playwright/test';

// A brief connection drop (like the ones Render's network causes) is recovered
// at once, without alarming the listener, and the audio keeps arriving.
test('a brief connection drop reconnects quickly and quietly', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  });
  await page.goto('/');
  await page.locator('[data-open-screen="create"]').click();
  await page.getByLabel('Your display name').fill('Drop host');
  await page.getByLabel('Room name', { exact: true }).fill('Drop check');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-view')).toBeVisible();
  const code = (await page.locator('#room-code-display').textContent()).trim();
  await page.locator('#share-audio').click();

  const context = await browser.newContext();
  try {
    const listener = await context.newPage();
    const sockets = [];
    await listener.routeWebSocket(/.*/, (socket) => { socket.connectToServer(); sockets.push(socket); });
    await listener.goto('/');
    await listener.locator('[data-open-screen="join"]').click();
    await listener.getByLabel('Your display name').fill('Drop listener');
    await listener.getByLabel('Room code', { exact: true }).fill(code);
    await listener.locator('#join-room').click();
    await expect(listener.locator('#room-view')).toBeVisible();
    await listener.locator('#room-tab-health').click();
    const packets = () => listener.locator('.health-metric').filter({ hasText: 'Audio packets' }).locator('strong').textContent().then((text) => Number(text.replaceAll(',', '')));
    await expect.poll(packets, { timeout: 15_000 }).toBeGreaterThan(50);

    // Drop the connection the way a network cut would.
    const dropAt = Date.now();
    await sockets[0].close({ code: 4001, reason: 'Simulated network drop' });
    await expect.poll(() => sockets.length, { timeout: 5_000 }).toBe(2);
    expect(Date.now() - dropAt, 'reconnects almost at once').toBeLessThan(2_000);
    const before = await packets();
    await expect.poll(packets, { timeout: 10_000 }).toBeGreaterThan(before + 50);
    // Recovered before the notice delay: no alarming banner or toast.
    await expect(listener.locator('#room-banner')).toBeHidden();
    await expect(listener.locator('.toast-stack')).not.toContainText('Connection lost');
  } finally {
    await context.close();
  }
});
