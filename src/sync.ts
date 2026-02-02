import { App, Notice, normalizePath } from "obsidian";
import { findLatestBackup, extractMrpro } from "./parser/mrpro";
import { parseDatabase } from "./parser/database";
import { generateBookNote, generateFilename } from "./writer/markdown";
import { fetchBookCover, downloadCover } from "./covers";
import { MoonSyncSettings, BookData } from "./types";
import { join } from "path";

export interface SyncResult {
	success: boolean;
	booksProcessed: number;
	booksCreated: number;
	booksUpdated: number;
	errors: string[];
}

/**
 * Main sync function that orchestrates the entire sync process
 */
export async function syncFromMoonReader(
	app: App,
	settings: MoonSyncSettings,
	wasmPath: string
): Promise<SyncResult> {
	const result: SyncResult = {
		success: false,
		booksProcessed: 0,
		booksCreated: 0,
		booksUpdated: 0,
		errors: [],
	};

	// Single progress notice that we'll hide when done
	const progressNotice = new Notice("MoonSync: Syncing...", 0);

	try {
		// Validate settings
		if (!settings.dropboxPath) {
			result.errors.push("Dropbox path not configured");
			progressNotice.hide();
			return result;
		}

		// Find the Backup folder within the .Moon+ directory
		const backupDir = join(settings.dropboxPath, ".Moon+", "Backup");

		// Find the latest backup
		const backupPath = await findLatestBackup(backupDir);

		if (!backupPath) {
			result.errors.push(`No .mrpro backup files found in ${backupDir}`);
			progressNotice.hide();
			return result;
		}

		// Extract the database from the backup
		const mrproContents = await extractMrpro(backupPath);

		// Parse the database
		const bookDataList = await parseDatabase(mrproContents.database, wasmPath);

		// Filter to only books with highlights
		const booksWithHighlights = bookDataList.filter(
			(b) => b.highlights.length > 0
		);

		if (booksWithHighlights.length === 0) {
			progressNotice.hide();
			new Notice("MoonSync: No books with highlights found");
			result.success = true;
			return result;
		}

		// Ensure output folder exists
		const outputPath = normalizePath(settings.outputFolder);
		if (!(await app.vault.adapter.exists(outputPath))) {
			await app.vault.createFolder(outputPath);
		}

		// Process each book
		for (const bookData of booksWithHighlights) {
			try {
				await processBook(app, outputPath, bookData, settings, result);
				result.booksProcessed++;
			} catch (error) {
				result.errors.push(
					`Error processing "${bookData.book.title}": ${error}`
				);
			}
		}

		progressNotice.hide();
		result.success = true;
		return result;
	} catch (error) {
		progressNotice.hide();
		result.errors.push(`Sync failed: ${error}`);
		return result;
	}
}

/**
 * Process a single book - create or update its note
 */
async function processBook(
	app: App,
	outputPath: string,
	bookData: BookData,
	settings: MoonSyncSettings,
	result: SyncResult
): Promise<void> {
	const filename = generateFilename(bookData.book.title);
	const filePath = normalizePath(`${outputPath}/${filename}.md`);

	// Fetch and save cover if enabled
	if (settings.fetchCovers) {
		const coverFilename = `${filename}.jpg`;
		const coversFolder = normalizePath(`${outputPath}/covers`);
		const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);

		// Only fetch if cover doesn't exist
		if (!(await app.vault.adapter.exists(coverPath))) {
			try {
				const coverResult = await fetchBookCover(
					bookData.book.title,
					bookData.book.author
				);

				if (coverResult.url) {
					// Ensure covers folder exists
					if (!(await app.vault.adapter.exists(coversFolder))) {
						await app.vault.createFolder(coversFolder);
					}

					// Download and save cover
					const imageData = await downloadCover(coverResult.url);
					if (imageData) {
						await app.vault.adapter.writeBinary(coverPath, imageData);
						bookData.coverPath = `covers/${coverFilename}`;
					}
				}
			} catch (error) {
				console.log(`MoonSync: Failed to fetch cover for "${bookData.book.title}"`, error);
			}
		} else {
			// Cover already exists
			bookData.coverPath = `covers/${coverFilename}`;
		}
	}

	const markdown = generateBookNote(bookData, settings);

	if (await app.vault.adapter.exists(filePath)) {
		// Update existing file
		await app.vault.adapter.write(filePath, markdown);
		result.booksUpdated++;
	} else {
		// Create new file
		await app.vault.create(filePath, markdown);
		result.booksCreated++;
	}
}

/**
 * Display sync results to the user
 */
export function showSyncResults(result: SyncResult): void {
	if (result.success) {
		if (result.booksProcessed === 0) {
			new Notice("MoonSync: No books with highlights to sync");
		} else {
			new Notice(
				`MoonSync: Synced ${result.booksProcessed} books ` +
					`(${result.booksCreated} new, ${result.booksUpdated} updated)`
			);
		}
	} else {
		new Notice(`MoonSync: Sync failed - ${result.errors[0]}`);
	}

	// Log all errors to console
	for (const error of result.errors) {
		console.error("MoonSync:", error);
	}
}
