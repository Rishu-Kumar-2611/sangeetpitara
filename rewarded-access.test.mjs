import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REWARDED_ACCESS_CONFIG,
  REWARDED_ACCESS_STORAGE_KEY,
  grantRewardedAccess,
  hasRewardedAccess,
  normalizeRewardedAccessConfig,
  readRewardedAccessExpiry,
  runRewardedAccess,
} from './ads.mjs';

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('rewarded-access config identifies the offline demo provider and six-hour grant', () => {
  assert.equal(DEFAULT_REWARDED_ACCESS_CONFIG.provider, 'demo-local');
  assert.equal(DEFAULT_REWARDED_ACCESS_CONFIG.mode, 'offline');
  assert.equal(DEFAULT_REWARDED_ACCESS_CONFIG.rewardDurationSeconds, 30);
  assert.equal(DEFAULT_REWARDED_ACCESS_CONFIG.accessDurationHours, 6);
  assert.equal(DEFAULT_REWARDED_ACCESS_CONFIG.accessDurationMs, 6 * 60 * 60 * 1000);
  assert.deepEqual(normalizeRewardedAccessConfig({ provider: 'DEMO-LOCAL', mode: 'OFFLINE' }), DEFAULT_REWARDED_ACCESS_CONFIG);
});

test('reward completion stores a local six-hour expiry and expires at the boundary', () => {
  const store = storage();
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  const expiresAt = grantRewardedAccess({ storage: store, now });

  assert.equal(expiresAt, now + 6 * 60 * 60 * 1000);
  assert.equal(store.getItem(REWARDED_ACCESS_STORAGE_KEY), String(expiresAt));
  assert.equal(readRewardedAccessExpiry(store), expiresAt);
  assert.equal(hasRewardedAccess({ storage: store, now: expiresAt - 1 }), true);
  assert.equal(hasRewardedAccess({ storage: store, now: expiresAt }), false);
  assert.equal(hasRewardedAccess({ storage: store, now: expiresAt + 1 }), false);
});

test('the demo-local provider completes after exactly the configured duration without loading a network', async () => {
  let intervalCallback;
  let cleared = false;
  const ticks = [];
  const timerApi = {
    setInterval(callback) {
      intervalCallback = callback;
      return 'demo-timer';
    },
    clearInterval(timer) {
      assert.equal(timer, 'demo-timer');
      cleared = true;
    },
  };

  const completion = runRewardedAccess(DEFAULT_REWARDED_ACCESS_CONFIG, {
    timerApi,
    onTick: (remaining) => ticks.push(remaining),
  });
  await Promise.resolve();
  assert.equal(typeof intervalCallback, 'function');
  assert.equal(ticks[0], 30);
  for (let remaining = 0; remaining < 30; remaining += 1) intervalCallback();

  assert.deepEqual(await completion, { completed: true, provider: 'demo-local', mode: 'offline' });
  assert.equal(cleared, true);
  assert.equal(ticks.at(-1), 0);
});
