import { App, Modal, Setting, Notice, normalizePath } from "obsidian";
import { SyncResult } from "./sync";
import { MoonSyncSettings } from "./types";
import { generateFilename } from "./writer/markdown";
import { fetchBookInfo, downloadCover, fetchMultipleBookCovers, BookInfoResult } from "./covers";

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

/**
 * Modal for specifying search query when re-fetching cover
 */
export class RefetchCoverModal extends Modal {
	private onSubmit: (title: string, author: string) => void;

	private title = "";
	private author = "";

	constructor(
		app: App,
		defaultTitle: string,
		defaultAuthor: string,
		onSubmit: (title: string, author: string) => void
	) {
		super(app);
		this.title = defaultTitle;
		this.author = defaultAuthor;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-create-book-modal");

		contentEl.createEl("h2", { text: "Re-fetch Book Cover" });
		contentEl.createEl("p", {
			text: "Edit the search query to find a different cover.",
			cls: "setting-item-description"
		});

		new Setting(contentEl)
			.setName("Title")
			.setDesc("Book title to search for")
			.addText((text) => {
				text
					.setPlaceholder("Enter book title")
					.setValue(this.title)
					.onChange((value) => {
						this.title = value;
					});
				// Focus the title input
				setTimeout(() => text.inputEl.focus(), 10);
			});

		new Setting(contentEl)
			.setName("Author")
			.setDesc("Author name (optional)")
			.addText((text) =>
				text
					.setPlaceholder("Enter author name")
					.setValue(this.author)
					.onChange((value) => {
						this.author = value;
					})
			);

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: "moonsync-button-container" });

		const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => this.close());

		const searchButton = buttonContainer.createEl("button", {
			text: "Search & Update",
			cls: "mod-cta",
		});
		searchButton.addEventListener("click", () => {
			if (!this.title.trim()) {
				new Notice("Please enter a book title");
				return;
			}
			this.onSubmit(this.title.trim(), this.author.trim());
			this.close();
		});
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
	private resultsContainer: HTMLElement | null = null;

	constructor(
		app: App,
		title: string,
		author: string,
		onSelect: (coverUrl: string) => void
	) {
		super(app);
		this.title = title;
		this.author = author;
		this.onSelect = onSelect;
	}

	async onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-select-cover-modal");
		modalEl.addClass("mod-moonsync-cover");

		// Title
		contentEl.createEl("h2", { text: "Fetch Book Cover" });

		// Tab navigation
		const tabNav = contentEl.createDiv({ cls: "moonsync-tab-nav" });
		const searchTab = tabNav.createEl("button", { text: "Search", cls: "moonsync-tab active" });
		const urlTab = tabNav.createEl("button", { text: "Custom URL", cls: "moonsync-tab" });

		// Tab content containers
		const searchContent = contentEl.createDiv({ cls: "moonsync-tab-content active" });
		const urlContent = contentEl.createDiv({ cls: "moonsync-tab-content" });

		// Tab switching logic
		searchTab.addEventListener("click", () => {
			searchTab.addClass("active");
			urlTab.removeClass("active");
			searchContent.addClass("active");
			urlContent.removeClass("active");
		});

		urlTab.addEventListener("click", () => {
			urlTab.addClass("active");
			searchTab.removeClass("active");
			urlContent.addClass("active");
			searchContent.removeClass("active");
		});

		// === Search Tab Content ===
		const titleSetting = new Setting(searchContent)
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
						this.performSearch();
					}
				});
			});
		titleSetting.settingEl.addClass("moonsync-labeled-field");

		const authorSetting = new Setting(searchContent)
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
						this.performSearch();
					}
				});
			});
		authorSetting.settingEl.addClass("moonsync-labeled-field");

		new Setting(searchContent)
			.addButton((button) => {
				button
					.setButtonText("Search")
					.setCta()
					.onClick(() => this.performSearch());
			});

		// Results container (inside search tab)
		this.resultsContainer = searchContent.createDiv({ cls: "moonsync-cover-results" });

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
		setTimeout(() => this.performSearch(), 150);
	}

	private async performSearch() {
		if (!this.resultsContainer) return;

		// Clear previous results
		this.resultsContainer.empty();

		if (!this.title.trim()) {
			this.resultsContainer.createEl("p", {
				text: "Please enter a book title.",
				cls: "setting-item-description"
			});
			return;
		}

		// Loading indicator
		const loadingEl = this.resultsContainer.createDiv({ cls: "moonsync-loading" });
		loadingEl.setText("Searching for covers...");

		// Fetch covers
		const covers = await fetchMultipleBookCovers(this.title, this.author, 10);

		// Remove loading indicator
		loadingEl.remove();

		if (covers.length === 0) {
			this.resultsContainer.createEl("p", {
				text: "No covers found. Try a different search query.",
				cls: "setting-item-description"
			});
			return;
		}

		// Display search info
		this.resultsContainer.createEl("p", {
			text: `Found ${covers.length} result${covers.length === 1 ? "" : "s"} for "${this.title}"${this.author ? ` by ${this.author}` : ""}`,
			cls: "moonsync-search-info"
		});

		// Display covers in a grid
		const gridContainer = this.resultsContainer.createDiv({ cls: "moonsync-cover-grid" });

		for (const cover of covers) {
			const coverItem = gridContainer.createDiv({ cls: "moonsync-cover-item" });

			// Cover image
			const img = coverItem.createEl("img", {
				attr: {
					src: cover.coverUrl || "",
					alt: cover.title || "Book cover"
				}
			});

			// Book info
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

			// Click handler
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
	private resultsContainer: HTMLElement | null = null;

	constructor(
		app: App,
		title: string,
		author: string,
		onSelect: (bookInfo: BookInfoResult) => void
	) {
		super(app);
		this.title = title;
		this.author = author;
		this.onSelect = onSelect;
	}

	async onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-select-cover-modal");
		modalEl.addClass("mod-moonsync-cover");

		// Title
		contentEl.createEl("h2", { text: "Fetch Book Metadata" });
		contentEl.createEl("p", {
			text: "Select a book to replace all metadata including cover, description, and details.",
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
						this.performSearch();
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
						this.performSearch();
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

		// Perform initial search after a short delay
		setTimeout(() => this.performSearch(), 150);
	}

	private async performSearch() {
		if (!this.resultsContainer) return;

		// Clear previous results
		this.resultsContainer.empty();

		if (!this.title.trim()) {
			this.resultsContainer.createEl("p", {
				text: "Please enter a book title.",
				cls: "setting-item-description"
			});
			return;
		}

		// Loading indicator
		const loadingEl = this.resultsContainer.createDiv({ cls: "moonsync-loading" });
		loadingEl.setText("Searching for books...");

		// Fetch books
		const books = await fetchMultipleBookCovers(this.title, this.author, 10);

		// Remove loading indicator
		loadingEl.remove();

		if (books.length === 0) {
			this.resultsContainer.createEl("p", {
				text: "No books found. Try a different search query.",
				cls: "setting-item-description"
			});
			return;
		}

		// Display search info
		this.resultsContainer.createEl("p", {
			text: `Found ${books.length} result${books.length === 1 ? "" : "s"} for "${this.title}"${this.author ? ` by ${this.author}` : ""}`,
			cls: "moonsync-search-info"
		});

		// Display books in a grid
		const gridContainer = this.resultsContainer.createDiv({ cls: "moonsync-cover-grid" });

		for (const book of books) {
			const bookItem = gridContainer.createDiv({ cls: "moonsync-cover-item" });

			// Cover image
			if (book.coverUrl) {
				bookItem.createEl("img", {
					attr: {
						src: book.coverUrl,
						alt: book.title || "Book cover"
					}
				});
			}

			// Book info
			const info = bookItem.createDiv({ cls: "moonsync-cover-info" });
			if (book.title) {
				info.createDiv({ cls: "moonsync-cover-title", text: book.title });
			}
			if (book.author) {
				info.createDiv({ cls: "moonsync-cover-author", text: book.author });
			}

			// Show more metadata details
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

			// Click handler
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

	async onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("moonsync-select-cover-modal");
		modalEl.addClass("mod-moonsync-cover");

		contentEl.createEl("h2", { text: "Create Book Note" });
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
						this.performSearch();
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
						this.performSearch();
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
	rating: number | null,
	ratingsCount: number | null,
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
	if (rating !== null) {
		lines.push(`rating: ${rating}`);
		if (ratingsCount !== null) {
			lines.push(`ratings_count: ${ratingsCount}`);
		}
	}
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
	if (rating !== null) {
		const ratingText = ratingsCount !== null
			? `**Rating:** ⭐ ${rating}/5 (${ratingsCount.toLocaleString()} ratings)`
			: `**Rating:** ⭐ ${rating}/5`;
		lines.push(ratingText);
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
