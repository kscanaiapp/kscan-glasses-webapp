// Canonical companion result fixtures — LOCAL QA / TEST USE ONLY.
//
// These fixtures feed the mock phone companion and the contract/state
// test suites. They must NEVER ship in the production artifact; the
// artifact verifier asserts FIXTURE_MARKER is absent from dist/.
//
// All fixtures are synthetic: no real products, no real photography, no
// personal data. Thumbnails point at non-existent https hosts on purpose —
// the HUD must render the intentional placeholder tile when they fail.

export const FIXTURE_MARKER = 'KSCAN_COMPANION_FIXTURE_V1';

let seq = 0;
function ids(requestId) {
  seq += 1;
  return {
    resultId: `fixture-r${seq}`,
    requestId: requestId || `fixture-req-${seq}`,
  };
}

function baseItem(overrides = {}) {
  return {
    title: 'Structured Wool Coat',
    brand: 'Fixture Atelier',
    price: { amount: 210, currency: 'USD' },
    commerceGroup: 'retail',
    retailer: 'Fixture Retail Co',
    resaleSource: null,
    thumbnailUrl: 'https://fixtures.invalid/thumb/coat.jpg',
    href: 'https://fixtures.invalid/item/coat',
    ...overrides,
  };
}

export function makeFullResult(requestId) {
  return {
    ...ids(requestId),
    summary: 'Quiet-luxury tailored outerwear in a neutral palette.',
    confidence: 91,
    primaryMatch: baseItem(),
    alternatives: [
      baseItem({ title: 'Double-Breasted Overcoat', price: { amount: 265, currency: 'USD' } }),
      baseItem({ title: 'Pre-owned Wool Coat', commerceGroup: 'resale', retailer: null, resaleSource: 'Fixture Resale', price: { label: '$120–$150' } }),
      baseItem({ title: 'Belted Trench Coat', price: { amount: 189, currency: 'EUR' } }),
    ],
    actions: ['save', 'open_on_phone'],
    generatedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_000_000 + 5 * 60 * 1000,
    demoMode: true,
  };
}

export function makeMinimalResult(requestId) {
  return {
    ...ids(requestId),
    summary: 'Minimal fixture result.',
    confidence: null,
    primaryMatch: null,
    alternatives: [],
    actions: [],
    generatedAt: 1_800_000_000_000,
    expiresAt: null,
    demoMode: true,
  };
}

export function makeMultiAlternativeResult(requestId) {
  const r = makeFullResult(requestId);
  r.alternatives = [
    ...r.alternatives,
    baseItem({ title: 'Cropped Wool Jacket', price: { amount: 145, currency: 'USD' } }),
    baseItem({ title: 'Vintage Camel Coat', commerceGroup: 'resale', retailer: null, resaleSource: 'Fixture Resale', price: { amount: 98, currency: 'GBP' } }),
  ];
  return r;
}

export function makeMissingPriceResult(requestId) {
  const r = makeFullResult(requestId);
  r.primaryMatch = baseItem({ price: null });
  r.alternatives = [baseItem({ title: 'Unpriced Alternative', price: undefined })];
  return r;
}

export function makeMissingThumbnailResult(requestId) {
  const r = makeFullResult(requestId);
  r.primaryMatch = baseItem({ thumbnailUrl: null });
  r.alternatives = r.alternatives.map((a) => ({ ...a, thumbnailUrl: undefined }));
  return r;
}

export function makeRetailOnlyResult(requestId) {
  const r = makeFullResult(requestId);
  r.alternatives = r.alternatives.filter((a) => a.commerceGroup === 'retail');
  return r;
}

export function makeResaleOnlyResult(requestId) {
  const r = makeFullResult(requestId);
  r.primaryMatch = baseItem({ commerceGroup: 'resale', retailer: null, resaleSource: 'Fixture Resale' });
  r.alternatives = r.alternatives.map((a) => ({ ...a, commerceGroup: 'resale', retailer: null, resaleSource: 'Fixture Resale' }));
  return r;
}

export function makeMixedCommerceResult(requestId) {
  return makeFullResult(requestId); // retail primary + resale alternative
}

export function makeExpiredResult(requestId) {
  const r = makeFullResult(requestId);
  r.generatedAt = 1_700_000_000_000;
  r.expiresAt = 1_700_000_060_000; // long past
  return r;
}

export function makeMalformedResult(requestId) {
  const r = makeFullResult(requestId);
  delete r.primaryMatch.title; // required item field missing
  return r;
}

export function makeOversizedResult(requestId) {
  const r = makeFullResult(requestId);
  r.summary = `oversized-${'x'.repeat(120 * 1024)}`;
  return r;
}

export function makeUnsafeUrlResult(requestId) {
  const r = makeFullResult(requestId);
  r.primaryMatch = baseItem({ thumbnailUrl: 'javascript:alert(1)' });
  return r;
}

export function makeHtmlInjectionResult(requestId) {
  const r = makeFullResult(requestId);
  r.summary = '<img src=x onerror=alert(1)>Injected summary';
  r.primaryMatch = baseItem({ title: '<script>alert(2)</script>Coat' });
  return r;
}

export function makeImageDataResult(requestId) {
  const r = makeFullResult(requestId);
  r.primaryMatch = { ...baseItem(), imageData: 'data:image/jpeg;base64,/9j/4AAQ...' };
  return r;
}

export function makeAuthDataResult(requestId) {
  const r = makeFullResult(requestId);
  return { ...r, accessToken: 'ya29.forged', refreshToken: 'forged-refresh' };
}

export const FIXTURE_BUILDERS = Object.freeze({
  full: makeFullResult,
  minimal: makeMinimalResult,
  multiAlternatives: makeMultiAlternativeResult,
  missingPrice: makeMissingPriceResult,
  missingThumbnail: makeMissingThumbnailResult,
  retailOnly: makeRetailOnlyResult,
  resaleOnly: makeResaleOnlyResult,
  mixedCommerce: makeMixedCommerceResult,
  expired: makeExpiredResult,
  malformed: makeMalformedResult,
  oversized: makeOversizedResult,
  unsafeUrl: makeUnsafeUrlResult,
  htmlInjection: makeHtmlInjectionResult,
  imageData: makeImageDataResult,
  authData: makeAuthDataResult,
});
