import { test, expect } from '@playwright/test';

for (const width of [320, 390]) {
  test(`manual fits a ${width}px phone and keeps topic navigation working`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/guide.html');
    const checkWidth = async () => expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await checkWidth();
    await page.locator('[data-topic="host-room"]').click();
    await expect(page.locator('#panel-host-room')).toBeVisible();
    await checkWidth();
    await page.locator('[data-mode="mobile"]').click();
    await expect(page.locator('#host-mode-mobile')).toBeVisible();
    await checkWidth();
    const images = page.locator('#host-mode-mobile img');
    for (let i = 0; i < await images.count(); i++) {
      await expect.poll(() => images.nth(i).evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    }
    await page.locator('.back-to-topics-btn:visible').first().click();
    await expect(page.locator('#topicsGridView')).toBeVisible();
    await checkWidth();
  });
}
