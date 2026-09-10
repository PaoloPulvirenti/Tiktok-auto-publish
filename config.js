import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Da dove arriva l'immagine del post:
 *   'generated' -> Claude inventa il modello, Gemini lo fotografa (~$0.034/post)
 *   'reference' -> usa a rotazione le TUE foto in reference/ (solo caption, ~$0.002/post)
 */
const postSource = process.env.POST_SOURCE || 'generated';
if (!['generated', 'reference'].includes(postSource)) {
  throw new Error(`POST_SOURCE non valido: "${postSource}". Valori ammessi: generated, reference.`);
}

/** Legge una env var obbligatoria, con errore parlante se manca. */
export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variabile d'ambiente mancante: ${name}. Copia .env.example in .env e compilala.`
    );
  }
  return value;
}

export const config = {
  rootDir,

  paths: {
    // Le tue foto reali: guidano la generazione (stile, filato, resa del punto).
    referenceDir: path.join(rootDir, 'reference'),
    // Scratch di lavoro: immagine e video del run corrente. Non versionato.
    outputDir: path.join(rootDir, 'output'),
    // Storico dei modelli già pubblicati, per non riproporre sempre la stessa borsa.
    historyFile: path.join(rootDir, 'history', 'posted.jsonl'),
    tokensFile: path.join(rootDir, 'tokens.json'),
  },

  tiktok: {
    baseUrl: 'https://open.tiktokapis.com',
    scopes: ['user.info.basic', 'video.publish'],
    redirectUri: process.env.TIKTOK_REDIRECT_URI || 'http://localhost:5173/callback',
    authPort: Number(process.env.AUTH_PORT || 5173),
    // PKCE: obbligatorio per le app registrate come Desktop/iOS/Android, innocuo
    // per quelle Web. Se l'authorize fallisce con "code_challenge", serve questo.
    // Attenzione: TikTok vuole lo SHA256 in ESADECIMALE, non in base64url.
    usePkce: process.env.TIKTOK_PKCE !== 'false',
    // App non auditata: il video atterra comunque privato, qualunque valore inviamo.
    // Con l'audit approvato basta cambiare questo in 'PUBLIC_TO_EVERYONE'.
    privacyLevel: 'SELF_ONLY',
    // Dichiarazione AIGC: obbligatoria per l'immagine generata, ma FALSA per le
    // tue foto reali — dichiararle generate sarebbe sbagliato oltre che ingiusto
    // verso il tuo lavoro.
    isAigc: postSource === 'generated',
    // Oltre questa soglia servirebbe l'upload multi-chunk (non implementato).
    maxSingleChunkBytes: 64 * 1024 * 1024,
    // Polling di status/fetch
    statusPollIntervalMs: 5000,
    statusPollTimeoutMs: 10 * 60 * 1000,
    // Rinnoviamo il token se scade entro questo margine.
    tokenRefreshSkewMs: 5 * 60 * 1000,
  },

  anthropic: {
    apiUrl: 'https://api.anthropic.com/v1/messages',
    version: '2023-06-01',
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    maxTokens: 700,
  },

  gemini: {
    // API "interactions": input multimodale, output immagine in base64.
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    // Nano Banana 2 Lite: generazione + editing, ~$0.034 per immagine 1K.
    // Alternative: 'gemini-3.1-flash-image' (~$0.067), 'gemini-3-pro-image' (~$0.134).
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-image',
    // Verticale nativo: chiediamo il 9:16 al modello invece di ritagliare dopo.
    aspectRatio: '9:16',
    imageSize: '1K',
    // Quante foto di riferimento allegare al massimo (le più recenti in reference/).
    maxReferenceImages: 3,
    referenceExtensions: ['.jpg', '.jpeg', '.png', '.webp'],
  },

  slideshow: {
    // TikTok vuole il verticale pieno.
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 8,
    // Zoom lento (Ken Burns): da 1.0 a questo fattore nell'arco del video.
    zoomTo: 1.12,
    // Traccia audio silenziosa: un mp4 senza stream audio a volte fa storie
    // in fase di elaborazione lato TikTok.
    silentAudio: true,
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  },

  product: {
    // 'generated' (Gemini) oppure 'reference' (le tue foto). Vedi POST_SOURCE.
    source: postSource,
    /**
     * Che cosa vendi e come. Guida sia l'idea del modello sia la caption:
     * è il posto giusto dove cambiare nicchia, materiali o tono.
     */
    brief:
      'Borse fatte a mano all\'uncinetto, pezzi unici realizzati su ordinazione. ' +
      'Filati di cotone e rafia, lavorazioni a punto basso, granny square, ' +
      'trafori e frange. Estetica artigianale mediterranea, niente plastica, ' +
      'niente logo. Il pubblico è femminile, 25-55 anni, cerca un accessorio ' +
      'che non si trova nei negozi.',
    // Invito all'azione: le borse non esistono ancora, si realizzano su richiesta.
    callToAction: 'Scrivimi in DM se vuoi questo modello: lo realizzo su ordinazione.',
    // Numero di immagini per post (1 = un solo modello, video statico con zoom).
    imagesPerPost: 1,
    // Quanti modelli recenti passare a Claude perché non si ripeta.
    historyWindow: 30,
    // Modalità 'reference': quando tutte le foto sono già state usate, si
    // ricomincia dalla meno recente invece di fermarsi.
    reusePhotos: true,
  },

  caption: {
    // TikTok tronca i titoli molto lunghi: teniamoci larghi ma prudenti.
    maxLength: 150,
  },
};

export default config;
