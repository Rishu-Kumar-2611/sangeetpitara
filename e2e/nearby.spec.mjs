import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { encodePcm16Frame } from '../media-relay.mjs';

test('Nearby Vibe page listens and chats using only a local host', async ({ page }) => {
  const html=await readFile(new URL('../android/app/src/main/assets/nearby/index.html',import.meta.url));
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws://${req.headers.host}; base-uri 'none'; frame-ancestors 'none'`);res.end(html)});
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
    await page.getByLabel('Message',{exact:true}).fill('Offline chat works');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect(page.locator('#chat')).toContainText('Offline chat works');
    await page.getByRole('button',{name:'Leave room',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('You left');
    expect(await page.evaluate(()=>joining)).toBe(false);
    expect(external).toEqual([]);
  } finally {clearInterval(interval);for(const client of wss.clients)client.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
});
