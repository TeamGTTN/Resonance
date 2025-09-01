import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { scanDevices, ListedDevice } from "./DeviceScanner";
import { HelpModal } from "./HelpModal";
import { LibraryModal } from "./LibraryModal";

export interface ResonanceSettings {
  geminiApiKey: string;
  geminiModel: string;
  ffmpegPath: string;
  ffmpegInputFormat: "auto" | "avfoundation" | "dshow" | "pulse" | "alsa";
  ffmpegMicDevice: string;
  ffmpegMicLabel?: string; // human label for remapping (avfoundation)
  ffmpegSystemDevice: string;
  ffmpegSystemLabel?: string; // human label for remapping (avfoundation)
  whisperRepoPath: string; // repo root path for whisper.cpp
  whisperMainPath: string; // whisper-cli resolved automatically from repo
  whisperModelPath: string;
  whisperModelPreset: "small" | "medium" | "large"; // quick choices
  whisperLanguage: string; // ISO code or 'auto'
  outputFolder: string;
  lastPromptKey?: string;
  maxRecordingsKept: number; // 0 = infinite
  // Recording quality
  recordSampleRateHz?: number; // e.g., 48000
  recordChannels?: number; // 1 or 2
  recordBitrateKbps?: number; // e.g., 192
}

export const DEFAULT_SETTINGS: ResonanceSettings = {
  geminiApiKey: "",
  geminiModel: "gemini-2.5-pro",
  ffmpegPath: "",
  ffmpegInputFormat: "auto",
  ffmpegMicDevice: "",
  ffmpegMicLabel: "",
  ffmpegSystemDevice: "",
  ffmpegSystemLabel: "",
  whisperRepoPath: "",
  whisperMainPath: "",
  whisperModelPath: "",
  whisperModelPreset: "medium",
  whisperLanguage: "auto",
  outputFolder: "",
  lastPromptKey: undefined,
  maxRecordingsKept: 5,
  recordSampleRateHz: 44100,
  recordChannels: 2,
  recordBitrateKbps: 160,
};

export class ResonanceSettingTab extends PluginSettingTab {
  private settings: ResonanceSettings;
  private save: (settings: Partial<ResonanceSettings>) => Promise<void>;
  private lastScan: ListedDevice[] = [];
  private pluginId: string;

  constructor(app: App, settings: ResonanceSettings, save: (settings: Partial<ResonanceSettings>) => Promise<void>) {
    super(app, (app as any).plugins.getPlugin("resonance"));
    this.settings = settings;
    const saveFn = save;
    this.save = async (partial: Partial<ResonanceSettings>) => {
      await saveFn(partial);
      // Mantieni lo stato locale sincronizzato per riflettere subito nell'UI
      this.settings = { ...this.settings, ...partial } as ResonanceSettings;
    };
    this.pluginId = ((app as any).plugins.getPlugin("resonance")?.manifest?.id) || "resonance";
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Resonance" });

    containerEl.createEl("p", { 
      text: "Thanks for using Resonance :)"
    });
    containerEl.createEl("p", { 
      text: "I know, setup can be a bit of a hassle... but once you’re done, you’ll be recording and transcribing like a pro! Take a few minutes to complete all the steps,future you will thank you."
    });
    
    containerEl.createEl("p", {
      text: "After you've completed the setup, use the microphone icon in the ribbon to start/stop, select a scenario from the menu that appears, and watch the timer in the status bar. "
    });

    containerEl.createEl("p", {
      text: "When finished, a note will be created in the Notes folder you've selected. You can also open the Library (audio file icon) to listen, copy the transcription, or manage recordings."
    });

    // STEP 1: FFmpeg
    containerEl.createEl("h3", { text: "FFmpeg" });
    containerEl.createEl("p", { text: "Used to capture audio from your microphone and system audio." });

    new Setting(containerEl)
    .setName("Installation")
    .setDesc("Install on macOS via Homebrew, Windows static build, or Linux via package manager.")
    .addButton((btn)=> btn.setButtonText("Guide").onClick(()=> new HelpModal(this.app, 'ffmpeg').open()));

    const ffmpegSetting = new Setting(containerEl)
      .setName("FFmpeg path")
      .setDesc("Choose the ffmpeg executable or use Detect to auto‑find.")
      .addText(text =>
        text
          .setPlaceholder("/opt/homebrew/bin/ffmpeg or C:/ffmpeg/bin/ffmpeg.exe")
          .setValue(this.settings.ffmpegPath)
          .onChange(async (value) => { await this.save({ ffmpegPath: value.trim() }); })
          .inputEl.style.width = "300px"
      );
    ffmpegSetting.addButton((btn) => btn.setButtonText("Detect").onClick(async () => {
      const guess = await this.autoDetectFfmpeg();
      if (guess) { await this.save({ ffmpegPath: guess }); new Notice('FFmpeg detected'); this.display(); }
      else new Notice('No FFmpeg found');
    }));

    // STEP 2: Whisper
    containerEl.createEl("h3", { text: "Whisper" });
    containerEl.createEl("p", { text: "Used to transcribe audio locally." });

    new Setting(containerEl)
    .setName("Installation")
    .setDesc("Manual installation required.")
    .addButton((btn)=> btn.setButtonText("Guide").onClick(()=> new HelpModal(this.app, 'whisper').open()));

    // Campo di testo allargato per il percorso della repo whisper.cpp
    new Setting(containerEl)
      .setName("whisper.cpp repo path")
      .setDesc("Cartella root della repo (es: /path/whisper.cpp)")
      .addText(text => {
        text
          .setPlaceholder(process.platform === 'win32' ? 'C:/whisper.cpp' : '/path/whisper.cpp')
          .setValue(this.settings.whisperRepoPath || '')
          .onChange(async (value) => { await this.save({ whisperRepoPath: value.trim() }); })
          .inputEl.style.width = "300px"
      });

    const whisperSetting = new Setting(containerEl)
      .setName("whisper-cli executable")
      .setDesc("Auto‑resolved from repo, you may need to manually select the correct file.")
      .addText(text =>
        text
          .setPlaceholder(process.platform === 'win32' ? 'C:/whisper/build/bin/whisper-cli.exe' : '/path/whisper.cpp/build/bin/whisper-cli')
          .setValue(this.settings.whisperMainPath)
          .onChange(async (value) => { await this.save({ whisperMainPath: value.trim() }); })
          .inputEl.style.width = "300px"
      );
    whisperSetting.addButton((btn)=> btn.setButtonText("Detect").onClick(async ()=>{
      const cli = await this.findWhisperCliFromRepo(this.settings.whisperRepoPath);
      if (cli) { await this.save({ whisperMainPath: cli }); new Notice('whisper-cli found'); this.display(); }
      else new Notice('whisper-cli not found. Build the repo (cmake/make).');
    }));

    const modelPreset = new Setting(containerEl)
      .setName("Model")
      .setDesc("Choose the model size. It will be downloaded automatically if missing.")
      .addDropdown(drop => {
        drop.addOption('small','small (fast)');
        drop.addOption('medium','medium (balanced)');
        drop.addOption('large','large (quality)');
        drop.setValue(this.settings.whisperModelPreset || 'medium');
        drop.onChange(async (value)=> { await this.save({ whisperModelPreset: value as any }); });
      });
    modelPreset.addButton((btn)=> btn.setButtonText("Download").onClick(async ()=>{
      try {
        const file = await this.downloadModelPreset();
        if (file) { await this.save({ whisperModelPath: file }); new Notice('Model ready: ' + file); this.display(); }
        else new Notice('Model download failed');
      } catch (e: any) { new Notice('Download error: ' + (e?.message ?? e)); }
    }));

    new Setting(containerEl)
      .setName("Whisper model (.bin)")
      .setDesc("Full path to the model.")
      .addText(text =>
        text
          .setPlaceholder(process.platform === 'win32' ? 'C:/whisper/models/ggml-medium.bin' : '/path/whisper.cpp/models/ggml-medium.bin')
          .setValue(this.settings.whisperModelPath)
          .onChange(async (value) => { await this.save({ whisperModelPath: value.trim() }); })
          .inputEl.style.width = "300px"
      );

    new Setting(containerEl)
      .setName("Transcription language")
      .setDesc("Choose expected language or leave Automatic.")
      .addDropdown(drop => {
        const opts: [string, string][] = [
          ['auto','Automatic'],
          ['it','Italiano'],
          ['en','English'],
          ['es','Español'],
          ['fr','Français'],
          ['de','Deutsch'],
          ['pt','Português'],
        ];
        opts.forEach(([v,l])=> drop.addOption(v,l));
        drop.setValue(this.settings.whisperLanguage || 'auto');
        drop.onChange(async (value)=> { await this.save({ whisperLanguage: value }); });
      });

    // STEP 3: LLM (Gemini)
    containerEl.createEl("h3", { text: "LLM" });
    containerEl.createEl("p", { text: "Used to summarize the transcription." });

    new Setting(containerEl)
    .setName("Installation")
    .setDesc("Use your own API key.")
    .addButton((btn)=> btn.setButtonText("Guide").onClick(()=> new HelpModal(this.app, 'llm').open()));
    
    const apiSetting = new Setting(containerEl)
      .setName("Google Gemini API Key")
      .setDesc("Key is stored locally in your vault.")
      .addText(text =>
        text
          .setValue(this.settings.geminiApiKey)
          .onChange(async (value) => { await this.save({ geminiApiKey: value }); })
      );
    apiSetting.settingEl.querySelector("input")?.setAttribute("type", "password");

    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc("Available: 1.5‑pro, 2.5‑flash, 2.5‑pro.")
      .addDropdown(drop => {
        const allowed: string[] = ["gemini-1.5-pro", "gemini-2.5-flash", "gemini-2.5-pro"];
        const labels: Record<string, string> = {
          "gemini-1.5-pro": "gemini-1.5-pro",
          "gemini-2.5-flash": "gemini-2.5-flash",
          "gemini-2.5-pro": "gemini-2.5-pro",
        };
        allowed.forEach(k => drop.addOption(k, labels[k]));
        const current = allowed.includes(this.settings.geminiModel) ? this.settings.geminiModel : "gemini-2.5-pro";
        drop.setValue(current);
        drop.onChange(async (value) => { await this.save({ geminiModel: value }); });
      });

    // STEP 4: Audio devices
    containerEl.createEl("h3", { text: "Audio devices" });
    containerEl.createEl("p", { text: "Select backend and choose devices." });

    new Setting(containerEl)
    .setName("Configuration")
    .addButton((btn)=> btn.setButtonText("Guide").onClick(()=> new HelpModal(this.app, 'devices').open()));

    new Setting(containerEl)
      .setName("FFmpeg backend")
      .setDesc("Automatic picks based on OS, choose manually if needed.")
      .addDropdown(drop => {
        drop.addOption("auto", "Automatic");
        drop.addOption("avfoundation", "avfoundation (macOS)");
        drop.addOption("dshow", "dshow (Windows)");
        drop.addOption("pulse", "pulse (Linux)");
        drop.addOption("alsa", "alsa (Linux)");
        drop.setValue(this.settings.ffmpegInputFormat || "auto");
        drop.onChange(async (value) => { await this.save({ ffmpegInputFormat: value as ResonanceSettings["ffmpegInputFormat"] }); });
      });

    const micSetting = new Setting(containerEl).setName("Microphone").setDesc("Choose from the list after scanning.");
    const micSelect = micSetting.settingEl.createEl("select");
    micSelect.addClass("resonance-inline-select");

    const sysSetting = new Setting(containerEl).setName("System audio").setDesc("Choose after scanning. Leave empty if not available.");
    const sysSelect = sysSetting.settingEl.createEl("select");
    sysSelect.addClass("resonance-inline-select");
    const none = document.createElement('option'); none.value=''; none.text='(none)'; sysSelect.appendChild(none);

    new Setting(containerEl)
      .setName("Device tools")
      .setDesc("Refresh devices and test audio config.")
      .addButton((btn) => btn.setButtonText("Refresh devices").onClick(async () => { await this.performScanAndPopulate(micSelect, sysSelect); }))
      .addButton((btn) => btn.setButtonText("Test audio config").onClick(async () => { await this.quickTestRecording(); }));

    await this.performScanAndPopulate(micSelect, sysSelect).catch(()=>{});
    micSelect.addEventListener('change', async () => {
      const selected = micSelect.options[micSelect.selectedIndex];
      await this.save({ ffmpegMicDevice: selected.value, ffmpegMicLabel: selected.text });
    });
    sysSelect.addEventListener('change', async () => {
      const selected = sysSelect.options[sysSelect.selectedIndex];
      await this.save({ ffmpegSystemDevice: selected.value, ffmpegSystemLabel: selected.text });
    });

    // STEP 5: Obsidian
    containerEl.createEl("h3", { text: "Obsidian" });
    containerEl.createEl("p", { text: "Choose the folder where generated notes will be saved." });

    const obs = new Setting(containerEl)
      .setName("Notes folder")
      .setDesc("Example: Meeting Notes, if empty, root of the vault.")
      .addText(text => text.setPlaceholder("Meeting Notes").setValue(this.settings.outputFolder).onChange(async (value) => { await this.save({ outputFolder: value.trim() }); }));

    // STEP 6: Recording
    containerEl.createEl("h3", { text: "Recording" });

    new Setting(containerEl)
      .setName("Sample rate (Hz)")
      .setDesc("Typical: 44100 or 48000")
      .addText((text) =>
        text
          .setPlaceholder("48000")
          .setValue(String(this.settings.recordSampleRateHz || 48000))
          .onChange(async (value) => {
            const v = Math.max(8000, Math.min(192000, Math.floor(Number(value || 48000))));
            await this.save({ recordSampleRateHz: v });
          })
      );

    new Setting(containerEl)
      .setName("Channels")
      .setDesc("1 = mono, 2 = stereo")
      .addDropdown((drop) => {
        drop.addOption("1", "Mono (1)");
        drop.addOption("2", "Stereo (2)");
        const ch = (this.settings.recordChannels || 1);
        drop.setValue(String(ch === 2 ? 2 : 1));
        drop.onChange(async (value) => { await this.save({ recordChannels: Number(value) }); });
      });

    new Setting(containerEl)
      .setName("Bitrate (kbps)")
      .setDesc("MP3 bitrate. Typical: 160 – 256")
      .addText((text) =>
        text
          .setPlaceholder("192")
          .setValue(String(this.settings.recordBitrateKbps || 192))
          .onChange(async (value) => {
            const v = Math.max(64, Math.min(512, Math.floor(Number(value || 192))));
            await this.save({ recordBitrateKbps: v });
          })
      );
    new Setting(containerEl)
      .setName("Max recordings kept")
      .setDesc("0 = infinite, older ones will be deleted automatically.")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.settings.maxRecordingsKept ?? 5))
          .onChange(async (value) => {
            const v = Math.max(0, Math.floor(Number(value || 0)));
            await this.save({ maxRecordingsKept: v });
          })
      );
    new Setting(containerEl)
      .setName("Open Library")
      .setDesc("See recordings list and actions")
      .addButton((btn)=> btn.setButtonText("Open").onClick(()=>{
        try {
          new LibraryModal(this.app, this.pluginId).open();
        } catch (e: any) { new Notice(`Failed to open Library: ${e?.message ?? e}`); }
      }));
  }

  private resolveBackend(): 'dshow' | 'avfoundation' | 'pulse' | 'alsa' {
    if (this.settings.ffmpegInputFormat !== 'auto') return this.settings.ffmpegInputFormat as any;
    if (process.platform === 'win32') return 'dshow';
    if (process.platform === 'darwin') return 'avfoundation';
    return 'pulse';
  }

  private async performScanAndPopulate(micSelect: HTMLSelectElement, sysSelect: HTMLSelectElement) {
    if (!this.settings.ffmpegPath) return;
    const backend = this.resolveBackend();
    this.lastScan = await scanDevices(this.settings.ffmpegPath, backend);

    micSelect.empty();
    while (sysSelect.options.length > 1) sysSelect.remove(1);

    const audioDevices = this.lastScan.filter(d => d.type !== 'video');

    const isSystemCandidate = (label: string): boolean => {
      if (backend !== 'dshow') return true; // su mac/linux non distinguiamo
      return /(stereo\s*mix|virtual-?audio-?capturer|vb[- ]?audio|voice\s*meeter|voicemeeter|cable\s*output|loopback)/i.test(label);
    };

    const micDevices = audioDevices.filter(d => !isSystemCandidate(d.label));
    const sysDevices = audioDevices.filter(d => isSystemCandidate(d.label));

    (micDevices.length ? micDevices : audioDevices).forEach(d => {
      const o1 = document.createElement('option'); o1.value = d.name; o1.text = d.label; micSelect.appendChild(o1);
    });
    sysDevices.forEach(d => {
      const o2 = document.createElement('option'); o2.value = d.name; o2.text = d.label; sysSelect.appendChild(o2);
    });

    const availableMicValues = new Set(Array.from(micSelect.options).map(o => o.value));
    // Prova remap per avfoundation: se label salvata esiste, riassegna nuovo indice dinamico
    const currentMicLabel = (this.settings.ffmpegMicLabel || '').replace(/^\d+:\s*/, '');
    if (this.settings.ffmpegInputFormat === 'avfoundation' && currentMicLabel) {
      const candidate = Array.from(micSelect.options).find(o => o.text.replace(/^\d+:\s*/, '') === currentMicLabel);
      if (candidate) {
        micSelect.value = candidate.value;
        await this.save({ ffmpegMicDevice: candidate.value });
      }
    }
    if (!micSelect.value && micSelect.options.length > 0) {
      micSelect.selectedIndex = 0;
      await this.save({ ffmpegMicDevice: micSelect.value, ffmpegMicLabel: micSelect.options[micSelect.selectedIndex].text });
      new Notice(`Microphone auto-selected: ${micSelect.options[micSelect.selectedIndex].text}`);
    }

    const availableSysValues = new Set(Array.from(sysSelect.options).map(o => o.value));
    if (this.settings.ffmpegSystemDevice && availableSysValues.has(this.settings.ffmpegSystemDevice)) {
      sysSelect.value = this.settings.ffmpegSystemDevice;
    }
    const currentSysLabel = (this.settings.ffmpegSystemLabel || '').replace(/^\d+:\s*/, '');
    if (this.settings.ffmpegInputFormat === 'avfoundation' && currentSysLabel) {
      const candidate2 = Array.from(sysSelect.options).find(o => o.text.replace(/^\d+:\s*/, '') === currentSysLabel);
      if (candidate2) {
        sysSelect.value = candidate2.value;
        await this.save({ ffmpegSystemDevice: candidate2.value });
      }
    }
  }

  async autoDetectFfmpeg(): Promise<string | null> {
    try {
      const { spawn } = (window as any).require('child_process');
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const found = await new Promise<string | null>((resolve) => {
        const child = spawn(cmd, ['ffmpeg']);
        let out = '';
        child.stdout?.on('data', (d: Buffer) => out += d.toString());
        child.on('close', () => { const line = out.split(/\r?\n/).map(s=>s.trim()).find(Boolean); resolve(line || null); });
        child.on('error', () => resolve(null));
      });
      if (found) return found;
    } catch {}
    try {
      const fs = (window as any).require('fs');
      const candidates = process.platform === 'win32' ? ['C:/ffmpeg/bin/ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe'] : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
      for (const c of candidates) { if (fs.existsSync(c)) return c; }
    } catch {}
    return null;
  }

  private async findWhisperCliFromRepo(repoPath: string): Promise<string | null> {
    try {
      if (!repoPath) return null;
      const path = (window as any).require('path');
      const fs = (window as any).require('fs');
      const isExe = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();
      const candidates = [
        ['build','bin','whisper-cli'],
        ['build','bin','whisper-cli.exe'],
        ['build','bin','Release','whisper-cli'],
        ['build','bin','Release','whisper-cli.exe'],
        ['main'],
        ['main.exe'],
      ].map(parts => path.join(repoPath, ...parts));
      for (const c of candidates) if (isExe(c)) return c;
      // ricerca ricorsiva shallow (max 3 livelli) per file che contengono 'whisper-cli'
      const maxDepth = 3;
      const found = this.walkFind(repoPath, (p)=>/whisper-cli(\.exe)?$/i.test(p), maxDepth);
      if (found) return found;
    } catch {}
    return null;
  }

  private walkFind(root: string, match: (p:string)=>boolean, depth: number): string | null {
    try {
      const fs = (window as any).require('fs');
      const path = (window as any).require('path');
      if (depth < 0) return null;
      const items = fs.readdirSync(root);
      for (const name of items) {
        const full = path.join(root, name);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile() && match(full)) return full;
          if (stat.isDirectory()) {
            const r = this.walkFind(full, match, depth - 1);
            if (r) return r;
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  private async downloadModelPreset(): Promise<string | null> {
    const preset = this.settings.whisperModelPreset || 'medium';
    const url = preset === 'small'
      ? 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
      : preset === 'large'
      ? 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large.bin'
      : 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin';

    const path = (window as any).require('path');
    const fs = (window as any).require('fs');
    const https = (window as any).require('https');

    const repo = this.settings.whisperRepoPath?.trim();
    const modelsDir = repo ? path.join(repo, 'models') : (this.settings.whisperModelPath ? path.dirname(this.settings.whisperModelPath) : '');
    if (!modelsDir) throw new Error('Set the repo folder first or provide a model path');
    try { fs.mkdirSync(modelsDir, { recursive: true }); } catch {}

    const outFile = path.join(modelsDir, url.split('/').pop());

    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(outFile);
      https.get(url, (res: any) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, (res2: any) => res2.pipe(file).on('finish', resolve)).on('error', reject);
        } else if (res.statusCode === 200) {
          res.pipe(file).on('finish', resolve);
        } else {
          reject(new Error('HTTP ' + res.statusCode));
        }
      }).on('error', reject);
    });

    return outFile;
  }

  private async quickTestRecording() {
    const ffmpeg = this.settings.ffmpegPath.trim();
    if (!ffmpeg) { new Notice('Set FFmpeg first'); return; }
    const backend = this.resolveBackend();
    const mic = this.settings.ffmpegMicDevice.trim();
    if (!mic) { new Notice('Select a microphone'); return; }

    const { spawn } = (window as any).require('child_process');
    const os = (window as any).require('os');
    const path = (window as any).require('path');
    const fs = (window as any).require('fs');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonance-test-'));
    const out = path.join(tmpDir, 'test.mp3');

    const normalize = (b: string, v: string) => b === 'dshow' && !/^(audio=|video=|@device_)/i.test(v) ? `audio=${v}` : v;
    const micArg = normalize(backend, mic);
    const sr = Math.max(8000, Number(this.settings.recordSampleRateHz || 48000));
    const ch = Math.max(1, Math.min(2, Number(this.settings.recordChannels || 1)));
    const br = Math.max(64, Number(this.settings.recordBitrateKbps || 160));
    const args: string[] = ['-y', '-f', backend, '-i', micArg, '-t', '1', '-ar', String(sr), '-ac', String(ch), '-acodec', 'libmp3lame', '-ab', `${br}k`, out];
    const child = spawn(ffmpeg, args);

    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code: number) => {
      if (code === 0) new Notice('Test passed!');
      else {
        const hint = stderr.split(/\r?\n/).slice(-6).join('\n');
        new Notice(`Test failed (code ${code}).\n${hint}`);
      }
      try { fs.unlinkSync(out); fs.rmdirSync(tmpDir); } catch {}
    });
    child.on('error', (e: any) => {
      new Notice(`FFmpeg test error: ${e?.message ?? e}`);
      try { fs.rmdirSync(tmpDir); } catch {}
    });
  }
}
