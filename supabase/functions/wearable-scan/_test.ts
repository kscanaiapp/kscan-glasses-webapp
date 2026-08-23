// Unit tests for wearable-scan's response normalization — the pure functions
// only, no network/Deno.serve. Run with: deno test --no-check
//
// These fixtures mirror the REAL scan-identify response envelope (verified
// against the live function on K Scan AI Staging, 2026-08-22), not a
// hypothetical shape. Before this file existed, normalizeWearableResult read
// a `style_metadata` field and a top-level `products` array that scan-identify
// never actually returns — every real wearable scan silently produced a fixed
// placeholder summary, null confidence, and (likely) zero product matches.
// These tests pin the corrected field mapping so that regression can't
// reintroduce the same silent failure undetected.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { normalizeWearableResult, toWearableProduct } from './normalize.ts';

const SAMPLE_PRODUCTS = [
  { name: 'Double-Breasted Overcoat', brand: 'Acme Co', price: { label: '$249.00' }, retailer: 'Acme', imageUrl: 'https://example.com/a.jpg', url: 'https://example.com/a' },
  { title: 'Wool Overcoat', brandName: 'Other Brand', priceText: '$199', source: 'OtherRetailer', image_url: 'https://example.com/b.jpg', product_url: 'https://example.com/b' },
];

// Matches the REAL scan-identify base response envelope, where
// similarityMatches is always present as a key (even when empty) — the
// current production shape — with recommendedProducts populated as the
// separate live-commerce field. Products here go in similarityMatches,
// since that is what a present-key response actually uses as the catalog
// shelf; recommendedProducts is exercised separately by the backward-compat
// test below (an older response shape that omits similarityMatches).
function realisticScanIdentifyResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    identification: {
      visual_observation: 'A double-breasted wool overcoat in charcoal grey',
      item_type: 'coat',
      confidence_score: 87,
      brand_guess: null,
      logo_detected: false,
    },
    attributes: { category: 'outerwear' },
    recommendedProducts: [],
    products: [], // scan-identify's base envelope always carries this — it must NOT be read as commerce data
    purchaseOptions: [],
    similarityMatches: SAMPLE_PRODUCTS,
    shoppingMeta: {},
    userMessage: 'Here is what we found.',
    ...overrides,
  };
}

Deno.test('normalizeWearableResult reads the real identification fields, not style_metadata', () => {
  const result = normalizeWearableResult(realisticScanIdentifyResponse(), 'req-1');
  assertEquals(result.summary, 'A double-breasted wool overcoat in charcoal grey');
  assertEquals(result.confidence, 87);
});

Deno.test('normalizeWearableResult falls back to userMessage when visual_observation is absent', () => {
  const raw = realisticScanIdentifyResponse({ identification: { confidence_score: 50 } });
  const result = normalizeWearableResult(raw, 'req-2');
  assertEquals(result.summary, 'Here is what we found.');
});

Deno.test('normalizeWearableResult falls back to the generic summary when nothing usable is present', () => {
  const raw = realisticScanIdentifyResponse({ identification: {}, userMessage: '' });
  const result = normalizeWearableResult(raw, 'req-3');
  assertEquals(result.summary, 'Style match found');
  assertEquals(result.confidence, null);
});

Deno.test('normalizeWearableResult reads similarityMatches, not the always-empty top-level products field', () => {
  const result = normalizeWearableResult(realisticScanIdentifyResponse(), 'req-4');
  assertExists(result.primaryMatch);
  assertEquals(result.primaryMatch.title, 'Double-Breasted Overcoat');
  assertEquals(result.primaryMatch.brand, 'Acme Co');
  assertEquals(result.alternatives.length, 1);
  assertEquals(result.alternatives[0].title, 'Wool Overcoat');
});

Deno.test('normalizeWearableResult falls back to recommendedProducts for an older response with no similarityMatches key at all', () => {
  const raw = realisticScanIdentifyResponse({ recommendedProducts: [{ name: 'Legacy Match', brand: 'Legacy Brand' }] });
  delete (raw as Record<string, unknown>).similarityMatches;
  const result = normalizeWearableResult(raw, 'req-5');
  assertEquals(result.primaryMatch.title, 'Legacy Match');
  assertEquals(result.primaryMatch.brand, 'Legacy Brand');
});

Deno.test('normalizeWearableResult prefers similarityMatches over recommendedProducts when both are present', () => {
  const raw = realisticScanIdentifyResponse({
    similarityMatches: [{ name: 'Catalog Match', brand: 'Catalog Brand' }],
    recommendedProducts: [{ name: 'Should Not Win', brand: 'Wrong Brand' }],
  });
  const result = normalizeWearableResult(raw, 'req-5b');
  assertEquals(result.primaryMatch.title, 'Catalog Match');
  assertEquals(result.primaryMatch.brand, 'Catalog Brand');
});

Deno.test('normalizeWearableResult returns no primaryMatch when no products are present at all', () => {
  const raw = realisticScanIdentifyResponse({ recommendedProducts: [], similarityMatches: [] });
  const result = normalizeWearableResult(raw, 'req-6');
  assertEquals(result.primaryMatch, null);
  assertEquals(result.alternatives.length, 0);
});

Deno.test('toWearableProduct reads snake_case field variants (image_url/product_url/source)', () => {
  const mapped = toWearableProduct({
    title: 'Snake Case Item',
    brand: 'Snake Brand',
    price: '$10',
    source: 'SnakeRetailer',
    image_url: 'https://example.com/s.jpg',
    product_url: 'https://example.com/s',
  });
  assertEquals(mapped.title, 'Snake Case Item');
  assertEquals(mapped.retailer, 'SnakeRetailer');
  assertEquals(mapped.thumbnailUrl, 'https://example.com/s.jpg');
  assertEquals(mapped.href, 'https://example.com/s');
});

Deno.test('toWearableProduct never puts the brand name into the retailer field', () => {
  const mapped = toWearableProduct({ title: 'Item', brand: 'Some Brand' });
  assertEquals(mapped.retailer, '');
});

Deno.test('toWearableProduct rejects non-https thumbnail/href URLs', () => {
  const mapped = toWearableProduct({ title: 'Item', imageUrl: 'http://insecure.example.com/a.jpg', url: 'http://insecure.example.com/a' });
  assertEquals(mapped.thumbnailUrl, null);
  assertEquals(mapped.href, null);
});

Deno.test('normalizeWearableResult throws on a non-object input', () => {
  let threw = false;
  try {
    normalizeWearableResult(null, 'req-7');
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// ---------------------------------------------------------------------------
// Commerce grouping.
//
// scan-identify returns two DIFFERENT kinds of product list and they do not
// mean the same thing to a wearer:
//
//   recommendedProducts -> live commerce listings   -> 'retail'
//   similarityMatches   -> catalog similarity shelf -> 'suggested'
//
// This function used to stamp `commerceGroup: 'retail'` on every item
// regardless of origin, which presented a visual-similarity suggestion as a
// buyable retail listing, and left the canonical StyleMatch 'suggested'
// bucket permanently empty. These tests pin the provenance-derived grouping.
// ---------------------------------------------------------------------------

Deno.test('similarityMatches are grouped as suggested, not presented as retail listings', () => {
  const result = normalizeWearableResult(realisticScanIdentifyResponse(), 'req-group-1');
  assertEquals(result.primaryMatch.commerceGroup, 'suggested');
  assertEquals(result.alternatives.length, 1);
  assertEquals(result.alternatives[0].commerceGroup, 'suggested');
});

Deno.test('recommendedProducts are grouped as retail when there is no similarity shelf', () => {
  const raw = realisticScanIdentifyResponse({ recommendedProducts: SAMPLE_PRODUCTS });
  delete (raw as Record<string, unknown>).similarityMatches;
  const result = normalizeWearableResult(raw, 'req-group-2');
  assertEquals(result.primaryMatch.commerceGroup, 'retail');
  assertEquals(result.alternatives[0].commerceGroup, 'retail');
});

Deno.test('an empty similarity shelf does not fall through and mislabel live commerce', () => {
  // similarityMatches is present but empty: the function reads it (and gets
  // nothing) rather than silently switching to recommendedProducts. That
  // behaviour is already pinned elsewhere; here we assert it does not produce
  // a mislabelled item either.
  const raw = realisticScanIdentifyResponse({ similarityMatches: [], recommendedProducts: SAMPLE_PRODUCTS });
  const result = normalizeWearableResult(raw, 'req-group-3');
  assertEquals(result.primaryMatch, null);
  assertEquals(result.alternatives.length, 0);
});

Deno.test('no wearable item is ever labelled resale, because no resale signal exists upstream', () => {
  // Guards against a future change inventing a resale provenance out of a
  // retailer name. If a genuine resale signal is added to scan-identify this
  // test should be updated deliberately, not deleted incidentally.
  for (const raw of [
    realisticScanIdentifyResponse(),
    realisticScanIdentifyResponse({ recommendedProducts: SAMPLE_PRODUCTS, similarityMatches: [] }),
  ]) {
    const result = normalizeWearableResult(raw, 'req-group-4');
    const groups = [result.primaryMatch, ...result.alternatives]
      .filter(Boolean)
      .map((item: any) => item.commerceGroup);
    assertEquals(groups.includes('resale'), false);
  }
});

Deno.test('toWearableProduct defaults to retail when no group is supplied', () => {
  assertEquals(toWearableProduct({ name: 'X' }).commerceGroup, 'retail');
  assertEquals(toWearableProduct({ name: 'X' }, 'suggested').commerceGroup, 'suggested');
});
