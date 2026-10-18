import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;
const PLAN_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PROVIDER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

const ENTITLEMENT_STATUSES = Object.freeze([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
  'expired',
  'inactive',
]);
const ENTITLEMENT_STATUS_SET = new Set(ENTITLEMENT_STATUSES);
const BILLABLE_STATUS_SET = new Set(['active', 'trialing']);

/**
 * The backend billing seam deliberately exposes configuration state only.
 * Secret values never leave this module, which makes it safe to use from
 * health checks, startup logs, and deployment diagnostics.
 */
export function billingConfigFromEnv(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const provider = clean(source.BILLING_PROVIDER).toLowerCase() || 'stripe';
  const secretKeyConfigured = Boolean(clean(source.STRIPE_SECRET_KEY));
  const webhookSecretConfigured = Boolean(clean(source.STRIPE_WEBHOOK_SECRET));
  const missing = [];

  if (provider !== 'stripe') missing.push('BILLING_PROVIDER=stripe');
  if (!secretKeyConfigured) missing.push('STRIPE_SECRET_KEY');
  if (!webhookSecretConfigured) missing.push('STRIPE_WEBHOOK_SECRET');

  return Object.freeze({
    provider,
    enabled: missing.length === 0,
    secretKeyConfigured,
    webhookSecretConfigured,
    priceId: clean(source.STRIPE_PRICE_ID) || null,
    successUrl: clean(source.STRIPE_CHECKOUT_SUCCESS_URL) || null,
    cancelUrl: clean(source.STRIPE_CHECKOUT_CANCEL_URL) || null,
    portalReturnUrl: clean(source.STRIPE_PORTAL_RETURN_URL) || null,
    missing: Object.freeze(missing),
  });
}

export const entitlementStatuses = ENTITLEMENT_STATUSES;
export const defaultPlanRanks = Object.freeze({ free: 0, pro: 100, business: 200 });

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveMillis(value, name = 'now') {
  const candidate = typeof value === 'function' ? value() : value;
  const millis = candidate instanceof Date ? candidate.getTime() : Number(candidate);
  if (!Number.isFinite(millis)) throw new TypeError(`${name} must be a valid Date or timestamp.`);
  return millis;
}

function normalizePeriodEnd(value, name) {
  if (value === undefined || value === null || value === '') return null;

  let millis;
  if (value instanceof Date) {
    millis = value.getTime();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    // Stripe timestamps are Unix seconds; accepting milliseconds keeps the
    // contract convenient for application-owned records and tests.
    millis = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    millis = Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  } else {
    millis = new Date(value).getTime();
  }

  if (!Number.isFinite(millis)) throw new TypeError(`${name} must be a valid timestamp.`);
  return new Date(millis).toISOString();
}

function normalizePlanName(value, field = 'plan') {
  const plan = clean(value).toLowerCase() || 'free';
  if (!PLAN_NAME.test(plan)) throw new TypeError(`${field} must be a short plan name.`);
  return plan;
}

/**
 * Normalize the provider-neutral record consumed by entitlement checks.
 * Stripe webhook adapters can map their subscription fields to this shape
 * without bringing the Stripe SDK into the RoomSound runtime.
 */
export function normalizeEntitlement(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Entitlement must be an object.');
  }

  const subjectId = clean(input.subjectId ?? input.userId);
  if (!subjectId || subjectId.length > 128) throw new TypeError('Entitlement subjectId is required.');

  const provider = clean(input.provider).toLowerCase() || 'stripe';
  if (!PROVIDER_NAME.test(provider)) throw new TypeError('Entitlement provider is invalid.');

  const status = clean(input.status).toLowerCase() || 'inactive';
  if (!ENTITLEMENT_STATUS_SET.has(status)) throw new TypeError(`Unknown entitlement status: ${status}`);

  return Object.freeze({
    subjectId,
    provider,
    customerId: clean(input.customerId ?? input.customer_id) || null,
    subscriptionId: clean(input.subscriptionId ?? input.subscription_id) || null,
    priceId: clean(input.priceId ?? input.price_id) || null,
    plan: normalizePlanName(input.plan),
    status,
    currentPeriodEnd: normalizePeriodEnd(input.currentPeriodEnd ?? input.current_period_end, 'currentPeriodEnd'),
    cancelAtPeriodEnd: Boolean(input.cancelAtPeriodEnd ?? input.cancel_at_period_end),
    updatedAt: normalizePeriodEnd(input.updatedAt ?? input.updated_at, 'updatedAt'),
  });
}

function normalizePlanRanks(planRanks) {
  if (!planRanks || typeof planRanks !== 'object' || Array.isArray(planRanks)) {
    throw new TypeError('planRanks must be an object.');
  }
  const normalized = {};
  for (const [name, rank] of Object.entries(planRanks)) {
    const plan = normalizePlanName(name, 'planRanks key');
    if (!Number.isFinite(rank)) throw new TypeError(`Plan rank for ${plan} must be finite.`);
    normalized[plan] = rank;
  }
  return normalized;
}

/**
 * Return true only when the subscription is currently entitled to the
 * requested plan. Past-due, canceled, unpaid, and expired states fail closed.
 */
export function entitlementAllows(input, requiredPlan = 'free', { now = Date.now(), planRanks = defaultPlanRanks } = {}) {
  const entitlement = normalizeEntitlement(input);
  const requested = normalizePlanName(requiredPlan, 'requiredPlan');
  const ranks = normalizePlanRanks(planRanks);
  const currentRank = ranks[entitlement.plan];
  const requiredRank = ranks[requested];

  if (currentRank === undefined || requiredRank === undefined) return false;
  if (!BILLABLE_STATUS_SET.has(entitlement.status)) return false;

  const periodEnd = entitlement.currentPeriodEnd ? Date.parse(entitlement.currentPeriodEnd) : null;
  if (periodEnd !== null && resolveMillis(now) >= periodEnd) return false;
  return currentRank >= requiredRank;
}

export const hasEntitlement = entitlementAllows;

function parseSignatureHeader(signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.trim()) return null;
  let timestamp = null;
  const signatures = [];

  for (const part of signatureHeader.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && timestamp === null) timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }

  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function hexSignature(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return Buffer.from(value, 'hex');
}

/**
 * Verify Stripe's signed-payload format without the Stripe SDK. The raw body
 * must be passed unchanged by an eventual HTTP webhook adapter.
 */
export function verifyStripeWebhookSignature(
  payload,
  signatureHeader,
  secret,
  { now = Date.now(), toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS } = {},
) {
  const webhookSecret = clean(secret);
  if (!webhookSecret) return false;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new TypeError('toleranceSeconds must be a non-negative finite number.');
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const currentSeconds = Math.floor(resolveMillis(now) / 1_000);
  if (Math.abs(currentSeconds - parsed.timestamp) > toleranceSeconds) return false;

  const rawPayload = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload instanceof Uint8Array ? payload : String(payload ?? ''), 'utf8');
  const signedPayload = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.`, 'utf8'),
    rawPayload,
  ]);
  const expected = createHmac('sha256', webhookSecret).update(signedPayload).digest();

  return parsed.signatures.some((candidate) => {
    const provided = hexSignature(candidate);
    return Boolean(provided && provided.length === expected.length && timingSafeEqual(provided, expected));
  });
}

/**
 * Small runtime facade for future checkout/webhook routes. It is deliberately
 * disabled unless both backend Stripe secrets are present, and all disabled
 * paths fail closed instead of granting paid access.
 */
export function createBillingService({ env = process.env, clock = () => Date.now() } = {}) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  const config = billingConfigFromEnv(env);
  const fetchImpl = typeof env.fetch === 'function' ? env.fetch : globalThis.fetch;

  async function stripeRequest(path, params) {
    if (!config.enabled || !config.priceId || !env.STRIPE_SECRET_KEY) {
      return { ok: false, code: 'BILLING_DISABLED' };
    }
    if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for billing requests.');
    const response = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, code: 'BILLING_PROVIDER_ERROR', status: response.status, error: payload?.error?.message || 'Stripe request failed.' };
    return { ok: true, payload };
  }

  return Object.freeze({
    ...config,
    status() {
      return {
        provider: config.provider,
        enabled: config.enabled,
        missing: [...config.missing],
      };
    },
    verifyWebhook(payload, signatureHeader, options = {}) {
      if (!config.enabled) return { ok: false, code: 'BILLING_DISABLED' };
      const valid = verifyStripeWebhookSignature(payload, signatureHeader, env.STRIPE_WEBHOOK_SECRET, {
        ...options,
        now: options.now ?? clock(),
      });
      return valid ? { ok: true, code: 'VERIFIED' } : { ok: false, code: 'INVALID_SIGNATURE' };
    },
    canUse(entitlement, requiredPlan = 'free', options = {}) {
      if (!config.enabled) return false;
      return entitlementAllows(entitlement, requiredPlan, { ...options, now: options.now ?? clock() });
    },
    async createCheckoutSession({ userId, email, successUrl = config.successUrl, cancelUrl = config.cancelUrl } = {}) {
      if (!userId || !email || !successUrl || !cancelUrl) return { ok: false, code: 'CHECKOUT_CONFIGURATION_REQUIRED' };
      return stripeRequest('checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': config.priceId,
        'line_items[0][quantity]': '1',
        customer_email: email,
        client_reference_id: userId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        'subscription_data[metadata][userId]': userId,
        'subscription_data[metadata][plan]': 'pro',
      });
    },
    async createPortalSession({ customerId, returnUrl = config.portalReturnUrl } = {}) {
      if (!customerId || !returnUrl) return { ok: false, code: 'PORTAL_CONFIGURATION_REQUIRED' };
      return stripeRequest('billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    },
    normalizeEntitlement,
  });
}
