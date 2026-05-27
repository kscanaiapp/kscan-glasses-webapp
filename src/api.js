const BASE_URL = (import.meta.env.VITE_KSCAN_BACKEND_URL || '').replace(/\/$/, '');

function withTimeout(promiseFactory, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return promiseFactory(controller.signal).finally(() => clearTimeout(timer));
}

function normalizeProduct(item) {
  const product = item && typeof item === 'object' ? item : {};
  const brand = typeof product.brand === 'string' ? product.brand : 'Unknown Brand';
  const name = typeof product.name === 'string' ? product.name : 'Unnamed Product';
  const price = typeof product.price === 'string'
    ? product.price
    : (typeof product.price_range === 'string' ? product.price_range : 'Price unavailable');
  const confidence = Number.isFinite(product.confidence) ? product.confidence : null;
  const image = typeof product.image === 'string' ? product.image : '';
  const link = typeof product.link === 'string' ? product.link : '#';

  return { brand, name, price, confidence, image, link };
}

export async function analyzeImage(base64) {
  if (!BASE_URL) throw new Error('Missing VITE_KSCAN_BACKEND_URL');

  let response;
  try {
    response = await withTimeout(
      (signal) => fetch(`${BASE_URL}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
        signal,
      }),
      10000,
    );
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Analyze request timed out');
    throw new Error('Network error during analyze request');
  }

  if (!response.ok) {
    throw new Error(`Analyze request failed (${response.status})`);
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error('Invalid JSON from analyze endpoint');
  }

  if (!json || typeof json !== 'object') {
    throw new Error('Invalid analyze response payload');
  }

  const productsSource = Array.isArray(json.products) ? json.products : [];
  const products = productsSource.map(normalizeProduct);

  return {
    products,
    style_metadata: json.style_metadata && typeof json.style_metadata === 'object' ? json.style_metadata : {},
    raw: json,
  };
}
