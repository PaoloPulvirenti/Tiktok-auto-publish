import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { tmpDir, rejects } from './helpers.js';
import { listPhotos, mimeTypeFor, pickPhoto } from '../src/photos.js';

let workDir;
const original = { referenceDir: config.paths.referenceDir, historyFile: config.paths.historyFile, reuse: config.product.reusePhotos };

beforeEach(async () => {
  workDir = await tmpDir();
  config.paths.referenceDir = path.join(workDir, 'reference');
  config.paths.historyFile = path.join(workDir, 'history.jsonl');
  await fs.mkdir(config.paths.referenceDir, { recursive: true });
});

afterEach(async () => {
  config.paths.referenceDir = original.referenceDir;
  config.paths.historyFile = original.historyFile;
  config.product.reusePhotos = original.reuse;
  await fs.rm(workDir, { recursive: true, force: true });
});

const photo = (name) => fs.writeFile(path.join(config.paths.referenceDir, name), 'bytes');
const history = (entries) =>
  fs.writeFile(config.paths.historyFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

describe('mimeTypeFor', () => {
  test('riconosce i formati ammessi, estensione maiuscola inclusa', () => {
    assert.equal(mimeTypeFor('a.jpg'), 'image/jpeg');
    assert.equal(mimeTypeFor('a.JPEG'), 'image/jpeg');
    assert.equal(mimeTypeFor('a.png'), 'image/png');
    assert.equal(mimeTypeFor('a.webp'), 'image/webp');
  });

  test('rifiuta un formato che l\'API non accetta', () => {
    assert.throws(() => mimeTypeFor('a.heic'), /non supportato/);
  });
});

describe('listPhotos', () => {
  test('ordina e ignora i file non immagine', async () => {
    await photo('b.jpg');
    await photo('a.png');
    await photo('note.txt');
    await photo('.DS_Store');
    assert.deepEqual((await listPhotos()).map((f) => path.basename(f)), ['a.png', 'b.jpg']);
  });
});

describe('pickPhoto', () => {
  test('senza storico prende la prima in ordine', async () => {
    await photo('a.jpg');
    await photo('b.jpg');
    const scelta = await pickPhoto();
    assert.equal(scelta.fileName, 'a.jpg');
    assert.equal(scelta.reused, false);
    assert.equal(scelta.mimeType, 'image/jpeg');
  });

  test('salta le foto già pubblicate', async () => {
    await photo('a.jpg');
    await photo('b.jpg');
    await photo('c.jpg');
    await history([{ photo: 'a.jpg' }, { photo: 'b.jpg' }]);
    assert.equal((await pickPhoto()).fileName, 'c.jpg');
  });

  test('quando sono tutte usate riparte dalla meno recente', async () => {
    await photo('a.jpg');
    await photo('b.jpg');
    // b pubblicata per ultima: tocca ad a
    await history([{ photo: 'a.jpg' }, { photo: 'b.jpg' }]);
    const scelta = await pickPhoto();
    assert.equal(scelta.fileName, 'a.jpg');
    assert.equal(scelta.reused, true);
  });

  test('con reusePhotos disattivato si ferma invece di ripetersi', async () => {
    config.product.reusePhotos = false;
    await photo('a.jpg');
    await history([{ photo: 'a.jpg' }]);
    const err = await rejects(() => pickPhoto());
    assert.match(err.message, /già state pubblicate/);
  });

  test('lo storico della modalità generated non blocca le foto', async () => {
    await photo('a.jpg');
    // voci senza campo photo: sono post generati, non consumano foto
    await history([{ name: 'Borsa inventata', imagePrompt: 'x' }]);
    assert.equal((await pickPhoto()).reused, false);
  });

  test('errore parlante se la cartella è vuota', async () => {
    const err = await rejects(() => pickPhoto());
    assert.match(err.message, /Nessuna foto/);
  });
});
