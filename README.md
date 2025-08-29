# Resonance (Obsidian Plugin)

Registra riunioni, trascrive localmente con whisper.cpp, riassume con Google Gemini e crea automaticamente una nota in Obsidian.

## Perché Vite
Vite è un bundler moderno che compila TypeScript in JavaScript in modo rapido e con DX eccellente.
- Build velocissima (watch in ms) → feedback immediato durante lo sviluppo.
- Configurazione semplice: produce `dist/main.js` in formato CommonJS richiesto da Obsidian.
- Mappa sorgenti (`.map`) utile per il debug.

Script:
```bash
npm run dev    # build in watch (rigenera dist/main.js ad ogni modifica)
npm run build  # build una tantum per rilasciare (copia anche manifest.json e styles.css in dist/)
```

## Requisiti
- Obsidian Desktop ≥ 1.5
- Node.js ≥ 18 (per build)
- FFmpeg installato localmente (per la registrazione audio)
- whisper.cpp compilato localmente (per la trascrizione)
- Chiave API Google Gemini (per il riassunto)

## Installazione sviluppo
```bash
npm install
npm run build
```
Troverai gli artefatti in `dist/`:
- `dist/manifest.json`
- `dist/main.js`
- `dist/styles.css`

### Installazione nel Vault
Copia l'intera cartella `dist/` dentro `<Vault>/.obsidian/plugins/resonance/` (o copia i 3 file elencati sopra mantenendo i nomi). Riavvia/ricarica Obsidian e abilita il plugin.

## UX avanzate incluse
- Scansione dispositivi FFmpeg (Windows/macOS): pulsante "Scansiona dispositivi audio" nelle impostazioni.
- Dropdown per scegliere rapidamente microfono e (opzionalmente) audio di sistema.
- Test rapido FFmpeg (3 secondi) per verificare il dispositivo.
- Pulsante "Annulla" durante Trascrizione/Riassunto.
- Scelta del modello Gemini.

## Configurazione
Impostazioni → Resonance: API Key/model, FFmpeg + backend e device, whisper `main` e modello `.bin`, cartella note.

## Build e ship
- Sviluppo: `npm run dev` e symlink/copia `dist/` nel vault
- Rilascio: `npm run build`, zippa il contenuto di `dist/`

## Troubleshooting
- "Configurazione incompleta" → imposta API Key, FFmpeg/whisper/model.
- Audio mancante → backend/device; usa scansione e test 3s.
- Trascrizione vuota → controlla `.mp3` e modello `.bin`.
- Errore Gemini → API Key e modello.
