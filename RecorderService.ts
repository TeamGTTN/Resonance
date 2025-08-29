import { App, Notice, TFile } from "obsidian";
import type { ResonanceSettings } from "./settings";

export type RecorderPhase = "idle" | "recording" | "transcribing" | "summarizing" | "error" | "done";

export class RecorderService {
  private app: App;
  private settings: ResonanceSettings;
  private pluginId: string;
  private saveSettings: (partial: Partial<ResonanceSettings>) => Promise<void>;

  private phase: RecorderPhase = "idle";
  private startTs: number | null = null;
  private elapsedIntervalId: number | null = null;

  private ffmpegChild: any | null = null;
  private stopRecordingFn: (() => Promise<void>) | null = null;

  private audioDir: string = "";
  private audioPath: string = "";
  private transcriptPath: string = "";
  private logPath: string = "";

  onPhaseChange?: (phase: RecorderPhase) => void;
  onElapsed?: (seconds: number) => void;
  onError?: (message: string) => void;
  onInfo?: (message: string) => void;

  constructor(app: App, settings: ResonanceSettings, pluginId: string, saveSettings: (partial: Partial<ResonanceSettings>) => Promise<void>) {
    this.app = app;
    this.settings = settings;
    this.pluginId = pluginId;
    this.saveSettings = saveSettings;
  }

  getPhase(): RecorderPhase {
    return this.phase;
  }

  private setPhase(p: RecorderPhase) {
    this.phase = p;
    this.onPhaseChange?.(p);
  }

  private startElapsedTimer() {
    this.startTs = Date.now();
    this.stopElapsedTimer();
    this.elapsedIntervalId = window.setInterval(() => {
      if (!this.startTs) return;
      const sec = Math.floor((Date.now() - this.startTs) / 1000);
      this.onElapsed?.(sec);
    }, 500);
  }

  private stopElapsedTimer() {
    if (this.elapsedIntervalId) {
      window.clearInterval(this.elapsedIntervalId);
      this.elapsedIntervalId = null;
    }
  }

  async start() {
    if (this.phase !== "idle" && this.phase !== "error" && this.phase !== "done") return;
    try {
      await this.prepareAudioPath();
      await this.beginRecording();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      this.onError?.(msg);
      this.setPhase("error");
    }
  }

  async stop() {
    if (this.phase !== "recording") return;
    try {
      if (this.stopRecordingFn) await this.stopRecordingFn();
      this.stopRecordingFn = null;
      this.stopElapsedTimer();
      await waitMs(500);
      try {
        const fs = (window as any).require("fs");
        const stat = fs.statSync(this.audioPath);
        this.appendLog(`Registrazione terminata. File: ${this.audioPath} (${stat.size} bytes)`);
      } catch { this.appendLog(`Registrazione terminata. File: ${this.audioPath}`); }
      this.onInfo?.(`File audio salvato in: ${this.audioPath}`);
      await this.transcribe();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      this.onError?.(msg);
      this.setPhase("error");
    }
  }

  private async prepareAudioPath() {
    const os = (window as any).require("os");
    const path = (window as any).require("path");
    const fs = (window as any).require("fs");

    // Determina la cartella del plugin nel vault: <vault>/.obsidian/plugins/<pluginId>/recordings
    const adapter = (this.app.vault as any).adapter;
    const basePath: string = adapter?.getBasePath?.() ?? adapter?.basePath ?? "";
    if (!basePath) throw new Error("Impossibile determinare il percorso del vault (solo Desktop)");
    const configDir: string = (this.app.vault as any).configDir ?? ".obsidian";
    const pluginDir = path.join(basePath, configDir, "plugins", this.pluginId);
    const recDir = path.join(pluginDir, "recordings");

    try { if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true }); } catch {}
    try { if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true }); } catch {}

    const stamp = new Date();
    const name = `registrazione_${
      stamp.getFullYear()
    }-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}_${String(stamp.getHours()).padStart(2, "0")}-${String(stamp.getMinutes()).padStart(2, "0")}-${String(stamp.getSeconds()).padStart(2, "0")}.mp3`;
    this.audioDir = recDir;
    this.audioPath = path.join(recDir, name);
    const base = name.replace(/\.mp3$/i, "");
    this.transcriptPath = path.join(recDir, `${base}.txt`);
    this.logPath = path.join(recDir, `${base}.log`);

    try { fs.appendFileSync(this.logPath, `[${new Date().toISOString()}] Sessione iniziata\n`); } catch {}
  }

  private resolveFfmpegInput(): { format: string; micSpec?: string; systemSpec?: string } {
    const platform = process.platform;
    let format = this.settings.ffmpegInputFormat;
    if (format === "auto") {
      format = platform === "darwin" ? "avfoundation" : platform === "win32" ? "dshow" : "pulse";
    }
    const mic = (this.settings.ffmpegMicDevice || "").trim();
    const sys = (this.settings.ffmpegSystemDevice || "").trim();
    // macOS: audio-only -> ":index" (non "index:")
    if (format === "avfoundation") return { format, micSpec: mic || ":0", systemSpec: sys || "" };
    if (format === "dshow") return { format, micSpec: mic || "audio=Microphone (default)", systemSpec: sys || "" };
    return { format, micSpec: mic || "default", systemSpec: sys || "" };
  }

  private async beginRecording() {
    const { ffmpegPath } = this.settings;
    if (!ffmpegPath) throw new Error("Percorso FFmpeg non configurato");

    const { spawn } = (window as any).require("child_process");

    const { format, micSpec, systemSpec } = this.resolveFfmpegInput();
    const inputs: string[] = [];
    if (micSpec) inputs.push("-f", format, "-i", micSpec);
    if (systemSpec) inputs.push("-f", format, "-i", systemSpec);
    if (inputs.length === 0) throw new Error("Nessun dispositivo di input FFmpeg configurato. Imposta almeno il microfono.");

    const shouldMix = Boolean(micSpec && systemSpec);
    const mixArgs = shouldMix ? ["-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest"] : [];
    const outputArgs = ["-acodec", "libmp3lame", "-ab", "192k", this.audioPath];

    this.setPhase("recording");
    this.startElapsedTimer();

    const args = ["-y", ...inputs, ...mixArgs, ...outputArgs];
    this.ffmpegChild = spawn(ffmpegPath, args, { detached: false });
    this.appendLog(`FFmpeg avviato: ${ffmpegPath} ${args.join(" ")}`);

    // Se FFmpeg termina subito con errore, notifichiamo
    let ffErr = "";
    this.ffmpegChild.stderr?.on("data", (d: Buffer) => { ffErr += d.toString(); });
    this.ffmpegChild.on("close", (code: number) => {
      if (this.phase === "recording" && code !== 0) {
        const tail = ffErr.split(/\r?\n/).slice(-8).join("\n");
        this.onError?.(`FFmpeg terminato con codice ${code}.\n${tail}`);
        this.appendLog(`FFmpeg errore (${code}):\n${tail}`);
        this.setPhase("error");
      }
    });

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

  private async transcribe() {
    this.setPhase("transcribing");
    const { whisperMainPath, whisperModelPath, whisperLanguage } = this.settings;
    if (!whisperMainPath) throw new Error("Percorso whisper-cli non configurato");
    if (!whisperModelPath) throw new Error("Percorso modello Whisper non configurato");

    const { spawn } = (window as any).require("child_process");
    const fs = (window as any).require("fs");

    const args = ["-m", whisperModelPath, "-f", this.audioPath];
    const lang = (whisperLanguage || "auto").trim();
    if (lang && lang !== "auto") { args.push("-l", lang); }
    this.appendLog(`Trascrizione: ${whisperMainPath} ${args.join(" ")}`);

    const stdoutBuf: string[] = [];
    let stderrBuf = "";

    await new Promise<void>((resolve, reject) => {
      const child = spawn(whisperMainPath, args, { cwd: this.audioDir });
      child.stdout?.on("data", (d: Buffer) => stdoutBuf.push(d.toString()));
      child.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
      child.on("error", (err: any) => reject(err));
      child.on("close", (code: number) => {
        if (code === 0) resolve(); else reject(new Error(`whisper-cli uscita con codice ${code}: ${stderrBuf}`));
      });
    });

    const transcript = stdoutBuf.join("").trim();
    if (!transcript) throw new Error("Trascrizione vuota o non trovata");
    try { fs.writeFileSync(this.transcriptPath, transcript, { encoding: "utf8" }); this.appendLog(`Trascrizione salvata: ${this.transcriptPath} (${transcript.length} chars)`); } catch {}
    this.onInfo?.(`Trascrizione salvata: ${this.transcriptPath}`);

    await this.summarize(transcript);
  }

  private async summarize(transcript: string) {
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
    } as any;

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
    this.appendLog(`Riassunto generato (${summary.length} chars)`);

    await this.createNote(summary);
  }

  private async createNote(markdown: string) {
    const fileName = `Riunione ${window.moment().format("YYYY-MM-DD HH-mm")}.md`;
    const folder = this.settings.outputFolder?.trim();
    const fullPath = folder ? `${folder}/${fileName}` : fileName;
    const tfile = await this.app.vault.create(fullPath, markdown);
    new Notice("Nota creata!");
    this.appendLog(`Nota creata: ${fullPath}`);

    this.setPhase("done");
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(tfile as TFile);
  }

  private appendLog(message: string) {
    try {
      if (!this.logPath) return;
      const fs = (window as any).require("fs");
      fs.appendFileSync(this.logPath, `[${new Date().toISOString()}] ${message}\n`);
    } catch {}
  }
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


