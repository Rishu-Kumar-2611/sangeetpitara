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

test('replacement tab stops automatic reconnect instead of fighting the active tab', async ({page,context})=>{
 await page.goto('/');await page.locator('[data-open-screen="create"]').click();
 await page.getByLabel('Your display name').fill('Original');await page.getByLabel('Room name',{exact:true}).fill('Tab recovery');await page.locator('#create-room').click();
 await expect(page.locator('#room-title')).toHaveText('Tab recovery');
 const code=(await page.locator('#room-code-display').textContent()).trim();
 const replacement=await context.newPage();await replacement.goto('/');await replacement.locator('[data-open-screen="join"]').click();
 await replacement.getByLabel('Your display name').fill('Replacement');await replacement.getByLabel('Room code',{exact:true}).fill(code);await replacement.locator('#join-room').click();
 await expect(replacement.locator('#room-title')).toHaveText('Tab recovery');
 await expect(page.locator('#welcome-actions')).toBeVisible();
 await page.waitForTimeout(3500);
 await expect(replacement.locator('#room-title')).toHaveText('Tab recovery');
 await expect(page.locator('#welcome-actions')).toBeVisible();
});

test('relay health shows ideal ranges and does not borrow listener underruns for a publisher',async({page},info)=>{
 await page.addInitScript(()=>{navigator.mediaDevices.getDisplayMedia=async()=>{
  const context=new AudioContext();const osc=context.createOscillator();const destination=context.createMediaStreamDestination();osc.connect(destination);osc.start();window.testAudioContext=context;return destination.stream;
 };});
 await page.goto('/');await page.locator('[data-open-screen="create"]').click();
 await page.getByLabel('Your display name').fill('Health host');await page.getByLabel('Room name',{exact:true}).fill('Health check');await page.locator('#create-room').click();
 await expect(page.locator('#room-title')).toHaveText('Health check');
 await page.locator('#share-audio').click();
 await expect(page.locator('#telemetry-list')).toContainText('Outgoing queue');
 await expect(page.locator('#telemetry-list')).toContainText('Ideal: 0–100 ms');
 await expect(page.locator('#telemetry-list')).not.toContainText('Underruns / 60 s');
 await expect(page.locator('#telemetry-list')).toContainText('No fixed ideal');
 await expect.poll(async()=>Number((await page.locator('.health-metric').filter({hasText:'Audio packets'}).locator('strong').textContent()).replaceAll(',',''))).toBeGreaterThan(10);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 if (await page.locator('#room-tab-health').isVisible()) await page.locator('#room-tab-health').click();
 await page.locator('#telemetry-panel').screenshot({path:info.outputPath('health.png')});
});

test('audio diagnostic export contains bounded measurements without room identity or invite secrets',async({page})=>{
 await page.goto('/');await page.locator('[data-open-screen="create"]').click();await page.getByLabel('Your display name').fill('Private diagnostic name');await page.getByLabel('Room name',{exact:true}).fill('Private diagnostic room');await page.locator('#create-room').click();
 await expect(page.locator('#room-title')).toHaveText('Private diagnostic room');const code=(await page.locator('#room-code-display').textContent()).trim();
 if(await page.locator('#room-tab-health').isVisible())await page.locator('#room-tab-health').click();
 const downloading=page.waitForEvent('download');await page.locator('#export-audio-diagnostics').click();const download=await downloading;
 const stream=await download.createReadStream();let text='';for await(const chunk of stream)text+=chunk.toString();const data=JSON.parse(text);
 expect(data.schemaVersion).toBe(1);expect(data.samples.length).toBeGreaterThan(0);expect(data.samples.length).toBeLessThanOrEqual(300);
 for(const privateText of [code,'Private diagnostic name','Private diagnostic room','roomsound-reconnect-secret','http://','https://'])expect(text).not.toContain(privateText);
 expect(data.samples.at(-1).direction).toBe('idle');
});
