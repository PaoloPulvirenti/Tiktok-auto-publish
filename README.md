# tiktok-daily-poster

Pubblica **un video al giorno** su TikTok in modo semi-automatico:
lo script genera la caption via **API Anthropic** e pubblica il video via
**Content Posting API** di TikTok in `SELF_ONLY` (privato). A te resta solo
un gesto: aprire l'app e rendere il video visibile a **Tutti**.

Questo evita l'audit di TikTok. Se in futuro fai l'audit, basta cambiare
`tiktok.privacyLevel` in `config.js` e la pubblicazione diventa pubblica al 100%.

Node 18+, ESM, unica dipendenza `dotenv`: tutte le chiamate HTTP usano il
`fetch` nativo. Niente framework, niente TypeScript.

## Come funziona

```
videos/queue/  ->  [cron mattutino]  ->  caption (Anthropic)  ->  post TikTok (privato)  ->  videos/posted/
```

- Droppi i video in `videos/queue/`. Vengono presi in ordine alfabetico
  (consiglio: nominali `2026-09-10.mp4`, `2026-09-11.mp4`, ...), uno per esecuzione.
- Brief: opzionale, un `.txt` con lo **stesso nome** del video
  (`2026-09-10.mp4` -> `2026-09-10.txt`). Se manca, usa `defaultBrief` in `config.js`.
- A fine corsa video, brief e un `.caption.txt` con la caption usata finiscono
  in `videos/posted/`.

## Setup

1. **Dipendenze**
   ```bash
   npm install
   ```

2. **App TikTok** su https://developers.tiktok.com
   - Aggiungi il prodotto **Content Posting API** con **Direct Post**, scope
     `video.publish` (e `user.info.basic` per il `creator_info`).
   - Registra la redirect URI: `http://localhost:5173/callback`.
   - Registra l'app come **Web app** (usa `client_secret`, quindi niente PKCE)
     e verifica il dominio se richiesto.

3. **Env**
   ```bash
   cp .env.example .env
   # compila ANTHROPIC_API_KEY, TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
   ```

4. **Autorizza l'account (una volta sola)**
   ```bash
   npm run auth
   ```
   Apri il link stampato, autorizza, e verrà creato `tokens.json`
   (il refresh token dura ~1 anno, l'access token ~24h e si rinnova da solo
   a ogni post).

5. **Test manuale**
   ```bash
   # metti un video di prova in videos/queue/, poi:
   npm run post
   ```

## Cron (un post ogni mattina alle 9:00)

```cron
0 9 * * * cd /percorso/tiktok-daily-poster && /usr/bin/node src/index.js >> post.log 2>&1
```

Note pratiche:

- il cron non eredita il tuo `PATH`: usa il percorso assoluto di `node`
  (`which node`) come nell'esempio;
- il `.env` viene letto dalla cartella del progetto, quindi il `cd` iniziale
  serve davvero;
- se la coda è vuota lo script esce con codice 0 e un messaggio, senza errori:
  puoi lasciarlo schedulato anche nei giorni in cui non hai video.

Su una serverless / GitHub Action il concetto è identico: schedule giornaliero
che lancia `node src/index.js`. Attenzione però: `tokens.json` va persistito
tra un run e l'altro (su GitHub Actions useresti un secret o uno storage, non
il filesystem effimero), perché a ogni refresh il token cambia.

## Configurazione (`config.js`)

| Chiave | Default | Cosa fa |
| --- | --- | --- |
| `tiktok.privacyLevel` | `SELF_ONLY` | Con app auditata puoi passare a `PUBLIC_TO_EVERYONE`. |
| `tiktok.maxSingleChunkBytes` | 64 MB | Oltre questa soglia lo script si ferma con un errore chiaro. |
| `tiktok.statusPollIntervalMs` / `statusPollTimeoutMs` | 5s / 10min | Polling di `status/fetch`. |
| `video.extensions` | `.mp4 .mov .webm` | Estensioni raccolte dalla coda. |
| `video.order` | `name` | `name` = alfabetico, `mtime` = dal file più vecchio. |
| `caption.maxLength` | 150 | Limite di caratteri della caption generata. |
| `defaultBrief` | — | Brief usato quando manca il sidecar `.txt`. |
| `anthropic.model` | `claude-haiku-4-5-20251001` | Sovrascrivibile con `ANTHROPIC_MODEL`. |

## Struttura

```
config.js          parametri, percorsi, brief di default
src/auth.js        flow OAuth one-time -> tokens.json
src/tiktok.js      refresh token + creator_info -> init -> upload -> status/fetch
src/anthropic.js   generazione della caption (/v1/messages)
src/index.js       orchestratore: coda -> caption -> post -> archivio
videos/queue/      i video da pubblicare (+ eventuali brief .txt)
videos/posted/     archivio dei video già pubblicati
```

## Note importanti

- **Account pubblico**: perché tu possa poi rendere pubblici i singoli video,
  l'account TikTok deve essere impostato su pubblico.
- **App non auditata**: il video atterra sempre privato, *qualunque*
  `privacy_level` invii. È previsto — non è un bug.
- **Inganno del creator_info**: l'API elenca `PUBLIC_TO_EVERYONE` tra le opzioni
  anche se non sei auditato, e restituisce "successo". Il video resta comunque
  privato finché non lo cambi a mano. Non fidarti della risposta API in fase di test.
- **Limiti**: ~15 post/giorno per account e MP4 fino a 1 GB. Questo scheletro
  carica in un unico chunk fino a 64 MB; oltre serve il chunking (non incluso),
  quindi lo script si ferma dicendoti di comprimere il video.
- **Segreti**: `.env` e `tokens.json` sono in `.gitignore` (`tokens.json` viene
  scritto con permessi `600`). Non committarli.

## Problemi frequenti

| Sintomo | Causa tipica |
| --- | --- |
| `redirect_uri` mismatch in fase di auth | La URI nel `.env` non è identica, carattere per carattere, a quella registrata nell'app TikTok. |
| `La porta 5173 è già occupata` | Un altro processo usa la porta: cambia `AUTH_PORT` (e la redirect URI registrata). |
| `tokens.json non trovato` | Non hai ancora eseguito `npm run auth`, o il cron gira in un'altra cartella. |
| Errore `spam_risk_too_many_posts` | Hai superato il limite giornaliero di post dell'account. |
| Il video non compare tra i pubblici | È corretto: è privato finché non lo rendi visibile a "Tutti" dall'app. |
| `status/fetch` in timeout | Il video è ancora in elaborazione: controlla l'app **prima** di ripubblicarlo, per non caricarlo due volte. |
