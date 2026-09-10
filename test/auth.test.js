import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { mockFetch, json } from './helpers.js';
import { buildAuthorizeUrl, createPkcePair } from '../src/auth.js';
import { exchangeCodeForTokens } from '../src/tiktok.js';

process.env.TIKTOK_CLIENT_KEY = 'ck';
process.env.TIKTOK_CLIENT_SECRET = 'cs';

let active;
afterEach(() => {
  active?.restore();
  active = undefined;
});

describe('PKCE', () => {
  test('il challenge è lo SHA256 del verifier in ESADECIMALE (non base64url)', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const hex = crypto.createHash('sha256').update(codeVerifier).digest('hex');
    assert.equal(codeChallenge, hex);
    assert.match(codeChallenge, /^[0-9a-f]{64}$/);
    // se qualcuno "corregge" in base64url, questo test cade
    const base64url = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    assert.notEqual(codeChallenge, base64url);
  });

  test('il verifier rispetta i vincoli RFC 7636', () => {
    const { codeVerifier } = createPkcePair();
    assert.ok(codeVerifier.length >= 43 && codeVerifier.length <= 128);
    assert.match(codeVerifier, /^[A-Za-z0-9._~-]+$/);
  });

  test('ogni chiamata genera una coppia nuova', () => {
    assert.notEqual(createPkcePair().codeVerifier, createPkcePair().codeVerifier);
  });
});

describe('URL di autorizzazione', () => {
  test('include challenge e metodo S256', () => {
    const url = new URL(buildAuthorizeUrl('ck', 'stato', 'abc123'));
    assert.equal(url.searchParams.get('code_challenge'), 'abc123');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('client_key'), 'ck');
    assert.equal(url.searchParams.get('state'), 'stato');
    assert.equal(url.searchParams.get('scope'), config.tiktok.scopes.join(','));
    assert.equal(url.searchParams.get('redirect_uri'), config.tiktok.redirectUri);
  });

  test('senza PKCE non manda i parametri', () => {
    const url = new URL(buildAuthorizeUrl('ck', 'stato', undefined));
    assert.equal(url.searchParams.get('code_challenge'), null);
    assert.equal(url.searchParams.get('code_challenge_method'), null);
  });
});

describe('scambio del code', () => {
  test('manda il code_verifier quando è stato usato PKCE', async () => {
    active = mockFetch(() => json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 }));
    await exchangeCodeForTokens('il-code', 'il-verifier');

    const body = new URLSearchParams(active.calls[0].body);
    assert.equal(body.get('code_verifier'), 'il-verifier');
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'il-code');
  });

  test('senza PKCE il campo non compare affatto', async () => {
    active = mockFetch(() => json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 }));
    await exchangeCodeForTokens('il-code');

    const body = new URLSearchParams(active.calls[0].body);
    assert.equal(body.has('code_verifier'), false);
  });
});
