import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { mockFetch, json, apiOk, tmpDir, captureLog, rejects } from './helpers.js';
import { archive, listQueue, main, moveFile, parseArgs, readBrief } from '../src/index.js';

process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.TIKTOK_CLIENT_KEY = 'ck';
process.env.TIKTOK_CLIENT_SECRET = 'cs';

let active;
let workDir;
const original = {
  queueDir: config.paths.queueDir,
  postedDir: config.paths.postedDir,
  tokensFile: config.paths.tokensFile,
  order: config.video.order,
  interval: config.tiktok.statusPollIntervalMs,
};

beforeEach(async () => {
  workDir = await tmpDir();
  config.paths.queueDir = path.join(workDir, 'queue');
  config.paths.postedDir = path.join(workDir, 'posted');
  config.paths.tokensFile = path.join(workDir, 'tokens.json');
  config.tiktok.statusPollIntervalMs = 1;
  await fs.mkdir(config.paths.queueDir, { recursive: true });
  await fs.writeFile(
    config.paths.tokensFile,
    JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600_000 })
  );
});

afterEach(async () => {
  active?.restore();
  active = undefined;
  Object.assign(config.paths, {
    queueDir: original.queueDir,
    postedDir: original.postedDir,
    tokensFile: original.tokensFile,
  });
  config.video.order = original.order;
  config.tiktok.statusPollIntervalMs = original.interval;
  await fs.rm(workDir, { recursive: true, force: true });
});

const queueFile = (name, content = 'video-bytes') =>
  fs.writeFile(path.join(config.paths.queueDir, name), content);

/** Mock del flusso TikTok completo + caption. */
const happyPath = (caption = 'Caption generata #fyp') =>
  mockFetch((url) => {
    if (url.includes('anthropic')) return json({ type: 'message', content: [{ type: 'text', text: caption }] });
    if (url.includes('creator_info')) return apiOk({ creator_nickname: 'paolo' });
    if (url.includes('video/init')) return apiOk({ publish_id: 'P1', upload_url: 'https://up.example/1' });
    if (url.startsWith('https://up.example/')) return new Response('', { status: 201 });
    if (url.includes('status/fetch')) return apiOk({ status: 'PUBLISH_COMPLETE' });
    throw new Error(`URL non atteso: ${url}`);
  });

describe('parseArgs', () => {
  test('senza argomenti non è dry-run', () => {
    assert.deepEqual(parseArgs([]), { dryRun: false });
  });

  test('riconosce --dry-run e -n', () => {
    assert.equal(parseArgs(['--dry-run']).dryRun, true);
    assert.equal(parseArgs(['-n']).dryRun, true);
  });

  test('rifiuta i flag sconosciuti invece di ignorarli', () => {
    assert.throws(() => parseArgs(['--publish-now']), /Argomento sconosciuto/);
  });
});

describe('listQueue', () => {
  test('ordina alfabeticamente e ignora i non-video', async () => {
    await queueFile('2026-09-11.mp4');
    await queueFile('2026-09-10.mp4');
    await queueFile('note.txt');
    await queueFile('.DS_Store');
    const queue = await listQueue();
    assert.deepEqual(queue.map((f) => path.basename(f)), ['2026-09-10.mp4', '2026-09-11.mp4']);
  });

  test('accetta .mov e .webm, maiuscole comprese', async () => {
    await queueFile('a.MOV');
    await queueFile('b.webm');
    assert.equal((await listQueue()).length, 2);
  });

  test('con order=mtime prende prima il file più vecchio', async () => {
    config.video.order = 'mtime';
    await queueFile('zzz.mp4');
    const old = path.join(config.paths.queueDir, 'zzz.mp4');
    await fs.utimes(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    await queueFile('aaa.mp4');
    const queue = await listQueue();
    assert.equal(path.basename(queue[0]), 'zzz.mp4');
  });

  test('coda vuota restituisce array vuoto', async () => {
    assert.deepEqual(await listQueue(), []);
  });

  test('errore parlante se la cartella non esiste', async () => {
    config.paths.queueDir = path.join(workDir, 'inesistente');
    const err = await rejects(() => listQueue());
    assert.match(err.message, /non esiste/);
  });
});

describe('readBrief', () => {
  test('usa il sidecar .txt con lo stesso nome', async () => {
    await queueFile('clip.mp4');
    await queueFile('clip.txt', '  Ricetta carbonara  ');
    const { brief, source } = await readBrief(path.join(config.paths.queueDir, 'clip.mp4'));
    assert.equal(brief, 'Ricetta carbonara');
    assert.equal(source, 'clip.txt');
  });

  test('senza sidecar ricade sul brief di default', async () => {
    await queueFile('clip.mp4');
    const { brief, source } = await readBrief(path.join(config.paths.queueDir, 'clip.mp4'));
    assert.equal(brief, config.defaultBrief);
    assert.match(source, /defaultBrief/);
  });

  test('un sidecar vuoto non produce un brief vuoto', async () => {
    await queueFile('clip.mp4');
    await queueFile('clip.txt', '   \n  ');
    let result;
    const out = await captureLog(async () => {
      result = await readBrief(path.join(config.paths.queueDir, 'clip.mp4'));
    });
    assert.equal(result.brief, config.defaultBrief);
    assert.match(out, /è vuoto/);
  });
});

describe('archiviazione', () => {
  test('non sovrascrive un file già presente in posted', async () => {
    await fs.mkdir(config.paths.postedDir, { recursive: true });
    const existing = path.join(config.paths.postedDir, 'clip.mp4');
    await fs.writeFile(existing, 'vecchio');
    await queueFile('clip.mp4', 'nuovo');

    const moved = await moveFile(path.join(config.paths.queueDir, 'clip.mp4'), existing);
    assert.notEqual(moved, existing);
    assert.equal(await fs.readFile(existing, 'utf8'), 'vecchio');
    assert.equal(await fs.readFile(moved, 'utf8'), 'nuovo');
  });

  test('sposta video, brief e scrive la caption usata', async () => {
    await queueFile('clip.mp4');
    await queueFile('clip.txt', 'brief');
    const videoPath = path.join(config.paths.queueDir, 'clip.mp4');
    const sidecar = path.join(config.paths.queueDir, 'clip.txt');

    await archive(videoPath, sidecar, 'La caption usata');

    const posted = (await fs.readdir(config.paths.postedDir)).sort();
    assert.deepEqual(posted, ['clip.caption.txt', 'clip.mp4', 'clip.txt']);
    assert.equal(
      await fs.readFile(path.join(config.paths.postedDir, 'clip.caption.txt'), 'utf8'),
      'La caption usata\n'
    );
    assert.deepEqual(await fs.readdir(config.paths.queueDir), []);
  });
});

describe('main', () => {
  test('coda vuota: esce senza chiamare nessuna API', async () => {
    active = mockFetch(() => {
      throw new Error('non deve chiamare la rete');
    });
    const out = await captureLog(() => main([]));
    assert.match(out, /Coda vuota/);
    assert.equal(active.calls.length, 0);
  });

  test('pubblica il primo video e lo archivia', async () => {
    await queueFile('2026-09-10.mp4');
    await queueFile('2026-09-11.mp4');
    active = happyPath('Caption del giorno #fyp');

    const out = await captureLog(() => main([]));
    assert.match(out, /Pubblico: 2026-09-10\.mp4/);
    assert.match(out, /PUBLISH_COMPLETE/);

    // solo il primo video viene consumato
    assert.deepEqual(await fs.readdir(config.paths.queueDir), ['2026-09-11.mp4']);
    assert.ok((await fs.readdir(config.paths.postedDir)).includes('2026-09-10.mp4'));

    const initBody = JSON.parse(active.calls.find((c) => c.url.includes('video/init')).body);
    assert.equal(initBody.post_info.title, 'Caption del giorno #fyp');
  });

  test('--dry-run: genera la caption ma non tocca TikTok né la coda', async () => {
    await queueFile('clip.mp4');
    active = happyPath('Caption in prova #test');

    const out = await captureLog(() => main(['--dry-run']));

    assert.match(out, /DRY RUN/);
    assert.match(out, /Caption in prova #test/);
    assert.match(out, /"privacy_level": "SELF_ONLY"/);
    assert.match(out, /"total_chunk_count": 1/);

    // solo Anthropic è stato chiamato
    assert.equal(active.calls.length, 1);
    assert.match(active.calls[0].url, /anthropic/);
    // il video resta in coda, niente archivio
    assert.deepEqual(await fs.readdir(config.paths.queueDir), ['clip.mp4']);
    await assert.rejects(() => fs.readdir(config.paths.postedDir));
  });

  test('--dry-run si ferma comunque su un file troppo grande', async () => {
    await queueFile('big.mp4', Buffer.alloc(config.tiktok.maxSingleChunkBytes + 1));
    active = happyPath();
    let err;
    await captureLog(async () => {
      err = await rejects(() => main(['--dry-run']));
    });
    assert.match(err.message, /supera il limite/);
  });

  test('se la pubblicazione fallisce il video NON viene archiviato', async () => {
    await queueFile('clip.mp4');
    active = mockFetch((url) => {
      if (url.includes('anthropic')) return json({ type: 'message', content: [{ type: 'text', text: 'c' }] });
      if (url.includes('creator_info')) return apiOk({ creator_nickname: 'paolo' });
      if (url.includes('video/init')) return json({ data: {}, error: { code: 'spam_risk_too_many_posts', message: 'limite' } });
      throw new Error(`URL non atteso: ${url}`);
    });

    let err;
    await captureLog(async () => {
      err = await rejects(() => main([]));
    });
    assert.match(err.message, /spam_risk_too_many_posts/);
    // il video resta in coda, così il giorno dopo ci riprova
    assert.deepEqual(await fs.readdir(config.paths.queueDir), ['clip.mp4']);
  });
});
