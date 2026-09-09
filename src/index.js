#!/usr/bin/env node
/**
 * Orchestratore del post giornaliero:
 *   coda -> brief -> caption (Anthropic) -> post TikTok (SELF_ONLY) -> archivio
 *
 *   npm run post
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { generateCaption } from './anthropic.js';
import { publishVideo } from './tiktok.js';

/** Elenca i video in coda, già ordinati secondo config.video.order. */
async function listQueue() {
  let entries;
  try {
    entries = await fs.readdir(config.paths.queueDir, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      throw new Error(`La cartella della coda non esiste: ${config.paths.queueDir}`);
    }
    throw cause;
  }

  const videos = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .filter((entry) => config.video.extensions.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(config.paths.queueDir, entry.name));

  if (config.video.order === 'mtime') {
    const withTimes = await Promise.all(
      videos.map(async (filePath) => ({ filePath, mtime: (await fs.stat(filePath)).mtimeMs }))
    );
    withTimes.sort((a, b) => a.mtime - b.mtime || a.filePath.localeCompare(b.filePath));
    return withTimes.map((item) => item.filePath);
  }

  return videos.sort((a, b) => a.localeCompare(b));
}

/** Legge il brief dal sidecar .txt con lo stesso nome del video, o usa il default. */
async function readBrief(videoPath) {
  const sidecar = videoPath.replace(/\.[^.]+$/, '.txt');
  try {
    const text = (await fs.readFile(sidecar, 'utf8')).trim();
    if (text) {
      return { brief: text, source: path.basename(sidecar), sidecar };
    }
    console.log(`${path.basename(sidecar)} è vuoto: uso il brief di default.`);
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  return { brief: config.defaultBrief, source: 'defaultBrief (config.js)', sidecar };
}

/** Sposta un file gestendo anche i filesystem diversi (EXDEV) e le collisioni. */
async function moveFile(from, to) {
  let target = to;
  try {
    await fs.access(target);
    // Destinazione già occupata: aggiungo un suffisso temporale invece di sovrascrivere.
    const ext = path.extname(target);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    target = `${target.slice(0, target.length - ext.length)}-${stamp}${ext}`;
  } catch {
    // non esiste: ok così
  }

  try {
    await fs.rename(from, target);
  } catch (cause) {
    if (cause.code !== 'EXDEV') throw cause;
    await fs.copyFile(from, target);
    await fs.unlink(from);
  }
  return target;
}

async function archive(videoPath, sidecarPath, caption) {
  await fs.mkdir(config.paths.postedDir, { recursive: true });

  const destination = path.join(config.paths.postedDir, path.basename(videoPath));
  const moved = await moveFile(videoPath, destination);

  // Porto con me anche il brief, se c'era.
  try {
    await fs.access(sidecarPath);
    await moveFile(sidecarPath, path.join(config.paths.postedDir, path.basename(sidecarPath)));
  } catch {
    // nessun sidecar da archiviare
  }

  // Traccia della caption effettivamente usata, accanto al video archiviato.
  const captionFile = `${moved.slice(0, moved.length - path.extname(moved).length)}.caption.txt`;
  await fs.writeFile(captionFile, `${caption}\n`);

  return moved;
}

async function main() {
  const queue = await listQueue();

  if (queue.length === 0) {
    console.log(`Coda vuota (${config.paths.queueDir}): niente da pubblicare oggi.`);
    return;
  }

  const videoPath = queue[0];
  const fileName = path.basename(videoPath);
  console.log(`Video in coda: ${queue.length}. Pubblico: ${fileName}`);

  const { brief, source, sidecar } = await readBrief(videoPath);
  console.log(`Brief da: ${source}`);

  const caption = await generateCaption(brief, { fileName });
  console.log(`Caption (${caption.length} caratteri): ${caption}`);

  const { publishId, status } = await publishVideo({ filePath: videoPath, title: caption });
  console.log(`Pubblicato: ${status} (publish_id=${publishId})`);

  const archived = await archive(videoPath, sidecar, caption);
  console.log(`Archiviato in: ${archived}`);

  console.log(
    '\nIl video è su TikTok come PRIVATO. Aprilo nell\'app e cambia la visibilità in ' +
      '"Tutti" per renderlo pubblico.'
  );
}

main().catch((err) => {
  console.error(`\nErrore: ${err.message}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
