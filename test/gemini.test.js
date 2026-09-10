import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { mockFetch, json, tmpDir, rejects } from './helpers.js';
import { extractImage, generateImage, listReferences } from '../src/gemini.js';

process.env.GEMINI_API_KEY = 'AIza-test';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageReply = (buffer = PNG) => json({ output_image: { data: buffer.toString('base64') } });

let active;
let workDir;
const originalRefDir = config.paths.referenceDir;

beforeEach(async () => {
  workDir = await tmpDir();
  config.paths.referenceDir = path.join(workDir, 'reference');
  await fs.mkdir(config.paths.referenceDir, { recursive: true });
});

afterEach(async () => {
  active?.restore();
  active = undefined;
  config.paths.referenceDir = originalRefDir;
  await fs.rm(workDir, { recursive: true, force: true });
});

const refFile = (name, content = PNG) =>
  fs.writeFile(path.join(config.paths.referenceDir, name), content);

describe('listReferences', () => {
  test('prende le foto più recenti, fino al massimo configurato', async () => {
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']) {
      await refFile(name);
    }
    const old = path.join(config.paths.referenceDir, 'd.jpg');
    await fs.utimes(old, new Date(2020, 0, 1), new Date(2020, 0, 1));

    const refs = await listReferences();
    assert.equal(refs.length, config.gemini.maxReferenceImages);
    assert.ok(!refs.includes(old), 'la foto più vecchia viene scartata');
  });

  test('ignora i file non immagine e i nascosti', async () => {
    await refFile('README.md', Buffer.from('testo'));
    await refFile('.DS_Store');
    await refFile('borsa.PNG');
    const refs = await listReferences();
    assert.deepEqual(refs.map((file) => path.basename(file)), ['borsa.PNG']);
  });

  test('errore parlante se la cartella è vuota', async () => {
    const err = await rejects(() => listReferences());
    assert.match(err.message, /Nessuna foto di riferimento/);
  });

  test('errore parlante se la cartella non esiste', async () => {
    const err = await rejects(() => listReferences(path.join(workDir, 'nope')));
    assert.match(err.message, /non esiste/);
  });
});

describe('extractImage', () => {
  test('legge la forma documentata output_image', () => {
    assert.deepEqual(extractImage({ output_image: { data: PNG.toString('base64') } }), PNG);
  });

  test('legge l\'immagine dai blocchi steps[].content[]', () => {
    const payload = {
      id: 'v1_x',
      status: 'completed',
      object: 'interaction',
      steps: [
        { type: 'model_output', content: [{ type: 'image', data: PNG.toString('base64'), mime_type: 'image/png' }] },
      ],
    };
    assert.deepEqual(extractImage(payload), PNG);
  });

  test('con più step tiene l\'ultima immagine prodotta', () => {
    const vecchia = Buffer.from('vecchia');
    const payload = {
      steps: [
        { content: [{ type: 'image', data: vecchia.toString('base64') }] },
        { content: [{ type: 'text', text: 'rifinisco' }, { type: 'image', data: PNG.toString('base64') }] },
      ],
    };
    assert.deepEqual(extractImage(payload), PNG);
  });

  test('non confonde un blocco di testo con un\'immagine', () => {
    const payload = { steps: [{ content: [{ type: 'text', text: 'bloccato dalla policy' }] }] };
    assert.equal(extractImage(payload), null);
  });

  test('legge la forma a lista output[]', () => {
    assert.deepEqual(extractImage({ output: [{ type: 'image', data: PNG.toString('base64') }] }), PNG);
  });

  test('legge la forma inlineData dei generateContent', () => {
    const payload = { candidates: [{ content: { parts: [{ inlineData: { data: PNG.toString('base64') } }] } }] };
    assert.deepEqual(extractImage(payload), PNG);
  });

  test('restituisce null se non c\'è nessuna immagine', () => {
    assert.equal(extractImage({ candidates: [{ content: { parts: [{ text: 'ciao' }] } }] }), null);
  });
});

describe('generateImage', () => {
  test('manda prompt, riferimenti e formato verticale', async () => {
    await refFile('borsa.jpg', Buffer.from('jpeg-bytes'));
    active = mockFetch(() => imageReply());

    const image = await generateImage('crochet bag on a table');
    assert.deepEqual(image, PNG);

    const [call] = active.calls;
    assert.equal(call.url, config.gemini.apiUrl);
    assert.equal(call.headers['x-goog-api-key'], 'AIza-test');

    const body = JSON.parse(call.body);
    assert.equal(body.model, config.gemini.model);
    assert.equal(body.response_format.aspect_ratio, '9:16');
    assert.equal(body.response_format.image_size, config.gemini.imageSize);
    assert.deepEqual(body.input[0], { type: 'text', text: 'crochet bag on a table' });
    assert.equal(body.input[1].type, 'image');
    assert.equal(body.input[1].mime_type, 'image/jpeg');
    assert.equal(Buffer.from(body.input[1].data, 'base64').toString(), 'jpeg-bytes');
  });

  test('allega tutte le foto di riferimento passate', async () => {
    await refFile('a.jpg');
    await refFile('b.png');
    active = mockFetch(() => imageReply());

    await generateImage('prompt');
    const body = JSON.parse(active.calls[0].body);
    const mimes = body.input.slice(1).map((part) => part.mime_type).sort();
    assert.deepEqual(mimes, ['image/jpeg', 'image/png']);
  });

  test('errore parlante su HTTP di errore', async () => {
    await refFile('a.jpg');
    active = mockFetch(() => json({ error: { code: 429, message: 'quota esaurita' } }, 429));
    const err = await rejects(() => generateImage('p'));
    assert.match(err.message, /429/);
    assert.match(err.message, /quota esaurita/);
  });

  test('un HTTP 200 senza immagine è un fallimento, col motivo', async () => {
    await refFile('a.jpg');
    active = mockFetch(() => json({ finish_reason: 'SAFETY' }));
    const err = await rejects(() => generateImage('p'));
    assert.match(err.message, /nessuna immagine/);
    assert.match(err.message, /SAFETY/);
  });

  test('errore se la risposta non è JSON', async () => {
    await refFile('a.jpg');
    active = mockFetch(() => new Response('<html>errore</html>', { status: 200 }));
    const err = await rejects(() => generateImage('p'));
    assert.match(err.message, /non JSON/);
  });

  test('errore se la rete è giù', async () => {
    await refFile('a.jpg');
    active = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await rejects(() => generateImage('p'));
    assert.match(err.message, /rete fallita/);
  });

  test('errore se manca la API key, prima di leggere i file', async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const err = await rejects(() => generateImage('p'));
      assert.match(err.message, /GEMINI_API_KEY/);
    } finally {
      process.env.GEMINI_API_KEY = saved;
    }
  });
});
