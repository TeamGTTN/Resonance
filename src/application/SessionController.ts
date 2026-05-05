import type { App } from "obsidian";
import { getScenario } from "../domain/scenarios";
import { buildDiagnosticsSummary, type RecordingSessionManifest, type SessionListItem, type SessionRuntimeSnapshot, type SessionState } from "../domain/session";
import type { PluginSettings } from "../domain/settings";
import { OrderedSegmentQueue, type SegmentDescriptor } from "./OrderedSegmentQueue";
import { deriveSessionListItem } from "./dashboard";
import { WebCaptureAdapter } from "../infrastructure/adapters/WebCaptureAdapter";
import { WhisperTranscriptionAdapter } from "../infrastructure/adapters/TranscriptionAdapter";
import { SummaryAdapter } from "../infrastructure/adapters/SummaryAdapter";
import { SessionStore } from "../infrastructure/storage/SessionStore";
import { VaultAdapter } from "../infrastructure/adapters/VaultAdapter";
import { DiagnosticsService } from "../infrastructure/system/DiagnosticsService";
import { formatTranscriptChunkMarkdown, normalizeCheckboxes, sanitizeSummary } from "../utils/markdown";

interface SessionControllerOptions {
  app: App;
  pluginId: string;
  getSettings: () => PluginSettings;
  saveSettings: (updater: (current: PluginSettings) => PluginSettings) => Promise<void>;
}

const STARTABLE_STATES = new Set<SessionState>(["idle", "done", "failed"]);

interface ActiveCaptureRuntime {
  stop(): Promise<void>;
  isRunning(): boolean;
}

export class SessionController {
  private readonly store: SessionStore;
  private readonly vaultAdapter: VaultAdapter;
  private readonly diagnosticsService: DiagnosticsService;
  private readonly summaryAdapter = new SummaryAdapter();

  private captureAdapter: ActiveCaptureRuntime | null = null;
  private queue: OrderedSegmentQueue | null = null;
  private manifest: RecordingSessionManifest | null = null;
  private elapsedTimerId: number | null = null;
  private startedAtMs: number | null = null;
  private stopRequested = false;
  private snapshot: SessionRuntimeSnapshot = {
    state: "idle",
    elapsedSeconds: 0,
    committedSegments: 0,
    queuedSegments: 0,
    liveTranscriptChars: 0,
  };

  onSnapshot?: (snapshot: SessionRuntimeSnapshot) => void;
  onInfo?: (message: string) => void;
  onError?: (message: string) => void;

  constructor(private readonly options: SessionControllerOptions) {
    this.store = new SessionStore(options.app, options.pluginId);
    this.vaultAdapter = new VaultAdapter(options.app);
    this.diagnosticsService = new DiagnosticsService(options.app);
  }

  getSnapshot(): SessionRuntimeSnapshot {
    return this.snapshot;
  }

  getActiveLiveTranscriptNotePath(): string | undefined {
    return this.manifest?.notes.liveTranscriptNotePath;
  }

  async openActiveLiveTranscript(): Promise<boolean> {
    const path = this.manifest?.notes.liveTranscriptNotePath;
    if (!path) return false;
    await this.vaultAdapter.openFile(path);
    return true;
  }

  async listRecentSessions(limit = 12): Promise<SessionListItem[]> {
    const manifests = await this.store.listSessions();
    return manifests
      .slice(0, limit)
      .map((manifest) => deriveSessionListItem(manifest, this.store.getSessionStorageBreakdown(manifest)));
  }

  async runDiagnostics() {
    const report = await this.diagnosticsService.run(this.options.getSettings());
    this.patchSnapshot({ diagnosticsReport: report });
    return report;
  }

  async runSmokeTest() {
    return await this.diagnosticsService.runSmokeTest(this.options.getSettings());
  }

  async regenerateTranscript(rootDir: string): Promise<SessionListItem> {
    this.assertNoActiveSession();
    const manifest = await this.requireStoredSession(rootDir);
    const settings = this.options.getSettings();
    if (!manifest.artifacts.hasAudio) {
      throw new Error("Audio file is missing for this session.");
    }

    await this.store.appendDiagnostics(manifest, "Manual recovery: transcript regeneration started.");
    const transcriptionAdapter = new WhisperTranscriptionAdapter(settings.transcription);
    const transcript = (await transcriptionAdapter.transcribeFile(manifest.paths.fullAudioPath)).trim();
    if (!transcript) {
      await this.store.appendDiagnostics(manifest, "Manual recovery: transcript regeneration returned empty output.");
      manifest.status = "failed";
      manifest.runtime.failureSummary = "Transcript regeneration returned empty output.";
      await this.store.writeManifest(manifest);
      throw new Error("Transcript regeneration returned empty output.");
    }

    await this.store.writeTranscript(manifest, transcript);
    manifest.artifacts.hasTranscript = true;
    if (settings.output.storeLiveTranscriptInVault) {
      const liveTranscriptNotePath = await this.vaultAdapter.createOrUpdateLiveTranscriptNote(manifest, settings.output, transcript);
      manifest.notes.liveTranscriptNotePath = liveTranscriptNotePath;
    }
    if (!manifest.artifacts.hasSummary) {
      manifest.status = "failed";
      manifest.runtime.failureSummary = "Transcript regenerated. Summary is still missing.";
    }
    await this.store.appendDiagnostics(manifest, "Manual recovery: transcript regeneration completed.");
    await this.store.writeManifest(manifest);
    return deriveSessionListItem(manifest, this.store.getSessionStorageBreakdown(manifest));
  }

  async regenerateSummary(rootDir: string): Promise<SessionListItem> {
    this.assertNoActiveSession();
    const manifest = await this.requireStoredSession(rootDir);
    const settings = this.options.getSettings();
    const transcript = this.store.readTranscript(manifest).trim();
    if (!transcript) {
      throw new Error("Transcript is missing for this session.");
    }

    await this.store.appendDiagnostics(manifest, "Manual recovery: summary regeneration started.");
    const scenario = getScenario(manifest.scenarioKey);
    const summaryResult = await this.summaryAdapter.summarize(
      settings.summary,
      scenario.prompt,
      transcript,
      settings.transcription.language
    );
    const cleanedSummary = normalizeCheckboxes(sanitizeSummary(summaryResult.markdown || ""));
    if (!cleanedSummary.trim()) {
      await this.store.appendDiagnostics(manifest, "Manual recovery: summary regeneration returned empty output.");
      manifest.status = "failed";
      manifest.runtime.failureSummary = "Summary regeneration returned empty output.";
      await this.store.writeManifest(manifest);
      throw new Error("Summary regeneration returned empty output.");
    }

    await this.store.writeSummary(manifest, cleanedSummary);
    manifest.artifacts.hasSummary = true;
    manifest.notes.summaryNotePath = await this.vaultAdapter.createSummaryNote(manifest, settings.output, cleanedSummary);
    manifest.status = "done";
    manifest.runtime.failureSummary = undefined;
    manifest.runtime.finishedAt = new Date().toISOString();
    await this.store.appendDiagnostics(manifest, `Manual recovery: summary note created at ${manifest.notes.summaryNotePath}.`);
    await this.store.writeManifest(manifest);
    return deriveSessionListItem(manifest, this.store.getSessionStorageBreakdown(manifest));
  }

  async startScenario(scenarioKey: string): Promise<void> {
    if (!STARTABLE_STATES.has(this.snapshot.state)) {
      throw new Error("A session is already active.");
    }

    this.resetSnapshot();
    const settings = this.options.getSettings();
    const scenario = getScenario(scenarioKey);
    this.stopRequested = false;

    try {
      this.transition("preflight", "Running diagnostics...");
      const diagnosticsReport = await this.diagnosticsService.run(settings);
      this.patchSnapshot({ diagnosticsReport });
      if (!diagnosticsReport.isHealthy) {
        this.transition("failed", diagnosticsReport.summary, diagnosticsReport.summary);
        throw new Error(diagnosticsReport.summary);
      }

      this.manifest = await this.store.createSession(scenario, settings, buildDiagnosticsSummary(diagnosticsReport));
      await this.store.appendDiagnostics(this.manifest, diagnosticsReport.summary);
      const workspace = await this.vaultAdapter.ensureSessionWorkspace(this.manifest, settings.output);
      this.manifest.notes.vaultFolderPath = workspace.folderPath;
      this.manifest.notes.liveTranscriptNotePath = workspace.liveTranscriptNotePath;
      await this.store.writeManifest(this.manifest);

      const transcriptionAdapter = new WhisperTranscriptionAdapter(settings.transcription);
      this.queue = new OrderedSegmentQueue(async (segment) => {
        await this.commitSegment(segment, transcriptionAdapter);
      }, Math.max(0, this.manifest.live.lastCommittedSegment + 1));

      const adapter = new WebCaptureAdapter();
      this.captureAdapter = adapter;
      await adapter.start({
        fullAudioPath: this.manifest.paths.fullAudioPath,
        segmentsDir: this.manifest.paths.segmentsDir,
        segmentDurationSeconds: settings.capture.segmentDurationSeconds,
        microphoneDevice: settings.capture.microphone.deviceId,
        additionalSources: settings.capture.additionalSources,
        onSegmentReady: (segment) => {
          this.queue?.enqueue([segment]);
          this.refreshQueueSnapshot();
        },
        onLog: (line) => {
          if (this.manifest) void this.store.appendDiagnostics(this.manifest, line);
        },
        onError: (message) => {
          void this.failSession(message);
        },
      });

      await this.store.appendDiagnostics(this.manifest, "Audio capture started.");
      await this.options.saveSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          lastScenarioKey: scenario.key,
        },
      }));

      this.startedAtMs = Date.now();
      this.manifest.runtime.startedAt = new Date(this.startedAtMs).toISOString();
      await this.store.writeManifest(this.manifest);
      this.startElapsedTimer();
      this.transition("segmenting", "Recorder primed. Waiting for the first segment...");
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (this.manifest) {
        await this.failSession(message);
      } else {
        this.transition("failed", message, message);
        await this.cleanupRuntime();
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const manifest = this.manifest;
    if (!this.captureAdapter || !manifest) return;
    if (this.stopRequested) return;

    try {
      this.stopRequested = true;
      const frozenElapsedSeconds = this.freezeElapsedSeconds();
      manifest.runtime.elapsedSeconds = frozenElapsedSeconds;
      this.transition("stopping", "Stopping recorder and flushing live transcript...");
      await this.store.writeManifest(manifest);
      await this.captureAdapter.stop();
      manifest.artifacts.hasAudio = true;
      manifest.runtime.elapsedSeconds = frozenElapsedSeconds;
      await this.store.writeManifest(manifest);
      this.patchSnapshot({
        state: "stopping",
        message: "Capture stopped. Finishing transcript and summary in the background...",
      });
      void this.finishStoppedSession();
    } catch (error) {
      await this.failSession(String((error as Error)?.message ?? error));
      throw error;
    }
  }

  private async finishStoppedSession(): Promise<void> {
    const manifest = this.requireManifest();
    try {
      await this.queue?.whenIdle();
      this.refreshQueueSnapshot();
      await this.store.appendDiagnostics(manifest, "Capture stopped and all live segments committed.");
      await this.finalizeSummary();
    } catch (error) {
      await this.failSession(String((error as Error)?.message ?? error));
    }
  }

  private async finalizeSummary() {
    const manifest = this.requireManifest();
    const settings = this.options.getSettings();
    const scenario = getScenario(manifest.scenarioKey);
    const transcript = this.store.readTranscript(manifest);
    if (!transcript.trim()) {
      await this.failSession("Transcript is empty after capture flush.");
      return;
    }

    this.transition("summarizing", "Generating the final summary...");
    await this.store.appendDiagnostics(manifest, "Summary generation started.");
    const summaryResult = await this.summaryAdapter.summarize(
      settings.summary,
      scenario.prompt,
      transcript,
      settings.transcription.language
    );
    const cleanedSummary = normalizeCheckboxes(sanitizeSummary(summaryResult.markdown || ""));
    if (!cleanedSummary.trim()) {
      await this.failSession("Summary provider returned an empty result.");
      return;
    }

    this.transition("persisting", "Writing notes and session manifest...");
    await this.store.writeSummary(manifest, cleanedSummary);
    manifest.artifacts.hasSummary = true;
    const summaryNotePath = await this.vaultAdapter.createSummaryNote(manifest, settings.output, cleanedSummary);
    manifest.notes.summaryNotePath = summaryNotePath;
    manifest.artifacts.hasAudio = true;
    manifest.runtime.elapsedSeconds = this.snapshot.elapsedSeconds;
    manifest.runtime.finishedAt = new Date().toISOString();
    manifest.runtime.failureSummary = undefined;
    manifest.status = "done";
    await this.store.appendDiagnostics(manifest, `Summary note created at ${summaryNotePath}.`);
    await this.store.writeManifest(manifest);
    await this.store.pruneFinishedSessions(settings.output.maxSessionsKept);
    this.transition("done", "Session completed.");
    await this.cleanupRuntime();
    if (settings.output.openSummaryAfterCreate) {
      await this.vaultAdapter.openFile(summaryNotePath);
    }
    this.onInfo?.("Resonance session completed.");
  }

  private async commitSegment(segment: SegmentDescriptor, transcriptionAdapter: WhisperTranscriptionAdapter) {
    const manifest = this.requireManifest();
    if (this.stopRequested) {
      this.patchSnapshot({
        state: "stopping",
        message: `Finishing remaining segment ${segment.index + 1}...`,
      });
    } else {
      this.transition("transcribing_live", `Transcribing live segment ${segment.index + 1}...`);
    }
    await this.store.appendDiagnostics(manifest, `Transcribing segment ${segment.index} (${segment.path}).`);
    const text = await transcriptionAdapter.transcribeFile(segment.path);
    manifest.runtime.elapsedSeconds = this.snapshot.elapsedSeconds;

    if (!text.trim()) {
      await this.store.appendDiagnostics(manifest, `Segment ${segment.index} produced empty transcript.`);
      await this.store.writeManifest(manifest);
      this.refreshQueueSnapshot();
      return;
    }

    await this.store.appendTranscriptChunk(manifest, text);
    manifest.live.committedSegments += 1;
    manifest.live.lastCommittedSegment = segment.index;
    manifest.artifacts.hasTranscript = true;
    if (manifest.notes.liveTranscriptNotePath) {
      const chunk = formatTranscriptChunkMarkdown(segment.index, text);
      if (chunk) {
        await this.vaultAdapter.appendToNote(manifest.notes.liveTranscriptNotePath, `\n${chunk}`);
      }
    }
    await this.store.writeManifest(manifest);
    const currentTranscript = this.store.readTranscript(manifest);
    this.patchSnapshot({
      committedSegments: manifest.live.committedSegments,
      liveTranscriptChars: currentTranscript.length,
    });
    this.refreshQueueSnapshot();
    if (!this.stopRequested) {
      this.transition("recording", "Recording with ordered live transcription.");
    }
  }

  private refreshQueueSnapshot() {
    if (!this.queue) {
      this.patchSnapshot({ queuedSegments: 0 });
      return;
    }

    const stats = this.queue.getStats();
    const queuedSegments = stats.queuedIndexes.length + (stats.inFlightIndex !== null ? 1 : 0);
    this.patchSnapshot({ queuedSegments });
    if (this.stopRequested) {
      const message =
        queuedSegments > 0
          ? `Stopping recorder and finishing ${queuedSegments} remaining segment${queuedSegments === 1 ? "" : "s"}...`
          : "Stopping recorder and finalizing the session...";
      this.patchSnapshot({ state: "stopping", message });
      return;
    }

    if (stats.inFlightIndex !== null || stats.queuedIndexes.length > 0) {
      this.patchSnapshot({ state: "transcribing_live", message: "Ordered live transcription in progress." });
    } else if (this.captureAdapter?.isRunning()) {
      this.patchSnapshot({ state: "recording", message: "Recording with ordered live transcription." });
    }
  }

  private startElapsedTimer() {
    this.stopElapsedTimer();
    this.elapsedTimerId = window.setInterval(() => {
      this.patchSnapshot({ elapsedSeconds: this.getElapsedSecondsFromClock() });
    }, 500);
  }

  private stopElapsedTimer() {
    if (this.elapsedTimerId !== null) {
      window.clearInterval(this.elapsedTimerId);
      this.elapsedTimerId = null;
    }
  }

  private getElapsedSecondsFromClock(): number {
    if (!this.startedAtMs) return this.snapshot.elapsedSeconds;
    return Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000));
  }

  private freezeElapsedSeconds(): number {
    const elapsedSeconds = this.getElapsedSecondsFromClock();
    this.stopElapsedTimer();
    this.patchSnapshot({ elapsedSeconds });
    return elapsedSeconds;
  }

  private transition(state: SessionState, message?: string, lastError?: string) {
    if (this.manifest) {
      this.manifest.status = state;
      this.manifest.runtime.elapsedSeconds = this.snapshot.elapsedSeconds;
      if (state === "failed" && lastError) {
        this.manifest.runtime.failureSummary = lastError;
      }
      if ((state === "done" || state === "failed") && !this.manifest.runtime.finishedAt) {
        this.manifest.runtime.finishedAt = new Date().toISOString();
      }
      void this.store.writeManifest(this.manifest);
    }
    this.patchSnapshot({ state, message, lastError });
  }

  private patchSnapshot(patch: Partial<SessionRuntimeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.manifest) {
      if (typeof patch.elapsedSeconds === "number") {
        this.manifest.runtime.elapsedSeconds = patch.elapsedSeconds;
      }
      this.snapshot = {
        ...this.snapshot,
        sessionId: this.manifest.sessionId,
        scenarioKey: this.manifest.scenarioKey,
        scenarioLabel: this.manifest.scenarioLabel,
      };
    }
    this.onSnapshot?.(this.snapshot);
  }

  private requireManifest(): RecordingSessionManifest {
    if (!this.manifest) throw new Error("No active session manifest.");
    return this.manifest;
  }

  private async requireStoredSession(rootDir: string): Promise<RecordingSessionManifest> {
    const manifest = await this.store.readSessionByRootDir(rootDir);
    if (!manifest) {
      throw new Error("Unable to load the selected session.");
    }
    return manifest;
  }

  private assertNoActiveSession(): void {
    if (!STARTABLE_STATES.has(this.snapshot.state)) {
      throw new Error("Stop the active session before repairing another one.");
    }
  }

  private async failSession(message: string) {
    if (this.snapshot.state === "failed" && !this.manifest) return;
    this.stopRequested = true;
    this.stopElapsedTimer();

    const manifest = this.manifest;
    if (manifest) {
      manifest.status = "failed";
      manifest.runtime.elapsedSeconds = this.snapshot.elapsedSeconds;
      manifest.runtime.finishedAt = new Date().toISOString();
      manifest.runtime.failureSummary = message;
      if (!manifest.errors.includes(message)) {
        manifest.errors.push(message);
      }
      await this.store.appendDiagnostics(manifest, `ERROR: ${message}`);
      await this.store.writeManifest(manifest);
    }

    this.transition("failed", message, message);
    await this.cleanupRuntime();
    this.onError?.(message);
  }

  private async cleanupRuntime() {
    this.stopElapsedTimer();
    await this.stopCaptureIfRunning();
    this.captureAdapter = null;
    this.queue = null;
    this.startedAtMs = null;
    this.stopRequested = false;
    this.manifest = null;
    this.snapshot = { ...this.snapshot, queuedSegments: 0 };
    this.onSnapshot?.(this.snapshot);
  }

  private async stopCaptureIfRunning() {
    if (!this.captureAdapter?.isRunning()) return;
    try {
      await this.captureAdapter.stop();
    } catch {
      // Capture shutdown is best effort when the session is already failing.
    }
  }

  private resetSnapshot() {
    this.snapshot = {
      state: "idle",
      elapsedSeconds: 0,
      committedSegments: 0,
      queuedSegments: 0,
      liveTranscriptChars: 0,
      diagnosticsReport: this.snapshot.diagnosticsReport,
    };
    this.onSnapshot?.(this.snapshot);
  }
}
