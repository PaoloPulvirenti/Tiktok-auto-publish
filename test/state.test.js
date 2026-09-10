import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { tmpDir } from './helpers.js';
import { appendEntry, readHistory, recentNames } from '../src/state.js';

let workDir;
const originalHistoryFile = config.paths.historyFile;

beforeEach(async () => {
  workDir = await tmpDir();
  config.paths.historyFile = path.join(workDir, 'history', 'posted.jsonl');
});

afterEach(async () => {
  config.paths.historyFile = originalHistoryFile;
  await fs.rm(workDir, { recursive: true, force: true });
});

const writeHistory = async (lines) => {
  await fs.mkdir(path.dirname(config.paths.historyFile), { recursive: true });
  await fs.writeFile(config.paths.historyFile, lines.join('\n'));
};

describe('readHistory', () => {
  test('storico assente vale storico vuoto, non un errore', async () => {
    assert.deepEqual(await readHistory(), []);
  });

  test('legge una riga per post', async () => {
    await writeHistory([JSON.stringify({ name: 'A' }), JSON.stringify({ name: 'B' }), '']);
    assert.deepEqual(await readHistory(), [{ name: 'A' }, { name: 'B' }]);
  });

  test('una riga corrotta non fa saltare il post di oggi', async () => {
    await writeHistory([JSON.stringify({ name: 'A' }), '{rotta', JSON.stringify({ name: 'B' })]);
    assert.deepEqual((await readHistory()).map((entry) => entry.name), ['A', 'B']);
  });
});

describe('recentNames', () => {
  test('restituisce i nomi dal più recente', async () => {
    await writeHistory(['A', 'B', 'C'].map((name) => JSON.stringify({ name })));
    assert.deepEqual(await recentNames(), ['C', 'B', 'A']);
  });

  test('rispetta il limite richiesto', async () => {
    await writeHistory(['A', 'B', 'C', 'D'].map((name) => JSON.stringify({ name })));
    assert.deepEqual(await recentNames(2), ['D', 'C']);
  });

  test('salta le voci senza nome', async () => {
    await writeHistory([
      JSON.stringify({ name: 'A' }),
      JSON.stringify({ publishId: 'P' }),
      JSON.stringify({ name: '  ' }),
    ]);
    assert.deepEqual(await recentNames(), ['A']);
  });
});

describe('appendEntry', () => {
  test('crea la cartella e aggiunge la data di pubblicazione', async () => {
    const record = await appendEntry({ name: 'Sacca', publishId: 'P1' });
    assert.equal(record.name, 'Sacca');
    assert.match(record.postedAt, /^\d{4}-\d{2}-\d{2}T/);

    const history = await readHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].publishId, 'P1');
  });

  test('accoda senza riscrivere lo storico', async () => {
    await appendEntry({ name: 'Uno' });
    await appendEntry({ name: 'Due' });
    assert.deepEqual((await readHistory()).map((entry) => entry.name), ['Uno', 'Due']);
  });
});
