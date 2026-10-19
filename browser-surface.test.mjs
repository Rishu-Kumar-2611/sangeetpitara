import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('.', import.meta.url);

test('browser surface is anonymous and exposes the local rewarded-access gate', async () => {
  const [html, app, ads, relay] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('ads.mjs', root), 'utf8'),
    readFile(new URL('media-relay.mjs', root), 'utf8'),
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
  assert.match(app, /Firefox.*does not provide system audio/s);
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

test('browser RTC keeps transiently disconnected peers for ICE recovery', async () => {
  const app = await readFile(new URL('app.js', root), 'utf8');

  assert.match(app, /if \(pc\.connectionState === 'closed'\) removePeerConnection\(/g);
  assert.doesNotMatch(app, /\['closed', 'disconnected'\]\.includes\(pc\.connectionState\)\) removePeerConnection/);
  assert.match(app, /disconnected.*recoverable|transient `disconnected` state is not terminal/s);
});
