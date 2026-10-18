import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  billingConfigFromEnv,
  createBillingService,
  entitlementAllows,
  normalizeEntitlement,
  verifyStripeWebhookSignature,
} from './billing.mjs';

const now = new Date('2026-01-01T00:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1_000);
const webhookSecret = 'billing-test-webhook-secret';
const apiSecret = 'billing-test-api-key';

function signatureFor(payload, timestamp = nowSeconds) {
  const signed = `${timestamp}.${payload}`;
  const digest = createHmac('sha256', webhookSecret).update(signed).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

test('billing is disabled and fails closed when backend secrets are absent', () => {
  const config = billingConfigFromEnv({ BILLING_PROVIDER: 'stripe' });
  assert.equal(config.enabled, false);
  assert.deepEqual(config.missing, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);

  const service = createBillingService({ env: { BILLING_PROVIDER: 'stripe' }, clock: () => now });
  assert.deepEqual(service.status(), {
    provider: 'stripe',
    enabled: false,
    missing: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  });
  assert.deepEqual(service.verifyWebhook('{}', 't=1,v1=bad'), { ok: false, code: 'BILLING_DISABLED' });
  assert.equal(service.canUse({ subjectId: 'user-1', plan: 'pro', status: 'active' }, 'pro'), false);
});

test('billing enables only the supported provider when both secrets are configured', () => {
  const config = billingConfigFromEnv({
    BILLING_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: apiSecret,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PRICE_ID: 'price_test',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.secretKeyConfigured, true);
  assert.equal(config.webhookSecretConfigured, true);
  assert.equal(config.priceId, 'price_test');
  assert.equal('secretKey' in config, false);
  assert.equal('webhookSecret' in config, false);

  const unsupported = billingConfigFromEnv({
    BILLING_PROVIDER: 'other',
    STRIPE_SECRET_KEY: apiSecret,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
  });
  assert.equal(unsupported.enabled, false);
  assert.deepEqual(unsupported.missing, ['BILLING_PROVIDER=stripe']);
});

test('Stripe signed payload verification accepts valid signatures and rejects tampering or stale signatures', () => {
  const payload = JSON.stringify({ id: 'evt_test', type: 'customer.subscription.updated' });
  const signature = signatureFor(payload);

  assert.equal(verifyStripeWebhookSignature(payload, signature, webhookSecret, { now }), true);
  assert.equal(verifyStripeWebhookSignature(Buffer.from(payload), signature, webhookSecret, { now }), true);
  assert.equal(verifyStripeWebhookSignature(`${payload}x`, signature, webhookSecret, { now }), false);
  assert.equal(verifyStripeWebhookSignature(payload, signature, 'wrong-secret', { now }), false);
  assert.equal(verifyStripeWebhookSignature(payload, signatureFor(payload, nowSeconds - 301), webhookSecret, { now }), false);
  assert.equal(verifyStripeWebhookSignature(payload, `t=${nowSeconds},v1=not-hex`, webhookSecret, { now }), false);
  assert.equal(verifyStripeWebhookSignature(payload, 't=not-a-number,v1=00', webhookSecret, { now }), false);
  assert.throws(() => verifyStripeWebhookSignature(payload, signature, webhookSecret, { now, toleranceSeconds: -1 }), /toleranceSeconds/);
});

test('entitlement rules grant active or trialing plans until the period ends', () => {
  const active = normalizeEntitlement({
    subjectId: 'user-1',
    provider: 'stripe',
    plan: 'pro',
    status: 'active',
    currentPeriodEnd: now.getTime() + 60_000,
  });
  assert.equal(active.currentPeriodEnd, '2026-01-01T00:01:00.000Z');
  assert.equal(entitlementAllows(active, 'pro', { now }), true);
  assert.equal(entitlementAllows(active, 'business', { now }), false);
  assert.equal(entitlementAllows(active, 'pro', { now: new Date('2026-01-01T00:02:00.000Z') }), false);

  assert.equal(entitlementAllows({ subjectId: 'user-2', plan: 'pro', status: 'trialing' }, 'pro', { now }), true);
  assert.equal(entitlementAllows({ subjectId: 'user-3', plan: 'pro', status: 'past_due' }, 'pro', { now }), false);
  assert.equal(entitlementAllows({ subjectId: 'user-4', plan: 'free', status: 'active' }, 'pro', { now }), false);
  assert.throws(() => normalizeEntitlement({ subjectId: 'user-5', plan: 'pro', status: 'unknown' }), /Unknown entitlement status/);
  assert.throws(() => normalizeEntitlement({ plan: 'pro', status: 'active' }), /subjectId/);
});

test('enabled billing service verifies signatures and delegates entitlement checks', () => {
  const payload = '{}';
  const service = createBillingService({
    env: {
      BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: apiSecret,
      STRIPE_WEBHOOK_SECRET: webhookSecret,
    },
    clock: () => now,
  });
  assert.deepEqual(service.verifyWebhook(payload, signatureFor(payload)), { ok: true, code: 'VERIFIED' });
  assert.deepEqual(service.verifyWebhook(payload, 't=1,v1=bad'), { ok: false, code: 'INVALID_SIGNATURE' });
  assert.equal(service.canUse({ subjectId: 'user-1', plan: 'pro', status: 'active' }, 'pro'), true);
});
