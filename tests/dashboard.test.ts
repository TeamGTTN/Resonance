import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardSnapshot, deriveSessionHealthBadge, deriveSessionListItem, groupDiagnosticsChecks } from "../src/application/dashboard";
import type { DiagnosticsReport } from "../src/domain/diagnostics";
import type { RecordingSessionManifest, SessionRuntimeSnapshot } from "../src/domain/session";

const diagnosticsReport: DiagnosticsReport = {
  checkedAt: "2026-04-22T08:00:00.000Z",
  provider: "ollama",
  capture: "web-audio",
  checks: [
    { id: "web-audio", label: "Web Audio capture", severity: "ok", detail: "Ready." },
    { id: "ollama", label: "Ollama", severity: "warning", detail: "Slow response." },
    { id: "model", label: "Whisper model", severity: "error", detail: "Missing model." },
  ],
  blockingIssueIds: ["model"],
  warningIds: ["ollama"],
  isHealthy: false,
  summary: "Diagnostics found blocking issues.",
};

const manifest: RecordingSessionManifest = {
  schemaVersion: 4,
  sessionId: "session-1",
  createdAt: "2026-04-22T08:00:00.000Z",
  updatedAt: "2026-04-22T08:30:00.000Z",
  scenarioKey: "work_meeting",
  scenarioLabel: "Meeting",
  captureMode: "microphone",
  captureSources: {
    microphone: { deviceId: "", label: "System default input" },
    additionalSources: [],
  },
  status: "failed",
  paths: {
    rootDir: "/tmp/session-1",
    manifestPath: "/tmp/session-1/session.json",
    diagnosticsLogPath: "/tmp/session-1/diagnostics.log",
    audioDir: "/tmp/session-1/audio",
    fullAudioPath: "/tmp/session-1/audio/recording.wav",
    segmentsDir: "/tmp/session-1/audio/segments",
    transcriptDir: "/tmp/session-1/transcript",
    transcriptTextPath: "/tmp/session-1/transcript/live-transcript.txt",
    summaryDir: "/tmp/session-1/summary",
    summaryMarkdownPath: "/tmp/session-1/summary/summary.md",
  },
  providerInfo: {
    summaryProvider: "ollama",
    transcriptionEngine: "whisper.cpp",
    model: "gemma3",
  },
  diagnosticsSummary: {
    checkedAt: "2026-04-22T08:00:00.000Z",
    blockingIssueIds: ["model"],
    warningIds: ["ollama"],
    summary: "Diagnostics found blocking issues.",
  },
  notes: {
    liveTranscriptNotePath: "Resonance/Live transcript.md",
  },
  runtime: {
    startedAt: "2026-04-22T08:00:00.000Z",
    lastActivityAt: "2026-04-22T08:20:00.000Z",
    finishedAt: "2026-04-22T08:25:00.000Z",
    elapsedSeconds: 1500,
    failureSummary: "Summary provider returned an empty result.",
  },
  artifacts: {
    hasAudio: true,
    hasTranscript: true,
    hasSummary: false,
  },
  live: {
    committedSegments: 5,
    lastCommittedSegment: 4,
  },
  errors: ["Summary provider returned an empty result."],
};

test("groupDiagnosticsChecks splits checks by severity", () => {
  const grouped = groupDiagnosticsChecks(diagnosticsReport);
  assert.equal(grouped.blocking.length, 1);
  assert.equal(grouped.warnings.length, 1);
  assert.equal(grouped.healthy.length, 1);
});

test("deriveSessionListItem exposes dashboard and library metadata", () => {
  const item = deriveSessionListItem(manifest, 42_000);
  assert.equal(item.paths.rootDir, "/tmp/session-1");
  assert.equal(item.audioSizeBytes, 42_000);
  assert.equal(item.healthBadge, "failed");
  assert.equal(item.failureSummary, "Summary provider returned an empty result.");
  assert.equal(item.artifactAvailability.hasTranscript, true);
  assert.equal(item.sourceLabel, "Microphone");
});

test("deriveSessionListItem labels multi-input sessions clearly", () => {
  const item = deriveSessionListItem(
    {
      ...manifest,
      sessionId: "session-2",
      captureMode: "multiple-input",
      captureSources: {
        microphone: { deviceId: "mic-1", label: "USB Microphone" },
        additionalSources: [
          { deviceId: "loopback-1", label: "BlackHole 2ch" },
          { deviceId: "loopback-2", label: "Monitor Source" },
        ],
      },
    },
    24_000
  );

  assert.equal(item.sourceLabel, "Microphone + 2 extra sources");
});

test("deriveSessionHealthBadge marks finalizing sessions as warning", () => {
  assert.equal(
    deriveSessionHealthBadge({
      ...manifest,
      status: "stopping",
      runtime: { ...manifest.runtime, failureSummary: undefined },
    }),
    "warning"
  );
});

test("buildDashboardSnapshot blocks start when diagnostics fail", () => {
  const runtime: SessionRuntimeSnapshot = {
    state: "idle",
    elapsedSeconds: 0,
    committedSegments: 0,
    queuedSegments: 0,
    liveTranscriptChars: 0,
    diagnosticsReport,
  };

  const snapshot = buildDashboardSnapshot({
    runtime,
    diagnosticsReport,
    recentSessions: [deriveSessionListItem(manifest, 42_000)],
    isCoreConfigured: false,
  });

  assert.equal(snapshot.primaryAction.intent, "blocked");
  assert.equal(snapshot.health.badge, "failed");
  assert.equal(snapshot.recentSessions.length, 1);
});

test("buildDashboardSnapshot exposes stop while a session is active", () => {
  const runtime: SessionRuntimeSnapshot = {
    state: "recording",
    elapsedSeconds: 15,
    committedSegments: 2,
    queuedSegments: 1,
    liveTranscriptChars: 120,
  };

  const snapshot = buildDashboardSnapshot({
    runtime,
    recentSessions: [],
    isCoreConfigured: true,
  });

  assert.equal(snapshot.primaryAction.intent, "stop");
  assert.equal(snapshot.primaryAction.disabled, false);
});
