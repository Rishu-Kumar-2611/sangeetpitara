import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionConfig, productionConfigErrors } from './config.mjs';

const safeProductionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://roomsound:secret@example.test/roomsound',
  ALLOWED_ORIGINS: 'https://sangeet-pitaraa.onrender.com',
  METRICS_BEARER_TOKEN: 'x'.repeat(40),
  SESSION_COOKIE_SECURE: '1',
  TRUST_PROXY: '1',
};

test('production configuration accepts the complete secure deployment contract', () => {
  assert.deepEqual(productionConfigErrors(safeProductionEnv, { appVersion: '1.1.2' }), []);
  assert.doesNotThrow(() => assertProductionConfig(safeProductionEnv, { appVersion: '1.1.2' }));
});

test('production configuration fails closed for missing persistence, origin, metrics, and proxy controls', () => {
  const errors = productionConfigErrors({ NODE_ENV: 'production' }, { appVersion: 'invalid' });
  assert.equal(errors.length, 6);
  assert.match(errors.join('\n'), /DATABASE_URL/);
  assert.match(errors.join('\n'), /ALLOWED_ORIGINS/);
  assert.match(errors.join('\n'), /METRICS_BEARER_TOKEN/);
  assert.match(errors.join('\n'), /SESSION_COOKIE_SECURE/);
  assert.match(errors.join('\n'), /TRUST_PROXY/);
  assert.match(errors.join('\n'), /APP_VERSION/);
  assert.throws(() => assertProductionConfig({ NODE_ENV: 'production' }, { appVersion: 'invalid' }), /Production configuration is unsafe/);
});

test('local and explicit test environments remain usable without production secrets', () => {
  assert.deepEqual(productionConfigErrors({ NODE_ENV: 'development' }), []);
  assert.deepEqual(productionConfigErrors({ NODE_ENV: 'production', ROOMSOUND_TEST_MODE: '1' }), []);
});
