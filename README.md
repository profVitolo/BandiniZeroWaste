# ♻️ Bandini Zero Waste AI

Classificatore automatico di rifiuti (stato embrionale) che riconosce, tramite il modello **OpenAI CLIP**, fotografie di rifiuti catturate dalla webcam e suggerisce la categoria di raccolta (bidone) più adatta.

## 📜 Descrizione

L'applicazione è un frontend web statico che utilizza il modello CLIP (`Xenova/clip-vit-base-patch16`) tramite la libreria `@huggingface/transformers` (pipeline `zero-shot-image-classification`). Il modello riceve in input l'immagine e una serie di prompt testuali descrittivi — uno per categoria — e individua la migliore corrispondenza.

## 🔍 Come funziona

1. Avvio della webcam tramite `getUserMedia`.
2. Inizializzazione della pipeline CLIP caricata dal CDN Hugging Face.
3. Cattura del fotogramma sul `<canvas>` e conversione in `RawImage`.
4. Classificazione zero-shot con i prompt definiti nel `LABEL_MAPPING` di `js/app.js`.
5. Applicazione della soglia di confidenza (35%) e aggiornamento del risultato.
6. Apertura animata del bidone corrispondente, con chiusura automatica dopo un countdown di 5 secondi.

## 🏗️ Scelte architetturali attuali

- **Frontend-only**: HTML + CSS + JS vanilla (ES module), nessun backend, nessun build step, nessun framework.
- **CLIP via CDN**: `@huggingface/transformers@3.0.2` (jsDelivr) con modello remoto `Xenova/clip-vit-base-patch16`; `env.allowLocalModels = false` e `env.allowRemoteModels = true`.
- **Zero-shot**: i prompt sono gestiti dinamicamente tramite la costante `LABEL_MAPPING` in `js/app.js`; la soglia di confidenza è fissata a `0.35`.
- **Fallback**: se la confidenza è sotto soglia o il top match riguarda un "empty background", il risultato è assegnato alla categoria di default (`indifferenziato/nc`).

## 🗑️ Interfaccia

L'interfaccia mostra una webcam, un pulsante di classificazione e una serie di **bidoni** animati (coperchio che si apre con un effetto di flip): Vetro, Umido, Carta, Multimateriale e Indifferenziato, ognuno con colore e icona dedicata.

## ✅ Checklist Test Manuale (RF7)

Prima di ogni release, eseguire i seguenti test manuali nel browser:

- [ ] **Avvio su desktop** — Webcam attiva, modello CLIP caricato, prompt visualizzati, pulsante "Classifica Rifiuto" abilitato, pulsante cambio fotocamera **nascosto** (solo 1 dispositivo video)
- [ ] **Avvio su mobile** — Webcam posteriore (`environment`) attiva, pulsante cambio fotocamera **visibile**, modello CLIP caricato
- [ ] **Classificazione oggetto noto** — Inquadrare un oggetto classificabile → risultato verde con categoria, bidone corretto si apre con animazione, hitpoint incrementato, countdown 5 secondi
- [ ] **Classificazione oggetto ignoto** — Inquadrare un oggetto non riconosciuto → risultato arancione "NON CLASSIFICATO", pulsante "Aiutami a imparare" visibile
- [ ] **Aggiunta entry nuova** — Click su "Aiutami a imparare" → modale si apre → inserire descrizione in inglese + categoria → salvare → messaggio successo, modale si chiude, prompt ricaricati
- [ ] **Aggiunta entry duplicata** — Inserire una descrizione già esistente → messaggio errore nella modale (HTTP 409), modale rimane aperta
- [ ] **Cambio camera** — Click su 🔄 → su mobile cambia tra anteriore/posteriore, su desktop cicla tra dispositivi disponibili, animazione feedback, stream aggiornato senza bloccare la classificazione
- [ ] **Nessun errore in console** — Durante tutto il flusso, DevTools Console non mostra errori (warning non bloccanti sono accettati)

## 🚀 Evoluzione futura

- **Classificazione assistita**: quando la confidenza del modello è bassa, viene aperta una richiesta di aiuto all'utente, che fornisce una **descrizione in inglese** dell'oggetto e la categoria di destinazione.
- **Persistenza**: la descrizione viene salvata in **file JSON** sul server tramite script **PHP** (gestione nuove entry e aggiornamento hit point).
- **Apprendimento incrementale**: la descrizione salvata diventa un nuovo prompt nel flusso di classificazione zero-shot del modello.
- **Hit point e pruning**: l'`hits` di un'entry viene incrementato quando la classificazione che la utilizza supera la soglia di confidenza. Le nuove entry partono da un **punto di reset** (20% della scala di hit point) per evitare che vengano selezionate subito per il pruning; le entry con hit a 0 possono essere rimosse, e in caso di esaurimento dello spazio nel file si sostituisce la entry con hit più basso.
- L'**indifferenziato** sarà una categoria a sé stante, distinta dal fallback **NC** (non classificabile).
