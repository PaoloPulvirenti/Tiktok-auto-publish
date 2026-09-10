import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { mockFetch, json, rejects } from './helpers.js';
import { generateCaption, generateIdea, parseIdeaJson } from '../src/anthropic.js';

process.env.ANTHROPIC_API_KEY = 'sk-test';

let active;
afterEach(() => {
  active?.restore();
  active = undefined;
});

const reply = (text) => json({ type: 'message', content: [{ type: 'text', text }] });

const IDEA = {
  name: 'Sacca Granny Sole',
  description: 'Sacca a granny square in cotone giallo con frange',
  imagePrompt: 'product photo of a crochet granny square bag, natural light',
};

const idea = (payload = IDEA) => reply(JSON.stringify(payload));

describe('parseIdeaJson', () => {
  test('legge il JSON nudo', () => {
    assert.deepEqual(parseIdeaJson(JSON.stringify(IDEA)), IDEA);
  });

  test('legge il JSON avvolto in un blocco di codice', () => {
    assert.deepEqual(parseIdeaJson(`\`\`\`json\n${JSON.stringify(IDEA)}\n\`\`\``), IDEA);
  });

  test('legge il JSON con del testo attorno', () => {
    assert.deepEqual(parseIdeaJson(`Ecco l'idea:\n${JSON.stringify(IDEA)}\nSpero vada bene.`), IDEA);
  });

  test('ripulisce gli spazi nei campi', () => {
    const parsed = parseIdeaJson(JSON.stringify({ ...IDEA, name: '  Sacca  ' }));
    assert.equal(parsed.name, 'Sacca');
  });

  test('errore se non è JSON', () => {
    assert.throws(() => parseIdeaJson('Mi dispiace, non posso.'), /non è un JSON valido/);
  });

  test('errore se manca un campo', () => {
    assert.throws(() => parseIdeaJson(JSON.stringify({ name: 'x', description: 'y' })), /imagePrompt/);
  });

  test('errore se un campo è vuoto', () => {
    assert.throws(() => parseIdeaJson(JSON.stringify({ ...IDEA, imagePrompt: '  ' })), /imagePrompt/);
  });
});

describe('generateIdea', () => {
  test('manda header e body previsti dall\'API Messages', async () => {
    active = mockFetch(() => idea());
    await generateIdea([]);

    const [call] = active.calls;
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.headers['x-api-key'], 'sk-test');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');

    const body = JSON.parse(call.body);
    assert.equal(body.model, config.anthropic.model);
    assert.ok(body.max_tokens > 0);
    assert.match(body.system, /JSON/);
    assert.match(body.messages[0].content, /uncinetto/i);
  });

  test('passa al modello i nomi già pubblicati, per non ripetersi', async () => {
    active = mockFetch(() => idea());
    await generateIdea(['Borsa Mare', 'Sacca Rafia']);

    const body = JSON.parse(active.calls[0].body);
    assert.match(body.messages[0].content, /Borsa Mare/);
    assert.match(body.messages[0].content, /Sacca Rafia/);
    assert.match(body.messages[0].content, /NON riproporre/);
  });

  test('senza storico non inventa una lista vuota nel prompt', async () => {
    active = mockFetch(() => idea());
    await generateIdea([]);
    assert.doesNotMatch(JSON.parse(active.calls[0].body).messages[0].content, /riproporre/);
  });

  test('errore parlante se il modello non risponde in JSON', async () => {
    active = mockFetch(() => reply('Certo! Ecco una bella borsa.'));
    const err = await rejects(() => generateIdea([]));
    assert.match(err.message, /non è un JSON valido/);
  });
});

describe('generateCaption', () => {
  test('mette nel prompt la borsa del giorno e la call to action', async () => {
    active = mockFetch(() => reply('Sacca gialla su ordinazione ✨ #uncinetto'));
    await generateCaption(IDEA);

    const body = JSON.parse(active.calls[0].body);
    assert.match(body.messages[0].content, /Sacca Granny Sole/);
    assert.match(body.messages[0].content, /granny square in cotone giallo/);
    assert.match(body.messages[0].content, /DM/);
    assert.match(body.system, /SU ORDINAZIONE/);
  });

  test('toglie le virgolette con cui il modello a volte avvolge la caption', async () => {
    active = mockFetch(() => reply('"Su ordinazione #uncinetto"'));
    assert.equal(await generateCaption(IDEA), 'Su ordinazione #uncinetto');
  });

  test('toglie anche le virgolette tipografiche e le caporali', async () => {
    active = mockFetch(() => reply('«Caption tra caporali»'));
    assert.equal(await generateCaption(IDEA), 'Caption tra caporali');
  });

  test('appiattisce le righe multiple in una caption sola', async () => {
    active = mockFetch(() => reply('Prima riga\n\nSeconda riga #tag'));
    assert.equal(await generateCaption(IDEA), 'Prima riga Seconda riga #tag');
  });

  test('tronca oltre il limite di caratteri configurato', async () => {
    active = mockFetch(() => reply('x'.repeat(400)));
    const caption = await generateCaption(IDEA);
    assert.equal(caption.length, config.caption.maxLength);
    assert.ok(caption.endsWith('…'));
  });

  test('lascia intatta una caption già nei limiti', async () => {
    const text = 'Sacca a granny square, su ordinazione 🧶 #uncinetto #handmade';
    active = mockFetch(() => reply(text));
    assert.equal(await generateCaption(IDEA), text);
  });
});

describe('errori comuni alle due chiamate', () => {
  test('errore parlante su chiave non valida', async () => {
    active = mockFetch(() =>
      json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)
    );
    const err = await rejects(() => generateCaption(IDEA));
    assert.match(err.message, /401/);
    assert.match(err.message, /invalid x-api-key/);
  });

  test('errore se la risposta non contiene testo', async () => {
    active = mockFetch(() => json({ type: 'message', content: [] }));
    const err = await rejects(() => generateCaption(IDEA));
    assert.match(err.message, /nessun testo/);
  });

  test('errore se la rete è giù', async () => {
    active = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await rejects(() => generateIdea([]));
    assert.match(err.message, /rete fallita/);
  });

  test('errore se manca la API key', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const err = await rejects(() => generateCaption(IDEA));
      assert.match(err.message, /ANTHROPIC_API_KEY/);
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
