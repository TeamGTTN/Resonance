import { App, Modal, Notice, Plugin } from "obsidian";
import { ResonanceSettings, DEFAULT_SETTINGS, ResonanceSettingTab } from "./settings";
import { checkDependencies } from "./DependencyChecker";
// @ts-expect-error: risoluzione modulo a runtime via bundler
import { RecorderService, type RecorderPhase } from "./RecorderService";

declare global {
  interface Window {
    resonanceAutoDetectFfmpeg?: () => Promise<string | null>;
    resonanceAutoDetectWhisper?: () => Promise<string | null>;
    resonanceQuickTest?: () => Promise<boolean>;
  }
}

export default class ResonancePlugin extends Plugin {
  settings!: ResonanceSettings;
  private recorder!: RecorderService;
  private ribbonIconEl!: HTMLElement;
  private statusBarEl!: HTMLElement;
  private statusTimerId: number | null = null;

  async onload() {
    await this.loadSettings();

    this.recorder = new RecorderService(this.app, this.settings, this.manifest.id, async (partial: Partial<ResonanceSettings>) => {
      await this.saveSettings(partial);
    });

    const ribbonIconEl = this.addRibbonIcon("mic", "Resonance: Registratore Riunione", async () => {
      await this.toggleFromRibbon();
    });
    this.ribbonIconEl = ribbonIconEl;
    ribbonIconEl.addClass("resonance-ribbon");

    // Status bar per timer/stati
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("resonance-statusbar");
    this.statusBarEl.setText("");
    (this.statusBarEl as any).hide?.();

    this.addCommand({
      id: "resonance-open-recorder",
      name: "Avvia/ferma registrazione (Resonance)",
      callback: async () => {
        await this.toggleFromRibbon();
      },
    });

    this.addSettingTab(new ResonanceSettingTab(this.app, this.settings, async (partial) => {
      await this.saveSettings(partial);
    }));

    // Collegamento eventi servizio → UI
    this.recorder.onPhaseChange = (phase: RecorderPhase) => {
      this.updateRibbonState(phase);
      this.updateStatusBarState(phase);
    };
    this.recorder.onElapsed = (sec: number) => {
      this.updateStatusBarTimer(sec);
    };
    this.recorder.onError = (message: string) => {
      new Notice(`Errore Resonance: ${message}`);
    };
    this.recorder.onInfo = (message: string) => {
      new Notice(message);
    };
  }

  async onunload() {}

  private async ensureDepsOk(): Promise<boolean> {
    const deps = await checkDependencies({
      apiKey: this.settings.geminiApiKey,
      ffmpegPath: this.settings.ffmpegPath,
      whisperMainPath: this.settings.whisperMainPath,
      whisperModelPath: this.settings.whisperModelPath,
    });

    if (!deps.hasApiKey || !deps.ffmpegOk || !deps.whisperOk || !deps.modelOk) {
      new Notice("Configurazione incompleta. Vai a Impostazioni → Resonance per completare i campi richiesti.");
      return false;
    }
    return true;
  }

  private async toggleFromRibbon() {
    if (!(await this.ensureDepsOk())) return;

    const phase = this.recorder.getPhase();
    if (phase === "idle" || phase === "error" || phase === "done") {
      const ok = await this.confirmStart();
      if (!ok) return;
      await this.recorder.start();
    } else if (phase === "recording") {
      await this.recorder.stop();
    } else {
      new Notice("Elaborazione in corso… attendi il completamento.");
    }
  }

  private updateRibbonState(phase: RecorderPhase) {
    if (!this.ribbonIconEl) return;
    this.ribbonIconEl.removeClass("recording");
    this.ribbonIconEl.removeClass("processing");
    if (phase === "recording") this.ribbonIconEl.addClass("recording");
    if (phase === "transcribing" || phase === "summarizing") this.ribbonIconEl.addClass("processing");
  }

  private updateStatusBarState(phase: RecorderPhase) {
    const el = this.statusBarEl;
    if (!el) return;
    if (phase === "recording") {
      (el as any).show?.();
      el.setText("Rec 00:00");
    } else if (phase === "transcribing") {
      (el as any).show?.();
      el.setText("Trascrizione…");
    } else if (phase === "summarizing") {
      (el as any).show?.();
      el.setText("Riassunto…");
    } else {
      el.setText("");
      (el as any).hide?.();
    }
  }

  private updateStatusBarTimer(sec: number) {
    if (!this.statusBarEl) return;
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    this.statusBarEl.setText(`Rec ${mm}:${ss}`);
  }

  private confirmStart(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const modal = new (class extends Modal {
        constructor(app: App, private onResult: (ok: boolean) => void) { super(app); }
        onOpen(): void {
          const { contentEl } = this;
          contentEl.empty();
          contentEl.addClass("resonance-modal");
          contentEl.createEl("h2", { text: "Avvia registrazione?" });
          contentEl.createEl("p", { text: "Vuoi avviare una registrazione con Resonance?" });
          const controls = contentEl.createEl("div", { cls: "resonance-controls" });
          const okBtn = controls.createEl("button", { cls: "resonance-btn primary", text: "Avvia" });
          okBtn.addEventListener("click", () => { this.onResult(true); this.close(); });
          const cancelBtn = controls.createEl("button", { cls: "resonance-btn secondary", text: "Annulla" });
          cancelBtn.addEventListener("click", () => { this.onResult(false); this.close(); });
        }
        onClose(): void { this.onResult(false); }
      })(this.app, (ok) => resolve(ok));
      modal.open();
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(partial: Partial<ResonanceSettings>) {
    this.settings = { ...this.settings, ...partial };
    await this.saveData(this.settings);
  }
}
