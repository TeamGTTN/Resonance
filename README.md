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
    <a href="#configuration">Configuration</a> ·
    <a href="#usage">Usage</a> ·
    <a href="#settings">Settings</a> ·
    <a href="#troubleshooting">Troubleshooting</a>
  </p>
  <p>
    <a href="https://github.com/TeamGTTN/Resonance" target="_blank" rel="noopener">
      <img alt="GitHub Repo" src="https://img.shields.io/badge/GitHub-Resonance-black?logo=github" />
    </a>
    <a href="https://buymeacoffee.com/michaelgorini" target="_blank" rel="noopener">
      <img alt="Donate" src="https://img.shields.io/badge/Donate-Buy%20me%20a%20coffee-yellow" />
    </a>
  </p>
</div>

## What it does

Resonance captures audio with FFmpeg, transcribes it locally using whisper.cpp, summarizes the transcript with Google Gemini, and creates a Markdown note in your vault, all from Obsidian.

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
- LLM API Key or local Ollama (for summaries)

## Installation

User install from release:
1) Download the zip containing `manifest.json`, `main.js`, `styles.css`.
2) Create `<YourVault>/.obsidian/plugins/resonance/`.
3) Copy the three files there and enable the plugin in Obsidian.

From source (developers):
```bash
npm install
npm run build
```
Artifacts are emitted to `dist/`.

## Configuration

Follow these steps once to fully set up recording, local transcription and summarization.

### 1) FFmpeg

- macOS:
  - Install with Homebrew: `brew install ffmpeg`
  - Typical path: `/opt/homebrew/bin/ffmpeg` (Apple Silicon) or `/usr/local/bin/ffmpeg` (Intel)
- Windows:
  - Download a static build (e.g. from the BtbN or Gyan packages)
  - Unzip to `C:/ffmpeg/` so the executable is at `C:/ffmpeg/bin/ffmpeg.exe`
  - Optionally add `C:/ffmpeg/bin` to PATH, or set the full path in settings
- Linux:
  - Install via your package manager, e.g. Debian/Ubuntu: `sudo apt install ffmpeg`, Fedora: `sudo dnf install ffmpeg`

In Obsidian → Resonance → FFmpeg:
- Set “FFmpeg path” or click “Detect”. On macOS you may need to grant microphone permissions to Obsidian.

### 2) whisper.cpp (local transcription)

Clone and build the project, then select the `whisper-cli` binary.

- macOS/Linux (generic):
```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -S . -B build
cmake --build build -j
```
  - The executable is typically at `build/bin/whisper-cli`
- Windows (CMake + MSVC):
  - Install CMake and Visual Studio Build Tools
  - From a Developer PowerShell:
```powershell
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -S . -B build -A x64
cmake --build build --config Release
```
  - The executable is typically at `build/bin/Release/whisper-cli.exe`

In Obsidian → Resonance → Whisper:
- Set “whisper.cpp repo path”, then click “Detect” to auto‑find `whisper-cli`, or set it manually.
- Pick a model preset and click “Download”, or set a model `.bin` path manually.
- Choose the “Transcription language” (or leave Automatic).

Models (manual download): see the official ggml models, e.g. small/medium/large. Place the `.bin` in `<repo>/models/` and select it in settings.

### 3) LLM

- Create an API key from Google AI Studio or the LLM of your choice.
- In Obsidian → Resonance → LLM: paste the key and pick the model.

Only the text transcript is sent to the LLM. Audio stays local.

### 4) Audio devices (mic and system audio)

Select the proper backend for your OS and pick devices from the scanned list.

- Backend:
  - macOS: `avfoundation`
  - Windows: `dshow`
  - Linux: `pulse` (or `alsa`)
  - “Automatic” chooses based on OS

- macOS system audio:
  - Install a virtual loopback driver (e.g. BlackHole 2ch)
  - Route system output to that device (or create a Multi‑Output/aggregate device if needed)
  - Click “Refresh devices”, then select your mic and the virtual device as “System audio”

- Windows system audio:
  - Install VB‑Audio Cable or VoiceMeeter
  - Set Windows output to the virtual device (or use “Stereo Mix” if available)
  - Click “Refresh devices”, pick mic and the virtual device for “System audio”

- Linux system audio:
  - With PulseAudio, choose the monitor of your output sink (e.g. `alsa_output.*.monitor`)
  - Click “Refresh devices”, then select mic and the monitor device

Use “Test audio config” to record a 1‑second MP3. If it fails, verify permissions, backend, and selected devices.

### 5) Obsidian output

- Set the “Notes folder” where Resonance will create the generated Markdown notes. If empty, the vault root is used.

### 6) Recording quality and limits

- Adjust sample rate, channels (mono/stereo), MP3 bitrate, and “Max recordings kept”. Older items beyond the limit are auto‑deleted (0 = infinite).

### 7) Done!

- You may need to restart Obsidian after changing settings.

### First run checklist

- FFmpeg path set and working (test passes)
- Whisper repo path + `whisper-cli` set
- Model `.bin` selected (or downloaded)
- API key and model set
- Mic and (optional) system audio selected
- Notes folder set

## Usage

1) Click the microphone icon in the ribbon to start/stop. Pick a scenario when prompted.  
2) Watch the timer in the status bar.  
3) When finished, a note named `<Scenario> YYYY-MM-DD HH-mm.md` is created in your selected folder.  
4) Open the Library (audio file icon) to browse, listen, download or delete recordings and transcripts.

## How it works (overview)

1) FFmpeg writes an `.mp3` to `<vault>/.obsidian/plugins/resonance/recordings/`  
2) whisper.cpp transcribes locally and writes a `.txt` transcript  
3) The LLM of your choice summarizes the transcript  
4) Resonance creates a Markdown note in your chosen folder

## Privacy

- Audio never leaves your machine.
- Only the text transcript is sent for summarization—unless you use Ollama, in which case everything stays local.
- The API Key is stored locally in your vault.

## Troubleshooting

- Incomplete configuration: set FFmpeg path, whisper main, model, and API key.
- No audio: verify backend/device; use Scan and the 3‑second Test.
- Noise in recordings: match the sample rate in settings with your mic.
- Empty transcription: check the `.mp3` file and the model path.
- LLM error: verify API key and selected model.

## Contributing

Issues and PRs are welcome. If you’d like to help with docs or UX, please open an issue to coordinate.

---

Built with Vite. This plugin is desktop‑only.