import fs from 'node:fs/promises';
import path from 'node:path';
import { config, requireEnv } from '../config.js';

const { baseUrl } = config.tiktok;

/* -------------------------------------------------------------------------- */
/* Helper HTTP                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Le risposte della Content Posting API hanno forma:
 *   { data: {...}, error: { code: 'ok' | '...', message, log_id } }
 * Un HTTP 200 con error.code !== 'ok' è comunque un fallimento.
 */
function assertApiOk(json, label) {
  const err = json?.error;
  if (err && err.code && err.code !== 'ok') {
    const details = [err.message, err.log_id && `log_id=${err.log_id}`]
      .filter(Boolean)
      .join(' | ');
    throw new Error(`TikTok ${label} ha restituito l'errore "${err.code}": ${details || 'nessun dettaglio'}`);
  }
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** POST JSON autenticato verso la Content Posting API. */
async function apiPost(endpoint, body, accessToken, label) {
  let res;
  try {
    res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(`TikTok ${label}: chiamata di rete fallita (${cause.message})`, { cause });
  }

  const payload = await readBody(res);

  if (!res.ok) {
    const snippet = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(
      `TikTok ${label}: HTTP ${res.status} ${res.statusText}. Risposta: ${snippet || '(vuota)'}`
    );
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`TikTok ${label}: risposta non JSON. Risposta: ${payload || '(vuota)'}`);
  }

  assertApiOk(payload, label);
  return payload.data ?? {};
}

/* -------------------------------------------------------------------------- */
/* Token: storage, scambio, refresh                                           */
/* -------------------------------------------------------------------------- */

export async function loadTokens() {
  let raw;
  try {
    raw = await fs.readFile(config.paths.tokensFile, 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      throw new Error(
        `tokens.json non trovato in ${config.paths.tokensFile}. Esegui prima "npm run auth".`
      );
    }
    throw cause;
  }

  let tokens;
  try {
    tokens = JSON.parse(raw);
  } catch {
    throw new Error(`tokens.json non è un JSON valido (${config.paths.tokensFile}). Rilancia "npm run auth".`);
  }

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('tokens.json è incompleto (manca access_token o refresh_token). Rilancia "npm run auth".');
  }
  return tokens;
}

export async function saveTokens(tokens) {
  await fs.writeFile(config.paths.tokensFile, `${JSON.stringify(tokens, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFile applica `mode` solo alla creazione: forziamo i permessi anche sui
  // file già esistenti (su Windows è un no-op innocuo).
  await fs.chmod(config.paths.tokensFile, 0o600).catch(() => {});
  return tokens;
}

/** Normalizza la risposta di /v2/oauth/token/ nel formato salvato su disco. */
function toStoredTokens(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // access token: ~24h. Salviamo la scadenza assoluta in ms epoch.
    expires_at: Date.now() + Number(data.expires_in || 0) * 1000,
    open_id: data.open_id,
    scope: data.scope,
    obtained_at: new Date().toISOString(),
  };
}

/** Chiamata comune a /v2/oauth/token/ (x-www-form-urlencoded, non JSON). */
async function oauthTokenRequest(params, label) {
  let res;
  try {
    res = await fetch(`${baseUrl}/v2/oauth/token/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // TikTok richiede esplicitamente di non usare la cache su questo endpoint.
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (cause) {
    throw new Error(`TikTok ${label}: chiamata di rete fallita (${cause.message})`, { cause });
  }

  const payload = await readBody(res);

  if (!res.ok) {
    const snippet = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(`TikTok ${label}: HTTP ${res.status} ${res.statusText}. Risposta: ${snippet || '(vuota)'}`);
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`TikTok ${label}: risposta non JSON. Risposta: ${payload || '(vuota)'}`);
  }

  // Su questo endpoint gli errori arrivano come campi top-level, non dentro "error".
  if (payload.error) {
    const description = payload.error_description || payload.message || 'nessun dettaglio';
    throw new Error(
      `TikTok ${label} ha restituito l'errore "${payload.error}": ${description}` +
        (payload.log_id ? ` | log_id=${payload.log_id}` : '')
    );
  }
  if (!payload.access_token) {
    throw new Error(`TikTok ${label}: risposta senza access_token. Risposta: ${JSON.stringify(payload)}`);
  }

  return toStoredTokens(payload);
}

/** Scambia l'authorization code con access + refresh token (usato da auth.js). */
export async function exchangeCodeForTokens(code) {
  return oauthTokenRequest(
    {
      client_key: requireEnv('TIKTOK_CLIENT_KEY'),
      client_secret: requireEnv('TIKTOK_CLIENT_SECRET'),
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.tiktok.redirectUri,
    },
    'scambio del code'
  );
}

export async function refreshTokens(refreshToken) {
  return oauthTokenRequest(
    {
      client_key: requireEnv('TIKTOK_CLIENT_KEY'),
      client_secret: requireEnv('TIKTOK_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    'refresh del token'
  );
}

/**
 * Restituisce un access token valido, rinnovandolo (e ri-salvandolo) se scaduto
 * o prossimo alla scadenza.
 */
export async function getAccessToken() {
  const tokens = await loadTokens();
  const expiresAt = Number(tokens.expires_at || 0);

  if (expiresAt - config.tiktok.tokenRefreshSkewMs > Date.now()) {
    return tokens.access_token;
  }

  console.log('Access token scaduto o in scadenza: refresh in corso...');
  const refreshed = await refreshTokens(tokens.refresh_token);
  await saveTokens(refreshed);
  console.log('Access token rinnovato.');
  return refreshed.access_token;
}

/* -------------------------------------------------------------------------- */
/* Content Posting API — Direct Post                                          */
/* -------------------------------------------------------------------------- */

/**
 * Step 1 — creator_info/query.
 * Serve a validare che l'account possa postare (e a leggere i limiti).
 * NOTA: con app non auditata la risposta elenca comunque PUBLIC_TO_EVERYONE
 * tra le privacy_level_options e torna "successo": è previsto, non è una garanzia.
 */
export async function queryCreatorInfo(accessToken) {
  return apiPost('/v2/post/publish/creator_info/query/', {}, accessToken, 'creator_info/query');
}

/** Body esatto inviato a video/init: usato anche dall'anteprima --dry-run. */
export function buildInitBody({ title, videoSize }) {
  return {
    post_info: {
      title,
      privacy_level: config.tiktok.privacyLevel,
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: videoSize,
      // Upload in un colpo solo: il chunk coincide con l'intero file.
      chunk_size: videoSize,
      total_chunk_count: 1,
    },
  };
}

/**
 * Step 2 — video/init.
 * Riserva la pubblicazione e restituisce { publish_id, upload_url }.
 */
export async function initVideoUpload(accessToken, { title, videoSize }) {
  const data = await apiPost(
    '/v2/post/publish/video/init/',
    buildInitBody({ title, videoSize }),
    accessToken,
    'video/init'
  );

  if (!data.publish_id || !data.upload_url) {
    throw new Error(
      `TikTok video/init: risposta senza publish_id o upload_url. Risposta: ${JSON.stringify(data)}`
    );
  }
  return { publishId: data.publish_id, uploadUrl: data.upload_url };
}

function mimeTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    default:
      return 'video/mp4';
  }
}

/**
 * Step 3 — PUT dei byte all'upload_url.
 * Attenzione: NON impostiamo Content-Length a mano. undici lo calcola dal Buffer
 * e un header duplicato fa fallire la richiesta.
 */
export async function uploadVideoFile(uploadUrl, filePath, buffer) {
  const size = buffer.length;

  let res;
  try {
    res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes 0-${size - 1}/${size}`,
        'Content-Type': mimeTypeFor(filePath),
      },
      body: buffer,
    });
  } catch (cause) {
    throw new Error(`Upload del video fallito (errore di rete): ${cause.message}`, { cause });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Upload del video fallito: HTTP ${res.status} ${res.statusText}. Risposta: ${body || '(vuota)'}`
    );
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Step 4 — polling di status/fetch fino a PUBLISH_COMPLETE (o FAILED / timeout).
 */
export async function waitForPublish(accessToken, publishId) {
  const { statusPollIntervalMs, statusPollTimeoutMs } = config.tiktok;
  const deadline = Date.now() + statusPollTimeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    const data = await apiPost(
      '/v2/post/publish/status/fetch/',
      { publish_id: publishId },
      accessToken,
      'status/fetch'
    );

    const status = data.status;
    if (status !== lastStatus) {
      console.log(`Stato pubblicazione: ${status}`);
      lastStatus = status;
    }

    if (status === 'PUBLISH_COMPLETE') {
      return data;
    }
    if (status === 'FAILED') {
      throw new Error(
        `Pubblicazione fallita (publish_id=${publishId}): ${data.fail_reason || 'nessun motivo fornito da TikTok'}`
      );
    }

    await sleep(statusPollIntervalMs);
  }

  throw new Error(
    `Timeout: la pubblicazione ${publishId} non ha raggiunto PUBLISH_COMPLETE entro ` +
      `${Math.round(statusPollTimeoutMs / 1000)}s (ultimo stato: ${lastStatus || 'sconosciuto'}). ` +
      'Controlla la app TikTok prima di ripubblicare lo stesso video.'
  );
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);

/**
 * Verifica che il file sia caricabile in un unico chunk.
 * Usata sia dal post vero sia dall'anteprima --dry-run.
 */
export function assertUploadable(videoSize, fileName) {
  if (videoSize === 0) {
    throw new Error(`Il file ${fileName} è vuoto (0 byte).`);
  }
  if (videoSize > config.tiktok.maxSingleChunkBytes) {
    throw new Error(
      `Il file ${fileName} pesa ${mb(videoSize)} MB e supera il limite di ` +
        `${mb(config.tiktok.maxSingleChunkBytes)} MB per l'upload in un unico chunk. ` +
        'Comprimi il video: questo tool non implementa (ancora) il chunking.'
    );
  }
}

/**
 * Flusso completo: creator_info -> init -> upload -> polling.
 * Restituisce { publishId, status }.
 */
export async function publishVideo({ filePath, title }) {
  const buffer = await fs.readFile(filePath);
  const videoSize = buffer.length;
  assertUploadable(videoSize, path.basename(filePath));

  const accessToken = await getAccessToken();

  const creatorInfo = await queryCreatorInfo(accessToken);
  const nickname = creatorInfo.creator_nickname || creatorInfo.creator_username || 'account';
  console.log(`Account autorizzato: ${nickname}`);
  if (typeof creatorInfo.max_video_post_duration_sec === 'number') {
    console.log(`Durata massima consentita: ${creatorInfo.max_video_post_duration_sec}s`);
  }

  console.log(`Init upload (${mb(videoSize)} MB)...`);
  const { publishId, uploadUrl } = await initVideoUpload(accessToken, { title, videoSize });

  console.log(`Upload dei byte (publish_id=${publishId})...`);
  await uploadVideoFile(uploadUrl, filePath, buffer);

  console.log('Upload completato, attendo la pubblicazione...');
  const result = await waitForPublish(accessToken, publishId);

  return { publishId, status: result.status };
}
