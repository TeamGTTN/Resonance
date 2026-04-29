import type { CaptureSettings, CaptureProfile } from "./settings";

export interface ResolvedAudioProfile {
  micGainDb: number;
  systemGainDb: number;
  micMixWeight: number;
  systemMixWeight: number;
  highpassHz: number | null;
  lowpassHz: number | null;
  limiter: boolean;
  limiterCeiling: number;
}

const PROFILES: Record<Exclude<CaptureProfile, "custom">, ResolvedAudioProfile> = {
  transcription: {
    micGainDb: 6.6,
    systemGainDb: 0,
    micMixWeight: 1.65,
    systemMixWeight: 0.75,
    highpassHz: 80,
    lowpassHz: 7000,
    limiter: true,
    limiterCeiling: 0.95,
  },
  balanced: {
    micGainDb: 3.0,
    systemGainDb: 0,
    micMixWeight: 1.2,
    systemMixWeight: 0.9,
    highpassHz: 80,
    lowpassHz: 12000,
    limiter: true,
    limiterCeiling: 0.95,
  },
  natural: {
    micGainDb: 0,
    systemGainDb: 0,
    micMixWeight: 1.0,
    systemMixWeight: 1.0,
    highpassHz: null,
    lowpassHz: null,
    limiter: true,
    limiterCeiling: 0.98,
  },
};

function dbToLinear(db: number): number {
  return Math.round(Math.pow(10, db / 20) * 1000) / 1000;
}

export function resolveAudioProfile(settings: CaptureSettings): ResolvedAudioProfile {
  if (settings.captureProfile !== "custom") {
    return PROFILES[settings.captureProfile];
  }

  return {
    micGainDb: settings.micGainDb,
    systemGainDb: settings.systemGainDb,
    micMixWeight: 1.0,
    systemMixWeight: 1.0,
    highpassHz: settings.noiseSuppression ? 80 : null,
    lowpassHz: settings.noiseSuppression ? 12000 : null,
    limiter: settings.limiter,
    limiterCeiling: 0.95,
  };
}

function buildMicFilters(profile: ResolvedAudioProfile): string {
  const parts: string[] = [];
  if (profile.highpassHz !== null) parts.push(`highpass=f=${profile.highpassHz}`);
  if (profile.lowpassHz !== null) parts.push(`lowpass=f=${profile.lowpassHz}`);
  const linearGain = dbToLinear(profile.micGainDb);
  if (linearGain !== 1) parts.push(`volume=${linearGain}`);
  return parts.join(",");
}

function buildSystemFilters(profile: ResolvedAudioProfile): string {
  const linearGain = dbToLinear(profile.systemGainDb);
  if (linearGain !== 1) return `volume=${linearGain}`;
  return "";
}

function buildLimiter(profile: ResolvedAudioProfile): string {
  if (!profile.limiter) return "";
  return `alimiter=limit=${profile.limiterCeiling}`;
}

export interface ResolvedFilterChain {
  filterArgs: string[];
  mapArgs: string[];
  /** Human-readable preview of the effective FFmpeg filter for the settings UI. */
  filterPreview: string;
}

export function resolveAudioFilterChain(settings: CaptureSettings, dualInput: boolean): ResolvedFilterChain {
  const profile = resolveAudioProfile(settings);

  if (dualInput) {
    const micFilters = buildMicFilters(profile);
    const sysFilters = buildSystemFilters(profile);
    const micChain = micFilters ? `[0:a]${micFilters}[mic]` : `[0:a]anull[mic]`;
    const sysChain = sysFilters ? `[1:a]${sysFilters}[sys]` : `[1:a]anull[sys]`;
    const amix = `[mic][sys]amix=inputs=2:duration=longest:weights='${profile.micMixWeight} ${profile.systemMixWeight}':normalize=0`;
    const limiter = buildLimiter(profile);
    const tail = limiter ? `,${limiter}[aout]` : `[aout]`;
    const filterComplex = `${micChain};${sysChain};${amix}${tail}`;
    return {
      filterArgs: ["-filter_complex", filterComplex],
      mapArgs: ["-map", "[aout]"],
      filterPreview: filterComplex,
    };
  }

  const parts: string[] = [];
  const micFilters = buildMicFilters(profile);
  if (micFilters) parts.push(micFilters);
  const limiter = buildLimiter(profile);
  if (limiter) parts.push(limiter);
  const af = parts.length > 0 ? parts.join(",") : "anull";
  return {
    filterArgs: ["-af", af],
    mapArgs: ["-map", "0:a"],
    filterPreview: af,
  };
}

export function getCaptureProfileDescription(profile: CaptureProfile): string {
  switch (profile) {
    case "transcription":
      return "Aggressive voice boost and band-pass filtering. Best transcription accuracy, but can sound distorted on some hardware.";
    case "balanced":
      return "Moderate voice boost with gentle filtering. Good transcription accuracy with cleaner playback.";
    case "natural":
      return "Minimal processing, clean audio. Best for playback. May reduce transcription accuracy in noisy environments.";
    case "custom":
      return "Full manual control over gain, filtering, and limiter.";
  }
}

export const CAPTURE_PROFILE_LABELS: Record<CaptureProfile, string> = {
  transcription: "Transcription (aggressive)",
  balanced: "Balanced (recommended)",
  natural: "Natural (clean)",
  custom: "Custom",
};
