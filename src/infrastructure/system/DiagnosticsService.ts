import type { App } from "obsidian";
import { getProviderCapabilities } from "../../domain/providers";
import {
  getSelectedProviderApiKey,
  isLikelyTestWhisperModelPath,
  isCoreConfigured,
  isLoopbackSystemAudioEnabled,
  type PluginSettingsV2,
} from "../../domain/settings";
import type { DiagnosticCheck, DiagnosticsReport } from "../../domain/diagnostics";
import { requireNodeModule } from "../node";
import { WebCaptureAdapter } from "../adapters/WebCaptureAdapter";
import { WhisperTranscriptionAdapter } from "../adapters/TranscriptionAdapter";
import {
  getMicrophonePermissionState,
  getWebAudioCapability,
  listWebAudioInputDevices,
} from "./webAudio";

export interface SmokeTestResult {
  ok: boolean;
  detail: string;
  cancelled?: boolean;
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
    const loopbackEnabled = isLoopbackSystemAudioEnabled(settings.capture);
    const backend = "web";
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
        : loopbackEnabled
        ? "Web Audio capture is ready, but the additional source, transcription, or summary configuration is still incomplete."
        : "Web Audio capture is ready, but transcription or summary configuration is still incomplete.",
      remediation: "Open Setup & Settings in the plugin settings tab and complete the missing dependency step.",
    });

    const capability = getWebAudioCapability();
    const permissionState = await getMicrophonePermissionState();
    const deviceSnapshot = await listWebAudioInputDevices().catch(async () => ({
      devices: [],
      permissionState,
      labelsAvailable: false,
    }));

    addCheck({
      id: "web-audio",
      label: "Web Audio capture",
      severity: capability.hasGetUserMedia && capability.hasEnumerateDevices ? "ok" : "error",
      detail: capability.hasGetUserMedia && capability.hasEnumerateDevices
        ? `Web Audio APIs are available${permissionState === "granted" ? " and microphone permission is granted." : permissionState === "prompt" ? ". Microphone permission will be requested on first recording." : permissionState === "denied" ? ", but microphone permission is denied." : "."}`
        : "Required browser audio APIs are unavailable in this runtime.",
      remediation:
        permissionState === "denied"
          ? "Re-enable microphone permission for Obsidian in the operating system settings."
          : "Use Obsidian desktop on a Chromium-based runtime that exposes getUserMedia and enumerateDevices.",
    });

    addCheck({
      id: "device-scan",
      label: "Audio input devices",
      severity: deviceSnapshot.devices.length > 0 ? "ok" : "warning",
      detail: deviceSnapshot.devices.length > 0
        ? `${deviceSnapshot.devices.length} audio input${deviceSnapshot.devices.length === 1 ? "" : "s"} discovered via Web Audio.${deviceSnapshot.labelsAvailable ? "" : " Device labels will become more descriptive after microphone permission is granted."}`
        : "No audio inputs were discovered via Web Audio.",
      remediation: "Grant microphone permission and check the OS input devices if the list stays empty.",
    });

    const selectedMic = settings.capture.microphoneDevice.trim();
    const selectedMicPresent = !selectedMic || deviceSnapshot.devices.some((device) => device.deviceId === selectedMic);
    addCheck({
      id: "selected-microphone",
      label: "Selected microphone",
      severity: selectedMicPresent ? "ok" : "warning",
      detail: selectedMic
        ? selectedMicPresent
          ? "Selected microphone is available."
          : "Selected microphone is unavailable. Recording will fall back to the system default input."
        : "No specific microphone selected. Recording will use the system default input.",
      remediation: "Choose a microphone device if you want to pin one instead of following the OS default.",
    });

    if (loopbackEnabled) {
      const selectedAdditional = settings.capture.systemDevice.trim();
      const selectedAdditionalPresent = Boolean(
        selectedAdditional && deviceSnapshot.devices.some((device) => device.deviceId === selectedAdditional)
      );
      const duplicateSource =
        Boolean(selectedAdditional) &&
        selectedAdditionalPresent &&
        selectedMic &&
        selectedAdditional === selectedMic;

      addCheck({
        id: "selected-additional-source",
        label: "Additional source",
        severity: !selectedAdditional
          ? "error"
          : duplicateSource
          ? "error"
          : selectedAdditionalPresent
          ? "ok"
          : "warning",
        detail: !selectedAdditional
          ? "Additional source is enabled, but no second input device is selected."
          : duplicateSource
          ? "The additional source matches the microphone. Pick a different input such as BlackHole or VB-Cable."
          : selectedAdditionalPresent
          ? "Selected additional source is available."
          : "Selected additional source is unavailable. Refresh devices or disable it.",
        remediation:
          "Select a second audioinput device such as BlackHole, VB-Cable, or a monitor source if you want multiple sources in the same recording.",
      });
    }

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
    const capability = getWebAudioCapability();
    const loopbackEnabled = isLoopbackSystemAudioEnabled(settings.capture);
    if (!capability.hasGetUserMedia || !capability.hasEnumerateDevices) {
      return { ok: false, detail: "Web Audio capture is unavailable in this runtime." };
    }

    if (loopbackEnabled && !settings.capture.systemDevice.trim()) {
      return { ok: false, detail: "Additional source is enabled, but no second input device is selected." };
    }

    const fs = requireNodeModule<{
      existsSync: (path: string) => boolean;
      mkdirSync: (path: string, options: { recursive: boolean }) => void;
      mkdtempSync: (prefix: string) => string;
      rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
    }>("fs");
    const os = requireNodeModule<{ tmpdir: () => string }>("os");
    const path = requireNodeModule<{ join: (...parts: string[]) => string }>("path");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-next-web-smoke-"));
    const segmentsDir = path.join(tmpRoot, "segments");
    const audioPath = path.join(tmpRoot, "smoke.wav");
    if (!fs.existsSync(segmentsDir)) {
      fs.mkdirSync(segmentsDir, { recursive: true });
    }

    const adapter = new WebCaptureAdapter();
    try {
      await adapter.start({
        fullAudioPath: audioPath,
        segmentsDir,
        segmentDurationSeconds: Math.max(1, settings.diagnostics.quickTestDurationSeconds),
        microphoneDevice: settings.capture.microphoneDevice,
        additionalSources:
          loopbackEnabled && settings.capture.systemDevice.trim()
            ? [
                {
                  deviceId: settings.capture.systemDevice.trim(),
                  label: settings.capture.systemLabel.trim() || "Additional source",
                },
              ]
            : [],
        onSegmentReady: () => {},
      });

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, Math.max(300, settings.diagnostics.quickTestDurationSeconds * 1_000));
      });
      await adapter.stop();

      if (settings.transcription.whisperCliPath.trim() && settings.transcription.modelPath.trim() && fs.existsSync(audioPath)) {
        const transcriptionAdapter = new WhisperTranscriptionAdapter(settings.transcription, settings.capture.ffmpegPath);
        const transcript = await transcriptionAdapter.transcribeFile(audioPath);
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
        if (adapter.isRunning()) {
          await adapter.stop();
        }
      } catch {}
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
