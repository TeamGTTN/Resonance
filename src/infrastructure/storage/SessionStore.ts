import type { App } from "obsidian";
import { getSelectedSummaryModel } from "../../domain/providers";
import { type PluginSettings, type CaptureSourceSelection } from "../../domain/settings";
import {
  SUPPORTED_SESSION_SCHEMA_VERSION,
  isSupportedSessionManifest,
  type DiagnosticsSummary,
  type RecordingSessionManifest,
  type SessionArtifactSizeBreakdown,
  type SessionCleanupAction,
  type SessionLibraryStats,
} from "../../domain/session";
import type { ScenarioTemplate } from "../../domain/scenarios";
import { getVaultBasePath, getVaultConfigDir, requireNodeModule } from "../node";

interface FsModule {
  accessSync: (path: string, mode?: number) => void;
  appendFileSync: (path: string, contents: string, options?: { encoding: "utf8" }) => void;
  constants: { F_OK: number };
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  readFileSync: (path: string, options?: { encoding: "utf8" }) => string | Buffer;
  readdirSync: (path: string) => string[];
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
  statSync: (path: string) => { isDirectory(): boolean; size: number };
  unlinkSync: (path: string) => void;
  writeFileSync: (path: string, contents: string, options?: { encoding: "utf8" }) => void;
}

interface PathModule {
  join: (...parts: string[]) => string;
}

export class SessionStore {
  constructor(private readonly app: App, private readonly pluginId: string) {}

  getSessionsRootDir(): string {
    const path = requireNodeModule<PathModule>("path");
    const basePath = getVaultBasePath(this.app);
    if (!basePath) throw new Error("Unable to determine vault base path.");
    return path.join(basePath, getVaultConfigDir(this.app), "plugins", this.pluginId, "data", "sessions");
  }

  async createSession(
    scenario: ScenarioTemplate,
    settings: PluginSettings,
    diagnosticsSummary: DiagnosticsSummary
  ): Promise<RecordingSessionManifest> {
    const fs = requireNodeModule<FsModule>("fs");
    const path = requireNodeModule<PathModule>("path");
    const createdAt = new Date().toISOString();
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rootDir = path.join(this.getSessionsRootDir(), sessionId);
    const audioDir = path.join(rootDir, "audio");
    const segmentsDir = path.join(audioDir, "segments");
    const transcriptDir = path.join(rootDir, "transcript");
    const summaryDir = path.join(rootDir, "summary");
    const manifestPath = path.join(rootDir, "session.json");
    const diagnosticsLogPath = path.join(rootDir, "diagnostics.log");
    const transcriptTextPath = path.join(transcriptDir, "live-transcript.txt");
    const summaryMarkdownPath = path.join(summaryDir, "summary.md");
    const fullAudioPath = path.join(audioDir, "recording.wav");

    for (const dir of [this.getSessionsRootDir(), rootDir, audioDir, segmentsDir, transcriptDir, summaryDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(transcriptTextPath, "", { encoding: "utf8" });
    fs.writeFileSync(summaryMarkdownPath, "", { encoding: "utf8" });
    fs.writeFileSync(diagnosticsLogPath, "", { encoding: "utf8" });

    const captureSources = {
      microphone: cloneSource(settings.capture.microphone),
      additionalSources: settings.capture.additionalSources.map(cloneSource),
    };

    const manifest: RecordingSessionManifest = {
      schemaVersion: SUPPORTED_SESSION_SCHEMA_VERSION,
      sessionId,
      createdAt,
      updatedAt: createdAt,
      scenarioKey: scenario.key,
      scenarioLabel: scenario.label,
      captureMode: captureSources.additionalSources.length > 0 ? "multiple-input" : "microphone",
      captureSources,
      status: "preflight",
      paths: {
        rootDir,
        manifestPath,
        diagnosticsLogPath,
        audioDir,
        fullAudioPath,
        segmentsDir,
        transcriptDir,
        transcriptTextPath,
        summaryDir,
        summaryMarkdownPath,
      },
      providerInfo: {
        summaryProvider: settings.summary.provider,
        transcriptionEngine: "whisper.cpp",
        model: getSelectedSummaryModel(settings.summary),
      },
      diagnosticsSummary,
      notes: {},
      runtime: {
        startedAt: createdAt,
        lastActivityAt: createdAt,
        elapsedSeconds: 0,
      },
      artifacts: {
        hasAudio: false,
        hasTranscript: false,
        hasSummary: false,
      },
      live: {
        committedSegments: 0,
        lastCommittedSegment: -1,
      },
      errors: [],
    };

    await this.writeManifest(manifest);
    return manifest;
  }

  writeManifest(manifest: RecordingSessionManifest): Promise<void> {
    const fs = requireNodeModule<FsModule>("fs");
    const now = new Date().toISOString();
    manifest.schemaVersion = SUPPORTED_SESSION_SCHEMA_VERSION;
    manifest.updatedAt = now;
    manifest.runtime.lastActivityAt = now;
    if ((manifest.status === "done" || manifest.status === "failed") && !manifest.runtime.finishedAt) {
      manifest.runtime.finishedAt = now;
    }
    this.refreshArtifactFlags(fs, manifest);
    fs.writeFileSync(manifest.paths.manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8" });
    return Promise.resolve();
  }

  appendDiagnostics(manifest: RecordingSessionManifest, message: string): Promise<void> {
    const fs = requireNodeModule<FsModule>("fs");
    fs.appendFileSync(manifest.paths.diagnosticsLogPath, `[${new Date().toISOString()}] ${message}\n`, { encoding: "utf8" });
    return Promise.resolve();
  }

  appendTranscriptChunk(manifest: RecordingSessionManifest, chunk: string): Promise<void> {
    const fs = requireNodeModule<FsModule>("fs");
    const current = fs.existsSync(manifest.paths.transcriptTextPath)
      ? String(fs.readFileSync(manifest.paths.transcriptTextPath, { encoding: "utf8" })).trim()
      : "";
    const prefix = current ? "\n" : "";
    fs.appendFileSync(manifest.paths.transcriptTextPath, `${prefix}${chunk.trim()}`, { encoding: "utf8" });
    return Promise.resolve();
  }

  readTranscript(manifest: RecordingSessionManifest): string {
    return this.readTextFile(manifest.paths.transcriptTextPath);
  }

  writeSummary(manifest: RecordingSessionManifest, markdown: string): Promise<void> {
    const fs = requireNodeModule<FsModule>("fs");
    fs.writeFileSync(manifest.paths.summaryMarkdownPath, markdown, { encoding: "utf8" });
    return Promise.resolve();
  }

  writeTranscript(manifest: RecordingSessionManifest, text: string): Promise<void> {
    const fs = requireNodeModule<FsModule>("fs");
    fs.writeFileSync(manifest.paths.transcriptTextPath, text.trim(), { encoding: "utf8" });
    return Promise.resolve();
  }

  listSessions(): Promise<RecordingSessionManifest[]> {
    const fs = requireNodeModule<FsModule>("fs");
    const path = requireNodeModule<PathModule>("path");
    const root = this.getSessionsRootDir();
    if (!fs.existsSync(root)) return Promise.resolve([]);

    const manifests: RecordingSessionManifest[] = [];
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const manifestPath = path.join(dir, "session.json");
        const raw = JSON.parse(String(fs.readFileSync(manifestPath, { encoding: "utf8" }))) as unknown;
        if (!isSupportedSessionManifest(raw)) continue;
        const manifest = this.normalizeManifest(raw);
        if (manifest.status !== "idle" && manifest.status !== "preflight") {
          manifests.push(manifest);
        }
      } catch {
        // Ignore incomplete or corrupt session folders in the library view.
      }
    }

    return Promise.resolve(manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  readSessionByRootDir(rootDir: string): Promise<RecordingSessionManifest | null> {
    const fs = requireNodeModule<FsModule>("fs");
    const path = requireNodeModule<PathModule>("path");
    try {
      const manifestPath = path.join(rootDir, "session.json");
      if (!fs.existsSync(manifestPath)) return Promise.resolve(null);
      const raw = JSON.parse(String(fs.readFileSync(manifestPath, { encoding: "utf8" }))) as unknown;
      if (!isSupportedSessionManifest(raw)) return Promise.resolve(null);
      return Promise.resolve(this.normalizeManifest(raw));
    } catch {
      return Promise.resolve(null);
    }
  }

  async pruneFinishedSessions(maxSessionsKept: number): Promise<void> {
    if (!Number.isFinite(maxSessionsKept) || maxSessionsKept <= 0) return;
    const sessions = await this.listSessions();
    const overflow = sessions.slice(maxSessionsKept);
    for (const manifest of overflow) {
      await this.deleteSessionFiles(manifest);
    }
  }

  async deleteSessionFiles(manifest: RecordingSessionManifest): Promise<void> {
    await this.deleteSessionRootDir(manifest.paths.rootDir);
  }

  async deleteSessionFilesMany(manifests: RecordingSessionManifest[]): Promise<void> {
    for (const manifest of manifests) {
      await this.deleteSessionFiles(manifest);
    }
  }

  deleteSessionRootDir(rootDir: string): Promise<void> {
    const fs = requireNodeModule<FsModule>("fs");
    fs.rmSync(rootDir, { recursive: true, force: true });
    return Promise.resolve();
  }

  deleteAudioArtifacts(manifest: RecordingSessionManifest): Promise<void> {
    const fs = requireNodeModule<FsModule>("fs");
    if (fs.existsSync(manifest.paths.fullAudioPath)) {
      fs.rmSync(manifest.paths.fullAudioPath, { recursive: false, force: true });
    }
    if (fs.existsSync(manifest.paths.segmentsDir)) {
      fs.rmSync(manifest.paths.segmentsDir, { recursive: true, force: true });
      fs.mkdirSync(manifest.paths.segmentsDir, { recursive: true });
    }
    manifest.artifacts.hasAudio = false;
    return Promise.resolve();
  }

  async deleteAudioArtifactsMany(manifests: RecordingSessionManifest[]): Promise<void> {
    for (const manifest of manifests) {
      await this.deleteAudioArtifacts(manifest);
    }
  }

  deleteTranscriptArtifacts(manifest: RecordingSessionManifest): Promise<void> {
    const fs = requireNodeModule<FsModule>("fs");
    fs.writeFileSync(manifest.paths.transcriptTextPath, "", { encoding: "utf8" });
    manifest.artifacts.hasTranscript = false;
    return Promise.resolve();
  }

  async deleteTranscriptArtifactsMany(manifests: RecordingSessionManifest[]): Promise<void> {
    for (const manifest of manifests) {
      await this.deleteTranscriptArtifacts(manifest);
    }
  }

  readTextFile(path: string): string {
    const fs = requireNodeModule<FsModule>("fs");
    if (!path || !fs.existsSync(path)) return "";
    return String(fs.readFileSync(path, { encoding: "utf8" }));
  }

  getSessionStorageBreakdown(manifest: RecordingSessionManifest): SessionArtifactSizeBreakdown {
    const fs = requireNodeModule<FsModule>("fs");
    const audioBytes = this.getPathSize(fs, manifest.paths.fullAudioPath) + this.getPathSize(fs, manifest.paths.segmentsDir);
    const transcriptBytes = this.getPathSize(fs, manifest.paths.transcriptTextPath);
    const summaryBytes = this.getPathSize(fs, manifest.paths.summaryMarkdownPath);
    const diagnosticsBytes = this.getPathSize(fs, manifest.paths.diagnosticsLogPath);
    return {
      audioBytes,
      transcriptBytes,
      summaryBytes,
      diagnosticsBytes,
      totalBytes: audioBytes + transcriptBytes + summaryBytes + diagnosticsBytes,
    };
  }

  getLibraryStorageStats(manifests: RecordingSessionManifest[]): SessionLibraryStats {
    return manifests.reduce<SessionLibraryStats>(
      (stats, manifest) => {
        const breakdown = this.getSessionStorageBreakdown(manifest);
        stats.sessionCount += 1;
        stats.audioBytes += breakdown.audioBytes;
        stats.transcriptBytes += breakdown.transcriptBytes;
        stats.summaryBytes += breakdown.summaryBytes;
        stats.diagnosticsBytes += breakdown.diagnosticsBytes;
        stats.totalBytes += breakdown.totalBytes;
        return stats;
      },
      {
        sessionCount: 0,
        audioBytes: 0,
        transcriptBytes: 0,
        summaryBytes: 0,
        diagnosticsBytes: 0,
        totalBytes: 0,
      }
    );
  }

  getReclaimableBytes(manifest: RecordingSessionManifest, action: SessionCleanupAction): number {
    const breakdown = this.getSessionStorageBreakdown(manifest);
    switch (action) {
      case "audio":
        return breakdown.audioBytes;
      case "transcript":
        return breakdown.transcriptBytes;
      case "session":
      default:
        return breakdown.totalBytes;
    }
  }

  getReclaimableBytesForSessions(manifests: RecordingSessionManifest[], action: SessionCleanupAction): number {
    return manifests.reduce((total, manifest) => total + this.getReclaimableBytes(manifest, action), 0);
  }

  private normalizeManifest(manifest: RecordingSessionManifest): RecordingSessionManifest {
    const fallbackTimestamp = manifest.updatedAt || manifest.createdAt || new Date().toISOString();
    const normalized: RecordingSessionManifest = {
      ...manifest,
      schemaVersion: SUPPORTED_SESSION_SCHEMA_VERSION,
      captureSources: {
        microphone: cloneSource(manifest.captureSources?.microphone),
        additionalSources: Array.isArray(manifest.captureSources?.additionalSources)
          ? manifest.captureSources.additionalSources.map(cloneSource)
          : [],
      },
      notes: manifest.notes ?? {},
      diagnosticsSummary: manifest.diagnosticsSummary ?? {
        checkedAt: fallbackTimestamp,
        blockingIssueIds: [],
        warningIds: [],
        summary: "No diagnostics summary was stored for this session.",
      },
      runtime: {
        startedAt: manifest.runtime?.startedAt ?? manifest.createdAt ?? fallbackTimestamp,
        lastActivityAt: manifest.runtime?.lastActivityAt ?? manifest.updatedAt ?? manifest.createdAt ?? fallbackTimestamp,
        finishedAt:
          manifest.runtime?.finishedAt ??
          (manifest.status === "done" || manifest.status === "failed" ? manifest.updatedAt || manifest.createdAt : undefined),
        elapsedSeconds: manifest.runtime?.elapsedSeconds ?? 0,
        failureSummary:
          manifest.runtime?.failureSummary ??
          (Array.isArray(manifest.errors) && manifest.errors.length > 0 ? manifest.errors[manifest.errors.length - 1] : undefined),
      },
      artifacts: {
        hasAudio: manifest.artifacts?.hasAudio ?? false,
        hasTranscript: manifest.artifacts?.hasTranscript ?? false,
        hasSummary: manifest.artifacts?.hasSummary ?? false,
      },
      live: manifest.live ?? {
        committedSegments: 0,
        lastCommittedSegment: -1,
      },
      errors: Array.isArray(manifest.errors) ? manifest.errors : [],
    };
    this.refreshArtifactFlags(requireNodeModule<FsModule>("fs"), normalized);
    return normalized;
  }

  private refreshArtifactFlags(fs: FsModule, manifest: RecordingSessionManifest): void {
    manifest.artifacts.hasAudio = manifest.artifacts.hasAudio || this.fileExists(fs, manifest.paths.fullAudioPath);
    manifest.artifacts.hasTranscript =
      manifest.artifacts.hasTranscript || this.readText(fs, manifest.paths.transcriptTextPath).trim().length > 0;
    manifest.artifacts.hasSummary =
      manifest.artifacts.hasSummary ||
      this.readText(fs, manifest.paths.summaryMarkdownPath).trim().length > 0 ||
      Boolean(manifest.notes.summaryNotePath);
  }

  private fileExists(fs: FsModule, path: string): boolean {
    if (!path) return false;
    try {
      fs.accessSync(path, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private readText(fs: FsModule, path: string): string {
    if (!path || !fs.existsSync(path)) return "";
    return String(fs.readFileSync(path, { encoding: "utf8" }));
  }

  private getPathSize(fs: FsModule, path: string): number {
    if (!path || !fs.existsSync(path)) return 0;
    try {
      const stat = fs.statSync(path);
      if (!stat.isDirectory()) return stat.size || 0;
      return fs
        .readdirSync(path)
        .reduce((total, entry) => total + this.getPathSize(fs, requireNodeModule<PathModule>("path").join(path, entry)), 0);
    } catch {
      return 0;
    }
  }
}

function cloneSource(source: Partial<CaptureSourceSelection> | undefined): CaptureSourceSelection {
  return {
    deviceId: typeof source?.deviceId === "string" ? source.deviceId : "",
    label: typeof source?.label === "string" ? source.label : "",
  };
}
