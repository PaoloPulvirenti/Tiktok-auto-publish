/**
 * Monta le immagini generate in un mp4 verticale con zoom lento (Ken Burns).
 *
 * Il video serve perché la Content Posting API accetta i byte solo per i video
 * (FILE_UPLOAD): i photo post richiedono PULL_FROM_URL da un dominio verificato.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Costruisce gli argomenti di ffmpeg. Pura e testabile: il comando è la parte
 * facile da sbagliare, e non vogliamo scoprirlo in produzione.
 * @param {string[]} imagePaths una o più immagini, in ordine di apparizione
 * @param {string} outPath mp4 di destinazione
 */
export function buildFfmpegArgs(imagePaths, outPath) {
  if (imagePaths.length === 0) {
    throw new Error('Nessuna immagine da montare nel video.');
  }

  const { width, height, fps, durationSec, zoomTo, silentAudio } = config.slideshow;
  const segmentSec = durationSec / imagePaths.length;
  const framesPerSegment = Math.max(1, Math.round(segmentSec * fps));
  // Incremento per frame che porta lo zoom da 1.0 a zoomTo in un segmento.
  const step = (zoomTo - 1) / framesPerSegment;

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  for (const imagePath of imagePaths) {
    args.push('-loop', '1', '-framerate', String(fps), '-t', segmentSec.toFixed(3), '-i', imagePath);
  }
  if (silentAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  // Sovracampioniamo prima dello zoom: zoomare l'immagine a risoluzione finale
  // la sfoca, ingrandire un 2x e poi ridurre no.
  const superWidth = width * 2;
  const superHeight = height * 2;

  const segments = imagePaths.map(
    (_, index) =>
      `[${index}:v]scale=${superWidth}:${superHeight}:force_original_aspect_ratio=increase,` +
      `crop=${superWidth}:${superHeight},` +
      `zoompan=z='min(1+${step.toFixed(6)}*on,${zoomTo})'` +
      `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
      `:d=1:s=${width}x${height}:fps=${fps},setsar=1[v${index}]`
  );

  const concatInputs = imagePaths.map((_, index) => `[v${index}]`).join('');
  const filter =
    imagePaths.length === 1
      ? segments[0].replace(/\[v0\]$/, '[v]')
      : `${segments.join(';')};${concatInputs}concat=n=${imagePaths.length}:v=1:a=0[v]`;

  args.push('-filter_complex', filter, '-map', '[v]');
  if (silentAudio) {
    args.push('-map', `${imagePaths.length}:a`, '-c:a', 'aac', '-b:a', '128k', '-shortest');
  }
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-t', durationSec.toFixed(3),
    outPath
  );

  return args;
}

/** Esegue ffmpeg e risolve quando il file è pronto. */
export function runFfmpeg(args, ffmpegPath = config.slideshow.ffmpegPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      // Con -loglevel error ffmpeg è muto se tutto va bene: non serve troncare
      // più di così, ma non teniamoci in RAM un log impazzito.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (cause) => {
      if (cause.code === 'ENOENT') {
        reject(
          new Error(
            `ffmpeg non trovato (${ffmpegPath}). Installalo — su macOS "brew install ffmpeg", ` +
              'su Windows "winget install Gyan.FFmpeg" — oppure indica il binario con FFMPEG_PATH. ' +
              'Sui runner GitHub è già presente.'
          )
        );
        return;
      }
      reject(cause);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg è uscito con codice ${code}. Errore:\n${stderr.trim() || '(nessun output)'}`));
    });
  });
}

/**
 * Scrive le immagini su disco, le monta e restituisce il percorso dell'mp4.
 * @param {Buffer[]} images
 * @param {string} baseName nome file senza estensione
 * @param {{ run?: (args: string[]) => Promise<void> }} [deps] runner sostituibile nei test
 */
export async function renderSlideshow(images, baseName, { run = runFfmpeg } = {}) {
  await fs.mkdir(config.paths.outputDir, { recursive: true });

  const imagePaths = [];
  for (const [index, image] of images.entries()) {
    const suffix = images.length === 1 ? '' : `-${index + 1}`;
    const imagePath = path.join(config.paths.outputDir, `${baseName}${suffix}.png`);
    await fs.writeFile(imagePath, image);
    imagePaths.push(imagePath);
  }

  const videoPath = path.join(config.paths.outputDir, `${baseName}.mp4`);
  await run(buildFfmpegArgs(imagePaths, videoPath));

  const { size } = await fs.stat(videoPath);
  if (size === 0) {
    throw new Error('ffmpeg ha prodotto un file vuoto.');
  }
  return { videoPath, imagePaths, size };
}
