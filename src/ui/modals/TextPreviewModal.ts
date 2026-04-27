import { App, Modal, Notice } from "obsidian";

export class TextPreviewModal extends Modal {
  constructor(app: App, private readonly titleText: string, private readonly contentText: string) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("rxn-modal");
    this.contentEl.createEl("h2", { text: this.titleText });
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
      return;
    } catch {}

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    new Notice("Copied.");
  }
}
