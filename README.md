# Resonance

Resonance is the clean-slate v2 of the Obsidian recording plugin. The product is now built around a local-first pipeline, settings-first setup, and manifest-backed session storage.

## Fastest Setup

If this machine already has `FFmpeg`, a built `whisper.cpp`, and at least one local ggml model:

1. Open the plugin settings page.
2. Work through **Step 1**, **Step 2**, and **Step 3** from top to bottom.
3. Use the Detect buttons to fill paths automatically when possible.
4. Pick a microphone and run **Quick test**.
5. Leave **Ollama** as the provider unless you intentionally want a cloud provider.

The settings page is now the full setup flow. Nothing important is hidden behind a separate setup modal.

## What Changed

- `src/` is the only active application tree for v2.
- The primary entrypoint is now the plugin settings surface instead of a simple start/stop flow.
- Recording state is driven by an explicit session controller with ordered live transcription.
- Sessions are stored as structured manifests with `audio/`, `transcript/`, `summary/`, and `diagnostics.log`.
- The session library is manifest-backed. It no longer scans raw media files blindly.

## Product Direction

- Desktop-only Obsidian plugin
- Local-first path: `FFmpeg` + `whisper.cpp` + `Ollama`
- Cloud summary providers remain available as secondary adapters
- Native Obsidian settings are now the primary surface, with horizontal tabs for diagnostics, library, and setup

## Current Information Architecture

- Diagnostics
  - Health status and blocking issues
  - Quick test
  - Startup behavior
  - Setup guidance when the local path is incomplete
- Setup & Settings
  - Horizontal tabs for Diagnostics, Library, Capture, Transcription, Summary, and Output
  - Capture tab for FFmpeg, devices, and quick test
  - Transcription tab for whisper.cpp, CLI, and model
  - Summary tab for Ollama or cloud providers
  - Output tab for vault, retention, and startup behavior
- Session Library
  - Filters for `done` and `failed`
  - Artifact availability
  - Transcript, diagnostics, audio, and summary actions

## Repository Layout

```text
src/            Active Resonance v2 source
tests/          Pure unit tests for v2
legacy/         Archived v1 runtime files kept for reference
dist/           Build output
```

## Local Development

Requirements:

- Obsidian desktop
- Node.js
- FFmpeg
- whisper.cpp with a local model
- Ollama if you want the full tier-1 local path

Commands:

```bash
npm run typecheck
npm test
npm run build
```

## Install In Obsidian

1. Build the plugin with `npm run build`.
2. Copy `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` into your vault plugin folder.
3. Enable `Resonance` in Obsidian community plugins.
4. Open the plugin settings page.
5. Use the `Capture` tab for FFmpeg and devices, then `Transcription` and `Summary`.
6. When setup is done, use the `Diagnostics` tab for health and the `Library` tab for saved session artifacts.

## Minimum Local Requirements

To record and summarize locally, Resonance needs:

- `FFmpeg`
- `whisper.cpp` CLI
- a readable local ggml model file
- `Ollama` running locally for summaries

If auto-detect fails, the manual fallback is:

1. Point Step 3 in plugin settings at your `whisper.cpp` repo.
2. Detect or set the `whisper.cpp` CLI path.
3. Detect or set the ggml model path.
4. Return to Step 2 and run the quick test.

## Runtime Model

Each session persists:

- `session.json`
- `audio/recording.mp3`
- `audio/segments/`
- `transcript/live-transcript.txt`
- `summary/summary.md`
- `diagnostics.log`

The live transcription queue commits segments strictly in order and the stop flow waits for the queue to flush before summary generation starts.

## Notes On Legacy Code

The previous implementation is archived under `legacy/`. It is not part of the active v2 runtime, build entry, or test surface.
