#!/usr/bin/env node
/**
 * Diagnostica: verifica env, token, ffmpeg, riferimenti e permessi TikTok
 * SENZA generare né pubblicare niente (quindi senza spendere).
 *
 *   npm run check
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { listReferences } from './gemini.js';
import { listPhotos, pickPhoto } from './photos.js';
import { runFfmpeg } from './slideshow.js';
import { readHistory, recentNames } from './state.js';
import { getAccessToken, loadTokens, queryCreatorInfo } from './tiktok.js';

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
  const needed = ['ANTHROPIC_API_KEY', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'];
  // Con POST_SOURCE=reference non generiamo niente: la chiave Gemini non serve.
  if (config.product.source === 'generated') needed.splice(1, 0, 'GEMINI_API_KEY');

  for (const name of needed) {
    if (process.env[name]) ok(`${name} presente`);
    else bad(`${name} mancante — copia .env.example in .env e compilalo`);
  }
  ok(`Modalità: ${config.product.source} (is_aigc: ${config.tiktok.isAigc})`);
  ok(`Modello testo: ${config.anthropic.model}`);
  if (config.product.source === 'generated') {
    ok(`Modello immagine: ${config.gemini.model} (${config.gemini.imageSize}, ${config.gemini.aspectRatio})`);
  } else {
    ok('Nessuna immagine generata: si pubblicano le foto in reference/');
  }
  ok(`Redirect URI: ${config.tiktok.redirectUri}`);
}

async function checkFfmpeg() {
  section('2. ffmpeg (montaggio del video)');
  try {
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-version']);
    ok(`ffmpeg utilizzabile (${config.slideshow.ffmpegPath})`);
  } catch (err) {
    bad(err.message);
  }
}

async function checkReferences() {
  if (config.product.source === 'reference') {
    section('3. Le tue foto (è da qui che escono i post)');
    try {
      const photos = await listPhotos();
      ok(`${photos.length} foto: ${photos.map((file) => path.basename(file)).join(', ')}`);
      const next = await pickPhoto();
      ok(`prossima: ${next.fileName}${next.reused ? ' (giro ricominciato: già pubblicata)' : ''}`);
      const history = await readHistory();
      const usate = new Set(history.filter((entry) => entry.photo).map((entry) => entry.photo));
      const rimaste = photos.filter((file) => !usate.has(path.basename(file))).length;
      if (rimaste === 0) warn('tutte già pubblicate: il giro riparte dalla meno recente');
      else ok(`${rimaste} mai pubblicate: ${rimaste} giorni prima di ripetersi`);
    } catch (err) {
      bad(err.message);
    }
    return;
  }

  section('3. Foto di riferimento (guidano la generazione)');
  try {
    const references = await listReferences();
    ok(`${references.length} riferimenti: ${references.map((file) => path.basename(file)).join(', ')}`);
    if (references.length < config.gemini.maxReferenceImages) {
      warn(
        `il modello ne accetta fino a ${config.gemini.maxReferenceImages}: più foto tue = borse più simili alle tue`
      );
    }
  } catch (err) {
    bad(err.message);
  }
}

async function checkTokens() {
  section('4. Token TikTok');
  let tokens;
  try {
    tokens = await loadTokens();
  } catch (err) {
    bad(err.message);
    return null;
  }

  ok(`token caricati (open_id: ${tokens.open_id ?? 'non salvato'})`);

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
  section('5. Chiamata reale a TikTok (creator_info, nessuna pubblicazione)');
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

async function checkHistory() {
  section('6. Storico');
  try {
    const history = await readHistory();
    if (history.length === 0) {
      warn(`storico vuoto (${config.paths.historyFile}): il primo post è ancora da fare`);
      return;
    }
    const recent = await recentNames(5);
    ok(`${history.length} post nello storico`);
    ok(`ultimi modelli: ${recent.join(', ')}`);
    ok(`is_aigc: ${config.tiktok.isAigc ? 'sì (dichiarato)' : 'NO'}`);
  } catch (err) {
    bad(err.message);
  }
}

async function main() {
  console.log('Controllo della configurazione (niente viene generato né pubblicato)');
  await checkEnv();
  await checkFfmpeg();
  await checkReferences();
  const tokens = await checkTokens();
  if (tokens) {
    await checkApi();
  } else {
    section('5. Chiamata reale a TikTok');
    warn('saltata: prima esegui "npm run auth"');
  }
  await checkHistory();

  console.log(
    failed
      ? '\nCi sono problemi da sistemare (vedi le righe FAIL).'
      : '\nTutto a posto. Prova "npm run post -- --dry-run": genera immagine, video e caption senza pubblicare.'
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nErrore inatteso: ${err.message}`);
  process.exit(1);
});
