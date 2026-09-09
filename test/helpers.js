import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Installa un fetch finto; restituisce { calls, restore }. */
export function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body });
    return handler(String(url), init, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

export const apiOk = (data) => json({ data, error: { code: 'ok', message: '', log_id: 'log' } });

export async function tmpDir(prefix = 'tdp-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Cattura console.log durante fn(). */
export async function captureLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

export async function rejects(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('Errore atteso, ma la chiamata è andata a buon fine');
}
