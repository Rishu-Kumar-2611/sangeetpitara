import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseLocalInvite(raw, allowLoopback = false) {
  const url = new URL(raw);
  const octets = url.hostname.split('.').map(Number);
  const privateIp = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.pathname !== '/' ||
      !(privateIp || allowLoopback && url.hostname === '127.0.0.1')) throw Error('Use the complete private Wi-Fi/hotspot invite.');
  const params = new URLSearchParams(url.hash.slice(1));
  const invite = params.get('invite'), code = params.get('code'), pin = params.get('pin'), tls = Number(params.get('tls'));
  if (!/^[a-f0-9-]{36}$/.test(invite || '') || !/^[A-Z2-9]{6}$/.test(code || '') || !/^[a-f0-9]{64}$/.test(pin || '') ||
      !Number.isInteger(tls) || tls < 1024 || tls > 65535 || Number(url.port) < 1024) throw Error('Update the host app and copy a fresh invite.');
  return { host: url.hostname, port: Number(url.port), tls, invite, code, pin };
}

async function loadPinnedCertificate(pair) {
  // The certificate is public. Fetch no invitation or identity over HTTP;
  // authenticate its exact bytes using the fingerprint in the shared invite.
  const pem = await new Promise((resolvePromise, reject) => {
    const request = http.get({ hostname: pair.host, port: pair.port, path: '/nearby-certificate', agent: false, timeout: 7000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('Update the host app, start a fresh room and copy its invite.')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 8192) response.destroy(Error('Invalid host certificate.')); else chunks.push(chunk); });
      response.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(Error('Cannot reach the host. Join the same Wi-Fi/hotspot.'))); request.on('error', reject);
  });
  const cert = new X509Certificate(pem), now = Date.now();
  if (digest(cert.raw) !== pair.pin) throw Error('The host certificate does not match this invite. Copy a fresh invite from the trusted host.');
  if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) throw Error('The host certificate has expired or the device clock is incorrect.');
  return pem;
}

export async function createDesktopCompanion({ port = 8767, pagePath = new URL('../android/app/src/main/assets/nearby/index.html', import.meta.url), allowLoopbackTargets = false } = {}) {
  const template = await readFile(pagePath, 'utf8'), token = randomBytes(32).toString('hex');
  let pairing = null, pairingBusy = false;
  const bridges = new Set();
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const validHost = request => request.headers.host === `127.0.0.1:${server.address().port}` || request.headers.host === `localhost:${server.address().port}`;
  const validOrigin = request => [origin(), `http://localhost:${server.address().port}`].includes(request.headers.origin);
  const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    if (!validHost(req)) { reply(res,403,{error:'Local access only.'}); return; }
    let path; try { path = new URL(req.url,origin()).pathname; } catch { reply(res,400,{error:'Invalid request URL.'}); return; }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer',
        'Content-Security-Policy':`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:; connect-src 'self' ws://${req.headers.host}; base-uri 'none'; frame-ancestors 'none'` });
      const scope=pairing ? digest(Buffer.from(`${pairing.host}:${pairing.tls}:${pairing.pin}:${pairing.invite}`)) : null;
      res.end(template.replace('<script>',`<script>window.NEARBY_DESKTOP=${JSON.stringify({ token, paired: !!pairing, scope })};</script><script>`)); return;
    }
    if (req.method === 'POST' && path === '/pair') {
      if (!validOrigin(req) || req.headers['x-nearby-token'] !== token || req.headers['content-type'] !== 'application/json') { reply(res,403,{error:'Open the local companion page to pair.'}); return; }
      if (pairingBusy || bridges.size) { reply(res,409,{error:'Leave the current room before pairing again.'}); return; }
      pairingBusy = true;
      try {
        const chunks=[]; let size=0;
        for await (const chunk of req) { size+=chunk.length; if(size>4096) throw Error('The invite is too long.'); chunks.push(chunk); }
        const next=parseLocalInvite(JSON.parse(Buffer.concat(chunks).toString()).invite,allowLoopbackTargets);
        const certificate=await loadPinnedCertificate(next); pairing={...next,certificate};
        reply(res,200,{invite:next.invite,code:next.code});
      } catch(error) { reply(res,400,{error:error.message?.startsWith('The host certificate') ? error.message : 'Could not pair. Join the same hotspot, update the host app and paste its fresh complete invite.'}); }
      finally { pairingBusy=false; }
      return;
    }
    reply(res,404,{error:'Not found.'});
  });
  server.requestTimeout=10_000; server.headersTimeout=10_000;
  const wss=new WebSocketServer({noServer:true,maxPayload:65_556,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    let url; try { url=new URL(req.url,origin()); } catch { socket.destroy(); return; }
    if(!validHost(req)||!validOrigin(req)||!pairing||url.pathname!=='/'||url.searchParams.get('invite')!==pairing.invite||bridges.size>=10){socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,client=>{
      const pair=pairing; bridges.add(client); let ready=false,closed=false;const pending=[];
      const remote=new WebSocket(`wss://${pair.host}:${pair.tls}/?invite=${pair.invite}`,{
        ca:pair.certificate,rejectUnauthorized:true,followRedirects:false,handshakeTimeout:10_000,perMessageDeflate:false,maxPayload:65_556,
        checkServerIdentity:(host,cert)=>host===pair.host&&digest(cert.raw)===pair.pin ? undefined : Error('The paired host certificate changed.'),
      });
      const close=()=>{if(closed)return;closed=true;bridges.delete(client);client.close();remote.close();};
      const forward=(destination,bytes,binary)=>{
        if(destination.readyState!==WebSocket.OPEN)return;
        if(destination.bufferedAmount>(binary?393_216:65_536)){if(!binary)close();return;}
        destination.send(bytes,{binary});
      };
      remote.on('open',()=>{ready=true;for(const item of pending)forward(remote,...item);pending.length=0;});
      client.on('message',(bytes,binary)=>{if(ready)forward(remote,bytes,binary);else if(!binary&&pending.length<8&&bytes.length<=8192)pending.push([bytes,binary]);else close();});
      remote.on('message',(bytes,binary)=>forward(client,bytes,binary));
      remote.on('error',close);client.on('error',close);remote.on('close',close);client.on('close',close);
    });
  });
  await new Promise((resolvePromise,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolvePromise);});
  return { origin:origin(), async close(){ for(const client of bridges)client.terminate(); await new Promise(r=>wss.close(r)); server.closeAllConnections(); await new Promise(r=>server.close(r)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const companion=await createDesktopCompanion();
  console.log(`Play Close desktop companion: ${companion.origin}\nKeep this window open. All room audio stays on your local Wi-Fi/hotspot.`);
  if(process.argv.includes('--open')) {
    const command=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';
    spawn(command,[companion.origin],{detached:true,stdio:'ignore'}).on('error',()=>{}).unref();
  }
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>companion.close().then(()=>process.exit(0)));
}
