import { Plugin, Notice, normalizePath, TFile, FileSystemAdapter } from "obsidian";
import { MoonSyncSettings, DEFAULT_SETTINGS, BookData } from "./src/types";
import { MoonSyncSettingTab } from "./src/settings";
import { syncFromMoonReader, showSyncResults, refreshIndexNote, refreshBaseFile } from "./src/sync";
import { CreateBookModal, generateBookTemplate, SelectCoverModal, SelectBookMetadataModal, UpdateHardcoverModal } from "./src/modal";
import { generateFilename, generateBookNote } from "./src/writer/markdown";
import { fetchBookInfo, downloadCover, downloadAndResizeCover, BookInfoResult } from "./src/covers";
import { parseManualExport } from "./src/parser/manual-export";
import { parseFrontmatter, extractFrontmatter, parseFrontmatterField } from "./src/utils";
import { lookupBookBySlug, updateHardcoverBook } from "./src/hardcover";
import { join } from "path";
import { watch, FSWatcher } from "fs";

export default class MoonSyncPlugin extends Plugin {
	settings: MoonSyncSettings = DEFAULT_SETTINGS;
	ribbonIconEl: HTMLElement | null = null;
	private fileWatcher: FSWatcher | null = null;
	private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private isSyncing = false;

	async onload() {
		console.log("MoonSync: BUILD 2026-02-23-A loaded");
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new MoonSyncSettingTab(this.app, this));

		// Add ribbon icon if enabled
		this.updateRibbonIcon();

		// Initialize content visibility CSS
		this.updateContentVisibility();

		// Add sync command
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => { void this.runSync(); },
		});

		// Add create book note command
		this.addCommand({
			id: "create-book-note",
			name: "Create book note",
			callback: () => this.openCreateBookModal(),
		});

		// Add import note command
		this.addCommand({
			id: "import-note",
			name: "Import note",
			callback: () => { void this.importManualExport(); },
		});

		// Add fetch cover command
		this.addCommand({
			id: "refetch-cover",
			name: "Fetch book cover",
			callback: () => { void this.refetchBookCover(); },
		});

		// Add fetch metadata command
		this.addCommand({
			id: "fetch-metadata",
			name: "Fetch book metadata",
			callback: () => { void this.fetchBookMetadata(); },
		});

		// Add update Hardcover link command (only visible when Hardcover is enabled)
		this.addCommand({
			id: "update-hardcover",
			name: "Update Hardcover link",
			checkCallback: (checking: boolean) => {
				if (!this.settings.hardcoverEnabled || !this.settings.hardcoverToken) return false;
				if (!checking) { void this.updateHardcoverLink(); }
				return true;
			},
		});

		// Sync on startup if enabled
		if (this.settings.syncOnStartup) {
			// Wait a bit for Obsidian to fully load
			this.app.workspace.onLayoutReady(() => {
				setTimeout(() => { void this.runSync(); }, 2000);
			});
		}

		// Start file watcher if enabled
		if (this.settings.watchForChanges) {
			this.startFileWatcher();
		}
	}

	onunload() {
		this.stopFileWatcher();
		document.body.classList.remove(
			"moonsync-hide-covers",
			"moonsync-hide-reading-progress",
			"moonsync-hide-description",
			"moonsync-hide-highlight-colors"
		);
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
				"MoonSync: Sync now",
				() => { void this.runSync(); }
			);
		}
	}

	updateContentVisibility() {
		document.body.classList.toggle("moonsync-hide-covers", !this.settings.showCovers);
		document.body.classList.toggle("moonsync-hide-reading-progress", !this.settings.showReadingProgress);
		document.body.classList.toggle("moonsync-hide-description", !this.settings.showDescription);
		document.body.classList.toggle("moonsync-hide-highlight-colors", !this.settings.showHighlightColors);
	}

	async runSync(): Promise<void> {
		if (!this.settings.syncPath) {
			new Notice("MoonSync: Please configure the sync path in settings");
			return;
		}

		if (this.isSyncing) {
			console.log("MoonSync: Sync already in progress, skipping");
			return;
		}

		this.isSyncing = true;
		try {
			const wasmPath = this.getWasmPath();

			const result = await syncFromMoonReader(
				this.app,
				this.settings,
				wasmPath
			);
			showSyncResults(this.app, result, this.settings);
		} catch (error) {
			console.error("MoonSync sync error:", error);
			new Notice(`MoonSync: Sync failed - ${error}`);
		} finally {
			this.isSyncing = false;
		}
	}

	startFileWatcher(): void {
		this.stopFileWatcher();

		if (!this.settings.syncPath) return;

		const cachePath = join(this.settings.syncPath, ".Moon+", "Cache");

		try {
			this.fileWatcher = watch(cachePath, { persistent: false }, (_event, filename) => {
				if (!filename) return;
				const name = filename.toString();
				if (!name.endsWith(".po") && !name.endsWith(".an")) return;

				// Debounce: wait 3 seconds after last change before syncing
				if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
				this.watchDebounceTimer = setTimeout(() => {
					console.log("MoonSync: File change detected, syncing...");
					void this.runSync();
				}, 3000);
			});

			this.fileWatcher.on("error", (err) => {
				console.error("MoonSync: File watcher error", err);
				this.stopFileWatcher();
			});

			console.log("MoonSync: Watching for changes in", cachePath);
		} catch (err) {
			console.error("MoonSync: Failed to start file watcher", err);
		}
	}

	stopFileWatcher(): void {
		if (this.watchDebounceTimer) {
			clearTimeout(this.watchDebounceTimer);
			this.watchDebounceTimer = null;
		}
		if (this.fileWatcher) {
			this.fileWatcher.close();
			this.fileWatcher = null;
			console.log("MoonSync: File watcher stopped");
		}
	}

	/**
	 * Get the path to the sql-wasm.wasm file bundled with the plugin
	 */
	private getWasmPath(): string {
		// The WASM file is copied to the plugin folder during build
		const pluginDir = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
		const pluginPath = this.manifest.dir;
		if (pluginPath) {
			return join(pluginDir, pluginPath, "sql-wasm.wasm");
		}
		throw new Error("Could not determine plugin directory");
	}

	async loadSettings() {
		const data = await this.loadData();
		// Migrate old "dropboxPath" setting to "syncPath"
		if (data && data.dropboxPath && !data.syncPath) {
			data.syncPath = data.dropboxPath;
			delete data.dropboxPath;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
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
			(bookInfo: BookInfoResult) => {
				void this.createBookNote(bookInfo);
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
					const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);
					if (!(await this.app.vault.adapter.exists(coversFolder))) {
						await this.app.vault.createFolder(coversFolder);
					}

					const coverFilename = `${filename}.jpg`;
					const coverFilePath = normalizePath(`${coversFolder}/${coverFilename}`);
					const imageData = await downloadAndResizeCover(bookInfo.coverUrl);
					if (imageData) {
						await this.app.vault.adapter.writeBinary(coverFilePath, imageData);
						coverPath = `moonsync-covers/${coverFilename}`;
					}
				} catch (error) {
					console.debug(`MoonSync: Failed to download cover for "${title}"`, error);
				}
			}

			// Generate the note content
			const content = generateBookTemplate(
				title,
				bookInfo.author || "",
				coverPath,
				this.settings.showDescription ? (bookInfo.description ?? null) : null,
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

	async deleteIndex(): Promise<void> {
		const outputPath = normalizePath(this.settings.outputFolder);
		const indexPath = normalizePath(`${outputPath}/${this.settings.indexNoteTitle}.md`);
		if (await this.app.vault.adapter.exists(indexPath)) {
			const file = this.app.vault.getAbstractFileByPath(indexPath);
			if (file) {
				await this.app.vault.delete(file);
				new Notice("MoonSync: Index note deleted");
			}
		}
	}

	async deleteBase(): Promise<void> {
		const outputPath = normalizePath(this.settings.outputFolder);
		const basePath = normalizePath(`${outputPath}/${this.settings.baseFileName}.base`);
		if (await this.app.vault.adapter.exists(basePath)) {
			const file = this.app.vault.getAbstractFileByPath(basePath);
			if (file) {
				await this.app.vault.delete(file);
				new Notice("MoonSync: Base file deleted");
			}
		}
	}

	async renameIndex(oldName: string, newName: string): Promise<void> {
		const outputPath = normalizePath(this.settings.outputFolder);
		const oldPath = normalizePath(`${outputPath}/${oldName}.md`);
		const newPath = normalizePath(`${outputPath}/${newName}.md`);

		const file = this.app.vault.getAbstractFileByPath(oldPath);
		if (file) {
			await this.app.fileManager.renameFile(file, newPath);
		}
	}

	async renameBase(oldName: string, newName: string): Promise<void> {
		const outputPath = normalizePath(this.settings.outputFolder);
		const oldPath = normalizePath(`${outputPath}/${oldName}.base`);
		const newPath = normalizePath(`${outputPath}/${newName}.base`);

		const file = this.app.vault.getAbstractFileByPath(oldPath);
		if (file) {
			await this.app.fileManager.renameFile(file, newPath);
		}
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
					const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);
					if (!(await this.app.vault.adapter.exists(coversFolder))) {
						await this.app.vault.createFolder(coversFolder);
					}

					const coverFilename = `${filename}.jpg`;
					const coverFilePath = normalizePath(`${coversFolder}/${coverFilename}`);
					const imageData = await downloadCover(bookInfo.coverUrl);
					if (imageData) {
						await this.app.vault.adapter.writeBinary(coverFilePath, imageData);
						coverPath = `moonsync-covers/${coverFilename}`;
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
				console.debug(`MoonSync: Failed to fetch book info for "${exportData.title}"`, error);
			}

			// Create BookData structure
			const bookData: BookData = {
				book: {
					id: 0,
					title: exportData.title,
					author: exportData.author,
					filename: "",
					description: "",
					category: "",
					thumbFile: "",
					coverFile: "",
					addTime: "",
					favorite: "",
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
			const parsed = parseFrontmatter(content);

			if (!parsed.title) {
				new Notice("MoonSync: No title found in frontmatter");
				return;
			}

			const title = parsed.title.replace(/\\"/g, '"');
			const author = parsed.author ? parsed.author.replace(/\\"/g, '"') : "";

			// Open cover selection modal
			new SelectCoverModal(
				this.app,
				title,
				author,
				(coverUrl: string) => {
					void this.handleCoverSelected(coverUrl, title, content, activeFile);
				}
			).open();
		} catch (error) {
			console.error("MoonSync: Failed to re-fetch cover", error);
			new Notice(`MoonSync: Failed to re-fetch cover - ${error}`);
		}
	}

	private async handleCoverSelected(coverUrl: string, title: string, content: string, activeFile: TFile): Promise<void> {
		const progressNotice = new Notice("MoonSync: Downloading cover...", 0);

		try {
			// Download and save cover
			const outputPath = normalizePath(this.settings.outputFolder);
			const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);

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
			const coverPath = `moonsync-covers/${coverFilename}`;
			const updatedContent = this.updateNoteCover(content, coverPath);

			// Temporarily remove cover embed to force cache invalidation
			const contentWithoutEmbed = updatedContent.replace(/!\[\[moonsync-covers\/[^\]]+\]\]\n?/, "");
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
		const coverEmbedPattern = /!\[\[moonsync-covers\/[^\]]+\|\d+\]\]/;

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
			const parsed = parseFrontmatter(content);

			if (!parsed.title) {
				new Notice("MoonSync: No title found in frontmatter");
				return;
			}

			const title = parsed.title.replace(/\\"/g, '"');
			const author = parsed.author ? parsed.author.replace(/\\"/g, '"') : "";

			// Open metadata selection modal
			new SelectBookMetadataModal(
				this.app,
				title,
				author,
				(bookInfo: BookInfoResult) => {
					void this.handleMetadataSelected(bookInfo, title, content, activeFile);
				}
			).open();
		} catch (error) {
			console.error("MoonSync: Failed to fetch metadata", error);
			new Notice(`MoonSync: Failed to fetch metadata - ${error}`);
		}
	}

	/**
	 * Update the Hardcover link for the current note by providing a Hardcover URL
	 */
	async updateHardcoverLink(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("MoonSync: No active file");
			return;
		}

		const content = await this.app.vault.read(activeFile);
		const parsed = parseFrontmatter(content);

		if (!parsed.title) {
			new Notice("MoonSync: No title found in frontmatter");
			return;
		}

		new UpdateHardcoverModal(this.app, (url: string) => {
			void this.handleHardcoverUrlSubmit(url, content, activeFile, parsed.progress);
		}).open();
	}

	private async handleHardcoverUrlSubmit(url: string, content: string, activeFile: TFile, progress: number | null): Promise<void> {
		// Extract slug from URL
		const slugMatch = url.match(/hardcover\.app\/books\/([^/?#]+)/);
		if (!slugMatch) {
			new Notice("MoonSync: Invalid Hardcover URL. Expected format: https://hardcover.app/books/...");
			return;
		}
		const slug = slugMatch[1];

		const progressNotice = new Notice("MoonSync: Looking up book on Hardcover...", 0);

		try {
			const book = await lookupBookBySlug(slug, this.settings.hardcoverToken);
			if (!book) {
				progressNotice.hide();
				new Notice("MoonSync: Book not found on Hardcover");
				return;
			}

			// Update frontmatter
			let updated = content;
			updated = updated.replace(/^hardcover_id: .*\n/m, "");
			updated = updated.replace(/^hardcover_progress: .*\n/m, "");
			updated = updated.replace(/^hardcover_url: .*\n/m, "");
			const fields = `hardcover_id: ${book.id}\nhardcover_url: "https://hardcover.app/books/${book.slug}"`;
			updated = updated.replace(/\n---\n/, `\n${fields}\n---\n`);
			await this.app.vault.modify(activeFile, updated);

			// Sync progress if available
			if (progress !== null && progress > 0) {
				progressNotice.setMessage("MoonSync: Syncing progress to Hardcover...");
				const statusId = progress >= 99 ? 3 : 2; // STATUS_READ or STATUS_CURRENTLY_READING
				await updateHardcoverBook(book.id, statusId, progress, book.pages, this.settings.hardcoverToken);
			}

			progressNotice.hide();
			new Notice(`MoonSync: Linked to "${book.title}" on Hardcover`);
		} catch (error) {
			progressNotice.hide();
			console.error("MoonSync: Failed to update Hardcover link", error);
			new Notice(`MoonSync: Failed to update Hardcover link - ${error}`);
		}
	}

	private async handleMetadataSelected(bookInfo: BookInfoResult, title: string, content: string, activeFile: TFile): Promise<void> {
		const progressNotice = new Notice("MoonSync: Updating metadata...", 0);

		try {
			// Get the directory of the current file
			const fileDir = activeFile.parent?.path || "";
			const coversFolder = normalizePath(`${fileDir}/moonsync-covers`);
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
					coverPath = `moonsync-covers/${coverFilename}`;
				}
			}

			// Update the note with all new metadata
			const updatedContent = this.updateNoteMetadata(content, bookInfo, coverPath);

			// Temporarily remove cover embed to force cache invalidation
			const contentWithoutEmbed = updatedContent.replace(/!\[\[moonsync-covers\/[^\]]+\]\]\n?/, "");
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
			const coverEmbedPattern = /!\[\[moonsync-covers\/[^\]]+\|\d+\]\]/;

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
