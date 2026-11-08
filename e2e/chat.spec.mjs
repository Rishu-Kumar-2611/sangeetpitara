import { test, expect } from '@playwright/test';
async function create(page) {
 await page.goto('/');await page.locator('[data-open-screen="create"]').click();await page.getByLabel('Your display name').fill('Voice host');await page.getByLabel('Room name',{exact:true}).fill('Voice and replies');await page.locator('#create-room').click();await expect(page.locator('#room-view')).toBeVisible();
 return (await page.locator('#room-code-display').textContent()).trim();
}
test('record, preview and send a playable voice note; replies and new messages preserve playback',async({page,browser},info)=>{
 await page.addInitScript(()=>{
  navigator.mediaDevices.getUserMedia=async()=>{
   const context=new AudioContext(),osc=context.createOscillator(),dest=context.createMediaStreamDestination();osc.frequency.value=440;osc.connect(dest);osc.start();window.testMicStream=dest.stream;window.testMicContext=context;return dest.stream;
  };
 });
 const code=await create(page),other=await browser.newContext({viewport:{width:390,height:844}});
 try {
  const listener=await other.newPage();await listener.goto('/');await listener.locator('[data-open-screen="join"]').click();await listener.getByLabel('Your display name').fill('Voice listener');await listener.getByLabel('Room code',{exact:true}).fill(code);await listener.locator('#join-room').click();
  await page.locator('#room-tab-chat').click();await listener.locator('#room-tab-chat').click();
  await page.getByLabel('Message the room').fill('A message to reply to');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(listener.locator('#chat-feed')).toContainText('A message to reply to');
  await listener.locator('#chat-feed').getByRole('button',{name:'Reply',exact:true}).first().click();await listener.getByLabel('Message the room').fill('This replies to you');await listener.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.locator('.chat-quote')).toContainText('A message to reply to');
  await page.getByRole('button',{name:'Record voice',exact:true}).click();await expect(page.getByRole('button',{name:'Stop recording',exact:true})).toBeVisible();
  await expect(page.locator('.chat-voice-preview')).toContainText('Recording 4 / 30 sec',{timeout:7000});
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();await expect(page.getByRole('button',{name:'Send voice',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.testMicStream.getAudioTracks().every(t=>t.readyState==='ended'))).toBe(true);
  await page.getByRole('button',{name:'Send voice',exact:true}).click();
  const audio=listener.locator('#chat-feed audio');await expect(audio).toHaveCount(1);
  await audio.evaluate(async el=>{await el.play()});await expect.poll(()=>audio.evaluate(el=>el.currentTime)).toBeGreaterThan(.1);
  const before=await audio.evaluate(el=>el.currentTime);const src=await audio.getAttribute('src');
  await listener.locator('#room-tab-listen').click();await listener.locator('#request-audio').click();await listener.locator('#room-tab-chat').click();
  await page.getByLabel('Message the room').fill('Another message while listening');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(listener.locator('#chat-feed')).toContainText('Another message while listening');
  expect(await audio.getAttribute('src')).toBe(src);await expect.poll(()=>audio.evaluate(el=>el.currentTime)).toBeGreaterThan(before);
  await page.getByRole('button',{name:'Record voice',exact:true}).click();await expect(page.getByRole('button',{name:'Stop recording',exact:true})).toBeVisible();await page.locator('#room-tab-health').click();
  expect(await page.evaluate(()=>window.testMicStream.getAudioTracks().every(t=>t.readyState==='ended'))).toBe(true);
  await page.locator('#room-tab-chat').click();await expect(page.getByRole('button',{name:'Send voice',exact:true})).toBeHidden();
  await page.screenshot({path:info.outputPath('voice-and-replies.png'),fullPage:true});
 } finally {await other.close();}
});
test('denied microphone permission leaves text chat usable',async({page})=>{
 await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError')};});await create(page);await page.locator('#room-tab-chat').click();await page.getByRole('button',{name:'Record voice',exact:true}).click();
 await expect(page.locator('.toast-stack')).toContainText('Microphone access was denied');await page.getByLabel('Message the room').fill('Text still works');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('#chat-feed')).toContainText('Text still works');
});
test('all public sections and room tabs reflow at phone portrait, landscape and tablet sizes',async({page})=>{
 test.setTimeout(90_000); // Forty themed page views plus room navigation across four viewports.
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of [320,390,844,1024]){
  await page.setViewportSize({width,height:width===844?390:844});
  for(const route of ['/','/about.html','/contact.html','/privacy.html','/terms.html']) {
   await page.goto(route);for(const mode of ['light','dark']){
    await page.locator('#theme-picker').selectOption(mode);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${route}/${width}/${mode}`).toBe(true);
   }
  }
 }
 await create(page);
 for(const viewport of [{width:320,height:720},{width:390,height:844},{width:844,height:390},{width:1440,height:1000}]){
  await page.setViewportSize(viewport);
  for(const tab of ['listen','chat','people','health']){
   await page.locator(`#room-tab-${tab}`).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${tab}/${viewport.width}`).toBe(true);
   if(viewport.width<=600&&viewport.height>=500){
    const bottom=await page.locator('#room-tabs').evaluate(e=>e.getBoundingClientRect().bottom);
    expect(Math.abs(bottom-viewport.height),'Phone navigation stays at the viewport bottom').toBeLessThanOrEqual(1);
   }
  }
  await expect(page.locator('#mini-player')).toBeVisible();
  await page.locator('#mini-player').click();
  await expect(page.locator('#room-view')).toHaveAttribute('data-room-tab','listen');
  await expect(page.locator('#mini-player')).toBeHidden();
 }
 expect(errors).toEqual([]);
});
