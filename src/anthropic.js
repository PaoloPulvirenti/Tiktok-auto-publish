import { config, requireEnv } from '../config.js';

const SYSTEM_PROMPT = [
  'Sei un copywriter esperto di TikTok.',
  'Scrivi la caption di UN video, in italiano, pronta da incollare.',
  'Regole:',
  `- massimo ${config.caption.maxLength} caratteri, hashtag inclusi;`,
  '- tono naturale e diretto, niente clickbait esagerato, niente emoji a raffica (max 2);',
  '- da 2 a 4 hashtag pertinenti alla fine;',
  '- niente virgolette attorno alla caption, niente preamboli, niente spiegazioni:',
  '  rispondi SOLO con il testo della caption.',
].join('\n');

/** Ripulisce la risposta del modello da virgolette/preamboli e la accorcia se serve. */
function sanitizeCaption(text) {
  let caption = text.trim().split('\n').filter(Boolean).join(' ').trim();

  // Toglie eventuali virgolette che avvolgono l'intera caption.
  const wrapped = /^["'«“](.*)["'»”]$/s.exec(caption);
  if (wrapped) caption = wrapped[1].trim();

  if (caption.length > config.caption.maxLength) {
    caption = `${caption.slice(0, config.caption.maxLength - 1).trimEnd()}…`;
  }
  return caption;
}

/**
 * Genera la caption a partire dal brief.
 * @param {string} brief testo libero che descrive il video
 * @param {{ fileName?: string }} [context]
 * @returns {Promise<string>}
 */
export async function generateCaption(brief, context = {}) {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const { model, apiUrl, version, maxTokens } = config.anthropic;

  const userMessage = [
    'Brief del video:',
    brief.trim(),
    context.fileName ? `\n(nome file: ${context.fileName})` : '',
    '\nScrivi la caption.',
  ]
    .filter(Boolean)
    .join('\n');

  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': version,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } catch (cause) {
    throw new Error(`Anthropic: chiamata di rete fallita (${cause.message})`, { cause });
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
    throw new Error(`Anthropic: HTTP ${res.status} ${res.statusText}. ${detail}`);
  }
  if (!payload) {
    throw new Error(`Anthropic: risposta non JSON. Risposta: ${text || '(vuota)'}`);
  }
  if (payload.type === 'error' || payload.error) {
    const err = payload.error || {};
    throw new Error(`Anthropic ha restituito l'errore "${err.type || 'unknown'}": ${err.message || 'nessun dettaglio'}`);
  }

  const caption = sanitizeCaption(
    (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  );

  if (!caption) {
    throw new Error(`Anthropic: nessun testo nella risposta. Risposta: ${JSON.stringify(payload)}`);
  }
  return caption;
}
