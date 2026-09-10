/**
 * Modalità 'reference': pubblica a rotazione le TUE foto in reference/,
 * invece di generare l'immagine con Gemini.
 *
 * La rotazione si basa sullo storico: prima le foto mai pubblicate, poi — se
 * config.product.reusePhotos è attivo — quella pubblicata più tempo fa.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { readHistory } from './state.js';

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function mimeTypeFor(filePath) {
  const mimeType = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  if (!mimeType) {
    throw new Error(
      `Formato non supportato: ${path.basename(filePath)}. ` +
        `Ammessi: ${Object.keys(MIME_BY_EXT).join(', ')}.`
    );
  }
  return mimeType;
}

/** Tutte le foto disponibili, in ordine alfabetico. */
export async function listPhotos(dir = config.paths.referenceDir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      throw new Error(`La cartella delle foto non esiste: ${dir}. Creala e mettici le tue foto.`);
    }
    throw cause;
  }

  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .filter((entry) => config.gemini.referenceExtensions.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Sceglie la foto del giorno.
 * @returns {Promise<{ filePath: string, fileName: string, mimeType: string, reused: boolean }>}
 */
export async function pickPhoto({ dir, historyFile } = {}) {
  const photos = await listPhotos(dir);
  if (photos.length === 0) {
    throw new Error(
      `Nessuna foto in ${dir ?? config.paths.referenceDir}. ` +
        'In modalità reference è da lì che esce il post: mettici almeno una foto.'
    );
  }

  const history = await readHistory(historyFile);
  // Ultima pubblicazione per ogni foto: l'ordine dello storico è cronologico.
  const lastUsed = new Map();
  history.forEach((entry, index) => {
    if (entry.photo) lastUsed.set(entry.photo, index);
  });

  const mai = photos.filter((filePath) => !lastUsed.has(path.basename(filePath)));
  if (mai.length > 0) {
    const filePath = mai[0];
    return { filePath, fileName: path.basename(filePath), mimeType: mimeTypeFor(filePath), reused: false };
  }

  if (!config.product.reusePhotos) {
    throw new Error(
      `Tutte le ${photos.length} foto in ${dir ?? config.paths.referenceDir} sono già state pubblicate. ` +
        'Aggiungine altre, oppure metti config.product.reusePhotos a true per ricominciare il giro.'
    );
  }

  // Tutte usate: riparte da quella pubblicata più tempo fa.
  const filePath = photos.reduce((meno, corrente) =>
    lastUsed.get(path.basename(corrente)) < lastUsed.get(path.basename(meno)) ? corrente : meno
  );
  return { filePath, fileName: path.basename(filePath), mimeType: mimeTypeFor(filePath), reused: true };
}
