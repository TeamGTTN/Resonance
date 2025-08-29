import { Notice, TFile } from "obsidian";

// Utility minima per verificare se un percorso esiste ed è eseguibile.
// In ambiente Obsidian desktop (Electron), l'accesso a Node è disponibile.
// Tuttavia alcuni ambienti potrebbero limitare i permessi: gestiamo gli errori con grazia.

export interface DependencyState {
  hasApiKey: boolean;
  ffmpegOk: boolean;
  whisperOk: boolean;
  modelOk: boolean;
  missingMessages: string[];
}

export async function checkDependencies(options: {
  apiKey: string;
  ffmpegPath: string;
  whisperMainPath: string;
  whisperModelPath: string;
}): Promise<DependencyState> {
  const { apiKey, ffmpegPath, whisperMainPath, whisperModelPath } = options;
  const missingMessages: string[] = [];

  const hasApiKey = !!apiKey && apiKey.trim().length > 0;
  if (!hasApiKey) missingMessages.push("Missing API Key");

  let ffmpegOk = false;
  let whisperOk = false;
  let modelOk = false;

  try {
    const fs = (window as any).require?.("fs");
    const access = fs?.access;
    const constants = fs?.constants;

    if (ffmpegPath) {
      await new Promise<void>((resolve) => {
        access(ffmpegPath, constants?.X_OK ?? 1, (err: any) => {
          ffmpegOk = !err;
          resolve();
        });
      });
      if (!ffmpegOk) missingMessages.push("FFmpeg not found or not executable");
    } else {
      missingMessages.push("FFmpeg path not set");
    }

    if (whisperMainPath) {
      await new Promise<void>((resolve) => {
        access(whisperMainPath, constants?.X_OK ?? 1, (err: any) => {
          whisperOk = !err;
          resolve();
        });
      });
      if (!whisperOk) missingMessages.push("whisper.cpp (main) not found or not executable");
    } else {
      missingMessages.push("whisper.cpp (main) path not set");
    }

    if (whisperModelPath) {
      await new Promise<void>((resolve) => {
        access(whisperModelPath, constants?.R_OK ?? 4, (err: any) => {
          modelOk = !err;
          resolve();
        });
      });
      if (!modelOk) missingMessages.push("Whisper model not readable/found");
    } else {
      missingMessages.push("Whisper model path not set");
    }
  } catch (e) {
    // In caso di errore d'accesso a fs (sandbox, permessi), forniamo un fallback prudente
    // senza bloccare l'utente, ma indicando l'impossibilità di verificare completamente.
    if (!ffmpegOk) missingMessages.push("Unable to verify FFmpeg (runtime restrictions)");
    if (!whisperOk) missingMessages.push("Unable to verify whisper.cpp (runtime restrictions)");
    if (!modelOk) missingMessages.push("Unable to verify Whisper model (runtime restrictions)");
  }

  return { hasApiKey, ffmpegOk, whisperOk, modelOk, missingMessages };
}
