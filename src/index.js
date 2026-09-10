#!/usr/bin/env node
/**
 * Orchestratore del post giornaliero:
 *   storico -> idea (Claude) -> immagine (Gemini) -> slideshow (ffmpeg)
 *   -> caption (Claude) -> post TikTok (SELF_ONLY, is_aigc) -> storico
 *
 *   npm run post
 *   npm run post -- --dry-run   (fa tutto tranne la pubblicazione)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { generateCaption, generateIdea } from './anthropic.js';
import { generateImage, listReferences } from './gemini.js';
import { renderSlideshow } from './slideshow.js';
import { appendEntry, recentNames } from './state.js';
import { assertUploadable, buildInitBody, publishVideo } from './tiktok.js';

/** Nome file leggibile: 2026-09-09-borsa-rafia-mare */
export function baseNameFor(idea, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const slug = idea.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug ? `${day}-${slug}` : day;
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

export async function main(argv = process.argv.slice(2), { run } = {}) {
  const { dryRun } = parseArgs(argv);
  if (dryRun) console.log('--- DRY RUN: nessuna chiamata a TikTok, niente viene salvato nello storico ---');

  const references = await listReferences();
  console.log(
    `Riferimenti (${references.length}): ${references.map((file) => path.basename(file)).join(', ')}`
  );

  const recent = await recentNames();
  console.log(`Modelli già pubblicati: ${recent.length}`);

  const idea = await generateIdea(recent);
  console.log(`\nModello di oggi: ${idea.name}`);
  console.log(`  ${idea.description}`);
  console.log(`  prompt: ${idea.imagePrompt}`);

  const count = Math.max(1, config.product.imagesPerPost);
  const images = [];
  for (let index = 0; index < count; index += 1) {
    console.log(`\nGenero l'immagine ${index + 1}/${count} con ${config.gemini.model}...`);
    const image = await generateImage(idea.imagePrompt, references);
    console.log(`  ${(image.length / 1024).toFixed(0)} KB`);
    images.push(image);
  }

  const baseName = baseNameFor(idea);
  console.log('\nMonto il video verticale...');
  const { videoPath, imagePaths, size } = await renderSlideshow(images, baseName, run ? { run } : {});
  console.log(`  ${videoPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  assertUploadable(size, path.basename(videoPath));

  const caption = await generateCaption(idea);
  console.log(`\nCaption (${caption.length} caratteri): ${caption}`);

  if (dryRun) {
    console.log('\nBody che verrebbe inviato a video/init:');
    console.log(JSON.stringify(buildInitBody({ title: caption, videoSize: size }), null, 2));
    console.log(`\nImmagine: ${imagePaths.join(', ')}`);
    console.log(`Video:    ${videoPath}`);
    console.log('Nessun post consumato.');
    return { idea, caption, videoPath, imagePaths, dryRun: true };
  }

  const { publishId, status } = await publishVideo({ filePath: videoPath, title: caption });
  console.log(`Pubblicato: ${status} (publish_id=${publishId})`);

  await appendEntry({
    name: idea.name,
    description: idea.description,
    imagePrompt: idea.imagePrompt,
    caption,
    model: config.gemini.model,
    publishId,
    status,
  });
  console.log(`Storico aggiornato: ${config.paths.historyFile}`);

  console.log(
    '\nIl video è su TikTok come PRIVATO. Aprilo nell\'app e cambia la visibilità in ' +
      '"Tutti" per renderlo pubblico.'
  );
  return { idea, caption, videoPath, imagePaths, publishId, status };
}

// Esegue solo se lanciato direttamente: importarlo (test inclusi) non pubblica nulla.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(`\nErrore: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    // Lasciamo in giro quello che è già stato generato: l'immagine è già pagata.
    await fs.access(config.paths.outputDir).then(
      () => console.error(`Materiale generato (se c'è) in: ${config.paths.outputDir}`),
      () => {}
    );
    process.exit(1);
  });
}
