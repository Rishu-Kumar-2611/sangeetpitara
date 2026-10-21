import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('.', import.meta.url);
const assetVersion = '20261021-playback-4';

test('web pages use the selected SangeetPitara logo and cache-busted branding assets', async () => {
  const logoPath = '/branding/sangeetpitara/05-diya-eighth-note.svg';
  const brandingVersion = assetVersion;
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
  assert.ok(app.includes(`from './ads.mjs?v=${assetVersion}'`));
  assert.ok(app.includes(`from './capture-tracks.js?v=${assetVersion}'`));
  assert.ok(html.includes(`src="/app.js?v=${assetVersion}"`));
});

test('browser module graph uses one release cache version, including the capture worklet', async () => {
  const [app, worklet] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('relay-capture-worklet.js', root), 'utf8'),
  ]);
  const importPattern = /^import\s[\s\S]*?\sfrom ['"]([^'"]+)['"];/gm;
  const imports = [...app.matchAll(importPattern)].map((match) => match[1]);
  for (const name of ['guest-id.js', 'relay-pcm.js', 'capture-tracks.js', 'media-relay.mjs', 'ads.mjs']) {
    assert.ok(imports.includes(`./${name}?v=${assetVersion}`), name);
  }
  for (const source of [app, worklet]) {
    for (const [, url] of source.matchAll(importPattern)) {
      assert.equal(new URL(url, root).search, `?v=${assetVersion}`, url);
    }
  }
  assert.ok(app.includes(`audioWorklet.addModule('/relay-capture-worklet.js?v=${assetVersion}')`));
  assert.ok(worklet.includes(`from './relay-pcm.js?v=${assetVersion}'`));
});

test('release download is labeled 1.0.1 and runtime packages both public APK names and audio modules', async () => {
  const [html, dockerfile, gitignore, dockerignore, syntax] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('Dockerfile.runtime', root), 'utf8'),
    readFile(new URL('.gitignore', root), 'utf8'),
    readFile(new URL('.dockerignore', root), 'utf8'),
    readFile(new URL('checks/syntax.mjs', root), 'utf8'),
  ]);
  assert.match(html, /class="apk-download-card" href="\/downloads\/SangeetPitara-1\.0\.1-debug\.apk" download/);
  assert.match(html, /Download SangeetPitara 1\.0\.1 for playback sharing on Android/);
  const copies = dockerfile.split(/\r?\n/).filter((line) => /^COPY --chown=node:node /.test(line))
    .map((line) => line.trim().split(/\s+/).slice(2));
  for (const name of ['SangeetPitara-debug.apk', 'SangeetPitara-1.0.1-debug.apk']) {
    assert.ok(copies.some((args) => args.at(-1) === './downloads/' && args.slice(0, -1).includes(`downloads/${name}`)), name);
    assert.ok(dockerignore.split(/\r?\n/).includes(`!downloads/${name}`), name);
  }
  for (const name of ['capture-tracks.js', 'media-relay.mjs', 'relay-pcm.js', 'relay-capture-worklet.js']) {
    assert.ok(copies.some((args) => args.at(-1) === './' && args.slice(0, -1).includes(name)), name);
    assert.ok((await readFile(new URL(name, root), 'utf8')).length > 0, name);
  }
  const checkedFiles = syntax.match(/const files = \[([\s\S]*?)\];/)?.[1];
  assert.ok(checkedFiles, 'syntax-check file list is present');
  for (const [, name] of checkedFiles.matchAll(/'([^']+)'/g)) {
    const packaged = name.startsWith('checks/')
      ? copies.some((args) => args.includes('checks') && args.at(-1) === './checks')
      : copies.some((args) => args.at(-1) === './' && args.slice(0, -1).includes(name));
    assert.ok(packaged, `Docker must copy syntax-check input: ${name}`);
  }
  const ignoreRules = gitignore.split(/\r?\n/);
  assert.ok(ignoreRules.includes('*.apk'));
  assert.deepEqual(ignoreRules.filter((line) => /^!.*\.apk/.test(line)), [
    '!downloads/SangeetPitara-debug.apk',
    '!downloads/SangeetPitara-1.0.1-debug.apk',
  ]);
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
  assert.match(html, /href="\/downloads\/SangeetPitara-1\.0\.1-debug\.apk"[^>]+download/);
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
  assert.match(app, /RELAY_PROCESSOR_BUFFER_SAMPLES = 2048/);
  assert.match(app, /new AudioWorkletNode/);
  assert.match(app, /syncRelayCaptureLease/);
  assert.match(app, /RELAY_MAX_BUFFERED_BYTES/);
  assert.match(app, /RELAY_MAX_PLAYAHEAD_SECONDS/);
  assert.match(app, /state\.relayPlaybackNextTime > now \+ RELAY_MAX_PLAYAHEAD_SECONDS/);
  assert.match(app, /Math\.max\(now \+ 0\.01, state\.relayPlaybackNextTime \|\| 0\)/);
  assert.match(app, /state\.relayLastSequence = frame\.sequence/);
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

test('landing page presents the browser room as the primary path and clarifies the room code', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('styles.css', root), 'utf8'),
  ]);

  assert.match(html, /class="browser-first-panel"/);
  assert.match(html, /listen live, chat with the room, request audio, and approve or reject requests without downloading anything/);
  assert.match(html, /Prefer the Android app\?/);
  assert.match(html, /<small>Share this code with listeners<\/small>/);
  assert.match(css, /\.room-code-display strong \{[^}]*font-size: clamp\(28px, 3\.2vw, 38px\)/s);
  assert.match(css, /\.request-actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.request-actions button \{[^}]*min-height: 34px/s);
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
  assert.match(app, /Use the Android app to share phone audio/);
  assert.match(app, /openMobileAudioGuide/);
  assert.doesNotMatch(app, /Boolean\(myRequest \|\| selfIsSource \|\| sourceIsParticipant\)/);
  assert.match(app, /Request your turn to share audio/);
  assert.match(app, /if \(!state\.captureStream\) \{\s*\/\/ getDisplayMedia must be launched from a user gesture\./s);
  assert.match(app, /navigator\.mediaDevices\.getDisplayMedia\(displayAudioCaptureConstraints\(\)\)/);
  assert.match(app, /if \(sourceType === 'DEVICE_AUDIO'\)/);
  assert.match(app, /if \(!window\.isSecureContext\)/);
  assert.match(app, /displayAudioCaptureGuidance\(navigator\.userAgent\)/);
  assert.match(app, /mobileAudioCaptureGuidance/);
  assert.doesNotMatch(capture, /Test Tone|Test audio|test audio/);
  assert.match(app, /Display capture was denied\. Allow access and tick Share audio, then try again\./);
});

test('browser RTC keeps transiently disconnected peers for ICE recovery', async () => {
  const app = await readFile(new URL('app.js', root), 'utf8');

  assert.match(app, /if \(pc\.connectionState === 'closed'\) removePeerConnection\(/g);
  assert.doesNotMatch(app, /\['closed', 'disconnected'\]\.includes\(pc\.connectionState\)\) removePeerConnection/);
  assert.match(app, /disconnected.*recoverable|transient `disconnected` state is not terminal/s);
});
