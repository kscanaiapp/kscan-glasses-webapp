// Guest library store: scan history + saved items.
//
// Storage policy (Phase 11, documented in README):
//   - Guest data lives in localStorage under a SCHEMA-VERSIONED key.
//   - SMALL METADATA ONLY: ids, timestamps, counts, brand/name/price text.
//   - NEVER images, base64 payloads, face metadata, tokens, or emails.
//   - Caps: 20 scans, 50 saved items (oldest evicted first).
//   - Guest data is preserved if the user later authenticates (no silent
//     wipe); a future migration/sync strategy is documented as TODO.
//   - Supabase-backed storage is deferred until @supabase/supabase-js is an
//     approved dependency; in stub mode the Library screen shows guest data
//     plus clearly-labeled example fixtures.

export const LIBRARY_SCHEMA_VERSION = 1;
export const LIBRARY_STORAGE_KEY = 'kscan.guestLibrary.v1';
const MAX_SCANS = 20;
const MAX_SAVED_ITEMS = 50;

const ALLOWED_SCAN_FIELDS = ['id', 'capturedAt', 'productCount', 'topBrand', 'topName'];
const ALLOWED_ITEM_FIELDS = ['id', 'savedAt', 'brand', 'name', 'price'];

function getStorage(storageLike) {
  if (storageLike) return storageLike;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function emptyLibrary() {
  return { schemaVersion: LIBRARY_SCHEMA_VERSION, scans: [], savedItems: [] };
}

function pickFields(source, allowed) {
  const out = {};
  for (const key of allowed) {
    const value = source?.[key];
    if (typeof value === 'string' && value.length <= 200) out[key] = value;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

// Defensive: refuse to persist anything that looks like an image payload.
function containsImagePayload(obj) {
  try {
    const serialized = JSON.stringify(obj);
    return serialized.includes('base64,') || serialized.length > 4096;
  } catch {
    return true;
  }
}

export function loadGuestLibrary(storageLike) {
  const storage = getStorage(storageLike);
  if (!storage) return emptyLibrary();

  try {
    const raw = storage.getItem(LIBRARY_STORAGE_KEY);
    if (!raw) return emptyLibrary();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== LIBRARY_SCHEMA_VERSION) {
      // Unknown/older schema: start fresh rather than guess. (v1 is first.)
      return emptyLibrary();
    }
    return {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      scans: Array.isArray(parsed.scans) ? parsed.scans.slice(0, MAX_SCANS) : [],
      savedItems: Array.isArray(parsed.savedItems) ? parsed.savedItems.slice(0, MAX_SAVED_ITEMS) : [],
    };
  } catch {
    return emptyLibrary();
  }
}

function persist(storage, library) {
  if (!storage) return false;
  if (containsImagePayload(library)) return false; // hard privacy gate
  try {
    storage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(library));
    return true;
  } catch {
    return false;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Record metadata about a completed scan. Accepts ONLY whitelisted scalar
 * fields — image data passed in by mistake is silently dropped.
 */
export function recordGuestScan(meta, storageLike) {
  const storage = getStorage(storageLike);
  const library = loadGuestLibrary(storage);

  const entry = {
    id: makeId('scan'),
    capturedAt: new Date().toISOString(),
    ...pickFields(meta, ALLOWED_SCAN_FIELDS.filter((f) => f !== 'id' && f !== 'capturedAt')),
  };

  library.scans = [entry, ...library.scans].slice(0, MAX_SCANS);
  persist(storage, library);
  return entry;
}

/** Save a product (metadata only) to the guest library. Dedupes by brand+name. */
export function saveGuestItem(product, storageLike) {
  const storage = getStorage(storageLike);
  const library = loadGuestLibrary(storage);

  const candidate = {
    id: makeId('item'),
    savedAt: new Date().toISOString(),
    ...pickFields(product, ALLOWED_ITEM_FIELDS.filter((f) => f !== 'id' && f !== 'savedAt')),
  };

  const duplicate = library.savedItems.some(
    (item) => item.brand === candidate.brand && item.name === candidate.name,
  );
  if (duplicate) return { saved: false, reason: 'duplicate' };

  library.savedItems = [candidate, ...library.savedItems].slice(0, MAX_SAVED_ITEMS);
  const ok = persist(storage, library);
  return { saved: ok, item: ok ? candidate : undefined };
}

export function clearGuestLibrary(storageLike) {
  const storage = getStorage(storageLike);
  if (!storage) return;
  try {
    storage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(emptyLibrary()));
  } catch {
    // ignore
  }
}

/** Clearly-labeled example fixtures shown in offline stub mode. */
export function getStubLibraryExamples() {
  return {
    scans: [
      { id: 'example_scan_1', capturedAt: '2026-06-01T17:20:00.000Z', productCount: 4, topBrand: 'Aether Loom', topName: 'Chrome Arc Jacket' },
      { id: 'example_scan_2', capturedAt: '2026-05-28T09:05:00.000Z', productCount: 0, topBrand: '', topName: '' },
    ],
    savedItems: [
      { id: 'example_item_1', savedAt: '2026-06-01T17:21:00.000Z', brand: 'Nova Thread', name: 'Cyan Edge Utility Vest', price: '$124' },
    ],
  };
}
