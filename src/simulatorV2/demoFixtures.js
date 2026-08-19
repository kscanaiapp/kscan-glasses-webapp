// Demo scenario fixtures — Simulator V2 (LOCAL QA / NON-PRODUCTION).
//
// Category-flavored synthetic StyleMatch results for the guided product
// demo. These are NOT real products, brands, retailers, or prices — every
// brand/retailer name here is fictional. Shaped exactly to the companion
// result contract (src/companion/resultContract.js RESULT_FIELDS/ITEM_FIELDS)
// so they pass through validateResultPayload unchanged, the same as any
// real phone-side result would.

let seq = 0;
function ids(requestId) {
  seq += 1;
  return { resultId: `demo-r${seq}`, requestId: requestId || `demo-req-${seq}` };
}

function item(overrides = {}) {
  return {
    title: 'Item',
    brand: null,
    price: { amount: 0, currency: 'USD' },
    commerceGroup: 'retail',
    retailer: null,
    resaleSource: null,
    thumbnailUrl: null,
    href: null,
    ...overrides,
  };
}

function scenario({ requestId, summary, confidence, primary, alternatives, icon, actions = ['save', 'open_on_phone'] }) {
  return {
    ...ids(requestId),
    summary,
    confidence,
    primaryMatch: primary,
    alternatives: alternatives || [],
    actions,
    generatedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_000_000 + 5 * 60 * 1000,
    demoMode: true,
    // Presentation-only hint for the outer premium chrome (not part of the
    // wire result contract — read by simulatorV2.js before the object is
    // sent, and stripped by resultContract normalization on the HUD side).
    __icon: icon,
  };
}

export function makeSunglassesResult(requestId) {
  return scenario({
    requestId,
    summary: 'Oversized acetate sunglasses in a warm tortoise finish.',
    confidence: 94,
    icon: 'sunglasses',
    primary: item({
      title: 'Oversized Aviator Sunglasses', brand: 'Aurel Optic Co.',
      price: { amount: 285, currency: 'USD' }, commerceGroup: 'retail', retailer: 'Aurel Boutique',
    }),
    alternatives: [
      item({ title: 'Round Tortoise Sunglasses', brand: 'Aurel Optic Co.', price: { amount: 260, currency: 'USD' }, retailer: 'Aurel Boutique' }),
      item({ title: 'Pre-owned Cat-Eye Sunglasses', brand: 'Aurel Optic Co.', commerceGroup: 'resale', retailer: null, resaleSource: 'Second Look Resale', price: { label: '$110–$140' } }),
    ],
  });
}

export function makeHandbagResult(requestId) {
  return scenario({
    requestId,
    summary: 'Structured top-handle bag in supple grained leather.',
    confidence: 89,
    icon: 'handbag',
    primary: item({
      title: 'Structured Top-Handle Bag', brand: 'Rivoli & Co',
      price: { amount: 890, currency: 'USD' }, commerceGroup: 'retail', retailer: 'Rivoli Atelier',
    }),
    alternatives: [
      item({ title: 'Mini Crossbody Bag', brand: 'Rivoli & Co', price: { amount: 520, currency: 'USD' }, retailer: 'Rivoli Atelier' }),
      item({ title: 'Pre-owned Tote', brand: 'Rivoli & Co', commerceGroup: 'resale', retailer: null, resaleSource: 'Second Look Resale', price: { amount: 340, currency: 'USD' } }),
    ],
  });
}

export function makeSneakersResult(requestId) {
  return scenario({
    requestId,
    summary: 'Minimal low-top sneakers in white full-grain leather.',
    confidence: 91,
    icon: 'sneakers',
    primary: item({
      title: 'Minimal Leather Sneakers', brand: 'Solstice Athletic',
      price: { amount: 165, currency: 'USD' }, commerceGroup: 'retail', retailer: 'Solstice Direct',
    }),
    alternatives: [
      item({ title: 'Court Sneakers, Suede Trim', brand: 'Solstice Athletic', price: { amount: 175, currency: 'USD' }, retailer: 'Solstice Direct' }),
      item({ title: 'Pre-owned Runner', brand: 'Solstice Athletic', commerceGroup: 'resale', retailer: null, resaleSource: 'Second Look Resale', price: { amount: 78, currency: 'USD' } }),
    ],
  });
}

export function makeJacketResult(requestId) {
  return scenario({
    requestId,
    summary: 'Tailored wool-blend jacket in a quiet neutral tone.',
    confidence: 87,
    icon: 'jacket',
    primary: item({
      title: 'Tailored Wool-Blend Jacket', brand: 'Maison Fontaine',
      price: { amount: 410, currency: 'USD' }, commerceGroup: 'retail', retailer: 'Maison Fontaine',
    }),
    alternatives: [
      item({ title: 'Double-Breasted Overcoat', brand: 'Maison Fontaine', price: { amount: 495, currency: 'USD' }, retailer: 'Maison Fontaine' }),
      item({ title: 'Pre-owned Blazer', brand: 'Maison Fontaine', commerceGroup: 'resale', retailer: null, resaleSource: 'Second Look Resale', price: { label: '$150–$190' } }),
    ],
  });
}

export function makeWatchResult(requestId) {
  return scenario({
    requestId,
    summary: 'Slim stainless steel dress watch with a leather strap.',
    confidence: 92,
    icon: 'watch',
    primary: item({
      title: 'Slim Dress Watch', brand: 'Verrier & Sons',
      price: { amount: 640, currency: 'USD' }, commerceGroup: 'retail', retailer: 'Verrier & Sons',
    }),
    alternatives: [
      item({ title: 'Steel Bracelet Watch', brand: 'Verrier & Sons', price: { amount: 720, currency: 'USD' }, retailer: 'Verrier & Sons' }),
      item({ title: 'Pre-owned Chronograph', brand: 'Verrier & Sons', commerceGroup: 'resale', retailer: null, resaleSource: 'Second Look Resale', price: { amount: 410, currency: 'USD' } }),
    ],
  });
}

export function makeNoMatchResult(requestId) {
  return scenario({
    requestId,
    summary: 'No confident match this time — try another angle or better light.',
    confidence: null,
    icon: 'no-match',
    primary: null,
    alternatives: [],
    actions: [],
  });
}

export const DEMO_SCENARIOS = Object.freeze({
  sunglasses: { label: 'Sunglasses', builder: makeSunglassesResult, icon: 'sunglasses' },
  handbag: { label: 'Handbag', builder: makeHandbagResult, icon: 'handbag' },
  sneakers: { label: 'Sneakers', builder: makeSneakersResult, icon: 'sneakers' },
  jacket: { label: 'Jacket', builder: makeJacketResult, icon: 'jacket' },
  watch: { label: 'Watch', builder: makeWatchResult, icon: 'watch' },
  noMatch: { label: 'No Match', builder: makeNoMatchResult, icon: 'no-match' },
  connectionLoss: { label: 'Connection Loss', builder: makeSunglassesResult, icon: 'connection-loss', simulatesDrop: true },
});
