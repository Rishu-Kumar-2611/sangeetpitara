import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function startServer(extraEnv = {}) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), ...extraEnv };
  if (!('ANDROID_APK_URL' in extraEnv)) delete env.ANDROID_APK_URL;
  const server = spawn(process.execPath, ['server.mjs'], { env, stdio: 'ignore' });
  const http = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${http}/health`)).ok) return { server, http };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error('RoomSound server did not start');
}

const LATEST = 'https://github.com/Rishu-Kumar-2611/sangeetpitara/releases/latest/download/SangeetPitara.apk';

test('APK download links, including legacy 1.0.1 names, redirect to the latest GitHub Release', async (t) => {
  const running = await startServer();
  t.after(() => running.server.kill());
  for (const name of ['SangeetPitara.apk', 'SangeetPitara-debug.apk', 'SangeetPitara-1.0.1-debug.apk']) {
    const response = await fetch(`${running.http}/downloads/${name}`, { redirect: 'manual' });
    assert.equal(response.status, 302, name);
    assert.equal(response.headers.get('location'), LATEST, name);
    assert.equal(response.headers.get('cache-control'), 'no-cache', name);
  }
  // Nothing else under /downloads is served, and APKs are no longer a static type.
  assert.equal((await fetch(`${running.http}/downloads/notes.txt`, { redirect: 'manual' })).status, 404);
});

test('ANDROID_APK_URL overrides the redirect target only with an https URL', async (t) => {
  const custom = await startServer({ ANDROID_APK_URL: 'https://example.com/builds/SangeetPitara.apk' });
  const unsafe = await startServer({ ANDROID_APK_URL: 'javascript:alert(1)' });
  t.after(() => { custom.server.kill(); unsafe.server.kill(); });
  const fromCustom = await fetch(`${custom.http}/downloads/SangeetPitara.apk`, { redirect: 'manual' });
  assert.equal(fromCustom.headers.get('location'), 'https://example.com/builds/SangeetPitara.apk');
  const fromUnsafe = await fetch(`${unsafe.http}/downloads/SangeetPitara.apk`, { redirect: 'manual' });
  assert.equal(fromUnsafe.headers.get('location'), LATEST);
});
