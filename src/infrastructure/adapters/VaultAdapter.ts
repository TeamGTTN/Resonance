import { App, TFile, normalizePath } from "obsidian";
import type { OutputSettings } from "../../domain/settings";
import type { RecordingSessionManifest } from "../../domain/session";
import { formatDateForFile, slugifyForPath } from "../../utils/format";
import { formatLiveTranscriptNote } from "../../utils/markdown";

export class VaultAdapter {
  constructor(private readonly app: App) {}

  async ensureSessionWorkspace(manifest: RecordingSessionManifest, output: OutputSettings): Promise<{
    folderPath: string;
    liveTranscriptNotePath?: string;
  }> {
    const folderName = slugifyForPath(`${manifest.scenarioLabel} ${formatDateForFile(manifest.createdAt)}`);
    const root = output.vaultFolder.trim();
    const folderPath = normalizePath(root ? `${root}/${folderName}` : folderName);
    await this.ensureFolderExists(folderPath);

    if (!output.storeLiveTranscriptInVault) {
      return { folderPath };
    }

    const liveTranscriptNotePath = normalizePath(`${folderPath}/Live transcript.md`);
    await this.getOrCreateFile(
      liveTranscriptNotePath,
      formatLiveTranscriptNote(`${manifest.scenarioLabel} — Transcript`, "")
    );
    return { folderPath, liveTranscriptNotePath };
  }

  async appendToNote(path: string, text: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) return;
    const current = await this.app.vault.read(existing);
    await this.app.vault.modify(existing, `${current}${text}`);
  }

  async createSummaryNote(
    manifest: RecordingSessionManifest,
    output: OutputSettings,
    markdown: string
  ): Promise<string> {
    const workspace = await this.ensureSessionWorkspace(manifest, output);
    const summaryNotePath = normalizePath(`${workspace.folderPath}/Summary.md`);
    const file = await this.getOrCreateFile(summaryNotePath, markdown);
    await this.app.vault.modify(file, markdown);
    return summaryNotePath;
  }

  async createOrUpdateLiveTranscriptNote(
    manifest: RecordingSessionManifest,
    output: OutputSettings,
    transcript: string
  ): Promise<string | undefined> {
    const workspace = await this.ensureSessionWorkspace(manifest, output);
    const liveTranscriptNotePath = workspace.liveTranscriptNotePath;
    if (!liveTranscriptNotePath) return undefined;
    const contents = formatLiveTranscriptNote(`${manifest.scenarioLabel} — Transcript`, transcript);
    const file = await this.getOrCreateFile(liveTranscriptNotePath, contents);
    await this.app.vault.modify(file, contents);
    return liveTranscriptNotePath;
  }

  async openFile(path: string | undefined): Promise<void> {
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async deleteFile(path: string | undefined): Promise<void> {
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.vault.delete(file, true);
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const segments = normalizePath(folderPath)
      .split("/")
      .filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? normalizePath(`${current}/${segment}`) : segment;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch {}
    }
  }

  private async getOrCreateFile(path: string, initialContents: string): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    return await this.app.vault.create(path, initialContents);
  }
}
