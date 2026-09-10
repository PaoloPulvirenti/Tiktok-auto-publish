# tiktok-daily-poster

Catalogo automatico di borse a uncinetto su TikTok.

Ogni mattina GitHub Actions inventa un modello di borsa, ne genera la **foto
fotorealistica** partendo dalle tue borse vere, la monta in un video verticale,
scrive la caption e pubblica il post in `SELF_ONLY` (privato). A te resta un
gesto: aprire l'app e rendere il video visibile a **Tutti**.

Chi vede un modello che gli piace ti scrive in DM e quella borsa la realizzi
su ordinazione: le immagini sono **proposte di design**, non foto di prodotti
in magazzino. Per questo ogni post parte con `is_aigc: true`, che applica
l'etichetta "AI-generated" richiesta da TikTok sui contenuti realistici.

Node 22+, ESM, unica dipendenza `dotenv`: tutte le chiamate HTTP usano il
`fetch` nativo. Niente framework, niente TypeScript, niente SDK.

## Come funziona

```
history/posted.jsonl ─┐
                      ├─> idea del giorno (Claude) ─> imagePrompt
reference/*.jpg ──────┘                                    │
                                                           v
                                        immagine 9:16 (Gemini, "Nano Banana")
                                                           │
                                                           v
                                          video 1080x1920 (ffmpeg, zoom lento)
                                                           │
                            caption (Claude) ─────────────>│
                                                           v
                                        TikTok Content Posting API (SELF_ONLY)
                                                           │
                                                           v
                                   history/posted.jsonl (committato dal workflow)
```

- **`reference/`** contiene le foto delle tue borse vere. Vengono allegate a
  ogni generazione: sono loro a dare filato, punto e colori reali. Senza
  almeno una foto lo script si ferma, invece di inventare un uncinetto che
  non è il tuo.
- **`history/posted.jsonl`** è la memoria: i modelli già pubblicati finiscono
  nel prompt come lista di cose da **non** riproporre.
- **`config.js`** è il posto dove cambiare nicchia, tono, materiali, durata del
  video e modello immagine.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `npm run auth` | Autorizzazione OAuth one-time, crea `tokens.json`. |
| `npm run check` | Diagnostica: env, ffmpeg, riferimenti, token, permessi TikTok. **Non genera e non pubblica: non spende.** |
| `npm run post -- --dry-run` | Fa tutto tranne pubblicare: immagine, video e caption restano in `output/`. **Costa la generazione dell'immagine.** |
| `npm run post` | Il post vero. |
| `npm test` | 104 test con le API mockate: gira senza credenziali e senza spendere. |
| `node scripts/ffmpeg-smoke.mjs` | Verifica che ffmpeg produca davvero un mp4 1080x1920 della durata attesa. |

## Quanto costa

A un post al giorno:

| Voce | Costo |
| --- | --- |
| Immagine (`gemini-3.1-flash-lite-image`, 1K) | ~$0.034 × 30 = **~$1/mese** |
| Idea + caption (Claude Haiku) | frazioni di centesimo, **~$0.05/mese** |
| GitHub Actions | **gratis** (2000 min/mese sui repo privati, il job ne usa ~3 al giorno) |

I modelli immagine di Gemini **non hanno free tier**: la chiave richiede la
fatturazione attiva. Se vuoi più qualità, in `config.js` puoi passare a
`gemini-3.1-flash-image` (~$2/mese) o `gemini-3-pro-image` (~$4/mese).

## Setup

### 1. Dipendenze

```bash
npm install
```

ffmpeg serve solo per girare in locale (sui runner GitHub è già presente):

```bash
brew install ffmpeg
```

Su Windows: `winget install Gyan.FFmpeg`. Se non è nel `PATH`, indicalo con
`FFMPEG_PATH` nel `.env`.

### 2. Le tue foto

Metti in `reference/` almeno una foto di una borsa che hai fatto: nitida, luce
naturale, e se puoi un dettaglio ravvicinato del punto. Vengono usate le 3 più
recenti. **Queste foto vanno committate**, perché servono al workflow: se il
repo è pubblico saranno pubbliche anche loro.

### 3. Chiavi API

```bash
cp .env.example .env
```

- `ANTHROPIC_API_KEY` — https://console.anthropic.com
- `GEMINI_API_KEY` — https://aistudio.google.com/apikey (con fatturazione attiva)
- `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` — vedi il punto 4

### 4. App TikTok

Su https://developers.tiktok.com:

- aggiungi il prodotto **Content Posting API** con **Direct Post**, scope
  `video.publish` (e `user.info.basic` per il `creator_info`);
- registra la redirect URI: `http://localhost:5173/callback`;
- registra l'app come **Web app** (usa `client_secret`, quindi niente PKCE) e
  verifica il dominio se richiesto.

### 5. Autorizza l'account (una volta sola)

```bash
npm run auth
```

Apri il link stampato, autorizza, e viene creato `tokens.json`. Il refresh
token dura circa un anno; l'access token ~24h e si rinnova da solo.

### 6. Verifica

```bash
npm run check
```

Controlla `.env`, ffmpeg, `reference/`, i token, gli scope concessi e chiama
`creator_info` — senza generare né pubblicare. Esce con codice 1 se qualcosa
non va.

### 7. Prova a vuoto

```bash
npm run post -- --dry-run
```

Genera l'idea, l'immagine e il video veri, stampa la caption e il body che
manderebbe a `video/init`, poi si ferma. Guarda `output/`: è il momento per
capire se il modello immagine rende bene le tue borse, **prima** di
pubblicare. Questa prova costa una generazione (~$0.034).

### 8. Il post vero

```bash
npm run post
```

## GitHub Actions

Tre workflow in `.github/workflows/`:

| Workflow | Quando | Cosa fa |
| --- | --- | --- |
| `post.yml` | cron `0 7 * * *` + a mano | Genera e pubblica. A mano puoi spuntare `dry_run`. |
| `check.yml` | a mano | `npm run check` con i secret del repo. Non spende. |
| `test.yml` | a ogni push | Suite di test + smoke test di ffmpeg sul runner. |

### Secret da configurare

In *Settings → Secrets and variables → Actions*:

| Secret | Contenuto |
| --- | --- |
| `ANTHROPIC_API_KEY` | la tua chiave Anthropic |
| `GEMINI_API_KEY` | la tua chiave Gemini |
| `TIKTOK_CLIENT_KEY` | dalla app TikTok |
| `TIKTOK_CLIENT_SECRET` | dalla app TikTok |
| `TIKTOK_TOKENS` | **il contenuto** di `tokens.json`, incollato per intero |
| `GH_PAT` | PAT fine-grained su questo repo con permesso *Secrets: write* |

### Perché serve il PAT

TikTok **ruota il refresh token a ogni rinnovo**: quello vecchio muore. Sul
runner il filesystem è effimero, quindi dopo ogni refresh il workflow riscrive
il secret `TIKTOK_TOKENS` con `gh secret set` — e il `GITHUB_TOKEN` di default
non può scrivere secret, da cui il PAT dedicato.

Senza `GH_PAT` il workflow **fallisce apposta** quando un refresh avviene, con
un messaggio esplicito: meglio un run rosso che scoprire fra un mese che
l'autenticazione è morta silenziosamente.

Non si usa `actions/cache` per i token: le cache vengono sfrattate dopo 7
giorni di inattività e spezzerebbero la catena del refresh, che invece dura
un anno.

### Fuso orario

Il cron di GitHub è **solo UTC**: `0 7 * * *` sono le 9:00 italiane con l'ora
legale e le 8:00 con quella solare. Se ci tieni all'orario esatto tutto
l'anno, tieni due righe di cron e commenta quella fuori stagione.

I workflow schedulati vengono disattivati da GitHub dopo 60 giorni di
inattività sul repo: qui non è un problema, perché ogni post committa lo
storico e quello conta come attività.

## Configurazione (`config.js`)

| Chiave | Default | Cosa fa |
| --- | --- | --- |
| `product.brief` | borse a uncinetto | **Il posto dove cambi nicchia**: guida idea e caption. |
| `product.callToAction` | scrivimi in DM | Invito all'azione messo nella caption. |
| `product.imagesPerPost` | 1 | Più di 1 = più inquadrature montate in sequenza (costo × N). |
| `product.historyWindow` | 30 | Quanti modelli recenti passare a Claude perché non si ripeta. |
| `gemini.model` | `gemini-3.1-flash-lite-image` | Alternative: `gemini-3.1-flash-image`, `gemini-3-pro-image`. |
| `gemini.imageSize` / `aspectRatio` | `1K` / `9:16` | Il verticale si chiede al modello, non si ritaglia dopo. |
| `gemini.maxReferenceImages` | 3 | Quante foto di `reference/` allegare. |
| `slideshow.durationSec` | 8 | Durata del video montato. |
| `slideshow.zoomTo` | 1.12 | Quanto zooma il Ken Burns (1.0 = immagine ferma). |
| `slideshow.silentAudio` | `true` | Traccia audio muta: un mp4 senza audio a volte fa storie lato TikTok. |
| `tiktok.privacyLevel` | `SELF_ONLY` | Con app auditata puoi passare a `PUBLIC_TO_EVERYONE`. |
| `tiktok.isAigc` | `true` | Dichiarazione di contenuto generato da IA. **Lascialo così.** |
| `caption.maxLength` | 150 | Limite di caratteri della caption. |
| `anthropic.model` | `claude-haiku-4-5-20251001` | Sovrascrivibile con `ANTHROPIC_MODEL`. |

## Struttura

```
config.js               parametri, percorsi, brief del prodotto
src/auth.js             flow OAuth one-time -> tokens.json
src/anthropic.js        idea del giorno (JSON) + caption
src/gemini.js           immagine 9:16 dalle foto di riferimento
src/slideshow.js        ffmpeg: immagine -> mp4 verticale con zoom
src/tiktok.js           refresh token + creator_info -> init -> upload -> status
src/state.js            storico dei post (posted.jsonl)
src/index.js            orchestratore
src/check.js            diagnostica (npm run check)
scripts/ffmpeg-smoke.mjs verifica il montaggio con ffmpeg vero
reference/              le TUE foto: guidano la generazione
history/posted.jsonl    memoria dei modelli già pubblicati
output/                 immagine e video del run corrente (non versionato)
```

## Test

```bash
npm test
```

104 test su `node:test` con `fetch` mockato: nessuna credenziale, nessuna
chiamata di rete, nessuna immagine generata, nessun video pubblicato. Coprono
i punti in cui è facile sbagliare: il body di `video/init`, l'header
`Content-Range` senza `Content-Length`, gli HTTP 200 che contengono un errore,
il refresh del token, il JSON dell'idea avvolto in un blocco di codice, il
comando ffmpeg, e il fatto che un post fallito **non** scrive nello storico
(così il modello può essere riproposto domani).

Il comando ffmpeg vero non è testabile con i mock: lo verifica
`scripts/ffmpeg-smoke.mjs`, che gira in CI dove ffmpeg è preinstallato e
controlla risoluzione e durata del file prodotto.

## Note importanti

- **Account pubblico**: perché tu possa poi rendere pubblici i singoli video,
  l'account TikTok deve essere impostato su pubblico.
- **App non auditata**: il video atterra sempre privato, *qualunque*
  `privacy_level` invii. È previsto — non è un bug, ed è anche la tua rete di
  sicurezza: niente va online senza che tu lo guardi.
- **Inganno del creator_info**: l'API elenca `PUBLIC_TO_EVERYONE` tra le
  opzioni anche se non sei auditato, e restituisce "successo". Non fidarti.
- **Perché un video e non un carosello di foto**: i photo post accettano solo
  `PULL_FROM_URL` da un **dominio verificato** nel portale TikTok, mentre i
  video accettano i byte diretti (`FILE_UPLOAD`). Il video muto con zoom evita
  di dover possedere e verificare un dominio. Se in futuro ne avrai uno, il
  carosello nativo è il formato migliore per un catalogo.
- **Video muto**: `auto_add_music` esiste solo per i photo post, quindi il
  video esce senza audio. La musica la aggiungi tu quando lo rendi pubblico.
- **Onestà del catalogo**: le borse mostrate non esistono ancora. Vanno
  presentate come modelli realizzabili su ordinazione — che è quello che fa la
  caption — e dichiarate come generate da IA. Spacciarle per foto di prodotti
  esistenti sarebbe pubblicità ingannevole, oltre che una violazione delle
  regole TikTok sui contenuti IA non dichiarati.
- **Limiti**: ~15 post/giorno per account. L'upload è single-chunk fino a
  64 MB: un video di 8 secondi sta largamente sotto.
- **Segreti**: `.env` e `tokens.json` sono in `.gitignore` (`tokens.json` viene
  scritto con permessi `600`). Non committarli.

## Problemi frequenti

| Sintomo | Causa tipica |
| --- | --- |
| `Nessuna foto di riferimento` | `reference/` è vuota: mettici una foto di una tua borsa. |
| `ffmpeg non trovato` | Non installato in locale (`brew install ffmpeg`) o fuori dal `PATH`: usa `FFMPEG_PATH`. |
| `Gemini: HTTP 429` | Quota o rate limit della chiave Gemini. |
| `nessuna immagine nella risposta (motivo: SAFETY)` | Il prompt è stato bloccato: rilancia, o ritocca `product.brief`. |
| `l'idea non è un JSON valido` | Claude ha risposto a parole: rilanciare basta quasi sempre. |
| `redirect_uri` mismatch in fase di auth | La URI nel `.env` non è identica, carattere per carattere, a quella registrata su TikTok. |
| `La porta 5173 è già occupata` | Cambia `AUTH_PORT` (e la redirect URI registrata). |
| `I token sono incompleti ... TIKTOK_TOKENS` | Il secret contiene un JSON parziale: reincolla tutto `tokens.json`. |
| Errore di permessi al primo post | Manca lo scope `video.publish`: `npm run check` te lo dice prima di provarci. |
| Errore `spam_risk_too_many_posts` | Superato il limite giornaliero di post dell'account. |
| Il video non compare tra i pubblici | È corretto: è privato finché non lo rendi visibile a "Tutti" dall'app. |
| `status/fetch` in timeout | Il video è ancora in elaborazione: controlla l'app **prima** di ripubblicare, per non caricarlo due volte. |
