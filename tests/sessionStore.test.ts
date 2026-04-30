import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/infrastructure/storage/SessionStore";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import type { RecordingSessionManifest } from "../src/domain/session";
import type { ScenarioTemplate } from "../src/domain/scenarios";

const scenario: ScenarioTemplate = {
  key: "work_meeting",
  label: "Meeting",
  description: "Decision log",
  notePrefix: "Meeting",
  prompt: "Summarize the meeting.",
};

function createTestStore(t: TestContext) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-store-"));
  (globalThis as any).window = { require };
  const app = {
    vault: {
      adapter: {
        getBasePath: () => rootDir,
      },
      configDir: ".obsidian",
    },
  } as any;
  const store = new SessionStore(app, "resonance-next");
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  return { store };
}

async function createSessionWithArtifacts(
  t: TestContext,
  overrides: Partial<RecordingSessionManifest["artifacts"]> = {}
) {
  const { store } = createTestStore(t);
  const manifest = await store.createSession(scenario, DEFAULT_SETTINGS, {
    checkedAt: "2026-04-29T10:00:00.000Z",
    blockingIssueIds: [],
    warningIds: [],
    summary: "Ready.",
  });

  fs.writeFileSync(manifest.paths.fullAudioPath, Buffer.alloc(100));
  fs.writeFileSync(path.join(manifest.paths.segmentsDir, "segment-0000.wav"), Buffer.alloc(25));
  fs.writeFileSync(path.join(manifest.paths.segmentsDir, "segment-0001.wav"), Buffer.alloc(35));
  fs.writeFileSync(manifest.paths.transcriptTextPath, "hello transcript");
  fs.writeFileSync(manifest.paths.summaryMarkdownPath, "summary");
  fs.writeFileSync(manifest.paths.diagnosticsLogPath, "diag");

  manifest.artifacts = {
    hasAudio: overrides.hasAudio ?? true,
    hasTranscript: overrides.hasTranscript ?? true,
    hasSummary: overrides.hasSummary ?? true,
  };
  await store.writeManifest(manifest);

  return { store, manifest };
}

test("SessionStore computes per-session storage breakdowns and library totals", async (t) => {
  const { store, manifest } = await createSessionWithArtifacts(t);
  const breakdown = store.getSessionStorageBreakdown(manifest);

  assert.equal(breakdown.audioBytes, 160);
  assert.equal(breakdown.transcriptBytes, Buffer.byteLength("hello transcript"));
  assert.equal(breakdown.summaryBytes, Buffer.byteLength("summary"));
  assert.equal(breakdown.diagnosticsBytes, Buffer.byteLength("diag"));
  assert.equal(
    breakdown.totalBytes,
    breakdown.audioBytes + breakdown.transcriptBytes + breakdown.summaryBytes + breakdown.diagnosticsBytes
  );

  const stats = store.getLibraryStorageStats([manifest]);
  assert.deepEqual(stats, {
    sessionCount: 1,
    ...breakdown,
  });
});

test("SessionStore estimates reclaimable bytes for each cleanup action", async (t) => {
  const { store, manifest } = await createSessionWithArtifacts(t);
  const breakdown = store.getSessionStorageBreakdown(manifest);

  assert.equal(store.getReclaimableBytes(manifest, "audio"), breakdown.audioBytes);
  assert.equal(store.getReclaimableBytes(manifest, "transcript"), breakdown.transcriptBytes);
  assert.equal(store.getReclaimableBytes(manifest, "session"), breakdown.totalBytes);
  assert.equal(store.getReclaimableBytesForSessions([manifest], "session"), breakdown.totalBytes);
});

test("SessionStore bulk cleanup helpers preserve the expected remaining artifacts", async (t) => {
  const { store, manifest } = await createSessionWithArtifacts(t);

  await store.deleteAudioArtifactsMany([manifest]);
  assert.equal(fs.existsSync(manifest.paths.fullAudioPath), false);
  assert.equal(fs.existsSync(manifest.paths.segmentsDir), true);
  assert.equal(fs.readFileSync(manifest.paths.summaryMarkdownPath, "utf8"), "summary");

  fs.writeFileSync(manifest.paths.fullAudioPath, Buffer.alloc(10));
  await store.deleteTranscriptArtifactsMany([manifest]);
  assert.equal(fs.readFileSync(manifest.paths.transcriptTextPath, "utf8"), "");
  assert.equal(fs.readFileSync(manifest.paths.summaryMarkdownPath, "utf8"), "summary");

  await store.deleteSessionFilesMany([manifest]);
  assert.equal(fs.existsSync(manifest.paths.rootDir), false);
});
