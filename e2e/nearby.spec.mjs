import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { decodePcm16Frame, encodePcm16Frame } from '../media-relay.mjs';

test('Nearby Vibe page listens and chats using only a local host', async ({ page }) => {
  const html=await readFile(new URL('../android/app/src/main/assets/nearby/index.html',import.meta.url));
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:; connect-src 'self' ws://${req.headers.host}; base-uri 'none'; frame-ancestors 'none'`);res.end(html)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const wss=new WebSocketServer({server});
  const invite='12345678-1234-1234-1234-123456789abc';
  let interval;
  const external=[];
  await page.route('**/*',route=>{if(route.request().url().startsWith(base))return route.continue();external.push(route.request().url());return route.abort()});
  wss.on('connection',ws=>{
    let sequence=0;
    ws.on('message',raw=>{const m=JSON.parse(raw.toString());
      if(m.type==='join-room'){
        expect(m.code).toBe('ABC123');
        ws.send(JSON.stringify({type:'joined',reconnectSecret:invite,state:{room:{sourceEpoch:1,sourceStatus:'LIVE'}}}));
        interval=setInterval(()=>{if(ws.readyState===1)ws.send(encodePcm16Frame({sourceEpoch:1,sequence:sequence++,samples:new Int16Array(960).fill(1000)}))},20);
      }
      if(m.type==='chat')ws.send(JSON.stringify({type:'chat',message:{senderName:'Friend',text:m.text}}));
    });
  });
  try {
    await page.goto(`${base}/#invite=${invite}&code=ABC123`);
    await page.getByLabel('Your name',{exact:true}).fill('Offline listener');
    await page.getByRole('button',{name:'Join and listen'}).click();
    await expect(page.getByRole('status')).toContainText('Listening over local Wi-Fi');
    expect(await page.evaluate(()=>ctx.state)).toBe('running');
    expect(await page.evaluate(()=>playing)).toBe(true);
    const downloading=page.waitForEvent('download');await page.locator('#export-diagnostics').click();const downloaded=await downloading;
    const input=await downloaded.createReadStream();let diagnosticText='';for await(const chunk of input)diagnosticText+=chunk.toString();
    const diagnostic=JSON.parse(diagnosticText);expect(diagnostic.platform).toBe('nearby-web');
    for(const secretText of [invite,'ABC123','Offline listener',base])expect(diagnosticText).not.toContain(secretText);

    await page.getByLabel('Message',{exact:true}).fill('Offline chat works');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect(page.locator('#chat')).toContainText('Offline chat works');
    await page.getByRole('button',{name:'Leave room',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('You left');
    expect(await page.evaluate(()=>joining)).toBe(false);
    expect(external).toEqual([]);
  } finally {clearInterval(interval);for(const client of wss.clients)client.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
});

test('offline guest requests control, publishes a chosen file and stops when revoked', async ({ page }) => {
  const html=await readFile(new URL('../android/app/src/main/assets/nearby/index.html',import.meta.url));
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:; connect-src 'self' ws://${req.headers.host}; base-uri 'none'; frame-ancestors 'none'`);res.end(html)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,wss=new WebSocketServer({server});
  let socket,frames=0,nonSilent=false;
  const state={room:{hostId:'host',activeSourceId:'host',sourceEpoch:1,sourceStatus:'LIVE'},self:{id:'guest'},members:[{id:'host',name:'Host',online:true},{id:'guest',name:'Guest',online:true}],requests:[]};
  const update=()=>socket.send(JSON.stringify({type:'state',state}));
  const external=[];
  await page.route('**/*',route=>{if(route.request().url().startsWith(base))return route.continue();external.push(route.request().url());return route.abort()});
  wss.on('connection',ws=>{socket=ws;ws.on('message',(raw,binary)=>{
    if(binary){const frame=decodePcm16Frame(raw);expect(frame.sourceEpoch).toBe(3);frames++;nonSilent ||= frame.samples.some(n=>n!==0);return}
    const message=JSON.parse(raw.toString());
    if(message.type==='join-room')ws.send(JSON.stringify({type:'joined',reconnectSecret:'test-secret',state}));
    if(message.type==='request-control'){state.requests=[{id:'request',requesterId:'guest',requesterName:'Guest',status:'PENDING'}];update()}
    if(message.type==='cancel-request'){state.requests=[];update()}
    if(message.type==='start-source'){expect(state.room.activeSourceId).toBe('guest');state.room.sourceStatus='LIVE';state.room.sourceEpoch=3;update()}
  })});
  try {
    await page.goto(`${base}/#invite=test-invite&code=ABC123`);
    await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByRole('button',{name:'Join and listen'}).click();
    await expect(page.locator('#controls')).toBeVisible();await expect(page.locator('#share')).toBeHidden();
    await page.locator('#request').click();await expect(page.locator('#cancel-request')).toBeVisible();
    await page.locator('#cancel-request').click();await expect(page.locator('#request')).toBeVisible();
    await page.locator('#request').click();await expect(page.locator('#cancel-request')).toBeVisible();
    state.room.activeSourceId='guest';state.room.sourceStatus='STARTING';state.room.sourceEpoch=2;state.requests=[];update();
    await expect(page.locator('#share')).toBeVisible();expect(frames).toBe(0);
    const wave=Buffer.alloc(44+48000*2*3);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(48000,24);wave.writeUInt32LE(96000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);for(let i=0;i<48000*3;i++)wave.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*12000),44+i*2);
    await page.locator('#track').setInputFiles({name:'offline-tone.wav',mimeType:'audio/wav',buffer:wave});
    await page.locator('#share').click();await expect.poll(()=>frames).toBeGreaterThan(5);expect(nonSilent).toBe(true);
    state.room.activeSourceId='host';state.room.sourceStatus='STARTING';state.room.sourceEpoch=4;update();
    await expect.poll(()=>page.evaluate(()=>publishNode===null&&trackPlayer===null)).toBe(true);
    await expect(page.locator('#share')).toBeHidden();
    expect(external).toEqual([]);
  } finally {for(const client of wss.clients)client.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
});
