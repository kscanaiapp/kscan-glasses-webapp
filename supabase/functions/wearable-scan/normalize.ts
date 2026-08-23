// Pure response-normalization logic for wearable-scan, split out from
// index.ts so it can be unit-tested (_test.ts) without importing the
// Deno.serve bootstrap, which requires --allow-net and starts a listener.

// Maps one scan-identify RankedScanProduct (a loose, provider-dependent
// shape — see services/scanIdentificationMapper.ts in the K Scan mobile
// app, the canonical consumer of this same response) into a bounded
// wearable commerce entry. Reads both camelCase and snake_case field name
// variants, matching how the mobile ProductShelf already reads this data.
export function toWearableProduct(p: any, commerceGroup: 'retail' | 'suggested' = 'retail'): any {
  const retailer = String(p?.retailer || p?.source || '').slice(0, 80);
  const imageUrl = typeof p?.imageUrl === 'string' ? p.imageUrl : typeof p?.image_url === 'string' ? p.image_url : null;
  const href = typeof p?.url === 'string' ? p.url : typeof p?.product_url === 'string' ? p.product_url : null;
  return {
    title: String(p?.name || p?.title || p?.displayName || 'Unnamed Product').slice(0, 120),
    brand: String(p?.brand || p?.brandName || '').slice(0, 80),
    price: typeof p?.price === 'object' && p?.price !== null ? p.price : { label: String(p?.price || p?.priceText || 'Price unavailable').slice(0, 40) },
    commerceGroup,
    retailer,
    thumbnailUrl: typeof imageUrl === 'string' && imageUrl.startsWith('https://') ? imageUrl : null,
    href: typeof href === 'string' && href.startsWith('https://') ? href : null,
  };
}

// Normalizes a scan-identify response into a bounded wearable result.
//
// scan-identify's actual response shape (verified against the live
// function, 2026-08-22 — see services/scanIdentificationMapper.ts in the
// K Scan mobile app for the canonical, authoritative parse of this same
// shape) does NOT have a `style_metadata` field or a populated top-level
// `products` field — an earlier version of this function read both and
// would have silently returned a fixed placeholder summary, null
// confidence, and an EMPTY product list for every real wearable scan.
// The real fields are `identification.visual_observation` (summary),
// `identification.confidence_score` (confidence), and `similarityMatches`
// (catalog shelf) falling back to `recommendedProducts` (live commerce) —
// exactly the `hasSimilarityField` split the mobile mapper performs.
export function normalizeWearableResult(raw: any, requestId: string): any {
  if (!raw || typeof raw !== 'object') {
    throw new Error('INVALID_RESULT_SHAPE');
  }

  const identification = raw.identification && typeof raw.identification === 'object' ? raw.identification : {};
  const hasSimilarityField = Object.prototype.hasOwnProperty.call(raw, 'similarityMatches');
  const recommendedProducts = Array.isArray(raw.recommendedProducts) ? raw.recommendedProducts : [];
  const similarityMatches = Array.isArray(raw.similarityMatches) ? raw.similarityMatches : [];
  const products = hasSimilarityField ? similarityMatches : recommendedProducts;

  // Commerce grouping is derived from WHICH array the product came from, not
  // hard-coded. The two source arrays mean genuinely different things and the
  // canonical StyleMatch shape has distinct buckets for them:
  //
  //   recommendedProducts -> live commerce listings   -> 'retail'
  //   similarityMatches   -> catalog similarity shelf -> 'suggested'
  //
  // Stamping every item 'retail' (as this function previously did) told the
  // wearer that a visual-similarity suggestion was a buyable retail listing.
  //
  // 'resale' is deliberately NOT produced here: the scan-identify response
  // carries no resale provenance for a product, and inventing one from, say,
  // a retailer name would be a guess presented as a fact. The bucket stays
  // empty until a real resale signal exists upstream.
  const commerceGroup: 'retail' | 'suggested' = hasSimilarityField ? 'suggested' : 'retail';

  const primary = products.length > 0 ? toWearableProduct(products[0], commerceGroup) : null;
  const alternatives = products.slice(1, 6).map((p: any) => toWearableProduct(p, commerceGroup));

  const summary = String(
    (typeof identification.visual_observation === 'string' && identification.visual_observation.trim())
      || (typeof raw.userMessage === 'string' && raw.userMessage.trim())
      || 'Style match found',
  ).slice(0, 300);
  const confidence = typeof identification.confidence_score === 'number'
    && identification.confidence_score >= 0 && identification.confidence_score <= 100
    ? Math.round(identification.confidence_score)
    : null;

  return {
    resultId: crypto.randomUUID(), // plain UUID — wearable-bridge requires UUID result IDs
    requestId,
    summary,
    confidence,
    primaryMatch: primary,
    alternatives,
    actions: ['save', 'open_on_phone'],
    generatedAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minute result TTL
    demoMode: false,
  };
}
