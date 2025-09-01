import { App, Modal, Notice, Plugin } from "obsidian";
import { ResonanceSettings, DEFAULT_SETTINGS, ResonanceSettingTab } from "./settings";
import { checkDependencies } from "./DependencyChecker";
import { RecorderService, type RecorderPhase } from "./RecorderService";
import { PROMPT_PRESETS, DEFAULT_PROMPT_KEY, getPresetKeys } from "./prompts";
import { autoDetectFfmpeg, autoDetectWhisperFromRepo } from "./AutoDetect";

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

    // Library icon first (so it appears above the microphone icon)
    const libRibbon = this.addRibbonIcon("audio-file", "Resonance - Library", async () => {
      const { LibraryModal } = await import('./LibraryModal');
      new LibraryModal(this.app, this.manifest.id).open();
    });
    libRibbon.addClass("resonance-ribbon");
    // Sposta in fondo (con flex column-reverse = primo figlio)
    this.moveRibbonToBottom(libRibbon);
    // Ripeti a layout pronto (altri plugin possono aggiungere icone dopo)
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.moveRibbonToBottom(libRibbon), 0);
      window.setTimeout(() => this.moveRibbonToBottom(libRibbon), 500);
    });

    // Microphone icon below library icon
    const ribbonIconEl = this.addRibbonIcon("mic", "Resonance - Meeting recorder", async () => {
      await this.toggleFromRibbonWithPreset();
    });
    this.ribbonIconEl = ribbonIconEl;
    ribbonIconEl.addClass("resonance-ribbon");
    // Sposta in fondo (con flex column-reverse = primo figlio)
    this.moveRibbonToBottom(ribbonIconEl);
    // Ripeti a layout pronto (altri plugin possono aggiungere icone dopo)
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.moveRibbonToBottom(ribbonIconEl), 0);
      window.setTimeout(() => this.moveRibbonToBottom(ribbonIconEl), 500);
    });

    // Status bar for timer/status
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("resonance-statusbar");
    this.statusBarEl.setText("");
    (this.statusBarEl as any).hide?.();

    this.addCommand({
      id: "resonance-open-recorder",
      name: "Start/stop recording (Resonance)",
      callback: async () => {
        await this.toggleFromRibbonWithPreset();
      },
    });

    this.addCommand({
      id: "resonance-open-library",
      name: "Open Library",
      callback: async () => {
        const { LibraryModal } = await import('./LibraryModal');
        new LibraryModal(this.app, this.manifest.id).open();
      },
    });

    this.addSettingTab(new ResonanceSettingTab(this.app, this.settings, async (partial) => {
      await this.saveSettings(partial);
    }));

    // Wire up service events → UI
    this.recorder.onPhaseChange = (phase: RecorderPhase) => {
      this.updateRibbonState(phase);
      this.updateStatusBarState(phase);
    };
    this.recorder.onElapsed = (sec: number) => {
      this.updateStatusBarTimer(sec);
    };
    this.recorder.onError = (message: string) => {
      new Notice(`Resonance error: ${message}`);
    };
    this.recorder.onInfo = (message: string) => {
      new Notice(message);
    };

    // Expose global helpers for the Setup Wizard
    window.resonanceAutoDetectFfmpeg = async () => {
      try { return await autoDetectFfmpeg(); } catch { return null; }
    };
    window.resonanceAutoDetectWhisper = async () => {
      try { return await autoDetectWhisperFromRepo(this.settings.whisperRepoPath); } catch { return null; }
    };
    window.resonanceQuickTest = async () => {
      try {
        const ffmpeg = (this.settings.ffmpegPath || '').trim();
        if (!ffmpeg) return false;
        const backend = (() => {
          const fmt = (this.settings.ffmpegInputFormat || 'auto');
          if (fmt !== 'auto') return fmt;
          if (process.platform === 'win32') return 'dshow';
          if (process.platform === 'darwin') return 'avfoundation';
          return 'pulse';
        })();
        const mic = (() => {
          const v = (this.settings.ffmpegMicDevice || '').trim();
          if (v) return v;
          if (backend === 'avfoundation') return ':0';
          if (backend === 'dshow') return 'audio=Microphone (default)';
          return 'default';
        })();

        const { spawn } = (window as any).require('child_process');
        const os = (window as any).require('os');
        const path = (window as any).require('path');
        const fs = (window as any).require('fs');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonance-qt-'));
        const out = path.join(tmpDir, 'test.mp3');
        const normalize = (b: string, v: string) => b === 'dshow' && !/^(audio=|video=|@device_)/i.test(v) ? `audio=${v}` : v;
        const micArg = normalize(backend, mic);
        const args: string[] = ['-y', '-f', backend, '-i', micArg, '-t', '3', '-acodec', 'libmp3lame', '-ab', '128k', out];
        const code: number = await new Promise((resolve) => {
          const child = spawn(ffmpeg, args);
          child.on('error', () => resolve(1));
          child.on('close', (c: number) => resolve(c ?? 1));
        });
        try { fs.unlinkSync(out); fs.rmdirSync(tmpDir); } catch {}
        return code === 0;
      } catch { return false; }
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
      new Notice("Incomplete configuration. Go to Settings → Resonance to fill in the required fields.");
      return false;
    }
    return true;
  }

  private async toggleFromRibbonWithPreset() {
    if (!(await this.ensureDepsOk())) return;

    const phase = this.recorder.getPhase();
    if (phase === "idle" || phase === "error" || phase === "done") {
      const presetKey = await this.selectPreset(this.settings.lastPromptKey || DEFAULT_PROMPT_KEY);
      if (!presetKey) return;
      await this.recorder.startWithPreset(presetKey);
      await this.saveSettings({ lastPromptKey: presetKey });
    } else if (phase === "recording") {
      await this.recorder.stop();
    } else {
      new Notice("Processing… please wait.");
    }
  }

  private updateRibbonState(phase: RecorderPhase) {
    if (!this.ribbonIconEl) return;
    this.ribbonIconEl.removeClass("recording");
    this.ribbonIconEl.removeClass("processing");
    if (phase === "recording") this.ribbonIconEl.addClass("recording");
    if (phase === "transcribing" || phase === "summarizing") this.ribbonIconEl.addClass("processing");
  }

  private moveRibbonToBottom(el: HTMLElement) {
    const parent = el?.parentElement;
    if (!parent) return;
    const first = parent.firstElementChild;
    if (first !== el) parent.insertBefore(el, first);
  }

  private updateStatusBarState(phase: RecorderPhase) {
    const el = this.statusBarEl;
    if (!el) return;
    if (phase === "recording") {
      (el as any).show?.();
      el.setText("Rec 00:00");
    } else if (phase === "transcribing") {
      (el as any).show?.();
      el.setText("Transcribing…");
    } else if (phase === "summarizing") {
      (el as any).show?.();
      el.setText("Summarizing…");
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



  private selectPreset(defaultKey: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const modal = new (class extends Modal {
        private value: string = defaultKey;
        constructor(app: App, private onResult: (key: string | null) => void) { super(app); }
        onOpen(): void {
          const { contentEl } = this;
          contentEl.empty();
          contentEl.addClass("resonance-modal");
          contentEl.createEl("h2", { text: "Select a Scenario" });
          contentEl.createEl("p", { text: "Choose the type of summary you want to generate." });
          const select = contentEl.createEl("select");
          select.addClass("resonance-inline-select");
          const keys = getPresetKeys();
          keys.forEach((k) => {
            const opt = document.createElement("option");
            opt.value = k; opt.text = PROMPT_PRESETS[k].label; select.appendChild(opt);
          });
          select.value = defaultKey;
          select.addEventListener("change", () => { this.value = select.value; });
          const controls = contentEl.createEl("div", { cls: "resonance-controls" });
          const okBtn = controls.createEl("button", { cls: "resonance-btn primary", text: "Start" });
          okBtn.addEventListener("click", () => { this.onResult(this.value); this.close(); });
          const cancelBtn = controls.createEl("button", { cls: "resonance-btn secondary", text: "Cancel" });
          cancelBtn.addEventListener("click", () => { this.onResult(null); this.close(); });
        }
        onClose(): void { /* keep last selection on close */ }
      })(this.app, (key) => resolve(key));
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
