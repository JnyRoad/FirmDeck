import assert from 'node:assert/strict';
import test from 'node:test';

import {
  corsHeaders,
  createRateLimiter,
  createSessionToken,
  sessionFromRequest,
  verifySessionToken,
} from '../lib/security.mjs';

test('signed website sessions verify and reject tampering', () => {
  const secret = 'a-secure-test-secret-that-is-long-enough';
  const { session, token } = createSessionToken(secret, 60, 1_000);
  assert.equal(verifySessionToken(token, secret, 2_000)?.sid, session.sid);
  assert.equal(verifySessionToken(`${token}x`, secret, 2_000), null);
  assert.equal(verifySessionToken(token, secret, 62_000), null);
});

test('website sessions accept a signed header token without a cookie', () => {
  const secret = 'a-secure-test-secret-that-is-long-enough';
  const { session, token } = createSessionToken(secret, 60);
  const request = { headers: { 'x-site-session': token } };
  assert.equal(sessionFromRequest(request, secret)?.sid, session.sid);
});

test('CORS headers are emitted only for configured origins', () => {
  const request = {
    headers: {
      host: '39.102.210.77:10086',
      origin: 'https://openbmb.github.io',
    },
  };
  assert.equal(corsHeaders(request, ['https://openbmb.github.io'])['Access-Control-Allow-Origin'], 'https://openbmb.github.io');
  assert.deepEqual(corsHeaders(request, ['https://example.com']), {});
});
test('rate limiter resets after its window', () => {
  const consume = createRateLimiter({ limit: 2, windowMs: 1_000 });
  assert.equal(consume('visitor', 0).allowed, true);
  assert.equal(consume('visitor', 10).allowed, true);
  assert.equal(consume('visitor', 20).allowed, false);
  assert.equal(consume('visitor', 1_100).allowed, true);
});
