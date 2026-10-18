/**
 * Provider-neutral advertising boundary.
 *
 * RoomSound ships no ad-network script and registers no provider by default.
 * A deployment may opt in by setting the three meta values in index.html (or
 * an equivalent same-origin build step), obtaining consent, and supplying a
 * slot key on an existing [data-ad-slot] element. A future provider adapter
 * can be registered without changing room controls or loading third-party
 * code from this client module.
 */

const providerAdapters = new Map();
const rewardedProviderAdapters = new Map();
const AD_CONSENT_STORAGE_KEY = 'roomsound-ad-consent';

export const REWARDED_ACCESS_STORAGE_KEY = 'roomsound-rewarded-access-expires-at';
export const DEFAULT_REWARDED_ACCESS_CONFIG = Object.freeze({
  enabled: true,
  provider: 'demo-local',
  mode: 'offline',
  rewardDurationSeconds: 30,
  accessDurationHours: 6,
  accessDurationMs: 6 * 60 * 60 * 1000,
});

function metaValue(documentRef, name) {
  return documentRef.querySelector(`meta[name="${name}"]`)?.content?.trim() || '';
}

function storedConsent(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(AD_CONSENT_STORAGE_KEY) === 'granted';
  } catch {
    return false;
  }
}

export function readAdConfig(documentRef = globalThis.document) {
  if (!documentRef?.querySelector) {
    return { enabled: false, consent: false, provider: '', client: '' };
  }
  const provider = metaValue(documentRef, 'roomsound-ad-provider');
  const client = metaValue(documentRef, 'roomsound-ad-client');
  const enabled = metaValue(documentRef, 'roomsound-ad-enabled').toLowerCase() === 'true';
  const consent = metaValue(documentRef, 'roomsound-ad-consent').toLowerCase() === 'granted' || storedConsent();
  return { enabled: Boolean(provider) && enabled && consent, consent, provider, client };
}

export function setAdConsent(granted, documentRef = globalThis.document, storage = globalThis.localStorage) {
  const value = granted ? 'granted' : 'denied';
  try { storage?.setItem(AD_CONSENT_STORAGE_KEY, value); } catch {}
  const meta = documentRef?.querySelector?.('meta[name="roomsound-ad-consent"]');
  if (meta) meta.content = value;
  return initializeAdSlots(documentRef);
}

export function registerAdProvider(name, mount) {
  const provider = String(name || '').trim().toLowerCase();
  if (!provider || typeof mount !== 'function') throw new TypeError('An ad provider name and mount function are required.');
  providerAdapters.set(provider, mount);
  return () => providerAdapters.delete(provider);
}

function positiveNumber(value, fallback, { integer = false, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) return fallback;
  const bounded = Math.min(max, number);
  return integer ? Math.round(bounded) : bounded;
}

export function normalizeRewardedAccessConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const rewardDurationSeconds = positiveNumber(
    source.rewardDurationSeconds ?? source.rewardedAdDurationSeconds ?? source.durationSeconds,
    DEFAULT_REWARDED_ACCESS_CONFIG.rewardDurationSeconds,
    { integer: true, min: 1, max: 10 * 60 },
  );
  const configuredHours = source.accessDurationHours
    ?? (Number.isFinite(Number(source.accessDurationMs)) ? Number(source.accessDurationMs) / (60 * 60 * 1000) : undefined);
  const accessDurationHours = positiveNumber(
    configuredHours,
    DEFAULT_REWARDED_ACCESS_CONFIG.accessDurationHours,
    { min: 1 / 60, max: 24 * 365 },
  );
  return {
    enabled: source.enabled !== false,
    provider: String(source.provider || DEFAULT_REWARDED_ACCESS_CONFIG.provider).trim().toLowerCase(),
    mode: String(source.mode || DEFAULT_REWARDED_ACCESS_CONFIG.mode).trim().toLowerCase(),
    rewardDurationSeconds,
    accessDurationHours,
    accessDurationMs: Math.round(accessDurationHours * 60 * 60 * 1000),
  };
}

export function readRewardedAccessExpiry(storage = globalThis.localStorage) {
  try {
    const expiry = Number(storage?.getItem(REWARDED_ACCESS_STORAGE_KEY));
    return Number.isFinite(expiry) && expiry > 0 ? expiry : null;
  } catch {
    return null;
  }
}

export function hasRewardedAccess({ storage = globalThis.localStorage, now = Date.now() } = {}) {
  const expiry = readRewardedAccessExpiry(storage);
  const nowMs = Number(now);
  return expiry !== null && Number.isFinite(nowMs) && expiry > nowMs;
}

export function grantRewardedAccess({
  storage = globalThis.localStorage,
  now = Date.now(),
  config = DEFAULT_REWARDED_ACCESS_CONFIG,
  durationMs,
} = {}) {
  const normalized = normalizeRewardedAccessConfig(config);
  const nowMs = Number(now);
  const accessMs = Number.isFinite(Number(durationMs)) ? Number(durationMs) : normalized.accessDurationMs;
  if (!Number.isFinite(nowMs) || !Number.isFinite(accessMs) || accessMs <= 0 || typeof storage?.setItem !== 'function') return null;
  const expiresAt = nowMs + accessMs;
  try {
    storage?.setItem(REWARDED_ACCESS_STORAGE_KEY, String(expiresAt));
    return expiresAt;
  } catch {
    return null;
  }
}

export function clearRewardedAccess(storage = globalThis.localStorage) {
  try { storage?.removeItem(REWARDED_ACCESS_STORAGE_KEY); } catch {}
}

export function formatRewardedAccessRemaining(expiresAt, now = Date.now()) {
  const remainingMs = Number(expiresAt) - Number(now);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'Access required';
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m remaining`;
  if (hours) return `${hours}h remaining`;
  return `${minutes}m remaining`;
}

export function registerRewardedProvider(name, start) {
  const provider = String(name || '').trim().toLowerCase();
  if (!provider || typeof start !== 'function') throw new TypeError('A rewarded provider name and start function are required.');
  rewardedProviderAdapters.set(provider, start);
  return () => rewardedProviderAdapters.delete(provider);
}

export function runRewardedAccess(config = DEFAULT_REWARDED_ACCESS_CONFIG, options = {}) {
  const normalized = normalizeRewardedAccessConfig(config);
  if (!normalized.enabled) return Promise.reject(new Error('Rewarded access is disabled.'));
  const provider = rewardedProviderAdapters.get(normalized.provider);
  if (!provider) return Promise.reject(new Error(`Rewarded provider "${normalized.provider}" is unavailable.`));
  return Promise.resolve().then(() => provider({
    config: normalized,
    onTick: options.onTick,
    documentRef: options.documentRef || globalThis.document,
    timerApi: options.timerApi || globalThis,
  }));
}

// This is deliberately a local/offline simulation. It does not load an ad
// network, make an impression claim, or represent a production monetization
// provider. A reviewed provider can be registered later without changing the
// room-entry or local-expiry contract.
registerRewardedProvider('demo-local', ({ config, onTick, timerApi }) => {
  const setIntervalImpl = typeof timerApi?.setInterval === 'function' ? timerApi.setInterval.bind(timerApi) : setInterval;
  const clearIntervalImpl = typeof timerApi?.clearInterval === 'function' ? timerApi.clearInterval.bind(timerApi) : clearInterval;
  let remaining = config.rewardDurationSeconds;
  onTick?.(remaining);
  return new Promise((resolve) => {
    const timer = setIntervalImpl(() => {
      remaining -= 1;
      onTick?.(Math.max(0, remaining));
      if (remaining > 0) return;
      clearIntervalImpl(timer);
      resolve({ completed: true, provider: 'demo-local', mode: 'offline' });
    }, 1000);
  });
});

function placeholderContent(documentRef, provider) {
  const label = documentRef.createElement('span');
  label.className = 'ad-slot-label';
  label.textContent = 'SPONSORED SPACE';
  const note = documentRef.createElement('span');
  note.className = 'ad-slot-note';
  note.textContent = `${provider} placement · RoomSound loads no third-party ad script by default.`;
  return [label, note];
}

function loadAdSenseScript(documentRef, client) {
  const existing = documentRef.querySelector('script[data-roomsound-adsense]');
  if (existing) return Promise.resolve();
  const script = documentRef.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.dataset.roomsoundAdsense = 'true';
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
  documentRef.head.appendChild(script);
  return new Promise((resolve, reject) => {
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', reject, { once: true });
  });
}

registerAdProvider('adsense', async ({ element, provider, slot, client, documentRef }) => {
  if (!client || !slot) return;
  const ad = documentRef.createElement('ins');
  ad.className = 'adsbygoogle';
  ad.style.display = 'block';
  ad.dataset.adClient = client;
  ad.dataset.adSlot = slot;
  ad.dataset.adFormat = 'auto';
  ad.dataset.fullWidthResponsive = 'true';
  element.replaceChildren(ad);
  await loadAdSenseScript(documentRef, client);
  const queue = globalThis.adsbygoogle || [];
  globalThis.adsbygoogle = queue;
  queue.push({});
  element.dataset.adProvider = provider;
});

export function initializeAdSlots(documentRef = globalThis.document) {
  const config = readAdConfig(documentRef);
  if (!documentRef?.querySelectorAll) return config;

  const consentBanner = documentRef.querySelector('#ad-consent-banner');
  if (consentBanner) {
    const shouldOffer = Boolean(config.provider) && metaValue(documentRef, 'roomsound-ad-enabled').toLowerCase() === 'true' && !config.consent;
    consentBanner.hidden = !shouldOffer;
    if (!consentBanner.dataset.wired) {
      consentBanner.dataset.wired = 'true';
      documentRef.querySelector('#ad-consent-allow')?.addEventListener('click', () => setAdConsent(true, documentRef));
      documentRef.querySelector('#ad-consent-deny')?.addEventListener('click', () => setAdConsent(false, documentRef));
    }
  }

  documentRef.querySelectorAll('[data-ad-slot]').forEach((slot) => {
    const slotKey = slot.dataset.adSlot?.trim() || '';
    const configured = config.enabled && Boolean(slotKey);
    slot.hidden = !configured;
    slot.classList.toggle('ad-slot-configured', configured);
    slot.setAttribute('aria-hidden', configured ? 'false' : 'true');
    slot.replaceChildren();
    if (!configured) return;

    slot.dataset.adProvider = config.provider;
    slot.dataset.adPlacement = slot.dataset.adPlacement || slotKey;
    slot.append(...placeholderContent(documentRef, config.provider));
    const adapter = providerAdapters.get(config.provider.toLowerCase());
    if (adapter) {
      try {
        Promise.resolve(adapter({ element: slot, provider: config.provider, client: config.client, slot: slotKey, consent: config.consent, documentRef }))
          .catch(() => {});
      } catch {
        // Keep the safe placeholder if a future provider adapter fails.
      }
    }
  });
  return config;
}
