import { test, expect } from '@playwright/test';
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { X509Certificate, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createDesktopCompanion } from '../desktop/nearby-desktop.mjs';
import { decodePcm16Frame } from '../media-relay.mjs';

test('companion pairs locally, shares captured audio after approval and stops on revocation',async({page})=>{
  const cert=await readFile(new URL('../desktop/test-fixtures/test-only-cert.pem',import.meta.url)),key=await readFile(new URL('../desktop/test-fixtures/test-only-key.pem',import.meta.url));
  const pin=createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),invite='12345678-1234-1234-1234-123456789abc';
  const certificateServer=http.createServer((req,res)=>res.end(cert)),secureServer=https.createServer({key,cert}),wss=new WebSocketServer({server:secureServer});
  await new Promise(r=>certificateServer.listen(0,'127.0.0.1',r));await new Promise(r=>secureServer.listen(0,'127.0.0.1',r));
  const companion=await createDesktopCompanion({port:0,allowLoopbackTargets:true});
  let socket,frames=0,nonSilent=false,lastSequence=null,sawSequenceGap=false;
  const state={room:{id:'local-room',hostId:'host',activeSourceId:'host',sourceEpoch:1,sourceStatus:'LIVE'},self:{id:'guest'},members:[{id:'host',name:'Host',online:true},{id:'guest',name:'Laptop',online:true}],requests:[]};
  const update=()=>socket.send(JSON.stringify({type:'state',state}));
  wss.on('connection',ws=>{socket=ws;ws.on('message',(raw,binary)=>{
    if(binary){const frame=decodePcm16Frame(raw);expect(frame.sourceEpoch).toBe(3);if(lastSequence!==null && ((frame.sequence-lastSequence)>>>0)>1)sawSequenceGap=true;lastSequence=frame.sequence;frames++;nonSilent ||= frame.samples.some(n=>n!==0);return}
    const m=JSON.parse(raw.toString());
    if(m.type==='join-room')ws.send(JSON.stringify({type:'joined',reconnectSecret:invite,state}));
    if(m.type==='request-control'){state.requests=[{id:'request',requesterId:'guest',requesterName:'Laptop',status:'PENDING'}];update()}
    if(m.type==='start-source'){expect(state.room.activeSourceId).toBe('guest');state.room.sourceStatus='LIVE';state.room.sourceEpoch=3;update()}
    if(m.type==='stop-source'){state.room.activeSourceId=null;state.room.sourceStatus='NONE';state.room.sourceEpoch++;update()}
  })});
  const external=[];await page.route('**/*',route=>{if(route.request().url().startsWith(companion.origin))return route.continue();external.push(route.request().url());return route.abort()});
  await page.addInitScript(()=>{
    // Simulated picker; actual WebAudio capture/PCM and local pinned TLS are used.
    Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async options=>{
      window.__displayOptions=options;window.__displayCalls=(window.__displayCalls||0)+1;
      if(window.__noAudio)return new MediaStream();
      const context=new AudioContext({sampleRate:48000});await context.resume();const oscillator=context.createOscillator(),gain=context.createGain(),destination=context.createMediaStreamDestination();
      gain.gain.value=.2;oscillator.connect(gain);gain.connect(destination);oscillator.start();window.__testContext=context;window.__testStream=destination.stream;
      if(window.__delayPicker)return new Promise(resolve=>{window.__resolvePicker=()=>resolve(destination.stream)});
      return destination.stream;
    }});
  });
  try{
    await page.goto(companion.origin);
    await page.getByLabel("Host's local invite",{exact:true}).fill(`http://127.0.0.1:${certificateServer.address().port}/#invite=${invite}&code=ABC234&tls=${secureServer.address().port}&pin=${pin}`);
    await page.getByRole('button',{name:'Connect to host',exact:true}).click();await expect(page.locator('#pair-status')).toContainText('Host paired');
    await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('midnight');
    await page.getByLabel('Your name',{exact:true}).fill('Laptop');await page.getByRole('button',{name:'Join and listen'}).click();
    await expect(page.locator('#request')).toBeVisible();await expect(page.locator('#share-screen')).toBeHidden();
    expect(await page.evaluate(()=>window.__displayCalls||0)).toBe(0);
    await page.locator('#request').click();await expect(page.locator('#cancel-request')).toBeVisible();
    state.room.activeSourceId='guest';state.room.sourceStatus='STARTING';state.room.sourceEpoch=2;state.requests=[];update();
    await expect(page.locator('#share-screen')).toBeVisible();await page.locator('#share-screen').click();await expect.poll(()=>frames).toBeGreaterThan(5);await expect.poll(()=>nonSilent).toBe(true);
    await page.evaluate(()=>Object.defineProperty(ws,'bufferedAmount',{configurable:true,get:()=>400000}));
    await expect.poll(()=>page.evaluate(()=>localSocketDrops)).toBeGreaterThan(2);
    await page.evaluate(()=>delete ws.bufferedAmount);
    await expect.poll(()=>sawSequenceGap).toBe(true);
    expect(await page.evaluate(()=>window.__displayOptions.systemAudio)).toBe('include');expect(await page.evaluate(()=>window.__displayOptions.video.displaySurface)).toBe('monitor');
    state.room.activeSourceId='host';state.room.sourceStatus='STARTING';state.room.sourceEpoch=4;update();
    await expect.poll(()=>page.evaluate(()=>publishNode===null&&window.__testStream.getTracks().every(t=>t.readyState==='ended'))).toBe(true);
    await page.evaluate(()=>{window.__testContext.close();window.__delayPicker=true});
    state.room.activeSourceId='guest';state.room.sourceEpoch=5;update();await expect(page.locator('#share-screen')).toBeVisible();await page.locator('#share-screen').click();
    await expect.poll(()=>page.evaluate(()=>typeof window.__resolvePicker)).toBe('function');
    state.room.activeSourceId='host';state.room.sourceEpoch=6;update();await expect(page.locator('#share-screen')).toBeHidden();await page.evaluate(()=>window.__resolvePicker());
    await expect.poll(()=>page.evaluate(()=>window.__testStream.getTracks().every(t=>t.readyState==='ended'))).toBe(true);
    await page.evaluate(()=>{window.__testContext.close();window.__delayPicker=false;window.__noAudio=true});
    state.room.activeSourceId='guest';state.room.sourceEpoch=7;update();await expect(page.locator('#share-screen')).toBeVisible();await page.locator('#share-screen').click();
    await expect(page.locator('#status')).toContainText('No audio was selected');expect(external).toEqual([]);
  }finally{await page.close();await companion.close();for(const client of wss.clients)client.terminate();await new Promise(r=>wss.close(r));certificateServer.closeAllConnections();secureServer.closeAllConnections();await Promise.all([new Promise(r=>certificateServer.close(r)),new Promise(r=>secureServer.close(r))]);}
});
