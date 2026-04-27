import type { DashboardSnapshot, DiagnosticsGroups } from "../domain/dashboard";
import type { DiagnosticsReport } from "../domain/diagnostics";
import type { SessionListItem, SessionRuntimeSnapshot, RecordingSessionManifest, SessionHealthBadge } from "../domain/session";
import { uiCopy } from "../ui/copy";

export function groupDiagnosticsChecks(report?: DiagnosticsReport): DiagnosticsGroups {
  const checks = report?.checks ?? [];
  return {
    blocking: checks.filter((check) => check.severity === "error"),
    warnings: checks.filter((check) => check.severity === "warning"),
    healthy: checks.filter((check) => check.severity === "ok"),
  };
}

export function deriveSessionHealthBadge(manifest: RecordingSessionManifest): SessionHealthBadge {
  if (manifest.status === "failed" || manifest.runtime.failureSummary) return "failed";
  if (manifest.status === "stopping" || manifest.status === "summarizing" || manifest.status === "persisting") {
    return "warning";
  }
  if (manifest.diagnosticsSummary.blockingIssueIds.length > 0) return "failed";
  if (manifest.diagnosticsSummary.warningIds.length > 0) return "warning";
  return "healthy";
}

export function deriveSessionListItem(manifest: RecordingSessionManifest, audioSizeBytes: number): SessionListItem {
  return {
    sessionId: manifest.sessionId,
    scenarioKey: manifest.scenarioKey,
    scenarioLabel: manifest.scenarioLabel,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    lastActivityAt: manifest.runtime.lastActivityAt,
    finishedAt: manifest.runtime.finishedAt,
    status: manifest.status,
    elapsedSeconds: manifest.runtime.elapsedSeconds,
    committedSegments: manifest.live.committedSegments,
    audioSizeBytes,
    healthBadge: deriveSessionHealthBadge(manifest),
    failureSummary: manifest.runtime.failureSummary || manifest.errors[manifest.errors.length - 1],
    diagnosticsSummary: manifest.diagnosticsSummary.summary,
    artifactAvailability: {
      hasAudio: manifest.artifacts.hasAudio,
      hasTranscript: manifest.artifacts.hasTranscript,
      hasSummary: manifest.artifacts.hasSummary,
    },
    paths: {
      rootDir: manifest.paths.rootDir,
      fullAudioPath: manifest.paths.fullAudioPath,
      transcriptTextPath: manifest.paths.transcriptTextPath,
      diagnosticsLogPath: manifest.paths.diagnosticsLogPath,
    },
    notes: {
      summaryNotePath: manifest.notes.summaryNotePath,
      liveTranscriptNotePath: manifest.notes.liveTranscriptNotePath,
    },
  };
}

export function buildDashboardSnapshot(input: {
  runtime: SessionRuntimeSnapshot;
  diagnosticsReport?: DiagnosticsReport;
  recentSessions: SessionListItem[];
  isCoreConfigured: boolean;
}): DashboardSnapshot {
  const groups = groupDiagnosticsChecks(input.diagnosticsReport);
  const blockingCount = groups.blocking.length;
  const warningCount = groups.warnings.length;
  const state = input.runtime.state;
  const isBusy = !["idle", "done", "failed"].includes(state);
  const isStoppable = ["preflight", "segmenting", "recording", "transcribing_live", "stopping"].includes(state);
  const isHealthy = blockingCount === 0 && input.isCoreConfigured;
  const badge = blockingCount > 0 ? "failed" : warningCount > 0 ? "warning" : "healthy";

  const primaryAction = isStoppable
    ? {
        intent: "stop" as const,
        label: uiCopy.actions.stopSession,
        disabled: false,
      }
    : isBusy
    ? {
        intent: "busy" as const,
        label: uiCopy.status.busy,
        disabled: true,
        reason: uiCopy.dashboard.busyReason,
      }
    : isHealthy
    ? {
        intent: "start" as const,
        label: uiCopy.actions.startSession,
        disabled: false,
      }
    : {
        intent: "blocked" as const,
        label: uiCopy.status.blocked,
        disabled: true,
        reason: uiCopy.dashboard.blockedReason,
      };

  return {
    generatedAt: new Date().toISOString(),
    runtime: input.runtime,
    primaryAction,
    health: {
      badge,
      summary: input.diagnosticsReport?.summary ?? (isHealthy ? uiCopy.status.ready : uiCopy.status.blocked),
      blockingCount,
      warningCount,
      groups,
      report: input.diagnosticsReport,
    },
    recentSessions: input.recentSessions,
    canOpenDiagnostics: Boolean(input.diagnosticsReport),
  };
}
