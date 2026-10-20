import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('.', import.meta.url);

test('web pages use the selected SangeetPitara logo and cache-busted branding assets', async () => {
  const logoPath = '/branding/sangeetpitara/05-diya-eighth-note.svg';
  const brandingVersion = '20261019-sangeetpitara-1';
  const pages = await Promise.all(['index.html', 'privacy.html', 'terms.html'].map(async (name) => ({
    name,
    html: await readFile(new URL(name, root), 'utf8'),
  })));
  const logo = await readFile(new URL(logoPath.slice(1), root), 'utf8');

  assert.match(logo, /viewBox="0 0 512 512"/);
  assert.match(logo, /Diya Eighth Note/);
  for (const { name, html } of pages) {
    assert.match(html, /<title>SangeetPitara[^<]*<\/title>/, name);
    assert.match(html, /<meta name="description" content="SangeetPitara[^"\n]+"\s*\/>/, name);
    assert.doesNotMatch(html, /RoomSound|brand-dot/, name);

    const favicon = html.match(/<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/);
    assert.equal(favicon?.[1], `${logoPath}?v=${brandingVersion}`, name);
    const stylesheet = html.match(/<link rel="stylesheet" href="([^"]+)"/);
    assert.equal(stylesheet?.[1], `/styles.css?v=${brandingVersion}`, name);
    const marks = [...html.matchAll(/<img class="brand-logo" src="([^"]+)" alt="SangeetPitara logo" width="40" height="40"/g)];
    assert.equal(marks.length, name === 'index.html' ? 2 : 1, name);
    for (const mark of marks) assert.equal(mark[1], `${logoPath}?v=${brandingVersion}`, name);
  }
});

test('browser-facing messages use SangeetPitara while retaining existing room integration names', async () => {
  const [app, ads, capture, html] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('ads.mjs', root), 'utf8'),
    readFile(new URL('capture-tracks.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8'),
  ]);

  assert.doesNotMatch(`${app}\n${ads}\n${capture}`, /RoomSound/);
  assert.match(app, /Join my SangeetPitara room with code/);
  assert.match(app, /roomsound-guest-id/);
  assert.match(app, /roomsound-notification-action/);
  assert.match(app, /roomsound-notification-ready/);
  assert.match(app, /roomsound-volume/);
  assert.match(ads, /roomsound-rewarded-access-expires-at/);
  assert.match(ads, /roomsound-ad-consent/);
  assert.match(app, /from '\.\/ads\.mjs\?v=20261019-sangeetpitara-1'/);
  assert.match(app, /from '\.\/capture-tracks\.js\?v=20261019-sangeetpitara-1'/);
  assert.match(html, /src="\/app\.js\?v=20261019-sangeetpitara-1"/);
});

test('browser surface is anonymous and exposes the local rewarded-access gate', async () => {
  const [html, app, ads, capture, relay, dockerfile] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('ads.mjs', root), 'utf8'),
    readFile(new URL('capture-tracks.js', root), 'utf8'),
    readFile(new URL('media-relay.mjs', root), 'utf8'),
    readFile(new URL('Dockerfile.runtime', root), 'utf8'),
  ]);

  for (const id of ['account-form', 'account-login', 'account-register', 'account-logout', 'room-session', 'room-logout']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="rewarded-access"/);
  assert.match(html, /id="complete-rewarded-access"/);
  assert.match(html, /30-second demo\/local rewarded preview/);
  assert.match(html, /Demo\/local provider · offline development only/);
  assert.match(html, /id="create-room"[^>]+disabled/);
  assert.match(html, /id="join-room"[^>]+disabled/);
  assert.match(html, /href="\/downloads\/SangeetPitara-debug\.apk"[^>]+download/);
  assert.match(dockerfile, /downloads\/SangeetPitara-debug\.apk/);
  assert.match(html, /id="create-tab"[^>]+role="tab"[^>]+aria-selected="true"/);
  assert.match(html, /id="join-tab"[^>]+role="tab"[^>]+aria-selected="false"/);
  assert.match(html, /id="create-panel"[^>]+role="tabpanel"/);
  assert.match(html, /id="join-panel"[^>]+role="tabpanel"/);
  assert.match(html, /id="room-actions-menu"[^>]+role="menu"/);
  for (const id of ['share-room', 'room-settings', 'leave-room', 'end-room']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="participant-controls"[^>]+aria-labelledby="request-controls-title"/);
  assert.match(html, /id="request-control-status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(`${html}\n${app}`, /Sign in|Create account|Sign out/);
  assert.doesNotMatch(app, /getCurrentUser|requestAuth|requestLogout|authRequired/);
  assert.match(app, /hasRewardedAccess/);
  assert.match(app, /runRewardedAccess/);
  assert.match(app, /grantRewardedAccess/);
  assert.match(html, /meta name="roomsound-ad-enabled" content="false"/);
  assert.match(html, /meta name="roomsound-ad-consent" content="false"/);
  assert.match(html, /meta name="roomsound-media-relay" content="server-configured-pcm16"/);
  assert.match(html, /id="ad-consent-banner"[^>]+hidden/);
  assert.match(html, /data-ad-slot=""[^>]+hidden/);
  assert.match(ads, /providerAdapters/);
  assert.match(ads, /setAdConsent/);
  assert.match(ads, /adsense/);
  assert.match(ads, /demo-local/);
  assert.match(ads, /rewardDurationSeconds: 30/);
  assert.match(ads, /accessDurationHours: 6/);
  assert.match(ads, /no third-party ad script by default/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
  assert.doesNotMatch(`${html}\n${app}\n${ads}`, /ca-pub-\d+/i);
  assert.match(app, /mediaRelay/);
  assert.match(app, /applyAdSenseConfig/);
  assert.match(ads, /ADSENSE|adsense/);
  assert.match(app, /decodePcm16Frame/);
  assert.match(app, /encodePcm16Frame/);
  assert.match(app, /createScriptProcessor/);
  assert.match(app, /RELAY_PROCESSOR_BUFFER_SAMPLES = 512/);
  assert.match(app, /RELAY_MAX_BUFFERED_BYTES/);
  assert.match(app, /RELAY_MAX_PLAYAHEAD_SECONDS/);
  assert.match(app, /muted sink/);
  assert.match(app, /event\.data instanceof Blob|handleRelayFrame\(event\.data\)/);
  assert.match(app, /displayAudioCaptureConstraints/);
  assert.match(app, /displayAudioCaptureGuidance/);
  assert.match(capture, /Firefox.*does not provide a live system-audio track/s);
  assert.doesNotMatch(app, /data-source=["']TEST_TONE["']/);
  assert.doesNotMatch(app, /Test Tone|Test audio|test audio/);
  assert.match(app, /sourceEpoch/);
  assert.match(app, /openRoomConfirmation/);
  assert.match(app, /type: 'leave-room'/);
  assert.match(app, /type: 'end-room'/);
  assert.match(app, /const isCurrentSocket = \(\) => state\.ws === socket/);
  assert.match(app, /if \(!isCurrentSocket\(\)\) return;/);
  assert.match(app, /state\.pendingIntent = null/);
  assert.match(app, /send\(\{ type: 'leave-room' \}\);\s*resetToLanding\(\)/s);
  assert.doesNotMatch(app, /window\.confirm\(/);
  assert.match(relay, /0x52, 0x53, 0x52, 0x31/);
  assert.match(relay, /MEDIA_RELAY_SAMPLE_RATE = 48_000/);
  assert.match(relay, /MEDIA_RELAY_CHANNELS = 1/);
  assert.match(relay, /sampleCount <= 0/);
  assert.match(relay, /payloadBytes !== sampleCount \* 2/);
});

test('browser audio sharing opens the native DEVICE_AUDIO picker without a source modal', async () => {
  const [app, capture] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('capture-tracks.js', root), 'utf8'),
  ]);

  assert.doesNotMatch(app, /openSourceModal/);
  assert.doesNotMatch(app, /source-options|source-option|data-source=/);
  assert.doesNotMatch(app, /<div class="source-modal"><div class="modal-eyebrow">AUDIO SOURCE/);
  assert.doesNotMatch(app, /Choose what to share/);
  assert.doesNotMatch(app, /TEST_TONE|Test Tone|Test audio|test audio/);

  assert.match(app, /startLocalCapture\('DEVICE_AUDIO', 'participant'\)/);
  assert.match(app, /startLocalCapture\('DEVICE_AUDIO', 'host'\)/);
  assert.match(app, /startLocalCapture\('DEVICE_AUDIO', 'takeover'\)/);
  assert.match(app, /Your request was approved\. Tap Share audio to open the browser picker\./);
  assert.match(app, /if \(!state\.captureStream\) \{\s*\/\/ getDisplayMedia must be launched from a user gesture\./s);
  assert.match(app, /navigator\.mediaDevices\.getDisplayMedia\(displayAudioCaptureConstraints\(\)\)/);
  assert.match(app, /if \(sourceType === 'DEVICE_AUDIO'\)/);
  assert.match(app, /if \(!window\.isSecureContext\)/);
  assert.match(app, /displayAudioCaptureGuidance\(navigator\.userAgent\)/);
  assert.doesNotMatch(capture, /Test Tone|Test audio|test audio/);
  assert.match(app, /Display capture was denied\. Allow access and tick Share audio, then try again\./);
});

test('browser RTC keeps transiently disconnected peers for ICE recovery', async () => {
  const app = await readFile(new URL('app.js', root), 'utf8');

  assert.match(app, /if \(pc\.connectionState === 'closed'\) removePeerConnection\(/g);
  assert.doesNotMatch(app, /\['closed', 'disconnected'\]\.includes\(pc\.connectionState\)\) removePeerConnection/);
  assert.match(app, /disconnected.*recoverable|transient `disconnected` state is not terminal/s);
});
