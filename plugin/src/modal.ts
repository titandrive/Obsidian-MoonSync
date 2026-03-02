import { App, Modal, Setting, normalizePath } from "obsidian";
import { SyncResult } from "./sync";
import { MoonSyncSettings } from "./types";
import { fetchMultipleBookCovers, BookInfoResult } from "./covers";

export class SyncSummaryModal extends Modal {
	private result: SyncResult;
	private settings: MoonSyncSettings;

	constructor(app: App, result: SyncResult, settings: MoonSyncSettings) {
		super(app);
		this.result = result;
		this.settings = settings;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-summary-modal");

		// Title - changes if there were failures
		const hasFailures = this.result.failedBooks && this.result.failedBooks.length > 0;
		const title = hasFailures ? "MoonSync import complete (with errors)" : "MoonSync import complete";
		contentEl.createEl("h2", { text: title });

		// Stats container
		const statsContainer = contentEl.createDiv({ cls: "moonsync-stats" });

		// Create stat items (2x2 grid)
		// Top row: Books Imported, Notes Created
		this.createStatItem(statsContainer, this.result.booksCreated.toString(), "Books imported");
		this.createStatItem(statsContainer, this.result.booksCreated.toString(), "Notes created");
		// Bottom row: Highlights, Notes
		this.createStatItem(statsContainer, this.result.totalHighlights.toString(), "Highlights");
		this.createStatItem(statsContainer, this.result.totalNotes.toString(), "Notes");

		// Show failed books if any
		if (hasFailures) {
			const failedSection = contentEl.createDiv({ cls: "moonsync-failed-section" });
			failedSection.createEl("h3", { text: `Failed (${this.result.failedBooks.length})` });
			const failedList = failedSection.createEl("ul", { cls: "moonsync-failed-list" });
			for (const failed of this.result.failedBooks) {
				const item = failedList.createEl("li");
				item.createSpan({ text: failed.title, cls: "moonsync-failed-title" });
				item.createSpan({ text: ` - ${failed.error}`, cls: "moonsync-failed-error" });
			}
		}

		// Settings link
		const settingsLink = contentEl.createDiv({ cls: "moonsync-settings-link" });
		const link = settingsLink.createEl("a", { text: "Open MoonSync settings" });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			this.close();
			// Open Obsidian settings and navigate to MoonSync tab
			const app = this.app as unknown as { setting: { open(): void; openTabById(id: string): void } };
			app.setting.open();
			app.setting.openTabById("moonsync");
		});

		// Button container with two buttons
		const buttonContainer = contentEl.createDiv({ cls: "moonsync-button-container" });

		// Open Index button
		const openIndexButton = buttonContainer.createEl("button", { text: "Open library" });
		openIndexButton.addEventListener("click", async () => {
			this.close();
			const indexPath = normalizePath(`${this.settings.outputFolder}/${this.settings.indexNoteTitle}.md`);
			const file = this.app.vault.getAbstractFileByPath(indexPath);
			if (file) {
				await this.app.workspace.openLinkText(indexPath, "", false);
			}
		});

		// Done button
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

/**
 * Modal for selecting from multiple cover options
 */
export class SelectCoverModal extends Modal {
	private title: string;
	private author: string;
	private customUrl: string = "";
	private onSelect: (coverUrl: string) => void;
	private hardcoverEnabled: boolean;
	private hardcoverToken: string;
	private activeSearchTab: "google" | "hardcover" = "hardcover";
	private googleResultsContainer: HTMLElement | null = null;
	private hardcoverResultsContainer: HTMLElement | null = null;

	constructor(
		app: App,
		title: string,
		author: string,
		onSelect: (coverUrl: string) => void,
		hardcoverEnabled: boolean = false,
		hardcoverToken: string = ""
	) {
		super(app);
		this.title = title;
		this.author = author;
		this.onSelect = onSelect;
		this.hardcoverEnabled = hardcoverEnabled && !!hardcoverToken;
		this.hardcoverToken = hardcoverToken;
		if (!this.hardcoverEnabled) this.activeSearchTab = "google";
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-select-cover-modal");
		modalEl.addClass("mod-moonsync-cover");

		// Title
		new Setting(contentEl).setName("Fetch book cover").setHeading();

		// Tab navigation
		const tabNav = contentEl.createDiv({ cls: "moonsync-tab-nav" });
		const tabs: HTMLElement[] = [];
		const tabContents: HTMLElement[] = [];

		let hardcoverTab: HTMLElement | null = null;
		if (this.hardcoverEnabled) {
			hardcoverTab = tabNav.createEl("button", { text: "Hardcover", cls: "moonsync-tab active" });
			tabs.push(hardcoverTab);
		}
		const googleTab = tabNav.createEl("button", { text: this.hardcoverEnabled ? "Google Books" : "Search", cls: this.hardcoverEnabled ? "moonsync-tab" : "moonsync-tab active" });
		tabs.push(googleTab);
		const urlTab = tabNav.createEl("button", { text: "Import", cls: "moonsync-tab" });
		tabs.push(urlTab);

		// Tab content containers
		let hardcoverContent: HTMLElement | null = null;
		if (this.hardcoverEnabled) {
			hardcoverContent = contentEl.createDiv({ cls: "moonsync-tab-content active" });
			tabContents.push(hardcoverContent);
		}
		const googleContent = contentEl.createDiv({ cls: this.hardcoverEnabled ? "moonsync-tab-content" : "moonsync-tab-content active" });
		tabContents.push(googleContent);
		const urlContent = contentEl.createDiv({ cls: "moonsync-tab-content" });
		tabContents.push(urlContent);

		const switchTab = (activeTab: HTMLElement, activeContent: HTMLElement) => {
			tabs.forEach(t => t.removeClass("active"));
			tabContents.forEach(c => c.removeClass("active"));
			activeTab.addClass("active");
			activeContent.addClass("active");
		};

		if (hardcoverTab && hardcoverContent) {
			hardcoverTab.addEventListener("click", () => {
				this.activeSearchTab = "hardcover";
				switchTab(hardcoverTab!, hardcoverContent!);
				if (this.hardcoverResultsContainer && this.hardcoverResultsContainer.childElementCount === 0) {
					void this.performSearch();
				}
			});
		}

		googleTab.addEventListener("click", () => {
			this.activeSearchTab = "google";
			switchTab(googleTab, googleContent);
			if (this.googleResultsContainer && this.googleResultsContainer.childElementCount === 0) {
				void this.performSearch();
			}
		});

		urlTab.addEventListener("click", () => {
			switchTab(urlTab, urlContent);
		});

		// === Search fields helper ===
		const buildSearchFields = (container: HTMLElement) => {
			const titleSetting = new Setting(container)
				.setName("Title")
				.addText((text) => {
					text
						.setPlaceholder("Enter book title")
						.setValue(this.title)
						.onChange((value) => {
							this.title = value;
						});
					text.inputEl.addEventListener("keydown", (e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void this.performSearch();
						}
					});
				});
			titleSetting.settingEl.addClass("moonsync-labeled-field");

			const authorSetting = new Setting(container)
				.setName("Author")
				.addText((text) => {
					text
						.setPlaceholder("Enter author name")
						.setValue(this.author)
						.onChange((value) => {
							this.author = value;
						});
					text.inputEl.addEventListener("keydown", (e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void this.performSearch();
						}
					});
				});
			authorSetting.settingEl.addClass("moonsync-labeled-field");

			new Setting(container)
				.addButton((button) => {
					button
						.setButtonText("Search")
						.setCta()
						.onClick(() => this.performSearch());
				});

			return container.createDiv({ cls: "moonsync-cover-results" });
		};

		// === Hardcover Tab Content ===
		if (hardcoverContent) {
			this.hardcoverResultsContainer = buildSearchFields(hardcoverContent);
		}

		// === Google Tab Content ===
		this.googleResultsContainer = buildSearchFields(googleContent);

		// === Custom URL Tab Content ===
		urlContent.createEl("p", {
			text: "If search can't find the cover, or you have one you prefer, you can import it here.",
			cls: "moonsync-url-description"
		});

		const urlSetting = new Setting(urlContent)
			.setName("URL")
			.addText((text) => {
				text
					.setPlaceholder("https://example.com/cover.jpg")
					.onChange((value) => {
						this.customUrl = value;
					});
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						if (this.customUrl.trim()) {
							this.onSelect(this.customUrl.trim());
							this.close();
						}
					}
				});
			});
		urlSetting.settingEl.addClass("moonsync-labeled-field");

		new Setting(urlContent)
			.addButton((button) => {
				button
					.setButtonText("Import")
					.setCta()
					.onClick(() => {
						if (this.customUrl.trim()) {
							this.onSelect(this.customUrl.trim());
							this.close();
						}
					});
			});

		// Perform initial search after a short delay to ensure modal is fully ready
		setTimeout(() => { void this.performSearch(); }, 150);
	}

	private async performSearch() {
		const container = this.activeSearchTab === "hardcover"
			? this.hardcoverResultsContainer
			: this.googleResultsContainer;
		if (!container) return;

		container.empty();

		if (!this.title.trim()) {
			container.createEl("p", {
				text: "Please enter a book title.",
				cls: "setting-item-description"
			});
			return;
		}

		const loadingEl = container.createDiv({ cls: "moonsync-loading" });
		loadingEl.setText("Searching for covers...");

		let covers: BookInfoResult[];
		if (this.activeSearchTab === "hardcover") {
			const { searchHardcoverBooks } = await import("./hardcover");
			covers = await searchHardcoverBooks(this.title, this.author, this.hardcoverToken, 10);
		} else {
			covers = await fetchMultipleBookCovers(this.title, this.author, 10);
		}

		loadingEl.remove();

		if (covers.length === 0) {
			container.createEl("p", {
				text: "No covers found. Try a different search query.",
				cls: "setting-item-description"
			});
			return;
		}

		container.createEl("p", {
			text: `Found ${covers.length} result${covers.length === 1 ? "" : "s"} for "${this.title}"${this.author ? ` by ${this.author}` : ""}`,
			cls: "moonsync-search-info"
		});

		const gridContainer = container.createDiv({ cls: "moonsync-cover-grid" });

		for (const cover of covers) {
			const coverItem = gridContainer.createDiv({ cls: "moonsync-cover-item" });

			coverItem.createEl("img", {
				attr: {
					src: cover.coverUrl || "",
					alt: cover.title || "Book cover"
				}
			});

			const info = coverItem.createDiv({ cls: "moonsync-cover-info" });
			if (cover.title) {
				info.createDiv({ cls: "moonsync-cover-title", text: cover.title });
			}
			if (cover.author) {
				info.createDiv({ cls: "moonsync-cover-author", text: cover.author });
			}
			if (cover.publishedDate) {
				info.createDiv({ cls: "moonsync-cover-year", text: cover.publishedDate });
			}

			coverItem.addEventListener("click", () => {
				if (cover.coverUrl) {
					this.onSelect(cover.coverUrl);
					this.close();
				}
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal for selecting book metadata from search results
 */
export class SelectBookMetadataModal extends Modal {
	private title: string;
	private author: string;
	private onSelect: (bookInfo: BookInfoResult) => void;
	private hardcoverEnabled: boolean;
	private hardcoverToken: string;
	private googleResultsContainer: HTMLElement | null = null;
	private hardcoverResultsContainer: HTMLElement | null = null;
	private activeTab: "google" | "hardcover" = "hardcover";

	constructor(
		app: App,
		title: string,
		author: string,
		onSelect: (bookInfo: BookInfoResult) => void,
		hardcoverEnabled: boolean = false,
		hardcoverToken: string = ""
	) {
		super(app);
		this.title = title;
		this.author = author;
		this.onSelect = onSelect;
		this.hardcoverEnabled = hardcoverEnabled && !!hardcoverToken;
		this.hardcoverToken = hardcoverToken;
		if (!this.hardcoverEnabled) this.activeTab = "google";
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-select-cover-modal");
		modalEl.addClass("mod-moonsync-cover");

		// Title
		new Setting(contentEl).setName("Fetch book metadata").setHeading();
		contentEl.createEl("p", {
			text: "Select a book to replace all metadata including cover, description, and details.",
			cls: "moonsync-url-description"
		});

		// Tab navigation (only when Hardcover is enabled)
		let tabNav: HTMLElement | null = null;
		let googleTab: HTMLElement | null = null;
		let hardcoverTab: HTMLElement | null = null;
		if (this.hardcoverEnabled) {
			tabNav = contentEl.createDiv({ cls: "moonsync-tab-nav" });
			hardcoverTab = tabNav.createEl("button", { text: "Hardcover", cls: "moonsync-tab active" });
			googleTab = tabNav.createEl("button", { text: "Google Books", cls: "moonsync-tab" });
		}

		// Search fields
		const titleSetting = new Setting(contentEl)
			.setName("Title")
			.addText((text) => {
				text
					.setPlaceholder("Enter book title")
					.setValue(this.title)
					.onChange((value) => {
						this.title = value;
					});
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void this.performSearch();
					}
				});
			});
		titleSetting.settingEl.addClass("moonsync-labeled-field");

		const authorSetting = new Setting(contentEl)
			.setName("Author")
			.addText((text) => {
				text
					.setPlaceholder("Enter author name")
					.setValue(this.author)
					.onChange((value) => {
						this.author = value;
					});
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void this.performSearch();
					}
				});
			});
		authorSetting.settingEl.addClass("moonsync-labeled-field");

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText("Search")
					.setCta()
					.onClick(() => this.performSearch());
			});

		// Results containers — tab content divs created AFTER search fields
		if (this.hardcoverEnabled) {
			const hardcoverContent = contentEl.createDiv({ cls: "moonsync-tab-content active" });
			const googleContent = contentEl.createDiv({ cls: "moonsync-tab-content" });

			this.googleResultsContainer = googleContent.createDiv({ cls: "moonsync-cover-results" });
			this.hardcoverResultsContainer = hardcoverContent.createDiv({ cls: "moonsync-cover-results" });

			googleTab!.addEventListener("click", () => {
				this.activeTab = "google";
				googleTab!.addClass("active");
				hardcoverTab!.removeClass("active");
				googleContent.addClass("active");
				hardcoverContent.removeClass("active");
				if (this.googleResultsContainer && this.googleResultsContainer.childElementCount === 0) {
					void this.performSearch();
				}
			});

			hardcoverTab!.addEventListener("click", () => {
				this.activeTab = "hardcover";
				hardcoverTab!.addClass("active");
				googleTab!.removeClass("active");
				hardcoverContent.addClass("active");
				googleContent.removeClass("active");
				if (this.hardcoverResultsContainer && this.hardcoverResultsContainer.childElementCount === 0) {
					void this.performSearch();
				}
			});
		} else {
			this.googleResultsContainer = contentEl.createDiv({ cls: "moonsync-cover-results" });
		}

		// Perform initial search after a short delay
		setTimeout(() => { void this.performSearch(); }, 150);
	}

	private async performSearch() {
		const container = this.activeTab === "hardcover"
			? this.hardcoverResultsContainer
			: this.googleResultsContainer;
		if (!container) return;

		container.empty();

		if (!this.title.trim()) {
			container.createEl("p", {
				text: "Please enter a book title.",
				cls: "setting-item-description"
			});
			return;
		}

		const loadingEl = container.createDiv({ cls: "moonsync-loading" });
		loadingEl.setText("Searching for books...");

		let books: BookInfoResult[];
		if (this.activeTab === "hardcover") {
			const { searchHardcoverBooks } = await import("./hardcover");
			books = await searchHardcoverBooks(this.title, this.author, this.hardcoverToken, 10);
		} else {
			books = await fetchMultipleBookCovers(this.title, this.author, 10);
		}

		loadingEl.remove();

		if (books.length === 0) {
			container.createEl("p", {
				text: "No books found. Try a different search query.",
				cls: "setting-item-description"
			});
			return;
		}

		container.createEl("p", {
			text: `Found ${books.length} result${books.length === 1 ? "" : "s"} for "${this.title}"${this.author ? ` by ${this.author}` : ""}`,
			cls: "moonsync-search-info"
		});

		const gridContainer = container.createDiv({ cls: "moonsync-cover-grid" });

		for (const book of books) {
			const bookItem = gridContainer.createDiv({ cls: "moonsync-cover-item" });

			if (book.coverUrl) {
				bookItem.createEl("img", {
					attr: {
						src: book.coverUrl,
						alt: book.title || "Book cover"
					}
				});
			}

			const info = bookItem.createDiv({ cls: "moonsync-cover-info" });
			if (book.title) {
				info.createDiv({ cls: "moonsync-cover-title", text: book.title });
			}
			if (book.author) {
				info.createDiv({ cls: "moonsync-cover-author", text: book.author });
			}

			const details: string[] = [];
			if (book.publishedDate) {
				details.push(book.publishedDate);
			}
			if (book.publisher) {
				details.push(book.publisher);
			}
			if (book.pageCount) {
				details.push(`${book.pageCount} pages`);
			}
			if (details.length > 0) {
				info.createDiv({ cls: "moonsync-cover-year", text: details.join(" · ") });
			}

			bookItem.addEventListener("click", () => {
				this.onSelect(book);
				this.close();
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal for creating a new book note with search and selection
 */
export class CreateBookModal extends Modal {
	private settings: MoonSyncSettings;
	private onSubmit: (bookInfo: BookInfoResult) => void;
	private title = "";
	private author = "";
	private resultsContainer: HTMLElement | null = null;

	constructor(
		app: App,
		settings: MoonSyncSettings,
		onSubmit: (bookInfo: BookInfoResult) => void
	) {
		super(app);
		this.settings = settings;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-select-cover-modal");
		modalEl.addClass("mod-moonsync-cover");

		new Setting(contentEl).setName("Create book note").setHeading();
		contentEl.createEl("p", {
			text: "Search for a book and select it to create a note.",
			cls: "moonsync-url-description"
		});

		// Search fields
		const titleSetting = new Setting(contentEl)
			.setName("Title")
			.addText((text) => {
				text
					.setPlaceholder("Enter book title")
					.setValue(this.title)
					.onChange((value) => {
						this.title = value;
					});
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void this.performSearch();
					}
				});
			});
		titleSetting.settingEl.addClass("moonsync-labeled-field");

		const authorSetting = new Setting(contentEl)
			.setName("Author")
			.addText((text) => {
				text
					.setPlaceholder("Enter author name (optional)")
					.setValue(this.author)
					.onChange((value) => {
						this.author = value;
					});
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void this.performSearch();
					}
				});
			});
		authorSetting.settingEl.addClass("moonsync-labeled-field");

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText("Search")
					.setCta()
					.onClick(() => this.performSearch());
			});

		// Results container
		this.resultsContainer = contentEl.createDiv({ cls: "moonsync-cover-results" });
	}

	private async performSearch() {
		if (!this.resultsContainer) return;

		this.resultsContainer.empty();

		if (!this.title.trim()) {
			this.resultsContainer.createEl("p", {
				text: "Please enter a book title.",
				cls: "setting-item-description"
			});
			return;
		}

		const loadingEl = this.resultsContainer.createDiv({ cls: "moonsync-loading" });
		loadingEl.setText("Searching for books...");

		const books = await fetchMultipleBookCovers(this.title, this.author, 10);

		loadingEl.remove();

		if (books.length === 0) {
			this.resultsContainer.createEl("p", {
				text: "No books found. Try a different search query.",
				cls: "setting-item-description"
			});
			return;
		}

		this.resultsContainer.createEl("p", {
			text: `Found ${books.length} result${books.length === 1 ? "" : "s"} for "${this.title}"${this.author ? ` by ${this.author}` : ""}`,
			cls: "moonsync-search-info"
		});

		const gridContainer = this.resultsContainer.createDiv({ cls: "moonsync-cover-grid" });

		for (const book of books) {
			const bookItem = gridContainer.createDiv({ cls: "moonsync-cover-item" });

			if (book.coverUrl) {
				bookItem.createEl("img", {
					attr: {
						src: book.coverUrl,
						alt: book.title || "Book cover"
					}
				});
			}

			const info = bookItem.createDiv({ cls: "moonsync-cover-info" });
			if (book.title) {
				info.createDiv({ cls: "moonsync-cover-title", text: book.title });
			}
			if (book.author) {
				info.createDiv({ cls: "moonsync-cover-author", text: book.author });
			}

			const details: string[] = [];
			if (book.publishedDate) {
				details.push(book.publishedDate);
			}
			if (book.publisher) {
				details.push(book.publisher);
			}
			if (book.pageCount) {
				details.push(`${book.pageCount} pages`);
			}
			if (details.length > 0) {
				info.createDiv({ cls: "moonsync-cover-year", text: details.join(" · ") });
			}

			bookItem.addEventListener("click", () => {
				this.onSubmit(book);
				this.close();
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Generate a book note template
 */
export function generateBookTemplate(
	title: string,
	author: string,
	coverPath: string | null,
	description: string | null,
	publishedDate: string | null = null,
	publisher: string | null = null,
	pageCount: number | null = null,
	genres: string[] | null = null,
	series: string | null = null,
	language: string | null = null
): string {
	const lines: string[] = [];
	const escapeYaml = (str: string) => str.replace(/"/g, '\\"').replace(/\n/g, " ");

	// Frontmatter
	lines.push("---");
	lines.push(`title: "${escapeYaml(title)}"`);
	if (author) {
		lines.push(`author: "${escapeYaml(author)}"`);
	}
	lines.push(`last_synced: ${new Date().toISOString().split("T")[0]}`);
	lines.push("highlights_count: 0");
	lines.push("manual_note: true");
	if (publishedDate) {
		lines.push(`published_date: "${escapeYaml(publishedDate)}"`);
	}
	if (publisher) {
		lines.push(`publisher: "${escapeYaml(publisher)}"`);
	}
	if (pageCount !== null) {
		lines.push(`page_count: ${pageCount}`);
	}
	if (genres && genres.length > 0) {
		lines.push(`genres:`);
		for (const genre of genres) {
			lines.push(`  - "${escapeYaml(genre)}"`);
		}
	}
	if (series) {
		lines.push(`series: "${escapeYaml(series)}"`);
	}
	if (language) {
		lines.push(`language: "${language}"`);
	}
	if (coverPath) {
		lines.push(`cover: "${coverPath}"`);
	}
	lines.push("---");

	// Content
	lines.push(`# ${title}`);
	if (author) {
		lines.push(`**Author:** ${author}`);
	}
	lines.push("");

	if (coverPath) {
		lines.push(`![[${coverPath}|200]]`);
		lines.push("");
	}

	if (description) {
		lines.push("## Description");
		lines.push(description);
		lines.push("");
	}

	lines.push("## Highlights");
	lines.push("");
	lines.push("> [!quote]");
	lines.push("> Add your highlights here...");
	lines.push("");

	return lines.join("\n");
}

export class UpdateHardcoverModal extends Modal {
	private onSubmit: (url: string) => void;

	constructor(app: App, onSubmit: (url: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Update Hardcover link" });
		contentEl.createEl("p", {
			text: "Paste the Hardcover URL for this book to correct the match.",
			cls: "setting-item-description",
		});

		let url = "";
		new Setting(contentEl)
			.setName("Hardcover URL")
			.addText((text) => {
				text.setPlaceholder("https://hardcover.app/books/...");
				text.onChange((value) => { url = value; });
				text.inputEl.style.width = "100%";
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						if (url.trim()) {
							this.onSubmit(url.trim());
							this.close();
						}
					}
				});
			});

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText("Update")
					.setCta()
					.onClick(() => {
						if (url.trim()) {
							this.onSubmit(url.trim());
							this.close();
						}
					});
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
