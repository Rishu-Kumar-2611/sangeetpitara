// Read-only verification of the public website and both shipped APK URLs.
// Usage: node checks/release.mjs https://your-service.example [--wait]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../', import.meta.url);
const origin = new URL(process.argv[2]);
assert.ok(['https:', 'http:'].includes(origin.protocol));
assert.ok(!origin.username && !origin.password, 'Use a public origin without credentials.');
assert.equal(origin.pathname, '/', 'Pass the site origin, not an asset path.');
const controller = new AbortController();
const budget = setTimeout(() => controller.abort(), 260_000);
const normalize = (text) => text.replace(/\r\n/g, '\n');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assetVersion = '20261024-prod';

async function get(path) {
  const url = new URL(path, origin);
  url.searchParams.set('release-check', assetVersion);
  const response = await fetch(url, { signal: controller.signal, cache: 'no-store', redirect: 'error' });
  assert.equal(response.status, 200, `${path}: expected HTTP 200, got ${response.status}`);
  return response;
}

try {
  const expectedHtml = normalize(await readFile(new URL('index.html', root), 'utf8'));
  const deadline = Date.now() + (process.argv.includes('--wait') ? 120_000 : 0);
  let liveHtml;
  do {
    liveHtml = normalize(await (await get('/')).text());
    if (liveHtml === expectedHtml || Date.now() >= deadline) break;
    console.log('Waiting for the new release landing page...');
    await delay(10_000, undefined, { signal: controller.signal });
  } while (true);
  assert.equal(sha256(liveHtml), sha256(expectedHtml), 'The live landing page is not this release.');
  console.log('PASS release landing page and versioned download link');

  for (const path of ['/health', '/ready']) {
    const status = await (await get(path)).json();
    assert.equal(status.ok, true, `${path} is not healthy`);
    console.log(`PASS ${path}`);
  }
  // Never print the complete config: explicitly enabled TURN can contain credentials.
  const config = await (await get('/config')).json();
  assert.equal(config.mediaRelay?.enabled, true, 'PCM16 relay must be enabled.');
  console.log('PASS PCM16 relay enabled');

  for (const file of [
    'privacy.html', 'terms.html', 'styles.css', 'app.js', 'guest-id.js',
    'capture-tracks.js', 'media-relay.mjs', 'relay-pcm.js',
    'relay-capture-worklet.js', 'ads.mjs', 'notifications-sw.js',
    'branding/sangeetpitara/05-diya-eighth-note.svg',
  ]) {
    const expected = normalize(await readFile(new URL(file, root), 'utf8'));
    const response = await get(`/${file}?v=${assetVersion}`);
    const actual = normalize(await response.text());
    assert.equal(sha256(actual), sha256(expected), `${file} does not match this release`);
    if (/\.(m?js)$/.test(file)) assert.match(response.headers.get('content-type') || '', /javascript/);
    console.log(`PASS ${file}`);
  }

  // APKs are published to GitHub Releases; the site only redirects to them.
  for (const file of ['SangeetPitara.apk', 'SangeetPitara-1.0.1-debug.apk', 'SangeetPitara-debug.apk']) {
    const url = new URL(`/downloads/${file}`, origin);
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store', redirect: 'manual' });
    assert.equal(response.status, 302, `/downloads/${file}: expected a redirect, got ${response.status}`);
    const location = response.headers.get('location') || '';
    assert.match(location, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/SangeetPitara\.apk$/);
    console.log(`PASS /downloads/${file} -> ${location}`);
  }
  console.log('RELEASE PASS: website assets match the local release and APK links redirect to GitHub Releases.');
} finally {
  clearTimeout(budget);
}
