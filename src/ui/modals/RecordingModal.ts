import { App, Modal, Notice } from "obsidian";
import type { SessionController } from "../../application/SessionController";
import { DEFAULT_SCENARIO_KEY, SCENARIOS, getScenario, type ScenarioTemplate } from "../../domain/scenarios";
import { isCoreConfigured, type PluginSettings } from "../../domain/settings";
import type { SessionRuntimeSnapshot, SessionState } from "../../domain/session";
import { openPluginSettings } from "../../infrastructure/obsidianDesktop";
import { formatDuration } from "../../utils/format";
import { setPreferredSettingsTab } from "../SettingsTab";
import { uiCopy } from "../copy";

interface RecordingModalOptions {
  pluginId: string;
  controller: SessionController;
  getSettings: () => PluginSettings;
  onClosed?: () => void;
}

const STARTABLE_STATES = new Set<SessionState>(["idle", "done", "failed"]);
const STOPPABLE_STATES = new Set<SessionState>(["segmenting", "recording", "transcribing_live"]);

export class RecordingModal extends Modal {
  private selectedScenarioKey: string;
  private refreshTimerId: number | null = null;
  private actionPending: "start" | "stop" | null = null;
  private opened = false;

  constructor(app: App, private readonly options: RecordingModalOptions) {
    super(app);
    const snapshot = options.controller.getSnapshot();
    this.selectedScenarioKey =
      snapshot.scenarioKey || options.getSettings().ui.lastScenarioKey || DEFAULT_SCENARIO_KEY;
  }

  isOpen(): boolean {
    return this.opened;
  }

  onOpen(): void {
    this.opened = true;
    this.modalEl.addClass("rxn-recording-modal");
    this.contentEl.addClass("rxn-modal", "rxn-recording-modal-content");
    this.render();
    this.refreshTimerId = window.setInterval(() => {
      this.render();
    }, 500);
  }

  onClose(): void {
    this.opened = false;
    if (this.refreshTimerId !== null) {
      window.clearInterval(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    this.contentEl.empty();
    this.modalEl.removeClass("rxn-recording-modal");
    this.contentEl.removeClass("rxn-modal", "rxn-recording-modal-content");
    this.options.onClosed?.();
  }

  private render(): void {
    const snapshot = this.options.controller.getSnapshot();
    const settings = this.options.getSettings();
    const scenario = getScenario(snapshot.scenarioKey || this.selectedScenarioKey);
    const canStart = STARTABLE_STATES.has(snapshot.state);
    const canStop = STOPPABLE_STATES.has(snapshot.state);
    const coreConfigured = isCoreConfigured(settings);

    this.contentEl.empty();

    const hero = this.contentEl.createDiv({ cls: "rxn-panel rxn-hero-panel rxn-recording-hero" });
    const heroHeader = hero.createDiv({ cls: "rxn-recording-hero-header" });
    const headline = heroHeader.createDiv({ cls: "rxn-section-heading" });
    headline.createEl("h2", { text: this.getHeadline(snapshot) });
    headline.createEl("p", { text: this.getSubheadline(snapshot, coreConfigured), cls: "rxn-muted" });

    const runtime = heroHeader.createDiv({ cls: "rxn-recording-runtime" });
    runtime.createSpan({ text: this.getStateLabel(snapshot.state), cls: `rxn-status-pill is-${this.getStateTone(snapshot.state)}` });
    runtime.createEl("strong", { text: formatDuration(snapshot.elapsedSeconds), cls: "rxn-recording-elapsed" });
    if (!canStart) {
      runtime.createSpan({ text: snapshot.scenarioLabel || scenario.label, cls: "rxn-muted" });
    }

    if (snapshot.lastError) {
      const note = hero.createDiv({ cls: "rxn-inline-note is-failed" });
      note.createEl("strong", { text: "Last result" });
      note.createEl("p", { text: snapshot.lastError });
    }

    if (canStart) {
      this.renderScenarioPicker();
      this.renderStartActions(snapshot, coreConfigured);
      return;
    }

    this.renderActiveSession(snapshot, scenario, canStop);
  }

  private renderScenarioPicker(): void {
    const picker = this.contentEl.createDiv({ cls: "rxn-panel" });

    const grid = picker.createDiv({ cls: "rxn-scenario-grid" });
    for (const scenario of SCENARIOS) {
      const button = grid.createEl("button", { cls: "rxn-scenario-option" });
      if (scenario.key === this.selectedScenarioKey) {
        button.addClass("is-selected");
      }
      button.disabled = this.actionPending !== null;
      button.createEl("strong", { text: scenario.label });
      button.createEl("p", { text: scenario.description });
      button.addEventListener("click", () => {
        this.selectedScenarioKey = scenario.key;
        this.render();
      });
    }
  }

  private renderStartActions(snapshot: SessionRuntimeSnapshot, coreConfigured: boolean): void {
    const panel = this.contentEl.createDiv({ cls: "rxn-panel" });
    const meta = panel.createDiv({ cls: "rxn-pill-row" });
    meta.createSpan({ text: `Provider: ${this.options.getSettings().summary.provider}`, cls: "rxn-pill" });

    if (!coreConfigured) {
      const note = panel.createDiv({ cls: "rxn-inline-note is-warning" });
      note.createEl("strong", { text: "Setup incomplete" });
      note.createEl("p", { text: "Finish capture, transcription, and summary setup before starting your first recording." });
    } else if (snapshot.state === "done") {
      const note = panel.createDiv({ cls: "rxn-inline-note is-healthy" });
      note.createEl("strong", { text: "Last session completed" });
      note.createEl("p", { text: "You can start a new recording with the same style or pick a different one." });
    }

    const actions = panel.createDiv({ cls: "rxn-action-bar" });
    this.createActionButton(
      actions,
      this.actionPending === "start" ? "Starting..." : "Start recording",
      async () => {
        this.actionPending = "start";
        this.render();
        try {
          await this.options.controller.startScenario(this.selectedScenarioKey);
        } catch {
          // The controller publishes the error through the plugin notice channel.
        }
        this.actionPending = null;
        this.render();
      },
      "rxn-btn-primary",
      this.actionPending !== null || !coreConfigured
    );
    this.createActionButton(actions, uiCopy.actions.openLibrary, () => {
      this.close();
      setPreferredSettingsTab("library");
      openPluginSettings(this.app, this.options.pluginId);
    }, "rxn-btn-secondary");
    this.createActionButton(actions, uiCopy.actions.openLiveTranscript, async () => {
      const opened = await this.options.controller.openActiveLiveTranscript();
      if (!opened) {
        new Notice("The live transcript note appears after the first transcript chunk is committed.");
      }
    }, "rxn-btn-secondary", !this.options.controller.getActiveLiveTranscriptNotePath());
  }

  private renderActiveSession(
    snapshot: SessionRuntimeSnapshot,
    scenario: ScenarioTemplate,
    canStop: boolean
  ): void {
    const live = this.contentEl.createDiv({ cls: "rxn-panel rxn-recording-live" });
    live.createEl("h3", { text: snapshot.scenarioLabel || scenario.label });
    live.createEl("p", {
      text:
        snapshot.state === "stopping"
          ? "Recording has stopped. Resonance is finishing the remaining transcript and summary work."
          : snapshot.state === "summarizing" || snapshot.state === "persisting"
          ? "Recording is done. Resonance is writing the final note and session files."
          : snapshot.state === "transcribing_live"
          ? "Recording is active and live transcription is catching up."
          : "Recording is active. Stop when you are ready to generate the final summary.",
      cls: "rxn-muted",
    });

    const actions = live.createDiv({ cls: "rxn-action-bar" });
    const stopLabel =
      this.actionPending === "stop"
        ? "Stopping..."
        : canStop
        ? uiCopy.actions.stopSession
        : snapshot.state === "preflight"
        ? "Starting..."
        : "Finalizing...";
    this.createActionButton(
      actions,
      stopLabel,
      () => {
        this.actionPending = "stop";
        this.render();
        new Notice("Stopping session. Resonance will finish transcript and summary in the background.");
        this.close();
        void this.options.controller.stop().catch((error) => {
          const message = String((error as Error)?.message ?? error);
          new Notice(`Unable to stop session: ${message}`);
        });
      },
      canStop ? "rxn-btn-danger" : "rxn-btn-secondary",
      this.actionPending !== null || !canStop
    );
    this.createActionButton(actions, uiCopy.actions.openLibrary, () => {
      this.close();
      setPreferredSettingsTab("library");
      openPluginSettings(this.app, this.options.pluginId);
    }, "rxn-btn-secondary");
    this.createActionButton(actions, uiCopy.actions.openLiveTranscript, async () => {
      const opened = await this.options.controller.openActiveLiveTranscript();
      if (!opened) {
        new Notice("The live transcript note appears after the first transcript chunk is committed.");
      }
    }, "rxn-btn-secondary", !this.options.controller.getActiveLiveTranscriptNotePath());

    const metrics = this.contentEl.createDiv({ cls: "rxn-recording-metrics" });
    this.renderMetric(metrics, "Committed", String(snapshot.committedSegments), "Written");
    this.renderMetric(metrics, "Queued", String(snapshot.queuedSegments), "Waiting");
    this.renderMetric(metrics, "Transcript", String(snapshot.liveTranscriptChars), "Characters");
  }

  private renderMetric(container: HTMLElement, label: string, value: string, detail: string): void {
    const card = container.createDiv({ cls: "rxn-panel rxn-recording-metric" });
    card.createSpan({ text: label, cls: "rxn-eyebrow" });
    card.createEl("strong", { text: value });
    card.createEl("p", { text: detail, cls: "rxn-muted" });
  }

  private createActionButton(
    container: HTMLElement,
    label: string,
    onClick: () => Promise<void> | void,
    cls: string,
    disabled = false
  ): void {
    const button = container.createEl("button", { text: label, cls });
    button.disabled = disabled;
    button.addEventListener("click", () => {
      void onClick();
    });
  }

  private getHeadline(snapshot: SessionRuntimeSnapshot): string {
    if (STARTABLE_STATES.has(snapshot.state)) {
      return "Record with Resonance";
    }
    if (snapshot.state === "stopping" || snapshot.state === "summarizing" || snapshot.state === "persisting") {
      return "Finishing the session";
    }
    return "Recording in progress";
  }

  private getSubheadline(snapshot: SessionRuntimeSnapshot, coreConfigured: boolean): string {
    if (snapshot.state === "failed" && snapshot.lastError) {
      return snapshot.lastError;
    }
    if (snapshot.state === "done") {
      return "The session is complete. Start another one when you are ready.";
    }
    if (STARTABLE_STATES.has(snapshot.state)) {
      return coreConfigured
        ? "Choose a style, then start recording."
        : "Finish setup first, then choose a style and start recording.";
    }
    return snapshot.message || "You can stop the recording here when you are ready.";
  }

  private getStateLabel(state: SessionState): string {
    switch (state) {
      case "idle":
        return "Ready";
      case "preflight":
        return "Starting";
      case "segmenting":
      case "recording":
      case "transcribing_live":
        return "Recording";
      case "stopping":
        return "Stopping";
      case "summarizing":
      case "persisting":
        return "Finalizing";
      case "done":
        return "Completed";
      case "failed":
        return "Failed";
    }
  }

  private getStateTone(state: SessionState): "healthy" | "warning" | "failed" {
    switch (state) {
      case "done":
        return "healthy";
      case "failed":
        return "failed";
      default:
        return "warning";
    }
  }
}
