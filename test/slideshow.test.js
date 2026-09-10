import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { tmpDir, rejects } from './helpers.js';
import { buildFfmpegArgs, renderSlideshow, runFfmpeg } from '../src/slideshow.js';

let workDir;
const originalOutputDir = config.paths.outputDir;

beforeEach(async () => {
  workDir = await tmpDir();
  config.paths.outputDir = path.join(workDir, 'output');
});

afterEach(async () => {
  config.paths.outputDir = originalOutputDir;
  await fs.rm(workDir, { recursive: true, force: true });
});

/** ffmpeg finto: crea il file di destinazione (l'ultimo argomento). */
const fakeFfmpeg = (calls) => async (args) => {
  calls.push(args);
  await fs.writeFile(args[args.length - 1], Buffer.alloc(2048));
};

describe('buildFfmpegArgs', () => {
  test('una immagine: verticale, durata e zoom dalla config', () => {
    const args = buildFfmpegArgs(['/tmp/a.png'], '/tmp/out.mp4');
    const line = args.join(' ');

    assert.equal(args.at(-1), '/tmp/out.mp4');
    assert.match(line, /-loop 1 -framerate 30 -t 8\.000 -i \/tmp\/a\.png/);
    assert.match(line, /s=1080x1920/);
    assert.match(line, /-pix_fmt yuv420p/);
    assert.match(line, /-movflags \+faststart/);
    // Un solo segmento: l'output del filtro si chiama [v], non [v0].
    assert.match(line, /setsar=1\[v\] -map \[v\]/);
  });

  test('sovracampiona prima dello zoom, per non sfocare', () => {
    const line = buildFfmpegArgs(['/tmp/a.png'], '/tmp/out.mp4').join(' ');
    assert.match(line, /scale=2160:3840:force_original_aspect_ratio=increase/);
    assert.match(line, /crop=2160:3840/);
  });

  test('lo zoom arriva esattamente a zoomTo alla fine del segmento', () => {
    const line = buildFfmpegArgs(['/tmp/a.png'], '/tmp/out.mp4').join(' ');
    const { zoomTo, fps, durationSec } = config.slideshow;
    const frames = Math.round(durationSec * fps);
    const step = (zoomTo - 1) / frames;
    assert.ok(line.includes(`min(1+${step.toFixed(6)}*on,${zoomTo})`), line);
  });

  test('più immagini: si dividono la durata e vengono concatenate', () => {
    const args = buildFfmpegArgs(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'], '/tmp/out.mp4');
    const line = args.join(' ');
    assert.equal((line.match(/-loop 1/g) ?? []).length, 3);
    assert.match(line, /-t 2\.667 -i \/tmp\/a\.png/);
    assert.match(line, /\[v0\]\[v1\]\[v2\]concat=n=3:v=1:a=0\[v\]/);
  });

  test('aggiunge la traccia audio silenziosa', () => {
    const line = buildFfmpegArgs(['/tmp/a.png'], '/tmp/out.mp4').join(' ');
    assert.match(line, /anullsrc=channel_layout=stereo:sample_rate=44100/);
    assert.match(line, /-c:a aac/);
    // L'audio è l'input successivo alle immagini.
    assert.match(line, /-map 1:a/);
  });

  test('senza audio silenzioso non mappa nessuna traccia audio', () => {
    const saved = config.slideshow.silentAudio;
    config.slideshow.silentAudio = false;
    try {
      const line = buildFfmpegArgs(['/tmp/a.png'], '/tmp/out.mp4').join(' ');
      assert.doesNotMatch(line, /anullsrc/);
      assert.doesNotMatch(line, /-c:a/);
    } finally {
      config.slideshow.silentAudio = saved;
    }
  });

  test('errore se non c\'è nessuna immagine', () => {
    assert.throws(() => buildFfmpegArgs([], '/tmp/out.mp4'), /Nessuna immagine/);
  });
});

describe('runFfmpeg', () => {
  test('errore parlante se il binario non esiste', async () => {
    const err = await rejects(() => runFfmpeg(['-version'], path.join(workDir, 'ffmpeg-che-non-esiste')));
    assert.match(err.message, /ffmpeg non trovato/);
    assert.match(err.message, /FFMPEG_PATH/);
  });

  test('errore col codice di uscita e lo stderr del processo', async () => {
    // Usiamo node come finto ffmpeg: è l'unico binario garantito qui.
    const err = await rejects(() =>
      runFfmpeg(['-e', 'console.error("moov atom not found"); process.exit(3)'], process.execPath)
    );
    assert.match(err.message, /codice 3/);
    assert.match(err.message, /moov atom not found/);
  });

  test('risolve se il processo esce con 0', async () => {
    await runFfmpeg(['-e', 'process.exit(0)'], process.execPath);
  });
});

describe('renderSlideshow', () => {
  test('scrive le immagini, monta il video e restituisce i percorsi', async () => {
    const calls = [];
    const result = await renderSlideshow([Buffer.from('img')], '2026-09-09-sacca', {
      run: fakeFfmpeg(calls),
    });

    assert.equal(path.basename(result.videoPath), '2026-09-09-sacca.mp4');
    assert.deepEqual(result.imagePaths.map((file) => path.basename(file)), ['2026-09-09-sacca.png']);
    assert.equal(result.size, 2048);
    assert.equal(await fs.readFile(result.imagePaths[0], 'utf8'), 'img');
    assert.equal(calls.length, 1);
  });

  test('numera le immagini quando sono più di una', async () => {
    const result = await renderSlideshow([Buffer.from('a'), Buffer.from('b')], 'base', {
      run: fakeFfmpeg([]),
    });
    assert.deepEqual(result.imagePaths.map((file) => path.basename(file)), ['base-1.png', 'base-2.png']);
  });

  test('crea la cartella di output se non c\'è', async () => {
    await renderSlideshow([Buffer.from('a')], 'base', { run: fakeFfmpeg([]) });
    assert.ok((await fs.stat(config.paths.outputDir)).isDirectory());
  });

  test('errore se ffmpeg produce un file vuoto', async () => {
    const err = await rejects(() =>
      renderSlideshow([Buffer.from('a')], 'base', {
        run: async (args) => fs.writeFile(args[args.length - 1], ''),
      })
    );
    assert.match(err.message, /file vuoto/);
  });
});
