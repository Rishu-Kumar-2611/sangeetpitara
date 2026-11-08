import {test,expect} from '@playwright/test';

test('busy laptop thread retains captured music and delivers a burst without sequence gaps',async({page,browser})=>{
 test.setTimeout(60_000);
 await page.addInitScript(()=>{navigator.mediaDevices.getDisplayMedia=async()=>{
  const context=new AudioContext(),osc=context.createOscillator(),destination=context.createMediaStreamDestination();
  osc.connect(destination);osc.start();return destination.stream;
 };});
 await page.goto('/');await page.locator('[data-open-screen="create"]').click();
 await page.getByLabel('Your display name').fill('Continuity host');await page.getByLabel('Room name',{exact:true}).fill('Capture stall check');await page.locator('#create-room').click();
 await expect(page.locator('#room-view')).toBeVisible();
 const code=(await page.locator('#room-code-display').textContent()).trim();
 const context=await browser.newContext({viewport:{width:390,height:844}});
 try {
  const guest=await context.newPage();await guest.goto('/');await guest.locator('[data-open-screen="join"]').click();await guest.getByLabel('Your display name').fill('Continuity listener');await guest.getByLabel('Room code',{exact:true}).fill(code);await guest.locator('#join-room').click();
  await page.locator('#share-audio').click();await guest.locator('#room-tab-health').click();
  const packets=()=>guest.locator('.health-metric').filter({hasText:'Audio packets'}).locator('strong').textContent().then(s=>Number(s.replaceAll(',','')));
  await expect.poll(packets).toBeGreaterThan(20);
  const before=await packets();
  // Capture runs on the audio thread while UI work blocks the laptop main thread.
  await page.evaluate(()=>{const until=performance.now()+6500;while(performance.now()<until){};});
  await expect.poll(packets,{timeout:10000}).toBeGreaterThan(before+280);
  await expect(guest.locator('.health-metric').filter({hasText:'Missing packets / 60 s'}).locator('strong')).toHaveText('0');
  await expect(guest.locator('.health-metric').filter({hasText:'Playback skipped / 60 s'}).locator('strong')).toHaveText('0 ms');
 }finally{await context.close();}
});
