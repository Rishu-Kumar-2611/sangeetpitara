import { test, expect } from '@playwright/test';

// Two current browsers negotiate Opus; the listener receives version 2 frames,
// plays them, and uses a fraction of the PCM16 bandwidth.
test('browsers negotiate Opus, play it, and use far less bandwidth than PCM16', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  });
  await page.goto('/');
  const hasWebCodecs = await page.evaluate(async () => typeof AudioDecoder !== 'undefined'
    && (await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })).supported
    && typeof AudioEncoder !== 'undefined');
  test.skip(!hasWebCodecs, 'This browser build has no WebCodecs Opus support.');

  await page.locator('[data-open-screen="create"]').click();
  await page.getByLabel('Your display name').fill('Opus host');
  await page.getByLabel('Room name', { exact: true }).fill('Opus check');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-view')).toBeVisible();
  const code = (await page.locator('#room-code-display').textContent()).trim();

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const guest = await context.newPage();
    const frames = [];
    guest.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') frames.push({ at: Date.now(), version: payload[4], bytes: payload.length });
    }));
    await guest.goto('/');
    await guest.locator('[data-open-screen="join"]').click();
    await guest.getByLabel('Your display name').fill('Opus listener');
    await guest.getByLabel('Room code', { exact: true }).fill(code);
    await guest.locator('#join-room').click();
    await expect(guest.locator('#room-view')).toBeVisible();

    await page.locator('#share-audio').click();
    await guest.locator('#room-tab-health').click();
    const packets = () => guest.locator('.health-metric').filter({ hasText: 'Audio packets' }).locator('strong').textContent().then((text) => Number(text.replaceAll(',', '')));
    await expect.poll(packets, { timeout: 15_000 }).toBeGreaterThan(100);

    const opusFrames = frames.filter((frame) => frame.version === 2);
    expect(opusFrames.length).toBeGreaterThan(100);
    expect(frames.filter((frame) => frame.version === 1).length).toBe(0);
    // Measure steady-state bytes per second over the received Opus frames.
    const steady = opusFrames.slice(10);
    const seconds = (steady.at(-1).at - steady[0].at) / 1000;
    const bytesPerSecond = steady.reduce((sum, frame) => sum + frame.bytes, 0) / seconds;
    console.log(`Opus relay: ${Math.round(bytesPerSecond)} B/s (PCM16 would be about 97,000 B/s)`);
    expect(bytesPerSecond).toBeLessThan(25_000);

    await expect(guest.locator('.health-metric').filter({ hasText: 'Missing packets / 60 s' }).locator('strong')).toHaveText('0');
  } finally {
    await context.close();
  }
});
