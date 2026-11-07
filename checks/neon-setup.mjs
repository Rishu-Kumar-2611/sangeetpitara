import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Pool } from 'pg';
import { createRepositoryFromEnv } from '../persistence.mjs';
process.loadEnvFile('.env');
const branch = process.env.NEON_VERIFY_BRANCH;
assert.ok(/^(codex-setup-verify-|migration-rehearsal-)/.test(branch || ''), 'Set NEON_VERIFY_BRANCH to a disposable verification branch. Never test user creation on production.');
const connection = (pooled) => execFileSync('neon.cmd', ['connection-string',branch,...(pooled?['--pooled']:[])], {shell:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const direct = connection(false), pooled = connection(true);
assert.match(direct,/^postgres/); assert.match(pooled,/^postgres/);
const repo = await createRepositoryFromEnv({...process.env,DATABASE_URL:pooled,DATABASE_URL_UNPOOLED:direct});
await repo.healthCheck(); await repo.close(); console.log('PASS Neon isolated-branch schema migrations and SQL connectivity');
let child;
const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
const base=`http://127.0.0.1:${port}`;
async function start(url=pooled,unpooled=direct) {
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'development',ROOMSOUND_TEST_MODE:'0',DATABASE_URL:url,DATABASE_URL_UNPOOLED:unpooled,HOST:'127.0.0.1',PORT:String(port),CANONICAL_PUBLIC_HOST:'',ALLOWED_ORIGINS:base,SESSION_COOKIE_SECURE:'0',DATABASE_SSL:'0'},stdio:'ignore'});
 for(let n=0;n<100;n++){try{const r=await fetch(base+'/ready'); if(r.ok){assert.equal((await r.json()).checks.repository.kind,'postgres');return;}}catch{} await delay(200);}
 throw new Error('App readiness timeout');
}
async function stop(){const running=child;child=null;if(running&&running.exitCode===null&&running.signalCode===null){const end=new Promise(r=>running.once('exit',r));running.kill();await end;}}
const sockets=[];
try {
 await start(); console.log('PASS started app; /ready reports postgres');
 const email=`neon-check-${randomUUID()}@example.test`, password=randomUUID()+'Aa1!';
 const registered=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(registered.status,201);
 const cookie=registered.headers.get('set-cookie').split(';')[0];
 const logged=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(logged.status,200);console.log('PASS HTTP registration and login backed by Neon');
 function client(){const ws=new WebSocket(base.replace('http','ws'),{headers:{Cookie:cookie}});sockets.push(ws);return ws;}
 const ws=client();await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
 function wait(type){return new Promise((r,j)=>{const timer=setTimeout(()=>j(new Error('WebSocket timeout: '+type)),5000);function on(raw,binary){if(binary)return;const m=JSON.parse(raw);if(m.type===type){clearTimeout(timer);ws.off('message',on);r(m);}}ws.on('message',on);});}
 let pending=wait('joined');ws.send(JSON.stringify({type:'create-room',name:'Neon verification',displayName:'Verification',guestId:randomUUID()}));const joined=await pending;
 pending=wait('chat');ws.send(JSON.stringify({type:'chat',text:'Neon end-to-end verification'}));await pending;console.log('PASS authenticated WebSocket room creation and chat');
 const db=new Pool({connectionString:direct});try{assert.equal((await db.query('SELECT count(*)::int AS n FROM users WHERE email=$1',[email])).rows[0].n,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM rooms WHERE id=$1',[joined.state.room.id])).rows[0].n,1);}finally{await db.end();} console.log('PASS account and room persisted in actual Neon PostgreSQL');
 sockets.forEach(s=>s.terminate());await stop();await start();const me=await fetch(base+'/api/auth/me',{headers:{Cookie:cookie}});assert.equal(me.status,200);console.log('PASS session survives app restart');
 await stop();
 // Initialize only the versioned application schema on the selected production branch.
 if (process.argv.includes('--initialize-production')) {
   await start(process.env.DATABASE_URL,process.env.DATABASE_URL_UNPOOLED); console.log('PASS selected Neon production branch: app starts and PostgreSQL readiness passes');
 }
}finally{sockets.forEach(s=>s.terminate());await stop();}
