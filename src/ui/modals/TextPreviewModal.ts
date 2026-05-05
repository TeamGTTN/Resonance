import { App, Modal, Notice } from "obsidian";

export class TextPreviewModal extends Modal {
  constructor(app: App, private readonly titleText: string, private readonly contentText: string) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.titleText);
    this.contentEl.empty();
    this.contentEl.addClass("rxn-modal");
    const toolbar = this.contentEl.createDiv({ cls: "rxn-action-bar" });
    const copy = toolbar.createEl("button", { text: "Copy all", cls: "rxn-btn-secondary" });
    copy.addEventListener("click", () => {
      void this.copyAll();
    });
    const pre = this.contentEl.createEl("pre", { cls: "rxn-preview", attr: { tabindex: "0" } });
    pre.setText(this.contentText || "(empty)");
  }

  private async copyAll(): Promise<void> {
    const text = this.contentText || "(empty)";
    try {
      await navigator.clipboard.writeText(text);
      new Notice("Copied.");
    } catch (error) {
      new Notice(`Copy failed: ${String((error as Error)?.message ?? error)}`);
    }
  }
}
