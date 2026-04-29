import type { App } from "obsidian";
import { getProviderCapabilities } from "../../domain/providers";
import {
  getSelectedProviderApiKey,
  isLikelyTestWhisperModelPath,
  isCoreConfigured,
  resolveCaptureBackend,
  type PluginSettingsV2,
} from "../../domain/settings";
import type { DiagnosticCheck, DiagnosticsReport } from "../../domain/diagnostics";
import { CAPTURE_PROFILE_LABELS } from "../../domain/captureProfiles";
import { requireNodeModule } from "../node";
import { resolveCaptureInputs } from "../adapters/captureUtils";
import { WhisperTranscriptionAdapter } from "../adapters/TranscriptionAdapter";
import { scanDevices } from "./deviceScanner";

export interface SmokeTestResult {
  ok: boolean;
  detail: string;
}

export class DiagnosticsService {
  constructor(private readonly app: App) {}

  async run(settings: PluginSettingsV2): Promise<DiagnosticsReport> {
    const fs = requireNodeModule<{
      accessSync: (path: string, mode?: number) => void;
      constants: { F_OK: number; R_OK: number; X_OK: number };
      existsSync: (path: string) => boolean;
      statSync: (path: string) => { size: number };
    }>("fs");
    const checks: DiagnosticCheck[] = [];
    const backend = resolveCaptureBackend(settings.capture.backend);
    const addCheck = (check: DiagnosticCheck) => checks.push(check);
    const fileMode = process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;

    const testPath = (path: string, mode: number): boolean => {
      try {
        fs.accessSync(path, mode);
        return true;
      } catch {
        return false;
      }
    };

    addCheck({
      id: "core-config",
      label: "Core configuration",
      severity: isCoreConfigured(settings) ? "ok" : "error",
      detail: isCoreConfigured(settings)
        ? "Core local-first path is configured."
        : "FFmpeg, whisper.cpp, model, or summary provider configuration is incomplete.",
      remediation: "Open Setup & Settings in the plugin settings tab and complete the missing dependency step.",
    });

    addCheck({
      id: "ffmpeg",
      label: "FFmpeg binary",
      severity: testPath(settings.capture.ffmpegPath, fileMode) ? "ok" : "error",
      detail: settings.capture.ffmpegPath
        ? `Configured path: ${settings.capture.ffmpegPath}`
        : "FFmpeg path is empty.",
      remediation: "Set the FFmpeg executable path or use auto-detect.",
    });

    addCheck({
      id: "whisper-cli",
      label: "whisper.cpp CLI",
      severity: testPath(settings.transcription.whisperCliPath, fileMode) ? "ok" : "error",
      detail: settings.transcription.whisperCliPath
        ? `Configured path: ${settings.transcription.whisperCliPath}`
        : "whisper.cpp CLI path is empty.",
      remediation: "Build whisper.cpp and point the plugin to whisper-cli.",
    });

    addCheck({
      id: "whisper-model",
      label: "Whisper model",
      severity: getWhisperModelSeverity(settings.transcription.modelPath, fs),
      detail: getWhisperModelDetail(settings.transcription.modelPath, fs),
      remediation: getWhisperModelRemediation(settings.transcription.modelPath, fs),
    });

    if (!settings.capture.microphoneDevice.trim()) {
      addCheck({
        id: "microphone",
        label: "Microphone selection",
        severity: "warning",
        detail: "No microphone device selected yet.",
        remediation: "Refresh devices and select the main microphone input.",
      });
    }

    try {
      if (settings.capture.ffmpegPath.trim()) {
        const devices = await scanDevices(settings.capture.ffmpegPath, backend);
        const audioDevices = devices.filter((device) => device.type === "audio");
        const micPresent = !settings.capture.microphoneDevice.trim()
          ? false
          : audioDevices.some((device) => device.name === settings.capture.microphoneDevice || device.label === settings.capture.microphoneLabel);
        addCheck({
          id: "device-scan",
          label: "Audio devices",
          severity: audioDevices.length > 0 ? "ok" : "warning",
          detail: audioDevices.length > 0
            ? `${audioDevices.length} audio devices discovered for backend ${backend}.`
            : `No audio devices discovered for backend ${backend}.`,
          remediation: "Check OS permissions, FFmpeg backend, and input devices.",
        });
        if (settings.capture.microphoneDevice.trim()) {
          addCheck({
            id: "selected-microphone",
            label: "Selected microphone",
            severity: micPresent ? "ok" : "warning",
            detail: micPresent
              ? "Selected microphone is present in the current FFmpeg scan."
              : "Selected microphone was not found in the current FFmpeg scan.",
            remediation: "Refresh devices and reselect the microphone if indexes changed.",
          });
        }
      }
    } catch (error) {
      addCheck({
        id: "device-scan",
        label: "Audio devices",
        severity: "warning",
        detail: `Device scan failed: ${String((error as Error)?.message ?? error)}`,
        remediation: "Verify FFmpeg path and backend compatibility.",
      });
    }

    const providerCapabilities = getProviderCapabilities(settings.summary.provider);
    if (providerCapabilities.kind === "local") {
      const ollamaHealthy = await this.checkOllamaHealth(settings.summary.ollamaEndpoint);
      addCheck({
        id: "ollama",
        label: "Ollama endpoint",
        severity: ollamaHealthy.ok ? "ok" : "error",
        detail: ollamaHealthy.detail,
        remediation: "Start Ollama locally or fix the configured endpoint.",
      });
    } else {
      addCheck({
        id: "cloud-provider-key",
        label: `${providerCapabilities.label} API key`,
        severity: getSelectedProviderApiKey(settings.summary).trim() ? "ok" : "error",
        detail: getSelectedProviderApiKey(settings.summary).trim()
          ? `${providerCapabilities.label} API key is configured.`
          : `${providerCapabilities.label} API key is missing.`,
        remediation: "Set the selected provider API key or switch back to Ollama.",
      });
    }

    addCheck({
      id: "vault-output",
      label: "Vault output",
      severity: this.app.vault.getName() ? "ok" : "warning",
      detail: settings.output.vaultFolder.trim()
        ? `Target vault folder: ${settings.output.vaultFolder}`
        : "The session folder will be created at the vault root.",
      remediation: "Set a dedicated output folder if you want generated notes grouped together.",
    });

    const profileLabel = CAPTURE_PROFILE_LABELS[settings.capture.captureProfile];
    const transcriptionWithNonStandardRate =
      settings.capture.captureProfile === "transcription" && settings.capture.sampleRateHz !== 48000;
    addCheck({
      id: "capture-profile",
      label: "Audio processing profile",
      severity: transcriptionWithNonStandardRate ? "warning" : "ok",
      detail: transcriptionWithNonStandardRate
        ? `Profile: ${profileLabel}. Sample rate ${settings.capture.sampleRateHz} Hz with the Transcription profile can cause extra resampling artifacts. Consider switching to 48000 Hz.`
        : `Profile: ${profileLabel}. Active on next recording.`,
      remediation: "Switch to Balanced or Natural profile if audio sounds robotic, or set sample rate to 48000 Hz.",
    });

    const blockingIssueIds = checks.filter((check) => check.severity === "error").map((check) => check.id);
    const warningIds = checks.filter((check) => check.severity === "warning").map((check) => check.id);
    return {
      checkedAt: new Date().toISOString(),
      provider: settings.summary.provider,
      backend,
      checks,
      blockingIssueIds,
      warningIds,
      isHealthy: blockingIssueIds.length === 0,
      summary:
        blockingIssueIds.length === 0
          ? "Diagnostics passed without blocking issues."
          : `Diagnostics found ${blockingIssueIds.length} blocking issue(s) and ${warningIds.length} warning(s).`,
    };
  }

  async runSmokeTest(settings: PluginSettingsV2): Promise<SmokeTestResult> {
    if (!settings.capture.ffmpegPath.trim()) {
      return { ok: false, detail: "FFmpeg path is missing." };
    }
    const resolvedInputs = await resolveCaptureInputs(settings.capture);
    if (!resolvedInputs.micSpec) {
      return { ok: false, detail: "No microphone input is configured." };
    }

    const fs = requireNodeModule<{
      mkdtempSync: (prefix: string) => string;
      existsSync: (path: string) => boolean;
      unlinkSync: (path: string) => void;
      rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
    }>("fs");
    const os = requireNodeModule<{ tmpdir: () => string }>("os");
    const path = requireNodeModule<{ join: (...parts: string[]) => string }>("path");
    const { spawn } = requireNodeModule<{ spawn: Function }>("child_process");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-next-smoke-"));
    const audioPath = path.join(tmpRoot, "smoke.mp3");
    const args = [
      "-y",
      "-f",
      resolvedInputs.backend,
      "-thread_queue_size",
      "1024",
      "-i",
      resolvedInputs.micSpec,
      "-t",
      String(settings.diagnostics.quickTestDurationSeconds),
      "-vn",
      "-ar",
      String(settings.capture.sampleRateHz),
      "-ac",
      String(settings.capture.channels),
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${settings.capture.bitrateKbps}k`,
      audioPath,
    ];

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(settings.capture.ffmpegPath, args);
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", (error: Error) => reject(error));
        child.on("close", (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `FFmpeg exited with code ${code}`));
        });
      });

      if (settings.transcription.whisperCliPath.trim() && settings.transcription.modelPath.trim() && fs.existsSync(audioPath)) {
        const adapter = new WhisperTranscriptionAdapter(settings.transcription, settings.capture.ffmpegPath);
        const transcript = await adapter.transcribeFile(audioPath);
        if (!transcript.trim()) {
          return { ok: false, detail: "Quick test recorded audio, but whisper.cpp returned an empty transcript." };
        }
      }

      if (getProviderCapabilities(settings.summary.provider).kind === "local") {
        const ollamaHealth = await this.checkOllamaHealth(settings.summary.ollamaEndpoint);
        if (!ollamaHealth.ok) return ollamaHealth;
      }

      return { ok: true, detail: "Quick smoke test completed." };
    } catch (error) {
      return { ok: false, detail: String((error as Error)?.message ?? error) };
    } finally {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    }
  }

  private async checkOllamaHealth(endpoint: string): Promise<SmokeTestResult> {
    const base = endpoint.trim() || "http://localhost:11434";
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 3_000);
      const response = await fetch(`${base}/api/tags`, { signal: controller.signal });
      window.clearTimeout(timeoutId);
      if (!response.ok) {
        return { ok: false, detail: `Ollama endpoint returned ${response.status}.` };
      }
      return { ok: true, detail: `Ollama reachable at ${base}.` };
    } catch (error) {
      return { ok: false, detail: `Ollama check failed: ${String((error as Error)?.message ?? error)}` };
    }
  }
}

function getWhisperModelSeverity(
  modelPath: string,
  fs: {
    constants: { R_OK: number };
    accessSync: (path: string, mode?: number) => void;
    existsSync: (path: string) => boolean;
    statSync: (path: string) => { size: number };
  }
): "ok" | "error" {
  if (!modelPath) return "error";
  if (isLikelyTestWhisperModelPath(modelPath)) return "error";
  try {
    fs.accessSync(modelPath, fs.constants.R_OK);
    return fs.statSync(modelPath).size >= 10 * 1024 * 1024 ? "ok" : "error";
  } catch {
    return "error";
  }
}

function getWhisperModelDetail(
  modelPath: string,
  fs: {
    existsSync: (path: string) => boolean;
    statSync: (path: string) => { size: number };
  }
): string {
  if (!modelPath) return "Whisper model path is empty.";
  if (isLikelyTestWhisperModelPath(modelPath)) {
    return `Configured path: ${modelPath} (this is a whisper.cpp test model without real weights).`;
  }
  try {
    if (fs.existsSync(modelPath)) {
      const sizeMb = (fs.statSync(modelPath).size / (1024 * 1024)).toFixed(1);
      if (fs.statSync(modelPath).size < 10 * 1024 * 1024) {
        return `Configured path: ${modelPath} (${sizeMb} MiB, suspiciously small for a real Whisper model).`;
      }
      return `Configured path: ${modelPath} (${sizeMb} MiB).`;
    }
  } catch {}
  return `Configured path: ${modelPath}`;
}

function getWhisperModelRemediation(
  modelPath: string,
  fs: {
    existsSync: (path: string) => boolean;
    statSync: (path: string) => { size: number };
  }
): string {
  if (isLikelyTestWhisperModelPath(modelPath)) {
    return "Download a real ggml model such as ggml-base.bin or ggml-small.bin. Do not use files prefixed with for-tests-.";
  }
  try {
    if (modelPath && fs.existsSync(modelPath) && fs.statSync(modelPath).size < 10 * 1024 * 1024) {
      return "Select a real ggml Whisper model. Valid models are typically tens or hundreds of MiB, not a few KiB or MiB.";
    }
  } catch {}
  return "Download or select a readable ggml model file.";
}
