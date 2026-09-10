import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { mockFetch, json, apiOk, tmpDir, captureLog, rejects } from './helpers.js';
import { baseNameFor, main, parseArgs } from '../src/index.js';
import { readHistory } from '../src/state.js';

process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.GEMINI_API_KEY = 'AIza-test';
process.env.TIKTOK_CLIENT_KEY = 'ck';
process.env.TIKTOK_CLIENT_SECRET = 'cs';

const IDEA = {
  name: 'Sacca Granny Sole',
  description: 'Sacca a granny square in cotone giallo con frange',
  imagePrompt: 'product photo of a yellow granny square crochet bag',
};

let active;
let workDir;
const original = {
  referenceDir: config.paths.referenceDir,
  outputDir: config.paths.outputDir,
  historyFile: config.paths.historyFile,
  tokensFile: config.paths.tokensFile,
  interval: config.tiktok.statusPollIntervalMs,
  imagesPerPost: config.product.imagesPerPost,
  maxBytes: config.tiktok.maxSingleChunkBytes,
};

beforeEach(async () => {
  workDir = await tmpDir();
  config.paths.referenceDir = path.join(workDir, 'reference');
  config.paths.outputDir = path.join(workDir, 'output');
  config.paths.historyFile = path.join(workDir, 'history', 'posted.jsonl');
  config.paths.tokensFile = path.join(workDir, 'tokens.json');
  config.tiktok.statusPollIntervalMs = 1;

  await fs.mkdir(config.paths.referenceDir, { recursive: true });
  await fs.writeFile(path.join(config.paths.referenceDir, 'borsa.jpg'), 'jpeg-bytes');
  await fs.writeFile(
    config.paths.tokensFile,
    JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600_000 })
  );
});

afterEach(async () => {
  active?.restore();
  active = undefined;
  Object.assign(config.paths, {
    referenceDir: original.referenceDir,
    outputDir: original.outputDir,
    historyFile: original.historyFile,
    tokensFile: original.tokensFile,
  });
  config.tiktok.statusPollIntervalMs = original.interval;
  config.product.imagesPerPost = original.imagesPerPost;
  config.tiktok.maxSingleChunkBytes = original.maxBytes;
  await fs.rm(workDir, { recursive: true, force: true });
});

/** ffmpeg finto: crea il file di destinazione con una dimensione plausibile. */
const fakeRun = (bytes = 3 * 1024 * 1024) => async (args) =>
  fs.writeFile(args[args.length - 1], Buffer.alloc(bytes));

const claudeReply = (text) => json({ type: 'message', content: [{ type: 'text', text }] });

/**
 * Mock dell'intera catena. Le due chiamate a Claude si distinguono dal system
 * prompt: quella dell'idea chiede un JSON.
 */
const happyPath = ({ caption = 'Sacca gialla su ordinazione 🧶 #uncinetto', idea = IDEA } = {}) =>
  mockFetch((url, init) => {
    if (url.includes('anthropic')) {
      const body = JSON.parse(init.body);
      return /JSON/.test(body.system) ? claudeReply(JSON.stringify(idea)) : claudeReply(caption);
    }
    if (url.includes('generativelanguage')) {
      return json({ output_image: { data: Buffer.from('png-bytes').toString('base64') } });
    }
    if (url.includes('creator_info')) return apiOk({ creator_nickname: 'paolo' });
    if (url.includes('video/init')) return apiOk({ publish_id: 'P1', upload_url: 'https://up.example/1' });
    if (url.startsWith('https://up.example/')) return new Response('', { status: 201 });
    if (url.includes('status/fetch')) return apiOk({ status: 'PUBLISH_COMPLETE' });
    throw new Error(`URL non atteso: ${url}`);
  });

const urlsOf = (calls) =>
  calls.map((call) => {
    if (call.url.includes('anthropic')) return /JSON/.test(JSON.parse(call.body).system) ? 'idea' : 'caption';
    if (call.url.includes('generativelanguage')) return 'immagine';
    if (call.url.includes('creator_info')) return 'creator_info';
    if (call.url.includes('video/init')) return 'init';
    if (call.url.startsWith('https://up.example/')) return 'upload';
    if (call.url.includes('status/fetch')) return 'status';
    return call.url;
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

describe('baseNameFor', () => {
  test('data più slug del nome', () => {
    assert.equal(
      baseNameFor({ name: 'Sacca Granny Sole' }, new Date('2026-09-09T08:00:00Z')),
      '2026-09-09-sacca-granny-sole'
    );
  });

  test('toglie accenti e punteggiatura', () => {
    assert.equal(
      baseNameFor({ name: 'Borsa "Città" à mano!' }, new Date('2026-01-02T00:00:00Z')),
      '2026-01-02-borsa-citta-a-mano'
    );
  });

  test('un nome senza caratteri utili non produce un nome file rotto', () => {
    assert.equal(baseNameFor({ name: '???' }, new Date('2026-01-02T00:00:00Z')), '2026-01-02');
  });
});

describe('main', () => {
  test('esegue la catena nell\'ordine giusto e pubblica', async () => {
    active = happyPath();
    const out = await captureLog(() => main([], { run: fakeRun() }));

    assert.deepEqual(urlsOf(active.calls), [
      'idea',
      'immagine',
      'caption',
      'creator_info',
      'init',
      'upload',
      'status',
    ]);
    assert.match(out, /Modello di oggi: Sacca Granny Sole/);
    assert.match(out, /PUBLISH_COMPLETE/);

    const initBody = JSON.parse(active.calls.find((call) => call.url.includes('video/init')).body);
    assert.equal(initBody.post_info.title, 'Sacca gialla su ordinazione 🧶 #uncinetto');
    assert.equal(initBody.post_info.is_aigc, true);
    assert.equal(initBody.post_info.privacy_level, 'SELF_ONLY');
  });

  test('genera l\'immagine col prompt dell\'idea e le foto di riferimento', async () => {
    active = happyPath();
    await captureLog(() => main([], { run: fakeRun() }));

    const body = JSON.parse(active.calls.find((call) => call.url.includes('generativelanguage')).body);
    assert.equal(body.input[0].text, IDEA.imagePrompt);
    assert.equal(body.input[1].mime_type, 'image/jpeg');
    assert.equal(Buffer.from(body.input[1].data, 'base64').toString(), 'jpeg-bytes');
  });

  test('scrive lo storico, così domani non ripropone la stessa borsa', async () => {
    active = happyPath();
    await captureLog(() => main([], { run: fakeRun() }));

    const history = await readHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].name, IDEA.name);
    assert.equal(history[0].imagePrompt, IDEA.imagePrompt);
    assert.equal(history[0].publishId, 'P1');
    assert.equal(history[0].status, 'PUBLISH_COMPLETE');
    assert.equal(history[0].model, config.gemini.model);
  });

  test('passa a Claude i modelli già in storico', async () => {
    await fs.mkdir(path.dirname(config.paths.historyFile), { recursive: true });
    await fs.writeFile(
      config.paths.historyFile,
      `${JSON.stringify({ name: 'Borsa Mare' })}\n${JSON.stringify({ name: 'Sacca Rafia' })}\n`
    );
    active = happyPath();
    await captureLog(() => main([], { run: fakeRun() }));

    const ideaCall = active.calls.find(
      (call) => call.url.includes('anthropic') && /JSON/.test(JSON.parse(call.body).system)
    );
    const prompt = JSON.parse(ideaCall.body).messages[0].content;
    assert.match(prompt, /Borsa Mare/);
    assert.match(prompt, /Sacca Rafia/);
  });

  test('imagesPerPost=2 genera due immagini', async () => {
    config.product.imagesPerPost = 2;
    active = happyPath();
    await captureLog(() => main([], { run: fakeRun() }));

    const imageCalls = active.calls.filter((call) => call.url.includes('generativelanguage'));
    assert.equal(imageCalls.length, 2);
  });

  test('--dry-run: genera tutto ma non tocca TikTok né lo storico', async () => {
    active = happyPath({ caption: 'Caption in prova #test' });
    const out = await captureLog(() => main(['--dry-run'], { run: fakeRun() }));

    assert.match(out, /DRY RUN/);
    assert.match(out, /Caption in prova #test/);
    assert.match(out, /"privacy_level": "SELF_ONLY"/);
    assert.match(out, /"is_aigc": true/);
    assert.match(out, /"total_chunk_count": 1/);

    assert.deepEqual(urlsOf(active.calls), ['idea', 'immagine', 'caption']);
    assert.deepEqual(await readHistory(), []);
  });

  test('--dry-run lascia su disco immagine e video da guardare', async () => {
    active = happyPath();
    let result;
    await captureLog(async () => {
      result = await main(['--dry-run'], { run: fakeRun() });
    });
    assert.equal(await fs.readFile(result.imagePaths[0], 'utf8'), 'png-bytes');
    assert.ok((await fs.stat(result.videoPath)).size > 0);
  });

  test('senza foto di riferimento si ferma prima di spendere un centesimo', async () => {
    await fs.rm(path.join(config.paths.referenceDir, 'borsa.jpg'));
    active = happyPath();

    const err = await rejects(() => main([], { run: fakeRun() }));
    assert.match(err.message, /Nessuna foto di riferimento/);
    assert.equal(active.calls.length, 0);
  });

  test('un video troppo grande si ferma prima di chiamare TikTok', async () => {
    config.tiktok.maxSingleChunkBytes = 1024;
    active = happyPath();

    let err;
    await captureLog(async () => {
      err = await rejects(() => main([], { run: fakeRun(4096) }));
    });
    assert.match(err.message, /supera il limite/);
    assert.deepEqual(urlsOf(active.calls), ['idea', 'immagine']);
  });

  test('se la pubblicazione fallisce lo storico NON viene toccato', async () => {
    active = mockFetch((url, init) => {
      if (url.includes('anthropic')) {
        const body = JSON.parse(init.body);
        return /JSON/.test(body.system) ? claudeReply(JSON.stringify(IDEA)) : claudeReply('c');
      }
      if (url.includes('generativelanguage')) {
        return json({ output_image: { data: Buffer.from('png').toString('base64') } });
      }
      if (url.includes('creator_info')) return apiOk({ creator_nickname: 'paolo' });
      if (url.includes('video/init')) {
        return json({ data: {}, error: { code: 'spam_risk_too_many_posts', message: 'limite' } });
      }
      throw new Error(`URL non atteso: ${url}`);
    });

    let err;
    await captureLog(async () => {
      err = await rejects(() => main([], { run: fakeRun() }));
    });
    assert.match(err.message, /spam_risk_too_many_posts/);
    // Niente in storico: domani Claude può riproporre questo modello.
    assert.deepEqual(await readHistory(), []);
  });

  test('se Gemini blocca il prompt non si arriva a TikTok', async () => {
    active = mockFetch((url, init) => {
      if (url.includes('anthropic')) {
        const body = JSON.parse(init.body);
        return /JSON/.test(body.system) ? claudeReply(JSON.stringify(IDEA)) : claudeReply('c');
      }
      if (url.includes('generativelanguage')) return json({ finish_reason: 'SAFETY' });
      throw new Error(`URL non atteso: ${url}`);
    });

    let err;
    await captureLog(async () => {
      err = await rejects(() => main([], { run: fakeRun() }));
    });
    assert.match(err.message, /nessuna immagine/);
    assert.deepEqual(await readHistory(), []);
  });
});
