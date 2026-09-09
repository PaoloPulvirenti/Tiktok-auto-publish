#!/usr/bin/env node
/**
 * Orchestratore del post giornaliero:
 *   coda -> brief -> caption (Anthropic) -> post TikTok (SELF_ONLY) -> archivio
 *
 *   npm run post
 *   npm run post -- --dry-run   (genera la caption e mostra cosa farebbe, senza pubblicare)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { generateCaption } from './anthropic.js';
import { assertUploadable, buildInitBody, publishVideo } from './tiktok.js';

/** Elenca i video in coda, già ordinati secondo config.video.order. */
export async function listQueue() {
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
export async function readBrief(videoPath) {
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
export async function moveFile(from, to) {
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

export async function archive(videoPath, sidecarPath, caption) {
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

/** Riconosce i flag da riga di comando, rifiutando quelli sconosciuti. */
export function parseArgs(argv) {
  const options = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else {
      throw new Error(`Argomento sconosciuto: ${arg}. Uso: node src/index.js [--dry-run]`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const { dryRun } = parseArgs(argv);
  if (dryRun) console.log('--- DRY RUN: nessuna chiamata a TikTok, niente viene archiviato ---');

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

  if (dryRun) {
    const { size } = await fs.stat(videoPath);
    // Stessa validazione del post vero: un file troppo grande fallisce già qui.
    assertUploadable(size, fileName);
    console.log(`\nBody che verrebbe inviato a video/init:`);
    console.log(JSON.stringify(buildInitBody({ title: caption, videoSize: size }), null, 2));
    console.log(`\nIl video resta in ${config.paths.queueDir}. Nessun post consumato.`);
    return;
  }

  const { publishId, status } = await publishVideo({ filePath: videoPath, title: caption });
  console.log(`Pubblicato: ${status} (publish_id=${publishId})`);

  const archived = await archive(videoPath, sidecar, caption);
  console.log(`Archiviato in: ${archived}`);

  console.log(
    '\nIl video è su TikTok come PRIVATO. Aprilo nell\'app e cambia la visibilità in ' +
      '"Tutti" per renderlo pubblico.'
  );
}

// Esegue solo se lanciato direttamente: importarlo (test inclusi) non pubblica nulla.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nErrore: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  });
}
