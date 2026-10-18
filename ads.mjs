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
const AD_CONSENT_STORAGE_KEY = 'roomsound-ad-consent';

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
