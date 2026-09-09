#!/usr/bin/env node
/**
 * Diagnostica: verifica env, token e permessi TikTok SENZA pubblicare niente.
 *
 *   npm run check
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getAccessToken, loadTokens, queryCreatorInfo } from './tiktok.js';
import { listQueue, readBrief } from './index.js';

let failed = false;

const ok = (msg) => console.log(`  OK   ${msg}`);
const warn = (msg) => console.log(`  ~    ${msg}`);
const bad = (msg) => {
  failed = true;
  console.log(`  FAIL ${msg}`);
};

function section(title) {
  console.log(`\n${title}`);
}

async function checkEnv() {
  section('1. Variabili d\'ambiente (.env)');
  for (const name of ['ANTHROPIC_API_KEY', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']) {
    if (process.env[name]) ok(`${name} presente`);
    else bad(`${name} mancante — copia .env.example in .env e compilalo`);
  }
  ok(`Modello Anthropic: ${config.anthropic.model}`);
  ok(`Redirect URI: ${config.tiktok.redirectUri}`);
}

async function checkTokens() {
  section('2. Token TikTok (tokens.json)');
  let tokens;
  try {
    tokens = await loadTokens();
  } catch (err) {
    bad(err.message);
    return null;
  }

  ok(`tokens.json trovato (open_id: ${tokens.open_id ?? 'non salvato'})`);

  const scopes = String(tokens.scope || '')
    .split(/[,\s]+/)
    .filter(Boolean);
  for (const needed of config.tiktok.scopes) {
    if (scopes.length === 0) {
      warn(`scope non salvato nel file: non posso verificare ${needed}`);
      break;
    }
    if (scopes.includes(needed)) ok(`scope ${needed} concesso`);
    else bad(`scope ${needed} MANCANTE — rilancia "npm run auth" autorizzando tutti i permessi`);
  }

  const expiresAt = Number(tokens.expires_at || 0);
  if (expiresAt > Date.now()) {
    const minutes = Math.round((expiresAt - Date.now()) / 60000);
    ok(`access token valido ancora ~${minutes} min`);
  } else {
    warn('access token scaduto: verrà rinnovato adesso col refresh token');
  }
  return tokens;
}

async function checkApi() {
  section('3. Chiamata reale a TikTok (creator_info, nessuna pubblicazione)');
  let accessToken;
  try {
    accessToken = await getAccessToken();
    ok('access token utilizzabile (refresh eseguito se serviva)');
  } catch (err) {
    bad(err.message);
    return;
  }

  try {
    const info = await queryCreatorInfo(accessToken);
    ok(`account: ${info.creator_nickname || info.creator_username || 'sconosciuto'}`);
    if (typeof info.max_video_post_duration_sec === 'number') {
      ok(`durata massima video: ${info.max_video_post_duration_sec}s`);
    }
    const options = info.privacy_level_options || [];
    ok(`privacy_level_options: ${options.join(', ') || '(nessuna)'}`);
    if (options.includes('PUBLIC_TO_EVERYONE')) {
      warn(
        'PUBLIC_TO_EVERYONE compare tra le opzioni anche con app NON auditata: ' +
          'non è una garanzia, il video resterà privato.'
      );
    }
    if (!options.includes(config.tiktok.privacyLevel)) {
      bad(`privacy_level configurato (${config.tiktok.privacyLevel}) non tra le opzioni disponibili`);
    }
  } catch (err) {
    bad(err.message);
  }
}

async function checkQueue() {
  section('4. Coda video');
  let queue;
  try {
    queue = await listQueue();
  } catch (err) {
    bad(err.message);
    return;
  }

  if (queue.length === 0) {
    warn(`nessun video in ${config.paths.queueDir} — il prossimo run non farà nulla`);
    return;
  }

  ok(`${queue.length} video in coda (ordine: ${config.video.order})`);
  const next = queue[0];
  const { size } = await fs.stat(next);
  const mb = (size / 1024 / 1024).toFixed(1);

  if (size === 0) bad(`il prossimo video (${path.basename(next)}) è vuoto`);
  else if (size > config.tiktok.maxSingleChunkBytes) {
    bad(
      `il prossimo video (${path.basename(next)}) pesa ${mb} MB e supera il limite di ` +
        `${(config.tiktok.maxSingleChunkBytes / 1024 / 1024).toFixed(0)} MB per l'upload single-chunk`
    );
  } else ok(`prossimo: ${path.basename(next)} (${mb} MB)`);

  const { source } = await readBrief(next);
  ok(`brief: ${source}`);
}

async function main() {
  console.log('Controllo della configurazione (nessun video verrà pubblicato)');
  await checkEnv();
  const tokens = await checkTokens();
  if (tokens) {
    await checkApi();
  } else {
    section('3. Chiamata reale a TikTok');
    warn('saltata: prima esegui "npm run auth"');
  }
  await checkQueue();

  console.log(
    failed
      ? '\nCi sono problemi da sistemare (vedi le righe FAIL).'
      : '\nTutto a posto. Prova "npm run post -- --dry-run" per vedere la caption senza pubblicare.'
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nErrore inatteso: ${err.message}`);
  process.exit(1);
});
