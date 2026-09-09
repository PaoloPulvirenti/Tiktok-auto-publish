import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { mockFetch, json, apiOk, tmpDir, captureLog, rejects } from './helpers.js';
import {
  assertUploadable,
  buildInitBody,
  getAccessToken,
  initVideoUpload,
  publishVideo,
  saveTokens,
  uploadVideoFile,
  waitForPublish,
} from '../src/tiktok.js';

process.env.TIKTOK_CLIENT_KEY = 'test-key';
process.env.TIKTOK_CLIENT_SECRET = 'test-secret';

let active;
let workDir;
const originalTokensFile = config.paths.tokensFile;
const originalInterval = config.tiktok.statusPollIntervalMs;

beforeEach(async () => {
  workDir = await tmpDir();
  config.paths.tokensFile = path.join(workDir, 'tokens.json');
  config.tiktok.statusPollIntervalMs = 1;
});

afterEach(async () => {
  active?.restore();
  active = undefined;
  config.paths.tokensFile = originalTokensFile;
  config.tiktok.statusPollIntervalMs = originalInterval;
  await fs.rm(workDir, { recursive: true, force: true });
});

const writeTokens = (expiresAt) =>
  fs.writeFile(
    config.paths.tokensFile,
    JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_at: expiresAt, scope: 'video.publish' })
  );

describe('buildInitBody', () => {
  test('rispetta il contratto single-chunk della Content Posting API', () => {
    const body = buildInitBody({ title: 'ciao', videoSize: 1234 });
    assert.deepEqual(body, {
      post_info: {
        title: 'ciao',
        privacy_level: 'SELF_ONLY',
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: 1234,
        chunk_size: 1234,
        total_chunk_count: 1,
      },
    });
  });

  test('chunk_size coincide sempre con video_size', () => {
    const body = buildInitBody({ title: 't', videoSize: 987654 });
    assert.equal(body.source_info.chunk_size, body.source_info.video_size);
    assert.equal(body.source_info.total_chunk_count, 1);
  });
});

describe('assertUploadable', () => {
  test('rifiuta i file vuoti', () => {
    assert.throws(() => assertUploadable(0, 'v.mp4'), /vuoto/);
  });

  test('rifiuta oltre 64 MB spiegando che manca il chunking', () => {
    assert.throws(() => assertUploadable(64 * 1024 * 1024 + 1, 'v.mp4'), /chunking/);
  });

  test('accetta esattamente il limite', () => {
    assert.doesNotThrow(() => assertUploadable(64 * 1024 * 1024, 'v.mp4'));
  });
});

describe('gestione token', () => {
  test('riusa l\'access token quando è ancora valido', async () => {
    await writeTokens(Date.now() + 3600_000);
    active = mockFetch(() => {
      throw new Error('non deve chiamare la rete');
    });
    assert.equal(await getAccessToken(), 'AT');
    assert.equal(active.calls.length, 0);
  });

  test('rinnova e risalva il token scaduto', async () => {
    await writeTokens(Date.now() - 1000);
    active = mockFetch(() =>
      json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400, open_id: 'oid' })
    );

    const token = await captureLog(async () => {
      assert.equal(await getAccessToken(), 'AT2');
    });
    assert.match(token, /refresh in corso/);

    const [call] = active.calls;
    assert.match(call.url, /\/v2\/oauth\/token\/$/);
    assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(call.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'RT');

    // il nuovo refresh token deve finire su disco, o il run successivo fallisce
    const saved = JSON.parse(await fs.readFile(config.paths.tokensFile, 'utf8'));
    assert.equal(saved.refresh_token, 'RT2');
    assert.ok(saved.expires_at > Date.now());
  });

  test('rinnova anche poco prima della scadenza (skew)', async () => {
    await writeTokens(Date.now() + 60_000);
    active = mockFetch(() => json({ access_token: 'AT3', refresh_token: 'RT3', expires_in: 86400 }));
    await captureLog(async () => {
      assert.equal(await getAccessToken(), 'AT3');
    });
    assert.equal(active.calls.length, 1);
  });

  test('errore parlante se tokens.json non esiste', async () => {
    const err = await rejects(() => getAccessToken());
    assert.match(err.message, /npm run auth/);
  });

  test('errore parlante se il refresh token è stato revocato', async () => {
    await writeTokens(0);
    active = mockFetch(() =>
      json({ error: 'invalid_grant', error_description: 'Refresh token is invalid', log_id: 'L9' })
    );
    let err;
    await captureLog(async () => {
      err = await rejects(() => getAccessToken());
    });
    assert.match(err.message, /invalid_grant/);
    assert.match(err.message, /Refresh token is invalid/);
  });

  test('salva tokens.json con permessi 600', async () => {
    await saveTokens({ access_token: 'A', refresh_token: 'R', expires_at: Date.now() });
    const stat = await fs.stat(config.paths.tokensFile);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('video/init', () => {
  test('estrae publish_id e upload_url', async () => {
    active = mockFetch(() => apiOk({ publish_id: 'P1', upload_url: 'https://up.example/1' }));
    const res = await initVideoUpload('AT', { title: 't', videoSize: 10 });
    assert.deepEqual(res, { publishId: 'P1', uploadUrl: 'https://up.example/1' });
    assert.equal(active.calls[0].headers.Authorization, 'Bearer AT');
    assert.match(active.calls[0].headers['Content-Type'], /application\/json/);
  });

  test('HTTP 200 con error.code diverso da ok è comunque un fallimento', async () => {
    active = mockFetch(() =>
      json({ data: {}, error: { code: 'spam_risk_too_many_posts', message: 'limite', log_id: 'L1' } })
    );
    const err = await rejects(() => initVideoUpload('AT', { title: 't', videoSize: 10 }));
    assert.match(err.message, /spam_risk_too_many_posts/);
    assert.match(err.message, /log_id=L1/);
  });

  test('errore se manca upload_url', async () => {
    active = mockFetch(() => apiOk({ publish_id: 'P1' }));
    const err = await rejects(() => initVideoUpload('AT', { title: 't', videoSize: 10 }));
    assert.match(err.message, /upload_url/);
  });

  test('risposta HTML/non-JSON non esplode con SyntaxError', async () => {
    active = mockFetch(() => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }));
    const err = await rejects(() => initVideoUpload('AT', { title: 't', videoSize: 10 }));
    assert.match(err.message, /HTTP 502/);
  });
});

describe('upload dei byte', () => {
  test('manda Content-Range corretto e NON imposta Content-Length', async () => {
    active = mockFetch(() => new Response('', { status: 201 }));
    const buffer = Buffer.alloc(2048, 7);
    await uploadVideoFile('https://up.example/1', 'clip.mp4', buffer);

    const [call] = active.calls;
    assert.equal(call.method, 'PUT');
    assert.equal(call.headers['Content-Range'], 'bytes 0-2047/2048');
    assert.equal(call.headers['Content-Type'], 'video/mp4');
    // header duplicato = errore undici: deve restare a undici calcolarlo
    const headerNames = Object.keys(call.headers).map((h) => h.toLowerCase());
    assert.ok(!headerNames.includes('content-length'));
    assert.ok(Buffer.isBuffer(call.body));
  });

  test('usa il MIME giusto per .mov', async () => {
    active = mockFetch(() => new Response('', { status: 201 }));
    await uploadVideoFile('https://up.example/1', 'clip.mov', Buffer.alloc(4));
    assert.equal(active.calls[0].headers['Content-Type'], 'video/quicktime');
  });

  test('errore parlante se l\'upload viene rifiutato', async () => {
    active = mockFetch(() => new Response('too large', { status: 413, statusText: 'Payload Too Large' }));
    const err = await rejects(() => uploadVideoFile('https://up.example/1', 'c.mp4', Buffer.alloc(4)));
    assert.match(err.message, /HTTP 413/);
    assert.match(err.message, /too large/);
  });
});

describe('polling di status/fetch', () => {
  test('attende finché non arriva PUBLISH_COMPLETE', async () => {
    const statuses = ['PROCESSING_UPLOAD', 'PROCESSING_UPLOAD', 'PUBLISH_COMPLETE'];
    active = mockFetch((_url, _init, n) => apiOk({ status: statuses[n - 1] }));
    const out = await captureLog(async () => {
      const res = await waitForPublish('AT', 'P1');
      assert.equal(res.status, 'PUBLISH_COMPLETE');
    });
    assert.equal(active.calls.length, 3);
    // lo stato invariato non viene ristampato a ogni giro
    assert.equal(out.match(/PROCESSING_UPLOAD/g).length, 1);
  });

  test('FAILED riporta il motivo di TikTok', async () => {
    active = mockFetch(() => apiOk({ status: 'FAILED', fail_reason: 'video_format_check_failed' }));
    const err = await rejects(() => waitForPublish('AT', 'P1'));
    assert.match(err.message, /video_format_check_failed/);
    assert.match(err.message, /P1/);
  });

  test('il timeout avvisa di controllare l\'app prima di ripubblicare', async () => {
    config.tiktok.statusPollTimeoutMs = 5;
    try {
      active = mockFetch(() => apiOk({ status: 'PROCESSING_UPLOAD' }));
      let err;
      await captureLog(async () => {
        err = await rejects(() => waitForPublish('AT', 'P1'));
      });
      assert.match(err.message, /Timeout/);
      assert.match(err.message, /prima di ripubblicare/);
    } finally {
      config.tiktok.statusPollTimeoutMs = 10 * 60 * 1000;
    }
  });
});

describe('publishVideo (flusso completo)', () => {
  test('esegue creator_info -> init -> upload -> status nell\'ordine giusto', async () => {
    await writeTokens(Date.now() + 3600_000);
    const videoPath = path.join(workDir, 'clip.mp4');
    await fs.writeFile(videoPath, Buffer.alloc(1024, 1));

    active = mockFetch((url) => {
      if (url.includes('creator_info')) return apiOk({ creator_nickname: 'paolo', privacy_level_options: ['SELF_ONLY'] });
      if (url.includes('video/init')) return apiOk({ publish_id: 'P9', upload_url: 'https://up.example/9' });
      if (url.startsWith('https://up.example/')) return new Response('', { status: 201 });
      if (url.includes('status/fetch')) return apiOk({ status: 'PUBLISH_COMPLETE' });
      throw new Error(`URL non atteso: ${url}`);
    });

    await captureLog(async () => {
      const res = await publishVideo({ filePath: videoPath, title: 'la mia caption' });
      assert.deepEqual(res, { publishId: 'P9', status: 'PUBLISH_COMPLETE' });
    });

    assert.deepEqual(
      active.calls.map((c) => c.url.replace('https://open.tiktokapis.com', '')),
      [
        '/v2/post/publish/creator_info/query/',
        '/v2/post/publish/video/init/',
        'https://up.example/9',
        '/v2/post/publish/status/fetch/',
      ]
    );
    const initBody = JSON.parse(active.calls[1].body);
    assert.equal(initBody.post_info.title, 'la mia caption');
    assert.equal(initBody.post_info.privacy_level, 'SELF_ONLY');
    assert.equal(initBody.source_info.video_size, 1024);
  });

  test('file troppo grande: si ferma prima di toccare i token', async () => {
    const videoPath = path.join(workDir, 'big.mp4');
    await fs.writeFile(videoPath, Buffer.alloc(config.tiktok.maxSingleChunkBytes + 1));
    active = mockFetch(() => {
      throw new Error('non deve chiamare la rete');
    });
    const err = await rejects(() => publishVideo({ filePath: videoPath, title: 't' }));
    assert.match(err.message, /supera il limite/);
    assert.equal(active.calls.length, 0);
  });
});
