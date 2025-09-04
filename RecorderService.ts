import { App, Notice, TFile } from "obsidian";
import { summarizeWithLLM, type LlmConfig } from "./llm";
import { normalizeCheckboxes } from "./markdown";
import { scanDevices } from "./DeviceScanner";
import type { ResonanceSettings } from "./settings";

// This module provides the recorder service for the plugin.

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
  private explicitStopRequested: boolean = false;

  private audioDir: string = "";
  private audioPath: string = "";
  private transcriptPath: string = "";
  private logPath: string = "";
  private selectedPresetKey: string | null = null;

  private liveWatcher: any | null = null;
  private liveProcessedSegments: Set<string> = new Set();
  private livePendingTimers: Map<string, any> = new Map();
  private liveSegmentPattern: string | null = null;
  private liveSegmentRegex: RegExp | null = null;
  private liveNoteFile: TFile | null = null;
  private liveSeenIndexes: Set<number> = new Set();
  private liveMaxIndexSeen: number = -1;
  private liveSeenPaths: Set<string> = new Set();
  private liveVaultFolder: string | null = null;

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

  async startWithPreset(presetKey: string) {
    this.selectedPresetKey = presetKey;
    await this.start();
  }

  async stop() {
    if (this.phase !== "recording") return;
    try {
      // Segnala che stiamo fermando intenzionalmente FFmpeg
      this.explicitStopRequested = true;
      if (this.stopRecordingFn) await this.stopRecordingFn();
      this.stopRecordingFn = null;
      this.stopElapsedTimer();
      await waitMs(500);
      try {
        const fs = (window as any).require("fs");
        const stat = fs.statSync(this.audioPath);
        this.appendLog(`Recording finished. File: ${this.audioPath} (${stat.size} bytes)`);
      } catch { this.appendLog(`Recording finished. File: ${this.audioPath}`); }
      await this.enforceRetention();
      // Live only: ferma watcher, poi passa al riassunto
      await this.stopLiveWatcherAndFinalize();
      this.setPhase("summarizing");
      const fs = (window as any).require("fs");
      const transcript = fs.existsSync(this.transcriptPath) ? String(fs.readFileSync(this.transcriptPath, { encoding: "utf8" })) : "";
      if (transcript.trim().replace(/\s+/g, "").length < 150) {
        this.onInfo?.("Transcription too short – summary skipped");
        this.setPhase("done");
        return;
      }
      this.onInfo?.("Summarizing...");
      await this.summarize(transcript);
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

    // Determine plugin folder inside the vault: <vault>/.obsidian/plugins/<pluginId>/recordings
    const adapter = (this.app.vault as any).adapter;
    const basePath: string = adapter?.getBasePath?.() ?? adapter?.basePath ?? "";
    if (!basePath) throw new Error("Unable to determine vault base path (Desktop only)");
    const configDir: string = (this.app.vault as any).configDir ?? ".obsidian";
    const pluginDir = path.join(basePath, configDir, "plugins", this.pluginId);
    const recDir = path.join(pluginDir, "recordings");

    try { if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true }); } catch {}
    try { if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true }); } catch {}

    const stamp = new Date();
    const name = `recording_${
      stamp.getFullYear()
    }-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}_${String(stamp.getHours()).padStart(2, "0")}-${String(stamp.getMinutes()).padStart(2, "0")}-${String(stamp.getSeconds()).padStart(2, "0")}.mp3`;
    const base = name.replace(/\.mp3$/i, "");
    const baseDir = path.join(recDir, base);
    try { if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true }); } catch {}
    this.audioDir = baseDir;
    this.audioPath = path.join(baseDir, name);
    this.transcriptPath = path.join(baseDir, `${base}.txt`);
    this.logPath = path.join(baseDir, `${base}.log`);

    // Prepara pattern per segmenti live
    this.liveSegmentPattern = `${base}_seg_%03d.mp3`;
    this.liveSegmentRegex = new RegExp(`^${base}_seg_(\\d{3})\\.mp3$`);

    try { fs.appendFileSync(this.logPath, `[${new Date().toISOString()}] Sessione iniziata\n`); } catch {}
  }

  private async enforceRetention() {
    try {
      const max = Number(this.settings.maxRecordingsKept || 0);
      if (!isFinite(max) || max <= 0) return; // 0 or invalid = infinite
      const fs = (window as any).require("fs");
      const path = (window as any).require("path");
      const dir = this.audioDir;
      if (!dir || !fs.existsSync(dir)) return;
      const files: string[] = fs.readdirSync(dir) ?? [];
      const mp3s = files.filter(f => /\.mp3$/i.test(f));
      const entries = mp3s.map(f => {
        const p = path.join(dir, f);
        let stat: any; try { stat = fs.statSync(p); } catch { stat = { mtimeMs: 0 }; }
        return { name: f, path: p, mtime: stat.mtimeMs || stat.ctimeMs || 0 };
      }).sort((a,b)=> b.mtime - a.mtime);
      if (entries.length <= max) return;
      const toDelete = entries.slice(max);
      for (const e of toDelete) {
        try {
          const base = e.name.replace(/\.mp3$/i, "");
          const txt = path.join(dir, `${base}.txt`);
          const log = path.join(dir, `${base}.log`);
          try { fs.unlinkSync(e.path); } catch {}
          try { fs.unlinkSync(txt); } catch {}
          try { fs.unlinkSync(log); } catch {}
        } catch {}
      }
    } catch {}
  }

  private async resolveFfmpegInput(): Promise<{ format: string; micSpec?: string; systemSpec?: string }> {
    const platform = process.platform;
    let format = this.settings.ffmpegInputFormat;
    if (format === "auto") {
      format = platform === "darwin" ? "avfoundation" : platform === "win32" ? "dshow" : "pulse";
    }

    const micSaved = (this.settings.ffmpegMicDevice || "").trim();
    const sysSaved = (this.settings.ffmpegSystemDevice || "").trim();

    if (format === "avfoundation") {
      // Su macOS gli indici AVFoundation cambiano tra sessioni.
      // Rimappiamo in base al label salvato (se presente), altrimenti verifichiamo l'esistenza dell'indice corrente.
      const ffmpegPath = (this.settings.ffmpegPath || "").trim();
      let devices: Awaited<ReturnType<typeof scanDevices>> = [];
      try {
        if (ffmpegPath) devices = await scanDevices(ffmpegPath, "avfoundation");
      } catch (e: any) {
        this.appendLog(`Device scan failed: ${e?.message ?? e}`);
      }

      const stripPrefix = (s: string) => s.replace(/^\d+:\s*/, "").trim();
      const audioDevices = devices.filter(d => d.type === "audio");

      const micLabelSaved = stripPrefix((this.settings.ffmpegMicLabel || ""));
      const sysLabelSaved = stripPrefix((this.settings.ffmpegSystemLabel || ""));

      const findByLabel = (label: string) => audioDevices.find(d => stripPrefix(d.label) === label);
      const findByName = (name: string) => audioDevices.find(d => d.name === name);
      const findByIndexString = (idxStr: string) => audioDevices.find(d => d.name === `:${idxStr}`);

      const normalizeIndexish = (v: string): string => {
        if (!v) return "";
        if (/^:\d+$/.test(v)) return v; // già formattato
        if (/^\d+$/.test(v)) return `:${v}`; // solo numero → aggiungi prefisso audio
        return ""; // non valido per avfoundation audio
      };

      let micSpec = "";
      let systemSpec = "";

      // Microfono: priorità label → nome → indice salvato normalizzato → default
      const micByLabel = micLabelSaved ? findByLabel(micLabelSaved) : undefined;
      const micSavedNormalized = normalizeIndexish(micSaved);
      const micByName = micSaved ? findByName(micSaved) : undefined;
      const micByIdx = micSavedNormalized ? findByName(micSavedNormalized) || findByIndexString(micSavedNormalized.slice(1)) : undefined;
      if (micByLabel) micSpec = micByLabel.name;
      else if (micByName) micSpec = micByName.name;
      else if (micByIdx) micSpec = micByIdx.name;
      else micSpec = ":0";

      const micResolvedObj = audioDevices.find(d => d.name === micSpec);
      if (micSpec !== micSaved) {
        this.appendLog(`Remapped microphone to ${micSpec} (was ${micSaved || 'unset'})`);
      } else {
        this.appendLog(`Using mic device: ${micSpec} (saved: ${micSaved || 'none'})`);
      }
      // Allinea sempre i settings persistiti al valore risolto
      try {
        await this.saveSettings({ ffmpegMicDevice: micSpec, ffmpegMicLabel: micResolvedObj?.label || micLabelSaved || "" });
      } catch {}

      // System audio: stessa strategia (se configurato)
      if (sysLabelSaved || sysSaved) {
        const sysByLabel = sysLabelSaved ? findByLabel(sysLabelSaved) : undefined;
        const sysSavedNormalized = normalizeIndexish(sysSaved);
        const sysByName = sysSaved ? findByName(sysSaved) : undefined;
        const sysByIdx = sysSavedNormalized ? findByName(sysSavedNormalized) || findByIndexString(sysSavedNormalized.slice(1)) : undefined;
        if (sysByLabel) systemSpec = sysByLabel.name;
        else if (sysByName) systemSpec = sysByName.name;
        else if (sysByIdx) systemSpec = sysByIdx.name;
        else systemSpec = "";
        const sysResolvedObj = systemSpec ? audioDevices.find(d => d.name === systemSpec) : undefined;
        if (systemSpec && systemSpec !== sysSaved) {
          this.appendLog(`Remapped system audio to ${systemSpec} (was ${sysSaved || 'unset'})`);
        } else if (systemSpec) {
          this.appendLog(`Using system device: ${systemSpec}`);
        }
        // Allinea sempre i settings persistiti al valore risolto
        if (systemSpec) {
          try {
            await this.saveSettings({ ffmpegSystemDevice: systemSpec, ffmpegSystemLabel: sysResolvedObj?.label || sysLabelSaved || "" });
          } catch {}
        }
      }

      return { format, micSpec, systemSpec };
    }

    if (format === "dshow") {
      const ensureDshowPrefix = (v: string): string => {
        if (!v) return v;
        return /^(audio=|video=|@device_)/i.test(v) ? v : `audio=${v}`;
      };
      const micName = micSaved || "audio=Microphone (default)";
      return { format, micSpec: ensureDshowPrefix(micName), systemSpec: sysSaved ? ensureDshowPrefix(sysSaved) : "" };
    }
    return { format, micSpec: micSaved || "default", systemSpec: sysSaved || "" };
  }

  private async beginRecording() {
    const { ffmpegPath } = this.settings;
    if (!ffmpegPath) throw new Error("FFmpeg path not configured");

    const { spawn } = (window as any).require("child_process");

    const { format, micSpec, systemSpec } = await this.resolveFfmpegInput();
    const inputs: string[] = [];
    const sr = Math.max(8000, Number(this.settings.recordSampleRateHz || 48000));
    const ch = Math.max(1, Math.min(2, Number(this.settings.recordChannels || 1)));
    const buildInputArgs = (spec: string): string[] => {
      // Per avfoundation (macOS) -ar/-ac per-input generano errore (Option sample_rate not found).
      // Manteniamo solo -thread_queue_size a livello di input e forziamo formato in uscita.
      return ["-f", format, "-thread_queue_size", "1024", "-i", spec];
    };
    if (micSpec) inputs.push(...buildInputArgs(micSpec));
    if (systemSpec) inputs.push(...buildInputArgs(systemSpec));
    if (inputs.length === 0) throw new Error("No FFmpeg input device configured. Set at least the microphone.");

    const shouldMix = Boolean(micSpec && systemSpec);
    const mixArgs = shouldMix ? [
      "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest[aout]"
    ] : [];
    const mapArgs = shouldMix ? ["-map", "[aout]"] : ["-map", "0:a"];
    const br = Math.max(64, Number(this.settings.recordBitrateKbps || 192));
    const audioFmtArgs = ["-vn", "-ar", String(sr), "-ac", String(ch)];
    let outputArgs: string[];
    {
      // Segmentazione in tempo reale + copia file completo
      // Segmenti fissi di 20 secondi
      const segSeconds = 20;
      const path = (window as any).require("path");
      const segPattern = path.join(this.audioDir, this.liveSegmentPattern || "segments_%03d.mp3");
      // tee muxer: un ramo segmentato, un ramo file completo
      const teeSpec = `[f=segment:segment_time=${segSeconds}:reset_timestamps=1]${segPattern}|${this.audioPath}`;
      outputArgs = [
        ...audioFmtArgs,
        ...mapArgs,
        "-c:a","libmp3lame","-b:a",`${br}k`,
        "-f","tee",
        teeSpec
      ];
    }

    this.setPhase("recording");
    this.startElapsedTimer();

    const args = ["-y", ...inputs, ...mixArgs, ...outputArgs];
    this.ffmpegChild = spawn(ffmpegPath, args, { detached: false, stdio: ["pipe", "ignore", "pipe"] });
    this.appendLog(`FFmpeg started: ${ffmpegPath} ${args.join(" ")}`);

    // Collect stderr to surface meaningful tail on errors
    let ffErr = "";
    this.ffmpegChild.stderr?.on("data", (d: Buffer) => { ffErr += d.toString(); });
    this.ffmpegChild.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const signaled = Boolean(signal);
      const userStop = this.explicitStopRequested || signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGKILL";

      if (userStop) {
        this.appendLog(`FFmpeg terminated on request (code=${code ?? 0}, signal=${signal ?? "none"}).`);
        // Do not treat as error; stop() flow will continue
      } else if (this.phase === "recording" && (code ?? 0) !== 0) {
        const tail = ffErr.split(/\r?\n/).slice(-8).join("\n");
        this.onError?.(`FFmpeg exited with code ${code}.\n${tail}`);
        this.appendLog(`FFmpeg error (${code}):\n${tail}`);
        this.setPhase("error");
      }

      this.explicitStopRequested = false;
      this.ffmpegChild = null;
    });

    this.stopRecordingFn = async () => {
      try {
        const child = this.ffmpegChild;
        if (!child) return;
        // Prova chiusura "graceful" inviando 'q' su stdin (FFmpeg flush + finalize)
        try { child.stdin?.write("q\n"); } catch {}
        const closed = await waitChildClose(child, 1500);
        if (closed) return;
        // fallback: segnali
        try { child.kill("SIGINT"); } catch {}
        if (await waitChildClose(child, 1200)) return;
        try { child.kill("SIGTERM"); } catch {}
        if (await waitChildClose(child, 1000)) return;
        if (process.platform === "win32") {
          const { spawn: sp } = (window as any).require("child_process");
          try { sp("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }); } catch {}
          await waitChildClose(child, 800);
        } else {
          try { child.kill("SIGKILL"); } catch {}
          await waitChildClose(child, 500);
        }
      } catch {}
    };

    // Se live attivo, avvia watcher per nuovi segmenti
    this.startLiveWatcher();
    await this.ensureLiveNoteOpen();
  }

  // Post-process transcription removed: live only

  private async summarize(transcript: string) {
    this.setPhase("summarizing");
    const { PROMPT_PRESETS, DEFAULT_PROMPT_KEY } = await import('./prompts');
    const preset = PROMPT_PRESETS[this.selectedPresetKey || this.settings.lastPromptKey || DEFAULT_PROMPT_KEY] || PROMPT_PRESETS[DEFAULT_PROMPT_KEY];
    const prompt = preset.prompt;

    const cfg: LlmConfig = (() => {
      const provider = this.settings.llmProvider || 'gemini';
      if (provider === 'openai') return { provider, apiKey: this.settings.openaiApiKey, model: this.settings.openaiModel || 'gpt-4o-mini' };
      if (provider === 'anthropic') return { provider, apiKey: this.settings.anthropicApiKey, model: this.settings.anthropicModel || 'claude-3-5-sonnet-latest' };
      if (provider === 'ollama') return { provider, model: this.settings.ollamaModel || 'qwen3:8b', endpoint: this.settings.ollamaEndpoint || 'http://localhost:11434' };
      return { provider: 'gemini', apiKey: this.settings.geminiApiKey, model: this.settings.geminiModel || 'gemini-2.5-pro' };
    })();

    const expectedLang = (this.settings.whisperLanguage || 'auto');
    // Importa la funzione di rilevamento per il log
    const { detectLanguageFromTranscript } = await import('./llm');
    const detectedLang = expectedLang === 'auto' ? detectLanguageFromTranscript(transcript) : expectedLang;
    this.appendLog(`Generating summary with ${cfg.provider}, language setting: ${expectedLang}, effective: ${detectedLang}`);
    const raw = await summarizeWithLLM(cfg, prompt, transcript, expectedLang);
    const { sanitizeSummary } = await import('./markdown');
    const summary = normalizeCheckboxes(sanitizeSummary(raw || ''));
    if (!summary.trim()) {
      this.appendLog(`Summary skipped: empty output (provider=${cfg.provider}).`);
      this.onInfo?.("Summary skipped");
      this.setPhase("done");
      return;
    }
    this.appendLog(`Summary generated (${summary.length} chars) via ${cfg.provider}, final lang=${detectedLang}`);

    await this.createNote(summary);
  }

  private async createNote(markdown: string) {
    try { if (!this.liveVaultFolder) await this.ensureLiveNoteOpen(); } catch {}
    const folderPath = this.liveVaultFolder || (this.settings.outputFolder?.trim() || '');
    const fullPath = folderPath ? `${folderPath}/Summary.md` : `Summary ${window.moment().format("YYYY-MM-DD HH-mm")}.md`;
    const tfile = await this.app.vault.create(fullPath, markdown);
    new Notice("Note created!");
    this.appendLog(`Note created: ${fullPath}`);

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

  // Avvia un watcher sulla cartella per trascrivere i segmenti appena chiusi
  private startLiveWatcher() {
    try {
      const fs = (window as any).require("fs");
      if (!this.liveSegmentRegex) return;
      // Reset stato
      this.liveProcessedSegments.clear();
      for (const t of this.livePendingTimers.values()) { try { clearTimeout(t); } catch {} }
      this.livePendingTimers.clear();
      this.liveSeenPaths.clear();
      // Crea/azzera transcript file
      try { fs.writeFileSync(this.transcriptPath, ""); } catch {}

      this.appendLog("Live watcher started");
      this.liveWatcher = fs.watch(this.audioDir, { persistent: true }, (event: string, filename: string) => {
        try {
          if (!filename) return;
          const m = this.liveSegmentRegex!.exec(filename);
          if (!m) return;
          const idx = parseInt(m[1], 10);
          const segPath = `${this.audioDir}/${filename}`;
          if (!Number.isFinite(idx)) return;
          if (!this.liveSeenPaths.has(segPath)) {
            this.liveSeenPaths.add(segPath);
            this.appendLog(`Detected new live segment: ${filename}`);
          }
          this.liveSeenIndexes.add(idx);
          this.liveMaxIndexSeen = Math.max(this.liveMaxIndexSeen, idx);
          // Processa il segmento precedente (idx-1) se presente e non processato
          const prevIdx = idx - 1;
          if (prevIdx >= 0) {
            const prevName = filename.replace(/_(\d{3})\.mp3$/, `_${String(prevIdx).padStart(3,'0')}.mp3`);
            const prevPath = `${this.audioDir}/${prevName}`;
            if (!this.liveProcessedSegments.has(prevPath)) {
              if (!this.livePendingTimers.has(prevPath)) {
                const t = setTimeout(()=>{
                  this.livePendingTimers.delete(prevPath);
                  this.handleNewLiveSegment(prevPath).catch(()=>{});
                }, 800);
                this.livePendingTimers.set(prevPath, t);
              }
            }
          }
        } catch {}
      });
    } catch {}
  }

  private async handleNewLiveSegment(segPath: string) {
    try {
      if (this.liveProcessedSegments.has(segPath)) return;
      this.liveProcessedSegments.add(segPath);
      const idxMatch = segPath.match(/_(\d{3})\.mp3$/);
      const idx = idxMatch ? parseInt(idxMatch[1], 10) : 0;
      const text = await this.transcribeChunk(segPath, idx);
      if (!text.trim()) return;
      const fs = (window as any).require("fs");
      const prefix = (fs.existsSync(this.transcriptPath) && fs.readFileSync(this.transcriptPath, 'utf8').trim() ? "\n\n" : "");
      fs.appendFileSync(this.transcriptPath, prefix + text, { encoding: 'utf8' });
      await this.updateLiveNote(prefix + text);
      try { fs.unlinkSync(segPath); } catch {}
    } catch (e: any) {
      this.appendLog(`Live segment failed: ${e?.message ?? e}`);
    }
  }

  private async ensureLiveNoteOpen() {
    try {
      const date = window.moment().format("YYYY-MM-DD HH-mm");
      let scenarioLabel: string | null = null;
      try {
        const { PROMPT_PRESETS, DEFAULT_PROMPT_KEY } = await import('./prompts');
        const key = (this.selectedPresetKey || this.settings.lastPromptKey || DEFAULT_PROMPT_KEY);
        scenarioLabel = PROMPT_PRESETS[key]?.label || null;
      } catch {}
      const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-');
      const folderBase = scenarioLabel ? `${safe(scenarioLabel)} ${date}` : `Meeting ${date}`;
      const root = (this.settings.outputFolder || '').trim();
      const folderPath = root ? `${root}/${folderBase}` : folderBase;
      this.liveVaultFolder = folderPath;
      const vault = this.app.vault;
      try { await (vault as any).createFolder(folderPath); } catch {}
      const notePath = `${folderPath}/Live transcript.md`;
      let file = this.liveNoteFile;
      if (!file) {
        try {
          const existing = vault.getAbstractFileByPath(notePath) as TFile | null;
          file = existing || await vault.create(notePath, `# Live transcript\n\n`);
          this.liveNoteFile = file;
        } catch {}
      }
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(this.liveNoteFile as TFile);
    } catch {}
  }

  private async updateLiveNote(appendText: string) {
    try {
      if (!this.liveNoteFile) return;
      const vault = this.app.vault;
      const current = await vault.read(this.liveNoteFile);
      const next = current + appendText;
      await vault.modify(this.liveNoteFile, next);
    } catch {}
  }

  private async stopLiveWatcherAndFinalize() {
    try {
      const fs = (window as any).require("fs");
      if (this.liveWatcher) { try { this.liveWatcher.close?.(); } catch {} this.liveWatcher = null; }
      // Processa l'ultimo segmento (max index) non ancora processato
      const files: string[] = fs.readdirSync(this.audioDir) ?? [];
      const segs = this.liveSegmentRegex ? files.filter(f => this.liveSegmentRegex!.test(f)) : [];
      segs.sort();
      for (const f of segs) {
        const p = `${this.audioDir}/${f}`;
        if (!this.liveProcessedSegments.has(p)) {
          await this.handleNewLiveSegment(p);
        }
      }
      // Cleanup timers
      for (const t of this.livePendingTimers.values()) { try { clearTimeout(t); } catch {} }
      this.livePendingTimers.clear();
      this.appendLog("Live watcher stopped");
    } catch {}
  }

  // Trascrivi un singolo chunk
  private async transcribeChunk(chunkPath: string, chunkIndex: number): Promise<string> {
    const { spawn } = (window as any).require("child_process");
    const fs = (window as any).require("fs");
    const path = (window as any).require("path");
    const { whisperMainPath, whisperModelPath, whisperLanguage } = this.settings;
    
    const args = ["-m", whisperModelPath, "-f", chunkPath];
    const lang = (whisperLanguage || "auto").trim();
    if (lang && lang !== "auto") { args.push("-l", lang); }
    
    // Parametri anti-loop per chunk
    args.push("--max-context", "128", "--entropy-thold", "2.4", "--logprob-thold", "-1.0", "--max-len", "0");
    args.push("--max-context", "128", "--entropy-thold", "2.4", "--logprob-thold", "-1.0", "--max-len", "0");
    args.push("--best-of", "1", "--no-timestamps", "--word-thold", "0.01");
    
    // Output su file temporaneo
    const tempTxtPath = chunkPath.replace(/\.mp3$/i, ".txt");
    const outPrefix = chunkPath.replace(/\.mp3$/i, "");
    args.push("-otxt", "-of", outPrefix);
    
    this.appendLog(`Transcribing chunk ${chunkIndex}: ${path.basename(chunkPath)}`);
    
    const stdoutBuf: string[] = [];
    let stderrBuf = "";
    
    await new Promise<void>((resolve, reject) => {
      const child = spawn(whisperMainPath, args, { cwd: path.dirname(chunkPath) });
      child.stdout?.on("data", (d: Buffer) => stdoutBuf.push(d.toString()));
      child.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
      child.on("error", (err: any) => reject(err));
      child.on("close", (code: number) => {
        if (code === 0) resolve(); else reject(new Error(`whisper chunk ${chunkIndex} failed: ${stderrBuf}`));
      });
    });
    
    // Leggi trascrizione
    let transcript = "";
    try {
      if (fs.existsSync(tempTxtPath)) {
        transcript = String(fs.readFileSync(tempTxtPath, { encoding: "utf8" })).trim();
        fs.unlinkSync(tempTxtPath); // Pulisci subito
      }
    } catch {}
    if (!transcript) transcript = stdoutBuf.join("").trim();
    
    return transcript;
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

async function waitChildClose(child: any, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const onClose = () => { if (!done) { done = true; resolve(true); } };
    child.once?.("close", onClose);
    setTimeout(() => { if (!done) { done = true; try { child.off?.("close", onClose); } catch {} resolve(false); } }, timeoutMs);
  });
}


