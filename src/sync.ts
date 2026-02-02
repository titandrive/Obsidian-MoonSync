import { App, Notice, normalizePath } from "obsidian";
import { findLatestBackup, extractMrpro } from "./parser/mrpro";
import { parseDatabase } from "./parser/database";
import { generateBookNote, generateFilename } from "./writer/markdown";
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

	try {
		// Validate settings
		if (!settings.dropboxPath) {
			result.errors.push("Dropbox path not configured");
			return result;
		}

		// Find the Backup folder within the .Moon+ directory
		const backupDir = join(settings.dropboxPath, ".Moon+", "Backup");

		// Find the latest backup
		new Notice("MoonSync: Finding latest backup...");
		const backupPath = await findLatestBackup(backupDir);

		if (!backupPath) {
			result.errors.push(`No .mrpro backup files found in ${backupDir}`);
			return result;
		}

		// Extract the database from the backup
		new Notice("MoonSync: Extracting database...");
		const mrproContents = await extractMrpro(backupPath);

		// Parse the database
		new Notice("MoonSync: Parsing book data...");
		const bookDataList = await parseDatabase(mrproContents.database, wasmPath);

		// Filter to only books with highlights
		const booksWithHighlights = bookDataList.filter(
			(b) => b.highlights.length > 0
		);

		if (booksWithHighlights.length === 0) {
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

		result.success = true;
		return result;
	} catch (error) {
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
