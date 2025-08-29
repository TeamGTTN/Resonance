import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { scanDevices, ListedDevice } from "./DeviceScanner";
import { HelpModal } from "./HelpModal";

export interface ResonanceSettings {
  geminiApiKey: string;
  geminiModel: string;
  ffmpegPath: string;
  ffmpegInputFormat: "auto" | "avfoundation" | "dshow" | "pulse" | "alsa";
  ffmpegMicDevice: string;
  ffmpegSystemDevice: string;
  whisperRepoPath: string; // nuovo: path root repo whisper.cpp
  whisperMainPath: string; // whisper-cli risolto automaticamente dal repo
  whisperModelPath: string;
  whisperModelPreset: "small" | "medium" | "large"; // scelte rapide
  whisperLanguage: string; // iso code or 'auto'
  outputFolder: string;
}

export const DEFAULT_SETTINGS: ResonanceSettings = {
  geminiApiKey: "",
  geminiModel: "gemini-1.5-pro",
  ffmpegPath: "",
  ffmpegInputFormat: "auto",
  ffmpegMicDevice: "",
  ffmpegSystemDevice: "",
  whisperRepoPath: "",
  whisperMainPath: "",
  whisperModelPath: "",
  whisperModelPreset: "medium",
  whisperLanguage: "auto",
  outputFolder: "",
};

export class ResonanceSettingTab extends PluginSettingTab {
  private settings: ResonanceSettings;
  private save: (settings: Partial<ResonanceSettings>) => Promise<void>;
  private lastScan: ListedDevice[] = [];

  constructor(app: App, settings: ResonanceSettings, save: (settings: Partial<ResonanceSettings>) => Promise<void>) {
    super(app, (app as any).plugins.getPlugin("resonance"));
    this.settings = settings;
    this.save = save;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Resonance – Impostazioni" });

    // STEP 1: FFmpeg
    containerEl.createEl("h3", { text: "1) FFmpeg" });
    containerEl.createEl("p", { text: "FFmpeg è l'utility che useremo per registrare l'audio. Installazione consigliata: macOS con Homebrew (brew install ffmpeg); Windows scarica la build statica da ffmpeg.org e punta a ffmpeg.exe; Linux usa il gestore pacchetti (apt/yum/pacman)." });

    const ffmpegSetting = new Setting(containerEl)
      .setName("Percorso FFmpeg")
      .setDesc("Scegli il percorso all'eseguibile ffmpeg e verifica con Rileva.")
      .addText(text =>
        text
          .setPlaceholder("/opt/homebrew/bin/ffmpeg o C:/ffmpeg/bin/ffmpeg.exe")
          .setValue(this.settings.ffmpegPath)
          .onChange(async (value) => { await this.save({ ffmpegPath: value.trim() }); })
      );
    ffmpegSetting.addButton((btn) => btn.setButtonText("Rileva").onClick(async () => {
      const guess = await this.autoDetectFfmpeg();
      if (guess) { await this.save({ ffmpegPath: guess }); new Notice('FFmpeg rilevato'); this.display(); }
      else new Notice('Nessun FFmpeg rilevato');
    }));
    ffmpegSetting.addButton((btn)=> btn.setButtonText("Guida").onClick(()=> new HelpModal(this.app, 'ffmpeg').open()));

    // STEP 2: Whisper
    containerEl.createEl("h3", { text: "2) Whisper (trascrizione locale)" });
    containerEl.createEl("p", { text: "Indica la cartella del repository whisper.cpp. Troveremo automaticamente l'eseguibile whisper-cli. Poi scegli un modello (small/medium/large) e scarichiamolo nella cartella models/ del repo." });

    const repoSetting = new Setting(containerEl)
      .setName("Percorso repo whisper.cpp")
      .setDesc("Cartella root del repo (es: /path/whisper.cpp)")
      .addText(text =>
        text
          .setPlaceholder(process.platform === 'win32' ? 'C:/whisper.cpp' : '/path/whisper.cpp')
          .setValue(this.settings.whisperRepoPath || '')
          .onChange(async (value) => { await this.save({ whisperRepoPath: value.trim() }); })
      );
    repoSetting.addButton((btn)=> btn.setButtonText("Guida").onClick(()=> new HelpModal(this.app, 'whisper').open()));

    const whisperSetting = new Setting(containerEl)
      .setName("Eseguibile whisper-cli")
      .setDesc("Risolto automaticamente dalla cartella repo; puoi modificarlo se necessario.")
      .addText(text =>
        text
          .setPlaceholder(process.platform === 'win32' ? 'C:/whisper/build/bin/whisper-cli.exe' : '/path/whisper.cpp/build/bin/whisper-cli')
          .setValue(this.settings.whisperMainPath)
          .onChange(async (value) => { await this.save({ whisperMainPath: value.trim() }); })
      );
    whisperSetting.addButton((btn)=> btn.setButtonText("Trova dal repo").onClick(async ()=>{
      const cli = await this.findWhisperCliFromRepo(this.settings.whisperRepoPath);
      if (cli) { await this.save({ whisperMainPath: cli }); new Notice('whisper-cli trovato'); this.display(); }
      else new Notice('whisper-cli non trovato. Compila il repo (cmake/make).');
    }));

    const modelPreset = new Setting(containerEl)
      .setName("Modello (preset)")
      .setDesc("Scegli la dimensione del modello. Verrà scaricato in whisper.cpp/models se non presente.")
      .addDropdown(drop => {
        drop.addOption('small','small (veloce)');
        drop.addOption('medium','medium (bilanciato)');
        drop.addOption('large','large (qualità)');
        drop.setValue(this.settings.whisperModelPreset || 'medium');
        drop.onChange(async (value)=> { await this.save({ whisperModelPreset: value as any }); });
      });
    modelPreset.addButton((btn)=> btn.setButtonText("Scarica modello").onClick(async ()=>{
      try {
        const file = await this.downloadModelPreset();
        if (file) { await this.save({ whisperModelPath: file }); new Notice('Modello pronto: ' + file); this.display(); }
        else new Notice('Download modello non riuscito');
      } catch (e: any) { new Notice('Errore download: ' + (e?.message ?? e)); }
    }));

    new Setting(containerEl)
      .setName("Modello Whisper (.bin)")
      .setDesc("Percorso completo del modello. Se hai usato 'Scarica modello' è gia impostato.")
      .addText(text =>
        text
          .setPlaceholder(process.platform === 'win32' ? 'C:/whisper/models/ggml-medium.bin' : '/path/whisper.cpp/models/ggml-medium.bin')
          .setValue(this.settings.whisperModelPath)
          .onChange(async (value) => { await this.save({ whisperModelPath: value.trim() }); })
      );

    new Setting(containerEl)
      .setName("Lingua trascrizione")
      .setDesc("Scegli la lingua attesa nella registrazione oppure lascia Automatico.")
      .addDropdown(drop => {
        const opts: [string, string][] = [
          ['auto','Automatico'],
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
    containerEl.createEl("h3", { text: "3) LLM (riassunto)" });
    containerEl.createEl("p", { text: "Per generare il riassunto usiamo l'API di Google Gemini. Crea una API Key nella console Google AI Studio e incollala qui. Puoi scegliere il modello da usare." });

    const apiSetting = new Setting(containerEl)
      .setName("Google Gemini API Key")
      .setDesc("La chiave resta memorizzata localmente nel vault.")
      .addText(text =>
        text
          .setPlaceholder("gai-...")
          .setValue(this.settings.geminiApiKey)
          .onChange(async (value) => { await this.save({ geminiApiKey: value }); })
      );
    apiSetting.settingEl.querySelector("input")?.setAttribute("type", "password");
    apiSetting.addButton((btn)=> btn.setButtonText("Guida").onClick(()=> new HelpModal(this.app, 'llm').open()));

    new Setting(containerEl)
      .setName("Modello Gemini")
      .setDesc("Scegli il modello: flash (più veloce), pro (migliore qualità), exp (sperimentale).")
      .addDropdown(drop => {
        const options: Record<string, string> = {
          "gemini-1.5-flash": "gemini-1.5-flash",
          "gemini-1.5-pro": "gemini-1.5-pro",
          "gemini-1.5-pro-exp": "gemini-1.5-pro-exp",
        };
        Object.entries(options).forEach(([value, label]) => drop.addOption(value, label));
        drop.setValue(this.settings.geminiModel || "gemini-1.5-pro");
        drop.onChange(async (value) => { await this.save({ geminiModel: value }); });
      });

    // STEP 4: Dispositivi audio
    containerEl.createEl("h3", { text: "4) Dispositivi audio" });
    containerEl.createEl("p", { text: "Seleziona il backend e scegli i dispositivi dall'elenco. Usa Scansiona per popolare automaticamente. Non è necessario scrivere nulla a mano." });

    const backendSetting = new Setting(containerEl)
      .setName("Backend FFmpeg")
      .setDesc("Automatico prova a scegliere in base al sistema. In caso di problemi seleziona manualmente.")
      .addDropdown(drop => {
        drop.addOption("auto", "Automatico");
        drop.addOption("avfoundation", "avfoundation (macOS)");
        drop.addOption("dshow", "dshow (Windows)");
        drop.addOption("pulse", "pulse (Linux)");
        drop.addOption("alsa", "alsa (Linux)");
        drop.setValue(this.settings.ffmpegInputFormat || "auto");
        drop.onChange(async (value) => { await this.save({ ffmpegInputFormat: value as ResonanceSettings["ffmpegInputFormat"] }); });
      });
    backendSetting.addButton((btn)=> btn.setButtonText("Guida").onClick(()=> new HelpModal(this.app, 'devices').open()));

    const micSetting = new Setting(containerEl).setName("Microfono").setDesc("Scegli dall'elenco dopo la scansione.");
    const micSelect = micSetting.settingEl.createEl("select");
    micSelect.addClass("resonance-inline-select");

    const sysSetting = new Setting(containerEl).setName("Audio di sistema (opzionale)").setDesc("Scegli dall'elenco dopo la scansione. Se non disponibile lascia vuoto.");
    const sysSelect = sysSetting.settingEl.createEl("select");
    sysSelect.addClass("resonance-inline-select");
    const none = document.createElement('option'); none.value=''; none.text='(nessuno)'; sysSelect.appendChild(none);

    new Setting(containerEl)
      .setName("Strumenti dispositivi")
      .setDesc("Scansiona e poi seleziona i dispositivi.")
      .addButton((btn) => btn.setButtonText("Scansiona").onClick(async () => { await this.performScanAndPopulate(micSelect, sysSelect); }))
      .addButton((btn) => btn.setButtonText("Test rapido 3s").onClick(async () => { await this.quickTestRecording(); }));

    await this.performScanAndPopulate(micSelect, sysSelect).catch(()=>{});
    micSelect.addEventListener('change', async () => { await this.save({ ffmpegMicDevice: micSelect.value }); });
    sysSelect.addEventListener('change', async () => { await this.save({ ffmpegSystemDevice: sysSelect.value }); });

    // STEP 5: Obsidian
    containerEl.createEl("h3", { text: "5) Obsidian" });
    containerEl.createEl("p", { text: "Scegli la cartella del tuo vault in cui salvare le note generate. Se lasci vuoto, verranno create nella root." });

    const obs = new Setting(containerEl)
      .setName("Cartella per le note")
      .setDesc("Esempio: Meeting Notes")
      .addText(text => text.setPlaceholder("Meeting Notes").setValue(this.settings.outputFolder).onChange(async (value) => { await this.save({ outputFolder: value.trim() }); }));
    obs.addButton((btn)=> btn.setButtonText("Guida").onClick(()=> new HelpModal(this.app, 'obsidian').open()));
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
    audioDevices.forEach(d => {
      const o1 = document.createElement('option'); o1.value = d.name; o1.text = d.label; micSelect.appendChild(o1);
      const o2 = document.createElement('option'); o2.value = d.name; o2.text = d.label; sysSelect.appendChild(o2);
    });

    const availableMicValues = new Set(Array.from(micSelect.options).map(o => o.value));
    if (this.settings.ffmpegMicDevice && availableMicValues.has(this.settings.ffmpegMicDevice)) {
      micSelect.value = this.settings.ffmpegMicDevice;
    } else if (micSelect.options.length > 0) {
      micSelect.selectedIndex = 0;
      await this.save({ ffmpegMicDevice: micSelect.value });
      new Notice(`Microfono impostato automaticamente su: ${micSelect.options[micSelect.selectedIndex].text}`);
    }

    const availableSysValues = new Set(Array.from(sysSelect.options).map(o => o.value));
    if (this.settings.ffmpegSystemDevice && availableSysValues.has(this.settings.ffmpegSystemDevice)) {
      sysSelect.value = this.settings.ffmpegSystemDevice;
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
    if (!modelsDir) throw new Error('Imposta prima la cartella repo o un percorso modello');
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
    if (!ffmpeg) { new Notice('Imposta prima FFmpeg'); return; }
    const backend = this.resolveBackend();
    const mic = this.settings.ffmpegMicDevice.trim();
    if (!mic) { new Notice('Seleziona un microfono'); return; }

    const { spawn } = (window as any).require('child_process');
    const os = (window as any).require('os');
    const path = (window as any).require('path');
    const fs = (window as any).require('fs');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonance-test-'));
    const out = path.join(tmpDir, 'test.mp3');

    const args: string[] = ['-y', '-f', backend, '-i', mic, '-t', '3', '-acodec', 'libmp3lame', '-ab', '128k', out];
    const child = spawn(ffmpeg, args);

    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code: number) => {
      if (code === 0) new Notice('Test completato: registrazione di 3s creata');
      else {
        const hint = stderr.split(/\r?\n/).slice(-6).join('\n');
        new Notice(`Test fallito (codice ${code}).\n${hint}`);
      }
      try { fs.unlinkSync(out); fs.rmdirSync(tmpDir); } catch {}
    });
    child.on('error', (e: any) => {
      new Notice(`Errore test FFmpeg: ${e?.message ?? e}`);
      try { fs.rmdirSync(tmpDir); } catch {}
    });
  }
}
