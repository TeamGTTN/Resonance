import { App, Modal, Notice } from "obsidian";
import { ResonanceSettings } from "./settings";
import { scanDevices, ListedDevice } from "./DeviceScanner";

export class SetupWizard extends Modal {
  private settings: ResonanceSettings;
  private save: (partial: Partial<ResonanceSettings>) => Promise<void>;
  private step = 0;
  private steps = ["API", "FFmpeg", "Devices", "Whisper", "Test", "Finish"];
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

    const title = contentEl.createEl("h2", { text: "Welcome to Resonance – Setup Wizard" });
    const indicator = contentEl.createEl("div", { cls: "resonance-steps" });
    this.steps.forEach((s, i) => {
      const dot = indicator.createEl("span", { text: s });
      if (i === this.step) dot.addClass("active");
    });

    this.content = contentEl.createEl("div", { cls: "resonance-wizard-content" });

    const controls = contentEl.createEl("div", { cls: "resonance-controls" });
    const back = controls.createEl("button", { cls: "resonance-btn secondary", text: "Back" });
    const next = controls.createEl("button", { cls: "resonance-btn primary", text: "Next" });

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
    this.content.createEl("h3", { text: "1) Gemini API Key" });
    const input = this.content.createEl("input", { type: "password" });
    input.placeholder = "gai-...";
    input.value = this.settings.geminiApiKey || "";
    input.addEventListener('input', () => (input.dataset.changed = '1'));
    this.content.createEl("p", { text: "The key is stored locally in Obsidian. Model is configurable in Settings." });
  }

  private renderFfmpegStep() {
    this.content.createEl("h3", { text: "2) FFmpeg" });
    const p = this.content.createEl("p", { text: "Specify or auto-detect the FFmpeg path." });
    const input = this.content.createEl("input");
    input.placeholder = process.platform === 'win32' ? 'C:/ffmpeg/bin/ffmpeg.exe' : '/opt/homebrew/bin/ffmpeg';
    input.value = this.settings.ffmpegPath || '';
    const detect = this.content.createEl("button", { cls: "resonance-btn secondary", text: "Detect" });
    detect.addEventListener('click', async () => {
      const guess = await (window as any).resonanceAutoDetectFfmpeg?.();
      if (guess) { input.value = guess; await this.save({ ffmpegPath: guess }); new Notice('FFmpeg detected'); }
      else new Notice('No FFmpeg found');
    });
  }

  private renderDevicesStep() {
    this.content.createEl("h3", { text: "3) Audio Devices" });
    const scanBtn = this.content.createEl("button", { cls: "resonance-btn secondary", text: "Scan devices" });
    const micSel = this.content.createEl("select");
    const sysSel = this.content.createEl("select");
    const none = document.createElement('option'); none.value = ''; none.text = '(none)'; sysSel.appendChild(none);

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
        new Notice(`Scan error: ${e?.message ?? e}`);
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
    const detect = this.content.createEl("button", { cls: "resonance-btn secondary", text: "Detect" });
    detect.addEventListener('click', async () => {
      const guess = await (window as any).resonanceAutoDetectWhisper?.();
      if (guess) { mainInput.value = guess; await this.save({ whisperMainPath: guess }); new Notice('whisper-cli detected'); }
      else new Notice('No whisper main found');
    });

    const modelInput = this.content.createEl("input");
    modelInput.placeholder = process.platform === 'win32' ? 'C:/modelli/ggml-base.en.bin' : '/path/ggml-base.en.bin';
    modelInput.value = this.settings.whisperModelPath || '';
  }

  private renderTestStep() {
    this.content.createEl("h3", { text: "5) Quick test" });
    const p2 = this.content.createEl("p", { text: "Runs a 3s mic recording to verify FFmpeg." });
    const btn = this.content.createEl("button", { cls: "resonance-btn primary", text: "Run 3s test" });
    btn.addEventListener('click', async () => {
      const ok = await (window as any).resonanceQuickTest?.();
      if (ok) new Notice('Test completed'); else new Notice('Test failed');
    });
  }

  private renderFinishStep() {
    this.content.createEl("h3", { text: "6) All set" });
    this.content.createEl("p", { text: "Basic configuration complete. You can tweak advanced options under Settings → Resonance." });
    const close = this.content.createEl("button", { cls: "resonance-btn primary", text: "Close" });
    close.addEventListener('click', async () => {
      await this.save({ simpleMode: true });
      this.close();
    });
  }

  private async validateAndSaveStep(): Promise<boolean> {
    if (this.step === 0) {
      const val = (this.content.querySelector('input') as HTMLInputElement)?.value?.trim() || '';
      await this.save({ geminiApiKey: val });
      if (!val) { new Notice('Enter the API Key'); return false; }
    }
    if (this.step === 1) {
      const val = (this.content.querySelector('input') as HTMLInputElement)?.value?.trim() || '';
      await this.save({ ffmpegPath: val });
      if (!val) { new Notice('Set FFmpeg'); return false; }
    }
    if (this.step === 3) {
      const inputs = this.content.querySelectorAll('input');
      const main = (inputs[0] as HTMLInputElement)?.value?.trim() || '';
      const model = (inputs[1] as HTMLInputElement)?.value?.trim() || '';
      await this.save({ whisperMainPath: main, whisperModelPath: model });
      if (!main || !model) { new Notice('Set whisper main and model'); return false; }
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
