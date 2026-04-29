import { getSelectedSummaryModel, type SummaryProviderId } from "./providers";

export interface CaptureSourceSelection {
  deviceId: string;
  label: string;
}

export interface CaptureSettings {
  microphone: CaptureSourceSelection;
  additionalSources: CaptureSourceSelection[];
  segmentDurationSeconds: number;
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

export interface PluginSettings {
  version: 3;
  capture: CaptureSettings;
  transcription: TranscriptionSettings;
  summary: SummarySettings;
  output: OutputSettings;
  ui: UiSettings;
  diagnostics: DiagnosticsSettings;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  version: 3,
  capture: {
    microphone: {
      deviceId: "",
      label: "",
    },
    additionalSources: [],
    segmentDurationSeconds: 20,
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

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeCaptureSource(raw: unknown, allowDefault = true): CaptureSourceSelection {
  const input = (raw ?? {}) as Partial<CaptureSourceSelection>;
  const rawDeviceId = asString(input.deviceId).trim();
  const deviceId = allowDefault && rawDeviceId === "default" ? "" : rawDeviceId;
  return {
    deviceId,
    label: asString(input.label).trim(),
  };
}

function normalizeAdditionalSources(raw: unknown, microphoneDeviceId: string): CaptureSourceSelection[] {
  const rawSources = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const normalized: CaptureSourceSelection[] = [];

  for (const entry of rawSources) {
    const source = normalizeCaptureSource(entry, false);
    if (!source.deviceId || source.deviceId === microphoneDeviceId || seen.has(source.deviceId)) continue;
    seen.add(source.deviceId);
    normalized.push(source);
  }

  return normalized;
}

function normalizeCaptureSettings(raw: unknown): CaptureSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const microphone = normalizeCaptureSource(input.microphone, true);
  const additionalSources = normalizeAdditionalSources(input.additionalSources, microphone.deviceId);

  return {
    microphone,
    additionalSources,
    segmentDurationSeconds: clampInteger(
      input.segmentDurationSeconds,
      DEFAULT_SETTINGS.capture.segmentDurationSeconds,
      5,
      300
    ),
  };
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
        : DEFAULT_SETTINGS.transcription.modelPreset,
    language: asString(input.language, DEFAULT_SETTINGS.transcription.language),
    beamSize: clampInteger(input.beamSize, DEFAULT_SETTINGS.transcription.beamSize, 1, 10),
    entropyThreshold: Number.isFinite(Number(input.entropyThreshold))
      ? Number(input.entropyThreshold)
      : DEFAULT_SETTINGS.transcription.entropyThreshold,
    logprobThreshold: Number.isFinite(Number(input.logprobThreshold))
      ? Number(input.logprobThreshold)
      : DEFAULT_SETTINGS.transcription.logprobThreshold,
  };
}

function normalizeSummarySettings(raw: unknown): SummarySettings {
  const input = (raw ?? {}) as Partial<SummarySettings>;
  const provider = input.provider;
  return {
    provider:
      provider === "ollama" || provider === "gemini" || provider === "openai" || provider === "anthropic"
        ? provider
        : DEFAULT_SETTINGS.summary.provider,
    ollamaEndpoint: asString(input.ollamaEndpoint, DEFAULT_SETTINGS.summary.ollamaEndpoint),
    ollamaModel: asString(input.ollamaModel, DEFAULT_SETTINGS.summary.ollamaModel),
    geminiApiKey: asString(input.geminiApiKey),
    geminiModel: asString(input.geminiModel, DEFAULT_SETTINGS.summary.geminiModel),
    openaiApiKey: asString(input.openaiApiKey),
    openaiModel: asString(input.openaiModel, DEFAULT_SETTINGS.summary.openaiModel),
    anthropicApiKey: asString(input.anthropicApiKey),
    anthropicModel: asString(input.anthropicModel, DEFAULT_SETTINGS.summary.anthropicModel),
  };
}

function normalizeOutputSettings(raw: unknown): OutputSettings {
  const input = (raw ?? {}) as Partial<OutputSettings>;
  return {
    vaultFolder: asString(input.vaultFolder, DEFAULT_SETTINGS.output.vaultFolder),
    storeLiveTranscriptInVault: asBoolean(
      input.storeLiveTranscriptInVault,
      DEFAULT_SETTINGS.output.storeLiveTranscriptInVault
    ),
    openSummaryAfterCreate: asBoolean(input.openSummaryAfterCreate, DEFAULT_SETTINGS.output.openSummaryAfterCreate),
    maxSessionsKept: clampInteger(input.maxSessionsKept, DEFAULT_SETTINGS.output.maxSessionsKept, 0, 500),
  };
}

function normalizeUiSettings(raw: unknown): UiSettings {
  const input = (raw ?? {}) as Partial<UiSettings>;
  return {
    lastScenarioKey: asString(input.lastScenarioKey) || undefined,
    showSetupWizardOnStartup: asBoolean(input.showSetupWizardOnStartup, DEFAULT_SETTINGS.ui.showSetupWizardOnStartup),
    showDiagnosticsOnStartup: asBoolean(input.showDiagnosticsOnStartup, DEFAULT_SETTINGS.ui.showDiagnosticsOnStartup),
  };
}

function normalizeDiagnosticsSettings(raw: unknown): DiagnosticsSettings {
  const input = (raw ?? {}) as Partial<DiagnosticsSettings>;
  return {
    quickTestDurationSeconds: clampInteger(
      input.quickTestDurationSeconds,
      DEFAULT_SETTINGS.diagnostics.quickTestDurationSeconds,
      1,
      10
    ),
  };
}

export function normalizeSettings(raw: unknown): PluginSettings {
  const input = (raw ?? {}) as Partial<PluginSettings>;
  return {
    version: 3,
    capture: normalizeCaptureSettings(input.capture),
    transcription: normalizeTranscriptionSettings(input.transcription),
    summary: normalizeSummarySettings(input.summary),
    output: normalizeOutputSettings(input.output),
    ui: normalizeUiSettings(input.ui),
    diagnostics: normalizeDiagnosticsSettings(input.diagnostics),
  };
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

export function isCoreConfigured(settings: PluginSettings): boolean {
  const selectedModel = getSelectedSummaryModel(settings.summary);
  if (!settings.transcription.whisperCliPath.trim()) return false;
  if (!settings.transcription.modelPath.trim()) return false;
  if (isLikelyTestWhisperModelPath(settings.transcription.modelPath)) return false;
  if (settings.summary.provider === "ollama") {
    return !!settings.summary.ollamaEndpoint.trim() && !!selectedModel.trim();
  }
  return !!selectedModel.trim() && !!getSelectedProviderApiKey(settings.summary).trim();
}

export function hasAdditionalCaptureSources(capture: CaptureSettings): boolean {
  return capture.additionalSources.length > 0;
}
