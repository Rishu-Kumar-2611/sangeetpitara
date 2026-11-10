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

async function startToneRoom(page, browser) {
  await page.goto('/');
  await page.locator('[data-open-screen="create"]').click();
  await page.getByLabel('Your display name').fill('Audio host');
  await page.getByLabel('Room name', { exact: true }).fill('Continuity check');
  await page.locator('#create-room').click();
  await expect(page.locator('#room-view')).toBeVisible();
  const code = (await page.locator('#room-code-display').textContent()).trim();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      const createAnalyser = AudioContext.prototype.createAnalyser;
      AudioContext.prototype.createAnalyser = function () {
        const analyser = createAnalyser.call(this);
        window.measureRoomAudio = () => {
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        };
        return analyser;
      };
      let received = 0;
      window.receivedRoomAudio = () => received;
      const WebSocketBase = window.WebSocket;
      window.WebSocket = class extends WebSocketBase {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => { if (typeof data !== 'string') received++; });
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(), tone = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        tone.frequency.value = 880;
        tone.connect(destination);
        tone.start();
        destination.stream.getTracks().forEach(track => {
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); void context.close(); };
        });
        return destination.stream;
      };
    });
    const listener = await context.newPage();
    await listener.goto(page.url().split('?')[0]);
    await listener.locator('[data-open-screen="join"]').click();
    await listener.getByLabel('Your display name').fill('Audio listener');
    await listener.getByLabel('Room code', { exact: true }).fill(code);
    await listener.locator('#join-room').click();
    await expect(listener.locator('#room-view')).toBeVisible();
    await page.locator('#share-audio').click();
    await listener.locator('#room-tab-chat').click();
    const enable = listener.locator('#enable-audio-participant');
    if (await enable.isVisible()) await enable.click();
    await expect.poll(() => listener.evaluate(() => window.receivedRoomAudio()), { timeout: 10000 }).toBeGreaterThan(20);
    await expect.poll(() => listener.evaluate(() => window.measureRoomAudio?.() || 0), { timeout: 10000 }).toBeGreaterThan(.02);
    return { context, listener };
  } catch (error) { await context.close(); throw error; }
}

async function installTonePublisher(page, delayReconnect = false) {
  await page.addInitScript((delayReconnect) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const context = new AudioContext(), osc = context.createOscillator();
      const dest = context.createMediaStreamDestination(), gain = context.createGain();
      gain.gain.value = .35;
      osc.connect(gain); gain.connect(dest); osc.start();
      return dest.stream;
    };
    if (!delayReconnect) return;
    const WebSocketBase = window.WebSocket;
    let sockets = 0;
    window.WebSocket = class extends WebSocketBase {
      constructor(...args) { super(...args); this.number = ++sockets; window.testRoomSocket = this; }
      send(data) {
        if (this.number > 1 && typeof data === 'string' && JSON.parse(data).type === 'join-room') {
          setTimeout(() => { if (this.readyState === WebSocket.OPEN) super.send(data); }, 1350);
          return;
        }
        super.send(data);
      }
    };
  }, delayReconnect);
}

test('laptop retains packets through a 1.5 second reconnect and phone audio resumes without missing frames', async ({ page, browser }) => {
  test.setTimeout(45_000);
  await installTonePublisher(page, true);
  const { context, listener } = await startToneRoom(page, browser);
  try {
    const packetCount = () => listener.evaluate(() => window.receivedRoomAudio());
    const before = await packetCount();
    await page.evaluate(() => window.testRoomSocket.close(4000, 'Continuity regression'));
    await expect.poll(() => page.evaluate(() => window.testRoomSocket.number)).toBeGreaterThan(1);
    await expect.poll(packetCount, { timeout: 10000 }).toBeGreaterThan(before + 90);
    await expect.poll(() => listener.evaluate(() => window.measureRoomAudio?.() || 0)).toBeGreaterThan(.02);
    await listener.locator('#room-tab-health').click();
    await expect(listener.locator('.health-metric').filter({ hasText: 'Missing packets / 60 s' }).locator('strong')).toHaveText('0');
  } finally { await context.close(); }
});

test('phone voice recording stops received room packets and output, sends the voice note, then resumes', async ({ page, browser }) => {
  test.setTimeout(45_000);
  await installTonePublisher(page);
  const { context, listener } = await startToneRoom(page, browser);
  try {
    const packetCount = () => listener.evaluate(() => window.receivedRoomAudio());
    await listener.getByRole('button', { name: 'Record voice', exact: true }).click();
    await expect(listener.locator('.chat-voice-preview')).toContainText('room audio paused');
    await expect.poll(() => listener.evaluate(() => window.measureRoomAudio?.() ?? 1)).toBeLessThan(.001);
    const pausedPackets = await packetCount();
    await expect(listener.locator('.chat-voice-preview')).toContainText('Recording 2 / 30 sec', { timeout: 6000 });
    expect(await packetCount()).toBe(pausedPackets);
    await listener.getByRole('button', { name: 'Stop and send voice', exact: true }).click();
    await expect.poll(packetCount).toBeGreaterThan(pausedPackets + 20);
    await expect.poll(() => listener.evaluate(() => window.measureRoomAudio?.() || 0)).toBeGreaterThan(.02);
    await page.locator('#room-tab-chat').click();
    const voice = page.locator('#chat-feed audio');
    await expect(voice).toHaveCount(1);
    await voice.evaluate(audio => audio.play());
    await expect.poll(() => voice.evaluate(audio => audio.currentTime)).toBeGreaterThan(0);
  } finally { await context.close(); }
});
