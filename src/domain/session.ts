import type { DiagnosticsReport } from "./diagnostics";
import type { SummaryProviderId } from "./providers";
import type { CaptureEngine, SystemAudioMode } from "./settings";

export const SESSION_STATES = [
  "idle",
  "preflight",
  "segmenting",
  "recording",
  "transcribing_live",
  "stopping",
  "summarizing",
  "persisting",
  "done",
  "failed",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export interface DiagnosticsSummary {
  checkedAt: string;
  blockingIssueIds: string[];
  warningIds: string[];
  summary: string;
}

export interface RecordingSessionPaths {
  rootDir: string;
  manifestPath: string;
  diagnosticsLogPath: string;
  audioDir: string;
  fullAudioPath: string;
  segmentsDir: string;
  transcriptDir: string;
  transcriptTextPath: string;
  summaryDir: string;
  summaryMarkdownPath: string;
}

export interface RecordingSessionManifest {
  schemaVersion: 1 | 2 | 3;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  scenarioKey: string;
  scenarioLabel: string;
  captureEngine?: CaptureEngine;
  systemAudioMode?: SystemAudioMode;
  captureMode: "microphone" | "microphone+system" | "system";
  status: SessionState;
  paths: RecordingSessionPaths;
  providerInfo: {
    summaryProvider: SummaryProviderId;
    transcriptionEngine: "whisper.cpp";
    model: string;
  };
  diagnosticsSummary: DiagnosticsSummary;
  notes: {
    vaultFolderPath?: string;
    liveTranscriptNotePath?: string;
    summaryNotePath?: string;
  };
  runtime: {
    startedAt: string;
    lastActivityAt: string;
    finishedAt?: string;
    elapsedSeconds: number;
    failureSummary?: string;
  };
  artifacts: {
    hasAudio: boolean;
    hasTranscript: boolean;
    hasSummary: boolean;
  };
  live: {
    committedSegments: number;
    lastCommittedSegment: number;
  };
  errors: string[];
}

export interface SessionRuntimeSnapshot {
  state: SessionState;
  sessionId?: string;
  scenarioKey?: string;
  scenarioLabel?: string;
  elapsedSeconds: number;
  committedSegments: number;
  queuedSegments: number;
  liveTranscriptChars: number;
  message?: string;
  lastError?: string;
  diagnosticsReport?: DiagnosticsReport;
}

export type SessionHealthBadge = "healthy" | "warning" | "failed";

export interface SessionListItem {
  sessionId: string;
  scenarioKey: string;
  scenarioLabel: string;
  captureEngine: CaptureEngine;
  systemAudioMode: SystemAudioMode;
  sourceLabel: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  finishedAt?: string;
  status: SessionState;
  elapsedSeconds: number;
  committedSegments: number;
  audioSizeBytes: number;
  healthBadge: SessionHealthBadge;
  failureSummary?: string;
  diagnosticsSummary: string;
  artifactAvailability: {
    hasAudio: boolean;
    hasTranscript: boolean;
    hasSummary: boolean;
  };
  paths: {
    rootDir: string;
    fullAudioPath: string;
    transcriptTextPath: string;
    diagnosticsLogPath: string;
  };
  notes: {
    summaryNotePath?: string;
    liveTranscriptNotePath?: string;
  };
}

export function buildDiagnosticsSummary(report: DiagnosticsReport): DiagnosticsSummary {
  return {
    checkedAt: report.checkedAt,
    blockingIssueIds: report.blockingIssueIds,
    warningIds: report.warningIds,
    summary: report.summary,
  };
}
