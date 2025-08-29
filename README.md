<p align="center">
  <a href="https://obsidian.md/" target="_blank" rel="noopener">
    <img alt="Resonance" src="https://img.shields.io/badge/Obsidian-Community%20Plugin-7c3aed?logo=obsidian&logoColor=white" />
  </a>
  <img alt="Desktop only" src="https://img.shields.io/badge/Desktop-only-informational" />
  <img alt="Requires FFmpeg" src="https://img.shields.io/badge/Requires-FFmpeg-green" />
  <img alt="Transcription via whisper.cpp" src="https://img.shields.io/badge/Transcription-whisper.cpp-orange" />
</p>

<div align="center">
  <h2>Resonance</h2>
  <p>
    Record → Transcribe → Summarize → Create note. <br/>
    A local‑first recording & meeting notes workflow for Obsidian.
  </p>
  <p>
    <a href="#installation">Installation</a> ·
    <a href="#usage">Usage</a> ·
    <a href="#settings">Settings</a> ·
    <a href="#troubleshooting">Troubleshooting</a>
  </p>
</div>

## What it does

Resonance captures audio with FFmpeg, transcribes it locally using whisper.cpp, summarizes the transcript with Google Gemini, and creates a Markdown note in your vault — all from Obsidian.

## Features

- 🎙️ Record microphone and optionally system audio (depends on OS setup)
- 🧠 Local transcription via whisper.cpp
- ✨ AI summary via Google Gemini
- ⏱️ Status‑bar timer and ribbon shortcuts
- 📚 Library to review, play, download or delete recordings/transcripts

## Requirements

- Obsidian Desktop ≥ 1.5
- FFmpeg installed locally
- whisper.cpp built locally (binary and model .bin)
- Google Gemini API Key (for summaries)

## Installation

User install from release:
1) Download the zip containing `manifest.json`, `main.js`, `styles.css`.
2) Create `<YourVault>/.obsidian/plugins/resonance/`.
3) Copy the three files there and enable the plugin in Obsidian.

From source (developers):
```bash
npm install
npm run dev   # watch build
npm run build # production build (outputs to dist/)
```
Artifacts are emitted to `dist/`.

## Usage

1) Click the microphone icon in the ribbon to start/stop. Pick a scenario when prompted.  
2) Watch the timer in the status bar.  
3) When finished, a note named `Meeting YYYY-MM-DD HH-mm.md` is created in your selected folder.  
4) Open the Library (audio file icon) to browse, listen, download or delete recordings and transcripts.

## Settings

- **FFmpeg**: executable path; backend (auto/dshow/avfoundation/pulse/alsa); device scan; 3‑second test.
- **Whisper**: repo path, whisper‑cli path, model picker or auto‑download; transcription language (auto or ISO code).
- **LLM**: Gemini API Key and model.
- **Obsidian**: output folder for generated notes.
- **Library & retention**: maximum recordings to keep (0 = infinite).

## How it works (overview)

1) FFmpeg writes an `.mp3` to `<vault>/.obsidian/plugins/resonance/recordings/`  
2) whisper.cpp transcribes locally and writes a `.txt` transcript  
3) Gemini summarizes the transcript  
4) Resonance creates a Markdown note in your chosen folder

## Privacy

- Audio never leaves your machine.  
- Only the text transcript is sent to Gemini for summarization.  
- The API Key is stored locally in your vault.

## Troubleshooting

- “Incomplete configuration”: set FFmpeg path, whisper main, model, and API key.
- No audio: verify backend/device; use Scan and the 3‑second Test.
- Empty transcription: check the `.mp3` file and the model path.
- Gemini error: verify API key and selected model.

## Contributing

Issues and PRs are welcome. If you’d like to help with docs or UX, please open an issue to coordinate.

---

Built with Vite. This plugin is desktop‑only.