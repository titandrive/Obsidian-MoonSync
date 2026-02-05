import { Plugin, Notice, setIcon, normalizePath, TFile } from "obsidian";
import { MoonSyncSettings, DEFAULT_SETTINGS, BookData } from "./src/types";
import { MoonSyncSettingTab } from "./src/settings";
import { syncFromMoonReader, showSyncResults, refreshIndexNote, refreshBaseFile } from "./src/sync";
import { CreateBookModal, generateBookTemplate, SelectCoverModal, SelectBookMetadataModal } from "./src/modal";
import { generateFilename, generateBookNote } from "./src/writer/markdown";
import { fetchBookInfo, downloadCover, downloadAndResizeCover, BookInfoResult } from "./src/covers";
import { parseManualExport } from "./src/parser/manual-export";
import { join } from "path";

export default class MoonSyncPlugin extends Plugin {
	settings: MoonSyncSettings = DEFAULT_SETTINGS;
	ribbonIconEl: HTMLElement | null = null;
	styleEl: HTMLStyleElement | null = null;

	async onload() {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new MoonSyncSettingTab(this.app, this));

		// Add ribbon icon if enabled
		this.updateRibbonIcon();

		// Initialize cover visibility CSS
		this.updateCoverVisibility();

		// Add sync command
		this.addCommand({
			id: "sync-now",
			name: "Sync Now",
			callback: () => this.runSync(),
		});

		// Add create book note command
		this.addCommand({
			id: "create-book-note",
			name: "Create Book Note",
			callback: () => this.openCreateBookModal(),
		});

		// Add import note command
		this.addCommand({
			id: "import-note",
			name: "Import Note",
			callback: () => this.importManualExport(),
		});

		// Add fetch cover command
		this.addCommand({
			id: "refetch-cover",
			name: "Fetch Book Cover",
			callback: () => this.refetchBookCover(),
		});

		// Add fetch metadata command
		this.addCommand({
			id: "fetch-metadata",
			name: "Fetch Book Metadata",
			callback: () => this.fetchBookMetadata(),
		});

		// Sync on startup if enabled
		if (this.settings.syncOnStartup) {
			// Wait a bit for Obsidian to fully load
			this.app.workspace.onLayoutReady(() => {
				setTimeout(() => this.runSync(), 2000);
			});
		}
	}

	onunload() {
		// Clean up injected style element
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}
	}

	updateRibbonIcon() {
		// Remove existing icon if present
		if (this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}

		// Add icon if setting is enabled
		if (this.settings.showRibbonIcon) {
			this.ribbonIconEl = this.addRibbonIcon(
				"book-open",
				"MoonSync: Sync Now",
				() => this.runSync()
			);
		}
	}

	updateCoverVisibility() {
		// Remove existing style element if present
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}

		// Create new style element
		this.styleEl = document.createElement("style");
		this.styleEl.id = "moonsync-cover-visibility";

		// If covers should be hidden, add CSS to hide them
		if (!this.settings.showCovers) {
			this.styleEl.textContent = `.internal-embed[src*="covers/"] { display: none !important; }`;
		}

		document.head.appendChild(this.styleEl);
	}

	async runSync(): Promise<void> {
		if (!this.settings.dropboxPath) {
			new Notice("MoonSync: Please configure the Dropbox path in settings");
			return;
		}

		try {
			// Get the path to the WASM file
			const wasmPath = this.getWasmPath();

			const result = await syncFromMoonReader(
				this.app,
				this.settings,
				wasmPath
			);
			showSyncResults(this.app, result);
		} catch (error) {
			console.error("MoonSync sync error:", error);
			new Notice(`MoonSync: Sync failed - ${error}`);
		}
	}

	/**
	 * Get the path to the sql-wasm.wasm file bundled with the plugin
	 */
	private getWasmPath(): string {
		// The WASM file is copied to the plugin folder during build
		const pluginDir = (this.app.vault.adapter as any).basePath;
		const pluginPath = this.manifest.dir;
		if (pluginPath) {
			return join(pluginDir, pluginPath, "sql-wasm.wasm");
		}
		throw new Error("Could not determine plugin directory");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Open the modal to create a new book note
	 */
	openCreateBookModal(): void {
		new CreateBookModal(
			this.app,
			this.settings,
			async (bookInfo: BookInfoResult) => {
				await this.createBookNote(bookInfo);
			}
		).open();
	}

	/**
	 * Create a new book note from selected book info
	 */
	async createBookNote(bookInfo: BookInfoResult): Promise<void> {
		const title = bookInfo.title || "Untitled";
		const progressNotice = new Notice("MoonSync: Creating book note...", 0);

		try {
			const outputPath = normalizePath(this.settings.outputFolder);
			const filename = generateFilename(title);
			const filePath = normalizePath(`${outputPath}/${filename}.md`);

			// Check if note already exists
			if (await this.app.vault.adapter.exists(filePath)) {
				progressNotice.hide();
				new Notice(`MoonSync: A note for "${title}" already exists`);
				return;
			}

			// Ensure output folder exists
			if (!(await this.app.vault.adapter.exists(outputPath))) {
				await this.app.vault.createFolder(outputPath);
			}

			// Download cover if available
			let coverPath: string | null = null;
			if (bookInfo.coverUrl) {
				try {
					const coversFolder = normalizePath(`${outputPath}/covers`);
					if (!(await this.app.vault.adapter.exists(coversFolder))) {
						await this.app.vault.createFolder(coversFolder);
					}

					const coverFilename = `${filename}.jpg`;
					const coverFilePath = normalizePath(`${coversFolder}/${coverFilename}`);
					const imageData = await downloadAndResizeCover(bookInfo.coverUrl);
					if (imageData) {
						await this.app.vault.adapter.writeBinary(coverFilePath, imageData);
						coverPath = `covers/${coverFilename}`;
					}
				} catch (error) {
					console.log(`MoonSync: Failed to download cover for "${title}"`, error);
				}
			}

			// Generate the note content
			const content = generateBookTemplate(
				title,
				bookInfo.author || "",
				coverPath,
				this.settings.showDescription ? (bookInfo.description ?? null) : null,
				this.settings.showRatings ? (bookInfo.rating ?? null) : null,
				this.settings.showRatings ? (bookInfo.ratingsCount ?? null) : null,
				bookInfo.publishedDate ?? null,
				bookInfo.publisher ?? null,
				bookInfo.pageCount ?? null,
				bookInfo.genres ?? null,
				bookInfo.series ?? null,
				bookInfo.language ?? null
			);

			// Create the file
			await this.app.vault.create(filePath, content);

			progressNotice.hide();
			new Notice(`MoonSync: Created note for "${title}"`);

			// Refresh the index to include the new book
			if (this.settings.showIndex) {
				await refreshIndexNote(this.app, this.settings);
			}

			// Open the newly created file
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file) {
				await this.app.workspace.openLinkText(filePath, "", true);
			}
		} catch (error) {
			progressNotice.hide();
			console.error("MoonSync: Failed to create book note", error);
			new Notice(`MoonSync: Failed to create book note - ${error}`);
		}
	}

	async refreshIndex(): Promise<void> {
		await refreshIndexNote(this.app, this.settings);
	}

	async refreshBase(): Promise<void> {
		await refreshBaseFile(this.app, this.settings);
	}

	/**
	 * Import a Moon Reader manual export note
	 */
	async importManualExport(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("MoonSync: No active file to import");
			return;
		}

		const progressNotice = new Notice("MoonSync: Importing note...", 0);

		try {
			// Read the file content
			const content = await this.app.vault.read(activeFile);

			// Parse the manual export format
			const exportData = parseManualExport(content);
			if (!exportData) {
				progressNotice.hide();
				new Notice("MoonSync: File is not a valid Moon Reader export");
				return;
			}

			const outputPath = normalizePath(this.settings.outputFolder);
			const filename = generateFilename(exportData.title);
			const filePath = normalizePath(`${outputPath}/${filename}.md`);

			// Check if note already exists
			if (await this.app.vault.adapter.exists(filePath)) {
				progressNotice.hide();
				new Notice(`MoonSync: A note for "${exportData.title}" already exists`);
				return;
			}

			// Ensure output folder exists
			if (!(await this.app.vault.adapter.exists(outputPath))) {
				await this.app.vault.createFolder(outputPath);
			}

			// Fetch book info (cover, description, metadata)
			let coverPath: string | null = null;
			let description: string | null = null;
			let publishedDate: string | null = null;
			let publisher: string | null = null;
			let pageCount: number | null = null;
			let genres: string[] | null = null;
			let series: string | null = null;
			let language: string | null = null;

			try {
				const bookInfo = await fetchBookInfo(exportData.title, exportData.author);

				// Save cover if available
				if (bookInfo.coverUrl) {
					const coversFolder = normalizePath(`${outputPath}/covers`);
					if (!(await this.app.vault.adapter.exists(coversFolder))) {
						await this.app.vault.createFolder(coversFolder);
					}

					const coverFilename = `${filename}.jpg`;
					const coverFilePath = normalizePath(`${coversFolder}/${coverFilename}`);
					const imageData = await downloadCover(bookInfo.coverUrl);
					if (imageData) {
						await this.app.vault.adapter.writeBinary(coverFilePath, imageData);
						coverPath = `covers/${coverFilename}`;
					}
				}

				description = bookInfo.description;
				publishedDate = bookInfo.publishedDate;
				publisher = bookInfo.publisher;
				pageCount = bookInfo.pageCount;
				genres = bookInfo.genres;
				series = bookInfo.series;
				language = bookInfo.language;
			} catch (error) {
				console.log(`MoonSync: Failed to fetch book info for "${exportData.title}"`, error);
			}

			// Create BookData structure
			const bookData: BookData = {
				book: {
					title: exportData.title,
					author: exportData.author,
					filename: "",
					description: "",
					category: "",
					iid: "",
				},
				highlights: exportData.highlights,
				statistics: null,
				progress: null,
				currentChapter: null,
				lastReadTimestamp: null,
				coverPath: coverPath,
				fetchedDescription: description,
				publishedDate: publishedDate,
				publisher: publisher,
				pageCount: pageCount,
				genres: genres,
				series: series,
				isbn10: null,
				isbn13: null,
				language: language,
			};

			// Generate the note content
			const noteContent = generateBookNote(bookData, this.settings);

			// Create the file
			await this.app.vault.create(filePath, noteContent);

			progressNotice.hide();
			new Notice(`MoonSync: Imported "${exportData.title}" with ${exportData.highlights.length} highlights`);

			// Refresh the index to include the new book
			if (this.settings.showIndex) {
				await refreshIndexNote(this.app, this.settings);
			}

			// Refresh base file
			if (this.settings.generateBaseFile) {
				await refreshBaseFile(this.app, this.settings);
			}

			// Open the newly created file
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file) {
				await this.app.workspace.openLinkText(filePath, "", true);
			}
		} catch (error) {
			progressNotice.hide();
			console.error("MoonSync: Failed to import note", error);
			new Notice(`MoonSync: Failed to import note - ${error}`);
		}
	}

	/**
	 * Re-fetch book cover for the current note
	 */
	async refetchBookCover(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("MoonSync: No active file");
			return;
		}

		try {
			// Read the file content to get title and author from frontmatter
			const content = await this.app.vault.read(activeFile);

			// Extract frontmatter
			const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
			if (!frontmatterMatch) {
				new Notice("MoonSync: This file doesn't have frontmatter");
				return;
			}

			const frontmatter = frontmatterMatch[1];

			// Extract title and author
			const titleMatch = frontmatter.match(/^title:\s*"?([^"\n]+)"?/m);
			const authorMatch = frontmatter.match(/^author:\s*"?([^"\n]+)"?/m);

			if (!titleMatch) {
				new Notice("MoonSync: No title found in frontmatter");
				return;
			}

			const title = titleMatch[1].trim().replace(/\\"/g, '"');
			const author = authorMatch ? authorMatch[1].trim().replace(/\\"/g, '"') : "";

			// Open cover selection modal
			new SelectCoverModal(
				this.app,
				title,
				author,
				async (coverUrl: string) => {
					const progressNotice = new Notice("MoonSync: Downloading cover...", 0);

					try {
						// Download and save cover
						const outputPath = normalizePath(this.settings.outputFolder);
						const coversFolder = normalizePath(`${outputPath}/covers`);

						// Ensure covers folder exists
						if (!(await this.app.vault.adapter.exists(coversFolder))) {
							await this.app.vault.createFolder(coversFolder);
						}

						const filename = generateFilename(title);
						const coverFilename = `${filename}.jpg`;
						const coverFilePath = normalizePath(`${coversFolder}/${coverFilename}`);

						const imageData = await downloadAndResizeCover(coverUrl);
						if (!imageData) {
							progressNotice.hide();
							new Notice("MoonSync: Failed to download cover image");
							return;
						}

						// Delete existing cover first to force cache invalidation
						const existingFile = this.app.vault.getAbstractFileByPath(coverFilePath);
						if (existingFile instanceof TFile) {
							await this.app.vault.delete(existingFile);
						}

						// Save the new cover using vault method (triggers Obsidian events)
						await this.app.vault.createBinary(coverFilePath, imageData);

						// Update frontmatter and note body with new cover path
						const coverPath = `covers/${coverFilename}`;
						const updatedContent = this.updateNoteCover(content, coverPath);

						// Temporarily remove cover embed to force cache invalidation
						const contentWithoutEmbed = updatedContent.replace(/!\[\[covers\/[^\]]+\]\]\n?/, "");
						await this.app.vault.modify(activeFile, contentWithoutEmbed);

						// Small delay then re-add the embed
						await new Promise(resolve => setTimeout(resolve, 50));
						await this.app.vault.modify(activeFile, updatedContent);

						// Refresh index note to include new cover
						await refreshIndexNote(this.app, this.settings);

						progressNotice.hide();
						new Notice("MoonSync: Cover updated successfully");
					} catch (error) {
						progressNotice.hide();
						console.error("MoonSync: Failed to download cover", error);
						new Notice(`MoonSync: Failed to download cover - ${error}`);
					}
				}
			).open();
		} catch (error) {
			console.error("MoonSync: Failed to re-fetch cover", error);
			new Notice(`MoonSync: Failed to re-fetch cover - ${error}`);
		}
	}

	/**
	 * Update the cover field in frontmatter and add/update cover embed in note body
	 */
	private updateNoteCover(content: string, coverPath: string): string {
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!frontmatterMatch) {
			return content;
		}

		const frontmatter = frontmatterMatch[1];
		let contentAfterFrontmatter = content.slice(frontmatterMatch[0].length);

		const lines: string[] = [];
		lines.push("---");

		// Process existing frontmatter lines
		let coverUpdated = false;
		for (const line of frontmatter.split("\n")) {
			if (line.startsWith("cover:")) {
				lines.push(`cover: "${coverPath}"`);
				coverUpdated = true;
			} else {
				lines.push(line);
			}
		}

		// Add cover field if it didn't exist
		if (!coverUpdated) {
			lines.push(`cover: "${coverPath}"`);
		}

		lines.push("---");

		// Update or add cover embed in note body
		const coverEmbed = `![[${coverPath}|200]]`;
		const coverEmbedPattern = /!\[\[covers\/[^\]]+\|\d+\]\]/;

		if (coverEmbedPattern.test(contentAfterFrontmatter)) {
			// Replace existing cover embed
			contentAfterFrontmatter = contentAfterFrontmatter.replace(coverEmbedPattern, coverEmbed);
		} else {
			// Add cover embed after author line or after title
			const authorPattern = /(\*\*Author:\*\*[^\n]*\n)/;
			const titlePattern = /(# [^\n]+\n)/;

			if (authorPattern.test(contentAfterFrontmatter)) {
				contentAfterFrontmatter = contentAfterFrontmatter.replace(
					authorPattern,
					`$1\n${coverEmbed}\n`
				);
			} else if (titlePattern.test(contentAfterFrontmatter)) {
				contentAfterFrontmatter = contentAfterFrontmatter.replace(
					titlePattern,
					`$1\n${coverEmbed}\n`
				);
			}
		}

		return lines.join("\n") + contentAfterFrontmatter;
	}

	/**
	 * Fetch and replace all book metadata for the current note
	 */
	async fetchBookMetadata(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("MoonSync: No active file");
			return;
		}

		try {
			// Read the file content to get title and author from frontmatter
			const content = await this.app.vault.read(activeFile);

			// Extract frontmatter
			const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
			if (!frontmatterMatch) {
				new Notice("MoonSync: This file doesn't have frontmatter");
				return;
			}

			const frontmatter = frontmatterMatch[1];

			// Extract title and author
			const titleMatch = frontmatter.match(/^title:\s*"?([^"\n]+)"?/m);
			const authorMatch = frontmatter.match(/^author:\s*"?([^"\n]+)"?/m);

			if (!titleMatch) {
				new Notice("MoonSync: No title found in frontmatter");
				return;
			}

			const title = titleMatch[1].trim().replace(/\\"/g, '"');
			const author = authorMatch ? authorMatch[1].trim().replace(/\\"/g, '"') : "";

			// Open metadata selection modal
			new SelectBookMetadataModal(
				this.app,
				title,
				author,
				async (bookInfo: BookInfoResult) => {
					const progressNotice = new Notice("MoonSync: Updating metadata...", 0);

					try {
						// Get the directory of the current file
						const fileDir = activeFile.parent?.path || "";
						const coversFolder = normalizePath(`${fileDir}/covers`);
						let coverPath: string | null = null;

						// Determine new filename based on new title (or keep original if no new title)
						const newTitle = bookInfo.title || title;
						const newFilename = generateFilename(newTitle);
						const newFilePath = normalizePath(`${fileDir}/${newFilename}.md`);

						// Handle cover: download new cover if available
						if (bookInfo.coverUrl) {
							if (!(await this.app.vault.adapter.exists(coversFolder))) {
								await this.app.vault.createFolder(coversFolder);
							}

							const coverFilename = `${newFilename}.jpg`;
							const coverFilePath = normalizePath(`${coversFolder}/${coverFilename}`);

							const imageData = await downloadAndResizeCover(bookInfo.coverUrl);
							if (imageData) {
								// Delete existing cover first to force cache invalidation
								const existingCover = this.app.vault.getAbstractFileByPath(coverFilePath);
								if (existingCover instanceof TFile) {
									await this.app.vault.delete(existingCover);
								}
								await this.app.vault.createBinary(coverFilePath, imageData);
								coverPath = `covers/${coverFilename}`;
							}
						}

						// Update the note with all new metadata
						const updatedContent = this.updateNoteMetadata(content, bookInfo, coverPath);

						// Temporarily remove cover embed to force cache invalidation
						const contentWithoutEmbed = updatedContent.replace(/!\[\[covers\/[^\]]+\]\]\n?/, "");
						await this.app.vault.modify(activeFile, contentWithoutEmbed);

						// Small delay then re-add the embed
						await new Promise(resolve => setTimeout(resolve, 50));
						await this.app.vault.modify(activeFile, updatedContent);

						// Rename file if filename doesn't match the expected name for this title
						if (activeFile.basename !== newFilename) {
							await this.app.fileManager.renameFile(activeFile, newFilePath);
						}

						// Refresh index note
						await refreshIndexNote(this.app, this.settings);

						progressNotice.hide();
						new Notice("MoonSync: Metadata updated successfully");
					} catch (error) {
						progressNotice.hide();
						console.error("MoonSync: Failed to update metadata", error);
						new Notice(`MoonSync: Failed to update metadata - ${error}`);
					}
				}
			).open();
		} catch (error) {
			console.error("MoonSync: Failed to fetch metadata", error);
			new Notice(`MoonSync: Failed to fetch metadata - ${error}`);
		}
	}

	/**
	 * Update all metadata fields in frontmatter and note body
	 */
	private updateNoteMetadata(content: string, bookInfo: BookInfoResult, coverPath: string | null): string {
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!frontmatterMatch) {
			return content;
		}

		const frontmatter = frontmatterMatch[1];
		let contentAfterFrontmatter = content.slice(frontmatterMatch[0].length);

		const escapeYaml = (str: string) => str.replace(/"/g, '\\"').replace(/\n/g, " ");

		// Fields we want to replace with new values
		const fieldsToReplace = new Set(["title", "author", "published_date", "publisher", "page_count", "genres", "series", "language", "cover", "rating", "ratings_count", "custom_metadata"]);

		// Parse existing frontmatter
		const frontmatterLines: string[] = [];
		let skipNextLines = false;

		for (const line of frontmatter.split("\n")) {
			// Skip array items from previous field
			if (line.startsWith("  -")) {
				if (skipNextLines) continue;
				frontmatterLines.push(line);
				continue;
			}
			skipNextLines = false;

			const fieldMatch = line.match(/^(\w+):/);
			if (fieldMatch) {
				const field = fieldMatch[1];

				// Replace these fields with new values
				if (fieldsToReplace.has(field)) {
					if (field === "genres") {
						skipNextLines = true;
					}
					continue; // Skip this line, we'll add updated values later
				}
			}

			frontmatterLines.push(line);
		}

		// Build new frontmatter
		const lines: string[] = [];
		lines.push("---");

		// Add existing fields (non-replaced ones)
		for (const line of frontmatterLines) {
			if (line.trim()) {
				lines.push(line);
			}
		}

		// Add new/updated metadata
		if (bookInfo.title) {
			lines.push(`title: "${escapeYaml(bookInfo.title)}"`);
		}
		if (bookInfo.author) {
			lines.push(`author: "${escapeYaml(bookInfo.author)}"`);
		}
		if (bookInfo.publishedDate) {
			lines.push(`published_date: "${escapeYaml(bookInfo.publishedDate)}"`);
		}
		if (bookInfo.publisher) {
			lines.push(`publisher: "${escapeYaml(bookInfo.publisher)}"`);
		}
		if (bookInfo.pageCount !== null) {
			lines.push(`page_count: ${bookInfo.pageCount}`);
		}
		if (bookInfo.genres && bookInfo.genres.length > 0) {
			lines.push(`genres:`);
			for (const genre of bookInfo.genres) {
				lines.push(`  - "${escapeYaml(genre)}"`);
			}
		}
		if (bookInfo.series) {
			lines.push(`series: "${escapeYaml(bookInfo.series)}"`);
		}
		if (bookInfo.language) {
			lines.push(`language: "${bookInfo.language}"`);
		}
		if (coverPath) {
			lines.push(`cover: "${coverPath}"`);
		}
		// Add custom_metadata flag so sync doesn't overwrite
		lines.push(`custom_metadata: true`);

		lines.push("---");

		// Update content: title, author, cover embed
		if (bookInfo.title) {
			// Update the title heading
			contentAfterFrontmatter = contentAfterFrontmatter.replace(
				/^(# ).+$/m,
				`$1${bookInfo.title}`
			);
		}

		if (bookInfo.author) {
			// Update or add author line
			if (/\*\*Author:\*\*/.test(contentAfterFrontmatter)) {
				contentAfterFrontmatter = contentAfterFrontmatter.replace(
					/\*\*Author:\*\*[^\n]*/,
					`**Author:** ${bookInfo.author}`
				);
			}
		}

		// Update cover embed
		if (coverPath) {
			const coverEmbed = `![[${coverPath}|200]]`;
			const coverEmbedPattern = /!\[\[covers\/[^\]]+\|\d+\]\]/;

			if (coverEmbedPattern.test(contentAfterFrontmatter)) {
				contentAfterFrontmatter = contentAfterFrontmatter.replace(coverEmbedPattern, coverEmbed);
			} else {
				// Add cover embed after author line or after title
				const authorPattern = /(\*\*Author:\*\*[^\n]*\n)/;
				const titlePattern = /(# [^\n]+\n)/;

				if (authorPattern.test(contentAfterFrontmatter)) {
					contentAfterFrontmatter = contentAfterFrontmatter.replace(
						authorPattern,
						`$1\n${coverEmbed}\n`
					);
				} else if (titlePattern.test(contentAfterFrontmatter)) {
					contentAfterFrontmatter = contentAfterFrontmatter.replace(
						titlePattern,
						`$1\n${coverEmbed}\n`
					);
				}
			}
		}

		return lines.join("\n") + contentAfterFrontmatter;
	}
}
