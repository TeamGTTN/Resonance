import { App, Modal, Notice, TFile } from "obsidian";

// This module provides a modal for displaying the recordings library.

interface LibraryItem {
  baseName: string; // without extension, e.g., recording_2025-01-01_12-00-00
  audioPath: string;
  transcriptPath: string;
  logPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export class LibraryModal extends Modal {
  private pluginId: string;
  private listEl!: HTMLElement;
  private items: LibraryItem[] = [];
  private toolbarEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private busy: boolean = false;
  private fromDate: string = ""; // YYYY-MM-DD
  private toDate: string = "";   // YYYY-MM-DD
  private sortMode: "date-desc" | "date-asc" | "size-desc" | "size-asc" | "name-asc" | "name-desc" = "date-desc";
  private selected: Set<string> = new Set();
  private selectAllCb: HTMLInputElement | null = null;
  private visibleItems: LibraryItem[] = [];
  private deleteBtn: HTMLButtonElement | null = null;

  constructor(app: App, pluginId: string) {
    super(app);
    this.pluginId = pluginId;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("resonance-modal");
    this.modalEl.addClass("resonance-wide");
    contentEl.createEl("h2", { text: "Recordings Library" });
    const hint = contentEl.createEl("p", { text: "Review, listen, download or delete your recordings." });
    hint.style.marginTop = "0";

    this.statusEl = contentEl.createEl("div", { cls: "resonance-status" });
    this.statusEl.setText("");

    this.toolbarEl = contentEl.createEl("div", { cls: "resonance-toolbar" });
    this.buildToolbar();

    this.listEl = contentEl.createEl("div", { cls: "resonance-list" });
    void this.refresh();
  }

  private getRecordingsDir(): string {
    const path = (window as any).require("path");
    const adapter = (this.app.vault as any).adapter;
    const basePath: string = adapter?.getBasePath?.() ?? adapter?.basePath ?? "";
    const configDir: string = (this.app.vault as any).configDir ?? ".obsidian";
    return path.join(basePath, configDir, "plugins", this.pluginId, "recordings");
  }

  private async scan(): Promise<LibraryItem[]> {
    const fs = (window as any).require("fs");
    const path = (window as any).require("path");
    const root = this.getRecordingsDir();
    try { if (!fs.existsSync(root)) return []; } catch { return []; }

    const items: LibraryItem[] = [];

    const walk = (dir: string) => {
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir) ?? []; } catch { return; }
      for (const name of entries) {
        const full = path.join(dir, name);
        let st: any; try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          walk(full);
        } else if (/\.mp3$/i.test(name)) {
          const base = name.replace(/\.mp3$/i, "");
          const transcriptPath = path.join(dir, `${base}.txt`);
          const logPath = path.join(dir, `${base}.log`);
          items.push({
            baseName: base,
            audioPath: full,
            transcriptPath,
            logPath,
            mtimeMs: st.mtimeMs || st.ctimeMs || 0,
            sizeBytes: st.size || 0,
          });
        }
      }
    };
    walk(root);
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return items;
  }

  private buildToolbar() {
    this.toolbarEl.empty();

    const fromWrap = this.toolbarEl.createEl("div", { cls: "date" });
    const fromLbl = fromWrap.createEl("label", { text: "From" }); fromLbl.style.marginRight = "6px";
    const from = fromWrap.createEl("input", { type: "date" }) as HTMLInputElement;
    from.value = this.fromDate;
    from.addEventListener("change", () => { this.fromDate = from.value || ""; this.render(); });

    const toWrap = this.toolbarEl.createEl("div", { cls: "date" });
    const toLbl = toWrap.createEl("label", { text: "To" }); toLbl.style.marginRight = "6px";
    const to = toWrap.createEl("input", { type: "date" }) as HTMLInputElement;
    to.value = this.toDate;
    to.addEventListener("change", () => { this.toDate = to.value || ""; this.render(); });

    const sort = this.toolbarEl.createEl("select");
    const addOpt = (v: typeof this.sortMode, l: string) => { const o = document.createElement('option'); o.value=v; o.text=l; sort.appendChild(o); };
    addOpt("date-desc", "Newest first");
    addOpt("date-asc", "Oldest first");
    addOpt("size-desc", "Size: large → small");
    addOpt("size-asc", "Size: small → large");
    addOpt("name-asc", "Name A→Z");
    addOpt("name-desc", "Name Z→A");
    sort.value = this.sortMode;
    sort.addEventListener("change", () => { this.sortMode = sort.value as any; this.render(); });

    const selAllWrap = this.toolbarEl.createEl("label");
    const selAll = selAllWrap.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    this.selectAllCb = selAll;
    selAll.addEventListener("change", () => this.toggleSelectAll(selAll.checked));
    selAllWrap.appendText(" Select all");

    const spacer = this.toolbarEl.createEl("div", { cls: "spacer" });

    const delSel = this.toolbarEl.createEl("button", { cls: "resonance-btn danger" });
    this.deleteBtn = delSel;
    delSel.addEventListener("click", () => this.deleteSelected());
    delSel.disabled = this.selected.size === 0;

    delSel.appendChild(createIcon('trash'));
    delSel.appendText(' Delete selected');

    const refreshBtn = this.toolbarEl.createEl("button", { cls: "resonance-btn secondary" });
    refreshBtn.appendChild(createIcon('refresh'));
    refreshBtn.appendText(' Refresh');
    refreshBtn.addEventListener("click", () => this.refresh());
  }

  private updateToolbarSelectionState() {
    const btns = Array.from(this.toolbarEl.querySelectorAll('button')) as HTMLButtonElement[];
    const del = btns.find(b => b.innerText.trim().toLowerCase() === 'delete selected');
    if (this.deleteBtn) this.deleteBtn.disabled = this.selected.size === 0;
    this.updateSelectAllState();
  }

  private updateSelectAllState() {
    if (!this.selectAllCb) return;
    if (this.visibleItems.length === 0) { this.selectAllCb.indeterminate = false; this.selectAllCb.checked = false; return; }
    const visiblePaths = new Set(this.visibleItems.map(it => it.audioPath));
    let checkedCount = 0;
    for (const p of visiblePaths) if (this.selected.has(p)) checkedCount++;
    if (checkedCount === 0) { this.selectAllCb.indeterminate = false; this.selectAllCb.checked = false; }
    else if (checkedCount === visiblePaths.size) { this.selectAllCb.indeterminate = false; this.selectAllCb.checked = true; }
    else { this.selectAllCb.indeterminate = true; }
  }

  private toggleSelectAll(checked: boolean) {
    const paths = this.visibleItems.map(it => it.audioPath);
    if (checked) paths.forEach(p => this.selected.add(p)); else paths.forEach(p => this.selected.delete(p));
    // Non ricreare tutta la lista per non perdere stato; aggiorna checkbox visibili e toolbar
    const checkboxes = Array.from(this.listEl.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const pathByRow: string[] = this.visibleItems.map(it => it.audioPath);
    for (let i = 0, j = 0; i < checkboxes.length && j < pathByRow.length; i++) {
      const cb = checkboxes[i];
      // Solo i checkbox delle righe (salta eventuali altri input)
      if (cb.type === 'checkbox') { cb.checked = this.selected.has(pathByRow[j++]); }
    }
    this.updateToolbarSelectionState();
  }

  private async deleteSelected() {
    if (this.selected.size === 0) return;
    const ok = confirm(`Delete ${this.selected.size} selected item(s)?`);
    if (!ok) return;
    const fs = (window as any).require("fs");
    const path = (window as any).require("path");
    try {
      for (const audioPath of Array.from(this.selected)) {
        try {
          const dir = path.dirname(audioPath);
          const base = path.basename(audioPath).replace(/\.mp3$/i, "");
          const txt = path.join(dir, `${base}.txt`);
          const log = path.join(dir, `${base}.log`);
          try { fs.unlinkSync(audioPath); } catch {}
          try { fs.unlinkSync(txt); } catch {}
          try { fs.unlinkSync(log); } catch {}
        } catch {}
      }
      new Notice("Selected items deleted");
    } finally {
      this.selected.clear();
      await this.refresh();
      this.updateToolbarSelectionState();
    }
  }
  private async refresh() {
    this.items = await this.scan();
    this.render();
  }

  private render() {
    this.listEl.empty();
    const filtered = this.items.filter(it => {
      if (this.fromDate) {
        const ts = new Date(this.fromDate + 'T00:00:00').getTime();
        if (it.mtimeMs < ts) return false;
      }
      if (this.toDate) {
        const ts2 = new Date(this.toDate + 'T23:59:59').getTime();
        if (it.mtimeMs > ts2) return false;
      }
      return true;
    });

    const items = filtered.sort((a,b)=>{
      switch (this.sortMode) {
        case "date-asc": return a.mtimeMs - b.mtimeMs;
        case "size-desc": return b.sizeBytes - a.sizeBytes;
        case "size-asc": return a.sizeBytes - b.sizeBytes;
        case "name-asc": return a.baseName.localeCompare(b.baseName);
        case "name-desc": return b.baseName.localeCompare(a.baseName);
        default: return b.mtimeMs - a.mtimeMs; // date-desc
      }
    });
    this.visibleItems = items;

    if (items.length === 0) {
      this.listEl.createEl("p", { text: "No recordings found." });
      return;
    }
    for (const it of items) this.renderItem(it);
    this.updateSelectAllState();
  }

  private renderItem(it: LibraryItem) {
    const row = this.listEl.createEl("div", { cls: "resonance-item" });
    const meta = row.createEl("div", { cls: "resonance-meta" });
    const date = new Date(it.mtimeMs);
    const left = meta.createEl("div", { cls: "resonance-left" });
    const cb = left.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    cb.addEventListener("change", () => {
      if (cb.checked) this.selected.add(it.audioPath); else this.selected.delete(it.audioPath);
      this.updateToolbarSelectionState();
    });
    cb.checked = this.selected.has(it.audioPath);

    const titleText = date.toLocaleString();
    const title = left.createEl("div", { cls: "resonance-title", text: titleText });
    title.setAttr("title", it.baseName);
    left.createEl("div", { cls: "resonance-sub", text: `${(it.sizeBytes/1024/1024).toFixed(2)} MB` });

    // Pulsanti: Listen + More (menu a tendina)
    const actions = row.createEl("div", { cls: "resonance-actions" });
    const playBtn = actions.createEl("button", { cls: "resonance-btn secondary" }); 
    playBtn.appendChild(createIcon('play')); 
    playBtn.appendText(' Listen');
    
    const moreBtn = actions.createEl("button", { cls: "resonance-btn secondary" }); 
    moreBtn.appendChild(createIcon('menu')); 
    moreBtn.appendText(' More');

    const audioWrap = this.listEl.createEl("div", { cls: "resonance-audio-wrap" });
    audioWrap.hide();

    playBtn.addEventListener("click", async () => {
      if (!audioWrap.isShown()) {
        audioWrap.empty();
        const el = await this.createAudioElement(it.audioPath);
        if (el) audioWrap.appendChild(el);
        audioWrap.show();
      } else {
        audioWrap.hide();
      }
    });

    // Menu dropdown per "More"
    moreBtn.addEventListener("click", async (ev) => {
      if (this.busy) { new Notice('Another operation is in progress…'); return; }
      ev.stopPropagation();
      document.querySelectorAll('.resonance-menu').forEach(m => m.remove());
      const menu = document.createElement('div');
      menu.className = 'resonance-menu';
      const addEntry = (label: string, icon: IconName, onClick: () => void) => {
        const item = document.createElement('button');
        item.className = 'resonance-menu-item';
        item.appendChild(createIcon(icon));
        item.appendChild(document.createTextNode(` ${label}`));
        item.addEventListener('click', () => { menu.remove(); try { onClick(); } catch (e: any) { new Notice(`Error: ${e?.message ?? e}`); } });
        menu.appendChild(item);
      };

      addEntry('Open transcript', 'file-text', async () => {
        const text = await this.readTextSafe(it.transcriptPath);
        if (!text) { new Notice('Transcript not found'); return; }
        new TextPreviewModal(this.app, `${it.baseName} – Transcript`, text).open();
      });
      addEntry('Open log', 'file-text', async () => {
        const text = await this.readTextSafe(it.logPath);
        if (!text) { new Notice('Log not found'); return; }
        new TextPreviewModal(this.app, `${it.baseName} – Log`, text).open();
      });

      // Apri nota se disponibile
      const notePath = await this.findNoteFromLog(it.logPath);
      if (notePath) {
        addEntry('Open note', 'note', async () => {
          try {
            const file = this.app.vault.getAbstractFileByPath(notePath);
            if (file && (file as any).extension === 'md') {
              const leaf = this.app.workspace.getLeaf(true);
              await leaf.openFile(file as TFile);
            } else {
              new Notice('Note not found in vault');
            }
          } catch { new Notice('Failed to open note'); }
        });
      }

      const divider = document.createElement('div');
      divider.style.height = '1px'; divider.style.background = 'var(--background-modifier-border)'; divider.style.margin = '8px 6px';
      menu.appendChild(divider);

      addEntry('Show in folder', 'folder', () => { try { const electron = (window as any).require('electron'); electron?.shell?.showItemInFolder?.(it.audioPath); } catch {} });

      const divider2 = document.createElement('div');
      divider2.style.height = '1px'; divider2.style.background = 'var(--background-modifier-border)'; divider2.style.margin = '8px 6px';
      menu.appendChild(divider2);

      addEntry('Regenerate summary', 'refresh', async () => { await this.regenerateSummary(it); });
      addEntry('Delete', 'trash', async () => {
        const ok = confirm('Delete this recording and related files?');
        if (!ok) return;
        const fs = (window as any).require('fs');
        try { fs.unlinkSync(it.audioPath); try { fs.unlinkSync(it.transcriptPath); } catch {} try { fs.unlinkSync(it.logPath); } catch {} new Notice('Deleted'); }
        catch (e: any) { new Notice(`Delete error: ${e?.message ?? e}`); }
        await this.refresh();
      });

      document.body.appendChild(menu);
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.left = `${rect.left}px`;
      menu.style.zIndex = '10000';
      const closeMenu = (e: Event) => { if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('click', closeMenu, true); document.removeEventListener('keydown', handleKeydown, true); } };
      const handleKeydown = (e: KeyboardEvent) => { if (e.key === 'Escape') { menu.remove(); document.removeEventListener('click', closeMenu, true); document.removeEventListener('keydown', handleKeydown, true); } };
      setTimeout(() => { document.addEventListener('click', closeMenu, true); document.addEventListener('keydown', handleKeydown, true); }, 0);
    });
  }

  private async regenerateTranscript(it: LibraryItem) {
    const fs = (window as any).require('fs');
    if (!fs.existsSync(it.audioPath)) { new Notice('Audio not found'); return; }
    try {
      this.busy = true; this.setBusyStatus('Regenerating transcript…');
      const path = (window as any).require('path');
      const plugin = (this.app as any).plugins.getPlugin(this.pluginId);
      if (!plugin) { new Notice('Plugin not available'); return; }
      const settings = plugin.settings as any;
      const { spawn } = (window as any).require('child_process');
      const args = ['-m', settings.whisperModelPath, '-f', it.audioPath];
      const lang = (settings.whisperLanguage || 'auto').trim(); if (lang && lang !== 'auto') args.push('-l', lang);
      // Parametri anti-loop fissi
      args.push('--max-context', '128', '--entropy-thold', '2.4', '--logprob-thold', '-1.0', '--max-len', '0');
      // Parametri aggiuntivi anti-loop
      args.push('--best-of', '1', '--no-timestamps', '--word-thold', '0.01');
      // Scrivi su file per evitare duplicazioni su output molto lunghi
      const outPrefix = it.transcriptPath.replace(/\.txt$/i, '');
      args.push('-otxt', '-of', outPrefix);
      const child = spawn(settings.whisperMainPath, args, { cwd: path.dirname(it.audioPath) });
      const out: string[] = []; let err="";
      await new Promise<void>((resolve, reject)=>{
        child.stdout?.on('data', (d: Buffer)=> out.push(d.toString()));
        child.stderr?.on('data', (d: Buffer)=> { err += d.toString(); });
        child.on('error', reject);
        child.on('close', (code: number)=> code===0? resolve() : reject(new Error(`whisper-cli exited with ${code}: ${err}`)));
      });
      // Preferisci il file generato (-otxt); fallback a stdout
      let text = '';
      try { if (fs.existsSync(it.transcriptPath)) text = String(fs.readFileSync(it.transcriptPath, { encoding: 'utf8' })).trim(); } catch {}
      if (!text) text = out.join('').trim();
      if (!text) throw new Error('Empty transcription');
      fs.writeFileSync(it.transcriptPath, text, { encoding: 'utf8' });
      new Notice('Transcript regenerated');
    } catch (e: any) {
      new Notice(`Regenerate failed: ${e?.message ?? e}`);
    } finally {
      this.busy = false; this.clearBusyStatus();
    }
  }

  private async regenerateSummary(it: LibraryItem) {
    const fs = (window as any).require('fs');
    if (!fs.existsSync(it.transcriptPath)) { new Notice('Transcript not found'); return; }
    try {
      this.busy = true; this.setBusyStatus('Regenerating summary…');
      const transcript: string = fs.readFileSync(it.transcriptPath, { encoding: 'utf8' });
      const plugin = (this.app as any).plugins.getPlugin(this.pluginId);
      if (!plugin) { new Notice('Plugin not available'); return; }
      const settings = plugin.settings as any;
      const { PROMPT_PRESETS, DEFAULT_PROMPT_KEY } = await import('./prompts');
      const { summarizeWithLLM } = await import('./llm');
      const { normalizeCheckboxes, sanitizeSummary } = await import('./markdown');
      const preset = PROMPT_PRESETS[settings.lastPromptKey || DEFAULT_PROMPT_KEY] || PROMPT_PRESETS[DEFAULT_PROMPT_KEY];
      const provider = settings.llmProvider || 'gemini';
      const cfg: any = provider === 'openai' ? { provider, apiKey: settings.openaiApiKey, model: settings.openaiModel || 'gpt-4o-mini' }
        : provider === 'anthropic' ? { provider, apiKey: settings.anthropicApiKey, model: settings.anthropicModel || 'claude-3-5-sonnet-latest' }
        : provider === 'ollama' ? { provider, model: settings.ollamaModel || 'qwen3:8b', endpoint: settings.ollamaEndpoint || 'http://localhost:11434' }
        : { provider: 'gemini', apiKey: settings.geminiApiKey, model: settings.geminiModel || 'gemini-2.5-pro' };
      const expectedLang = (settings.whisperLanguage || 'auto');
      const { detectLanguageFromTranscript } = await import('./llm');
      const detectedLang = expectedLang === 'auto' ? detectLanguageFromTranscript(transcript) : expectedLang;
      console.log(`[Resonance] Regenerating summary with ${provider}, language setting: ${expectedLang}, effective: ${detectedLang}`);
      const raw = await summarizeWithLLM(cfg, preset.prompt, transcript, expectedLang);
      const summary = normalizeCheckboxes(sanitizeSummary(raw || ''));
      if (!summary.trim()) {
        new Notice('Summary skipped: empty output from LLM');
        return;
      }
      // Create new note
      const date = (window as any).moment().format('YYYY-MM-DD HH-mm');
      const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-');
      const scenarioLabel = preset?.label || 'Meeting';
      const fileName = `${safe(scenarioLabel)} ${date} (regenerated).md`;
      const folder = (settings.outputFolder || '').trim();
      const fullPath = folder ? `${folder}/${fileName}` : fileName;
      const tfile = await this.app.vault.create(fullPath, summary);
      new Notice('Summary regenerated');
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(tfile as TFile);
    } catch (e: any) {
      new Notice(`Regenerate failed: ${e?.message ?? e}`);
    } finally {
      this.busy = false; this.clearBusyStatus();
    }
  }

  private setBusyStatus(text: string) {
    try {
      this.statusEl?.setText(text);
      const allBtns = Array.from(this.modalEl.querySelectorAll('button')) as HTMLButtonElement[];
      allBtns.forEach(b => b.disabled = true);
    } catch {}
  }

  private clearBusyStatus() {
    try {
      this.statusEl?.setText('');
      const allBtns = Array.from(this.modalEl.querySelectorAll('button')) as HTMLButtonElement[];
      allBtns.forEach(b => b.disabled = false);
    } catch {}
  }

  private async readTextSafe(filePath: string): Promise<string | null> {
    try {
      const fs = (window as any).require("fs");
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath, { encoding: "utf8" });
    } catch { return null; }
  }

  private async createAudioElement(filePath: string): Promise<HTMLAudioElement | null> {
    try {
      const fs = (window as any).require("fs");
      if (!fs.existsSync(filePath)) return null;
      const buf: any = fs.readFileSync(filePath);
      const uint = buf instanceof Uint8Array ? buf : new Uint8Array(buf?.buffer || buf);
      const blob = new Blob([uint], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = url;
      audio.preload = "metadata";
      return audio;
    } catch { return null; }
  }

  private async downloadFile(filePath: string, downloadName: string, mime: string) {
    try {
      const fs = (window as any).require("fs");
      if (!fs.existsSync(filePath)) { new Notice("File not found"); return; }
      const buf: any = fs.readFileSync(filePath);
      const uint = buf instanceof Uint8Array ? buf : new Uint8Array(buf?.buffer || buf);
      const blob = new Blob([uint], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) {
      new Notice(`Download error: ${e?.message ?? e}`);
    }
  }

  private async findNoteFromLog(logPath: string): Promise<string | null> {
    try {
      const fs = (window as any).require("fs");
      if (!fs.existsSync(logPath)) return null;
      const txt: string = fs.readFileSync(logPath, { encoding: "utf8" });
      // Look for the last occurrence of "Note created: <path>"
      const matches = Array.from(txt.matchAll(/Note created:\s*(.+)$/gmi));
      if (matches.length === 0) return null;
      const last = matches[matches.length - 1][1].trim();
      return last;
    } catch { return null; }
  }
}

class TextPreviewModal extends Modal {
  private titleText: string;
  private contentText: string;
  constructor(app: App, titleText: string, contentText: string) {
    super(app);
    this.titleText = titleText;
    this.contentText = contentText;
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("resonance-modal");
    contentEl.createEl("h3", { text: this.titleText });
    const pre = contentEl.createEl("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.maxHeight = "50vh";
    pre.style.overflow = "auto";
    pre.setText(this.contentText);
  }
}

type IconName = 'play' | 'file-text' | 'download' | 'folder' | 'note' | 'trash' | 'refresh' | 'menu';
function createIcon(name: IconName): HTMLElement {
  const span = document.createElement('span');
  span.addClass('resonance-icon');
  span.innerHTML =
    name === 'play' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' :
    name === 'file-text' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" opacity=".3"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>' :
    name === 'download' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3v10m0 0l4-4m-4 4l-4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 18h14v3H5z"/></svg>' :
    name === 'folder' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M10 4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>' :
    name === 'note' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4 4h14l2 2v14H4z"/><path d="M8 12h8" stroke="currentColor" stroke-width="2"/><path d="M8 16h6" stroke="currentColor" stroke-width="2"/></svg>' :
    name === 'trash' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 6h18" stroke="currentColor" stroke-width="2"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>' :
    name === 'menu' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4 6h16" stroke="currentColor" stroke-width="2"/><path d="M4 12h16" stroke="currentColor" stroke-width="2"/><path d="M4 18h16" stroke="currentColor" stroke-width="2"/></svg>' :
    /* refresh */ '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 13a8.1 8.1 0 0 0 15.5 2"/><path d="M4 4v5h5"/><path d="M20 20v-5h-5"/></svg>';
  return span;
}


