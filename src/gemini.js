/**
 * Generazione dell'immagine del prodotto con i modelli immagine di Gemini
 * ("Nano Banana"), via API interactions.
 *
 * Le foto in reference/ vengono allegate come immagini di riferimento: sono
 * loro a dare al modello il filato, il punto e la resa reale delle tue borse.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, requireEnv } from '../config.js';

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Elenca le foto di riferimento, dalla più recente. */
export async function listReferences(dir = config.paths.referenceDir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      throw new Error(
        `La cartella dei riferimenti non esiste: ${dir}. Creala e mettici almeno una foto di una tua borsa.`
      );
    }
    throw cause;
  }

  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .filter((entry) =>
      config.gemini.referenceExtensions.includes(path.extname(entry.name).toLowerCase())
    )
    .map((entry) => path.join(dir, entry.name));

  if (files.length === 0) {
    throw new Error(
      `Nessuna foto di riferimento in ${dir}. Mettici almeno una foto di una tua borsa ` +
        `(${config.gemini.referenceExtensions.join(', ')}): senza riferimenti il modello ` +
        'inventa un uncinetto che non è il tuo.'
    );
  }

  const withTimes = await Promise.all(
    files.map(async (filePath) => ({ filePath, mtime: (await fs.stat(filePath)).mtimeMs }))
  );
  withTimes.sort((a, b) => b.mtime - a.mtime || a.filePath.localeCompare(b.filePath));

  return withTimes.slice(0, config.gemini.maxReferenceImages).map((item) => item.filePath);
}

async function toImagePart(filePath) {
  const mimeType = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  if (!mimeType) {
    throw new Error(`Formato non supportato per il riferimento ${path.basename(filePath)}.`);
  }
  const data = await fs.readFile(filePath);
  return { type: 'image', mime_type: mimeType, data: data.toString('base64') };
}

/**
 * Estrae l'immagine dalla risposta.
 * `output_image.data` è la scorciatoia comoda, ma l'immagine sta anche nei
 * blocchi di `steps[].content[]`: se la scorciatoia non c'è la peschiamo da lì,
 * così non perdiamo un'immagine già pagata.
 */
export function extractImage(payload) {
  const direct = payload?.output_image?.data;
  if (typeof direct === 'string' && direct) return Buffer.from(direct, 'base64');

  const isImageBlock = (item) =>
    item?.type === 'image' && typeof item?.data === 'string' && item.data;

  // Forma canonica della Interactions API: l'ultima immagine prodotta vince.
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  const fromSteps = steps
    .flatMap((step) => (Array.isArray(step?.content) ? step.content : []))
    .filter(isImageBlock)
    .pop();
  if (fromSteps) return Buffer.from(fromSteps.data, 'base64');

  const fromOutput = (Array.isArray(payload?.output) ? payload.output : []).find(isImageBlock);
  if (fromOutput) return Buffer.from(fromOutput.data, 'base64');

  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((part) => part?.inlineData?.data || part?.inline_data?.data);
  if (inline) {
    return Buffer.from(inline.inlineData?.data || inline.inline_data.data, 'base64');
  }

  return null;
}

/**
 * Genera l'immagine del prodotto.
 * @param {string} prompt descrizione visiva della borsa
 * @param {string[]} [referencePaths] foto di riferimento (default: reference/)
 * @returns {Promise<Buffer>} i byte dell'immagine (PNG/JPEG secondo il modello)
 */
export async function generateImage(prompt, referencePaths) {
  const apiKey = requireEnv('GEMINI_API_KEY');
  const { apiUrl, model, aspectRatio, imageSize } = config.gemini;

  const references = referencePaths ?? (await listReferences());
  const imageParts = await Promise.all(references.map(toImagePart));

  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [{ type: 'text', text: prompt }, ...imageParts],
        response_format: { type: 'image', aspect_ratio: aspectRatio, image_size: imageSize },
      }),
    });
  } catch (cause) {
    throw new Error(`Gemini: chiamata di rete fallita (${cause.message})`, { cause });
  }

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const detail = payload?.error?.message || text || '(risposta vuota)';
    throw new Error(`Gemini: HTTP ${res.status} ${res.statusText}. ${detail}`);
  }
  if (!payload) {
    throw new Error(`Gemini: risposta non JSON. Risposta: ${text || '(vuota)'}`);
  }
  if (payload.error) {
    throw new Error(
      `Gemini ha restituito l'errore "${payload.error.status || payload.error.code || 'unknown'}": ` +
        `${payload.error.message || 'nessun dettaglio'}`
    );
  }

  const image = extractImage(payload);
  if (!image || image.length === 0) {
    // Il blocco per policy arriva qui: risposta valida, nessuna immagine.
    const reason =
      payload.finish_reason || payload.candidates?.[0]?.finishReason || 'nessun motivo indicato';
    throw new Error(
      `Gemini: nessuna immagine nella risposta (motivo: ${reason}). ` +
        'Se si ripete, il prompt è probabilmente stato bloccato: cambia la descrizione.'
    );
  }
  return image;
}
