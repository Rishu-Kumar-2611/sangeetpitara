// Exercise release packaging and room control on an isolated server, not an
// existing development process. No .env, database, or production rooms are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const probe = net.createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: '',
  CANONICAL_PUBLIC_HOST: '', MEDIA_RELAY_ENABLED: '1', TURN_ENABLED: '0',
  TURN_URLS: '', TURN_USERNAME: '', TURN_CREDENTIAL: '', ALLOWED_ORIGINS: origin,
};
const server = spawn(process.execPath, ['server.mjs'], { cwd, env, stdio: 'ignore' });

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extraEnv }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${args[0]} exited with ${code}`)));
  });
}

try {
  const deadline = Date.now() + 8_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try { ready = (await fetch(`${origin}/health`)).ok; } catch {}
    if (!ready) await delay(100);
  }
  assert.ok(ready, 'Isolated release server did not become healthy.');
  await run(['checks/release.mjs', origin]);
  await run(['smoke.mjs'], { ROOMSOUND_SMOKE_WS_URL: `ws://127.0.0.1:${port}` });
} finally {
  server.kill();
}
