import { Notice, Plugin } from "obsidian";
import { SessionController } from "./application/SessionController";
import { DEFAULT_SCENARIO_KEY } from "./domain/scenarios";
import { isCoreConfigured, normalizeSettings, type PluginSettings } from "./domain/settings";
import { setElementVisibility, openPluginSettings } from "./infrastructure/obsidianDesktop";
import { formatDuration } from "./utils/format";
import { uiCopy } from "./ui/copy";
import { ResonanceNextSettingTab, setPreferredSettingsTab } from "./ui/SettingsTab";
import { RecordingModal } from "./ui/modals/RecordingModal";

export default class ResonanceNextPlugin extends Plugin {
  settings!: PluginSettings;
  private controller!: SessionController;
  private controlRibbonEl!: HTMLElement;
  private libraryRibbonEl!: HTMLElement;
  private statusBarEl!: HTMLElement;
  private recordingModal: RecordingModal | null = null;

  async onload() {
    await this.loadSettings();
    this.controller = new SessionController({
      app: this.app,
      pluginId: this.manifest.id,
      getSettings: () => this.settings,
      saveSettings: async (updater) => {
        await this.updateSettings(updater);
      },
    });

    this.controller.onSnapshot = (snapshot) => {
      this.updateStatusBar(snapshot.state, snapshot.elapsedSeconds, snapshot.message);
      this.updateRibbonState(snapshot.state);
    };
    this.controller.onError = (message) => {
      new Notice(`Resonance: ${message}`);
    };
    this.controller.onInfo = (message) => {
      new Notice(message);
    };

    this.controlRibbonEl = this.addRibbonIcon("mic", uiCopy.actions.openRecorder, () => {
      this.openRecorder();
    });
    this.controlRibbonEl.addClass("rxn-ribbon");

    this.libraryRibbonEl = this.addRibbonIcon("audio-file", uiCopy.actions.openLibrary, () => {
      this.openLibrary();
    });
    this.libraryRibbonEl.addClass("rxn-ribbon");

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("rxn-statusbar");
    this.statusBarEl.setText("");
    this.statusBarEl.addEventListener("click", () => {
      this.openRecorder();
    });
    setElementVisibility(this.statusBarEl, false);

    this.addCommand({
      id: "resonance-next-open-control-room",
      name: uiCopy.actions.openRecorder,
      callback: () => {
        this.openRecorder();
      },
    });
    this.addCommand({
      id: "resonance-next-open-diagnostics",
      name: uiCopy.actions.openDiagnostics,
      callback: () => {
        this.openDiagnostics();
      },
    });
    this.addCommand({
      id: "resonance-next-quick-toggle-session",
      name: "Start the last scenario or stop the active session",
      callback: async () => {
        await this.quickToggleSession();
      },
    });
    this.addCommand({
      id: "resonance-next-open-library",
      name: uiCopy.actions.openLibrary,
      callback: () => {
        this.openLibrary();
      },
    });
    this.addCommand({
      id: "resonance-next-open-setup",
      name: uiCopy.actions.openSetupGuide,
      callback: () => {
        this.openSetupGuide();
      },
    });

    this.addSettingTab(
      new ResonanceNextSettingTab(this.app, {
        pluginId: this.manifest.id,
        getSettings: () => this.settings,
        saveSettings: async (updater) => {
          await this.updateSettings(updater);
        },
        controller: this.controller,
      })
    );

    this.app.workspace.onLayoutReady(() => {
      if (!isCoreConfigured(this.settings) && this.settings.ui.showSetupWizardOnStartup) {
        this.openSetupGuide();
      } else if (this.settings.ui.showDiagnosticsOnStartup) {
        this.openDiagnostics();
      }
    });
  }

  async onunload() {
    this.recordingModal?.close();
    this.recordingModal = null;
  }

  private async quickToggleSession() {
    const state = this.controller.getSnapshot().state;
    if (["idle", "done", "failed"].includes(state)) {
      try {
        await this.controller.startScenario(this.settings.ui.lastScenarioKey || DEFAULT_SCENARIO_KEY);
      } catch (error) {
        new Notice(String((error as Error)?.message ?? error));
      }
      return;
    }

    if (["preflight", "segmenting", "recording", "transcribing_live", "stopping"].includes(state)) {
      try {
        await this.controller.stop();
      } catch (error) {
        new Notice(String((error as Error)?.message ?? error));
      }
      return;
    }

    new Notice(uiCopy.notices.sessionBusy);
  }

  private updateStatusBar(state: string, elapsedSeconds: number, message?: string) {
    const status =
      state === "recording" || state === "transcribing_live"
        ? `Resonance ${formatDuration(elapsedSeconds)}`
        : message || "";
    this.statusBarEl.setText(status);
    setElementVisibility(this.statusBarEl, Boolean(status));
  }

  private updateRibbonState(state: string) {
    if (!this.controlRibbonEl) return;
    this.controlRibbonEl.removeClass("is-recording");
    this.controlRibbonEl.removeClass("is-busy");
    if (state === "recording" || state === "transcribing_live") {
      this.controlRibbonEl.addClass("is-recording");
    } else if (!["idle", "done", "failed"].includes(state)) {
      this.controlRibbonEl.addClass("is-busy");
    }
  }

  private openRecorder() {
    if (this.recordingModal?.isOpen()) return;
    const modal = new RecordingModal(this.app, {
      pluginId: this.manifest.id,
      controller: this.controller,
      getSettings: () => this.settings,
      onClosed: () => {
        if (this.recordingModal === modal) {
          this.recordingModal = null;
        }
      },
    });
    this.recordingModal = modal;
    modal.open();
  }

  private openLibrary() {
    setPreferredSettingsTab("library");
    openPluginSettings(this.app, this.manifest.id);
  }

  private openDiagnostics() {
    setPreferredSettingsTab("control-room");
    openPluginSettings(this.app, this.manifest.id);
  }

  private openSetupGuide() {
    setPreferredSettingsTab("capture");
    openPluginSettings(this.app, this.manifest.id);
  }

  private async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  private async updateSettings(updater: (current: PluginSettings) => PluginSettings) {
    this.settings = normalizeSettings(updater(this.settings));
    await this.saveData(this.settings);
  }
}
