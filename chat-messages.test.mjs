import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

async function startServer() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, NODE_ENV:'development', DATABASE_URL:'', CANONICAL_PUBLIC_HOST:'', ALLOWED_ORIGINS:'', HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { server, port };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error('RoomSound server did not start');
}

function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  const waiters = [];
  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    socket,
    send: (payload) => socket.send(JSON.stringify(payload)),
    open: () => new Promise((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    // Only messages after `since` count, so repeated events are not matched twice.
    next: (predicate, since = messages.length) => {
      const existing = messages.slice(since).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('message timeout')), 5_000) };
        waiters.push(waiter);
      });
    },
    get count() { return messages.length; },
  };
}

async function roomWithTwoMembers(t) {
  const { server, port } = await startServer();
  const host = client(port);
  const guest = client(port);
  t.after(() => { host.socket.close(); guest.socket.close(); server.kill(); });
  await host.open();
  host.send({ type: 'create-room', name: 'Reactions', displayName: 'Host', guestId: 'react-host' });
  const joined = await host.next((m) => m.type === 'joined', 0);
  await guest.open();
  guest.send({ type: 'join-room', code: joined.state?.room?.code ?? joined.room?.code, displayName: 'Guest', guestId: 'react-guest' });
  const guestJoined = await guest.next((m) => m.type === 'joined', 0);
  return { host, guest, guestId: guestJoined.state?.self?.id ?? guestJoined.self?.id };
}

test('chat replies and bounded voice notes cross clients, reject forged content and deduplicate retries', async()=>{
 const {server,port}=await startServer(); const host=client(port), guest=client(port);
 try {
  await Promise.all([host.open(),guest.open()]);
  host.send({type:'create-room',name:'Voice checks',displayName:'Host',guestId:'voice-host'});
  const created=await host.next(m=>m.type==='joined',0);
  guest.send({type:'join-room',code:created.state.room.code,displayName:'Guest',guestId:'voice-guest'});
  await guest.next(m=>m.type==='joined',0);
  host.send({type:'chat',text:'Original'});
  const original=await guest.next(m=>m.type==='chat'&&m.message.text==='Original',0);
  guest.send({type:'chat',text:'A reply',replyToId:original.message.id,replyTo:{senderName:'Forged'}});
  const reply=await host.next(m=>m.type==='chat'&&m.message.text==='A reply',0);
  assert.equal(reply.message.replyTo.senderName,'Host');assert.equal(reply.message.replyTo.text,'Original');
  const voice={mimeType:'audio/mp4',durationMs:1000,data:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(160_000)]).toString('base64')};
  guest.send({type:'chat',voice,clientMessageId:'voice-retry'});
  const recorded=await host.next(m=>m.type==='chat'&&m.message.voice,0);
  assert.equal(recorded.message.voice.data,voice.data);
  guest.send({type:'chat',voice,clientMessageId:'voice-retry'});
  const acknowledged=await guest.next(m=>m.type==='chat'&&m.message.id===recorded.message.id,0);
  assert.equal(acknowledged.message.clientMessageId,'voice-retry');
  host.send({type:'start-source',sourceType:'DEVICE_AUDIO'});
  const compact=await guest.next(m=>m.type==='state'&&m.state.messages.some(item=>item.id===recorded.message.id&&item.voice?.referenceOnly),0);
  assert.equal(compact.state.messages.find(item=>item.id===recorded.message.id).voice.data,undefined);
  host.send({type:'chat',voice:{...voice,mimeType:'text/html'}});
  const invalid=await host.next(m=>m.type==='error',0);assert.match(invalid.message,/voice|record|format/i);
 } finally {host.socket.terminate();guest.socket.terminate();server.kill();}
});
