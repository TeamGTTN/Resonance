import { App, Modal, Notice, TFile, moment } from "obsidian";
import { ResonanceSettings } from "./settings";

// Nota importante sull'esecuzione di processi esterni:
// Obsidian Desktop consente l'accesso a Node.js (Electron) in plugin community.
// Usiamo child_process per invocare ffmpeg e whisper.cpp in modo controllato.

interface RecordingModalState {
  phase: "idle" | "recording" | "transcribing" | "summarizing" | "error" | "done";
  startTs: number | null;
  elapsedSec: number;
  errorMessage?: string;
}

export class RecordingModal extends Modal {
  private settings: ResonanceSettings;
  private state: RecordingModalState = { phase: "idle", startTs: null, elapsedSec: 0 };
  private intervalId: number | null = null;
  private tempDir: string = "";
  private tempAudio: string = "";
  private ffmpegChild: any | null = null;
  private stopRecordingFn: (() => Promise<void>) | null = null;

  // Elementi UI di riferimento per aggiornamenti dinamici
  private statusEl!: HTMLElement;
  private timerEl!: HTMLElement;
  private controlBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private waveEl!: HTMLElement;

  constructor(app: App, settings: ResonanceSettings) {
    super(app);
    this.settings = settings;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("resonance-modal");

    contentEl.createEl("h2", { text: "Registratore Riunione" });

    const status = contentEl.createEl("div", { cls: "resonance-status" });
    this.statusEl = status;
    this.setStatus("Pronto per registrare");

    const timer = contentEl.createEl("div", { cls: "resonance-timer", text: "00:00" });
    this.timerEl = timer;

    const wave = contentEl.createEl("div", { cls: "resonance-wave" });
    this.waveEl = wave;

    const controls = contentEl.createEl("div", { cls: "resonance-controls" });
    const btn = controls.createEl("button", { cls: "resonance-btn primary" });
    btn.appendChild(createIcon("microphone"));
    btn.appendText(" Avvia Registrazione");
    btn.addEventListener("click", () => this.handleControlClick());
    this.controlBtn = btn as HTMLButtonElement;

    const cancel = controls.createEl("button", { cls: "resonance-btn secondary" });
    cancel.appendChild(createIcon("square"));
    cancel.appendText(" Annulla");
    cancel.addEventListener("click", () => this.cancelFlow());
    this.cancelBtn = cancel as HTMLButtonElement;
    this.cancelBtn.hide();
  }

  onClose(): void {
    this.clearTimer();
  }

  private setStatus(text: string) {
    this.statusEl.setText(text);
  }

  private setPhase(phase: RecordingModalState["phase"]) {
    this.state.phase = phase;
    switch (phase) {
      case "idle":
        this.setStatus("Pronto per registrare");
        this.updateButton("primary", "microphone", "Avvia Registrazione", true);
        this.cancelBtn.hide();
        this.waveEl.removeClass("active");
        break;
      case "recording":
        this.setStatus("Registrazione...");
        this.updateButton("danger", "square", "Ferma Registrazione", true);
        this.cancelBtn.hide();
        this.waveEl.addClass("active");
        break;
      case "transcribing":
        this.setStatus("Trascrizione...");
        this.updateButton("disabled", "loader", "Elaborazione...", false, true);
        this.cancelBtn.show();
        this.waveEl.removeClass("active");
        break;
      case "summarizing":
        this.setStatus("Riassunto...");
        this.updateButton("disabled", "loader", "Elaborazione...", false, true);
        this.cancelBtn.show();
        this.waveEl.removeClass("active");
        break;
      case "error":
        this.updateButton("primary", "microphone", "Riprova", true);
        this.cancelBtn.hide();
        this.waveEl.removeClass("active");
        break;
      case "done":
        this.updateButton("primary", "microphone", "Nuova Registrazione", true);
        this.cancelBtn.hide();
        this.waveEl.removeClass("active");
        break;
    }
  }

  private updateButton(style: "primary" | "danger" | "disabled", icon: IconName, label: string, enabled: boolean, spinning = false) {
    this.controlBtn.setAttr("class", `resonance-btn ${style}`);
    this.controlBtn.empty();
    this.controlBtn.appendChild(createIcon(icon, spinning));
    this.controlBtn.appendText(` ${label}`);
    this.controlBtn.disabled = !enabled;
  }

  private startTimer() {
    this.state.startTs = Date.now();
    this.state.elapsedSec = 0;
    this.timerEl.setText("00:00");

    this.clearTimer();
    this.intervalId = window.setInterval(() => {
      if (this.state.startTs) {
        const diff = Math.floor((Date.now() - this.state.startTs) / 1000);
        this.state.elapsedSec = diff;
        const mm = String(Math.floor(diff / 60)).padStart(2, "0");
        const ss = String(diff % 60).padStart(2, "0");
        this.timerEl.setText(`${mm}:${ss}`);
      }
    }, 500);
  }

  private clearTimer() {
    if (this.intervalId) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async handleControlClick() {
    try {
      if (this.state.phase === "idle" || this.state.phase === "error" || this.state.phase === "done") {
        await this.beginRecordingFlow();
      } else if (this.state.phase === "recording") {
        await this.stopRecordingFlow();
      }
    } catch (e: any) {
      new Notice(`Errore: ${e?.message ?? e}`);
      this.state.errorMessage = String(e?.message ?? e);
      this.setPhase("error");
      await this.cleanupTemp();
    }
  }

  private async cancelFlow() {
    try {
      if (this.state.phase === "recording" && this.stopRecordingFn) {
        await this.stopRecordingFn();
      }
    } finally {
      this.setPhase("idle");
      await this.cleanupTemp();
    }
  }

  // Fase 1: Registrazione Audio con ffmpeg (cross‑platform)
  private async beginRecordingFlow() {
    const { ffmpegPath } = this.settings;
    if (!ffmpegPath) throw new Error("Percorso FFmpeg non configurato");

    const os = (window as any).require("os");
    const path = (window as any).require("path");
    const fs = (window as any).require("fs");
    const { spawn } = (window as any).require("child_process");

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-"));
    this.tempAudio = path.join(this.tempDir, "registrazione.mp3");

    const { format, micSpec, systemSpec } = this.resolveFfmpegInput();

    const inputs: string[] = [];
    if (micSpec) {
      inputs.push("-f", format, "-i", micSpec);
    }
    if (systemSpec) {
      inputs.push("-f", format, "-i", systemSpec);
    }

    if (inputs.length === 0) {
      throw new Error("Nessun dispositivo di input FFmpeg configurato. Imposta almeno il microfono.");
    }

    const shouldMix = Boolean(micSpec && systemSpec);
    const mixArgs = shouldMix
      ? ["-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest"]
      : [];

    const outputArgs = ["-acodec", "libmp3lame", "-ab", "192k", this.tempAudio];

    this.setPhase("recording");
    this.startTimer();

    const args = [...inputs, ...mixArgs, ...outputArgs];
    this.ffmpegChild = spawn(ffmpegPath, args, { detached: false });

    // Riferimento per stop (cross‑platform)
    this.stopRecordingFn = async () => {
      try {
        const child = this.ffmpegChild;
        if (!child) return;
        if (process.platform === "win32") {
          try { child.kill("SIGINT"); } catch {}
          await waitMs(900);
          try { child.kill("SIGTERM"); } catch {}
          await waitMs(700);
          if (!child.killed) {
            const { spawn: sp } = (window as any).require("child_process");
            try { sp("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }); } catch {}
            await waitMs(600);
          }
        } else {
          try { child.kill("SIGINT"); } catch {}
          await waitMs(900);
          try { child.kill("SIGTERM"); } catch {}
          await waitMs(700);
          try { child.kill("SIGKILL"); } catch {}
        }
      } catch {}
    };
  }

  private resolveFfmpegInput(): { format: string; micSpec?: string; systemSpec?: string } {
    const platform = process.platform; // 'darwin' | 'win32' | 'linux'
    let format = this.settings.ffmpegInputFormat;
    if (format === "auto") {
      format = platform === "darwin" ? "avfoundation" : platform === "win32" ? "dshow" : "pulse";
    }

    const mic = (this.settings.ffmpegMicDevice || "").trim();
    const sys = (this.settings.ffmpegSystemDevice || "").trim();

    if (format === "avfoundation") {
      // macOS: audio-only -> ":index" (non "index:")
      return { format, micSpec: mic || ":0", systemSpec: sys || "" };
    }
    if (format === "dshow") {
      // Windows: serve 'audio=Nome Dispositivo'
      return { format, micSpec: mic || "audio=Microphone (default)", systemSpec: sys || "" };
    }
    // Linux (pulse/alsa): spesso 'default' funziona per mic; system audio richiede setup loopback
    return { format, micSpec: mic || "default", systemSpec: sys || "" };
  }

  private async stopRecordingFlow() {
    if (this.stopRecordingFn) {
      await this.stopRecordingFn();
      this.stopRecordingFn = null;
    }
    this.clearTimer();
    await waitMs(500); // tempo per chiusura file
    await this.transcribeFlow();
  }

  // Fase 2: Trascrizione con whisper.cpp
  private async transcribeFlow() {
    this.setPhase("transcribing");
    const { whisperMainPath, whisperModelPath, whisperLanguage } = this.settings;
    if (!whisperMainPath) throw new Error("Percorso whisper-cli non configurato");
    if (!whisperModelPath) throw new Error("Percorso modello Whisper non configurato");

    const fs = (window as any).require("fs");
    const { spawn } = (window as any).require("child_process");

    const args = ["-m", whisperModelPath, "-f", this.tempAudio];
    const lang = (whisperLanguage || 'auto').trim();
    if (lang && lang !== 'auto') { args.push('-l', lang); }

    const stdoutBuf: string[] = [];
    let stderrBuf = "";

    await new Promise<void>((resolve, reject) => {
      const child = spawn(whisperMainPath, args, { cwd: this.tempDir });
      child.stdout?.on("data", (d: Buffer) => stdoutBuf.push(d.toString()));
      child.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
      child.on("error", (err: any) => reject(err));
      child.on("close", (code: number) => {
        if (code === 0) resolve(); else reject(new Error(`whisper-cli uscita con codice ${code}: ${stderrBuf}`));
      });
    });

    // whisper-cli stampa la trascrizione su stdout; usiamo quella.
    const transcript = stdoutBuf.join("").trim();
    if (!transcript) throw new Error("Trascrizione vuota o non trovata");

    await this.summarizeFlow(transcript);
  }

  // Fase 3: Riassunto con Google Gemini
  private async summarizeFlow(transcript: string) {
    this.setPhase("summarizing");
    const { geminiApiKey, geminiModel } = this.settings;
    if (!geminiApiKey) throw new Error("API Key Gemini non configurata");

    const prompt = `Sei un assistente AI d'élite, specializzato nell'estrarre l'essenza da dialoghi professionali. Analizza la seguente trascrizione di una riunione e distilla le informazioni in un report conciso e strutturato in formato Markdown. Il tuo output deve essere immediatamente utilizzabile.

## Punti Salienti
- Un elenco puntato che cattura le conclusioni, le intuizioni e i temi principali emersi dalla discussione.

## Decisioni Formalizzate
- Un elenco chiaro e diretto delle decisioni approvate. Se non ci sono decisioni esplicite, scrivi 'Nessuna decisione formale presa'.

## Piano d'Azione
- Una checklist di task da completare, formattata come: - [ ] Descrizione chiara del task @Proprietario (se identificabile)

Se una sezione risulta vuota, omettila elegantemente dal report finale. Concentrati sulla chiarezza e la sintesi.`;

    const model = (geminiModel || "gemini-1.5-pro").trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: `\n\nTrascrizione:\n${transcript}` },
          ],
        },
      ],
    };

    const res = await fetch(`${url}?key=${encodeURIComponent(geminiApiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      throw new Error(`Errore API Gemini: ${res.status} ${errTxt}`);
    }

    const json = await res.json();
    const summary = extractMarkdownFromGemini(json) || "";
    if (!summary) throw new Error("Riassunto vuoto dalla risposta di Gemini");

    await this.createNoteAndFinish(summary);
  }

  // Fase 4: Creazione nota
  private async createNoteAndFinish(markdown: string) {
    const date = window.moment().format("YYYY-MM-DD HH-mm");
    const fileName = `Riunione ${date}.md`;
    const folder = this.settings.outputFolder?.trim();

    const fullPath = folder ? `${folder}/${fileName}` : fileName;
    const vault = this.app.vault;

    const tfile = await vault.create(fullPath, markdown);
    new Notice("Nota creata!");

    this.setPhase("done");
    await this.cleanupTemp();
    this.close();

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(tfile);
  }

  private async cleanupTemp() {
    try {
      if (!this.tempDir) return;
      const fs = (window as any).require("fs");
      const path = (window as any).require("path");
      const files: string[] = fs.readdirSync(this.tempDir) ?? [];
      for (const f of files) {
        try { fs.unlinkSync(path.join(this.tempDir, f)); } catch {}
      }
      try { fs.rmdirSync(this.tempDir); } catch {}
    } catch {}
  }
}

type IconName = "microphone" | "square" | "loader";
function createIcon(name: IconName, spinning = false): HTMLElement {
  const span = document.createElement("span");
  span.addClass("resonance-icon");
  if (spinning) span.addClass("spin");
  span.innerHTML =
    name === "microphone"
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2zM11 19h2v3h-2v-3z"/></svg>'
      : name === "square"
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>';
  return span;
}

function extractMarkdownFromGemini(json: any): string | null {
  try {
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("\n");
    if (text && typeof text === "string") return text.trim();
  } catch {}
  return null;
}

function waitMs(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}
