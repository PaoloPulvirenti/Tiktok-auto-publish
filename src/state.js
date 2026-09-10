/**
 * Storico dei post: un JSON per riga in history/posted.jsonl.
 *
 * Serve a due cose: non riproporre a Claude modelli già pubblicati, e tenere
 * traccia di quale prompt ha generato quale borsa (utile quando una funziona).
 * Su GitHub Actions il file viene committato a ogni run, perché il filesystem
 * del runner è effimero.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export async function readHistory(filePath = config.paths.historyFile) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // Una riga corrotta non deve far saltare il post di oggi.
        return null;
      }
    })
    .filter(Boolean);
}

/** Nomi dei modelli già pubblicati, dal più recente. */
export async function recentNames(limit = config.product.historyWindow, filePath) {
  const history = await readHistory(filePath);
  return history
    .map((entry) => entry.name)
    .filter((name) => typeof name === 'string' && name.trim())
    .reverse()
    .slice(0, limit);
}

export async function appendEntry(entry, filePath = config.paths.historyFile) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const record = { postedAt: new Date().toISOString(), ...entry };
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`);
  return record;
}
