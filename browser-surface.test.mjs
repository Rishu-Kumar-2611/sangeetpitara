import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('.', import.meta.url);

test('browser surface keeps account controls and ad slots opt-in', async () => {
  const [html, app, ads] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('ads.mjs', root), 'utf8'),
  ]);

  for (const id of ['account-form', 'account-login', 'account-register', 'account-logout']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /getCurrentUser/);
  assert.match(app, /requestAuth/);
  assert.match(app, /requestLogout/);
  assert.match(html, /meta name="roomsound-ad-enabled" content="false"/);
  assert.match(html, /meta name="roomsound-ad-consent" content="false"/);
  assert.match(html, /id="ad-consent-banner"[^>]+hidden/);
  assert.match(html, /data-ad-slot=""[^>]+hidden/);
  assert.match(ads, /providerAdapters/);
  assert.match(ads, /setAdConsent/);
  assert.match(ads, /adsense/);
  assert.match(ads, /no third-party ad script by default/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
  assert.doesNotMatch(`${html}\n${app}\n${ads}`, /ca-pub-\d+/i);
});
