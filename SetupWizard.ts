import { App, Modal, Notice } from "obsidian";
import { ResonanceSettings } from "./settings";
import { scanDevices, ListedDevice } from "./DeviceScanner";

export class SetupWizard extends Modal {
  private settings: ResonanceSettings;
  private save: (partial: Partial<ResonanceSettings>) => Promise<void>;
  private step = 0;
  private steps = ["API", "FFmpeg", "Dispositivi", "Whisper", "Test", "Fine"];
  private content!: HTMLElement;
  private scanResults: ListedDevice[] = [];

  constructor(app: App, settings: ResonanceSettings, save: (partial: Partial<ResonanceSettings>) => Promise<void>) {
    super(app);
    this.settings = settings;
    this.save = save;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("resonance-modal");

    const title = contentEl.createEl("h2", { text: "Benvenuto in Resonance – Configurazione Guidata" });
    const indicator = contentEl.createEl("div", { cls: "resonance-steps" });
    this.steps.forEach((s, i) => {
      const dot = indicator.createEl("span", { text: s });
      if (i === this.step) dot.addClass("active");
    });

    this.content = contentEl.createEl("div", { cls: "resonance-wizard-content" });

    const controls = contentEl.createEl("div", { cls: "resonance-controls" });
    const back = controls.createEl("button", { cls: "resonance-btn secondary", text: "Indietro" });
    const next = controls.createEl("button", { cls: "resonance-btn primary", text: "Avanti" });

    back.addEventListener("click", () => this.prev());
    next.addEventListener("click", () => this.next());

    this.renderStep();
  }

  private refreshIndicator() {
    const el = this.contentEl.querySelector(".resonance-steps");
    if (!el) return;
    el.empty();
    this.steps.forEach((s, i) => {
      const dot = el.createEl("span", { text: s });
      if (i === this.step) dot.addClass("active");
    });
  }

  private async next() {
    if (!(await this.validateAndSaveStep())) return;
    this.step = Math.min(this.step + 1, this.steps.length - 1);
    this.refreshIndicator();
    this.renderStep();
  }

  private prev() {
    this.step = Math.max(this.step - 1, 0);
    this.refreshIndicator();
    this.renderStep();
  }

  private renderStep() {
    this.content.empty();
    switch (this.step) {
      case 0: this.renderApiStep(); break;
      case 1: this.renderFfmpegStep(); break;
      case 2: this.renderDevicesStep(); break;
      case 3: this.renderWhisperStep(); break;
      case 4: this.renderTestStep(); break;
      case 5: this.renderFinishStep(); break;
    }
  }

  private renderApiStep() {
    this.content.createEl("h3", { text: "1) Chiave API Gemini" });
    const input = this.content.createEl("input", { type: "password" });
    input.placeholder = "gai-...";
    input.value = this.settings.geminiApiKey || "";
    input.addEventListener('input', () => (input.dataset.changed = '1'));
    this.content.createEl("p", { text: "La chiave resta locale in Obsidian. Modello selezionabile nelle impostazioni." });
  }

  private renderFfmpegStep() {
    this.content.createEl("h3", { text: "2) FFmpeg" });
    const p = this.content.createEl("p", { text: "Specifica o rileva automaticamente il percorso a FFmpeg." });
    const input = this.content.createEl("input");
    input.placeholder = process.platform === 'win32' ? 'C:/ffmpeg/bin/ffmpeg.exe' : '/opt/homebrew/bin/ffmpeg';
    input.value = this.settings.ffmpegPath || '';
    const detect = this.content.createEl("button", { cls: "resonance-btn secondary", text: "Rileva" });
    detect.addEventListener('click', async () => {
      const guess = await (window as any).resonanceAutoDetectFfmpeg?.();
      if (guess) input.value = guess;
      else new Notice('Nessun FFmpeg rilevato');
    });
  }

  private renderDevicesStep() {
    this.content.createEl("h3", { text: "3) Dispositivi Audio" });
    const scanBtn = this.content.createEl("button", { cls: "resonance-btn secondary", text: "Scansiona dispositivi" });
    const micSel = this.content.createEl("select");
    const sysSel = this.content.createEl("select");
    const none = document.createElement('option'); none.value = ''; none.text = '(nessuno)'; sysSel.appendChild(none);

    scanBtn.addEventListener('click', async () => {
      try {
        const backend = this.resolveBackend();
        this.scanResults = await scanDevices(this.settings.ffmpegPath, backend);
        micSel.empty(); sysSel.length = 1; // keep none
        this.scanResults.filter(d => d.type !== 'video').forEach(d => {
          const o1 = document.createElement('option'); o1.value = d.name; o1.text = d.label; micSel.appendChild(o1);
          const o2 = document.createElement('option'); o2.value = d.name; o2.text = d.label; sysSel.appendChild(o2);
        });
      } catch (e: any) {
        new Notice(`Errore scansione: ${e?.message ?? e}`);
      }
    });

    micSel.value = this.settings.ffmpegMicDevice || '';
    sysSel.value = this.settings.ffmpegSystemDevice || '';

    micSel.addEventListener('change', async () => await this.save({ ffmpegMicDevice: micSel.value }));
    sysSel.addEventListener('change', async () => await this.save({ ffmpegSystemDevice: sysSel.value }));
  }

  private renderWhisperStep() {
    this.content.createEl("h3", { text: "4) whisper.cpp" });
    const mainInput = this.content.createEl("input");
    mainInput.placeholder = process.platform === 'win32' ? 'C:/whisper/main.exe' : '/usr/local/bin/main';
    mainInput.value = this.settings.whisperMainPath || '';
    const detect = this.content.createEl("button", { cls: "resonance-btn secondary", text: "Rileva" });
    detect.addEventListener('click', async () => {
      const guess = await (window as any).resonanceAutoDetectWhisper?.();
      if (guess) mainInput.value = guess; else new Notice('Nessun whisper main rilevato');
    });

    const modelInput = this.content.createEl("input");
    modelInput.placeholder = process.platform === 'win32' ? 'C:/modelli/ggml-base.en.bin' : '/path/ggml-base.en.bin';
    modelInput.value = this.settings.whisperModelPath || '';
  }

  private renderTestStep() {
    this.content.createEl("h3", { text: "5) Test rapido" });
    const p = this.content.createEl("p", { text: "Esegue una registrazione di 3s col microfono selezionato per verificare FFmpeg." });
    const btn = this.content.createEl("button", { cls: "resonance-btn primary", text: "Esegui Test 3s" });
    btn.addEventListener('click', async () => {
      const ok = await (window as any).resonanceQuickTest?.();
      if (ok) new Notice('Test completato'); else new Notice('Test fallito');
    });
  }

  private renderFinishStep() {
    this.content.createEl("h3", { text: "6) Fatto" });
    this.content.createEl("p", { text: "Configurazione di base completata. Puoi modificare opzioni avanzate in Impostazioni → Resonance." });
    const close = this.content.createEl("button", { cls: "resonance-btn primary", text: "Chiudi" });
    close.addEventListener('click', async () => {
      await this.save({ simpleMode: true });
      this.close();
    });
  }

  private async validateAndSaveStep(): Promise<boolean> {
    if (this.step === 0) {
      const val = (this.content.querySelector('input') as HTMLInputElement)?.value?.trim() || '';
      await this.save({ geminiApiKey: val });
      if (!val) { new Notice('Inserisci la API Key'); return false; }
    }
    if (this.step === 1) {
      const val = (this.content.querySelector('input') as HTMLInputElement)?.value?.trim() || '';
      await this.save({ ffmpegPath: val });
      if (!val) { new Notice('Imposta FFmpeg'); return false; }
    }
    if (this.step === 3) {
      const inputs = this.content.querySelectorAll('input');
      const main = (inputs[0] as HTMLInputElement)?.value?.trim() || '';
      const model = (inputs[1] as HTMLInputElement)?.value?.trim() || '';
      await this.save({ whisperMainPath: main, whisperModelPath: model });
      if (!main || !model) { new Notice('Imposta whisper main e modello'); return false; }
    }
    return true;
  }

  private resolveBackend(): 'dshow' | 'avfoundation' | 'pulse' | 'alsa' {
    if (this.settings.ffmpegInputFormat !== 'auto') return this.settings.ffmpegInputFormat as any;
    if (process.platform === 'win32') return 'dshow';
    if (process.platform === 'darwin') return 'avfoundation';
    return 'pulse';
  }
}
