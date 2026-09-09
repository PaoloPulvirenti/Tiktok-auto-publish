import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = path.dirname(fileURLToPath(import.meta.url));

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
    queueDir: path.join(rootDir, 'videos', 'queue'),
    postedDir: path.join(rootDir, 'videos', 'posted'),
    tokensFile: path.join(rootDir, 'tokens.json'),
  },

  tiktok: {
    baseUrl: 'https://open.tiktokapis.com',
    scopes: ['user.info.basic', 'video.publish'],
    redirectUri: process.env.TIKTOK_REDIRECT_URI || 'http://localhost:5173/callback',
    authPort: Number(process.env.AUTH_PORT || 5173),
    // App non auditata: il video atterra comunque privato, qualunque valore inviamo.
    // Con l'audit approvato basta cambiare questo in 'PUBLIC_TO_EVERYONE'.
    privacyLevel: 'SELF_ONLY',
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
    maxTokens: 300,
  },

  video: {
    // Estensioni accettate nella coda.
    extensions: ['.mp4', '.mov', '.webm'],
    // Ordine con cui si svuota la coda:
    //  'name'  -> alfabetico (con i file nominati 2026-09-10.mp4 = dal più vecchio)
    //  'mtime' -> data di modifica del file, dal più vecchio
    order: 'name',
  },

  caption: {
    // TikTok tronca i titoli molto lunghi: teniamoci larghi ma prudenti.
    maxLength: 150,
  },

  /** Brief usato quando il video non ha un sidecar .txt con lo stesso nome. */
  defaultBrief:
    'Video breve e verticale del mio canale. Scrivi una caption generica ma ' +
    'accattivante, in italiano, che inviti a guardare fino alla fine.',
};

export default config;
