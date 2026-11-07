import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { X509Certificate, createHash } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createDesktopCompanion, parseLocalInvite } from './nearby-desktop.mjs';

const id='12345678-1234-1234-1234-123456789abc';
test('desktop pairing accepts only complete private invitations',()=>{
  const suffix=`/#invite=${id}&code=ABC234&tls=8766&pin=${'a'.repeat(64)}`;
  assert.equal(parseLocalInvite(`http://192.168.43.1:8765${suffix}`).host,'192.168.43.1');
  for(const input of [`http://8.8.8.8:8765${suffix}`,`http://localhost:8765${suffix}`,`http://127.0.0.1:8765${suffix}`,`http://user@192.168.43.1:8765${suffix}`,'http://192.168.43.1:8765/#invite=missing'])assert.throws(()=>parseLocalInvite(input));
});

test('loopback companion verifies the host pin and bridges exact local TLS messages',{timeout:20_000},async()=>{
  // Public test fixtures only; never used by the app or included in downloads.
  const cert=await readFile(new URL('test-fixtures/test-only-cert.pem',import.meta.url));
  const key=await readFile(new URL('test-fixtures/test-only-key.pem',import.meta.url));
  const pin=createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
  const certificateServer=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/x-pem-file'});res.end(cert)});
  const secureServer=https.createServer({cert,key});const wss=new WebSocketServer({server:secureServer});let remoteConnections=0;
  wss.on('connection',(socket,req)=>{remoteConnections++;assert.equal(new URL(req.url,'https://test').searchParams.get('invite'),id);socket.on('message',(bytes,binary)=>socket.send(bytes,{binary}));});
  await new Promise(r=>certificateServer.listen(0,'127.0.0.1',r));await new Promise(r=>secureServer.listen(0,'127.0.0.1',r));
  const companion=await createDesktopCompanion({port:0,allowLoopbackTargets:true});let client;
  const invite=`http://127.0.0.1:${certificateServer.address().port}/#invite=${id}&code=ABC234&tls=${secureServer.address().port}&pin=${pin}`;
  try{
    const html=await(await fetch(companion.origin)).text();const bootstrap=JSON.parse(html.match(/window\.NEARBY_DESKTOP=(\{[^;]+\});/)[1]);
    const headers={'Content-Type':'application/json','Origin':companion.origin,'X-Nearby-Token':bootstrap.token};
    assert.equal((await fetch(`${companion.origin}/pair`,{method:'POST',headers:{...headers,Origin:'https://attacker.example'},body:JSON.stringify({invite})})).status,403);
    assert.equal((await fetch(`${companion.origin}/pair`,{method:'POST',headers:{...headers,'X-Nearby-Token':'wrong'},body:JSON.stringify({invite})})).status,403);
    assert.equal((await fetch(`${companion.origin}/pair`,{method:'POST',headers,body:JSON.stringify({invite:invite.replace(pin,'0'.repeat(64))})})).status,400);
    assert.equal(remoteConnections,0,'No identity may be sent before certificate verification');
    assert.equal((await fetch(`${companion.origin}/pair`,{method:'POST',headers,body:JSON.stringify({invite})})).status,200);
    client=new WebSocket(`${companion.origin.replace('http:','ws:')}/?invite=${id}`,{origin:companion.origin});
    await once(client,'open');const text=once(client,'message');client.send('{"type":"join-room","code":"ABC234"}');
    const [reply,binary]=await text;assert.equal(binary,false);assert.equal(reply.toString(),'{"type":"join-room","code":"ABC234"}');
    const audio=Buffer.alloc(1940,37);const frame=once(client,'message');client.send(audio);const [bytes,isBinary]=await frame;assert.equal(isBinary,true);assert.deepEqual(bytes,audio);
    assert.equal((await fetch(`${companion.origin}/pair`,{method:'POST',headers,body:JSON.stringify({invite})})).status,409);
    assert.equal(remoteConnections,1);
  }finally{client?.terminate();await companion.close();for(const peer of wss.clients)peer.terminate();await new Promise(r=>wss.close(r));secureServer.closeAllConnections();certificateServer.closeAllConnections();await Promise.all([new Promise(r=>secureServer.close(r)),new Promise(r=>certificateServer.close(r))]);}
});
