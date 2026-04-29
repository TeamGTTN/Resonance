import { getSelectedSummaryModel, type SummaryProviderId } from "./providers";

export type CaptureBackend = "auto" | "avfoundation" | "dshow" | "pulse" | "alsa";
export type CaptureProfile = "transcription" | "balanced" | "natural" | "custom";
export type CaptureEngine = "web" | "ffmpeg";
export type SystemAudioMode = "off" | "loopback" | "share";
export type CaptureRuntimeKind = "web-mic" | "web-multi-input";

export interface CaptureSettings {
  captureEngine: CaptureEngine;
  systemAudioMode: SystemAudioMode;
  ffmpegPath: string;
  backend: CaptureBackend;
  microphoneDevice: string;
  microphoneLabel: string;
  systemDevice: string;
  systemLabel: string;
  sampleRateHz: number;
  channels: 1 | 2;
  bitrateKbps: number;
  segmentDurationSeconds: number;
  captureProfile: CaptureProfile;
  micGainDb: number;
  systemGainDb: number;
  noiseSuppression: boolean;
  limiter: boolean;
}

export interface TranscriptionSettings {
  whisperRepoPath: string;
  whisperCliPath: string;
  modelPath: string;
  modelPreset: "base" | "small" | "medium" | "large";
  language: string;
  beamSize: number;
  entropyThreshold: number;
  logprobThreshold: number;
}

export interface SummarySettings {
  provider: SummaryProviderId;
  ollamaEndpoint: string;
  ollamaModel: string;
  geminiApiKey: string;
  geminiModel: string;
  openaiApiKey: string;
  openaiModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
}

export interface OutputSettings {
  vaultFolder: string;
  storeLiveTranscriptInVault: boolean;
  openSummaryAfterCreate: boolean;
  maxSessionsKept: number;
}

export interface UiSettings {
  lastScenarioKey?: string;
  showSetupWizardOnStartup: boolean;
  showDiagnosticsOnStartup: boolean;
}

export interface DiagnosticsSettings {
  quickTestDurationSeconds: number;
}

export interface PluginSettingsV2 {
  version: 2;
  capture: CaptureSettings;
  transcription: TranscriptionSettings;
  summary: SummarySettings;
  output: OutputSettings;
  ui: UiSettings;
  diagnostics: DiagnosticsSettings;
}

export const DEFAULT_SETTINGS_V2: PluginSettingsV2 = {
  version: 2,
  capture: {
    captureEngine: "web",
    systemAudioMode: "off",
    ffmpegPath: "",
    backend: "auto",
    microphoneDevice: "",
    microphoneLabel: "",
    systemDevice: "",
    systemLabel: "",
    sampleRateHz: 48000,
    channels: 1,
    bitrateKbps: 160,
    segmentDurationSeconds: 20,
    captureProfile: "balanced",
    micGainDb: 0,
    systemGainDb: 0,
    noiseSuppression: true,
    limiter: true,
  },
  transcription: {
    whisperRepoPath: "",
    whisperCliPath: "",
    modelPath: "",
    modelPreset: "small",
    language: "auto",
    beamSize: 5,
    entropyThreshold: 2.4,
    logprobThreshold: -1.0,
  },
  summary: {
    provider: "ollama",
    ollamaEndpoint: "http://localhost:11434",
    ollamaModel: "gemma3",
    geminiApiKey: "",
    geminiModel: "gemini-2.5-flash",
    openaiApiKey: "",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "",
    anthropicModel: "claude-3-5-sonnet-latest",
  },
  output: {
    vaultFolder: "Resonance",
    storeLiveTranscriptInVault: true,
    openSummaryAfterCreate: true,
    maxSessionsKept: 20,
  },
  ui: {
    lastScenarioKey: undefined,
    showSetupWizardOnStartup: true,
    showDiagnosticsOnStartup: false,
  },
  diagnostics: {
    quickTestDurationSeconds: 2,
  },
};

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.max(min, Math.min(max, parsed)) * 10) / 10;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeCaptureSettings(raw: unknown): CaptureSettings {
  const input = (raw ?? {}) as Partial<CaptureSettings>;
  const backend = input.backend;
  const profile = input.captureProfile;
  const captureEngine = inferCaptureEngine(input);
  const systemAudioMode = inferSystemAudioMode(input);
  return {
    captureEngine,
    systemAudioMode,
    ffmpegPath: asString(input.ffmpegPath),
    backend:
      backend === "avfoundation" || backend === "dshow" || backend === "pulse" || backend === "alsa" || backend === "auto"
        ? backend
        : DEFAULT_SETTINGS_V2.capture.backend,
    microphoneDevice: asString(input.microphoneDevice),
    microphoneLabel: asString(input.microphoneLabel),
    systemDevice: asString(input.systemDevice),
    systemLabel: asString(input.systemLabel),
    sampleRateHz: clampInteger(input.sampleRateHz, DEFAULT_SETTINGS_V2.capture.sampleRateHz, 8_000, 192_000),
    channels: clampInteger(input.channels, DEFAULT_SETTINGS_V2.capture.channels, 1, 2) === 1 ? 1 : 2,
    bitrateKbps: clampInteger(input.bitrateKbps, DEFAULT_SETTINGS_V2.capture.bitrateKbps, 64, 320),
    segmentDurationSeconds: clampInteger(input.segmentDurationSeconds, DEFAULT_SETTINGS_V2.capture.segmentDurationSeconds, 5, 300),
    captureProfile:
      profile === "transcription" || profile === "balanced" || profile === "natural" || profile === "custom"
        ? profile
        : DEFAULT_SETTINGS_V2.capture.captureProfile,
    micGainDb: clampFloat(input.micGainDb, DEFAULT_SETTINGS_V2.capture.micGainDb, -12, 12),
    systemGainDb: clampFloat(input.systemGainDb, DEFAULT_SETTINGS_V2.capture.systemGainDb, -12, 12),
    noiseSuppression: asBoolean(input.noiseSuppression, DEFAULT_SETTINGS_V2.capture.noiseSuppression),
    limiter: asBoolean(input.limiter, DEFAULT_SETTINGS_V2.capture.limiter),
  };
}

function inferCaptureEngine(input: Partial<CaptureSettings>): CaptureEngine {
  if (input.captureEngine === "web" || input.captureEngine === "ffmpeg") {
    return input.captureEngine;
  }

  return DEFAULT_SETTINGS_V2.capture.captureEngine;
}

function inferSystemAudioMode(input: Partial<CaptureSettings>): SystemAudioMode {
  if (input.systemAudioMode === "off" || input.systemAudioMode === "loopback") {
    return input.systemAudioMode;
  }

  if (input.systemAudioMode === "share") {
    return "off";
  }

  if (asString(input.systemDevice).trim() || asString(input.systemLabel).trim()) {
    return "loopback";
  }

  return DEFAULT_SETTINGS_V2.capture.systemAudioMode;
}

function normalizeTranscriptionSettings(raw: unknown): TranscriptionSettings {
  const input = (raw ?? {}) as Partial<TranscriptionSettings>;
  const preset = input.modelPreset;
  return {
    whisperRepoPath: asString(input.whisperRepoPath),
    whisperCliPath: asString(input.whisperCliPath),
    modelPath: asString(input.modelPath),
    modelPreset:
      preset === "base" || preset === "small" || preset === "medium" || preset === "large"
        ? preset
        : DEFAULT_SETTINGS_V2.transcription.modelPreset,
    language: asString(input.language, DEFAULT_SETTINGS_V2.transcription.language),
    beamSize: clampInteger(input.beamSize, DEFAULT_SETTINGS_V2.transcription.beamSize, 1, 10),
    entropyThreshold: Number.isFinite(Number(input.entropyThreshold))
      ? Number(input.entropyThreshold)
      : DEFAULT_SETTINGS_V2.transcription.entropyThreshold,
    logprobThreshold: Number.isFinite(Number(input.logprobThreshold))
      ? Number(input.logprobThreshold)
      : DEFAULT_SETTINGS_V2.transcription.logprobThreshold,
  };
}

function normalizeSummarySettings(raw: unknown): SummarySettings {
  const input = (raw ?? {}) as Partial<SummarySettings>;
  const provider = input.provider;
  return {
    provider:
      provider === "ollama" || provider === "gemini" || provider === "openai" || provider === "anthropic"
        ? provider
        : DEFAULT_SETTINGS_V2.summary.provider,
    ollamaEndpoint: asString(input.ollamaEndpoint, DEFAULT_SETTINGS_V2.summary.ollamaEndpoint),
    ollamaModel: asString(input.ollamaModel, DEFAULT_SETTINGS_V2.summary.ollamaModel),
    geminiApiKey: asString(input.geminiApiKey),
    geminiModel: asString(input.geminiModel, DEFAULT_SETTINGS_V2.summary.geminiModel),
    openaiApiKey: asString(input.openaiApiKey),
    openaiModel: asString(input.openaiModel, DEFAULT_SETTINGS_V2.summary.openaiModel),
    anthropicApiKey: asString(input.anthropicApiKey),
    anthropicModel: asString(input.anthropicModel, DEFAULT_SETTINGS_V2.summary.anthropicModel),
  };
}

function normalizeOutputSettings(raw: unknown): OutputSettings {
  const input = (raw ?? {}) as Partial<OutputSettings>;
  return {
    vaultFolder: asString(input.vaultFolder, DEFAULT_SETTINGS_V2.output.vaultFolder),
    storeLiveTranscriptInVault: asBoolean(input.storeLiveTranscriptInVault, DEFAULT_SETTINGS_V2.output.storeLiveTranscriptInVault),
    openSummaryAfterCreate: asBoolean(input.openSummaryAfterCreate, DEFAULT_SETTINGS_V2.output.openSummaryAfterCreate),
    maxSessionsKept: clampInteger(input.maxSessionsKept, DEFAULT_SETTINGS_V2.output.maxSessionsKept, 0, 500),
  };
}

function normalizeUiSettings(raw: unknown): UiSettings {
  const input = (raw ?? {}) as Partial<UiSettings>;
  return {
    lastScenarioKey: asString(input.lastScenarioKey) || undefined,
    showSetupWizardOnStartup: asBoolean(input.showSetupWizardOnStartup, DEFAULT_SETTINGS_V2.ui.showSetupWizardOnStartup),
    showDiagnosticsOnStartup: asBoolean(input.showDiagnosticsOnStartup, DEFAULT_SETTINGS_V2.ui.showDiagnosticsOnStartup),
  };
}

function normalizeDiagnosticsSettings(raw: unknown): DiagnosticsSettings {
  const input = (raw ?? {}) as Partial<DiagnosticsSettings>;
  return {
    quickTestDurationSeconds: clampInteger(
      input.quickTestDurationSeconds,
      DEFAULT_SETTINGS_V2.diagnostics.quickTestDurationSeconds,
      1,
      10
    ),
  };
}

export function normalizeSettingsV2(raw: unknown): PluginSettingsV2 {
  const input = (raw ?? {}) as Partial<PluginSettingsV2>;
  const summary = normalizeSummarySettings(input.summary);
  return {
    version: 2,
    capture: normalizeCaptureSettings(input.capture),
    transcription: normalizeTranscriptionSettings(input.transcription),
    summary,
    output: normalizeOutputSettings(input.output),
    ui: normalizeUiSettings(input.ui),
    diagnostics: normalizeDiagnosticsSettings(input.diagnostics),
  };
}

export function resolveCaptureBackend(
  backend: CaptureBackend,
  platform: NodeJS.Platform = process.platform
): "avfoundation" | "dshow" | "pulse" | "alsa" {
  if (backend !== "auto") return backend;
  if (platform === "darwin") return "avfoundation";
  if (platform === "win32") return "dshow";
  return "pulse";
}

export function getSelectedProviderApiKey(settings: SummarySettings): string {
  switch (settings.provider) {
    case "gemini":
      return settings.geminiApiKey;
    case "openai":
      return settings.openaiApiKey;
    case "anthropic":
      return settings.anthropicApiKey;
    case "ollama":
    default:
      return "";
  }
}

export function isLikelyTestWhisperModelPath(modelPath: string): boolean {
  const normalized = modelPath.replace(/\\/g, "/").trim().toLowerCase();
  if (!normalized) return false;
  const basename = normalized.split("/").pop() ?? "";
  return basename.startsWith("for-tests-");
}

export function isCoreConfigured(settings: PluginSettingsV2): boolean {
  const selectedModel = getSelectedSummaryModel(settings.summary);
  if (settings.capture.systemAudioMode === "loopback" && !settings.capture.systemDevice.trim()) return false;
  if (!settings.transcription.whisperCliPath.trim()) return false;
  if (!settings.transcription.modelPath.trim()) return false;
  if (isLikelyTestWhisperModelPath(settings.transcription.modelPath)) return false;
  if (settings.summary.provider === "ollama") {
    return !!settings.summary.ollamaEndpoint.trim() && !!selectedModel.trim();
  }
  return !!selectedModel.trim() && !!getSelectedProviderApiKey(settings.summary).trim();
}

export function isSystemAudioEnabled(capture: CaptureSettings): boolean {
  return capture.systemAudioMode !== "off";
}

export function isLoopbackSystemAudioEnabled(capture: CaptureSettings): boolean {
  return capture.systemAudioMode === "loopback";
}

export function resolveCaptureRuntime(capture: CaptureSettings): CaptureRuntimeKind {
  if (capture.systemAudioMode === "loopback") {
    return "web-multi-input";
  }
  return "web-mic";
}
