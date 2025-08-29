import { App, Notice, Plugin } from "obsidian";
import { ResonanceSettings, DEFAULT_SETTINGS, ResonanceSettingTab } from "./settings";
import { checkDependencies } from "./DependencyChecker";
import { RecordingModal } from "./RecordingModal";

declare global {
  interface Window {
    resonanceAutoDetectFfmpeg?: () => Promise<string | null>;
    resonanceAutoDetectWhisper?: () => Promise<string | null>;
    resonanceQuickTest?: () => Promise<boolean>;
  }
}

export default class ResonancePlugin extends Plugin {
  settings!: ResonanceSettings;

  async onload() {
    await this.loadSettings();

    const ribbonIconEl = this.addRibbonIcon("mic", "Resonance: Registratore Riunione", async () => {
      await this.startFlow();
    });
    ribbonIconEl.addClass("resonance-ribbon");

    this.addCommand({
      id: "resonance-open-recorder",
      name: "Avvia registrazione riunione (Resonance)",
      callback: async () => {
        await this.startFlow();
      },
    });

    this.addSettingTab(new ResonanceSettingTab(this.app, this.settings, async (partial) => {
      await this.saveSettings(partial);
    }));
  }

  async onunload() {}

  private async startFlow() {
    const deps = await checkDependencies({
      apiKey: this.settings.geminiApiKey,
      ffmpegPath: this.settings.ffmpegPath,
      whisperMainPath: this.settings.whisperMainPath,
      whisperModelPath: this.settings.whisperModelPath,
    });

    if (!deps.hasApiKey || !deps.ffmpegOk || !deps.whisperOk || !deps.modelOk) {
      new Notice("Configurazione incompleta. Vai a Impostazioni → Resonance per completare i campi richiesti.");
      return;
    }

    new RecordingModal(this.app, this.settings).open();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(partial: Partial<ResonanceSettings>) {
    this.settings = { ...this.settings, ...partial };
    await this.saveData(this.settings);
  }
}
