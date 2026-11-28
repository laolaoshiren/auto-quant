import test from 'node:test';
import assert from 'node:assert/strict';
import { isCorsOriginAllowed, parseCorsAllowedOrigins } from './corsOrigin.js';

test('allows requests without Origin header', () => {
  assert.equal(isCorsOriginAllowed(undefined, { requestHost: 'app.example.com' }), true);
});

test('allows same-origin requests behind reverse proxy', () => {
  assert.equal(
    isCorsOriginAllowed('https://app.example.com', { requestHost: 'app.example.com' }),
    true,
  );
  assert.equal(
    isCorsOriginAllowed('https://app.example.com:8443', { requestHost: 'app.example.com:8443' }),
    true,
  );
});

test('allows loopback dev origins across local ports', () => {
  assert.equal(
    isCorsOriginAllowed('http://localhost:5173', { requestHost: '127.0.0.1:27137' }),
    true,
  );
  assert.equal(
    isCorsOriginAllowed('http://127.0.0.1:3200', { requestHost: '127.0.0.1:27137' }),
    true,
  );
});

test('blocks untrusted third-party origins by default', () => {
  assert.equal(
    isCorsOriginAllowed('https://evil.example.net', { requestHost: 'app.example.com' }),
    false,
  );
  assert.equal(
    isCorsOriginAllowed('https://app.example.com.evil.net', { requestHost: 'app.example.com' }),
    false,
  );
  assert.equal(isCorsOriginAllowed('null', { requestHost: 'app.example.com' }), false);
});

test('honors explicit CORS_ALLOWED_ORIGINS whitelist', () => {
  const allow = parseCorsAllowedOrigins('https://admin.example.org/, https://console.example.org');
  assert.equal(
    isCorsOriginAllowed('https://admin.example.org', {
      requestHost: 'api.example.com',
      extraAllowedOrigins: allow,
    }),
    true,
  );
  assert.equal(
    isCorsOriginAllowed('https://other.example.org', {
      requestHost: 'api.example.com',
      extraAllowedOrigins: allow,
    }),
    false,
  );
});
