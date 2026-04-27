import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { buildDashboardSnapshot, deriveSessionListItem } from "../application/dashboard";
import type { SessionController } from "../application/SessionController";
import type { DashboardSnapshot } from "../domain/dashboard";
import type { SessionListItem } from "../domain/session";
import { isCoreConfigured, resolveCaptureBackend, type PluginSettingsV2 } from "../domain/settings";
import { VaultAdapter } from "../infrastructure/adapters/VaultAdapter";
import { requireNodeModule } from "../infrastructure/node";
import {
  autoDetectFfmpeg,
  autoDetectWhisperCli,
  autoDetectWhisperModel,
  autoDetectWhisperRepo,
  inferWhisperRepoPath,
} from "../infrastructure/system/autoDetect";
import { getPluginInstance } from "../infrastructure/obsidianDesktop";
import { scanDevices } from "../infrastructure/system/deviceScanner";
import { SessionStore } from "../infrastructure/storage/SessionStore";
import { formatBytes, formatDuration } from "../utils/format";
import { uiCopy } from "./copy";
import { TextPreviewModal } from "./modals/TextPreviewModal";

export type SettingsSurfaceTab = "control-room" | "library" | "capture" | "transcription" | "summary" | "output";
type GuidePlatform = "macos" | "linux" | "windows";
type LibraryFilter = "all" | "done" | "failed";

interface SettingsTabOptions {
  pluginId: string;
  getSettings: () => PluginSettingsV2;
  saveSettings: (updater: (current: PluginSettingsV2) => PluginSettingsV2) => Promise<void>;
  controller: SessionController;
}

interface PlatformGuide {
  text?: string;
  bullets?: string[];
  code?: string;
  codeBlocks?: Array<{
    label?: string;
    code: string;
  }>;
}

interface GuideSectionOptions {
  badge: string;
  title: string;
  intro: string;
  bullets?: string[];
  code?: string;
  platformGuides?: Partial<Record<GuidePlatform, PlatformGuide>>;
}

interface SettingsTabDefinition {
  key: SettingsSurfaceTab;
  label: string;
  subtitle: string;
}

const WORKSPACE_TABS: SettingsTabDefinition[] = [
  {
    key: "control-room",
    label: "Diagnostics",
    subtitle: "Health and blocking issues.",
  },
  {
    key: "library",
    label: "Library",
    subtitle: "Sessions, notes, artifacts.",
  },
];

const SETUP_TABS: SettingsTabDefinition[] = [
  {
    key: "capture",
    label: "Capture",
    subtitle: "FFmpeg, devices, quick test.",
  },
  {
    key: "transcription",
    label: "Transcription",
    subtitle: "whisper.cpp and model.",
  },
  {
    key: "summary",
    label: "Summary",
    subtitle: "Provider and model.",
  },
  {
    key: "output",
    label: "Output",
    subtitle: "Notes, retention, startup.",
  },
];

const GUIDE_PLATFORM_ORDER: GuidePlatform[] = ["macos", "linux", "windows"];

const GUIDE_PLATFORM_LABELS: Record<GuidePlatform, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

let preferredSettingsTab: SettingsSurfaceTab = "capture";

export function setPreferredSettingsTab(tab: SettingsSurfaceTab): void {
  preferredSettingsTab = tab;
}

export class ResonanceNextSettingTab extends PluginSettingTab {
  private readonly store: SessionStore;
  private readonly vaultAdapter: VaultAdapter;
  private readonly audioUrlCache = new Map<string, string>();
  private activeTab: SettingsSurfaceTab = preferredSettingsTab;
  private libraryItems: SessionListItem[] = [];
  private libraryFilter: LibraryFilter = "all";
  private libraryQuery = "";
  private openAudioSessionId: string | null = null;
  private libraryBusySessionId: string | null = null;
  private libraryBusyAction: "transcript" | "summary" | null = null;
  private isQuickTestRunning = false;
  private smokeMessage: string | null = null;

  constructor(app: App, private readonly options: SettingsTabOptions) {
    super(app, getPluginInstance(app, options.pluginId)!);
    this.store = new SessionStore(app, options.pluginId);
    this.vaultAdapter = new VaultAdapter(app);
  }

  async display() {
    this.activeTab = preferredSettingsTab;
    if (this.activeTab === "control-room") {
      await this.refreshControlRoomData(true);
    } else if (this.activeTab === "library" && this.libraryItems.length === 0) {
      await this.refreshLibraryData();
    }

    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("rxn-settings");

    this.renderHero(containerEl);
    this.renderTabs(containerEl);

    const body = containerEl.createEl("div", { cls: "rxn-settings-surface" });
    if (this.activeTab === "control-room") {
      await this.renderControlRoomTab(body);
      return;
    }

    if (this.activeTab === "library") {
      await this.renderLibraryTab(body);
      return;
    }

    if (this.activeTab === "capture") {
      await this.renderCaptureTab(body);
      return;
    }

    if (this.activeTab === "transcription") {
      await this.renderTranscriptionTab(body);
      return;
    }

    if (this.activeTab === "summary") {
      await this.renderSummaryTab(body);
      return;
    }

    await this.renderOutputTab(body);
  }

  private renderHero(container: HTMLElement) {
    const hero = container.createEl("div", { cls: "rxn-card rxn-hero" });
    hero.createEl("h2", { text: uiCopy.appName, cls: "rxn-hero-brand" });
    hero.createEl("p", {
      text: uiCopy.settings.title,
      cls: "rxn-muted rxn-hero-subtitle",
    });
  }

  private renderTabs(container: HTMLElement) {
    const groups = container.createEl("div", { cls: "rxn-settings-tab-groups" });
    this.renderTabGroup(groups, "Workspace", WORKSPACE_TABS);
    this.renderTabGroup(groups, "Setup", SETUP_TABS, true);
  }

  private async switchTab(tab: SettingsSurfaceTab) {
    preferredSettingsTab = tab;
    this.activeTab = tab;
    if (tab === "library") {
      await this.refreshLibraryData();
    }
    await this.display();
  }

  private renderTabGroup(
    container: HTMLElement,
    title: string,
    tabs: SettingsTabDefinition[],
    numbered = false
  ) {
    const group = container.createEl("div", {
      cls: numbered ? "rxn-settings-tab-group is-setup" : "rxn-settings-tab-group is-workspace",
    });
    group.createEl("span", { text: title, cls: "rxn-settings-tab-group-label" });
    const row = group.createEl("div", { cls: "rxn-settings-tabs" });
    tabs.forEach((tab, index) => {
      const button = row.createEl("button", { cls: "rxn-settings-tab" });
      if (tab.key === this.activeTab) {
        button.addClass("is-selected");
      }
      button.setAttribute("title", tab.subtitle);
      button.createEl("strong", { text: numbered ? `${index + 1}. ${tab.label}` : tab.label });
      button.addEventListener("click", () => {
        void this.switchTab(tab.key);
      });
    });
  }

  private async refreshControlRoomData(forceDiagnostics: boolean) {
    if (forceDiagnostics) {
      await this.options.controller.runDiagnostics();
    }
  }

  private async refreshLibraryData() {
    const manifests = await this.store.listSessions();
    this.libraryItems = manifests.map((manifest) =>
      deriveSessionListItem(manifest, this.store.getAudioSize(manifest.paths.fullAudioPath))
    );
  }

  private buildDashboardSnapshot(): DashboardSnapshot {
    return buildDashboardSnapshot({
      runtime: this.options.controller.getSnapshot(),
      diagnosticsReport: this.options.controller.getSnapshot().diagnosticsReport,
      recentSessions: [],
      isCoreConfigured: isCoreConfigured(this.options.getSettings()),
    });
  }

  private async renderControlRoomTab(container: HTMLElement) {
    const snapshot = this.buildDashboardSnapshot();
    const intro = this.createGuideSection(container, {
      badge: "Workspace",
      title: "Diagnostics",
      intro: "Check what is blocking the local pipeline and fix it in the setup tabs.",
    });

    const actions = intro.createDiv({ cls: "rxn-action-bar" });
    this.createActionButton(actions, uiCopy.actions.refreshHealth, async () => {
      await this.refreshControlRoomData(true);
      await this.display();
    }, "rxn-btn-secondary");
    this.createActionButton(actions, this.isQuickTestRunning ? "Running quick test..." : uiCopy.actions.runQuickTest, async () => {
      await this.runQuickTest();
    }, "rxn-btn-secondary", this.isQuickTestRunning);

    const meta = intro.createDiv({ cls: "rxn-pill-row rxn-diagnostics-meta" });
    meta.createEl("span", {
      text: snapshot.health.badge === "failed" ? "Blocked" : snapshot.health.badge === "warning" ? "Needs review" : "Ready",
      cls: `rxn-status-pill is-${snapshot.health.badge}`,
    });
    meta.createEl("span", { text: `${snapshot.health.blockingCount} blocking`, cls: "rxn-pill" });
    meta.createEl("span", { text: `${snapshot.health.warningCount} warnings`, cls: "rxn-pill" });
    meta.createEl("span", {
      text: `Quick test: ${
        this.isQuickTestRunning ? "running" : this.smokeMessage ? (this.smokeMessage.includes("failed") ? "failed" : "passed") : "not run"
      }`,
      cls: "rxn-pill",
    });
    meta.createEl("span", { text: `Backend: ${snapshot.health.report?.backend ?? "n/a"}`, cls: "rxn-pill" });

    if (this.smokeMessage) {
      const smoke = intro.createDiv({ cls: `rxn-inline-note ${this.smokeMessage.includes("failed") ? "is-failed" : "is-healthy"}` });
      smoke.createEl("strong", { text: "Quick test" });
      smoke.createEl("p", { text: this.smokeMessage });
    }

    const issues = intro.createDiv({ cls: "rxn-diagnostics-stack" });
    const blockingChecks = snapshot.health.groups.blocking;
    const warningChecks = snapshot.health.groups.warnings;
    if (blockingChecks.length === 0 && warningChecks.length === 0) {
      const ok = issues.createDiv({ cls: "rxn-check-card is-healthy" });
      ok.createEl("strong", { text: "No blocking issues or warnings" });
      ok.createEl("p", { text: snapshot.health.report?.summary ?? uiCopy.status.ready, cls: "rxn-muted" });
    } else {
      this.renderDiagnosticChecks(issues, blockingChecks, "is-failed");
      this.renderDiagnosticChecks(issues, warningChecks, "is-warning");
    }

    const settings = this.options.getSettings();
    const preferences = this.createGuideSection(container, {
      badge: "Preferences",
      title: "Quick test and startup",
      intro: "Use these to tune the smoke test and choose which tab opens first.",
    });

    new Setting(preferences)
      .setName("Quick test seconds")
      .setDesc("Length of the quick recording.")
      .addText((text) =>
        text.setValue(String(settings.diagnostics.quickTestDurationSeconds)).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            diagnostics: {
              ...current.diagnostics,
              quickTestDurationSeconds: Math.max(1, Math.min(10, Number(value) || 2)),
            },
          }));
        })
      );

    new Setting(preferences)
      .setName("Open setup on startup")
      .setDesc("Open Capture on launch.")
      .addToggle((toggle) =>
        toggle.setValue(settings.ui.showSetupWizardOnStartup).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            ui: { ...current.ui, showSetupWizardOnStartup: value },
          }));
        })
      );

    new Setting(preferences)
      .setName("Open diagnostics on startup")
      .setDesc("Open Diagnostics on launch.")
      .addToggle((toggle) =>
        toggle.setValue(settings.ui.showDiagnosticsOnStartup).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            ui: { ...current.ui, showDiagnosticsOnStartup: value },
          }));
        })
      );

    preferences.createEl("p", {
      cls: "rxn-muted",
      text: "Session logs are available in Library with Preview diagnostics.",
    });
  }

  private async renderCaptureTab(container: HTMLElement) {
    const settings = this.options.getSettings();
    const ffmpeg = this.createGuideSection(container, {
      badge: "Recorder",
      title: "FFmpeg",
      intro: "FFmpeg is required for recording.",
      platformGuides: {
        macos: {
          text: "Install FFmpeg, then paste the path to ffmpeg below.",
          code: "brew install ffmpeg",
        },
        linux: {
          text: "Install FFmpeg with your package manager, then paste the path below.",
          code: "sudo apt install ffmpeg",
        },
        windows: {
          text: "Install FFmpeg, then paste the full path to ffmpeg.exe below.",
          code: "winget install Gyan.FFmpeg",
        },
      },
    });

    new Setting(ffmpeg)
      .setName("FFmpeg path")
      .setDesc("Path to the FFmpeg executable.")
      .addText((text) =>
        text.setPlaceholder("/opt/homebrew/bin/ffmpeg").setValue(settings.capture.ffmpegPath).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            capture: { ...current.capture, ffmpegPath: value.trim() },
          }));
        })
      )
      .addButton((button) =>
        button.setButtonText(uiCopy.actions.detectFfmpeg).onClick(async () => {
          const detected = await autoDetectFfmpeg();
          if (!detected) {
            new Notice(uiCopy.notices.ffmpegNotDetected);
            return;
          }
          await this.options.saveSettings((current) => ({
            ...current,
            capture: { ...current.capture, ffmpegPath: detected },
          }));
          new Notice(uiCopy.notices.ffmpegDetected);
          await this.display();
        })
      );

    const capture = this.createGuideSection(container, {
      badge: "Devices",
      title: "Inputs",
      intro: "Pick a microphone. Add system audio only if you really need it.",
      platformGuides: {
        macos: {
          bullets: ["For system audio, install a loopback device such as BlackHole and select it below."],
        },
        linux: {
          bullets: ["For system audio, use a PulseAudio or PipeWire monitor source if available."],
        },
        windows: {
          bullets: ["For system audio, use a loopback device such as VB-Cable and select it below."],
        },
      },
    });

    new Setting(capture)
      .setName("Backend")
      .setDesc("Use Automatic unless device scan fails.")
      .addDropdown((dropdown) => {
        dropdown.addOption("auto", "Automatic");
        dropdown.addOption("avfoundation", "avfoundation (macOS)");
        dropdown.addOption("dshow", "dshow (Windows)");
        dropdown.addOption("pulse", "pulse (Linux)");
        dropdown.addOption("alsa", "alsa (Linux)");
        dropdown.setValue(settings.capture.backend);
        dropdown.onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            capture: { ...current.capture, backend: value as PluginSettingsV2["capture"]["backend"] },
          }));
        });
      });

    const micSetting = new Setting(capture)
      .setName("Microphone device")
      .setDesc("Pick the microphone to record.");
    const micSelect = micSetting.controlEl.createEl("select");
    micSelect.addClass("rxn-inline-select");

    const systemSetting = new Setting(capture)
      .setName("System audio device")
      .setDesc("Optional loopback or monitor input.");
    const systemSelect = systemSetting.controlEl.createEl("select");
    systemSelect.addClass("rxn-inline-select");

    const captureActions = capture.createDiv({ cls: "rxn-action-bar" });
    this.createActionButton(captureActions, uiCopy.actions.refreshDevices, async () => {
      await this.populateDevices(micSelect, systemSelect, true);
    }, "rxn-btn-secondary");
    this.createActionButton(
      captureActions,
      this.isQuickTestRunning ? "Running quick test..." : uiCopy.actions.runQuickTest,
      async () => {
        await this.runQuickTest();
        await this.switchTab("control-room");
      },
      "rxn-btn-secondary",
      this.isQuickTestRunning
    );

    const captureMeta = capture.createDiv({ cls: "rxn-pill-row rxn-diagnostics-meta" });
    captureMeta.createEl("span", {
      text: `Backend: ${resolveCaptureBackend(settings.capture.backend)}`,
      cls: "rxn-pill",
    });

    await this.populateDevices(micSelect, systemSelect);
    micSelect.addEventListener("change", async () => {
      const selected = micSelect.options[micSelect.selectedIndex];
      if (!selected?.value) return;
      await this.options.saveSettings((current) => ({
        ...current,
        capture: {
          ...current.capture,
          microphoneDevice: selected.value,
          microphoneLabel: selected.text,
        },
      }));
    });
    systemSelect.addEventListener("change", async () => {
      const selected = systemSelect.options[systemSelect.selectedIndex];
      await this.options.saveSettings((current) => ({
        ...current,
        capture: {
          ...current.capture,
          systemDevice: selected?.value ?? "",
          systemLabel: selected?.value ? selected.text : "",
        },
      }));
    });

    new Setting(capture)
      .setName("Sample rate")
      .setDesc("Usually 48000.")
      .addText((text) =>
        text.setValue(String(settings.capture.sampleRateHz)).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            capture: { ...current.capture, sampleRateHz: Math.max(8_000, Math.min(192_000, Number(value) || 48_000)) },
          }));
        })
      );

    new Setting(capture)
      .setName("Channels")
      .setDesc("Mono is lighter. Stereo keeps more room context.")
      .addDropdown((dropdown) => {
        dropdown.addOption("1", "Mono");
        dropdown.addOption("2", "Stereo");
        dropdown.setValue(String(settings.capture.channels));
        dropdown.onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            capture: { ...current.capture, channels: value === "1" ? 1 : 2 },
          }));
        });
      });

    new Setting(capture)
      .setName("Bitrate / segment seconds")
      .setDesc("MP3 quality and live chunk length.")
      .addText((text) =>
        text.setPlaceholder("160").setValue(String(settings.capture.bitrateKbps)).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            capture: { ...current.capture, bitrateKbps: Math.max(64, Math.min(320, Number(value) || 160)) },
          }));
        })
      )
      .addText((text) =>
        text.setPlaceholder("20").setValue(String(settings.capture.segmentDurationSeconds)).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            capture: { ...current.capture, segmentDurationSeconds: Math.max(5, Math.min(300, Number(value) || 20)) },
          }));
        })
      );
  }

  private async renderTranscriptionTab(container: HTMLElement) {
    const settings = this.options.getSettings();
    const transcription = this.createGuideSection(container, {
      badge: "whisper.cpp",
      title: "Local transcription",
      intro: "Build whisper.cpp once, then point the plugin to whisper-cli.",
      platformGuides: {
        macos: {
          text: "Clone and build whisper.cpp once. Then set repo and CLI path below.",
          code: "git clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp\ncmake -S . -B build\ncmake --build build -j",
        },
        linux: {
          text: "Clone and build whisper.cpp once. Then set repo and CLI path below.",
          code: "git clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp\ncmake -S . -B build\ncmake --build build -j",
        },
        windows: {
          text: "Clone and build whisper.cpp once. Then set repo and CLI path below.",
          code: "git clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp\ncmake -S . -B build\ncmake --build build --config Release",
        },
      },
      bullets: [
        "Repo path is optional, but helps auto-detect.",
        "CLI path is required.",
      ],
    });

    new Setting(transcription)
      .setName("whisper.cpp repo")
      .setDesc("Optional. Helps auto-detect CLI and model.")
      .addText((text) =>
        text.setPlaceholder("/path/to/whisper.cpp").setValue(settings.transcription.whisperRepoPath).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: { ...current.transcription, whisperRepoPath: value.trim() },
          }));
        })
      )
      .addButton((button) =>
        button.setButtonText(uiCopy.actions.detectWhisperRepo).onClick(async () => {
          const detected = await autoDetectWhisperRepo();
          if (!detected) {
            new Notice(uiCopy.notices.whisperRepoNotDetected);
            return;
          }
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: { ...current.transcription, whisperRepoPath: detected },
          }));
          new Notice(uiCopy.notices.whisperRepoDetected);
          await this.display();
        })
      );

    new Setting(transcription)
      .setName("whisper.cpp CLI")
      .setDesc("Path to whisper-cli.")
      .addText((text) =>
        text.setPlaceholder("/path/to/whisper-cli").setValue(settings.transcription.whisperCliPath).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: { ...current.transcription, whisperCliPath: value.trim() },
          }));
        })
      )
      .addButton((button) =>
        button.setButtonText(uiCopy.actions.detectWhisper).onClick(async () => {
          const detected = await autoDetectWhisperCli(this.options.getSettings().transcription.whisperRepoPath);
          if (!detected) {
            new Notice(uiCopy.notices.whisperNotDetected);
            return;
          }
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: {
              ...current.transcription,
              whisperCliPath: detected,
              whisperRepoPath: current.transcription.whisperRepoPath || inferWhisperRepoPath(detected) || "",
            },
          }));
          new Notice(uiCopy.notices.whisperDetected);
          await this.display();
        })
      );

    const selectedModelPreset = settings.transcription.modelPreset;
    const selectedModelLabel = this.getWhisperModelLabel(selectedModelPreset);
    const selectedModelFilename = this.getWhisperModelFilename(selectedModelPreset);
    const model = container.createEl("div", { cls: "rxn-card rxn-step-section" });
    const modelHeader = model.createEl("div", { cls: "rxn-step-section-header" });
    modelHeader.createEl("span", { text: "Model", cls: "rxn-step-section-badge" });
    modelHeader.createEl("h3", { text: "Whisper model" });
    model.createEl("p", {
      text: "Choose a model size first. Then download that model once and point Model path to the file.",
      cls: "rxn-muted",
    });

    new Setting(model)
      .setName("Model size")
      .setDesc("This updates the download commands below and what Detect model looks for first.")
      .addDropdown((dropdown) => {
        dropdown.addOption("base", "Base");
        dropdown.addOption("small", "Small");
        dropdown.addOption("medium", "Medium");
        dropdown.addOption("large", "Large");
        dropdown.setValue(selectedModelPreset);
        dropdown.onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: {
              ...current.transcription,
              modelPreset: value as PluginSettingsV2["transcription"]["modelPreset"],
            },
          }));
          await this.display();
        });
      });

    this.renderPlatformGuide(
      model,
      {
        macos: {
          codeBlocks: [
            {
              label: "Go to the models folder",
              code: "cd /path/to/whisper.cpp/models",
            },
            {
              label: `Download ${selectedModelLabel.toLowerCase()}`,
              code: `./download-ggml-model.sh ${selectedModelPreset}`,
            },
          ],
        },
        linux: {
          codeBlocks: [
            {
              label: "Go to the models folder",
              code: "cd /path/to/whisper.cpp/models",
            },
            {
              label: `Download ${selectedModelLabel.toLowerCase()}`,
              code: `./download-ggml-model.sh ${selectedModelPreset}`,
            },
          ],
        },
        windows: {
          codeBlocks: [
            {
              label: "Go to the models folder",
              code: "cd C:\\path\\to\\whisper.cpp\\models",
            },
            {
              label: `Download ${selectedModelLabel.toLowerCase()}`,
              code: `download-ggml-model.cmd ${selectedModelPreset}`,
            },
          ],
        },
      },
      true
    );

    const modelBullets = model.createEl("ul", { cls: "rxn-guide-list" });
    modelBullets.createEl("li", {
      text: `${selectedModelFilename} is the first file Detect model will look for.`,
    });
    modelBullets.createEl("li", {
      text: "For higher reliability, try Medium or Large if your machine can handle them.",
    });

    new Setting(model)
      .setName("Model path")
      .setDesc("Path to the ggml model file whisper.cpp should use.")
      .addText((text) =>
        text
          .setPlaceholder(`/path/to/${selectedModelFilename}`)
          .setValue(settings.transcription.modelPath)
          .onChange(async (value) => {
            await this.options.saveSettings((current) => ({
              ...current,
              transcription: { ...current.transcription, modelPath: value.trim() },
            }));
          })
      )
      .addButton((button) =>
        button.setButtonText(`Detect ${selectedModelLabel}`).onClick(async () => {
          const current = this.options.getSettings();
          const detected = await autoDetectWhisperModel({
            repoPath: current.transcription.whisperRepoPath,
            whisperCliPath: current.transcription.whisperCliPath,
            preset: current.transcription.modelPreset,
          });
          if (!detected) {
            new Notice(uiCopy.notices.modelNotDetected);
            return;
          }
          await this.options.saveSettings((currentSettings) => ({
            ...currentSettings,
            transcription: { ...currentSettings.transcription, modelPath: detected },
          }));
          new Notice(uiCopy.notices.modelDetected);
          await this.display();
        })
      );

    new Setting(transcription)
      .setName("Language / beam")
      .setDesc("Leave Automatic unless you always record one language.")
      .addDropdown((dropdown) => {
        dropdown.addOption("auto", "Automatic");
        dropdown.addOption("it", "Italian");
        dropdown.addOption("en", "English");
        dropdown.addOption("es", "Spanish");
        dropdown.addOption("fr", "French");
        dropdown.setValue(settings.transcription.language);
        dropdown.onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: { ...current.transcription, language: value },
          }));
        });
      })
      .addText((text) =>
        text.setValue(String(settings.transcription.beamSize)).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: { ...current.transcription, beamSize: Math.max(1, Math.min(10, Number(value) || 5)) },
          }));
        })
      );

    new Setting(transcription)
      .setName("Entropy / logprob thresholds")
      .setDesc("Advanced. Leave as is unless transcription is unstable.")
      .addText((text) =>
        text.setValue(String(settings.transcription.entropyThreshold)).onChange(async (value) => {
          const parsed = Number(value);
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: {
              ...current.transcription,
              entropyThreshold: Number.isFinite(parsed) ? parsed : current.transcription.entropyThreshold,
            },
          }));
        })
      )
      .addText((text) =>
        text.setValue(String(settings.transcription.logprobThreshold)).onChange(async (value) => {
          const parsed = Number(value);
          await this.options.saveSettings((current) => ({
            ...current,
            transcription: {
              ...current.transcription,
              logprobThreshold: Number.isFinite(parsed) ? parsed : current.transcription.logprobThreshold,
            },
          }));
        })
      );
  }

  private async renderSummaryTab(container: HTMLElement) {
    const settings = this.options.getSettings();
    const summary = this.createGuideSection(container, {
      badge: "Provider",
      title: "Final note",
      intro: "Pick one provider for the final summary.",
      platformGuides: {
        macos: {
          text: "For the local path, install Ollama and pull one model.",
          code: "brew install ollama\nollama serve\nollama pull gemma3",
        },
        linux: {
          text: "For the local path, install Ollama and pull one model.",
          code: "curl -fsSL https://ollama.com/install.sh | sh\nollama serve\nollama pull gemma3",
        },
        windows: {
          text: "For the local path, install Ollama and pull one model.",
          code: "winget install Ollama.Ollama\nollama pull gemma3",
        },
      },
    });

    new Setting(summary)
      .setName("Provider")
      .setDesc("Ollama is local. Cloud providers need API key and model.")
      .addDropdown((dropdown) => {
        dropdown.addOption("ollama", "Ollama (recommended)");
        dropdown.addOption("gemini", "Gemini (experimental)");
        dropdown.addOption("openai", "OpenAI (experimental)");
        dropdown.addOption("anthropic", "Anthropic (experimental)");
        dropdown.setValue(settings.summary.provider);
        dropdown.onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            summary: { ...current.summary, provider: value as PluginSettingsV2["summary"]["provider"] },
          }));
          await this.display();
        });
      });

    if (settings.summary.provider === "ollama") {
      new Setting(summary)
        .setName("Ollama endpoint / model")
        .setDesc("Local server URL and model tag.")
        .addText((text) =>
          text.setPlaceholder("http://localhost:11434").setValue(settings.summary.ollamaEndpoint).onChange(async (value) => {
            await this.options.saveSettings((current) => ({
              ...current,
              summary: { ...current.summary, ollamaEndpoint: value.trim() },
            }));
          })
        )
        .addText((text) =>
          text.setPlaceholder("gemma3").setValue(settings.summary.ollamaModel).onChange(async (value) => {
            await this.options.saveSettings((current) => ({
              ...current,
              summary: { ...current.summary, ollamaModel: value.trim() },
            }));
          })
        );
      return;
    }

    const fieldMap = {
      gemini: ["geminiApiKey", "geminiModel"] as const,
      openai: ["openaiApiKey", "openaiModel"] as const,
      anthropic: ["anthropicApiKey", "anthropicModel"] as const,
    };
    const [apiKeyField, modelField] = fieldMap[settings.summary.provider];
    new Setting(summary)
      .setName("API key / model")
      .setDesc("Cloud provider credentials for this machine.")
      .addText((text) => {
        text.setValue(settings.summary[apiKeyField]).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            summary: { ...current.summary, [apiKeyField]: value } as PluginSettingsV2["summary"],
          }));
        });
        text.inputEl.type = "password";
      })
      .addText((text) =>
        text.setValue(settings.summary[modelField]).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            summary: { ...current.summary, [modelField]: value } as PluginSettingsV2["summary"],
          }));
        })
      );
  }

  private async renderOutputTab(container: HTMLElement) {
    const settings = this.options.getSettings();
    const output = this.createGuideSection(container, {
      badge: "Vault",
      title: "Notes and retention",
      intro: "Choose where notes go and how much history to keep.",
    });

    new Setting(output)
      .setName("Vault folder")
      .setDesc("Folder for notes inside the current vault.")
      .addText((text) =>
        text.setValue(settings.output.vaultFolder).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            output: { ...current.output, vaultFolder: value.trim() },
          }));
        })
      );

    new Setting(output)
      .setName("Store live transcript note")
      .setDesc("Write the live transcript into a vault note while recording.")
      .addToggle((toggle) =>
        toggle.setValue(settings.output.storeLiveTranscriptInVault).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            output: { ...current.output, storeLiveTranscriptInVault: value },
          }));
        })
      );

    new Setting(output)
      .setName("Open summary automatically")
      .setDesc("Open the final note after a successful session.")
      .addToggle((toggle) =>
        toggle.setValue(settings.output.openSummaryAfterCreate).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            output: { ...current.output, openSummaryAfterCreate: value },
          }));
        })
      );

    new Setting(output)
      .setName("Completed sessions kept")
      .setDesc("Older finished sessions are pruned. Use 0 to disable.")
      .addText((text) =>
        text.setValue(String(settings.output.maxSessionsKept)).onChange(async (value) => {
          await this.options.saveSettings((current) => ({
            ...current,
            output: { ...current.output, maxSessionsKept: Math.max(0, Number(value) || 0) },
          }));
        })
      );

  }

  private async renderLibraryTab(container: HTMLElement) {
    const library = this.createGuideSection(container, {
      badge: "Workspace",
      title: uiCopy.library.title,
      intro: "Review completed and failed sessions here.",
    });

    const controls = library.createDiv({ cls: "rxn-toolbar" });
    const filterRow = controls.createDiv({ cls: "rxn-filter-row" });
    this.renderLibraryFilterChip(filterRow, uiCopy.library.all, "all");
    this.renderLibraryFilterChip(filterRow, uiCopy.library.done, "done");
    this.renderLibraryFilterChip(filterRow, uiCopy.library.failed, "failed");

    const search = controls.createEl("input", {
      cls: "rxn-search-input",
      attr: { type: "search", placeholder: uiCopy.library.searchPlaceholder },
    });
    search.value = this.libraryQuery;
    search.addEventListener("input", () => {
      this.libraryQuery = search.value.trim().toLowerCase();
      void this.display();
    });

    this.createActionButton(controls, uiCopy.actions.refresh, async () => {
      await this.refreshLibraryData();
      await this.display();
    }, "rxn-btn-secondary");
    this.createActionButton(controls, uiCopy.actions.openLibraryFolder, async () => {
      this.openLibraryFolder();
    }, "rxn-btn-secondary");

    const items = this.getFilteredLibraryItems();
    if (items.length === 0) {
      library.createEl("p", { text: uiCopy.library.empty, cls: "rxn-muted" });
      return;
    }

    const list = library.createDiv({ cls: "rxn-session-workspace" });
    for (const item of items) {
      const isBusy = this.libraryBusySessionId === item.sessionId;
      const needsTranscript = item.artifactAvailability.hasAudio && !item.artifactAvailability.hasTranscript;
      const needsSummary = item.artifactAvailability.hasTranscript && !item.artifactAvailability.hasSummary;
      const card = list.createDiv({ cls: "rxn-session-workspace-card" });
      const header = card.createDiv({ cls: "rxn-session-header" });
      const titleBlock = header.createDiv({ cls: "rxn-session-title" });
      titleBlock.createEl("strong", { text: item.scenarioLabel });
      titleBlock.createEl("span", {
        text: item.failureSummary || item.diagnosticsSummary,
        cls: "rxn-muted",
      });
      header.createEl("span", {
        text: item.status,
        cls: `rxn-status-pill is-${item.healthBadge}`,
      });

      const meta = card.createDiv({ cls: "rxn-session-meta-row" });
      this.renderSessionMeta(meta, "Started", new Date(item.createdAt).toLocaleString());
      this.renderSessionMeta(meta, "Duration", formatDuration(item.elapsedSeconds));
      this.renderSessionMeta(meta, "Segments", String(item.committedSegments));
      this.renderSessionMeta(meta, "Audio", formatBytes(item.audioSizeBytes));
      this.renderSessionMeta(meta, "Last activity", new Date(item.lastActivityAt).toLocaleString());

      const artifactRow = card.createDiv({ cls: "rxn-pill-row" });
      artifactRow.createEl("span", {
        text: item.artifactAvailability.hasAudio ? "Audio ready" : "No audio",
        cls: `rxn-pill ${item.artifactAvailability.hasAudio ? "is-ok" : ""}`,
      });
      artifactRow.createEl("span", {
        text: item.artifactAvailability.hasTranscript ? "Transcript ready" : "No transcript",
        cls: `rxn-pill ${item.artifactAvailability.hasTranscript ? "is-ok" : ""}`,
      });
      artifactRow.createEl("span", {
        text: item.artifactAvailability.hasSummary ? "Summary ready" : "No summary",
        cls: `rxn-pill ${item.artifactAvailability.hasSummary ? "is-ok" : ""}`,
      });

      if (needsTranscript || needsSummary) {
        const recovery = card.createDiv({ cls: "rxn-session-recovery" });
        const recoveryCopy = recovery.createDiv({ cls: "rxn-session-recovery-copy" });
        recoveryCopy.createEl("strong", { text: "Recovery" });
        recoveryCopy.createEl("p", {
          text: needsTranscript
            ? "Transcript missing. Generate it from the saved audio."
            : "Summary missing. Generate it from the saved transcript.",
          cls: "rxn-muted",
        });
        const recoveryActions = recovery.createDiv({ cls: "rxn-actions rxn-session-action-row" });
        this.createActionButton(
          recoveryActions,
          isBusy && this.libraryBusyAction === "transcript" ? "Generating transcript..." : uiCopy.actions.regenerateTranscript,
          async () => {
            await this.runLibraryRecovery(item, "transcript");
          },
          "rxn-btn-secondary",
          isBusy || !needsTranscript
        );
        this.createActionButton(
          recoveryActions,
          isBusy && this.libraryBusyAction === "summary" ? "Generating summary..." : uiCopy.actions.regenerateSummary,
          async () => {
            await this.runLibraryRecovery(item, "summary");
          },
          "rxn-btn-secondary",
          isBusy || !needsSummary
        );
      }

      const menus = card.createDiv({ cls: "rxn-session-menu-row" });

      const openMenu = this.createSessionActionMenu(menus, "Open files");
      this.createActionButton(openMenu, uiCopy.actions.openSummary, async () => {
        await this.vaultAdapter.openFile(item.notes.summaryNotePath);
      }, "rxn-btn-secondary", isBusy || !item.notes.summaryNotePath);
      this.createActionButton(openMenu, uiCopy.actions.openTranscript, async () => {
        await this.vaultAdapter.openFile(item.notes.liveTranscriptNotePath);
      }, "rxn-btn-secondary", isBusy || !item.notes.liveTranscriptNotePath);
      this.createActionButton(openMenu,
        this.openAudioSessionId === item.sessionId ? uiCopy.actions.hideAudio : uiCopy.actions.playAudio,
        async () => {
          this.openAudioSessionId = this.openAudioSessionId === item.sessionId ? null : item.sessionId;
          await this.display();
        },
        "rxn-btn-secondary",
        isBusy || !item.artifactAvailability.hasAudio
      );

      const toolsMenu = this.createSessionActionMenu(menus, "Inspect");
      this.createActionButton(toolsMenu, uiCopy.actions.previewTranscript, async () => {
        new TextPreviewModal(this.app, "Raw transcript", this.store.readTextFile(item.paths.transcriptTextPath)).open();
      }, "rxn-btn-secondary", isBusy || !item.artifactAvailability.hasTranscript);
      this.createActionButton(toolsMenu, uiCopy.actions.previewDiagnostics, async () => {
        new TextPreviewModal(this.app, "Diagnostics log", this.store.readTextFile(item.paths.diagnosticsLogPath)).open();
      }, "rxn-btn-secondary", isBusy);
      this.createActionButton(toolsMenu, uiCopy.actions.exportAudio, async () => {
        this.exportAudio(item);
      }, "rxn-btn-secondary", isBusy || !item.artifactAvailability.hasAudio);
      this.createActionButton(toolsMenu, uiCopy.actions.showFolder, async () => {
        try {
          const electron = requireNodeModule<{ shell?: { showItemInFolder?: (path: string) => void } }>("electron");
          electron.shell?.showItemInFolder?.(item.paths.rootDir);
        } catch { }
      }, "rxn-btn-secondary", isBusy);

      const dangerMenu = this.createSessionActionMenu(menus, "Delete", true);
      this.createActionButton(dangerMenu, "Delete audio", async () => {
        const ok = confirm("Delete saved audio for this session and keep the transcript/summary?");
        if (!ok) return;
        this.openAudioSessionId = this.openAudioSessionId === item.sessionId ? null : this.openAudioSessionId;
        const manifest = await this.store.readSessionByRootDir(item.paths.rootDir);
        if (!manifest) return;
        await this.store.deleteAudioArtifacts(manifest);
        await this.store.appendDiagnostics(manifest, "Manual cleanup: audio artifacts deleted.");
        await this.store.writeManifest(manifest);
        new Notice("Audio deleted.");
        await this.refreshLibraryData();
        await this.display();
      }, "rxn-btn-danger", isBusy || !item.artifactAvailability.hasAudio);
      this.createActionButton(dangerMenu, "Delete transcript", async () => {
        const ok = confirm("Delete saved transcript for this session and keep the summary if it exists?");
        if (!ok) return;
        const manifest = await this.store.readSessionByRootDir(item.paths.rootDir);
        if (!manifest) return;
        await this.vaultAdapter.deleteFile(manifest.notes.liveTranscriptNotePath);
        manifest.notes.liveTranscriptNotePath = undefined;
        await this.store.deleteTranscriptArtifacts(manifest);
        await this.store.appendDiagnostics(manifest, "Manual cleanup: transcript artifacts deleted.");
        await this.store.writeManifest(manifest);
        new Notice("Transcript deleted.");
        await this.refreshLibraryData();
        await this.display();
      }, "rxn-btn-danger", isBusy || !item.artifactAvailability.hasTranscript);
      this.createActionButton(dangerMenu, uiCopy.actions.deleteSession, async () => {
        const ok = confirm(uiCopy.library.deleteConfirmation);
        if (!ok) return;
        await this.vaultAdapter.deleteFile(item.notes.summaryNotePath);
        await this.vaultAdapter.deleteFile(item.notes.liveTranscriptNotePath);
        await this.store.deleteSessionRootDir(item.paths.rootDir);
        new Notice(uiCopy.notices.sessionDeleted);
        await this.refreshLibraryData();
        await this.display();
      }, "rxn-btn-danger", isBusy);

      if (this.openAudioSessionId === item.sessionId && item.artifactAvailability.hasAudio) {
        const audio = card.createEl("audio", { attr: { controls: "true" } });
        audio.src = this.getAudioUrl(item.paths.fullAudioPath);
      }
    }
  }

  private renderSessionMeta(container: HTMLElement, label: string, value: string) {
    const item = container.createDiv({ cls: "rxn-session-meta-item" });
    item.createEl("span", { text: `${label}:`, cls: "rxn-session-meta-label" });
    item.createEl("span", { text: value, cls: "rxn-session-meta-value" });
  }

  private createSessionActionMenu(container: HTMLElement, label: string, isDanger = false): HTMLElement {
    const details = container.createEl("details", {
      cls: `rxn-session-menu${isDanger ? " is-danger" : ""}`,
    });
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      const allMenus = this.containerEl.querySelectorAll<HTMLDetailsElement>(".rxn-session-menu");
      allMenus.forEach((menu) => {
        if (menu !== details) {
          menu.open = false;
        }
      });
    });
    const summary = details.createEl("summary", {
      text: label,
      cls: isDanger ? "rxn-btn-danger rxn-session-menu-trigger" : "rxn-btn-secondary rxn-session-menu-trigger",
    });
    summary.setAttribute("role", "button");
    const list = details.createDiv({ cls: "rxn-session-menu-list" });
    list.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("button")) {
        details.open = false;
      }
    });
    return list;
  }

  private openLibraryFolder() {
    try {
      const electron = requireNodeModule<{ shell?: { showItemInFolder?: (path: string) => void } }>("electron");
      const sessionsRoot = this.store.getSessionsRootDir();
      electron.shell?.showItemInFolder?.(sessionsRoot);
    } catch {}
  }

  private createGuideSection(container: HTMLElement, options: GuideSectionOptions): HTMLElement {
    const section = container.createEl("div", { cls: "rxn-card rxn-step-section" });
    const header = section.createEl("div", { cls: "rxn-step-section-header" });
    header.createEl("span", { text: options.badge, cls: "rxn-step-section-badge" });
    header.createEl("h3", { text: options.title });
    section.createEl("p", { text: options.intro, cls: "rxn-muted" });
    if (options.platformGuides) {
      this.renderPlatformGuide(section, options.platformGuides, Boolean(options.intro.trim()));
    }
    if (options.bullets?.length) {
      const list = section.createEl("ul", { cls: "rxn-guide-list" });
      for (const bullet of options.bullets) {
        list.createEl("li", { text: bullet });
      }
    }
    if (options.code) {
      this.renderCodeBlock(section, options.code);
    }
    return section;
  }

  private async runLibraryRecovery(item: SessionListItem, action: "transcript" | "summary") {
    this.libraryBusySessionId = item.sessionId;
    this.libraryBusyAction = action;
    await this.display();
    try {
      if (action === "transcript") {
        await this.options.controller.regenerateTranscript(item.paths.rootDir);
        new Notice("Transcript generated.");
      } else {
        await this.options.controller.regenerateSummary(item.paths.rootDir);
        new Notice("Summary generated.");
      }
      await this.refreshLibraryData();
    } catch (error) {
      new Notice(String((error as Error)?.message ?? error));
    } finally {
      this.libraryBusySessionId = null;
      this.libraryBusyAction = null;
      await this.display();
    }
  }

  private renderPlatformGuide(
    section: HTMLElement,
    platformGuides: Partial<Record<GuidePlatform, PlatformGuide>>,
    hasIntro: boolean
  ) {
    const entries = GUIDE_PLATFORM_ORDER.flatMap((platform) => {
      const guide = platformGuides[platform];
      return guide ? [{ platform, guide }] : [];
    });
    if (entries.length === 0) {
      return;
    }

    const wrapper = section.createDiv({ cls: "rxn-guide-platform" });
    const tabs = wrapper.createDiv({ cls: "rxn-guide-platform-tabs" });
    const panel = wrapper.createDiv({ cls: "rxn-guide-platform-panel" });
    const buttons = new Map<GuidePlatform, HTMLButtonElement>();

    const renderPanel = (platform: GuidePlatform) => {
      panel.empty();
      for (const [key, button] of buttons) {
        button.toggleClass("is-selected", key === platform);
      }

      const guide = platformGuides[platform];
      if (!guide) {
        return;
      }

      if (guide.text && !hasIntro) {
        panel.createEl("p", { text: guide.text, cls: "rxn-muted rxn-guide-platform-copy" });
      }
      if (guide.bullets?.length) {
        const list = panel.createEl("ul", { cls: "rxn-guide-list" });
        for (const bullet of guide.bullets) {
          list.createEl("li", { text: bullet });
        }
      }
      if (guide.codeBlocks?.length) {
        for (const block of guide.codeBlocks) {
          this.renderCodeBlock(panel, block.code, block.label);
        }
      }
      if (guide.code) {
        this.renderCodeBlock(panel, guide.code);
      }
    };

    for (const { platform } of entries) {
      const button = tabs.createEl("button", {
        text: GUIDE_PLATFORM_LABELS[platform],
        cls: "rxn-guide-platform-tab",
      });
      buttons.set(platform, button);
      button.addEventListener("click", () => {
        renderPanel(platform);
      });
    }

    renderPanel(this.getDefaultGuidePlatform(entries.map((entry) => entry.platform)));
  }

  private renderCodeBlock(container: HTMLElement, code: string, label?: string) {
    const block = container.createDiv({ cls: "rxn-guide-code-block" });
    if (label) {
      block.createEl("div", { text: label, cls: "rxn-guide-code-label" });
    }
    const shell = block.createDiv({ cls: "rxn-guide-code-shell" });
    const copyButton = shell.createEl("button", {
      text: "Copy",
      cls: "rxn-guide-code-copy rxn-btn-secondary",
      attr: { type: "button" },
    });
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code);
        new Notice("Command copied.");
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = code;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
        new Notice("Command copied.");
      }
    });

    const pre = shell.createEl("pre", { cls: "rxn-guide-code" });
    pre.setText(code);
  }

  private getWhisperModelLabel(preset: PluginSettingsV2["transcription"]["modelPreset"]): string {
    return preset.charAt(0).toUpperCase() + preset.slice(1);
  }

  private getWhisperModelFilename(preset: PluginSettingsV2["transcription"]["modelPreset"]): string {
    return `ggml-${preset}.bin`;
  }

  private getDefaultGuidePlatform(platforms: GuidePlatform[]): GuidePlatform {
    let preferred: GuidePlatform = "macos";

    try {
      const processModule = requireNodeModule<{ platform?: string }>("process");
      if (processModule.platform === "win32") {
        preferred = "windows";
      } else if (processModule.platform === "linux") {
        preferred = "linux";
      }
    } catch {
      const agent = typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase();
      preferred = agent.includes("windows") ? "windows" : agent.includes("linux") ? "linux" : "macos";
    }

    return platforms.includes(preferred) ? preferred : platforms[0] ?? "macos";
  }

  private getFilteredLibraryItems(): SessionListItem[] {
    return this.libraryItems.filter((item) => {
      const statusMatches = this.libraryFilter === "all" ? true : item.status === this.libraryFilter;
      if (!statusMatches) return false;
      if (!this.libraryQuery) return true;
      const haystack = [item.scenarioLabel, item.status, item.failureSummary, item.diagnosticsSummary]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(this.libraryQuery);
    });
  }

  private renderLibraryFilterChip(container: HTMLElement, label: string, value: LibraryFilter) {
    const chip = container.createEl("button", { text: label, cls: "rxn-filter-chip" });
    if (this.libraryFilter === value) {
      chip.addClass("is-selected");
    }
    chip.addEventListener("click", () => {
      this.libraryFilter = value;
      void this.display();
    });
  }

  private renderDiagnosticChecks(
    container: HTMLElement,
    checks: DashboardSnapshot["health"]["groups"]["blocking"],
    toneClass: "is-failed" | "is-warning"
  ) {
    for (const check of checks) {
      const item = container.createDiv({ cls: `rxn-check-card ${toneClass}` });
      item.createEl("strong", { text: check.label });
      item.createEl("p", { text: check.detail, cls: "rxn-muted" });
      if (check.remediation) {
        item.createEl("small", { text: check.remediation, cls: "rxn-muted" });
      }
    }
  }

  private async runQuickTest() {
    if (this.isQuickTestRunning) return;

    this.isQuickTestRunning = true;
    this.smokeMessage = "Quick test running...";
    await this.display();

    try {
      new Notice("Quick test started...");
      const result = await this.options.controller.runSmokeTest();
      this.smokeMessage = result.ok ? uiCopy.diagnostics.smokePassed : `${uiCopy.notices.quickTestFailedPrefix}: ${result.detail}`;
      new Notice(this.smokeMessage);
      await this.refreshControlRoomData(false);
    } finally {
      this.isQuickTestRunning = false;
      await this.display();
    }
  }

  private getAudioUrl(path: string): string {
    const cached = this.audioUrlCache.get(path);
    if (cached) return cached;
    const fs = requireNodeModule<{ readFileSync: (path: string) => Buffer }>("fs");
    const buffer = fs.readFileSync(path);
    const bytes = Uint8Array.from(buffer);
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    this.audioUrlCache.set(path, url);
    return url;
  }

  private exportAudio(item: SessionListItem) {
    const fs = requireNodeModule<{ readFileSync: (path: string) => Buffer }>("fs");
    const bytes = Uint8Array.from(fs.readFileSync(item.paths.fullAudioPath));
    const blob = new Blob([bytes], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${item.scenarioLabel}-${item.sessionId}.mp3`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  private createActionButton(
    container: HTMLElement,
    label: string,
    onClick: () => Promise<void> | void,
    cls: string,
    disabled = false
  ) {
    const button = container.createEl("button", { text: label });
    button.addClass(cls);
    button.disabled = disabled;
    button.addEventListener("click", () => {
      void onClick();
    });
    return button;
  }

  private resetDeviceSelects(micSelect: HTMLSelectElement, systemSelect: HTMLSelectElement, placeholder: string) {
    micSelect.empty();
    const micPlaceholder = document.createElement("option");
    micPlaceholder.value = "";
    micPlaceholder.text = placeholder;
    micSelect.appendChild(micPlaceholder);

    systemSelect.empty();
    const none = document.createElement("option");
    none.value = "";
    none.text = "(none)";
    systemSelect.appendChild(none);
  }

  private async populateDevices(micSelect: HTMLSelectElement, systemSelect: HTMLSelectElement, notifyOnFailure = false) {
    const settings = this.options.getSettings();
    this.resetDeviceSelects(
      micSelect,
      systemSelect,
      settings.capture.ffmpegPath.trim() ? "Refresh devices to load microphones" : "Set FFmpeg path first"
    );
    if (!settings.capture.ffmpegPath.trim()) return;

    try {
      const scanned = await scanDevices(settings.capture.ffmpegPath, resolveCaptureBackend(settings.capture.backend));
      const audioDevices = scanned.filter((device) => device.type === "audio");
      if (audioDevices.length === 0) {
        return;
      }

      micSelect.empty();
      for (const device of audioDevices) {
        const option = document.createElement("option");
        option.value = device.name;
        option.text = device.label;
        micSelect.appendChild(option);

        const sysOption = document.createElement("option");
        sysOption.value = device.name;
        sysOption.text = device.label;
        systemSelect.appendChild(sysOption);
      }

      if (
        settings.capture.microphoneDevice &&
        Array.from(micSelect.options).some((option) => option.value === settings.capture.microphoneDevice)
      ) {
        micSelect.value = settings.capture.microphoneDevice;
      } else if (micSelect.options.length > 0) {
        micSelect.selectedIndex = 0;
      }

      if (
        settings.capture.systemDevice &&
        Array.from(systemSelect.options).some((option) => option.value === settings.capture.systemDevice)
      ) {
        systemSelect.value = settings.capture.systemDevice;
      }
    } catch (error) {
      if (notifyOnFailure) {
        new Notice(`Device scan failed: ${String((error as Error)?.message ?? error)}`);
      }
    }
  }
}
