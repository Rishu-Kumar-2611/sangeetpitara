# Minimal-effort AdSense guide — what YOU do

Everything else is already done in the repo.

## Already built
- privacy.html (Google/DART, opt-out, ads.txt note, consent)
- terms.html (DMCA, moderation)
- about.html (original content for reviewers)
- contact.html (email + 48h promise — edit placeholder if you want)
- robots.txt + sitemap.xml
- index.html — canonical, OG/Twitter, JSON-LD, footer (About/Privacy/Terms/Contact/Sitemap/Cookie prefs), consent-gated ad slots + cookie banner wired to ads.mjs
- server.mjs — serves .xml, /ads.txt emits google.com, pub-..., DIRECT line after env vars
- 82/82 PASS

Zero code change to turn ads on — only Render env vars.

## Steps (in order)
### A. Support email (2 min)
Placeholder is support@sangeet-pitaraa.onrender.com. Edit contact.html or just visit ?email=you@gmail.com once — stored to localStorage:roomsound-contact-email.

### B. Push live
Commit + push main. Verify /privacy.html /terms.html /about.html /contact.html /robots.txt /sitemap.xml return 200. /ads.txt 404 before approval is expected.

### C. Create AdSense account (15 min)
1. https://adsense.google.com → Get started → site sangeet-pitaraa.onrender.com.
2. Verification: ads.txt will auto-serve after approval (step E), or paste the meta/script Google gives into index.html head, push once.
3. Add payout profile (legal name, PAN, address). Pin letter after small threshold; payouts at Rs 800.

### D. While waiting
- Keep footer + Allow/Deny banner visible on first visit.
- Optional: add to Search Console and submit sitemap.xml.
- Never click own ads.

### E. After approval — turn on in 2 min (no code)
1. In AdSense → Ads → create 2 Responsive units → copy ca-pub-... + LANDING_SLOT + ROOM_SLOT.
2. Render → Environment:
   ADSENSE_ENABLED=1
   ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXX
   ADSENSE_LANDING_SLOT=1111111111
   ADSENSE_ROOM_SLOT=2222222222
3. Verify: /api/config shows enabled:true, /ads.txt shows google.com, pub-..., Allow loads pagead2.googlesyndication.com.

## Earning before subscriptions
1. **Display ads (day 1):** two slots, consent-gated. India RPM ~$0.2-0.8, US/EU $2-8. 1k views/day x $0.5 ≈ $15/mo; scales linearly.
2. **Rewarded gate (built):** 30s view → 6h free. Now demo-local (no payout, policy-safe). Later wire a real rewarded provider via registerAdProvider() for higher CPM.
3. **Tip jar:** Buy Me a Coffee / UPI / Razorpay link in footer — no paywall, goodwill.
4. **Freemium later (your plan):** billing.mjs + STRIPE_* already staged. Free forever + Plus Rs 49-99/mo (no gate, larger rooms, priority relay). Enable after ~100 DAU.
Fallback if rejected: add 5-10 help posts, then retry or registerAdProvider for Medianet/PropellerAds/Adsterra.
