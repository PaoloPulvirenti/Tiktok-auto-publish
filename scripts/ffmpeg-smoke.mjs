#!/usr/bin/env node
/**
 * Verifica che il comando ffmpeg costruito da src/slideshow.js produca davvero
 * un mp4 verticale della durata giusta.
 *
 * Gira in CI (dove ffmpeg è preinstallato) e in locale se hai ffmpeg:
 *   node scripts/ffmpeg-smoke.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { renderSlideshow, runFfmpeg } from '../src/slideshow.js';

const run = promisify(execFile);

// ffprobe sta accanto a ffmpeg: se hai indicato FFMPEG_PATH usiamo quella cartella,
// così lo script gira anche con un ffmpeg fuori dal PATH.
const ffprobePath =
  process.env.FFPROBE_PATH ||
  (process.env.FFMPEG_PATH
    ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe')
    : 'ffprobe');

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdp-smoke-'));
config.paths.outputDir = path.join(workDir, 'output');

try {
  // Immagine di prova generata da ffmpeg stesso: niente asset binari nel repo.
  const imagePath = path.join(workDir, 'testsrc.png');
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=1200x1600:rate=1',
    '-frames:v', '1', imagePath,
  ]);

  const image = await fs.readFile(imagePath);
  const { videoPath, size } = await renderSlideshow([image], 'smoke');

  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    videoPath,
  ]);
  const probe = JSON.parse(stdout);
  const { width, height } = probe.streams[0];
  const duration = Number(probe.format.duration);

  const problems = [];
  if (width !== config.slideshow.width) problems.push(`larghezza ${width} invece di ${config.slideshow.width}`);
  if (height !== config.slideshow.height) problems.push(`altezza ${height} invece di ${config.slideshow.height}`);
  if (Math.abs(duration - config.slideshow.durationSec) > 0.5) {
    problems.push(`durata ${duration.toFixed(2)}s invece di ~${config.slideshow.durationSec}s`);
  }
  if (size === 0) problems.push('file vuoto');

  if (problems.length) {
    console.error(`Slideshow non conforme: ${problems.join('; ')}`);
    process.exit(1);
  }

  console.log(
    `OK: ${width}x${height}, ${duration.toFixed(2)}s, ${(size / 1024).toFixed(0)} KB ` +
      `(${path.basename(videoPath)})`
  );
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
