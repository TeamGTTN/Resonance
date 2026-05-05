import { App, Modal } from "obsidian";

interface ConfirmationModalOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText?: string;
  danger?: boolean;
}

export class ConfirmationModal extends Modal {
  private resolved = false;
  private resolveResult: ((confirmed: boolean) => void) | null = null;

  constructor(app: App, private readonly options: ConfirmationModalOptions) {
    super(app);
  }

  openAndWait(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolveResult = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.setTitle(this.options.title);
    this.contentEl.empty();
    this.contentEl.addClass("rxn-modal");
    this.contentEl.createEl("p", { text: this.options.message, cls: "rxn-muted" });
    const actions = this.contentEl.createDiv({ cls: "rxn-action-bar" });
    const cancel = actions.createEl("button", {
      text: this.options.cancelText ?? "Cancel",
      cls: "rxn-btn-secondary",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => {
      this.finish(false);
    });
    const confirm = actions.createEl("button", {
      text: this.options.confirmText,
      cls: this.options.danger ? "rxn-btn-danger" : "rxn-btn-primary",
      attr: { type: "button" },
    });
    confirm.addEventListener("click", () => {
      this.finish(true);
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.contentEl.removeClass("rxn-modal");
    if (!this.resolved) {
      this.resolved = true;
      this.resolveResult?.(false);
    }
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveResult?.(confirmed);
    this.close();
  }
}
