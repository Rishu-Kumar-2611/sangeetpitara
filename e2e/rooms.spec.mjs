import { test, expect } from '@playwright/test';

test('browser room creation, separate listener, chat, reconnect and leaving', async ({ page, browser }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Get SangeetPitara for Android')).toBeVisible();
  await expect(page.locator('#cookie-banner')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('landing.png'), fullPage: true });
  if (await page.locator('#welcome-actions').isVisible()) await page.locator('[data-open-screen="create"]').click();
  await page.getByLabel('Your display name').fill('Browser host');
  await page.getByLabel('Room name', { exact: true }).fill('Production check');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-title')).toHaveText('Production check');
  await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('forest');
  await expect(page.locator('#room-title')).toHaveText('Production check');
  const code = (await page.locator('#room-code-display').textContent()).trim();
  const listenerContext = await browser.newContext();
  try {
    const listener = await listenerContext.newPage();
    await listener.goto('/');
    await listener.locator('[data-open-screen="join"]').click();
    await listener.getByLabel('Your display name').fill('Browser listener');
    await listener.getByLabel('Room code', { exact: true }).fill(code);
    await listener.locator('#join-room').click();
    await expect(listener.locator('#room-title')).toHaveText('Production check');
    await page.getByLabel('Message the room').fill('Hello from the browser regression');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(listener.locator('#chat-feed')).toContainText('Hello from the browser regression');
    await page.reload();
    // Reload returns to entry; the persisted capability lets the host rejoin.
    await page.getByLabel('Your display name').fill('Browser host');
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

test('four themes persist across reload and keep the welcome layout usable', async ({ page }, info) => {
  await page.goto('/');
  const picker=page.getByRole('combobox',{name:'Theme',exact:true});
  await expect(picker.locator('option')).toHaveCount(4);
  const colors=[];
  for(const key of ['brass','midnight','forest','rose']){
    await picker.selectOption(key);await expect(page.locator('html')).toHaveAttribute('data-theme',key);
    colors.push(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`theme-${key}.png`),fullPage:true});
  }
  expect(new Set(colors).size).toBe(4);
  await page.reload();await expect(picker).toHaveValue('rose');await expect(page.locator('html')).toHaveAttribute('data-theme','rose');
});

test('room creation remains usable when localStorage is denied', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
    get() { throw new DOMException('Storage denied', 'SecurityError'); },
  }));
  await page.goto('/');
  await page.locator('[data-open-screen="create"]').click();
  await page.getByLabel('Your display name').fill('Transient guest');
  await page.getByLabel('Room name', { exact: true }).fill('Transient room');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-title')).toHaveText('Transient room');
});


test('welcome is minimal and entry screens navigate without mixing forms', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#welcome-actions')).toBeVisible();
  await expect(page.locator('.online-entry')).toBeHidden();
  await expect(page.locator('.nearby-card')).toBeHidden();
  const arrows=await page.locator('#welcome-actions [data-open-screen]').evaluateAll(cards=>cards.map(card=>{
    const arrow=card.querySelector('b'),a=arrow.getBoundingClientRect(),c=card.getBoundingClientRect();
    return {text:arrow.textContent,x:a.x,offset:Math.abs(a.y+a.height/2-c.y-c.height/2)};
  }));
  expect(arrows.map(a=>a.text)).toEqual(['→','→','→']);
  expect(arrows.every(a=>a.offset<1)).toBe(true);
  expect(Math.max(...arrows.map(a=>a.x))-Math.min(...arrows.map(a=>a.x))).toBeLessThan(1);
  await page.locator('[data-open-screen="join"]').click();
  await expect(page.locator('#join-panel')).toBeVisible();
  await expect(page.locator('#create-panel')).toBeHidden();
  await page.goBack();
  await expect(page.locator('#welcome-actions')).toBeVisible();
  await page.locator('[data-open-screen="nearby"]').click();
  await expect(page.locator('.nearby-card')).toBeVisible();
  await expect(page.locator('.online-entry')).toBeHidden();
  await page.locator('#entry-back').click();
  await expect(page.locator('#welcome-actions')).toBeVisible();
});
