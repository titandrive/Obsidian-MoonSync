import { Plugin, Notice, setIcon, normalizePath } from "obsidian";
import { MoonSyncSettings, DEFAULT_SETTINGS } from "./src/types";
import { MoonSyncSettingTab } from "./src/settings";
import { syncFromMoonReader, showSyncResults, refreshIndexNote } from "./src/sync";
import { CreateBookModal, generateBookTemplate } from "./src/modal";
import { generateFilename } from "./src/writer/markdown";
import { fetchBookInfo, downloadCover } from "./src/covers";
import { join } from "path";

export default class MoonSyncPlugin extends Plugin {
	settings: MoonSyncSettings = DEFAULT_SETTINGS;
	ribbonIconEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new MoonSyncSettingTab(this.app, this));

		// Add ribbon icon if enabled
		this.updateRibbonIcon();

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

		// Add force refresh metadata command
		this.addCommand({
			id: "force-refresh-metadata",
			name: "Force Refresh All Metadata",
			callback: () => this.forceRefreshMetadata(),
		});

		// Sync on startup if enabled
		if (this.settings.syncOnStartup) {
			// Wait a bit for Obsidian to fully load
			this.app.workspace.onLayoutReady(() => {
				setTimeout(() => this.runSync(), 2000);
			});
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
			async (title: string, author: string) => {
				await this.createBookNote(title, author);
			}
		).open();
	}

	/**
	 * Create a new book note with the given title and author
	 */
	async createBookNote(title: string, author: string): Promise<void> {
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

			// Fetch book info (cover, description, rating)
			let coverPath: string | null = null;
			let description: string | null = null;
			let rating: number | null = null;
			let ratingsCount: number | null = null;
			let fetchedAuthor: string | null = null;
		let publishedDate: string | null = null;
		let publisher: string | null = null;
		let pageCount: number | null = null;
		let genres: string[] | null = null;
		let series: string | null = null;
		let language: string | null = null;

			if (this.settings.fetchCovers || this.settings.showDescription || this.settings.showRatings) {
				try {
					const bookInfo = await fetchBookInfo(title, author);

					// Save cover if enabled
					if (this.settings.fetchCovers && bookInfo.coverUrl) {
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
					rating = bookInfo.rating;
					ratingsCount = bookInfo.ratingsCount;
					fetchedAuthor = bookInfo.author;
			publishedDate = bookInfo.publishedDate;
			publisher = bookInfo.publisher;
			pageCount = bookInfo.pageCount;
			genres = bookInfo.genres;
			series = bookInfo.series;
			language = bookInfo.language;
				} catch (error) {
					console.log(`MoonSync: Failed to fetch book info for "${title}"`, error);
				}
			}

			// Use fetched author if none provided
			const finalAuthor = author || fetchedAuthor || "";

			// Generate the note content
			const content = generateBookTemplate(
				title,
				finalAuthor,
				coverPath,
				this.settings.showDescription ? description : null,
				this.settings.showRatings ? rating : null,
				this.settings.showRatings ? ratingsCount : null,
			publishedDate,
			publisher,
			pageCount,
			genres,
			series,
			language
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

	async forceRefreshMetadata(): Promise<void> {
		const notice = new Notice("Force refreshing metadata for all books...", 0);

		try {
			// Delete cache to force refresh
			const cacheFile = normalizePath(`${this.settings.outputFolder}/.moonsync-cache.json`);
			if (await this.app.vault.adapter.exists(cacheFile)) {
				await this.app.vault.adapter.remove(cacheFile);
			}

			// Run sync
			await this.runSync();
			notice.hide();
		} catch (error) {
			notice.hide();
			new Notice(`Failed to refresh metadata: ${error}`);
		}
	}
}
