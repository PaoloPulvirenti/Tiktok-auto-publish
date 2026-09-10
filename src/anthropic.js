/**
 * Claude fa due lavori in questa pipeline:
 *   1. inventa il modello di borsa del giorno + il prompt visivo per Gemini;
 *   2. scrive la caption del post.
 */
import { config, requireEnv } from '../config.js';

const IDEA_SYSTEM_PROMPT = [
  'Sei una designer di accessori fatti a mano all\'uncinetto.',
  'Inventi UN modello di borsa al giorno e lo descrivi per farlo fotografare.',
  'Rispondi SOLO con un oggetto JSON, senza testo attorno e senza blocchi di codice:',
  '{',
  '  "name": "nome breve del modello, 2-4 parole, in italiano",',
  '  "description": "una frase che dice com\'è fatta: punto, filato, colore, forma",',
  '  "imagePrompt": "prompt in inglese per un modello text-to-image"',
  '}',
  'Regole per imagePrompt:',
  '- descrivi una FOTOGRAFIA di prodotto realistica, verticale, della borsa;',
  '- specifica punto a uncinetto e filato in modo che si veda la texture da vicino;',
  '- luce naturale morbida, sfondo semplice e coerente con l\'estetica artigianale;',
  '- una sola borsa in scena, nessun testo, nessun logo, nessun watermark;',
  '- niente volti riconoscibili: al massimo mani o un corpo tagliato che la indossa;',
  '- resta sotto le 80 parole.',
].join('\n');

const PHOTO_SYSTEM_PROMPT = [
  'Guardi la foto di una borsa a uncinetto fatta a mano e la descrivi.',
  'La borsa nella foto ESISTE: è un pezzo realmente realizzato, non una proposta.',
  'Rispondi SOLO con un oggetto JSON, senza testo attorno e senza blocchi di codice:',
  '{',
  '  "name": "nome breve per questo modello, 2-4 parole, in italiano",',
  '  "description": "una frase su com\'è fatta, basata su ciò che VEDI: punto, filato, colore, forma"',
  '}',
  'Descrivi solo quello che si vede davvero nella foto: niente dettagli inventati.',
].join('\n');

const CAPTION_SYSTEM_PROMPT = [
  'Sei un copywriter esperto di TikTok per un\'artigiana che fa borse a uncinetto.',
  'Scrivi la caption di UN post, in italiano, pronta da incollare.',
  'Regole:',
  `- massimo ${config.caption.maxLength} caratteri, hashtag inclusi;`,
  '- tono naturale e diretto, niente clickbait esagerato, niente emoji a raffica (max 2);',
  config.product.source === 'reference'
    ? '- la borsa in foto è un pezzo già realizzato a mano: parlane come di una cosa che esiste;'
    : '- deve essere chiaro che la borsa si realizza SU ORDINAZIONE, non è pronta in magazzino;',
  '- includi l\'invito a scrivere in DM;',
  '- da 2 a 4 hashtag pertinenti alla fine;',
  '- niente virgolette attorno alla caption, niente preamboli, niente spiegazioni:',
  '  rispondi SOLO con il testo della caption.',
].join('\n');

/**
 * Chiamata comune a /v1/messages: restituisce il testo concatenato.
 * `userMessage` è una stringa oppure una lista di blocchi (testo + immagine).
 */
async function callClaude(system, userMessage, { maxTokens = config.anthropic.maxTokens } = {}) {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const { model, apiUrl, version } = config.anthropic;

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
        system,
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
    throw new Error(
      `Anthropic ha restituito l'errore "${err.type || 'unknown'}": ${err.message || 'nessun dettaglio'}`
    );
  }

  const content = (payload.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  if (!content.trim()) {
    throw new Error(`Anthropic: nessun testo nella risposta. Risposta: ${JSON.stringify(payload)}`);
  }
  return content;
}

/** Estrae il JSON anche se il modello lo avvolge in un blocco di codice. */
export function parseIdeaJson(text, required = ['name', 'description', 'imagePrompt']) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced ? fenced[1] : text).trim();
  // Se restasse del testo attorno, prendiamo dal primo { all'ultimo }.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;

  let idea;
  try {
    idea = JSON.parse(candidate);
  } catch {
    throw new Error(`Anthropic: l'idea non è un JSON valido. Risposta: ${text.slice(0, 400)}`);
  }

  for (const field of required) {
    if (typeof idea[field] !== 'string' || !idea[field].trim()) {
      throw new Error(`Anthropic: campo "${field}" mancante o vuoto nell'idea generata.`);
    }
  }
  return Object.fromEntries(required.map((field) => [field, idea[field].trim()]));
}

/**
 * Inventa il modello del giorno, evitando quelli già pubblicati.
 * @param {string[]} [recentNames] nomi dei modelli recenti da non ripetere
 */
export async function generateIdea(recentNames = []) {
  const userMessage = [
    'Cosa vendo:',
    config.product.brief.trim(),
    recentNames.length
      ? `\nModelli già pubblicati, da NON riproporre (nemmeno variazioni minime):\n- ${recentNames.join('\n- ')}`
      : '',
    '\nInventa il modello di oggi e rispondi con il JSON.',
  ]
    .filter(Boolean)
    .join('\n');

  return parseIdeaJson(await callClaude(IDEA_SYSTEM_PROMPT, userMessage));
}

/**
 * Guarda una foto vera e ne ricava nome + descrizione, nello stesso formato
 * di generateIdea, così il resto della pipeline non cambia.
 * @param {Buffer} image byte della foto
 * @param {string} mimeType es. 'image/jpeg'
 */
export async function describePhoto(image, mimeType) {
  const text = await callClaude(PHOTO_SYSTEM_PROMPT, [
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: image.toString('base64') } },
    { type: 'text', text: `Cosa vendo:\n${config.product.brief.trim()}\n\nDescrivi la borsa in foto.` },
  ]);

  const idea = parseIdeaJson(text, ['name', 'description']);
  // In questa modalità non serve un prompt per Gemini: la foto ce l'abbiamo già.
  return { name: idea.name, description: idea.description };
}

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
 * Genera la caption del post a partire dal modello del giorno.
 * @param {{ name: string, description: string }} idea
 */
export async function generateCaption(idea) {
  const userMessage = [
    'Cosa vendo:',
    config.product.brief.trim(),
    '\nBorsa di oggi:',
    `${idea.name}: ${idea.description}`,
    `\nInvito all'azione da rendere tuo: ${config.product.callToAction}`,
    '\nScrivi la caption.',
  ].join('\n');

  const caption = sanitizeCaption(await callClaude(CAPTION_SYSTEM_PROMPT, userMessage, { maxTokens: 300 }));
  if (!caption) {
    throw new Error('Anthropic: caption vuota dopo la pulizia.');
  }
  return caption;
}
