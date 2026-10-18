# Billing and entitlement seam

RoomSound includes a dependency-light, provider-neutral contract in
[`billing.mjs`](../billing.mjs). It can create Stripe Checkout and Customer
Portal sessions through the Stripe REST API, verify raw webhook signatures,
deduplicate provider events, and persist normalized entitlements without adding
a Stripe SDK to the media server.

## Disabled-by-default contract

`createBillingService()` is enabled only when all of the following are true:

```text
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=<injected at runtime>
STRIPE_WEBHOOK_SECRET=<injected at runtime>
```

`STRIPE_PRICE_ID` and the checkout/portal return URLs are required to activate
the corresponding actions. Missing secrets make `status().enabled` false, cause `verifyWebhook()` to return
`{ ok: false, code: "BILLING_DISABLED" }`, and make `canUse()` return false.
Paid access therefore fails closed while billing is not configured. The config
object exposes only booleans and missing-key names; it never returns secret
values.

The tracked production template is
[`ops/env.production.example`](../ops/env.production.example). Put real
values in a secret manager or platform dashboard.

## Signature boundary

The future HTTP adapter must read the raw request body, preserve it unchanged,
and call:

```js
const result = billing.verifyWebhook(rawBody, request.headers['stripe-signature']);
if (!result.ok) return respondWith400(result.code);
```

`verifyStripeWebhookSignature()` implements the Stripe `t=...,v1=...`
HMAC-SHA256 format, accepts multiple `v1` signatures for secret rotation, uses
constant-time comparison, and rejects timestamps outside the five-minute
default tolerance. A route should verify the signature before parsing JSON,
deduplicate the provider event ID, and acknowledge only after durable state is
written.

## Entitlement record

Adapters normalize provider records to this shape:

```js
{
  subjectId: 'account-id',
  provider: 'stripe',
  customerId: 'cus_...',
  subscriptionId: 'sub_...',
  priceId: 'price_...',
  plan: 'pro',
  status: 'active',
  currentPeriodEnd: '2026-02-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
}
```

`entitlementAllows(record, requiredPlan, { now })` grants access only for
`active` or `trialing` status, before `currentPeriodEnd` when one is present,
and when the plan rank meets the requested plan rank. `past_due`, `unpaid`,
`canceled`, `paused`, incomplete, expired, and unknown records do not grant
paid access. A cancellation scheduled at period end remains usable until the
period end because the provider status is still active.

The default plan ranks are `free < pro < business`; callers can pass a bounded
map for another product catalog. The canonical subject key is `subjectId`
(`userId` is accepted as an adapter convenience), so the eventual account
integration must bind it to the server-issued account ID rather than a guest
ID or a client-provided room member ID.

## HTTP endpoints

- `POST /api/billing/checkout` — authenticated; returns a Stripe Checkout URL.
  The optional JSON body can provide `successUrl` and `cancelUrl`.
- `POST /api/billing/portal` — authenticated; returns a Customer Portal URL
  when the account has a stored Stripe customer ID. The optional JSON body can
  provide `returnUrl`.
- `POST /api/billing/webhook` — Stripe raw-body webhook; verifies the
  `stripe-signature` header, deduplicates the event ID, and writes the
  entitlement record.
- `GET /api/billing/status` — authenticated; returns sanitized billing state
  and the current entitlement. It never returns provider secrets.

Paid capabilities must still call `entitlementAllows()` at the authorization
boundary. The current room limit remains the product's free baseline until a
specific paid room/seat policy is selected.
