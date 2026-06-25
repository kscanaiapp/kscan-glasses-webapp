import assert from 'node:assert/strict';

import {
  analyzeTextQuery,
  TEXTSCAN_ERROR_CODES,
} from '../src/services/textScan.js';
import {
  __setSupabaseTestClient,
} from '../src/services/supabaseClient.js';

function makeSuccessData() {
  return {
    status: 'completed',
    attributes: {
      category: 'Outerwear',
      colorPalette: ['Black'],
      materialEstimate: 'Wool',
      silhouette: 'Oversized',
      occasion: 'Work',
      styleTags: ['minimal'],
      confidenceScore: 0.91,
    },
    userMessage: 'Black oversized blazer with structured shoulders.',
  };
}

function makeClient(invokeImpl, refreshImpl = null) {
  return {
    auth: {
      async getSession() {
        return { data: { session: { access_token: 'mock-access-token' } } };
      },
      async refreshSession() {
        if (refreshImpl) return refreshImpl();
        return { data: { session: { access_token: 'mock-access-token' } } };
      },
    },
    functions: {
      invoke: invokeImpl,
    },
  };
}

async function expectRejectsCode(name, promise, code) {
  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.equal(caught?.code, code, `${name}: expected ${code}, got ${caught?.code || 'no error'}`);
}

async function testSuccess() {
  let body = null;
  __setSupabaseTestClient(makeClient(async (_fn, options) => {
    body = options.body;
    return { data: makeSuccessData(), error: null };
  }));
  const result = await analyzeTextQuery('  black oversized blazer  ', { source: 'preset', mock: false });
  assert.equal(body.mode, 'text');
  assert.equal(body.textQuery, 'black oversized blazer');
  assert.equal(body.source, 'preset');
  assert.ok(body.clientTimestamp);
  assert.equal(result.meta.isDemo, false);
  assert.ok(result.spokenSummary);
}

async function testThrownNetworkError() {
  __setSupabaseTestClient(makeClient(async () => {
    throw new Error('network down');
  }));
  await expectRejectsCode(
    'thrown network error',
    analyzeTextQuery('black blazer', { source: 'preset', mock: false }),
    TEXTSCAN_ERROR_CODES.NETWORK_ERROR,
  );
}

async function testReturnedErrorObject() {
  __setSupabaseTestClient(makeClient(async () => ({
    data: null,
    error: { message: 'bad request', status: 400 },
  })));
  await expectRejectsCode(
    'returned error object',
    analyzeTextQuery('black blazer', { source: 'preset', mock: false }),
    TEXTSCAN_ERROR_CODES.NETWORK_ERROR,
  );
}

async function testMalformedData() {
  __setSupabaseTestClient(makeClient(async () => ({ data: { status: 'completed' }, error: null })));
  await expectRejectsCode(
    'malformed data',
    analyzeTextQuery('black blazer', { source: 'preset', mock: false }),
    TEXTSCAN_ERROR_CODES.MALFORMED_RESPONSE,
  );
}

async function testAuthRetrySuccess() {
  let calls = 0;
  let refreshed = false;
  __setSupabaseTestClient(makeClient(
    async () => {
      calls += 1;
      if (calls === 1) return { data: null, error: { message: 'jwt expired', status: 401 } };
      return { data: makeSuccessData(), error: null };
    },
    async () => {
      refreshed = true;
      return { data: { session: { access_token: 'mock-access-token' } }, error: null };
    },
  ));
  const result = await analyzeTextQuery('black blazer', { source: 'preset', mock: false });
  assert.equal(calls, 2);
  assert.equal(refreshed, true);
  assert.equal(result.error, undefined);
}

async function testDuplicateInvocationBlocked() {
  let release;
  const pending = new Promise((resolve) => {
    release = () => resolve({ data: makeSuccessData(), error: null });
  });
  __setSupabaseTestClient(makeClient(async () => pending));
  const first = analyzeTextQuery('black blazer', { source: 'preset', mock: false });
  await expectRejectsCode(
    'duplicate invocation',
    analyzeTextQuery('blue bag', { source: 'preset', mock: false }),
    TEXTSCAN_ERROR_CODES.BUSY,
  );
  release();
  await first;
}

await testSuccess();
await testThrownNetworkError();
await testReturnedErrorObject();
await testMalformedData();
await testAuthRetrySuccess();
await testDuplicateInvocationBlocked();

__setSupabaseTestClient(null, false);
console.log('[OK] TextScan live mocked tests passed.');
