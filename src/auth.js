#!/usr/bin/env node
/**
 * Script one-time: apre un server locale, esegue il flow OAuth authorization code
 * di TikTok e salva tokens.json.
 *
 *   npm run auth
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { config, requireEnv } from '../config.js';
import { exchangeCodeForTokens, saveTokens } from './tiktok.js';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';

function buildAuthorizeUrl(clientKey, state) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_key', clientKey);
  url.searchParams.set('scope', config.tiktok.scopes.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.tiktok.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

function htmlPage(title, message) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6}
h1{font-size:1.4rem}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:.2rem}</style>
</head><body><h1>${title}</h1><p>${message}</p></body></html>`;
}

/** Avvia il server locale e risolve con il code ricevuto sulla redirect URI. */
function waitForCallback(expectedState) {
  const redirect = new URL(config.tiktok.redirectUri);
  const callbackPath = redirect.pathname;
  const port = config.tiktok.authPort;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, `http://localhost:${port}`);

      if (requestUrl.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const finish = (statusCode, page, settle) => {
        res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page);
        server.close(() => settle());
      };

      const error = requestUrl.searchParams.get('error');
      if (error) {
        const description = requestUrl.searchParams.get('error_description') || 'nessun dettaglio';
        finish(400, htmlPage('Autorizzazione negata', `${error}: ${description}`), () =>
          reject(new Error(`Autorizzazione negata da TikTok: ${error} — ${description}`))
        );
        return;
      }

      const state = requestUrl.searchParams.get('state');
      if (state !== expectedState) {
        finish(400, htmlPage('State non valido', 'Il parametro <code>state</code> non combacia.'), () =>
          reject(new Error('State non valido nella callback: possibile richiesta non originata da questo script.'))
        );
        return;
      }

      // URLSearchParams decodifica già il code (TikTok lo restituisce URL-encoded,
      // spesso con un suffisso "*1" che va mantenuto così com'è).
      const code = requestUrl.searchParams.get('code');
      if (!code) {
        finish(400, htmlPage('Code mancante', 'La callback non conteneva nessun <code>code</code>.'), () =>
          reject(new Error('La callback di TikTok non conteneva il parametro code.'))
        );
        return;
      }

      finish(
        200,
        htmlPage('Autorizzazione completata', 'Puoi chiudere questa scheda e tornare al terminale.'),
        () => resolve(code)
      );
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`La porta ${port} è già occupata. Libera la porta o cambia AUTH_PORT nel .env.`));
        return;
      }
      reject(err);
    });

    server.listen(port, () => {
      console.log(`In ascolto su ${config.tiktok.redirectUri}`);
    });
  });
}

async function main() {
  const clientKey = requireEnv('TIKTOK_CLIENT_KEY');
  requireEnv('TIKTOK_CLIENT_SECRET');

  const state = crypto.randomBytes(16).toString('hex');
  const authorizeUrl = buildAuthorizeUrl(clientKey, state);

  console.log('\nApri questo link nel browser e autorizza l\'app:\n');
  console.log(`  ${authorizeUrl}\n`);
  console.log('(La redirect URI deve combaciare esattamente con quella registrata nella app TikTok.)\n');

  const code = await waitForCallback(state);
  console.log('Code ricevuto, lo scambio con i token...');

  const tokens = await exchangeCodeForTokens(code);
  await saveTokens(tokens);

  console.log(`\nFatto. Token salvati in ${config.paths.tokensFile}`);
  console.log(`  open_id : ${tokens.open_id ?? '(non fornito)'}`);
  console.log(`  scope   : ${tokens.scope ?? '(non fornito)'}`);
  console.log(`  scadenza access token: ${new Date(tokens.expires_at).toLocaleString('it-IT')}`);
  console.log('\nIl refresh token dura circa un anno e viene rinnovato automaticamente a ogni post.');
}

main().catch((err) => {
  console.error(`\nErrore: ${err.message}`);
  process.exit(1);
});
