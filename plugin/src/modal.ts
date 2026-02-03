import { App, Modal } from "obsidian";
import { SyncResult } from "./sync";

export class SyncSummaryModal extends Modal {
	private result: SyncResult;

	constructor(app: App, result: SyncResult) {
		super(app);
		this.result = result;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-summary-modal");

		// Title
		contentEl.createEl("h2", { text: "MoonSync Import Complete" });

		// Stats container
		const statsContainer = contentEl.createDiv({ cls: "moonsync-stats" });

		// Create stat items (2x2 grid)
		// Top row: Books Imported, Notes Created
		this.createStatItem(statsContainer, this.result.booksCreated.toString(), "Books Imported");
		this.createStatItem(statsContainer, this.result.booksCreated.toString(), "Notes Created");
		// Bottom row: Highlights, Notes
		this.createStatItem(statsContainer, this.result.totalHighlights.toString(), "Highlights");
		this.createStatItem(statsContainer, this.result.totalNotes.toString(), "Notes");

		// Settings link
		const settingsLink = contentEl.createDiv({ cls: "moonsync-settings-link" });
		const link = settingsLink.createEl("a", { text: "Open MoonSync Settings" });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			this.close();
			// Open Obsidian settings and navigate to MoonSync tab
			(this.app as any).setting.open();
			(this.app as any).setting.openTabById("moonsync");
		});

		// Close button
		const buttonContainer = contentEl.createDiv({ cls: "moonsync-button-container" });
		const closeButton = buttonContainer.createEl("button", { text: "Done" });
		closeButton.addEventListener("click", () => this.close());
	}

	private createStatItem(container: HTMLElement, value: string, label: string) {
		const item = container.createDiv({ cls: "moonsync-stat-item" });
		item.createDiv({ cls: "moonsync-stat-value", text: value });
		item.createDiv({ cls: "moonsync-stat-label", text: label });
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
