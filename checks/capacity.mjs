// Always starts its own loopback-only, in-memory service. Never accepts a URL
// or uses .env/production data. Measures relay delivery, not speaker playback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { encodePcm16Frame } from '../media-relay.mjs';

const soak=process.argv.includes('--soak');
const levels=soak?[100]:process.argv.includes('--quick')?[10,25]:[10,25,50,100,200];
const duration=soak?600000:process.argv.includes('--quick')?3000:10000;
const results=[];
async function run(count) {
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin=`http://127.0.0.1:${port}`,token=randomUUID()+randomUUID();
  const server=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,
    NODE_ENV:'development',DATABASE_URL:'',DATABASE_URL_UNPOOLED:'',HOST:'127.0.0.1',PORT:String(port),
    CANONICAL_PUBLIC_HOST:'',TRUST_PROXY:'1',TRUST_PROXY_HOPS:'1',ALLOWED_ORIGINS:origin,
    METRICS_BEARER_TOKEN:token,ROOMSOUND_TEST_MODE:'0'},stdio:'ignore'});
  const clients=[],rooms=[],delays=[];let delayCount=0;let timer,metricsTimer,phase='setup',unexpectedCloses=0,maxRss=0,maxLoop=0,baselineGaps=0,recoveryGaps=0;
  const metrics=async()=>{
    const response=await fetch(origin+'/metrics',{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(response.status,200);const text=await response.text();
    const get=name=>Number(text.match(new RegExp(`^roomsound_${name} (.+)$`,'m'))?.[1]||0);
    maxRss=Math.max(maxRss,get('process_resident_memory_bytes'));maxLoop=Math.max(maxLoop,get('event_loop_delay_ms'));
    return {cpu:get('process_cpu_seconds')};
  };
  function connect(index,room,identity={guestId:randomUUID(),reconnectSecret:randomUUID()}) {
    const socket=new WebSocket(origin.replace('http','ws'),{headers:{Origin:origin,'X-Forwarded-For':`198.18.${Math.floor(index/250)}.${index%250+1}`}});
    const messages=[],waiters=[];const client={socket,index,room,identity,frames:0,last:null,intentional:false};
    clients.push(client);
    socket.on('error',()=>{});
    socket.on('close',()=>{if(!client.intentional && phase!=='cleanup')unexpectedCloses++;});
    socket.on('message',(data,binary)=>{
      if(binary){const sequence=data.readUInt32LE(14);client.frames++;
        if(client.last!==null){const gap=(sequence-client.last)>>>0;if(gap>1&&gap<0x80000000){if(phase==='baseline')baselineGaps+=gap-1;else recoveryGaps+=gap-1;}}
        client.last=sequence;const at=client.room?.sent.get(sequence);if(at!==undefined){const elapsed=performance.now()-at;delayCount++;if(delays.length<100000)delays.push(elapsed);else{const slot=Math.floor(Math.random()*delayCount);if(slot<100000)delays[slot]=elapsed;}}return;}
      const message=JSON.parse(data);if(message.type==='error')client.failure=message.message;
      if(messages.length>60)messages.shift();messages.push(message);
      for(const waiter of [...waiters])if(waiter.predicate(message)){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(message);}
    });
    client.wait=predicate=>new Promise((resolve,reject)=>{const found=messages.find(predicate);if(found)return resolve(found);const waiter={predicate,resolve,timer:setTimeout(()=>reject(new Error('Room control timeout')),10000)};waiters.push(waiter);});
    client.open=new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    client.send=data=>socket.send(JSON.stringify(data));return client;
  }
  try {
    let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(origin+'/ready')).ok;}catch{}if(ready)break;await delay(100);}
    assert.ok(ready,'Isolated load server not ready');
    for(let index=0;index<count;index++){
      const offset=index%10;
      if(offset===0){
        const host=connect(index,null);await host.open;
        host.send({type:'create-room',name:'Isolated capacity test',displayName:'Synthetic host',...host.identity});
        const joined=await host.wait(m=>m.type==='joined');
        const room={host,code:joined.state.room.code,sequence:0,sent:new Map()};rooms.push(room);host.room=room;
        host.send({type:'start-source',sourceType:'TEST_TONE',sourceLabel:'Synthetic test signal'});
        const live=await host.wait(m=>m.type==='state'&&m.state.room.sourceStatus==='LIVE');room.epoch=live.state.room.sourceEpoch;
      } else {
        const room=rooms.at(-1),listener=connect(index,room);await listener.open;
        listener.send({type:'join-room',code:room.code,displayName:'Synthetic listener',...listener.identity});await listener.wait(m=>m.type==='joined');
      }
    }
    const start=performance.now(),before=await metrics();phase='baseline';
    const pcm=new Int16Array(960).fill(1000);
    timer=setInterval(()=>{const due=Math.floor((performance.now()-start)/20);for(const room of rooms){while(room.sequence<due){const sequence=room.sequence++;room.sent.set(sequence,performance.now());if(room.sent.size>512)room.sent.delete(sequence-512);room.host.socket.send(encodePcm16Frame({sourceEpoch:room.epoch,sequence,samples:pcm}));}}},10);
    let collecting=false;metricsTimer=setInterval(()=>{if(!collecting){collecting=true;metrics().catch(()=>{}).finally(()=>{collecting=false;});}},1000);
    await delay(duration);
    const minimumFrames=Math.min(...clients.filter(c=>c!==c.room.host).map(c=>c.frames));
    console.log(JSON.stringify({stage:'baseline',connections:count,minimumFrames,produced:rooms.map(r=>r.sequence),errors:clients.map(c=>c.failure).filter(Boolean)}));
    assert.ok(minimumFrames>=duration/20*.8,'At least one listener stopped receiving');
    assert.equal(baselineGaps,0,'Sequence gaps on baseline loopback relay');
    phase='reconnect';const reconnectStart=performance.now();
    const victims=clients.filter(c=>c!==c.room.host && c.index%4===1);
    await Promise.all(victims.map(async old=>{old.intentional=true;old.socket.terminate();
      const next=connect(old.index,old.room,old.identity);await next.open;
      next.send({type:'join-room',code:old.room.code,displayName:'Synthetic reconnected listener',...old.identity});await next.wait(m=>m.type==='joined');
    }));
    const reconnectMs=performance.now()-reconnectStart;await delay(1000);
    assert.ok(clients.filter(c=>!c.intentional&&c!==c.room.host).every(c=>c.frames>0),'A rejoined listener did not receive audio');
    assert.equal(unexpectedCloses,0,'Unexpected socket closures');
    assert.ok(clients.every(c=>!c.failure),'Server reported a room/media error');
    const after=await metrics(),elapsed=performance.now()-start;delays.sort((a,b)=>a-b);
    return {connections:count,rooms:rooms.length,durationMs:duration,minListenerPackets:minimumFrames,
      baselineMissingPackets:baselineGaps,unexpectedCloses,reconnectedListeners:victims.length,reconnectMs:Math.round(reconnectMs),
      loopbackRelayP95Ms:Math.round(delays[Math.floor(delays.length*.95)]||0),maxEventLoopDelayMs:Math.round(maxLoop),
      maxRssMB:Math.round(maxRss/1024/1024),averageOneCoreCpuPercent:Math.round((after.cpu-before.cpu)*100000/elapsed)};
  } finally {
    phase='cleanup';clearInterval(timer);clearInterval(metricsTimer);for(const c of clients){c.intentional=true;c.socket.terminate();}
    server.kill();await Promise.race([new Promise(r=>server.once('exit',r)),delay(3000)]);
  }
}
for(const count of levels){const result=await run(count);results.push(result);console.log(JSON.stringify(result));}
await writeFile(new URL(soak?'../ops/soak-results.json':'../ops/capacity-results.json',import.meta.url),JSON.stringify({
  recordedAt:new Date().toISOString(),scope:'Bounded latency sample reservoir; isolated loopback synthetic PCM relay; no speaker, browser playout, WAN, production host or acoustic measurements.',results},null,2));
console.log('CAPACITY PASS');
