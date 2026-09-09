import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { mockFetch, json, rejects } from './helpers.js';
import { generateCaption } from '../src/anthropic.js';

process.env.ANTHROPIC_API_KEY = 'sk-test';

let active;
afterEach(() => {
  active?.restore();
  active = undefined;
});

const reply = (text) => json({ type: 'message', content: [{ type: 'text', text }] });

describe('generateCaption', () => {
  test('manda header e body previsti dall\'API Messages', async () => {
    active = mockFetch(() => reply('Caption di prova #test'));
    await generateCaption('Un brief', { fileName: 'clip.mp4' });

    const [call] = active.calls;
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.headers['x-api-key'], 'sk-test');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');

    const body = JSON.parse(call.body);
    assert.equal(body.model, config.anthropic.model);
    assert.equal(body.messages[0].role, 'user');
    assert.match(body.messages[0].content, /Un brief/);
    assert.match(body.messages[0].content, /clip\.mp4/);
    assert.ok(body.max_tokens > 0);
  });

  test('toglie le virgolette con cui il modello a volte avvolge la caption', async () => {
    active = mockFetch(() => reply('"Guarda fino alla fine #fyp"'));
    assert.equal(await generateCaption('b'), 'Guarda fino alla fine #fyp');
  });

  test('toglie anche le virgolette tipografiche e le caporali', async () => {
    active = mockFetch(() => reply('«Caption tra caporali»'));
    assert.equal(await generateCaption('b'), 'Caption tra caporali');
  });

  test('appiattisce le righe multiple in una caption sola', async () => {
    active = mockFetch(() => reply('Prima riga\n\nSeconda riga #tag'));
    assert.equal(await generateCaption('b'), 'Prima riga Seconda riga #tag');
  });

  test('tronca oltre il limite di caratteri configurato', async () => {
    active = mockFetch(() => reply('x'.repeat(400)));
    const caption = await generateCaption('b');
    assert.equal(caption.length, config.caption.maxLength);
    assert.ok(caption.endsWith('…'));
  });

  test('lascia intatta una caption già nei limiti', async () => {
    const text = 'Carbonara in 20 secondi 🍝 #ricette #fyp';
    active = mockFetch(() => reply(text));
    assert.equal(await generateCaption('b'), text);
  });

  test('errore parlante su chiave non valida', async () => {
    active = mockFetch(() =>
      json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)
    );
    const err = await rejects(() => generateCaption('b'));
    assert.match(err.message, /401/);
    assert.match(err.message, /invalid x-api-key/);
  });

  test('errore se la risposta non contiene testo', async () => {
    active = mockFetch(() => json({ type: 'message', content: [] }));
    const err = await rejects(() => generateCaption('b'));
    assert.match(err.message, /nessun testo/);
  });

  test('errore se la rete è giù', async () => {
    active = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await rejects(() => generateCaption('b'));
    assert.match(err.message, /rete fallita/);
  });

  test('errore se manca la API key', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const err = await rejects(() => generateCaption('b'));
      assert.match(err.message, /ANTHROPIC_API_KEY/);
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
