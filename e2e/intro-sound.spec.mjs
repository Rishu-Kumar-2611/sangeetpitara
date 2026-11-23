import { test, expect } from '@playwright/test';

for (const [name, policy] of [
  ['autoplay allowed', 'no-user-gesture-required'],
  ['first visit requires a tap', 'document-user-activation-required'],
]) {
  test(name + ' plays the lid and seven landings @intro-sound', async ({ playwright, baseURL }, testInfo) => {
    const browser = await playwright.chromium.launch({ args: ['--autoplay-policy=' + policy] });
    try {
      const { viewport, hasTouch, isMobile } = testInfo.project.use;
      const page = await browser.newPage({ baseURL, viewport, hasTouch, isMobile });
      await page.addInitScript(() => {
        // Meter the browser's decoded media output while the real animation runs.
        window.introLevels = Array(8).fill(0);
        window.landingErrors = Array(7).fill(null);
        document.addEventListener('playing', async event => {
          const media = event.target;
          if (media.id !== 'intro-track' || window.introMeterAttached) return;
          window.introMeterAttached = true;
          const audio = new AudioContext();
          const meter = audio.createAnalyser();
          meter.fftSize = 1024;
          audio.createMediaElementSource(media).connect(meter).connect(audio.destination);
          await audio.resume();
          const waveform = new Float32Array(meter.fftSize);
          // Measure the sustained lid resonance after the old short impact would have faded.
          const cues = [1.45, 2.569, 2.939, 3.309, 3.679, 4.049, 4.419, 4.789];
          const flights = [...document.querySelectorAll('.pitara-piece')]
            .flatMap(piece => piece.getAnimations())
            .filter(motion => motion.effect.getTiming().duration === 1450)
            .sort((a, b) => a.effect.getTiming().delay - b.effect.getTiming().delay);
          const timer = setInterval(() => {
            meter.getFloatTimeDomainData(waveform);
            const peak = waveform.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
            cues.forEach((time, i) => {
              if (media.currentTime >= time && media.currentTime < time + (i === 0 ? .62 : .31)) {
                window.introLevels[i] = Math.max(window.introLevels[i], peak);
                if (i && peak > .025 && flights[i-1] && window.landingErrors[i-1] === null) {
                  const motion = flights[i-1];
                  const timing = motion.effect.getTiming();
                  const contact = timing.delay + timing.duration * .82;
                  window.landingErrors[i-1] = Math.abs((motion.currentTime - contact) -
                    (media.currentTime - time) * 1000);
                }
              }
            });
            if (media.ended || (media.paused && media.currentTime > 0)) {
              clearInterval(timer);
              audio.close();
            }
          }, 12);
        }, true);
      });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.box-scene')).toHaveClass(/open/);
      await expect(page.locator('#intro-audio, #open-box-sound')).toHaveCount(0);
      if (policy === 'document-user-activation-required') {
        await expect(page.locator('#intro-track')).toHaveJSProperty('paused', true);
        if (hasTouch) await page.touchscreen.tap(8, 8);
        else await page.mouse.click(8, 8);
      }
      await expect.poll(() => page.evaluate(() => window.introLevels.map(peak => peak > .025)),
        { timeout: 10000 }).toEqual(Array(8).fill(true));
      const errors = await page.evaluate(() => window.landingErrors);
      for (const error of errors) expect(error).toBeLessThan(100);
    } finally {
      await browser.close();
    }
  });
}

test('supplies the opening audio byte range for phone media players @intro-sound', async ({ request }) => {
  const response = await request.get('/branding/sangeetpitara/intro-sound.mp3?v=5', {
    headers: { Range: 'bytes=0-1' },
  });
  expect(response.status()).toBe(206);
  expect(response.headers()['content-type']).toBe('audio/mpeg');
  expect(response.headers()['content-range']).toMatch(/^bytes 0-1\/\d+$/);
  expect((await response.body()).length).toBe(2);
});
