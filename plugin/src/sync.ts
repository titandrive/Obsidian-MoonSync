import { App, Notice, normalizePath } from "obsidian";
import { parseAnnotationFiles } from "./parser/annotations";
import { generateBookNote, generateFilename, generateIndexNote } from "./writer/markdown";
import { fetchBookInfo, downloadCover } from "./covers";
import { MoonSyncSettings, BookData } from "./types";
import { loadCache, saveCache, getCachedInfo, setCachedInfo, BookInfoCache } from "./cache";

export interface SyncResult {
	success: boolean;
	booksProcessed: number;
	booksCreated: number;
	booksUpdated: number;
	booksSkipped: number;
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
		booksSkipped: 0,
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

		// Parse annotation files from Cache folder (real-time sync)
		const booksWithHighlights = await parseAnnotationFiles(settings.dropboxPath);

		if (booksWithHighlights.length === 0) {
			result.errors.push("No annotation files found in .Moon+/Cache folder");
			progressNotice.hide();
			return result;
		}

		// Ensure output folder exists
		const outputPath = normalizePath(settings.outputFolder);
		if (!(await app.vault.adapter.exists(outputPath))) {
			await app.vault.createFolder(outputPath);
		}

		// Load book info cache
		const cache = await loadCache(app, outputPath);
		let cacheModified = false;

		// Process each book
		for (const bookData of booksWithHighlights) {
			try {
				const processed = await processBook(app, outputPath, bookData, settings, result, cache);
				if (processed) {
					cacheModified = true;
				}
				result.booksProcessed++;
			} catch (error) {
				result.errors.push(
					`Error processing "${bookData.book.title}": ${error}`
				);
			}
		}

		// Save cache if modified
		if (cacheModified) {
			await saveCache(app, outputPath, cache);
		}

		// Update index note if any books were created or updated
		if (result.booksCreated > 0 || result.booksUpdated > 0) {
			await updateIndexNote(app, outputPath, booksWithHighlights);
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

interface ExistingBookData {
	highlightsCount: number;
	progress: number | null;
}

/**
 * Get highlights count and progress from an existing markdown file's frontmatter
 */
async function getExistingBookData(app: App, filePath: string): Promise<ExistingBookData | null> {
	try {
		if (!(await app.vault.adapter.exists(filePath))) {
			return null;
		}

		const content = await app.vault.adapter.read(filePath);

		const countMatch = content.match(/^highlights_count:\s*(\d+)/m);
		const progressMatch = content.match(/^progress:\s*"?(\d+(?:\.\d+)?)/m);

		if (countMatch) {
			return {
				highlightsCount: parseInt(countMatch[1], 10),
				progress: progressMatch ? parseFloat(progressMatch[1]) : null,
			};
		}
	} catch {
		// File doesn't exist or can't be read
	}
	return null;
}

/**
 * Process a single book - create or update its note
 * Returns true if cache was modified
 */
async function processBook(
	app: App,
	outputPath: string,
	bookData: BookData,
	settings: MoonSyncSettings,
	result: SyncResult,
	cache: BookInfoCache
): Promise<boolean> {
	const filename = generateFilename(bookData.book.title);
	const filePath = normalizePath(`${outputPath}/${filename}.md`);
	let cacheModified = false;

	// Check if book has changed (compare highlights count and progress)
	const existingData = await getExistingBookData(app, filePath);
	const fileExists = existingData !== null;

	if (fileExists) {
		const highlightsUnchanged = existingData.highlightsCount === bookData.highlights.length;
		const progressUnchanged = existingData.progress === bookData.progress;

		if (highlightsUnchanged && progressUnchanged) {
			// Book hasn't changed, skip
			result.booksSkipped++;
			return false;
		}
	}

	// Fetch book info (cover, description, and rating) from external sources
	if (settings.fetchCovers || settings.showDescription || settings.showRatings) {
		const coverFilename = `${filename}.jpg`;
		const coversFolder = normalizePath(`${outputPath}/covers`);
		const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);

		const coverExists = await app.vault.adapter.exists(coverPath);

		// Check cache first for description and rating
		const cachedInfo = getCachedInfo(cache, bookData.book.title, bookData.book.author);

		if (cachedInfo) {
			// Use cached data
			if (cachedInfo.description) {
				bookData.fetchedDescription = cachedInfo.description;
			}
			if (cachedInfo.rating !== null) {
				bookData.rating = cachedInfo.rating;
			}
			if (cachedInfo.ratingsCount !== null) {
				bookData.ratingsCount = cachedInfo.ratingsCount;
			}
			if (!bookData.book.author && cachedInfo.author) {
				bookData.book.author = cachedInfo.author;
			}
		}

		// Fetch from APIs only if we need cover (and don't have it) OR we don't have cached data
		const needsApiFetch = (settings.fetchCovers && !coverExists) || !cachedInfo;

		if (needsApiFetch) {
			try {
				const bookInfo = await fetchBookInfo(
					bookData.book.title,
					bookData.book.author
				);

				// Save cover if fetched and enabled
				if (settings.fetchCovers && bookInfo.coverUrl && !coverExists) {
					// Ensure covers folder exists
					if (!(await app.vault.adapter.exists(coversFolder))) {
						await app.vault.createFolder(coversFolder);
					}

					// Download and save cover
					const imageData = await downloadCover(bookInfo.coverUrl);
					if (imageData) {
						await app.vault.adapter.writeBinary(coverPath, imageData);
						bookData.coverPath = `covers/${coverFilename}`;
					}
				}

				// Use fetched description if available
				if (bookInfo.description) {
					bookData.fetchedDescription = bookInfo.description;
				}

				// Use fetched rating if available
				if (bookInfo.rating !== null) {
					bookData.rating = bookInfo.rating;
				}
				if (bookInfo.ratingsCount !== null) {
					bookData.ratingsCount = bookInfo.ratingsCount;
				}

				// Use fetched author if book has no author from filename
				if (!bookData.book.author && bookInfo.author) {
					bookData.book.author = bookInfo.author;
				}

				// Update cache
				setCachedInfo(cache, bookData.book.title, bookData.book.author, {
					description: bookInfo.description,
					rating: bookInfo.rating,
					ratingsCount: bookInfo.ratingsCount,
					author: bookInfo.author,
				});
				cacheModified = true;
			} catch (error) {
				console.log(`MoonSync: Failed to fetch book info for "${bookData.book.title}"`, error);
			}
		}

		// Set cover path if cover already exists
		if (settings.fetchCovers && coverExists) {
			bookData.coverPath = `covers/${coverFilename}`;
		}
	}

	const markdown = generateBookNote(bookData, settings);

	if (fileExists) {
		// Update existing file
		await app.vault.adapter.write(filePath, markdown);
		result.booksUpdated++;
	} else {
		// Create new file
		await app.vault.create(filePath, markdown);
		result.booksCreated++;
	}

	return cacheModified;
}

const INDEX_FILENAME = "A. Library Index";

/**
 * Update the index note with summary and links to all books
 */
async function updateIndexNote(app: App, outputPath: string, books: BookData[]): Promise<void> {
	const indexPath = normalizePath(`${outputPath}/${INDEX_FILENAME}.md`);
	const markdown = generateIndexNote(books);

	if (await app.vault.adapter.exists(indexPath)) {
		await app.vault.adapter.write(indexPath, markdown);
	} else {
		await app.vault.create(indexPath, markdown);
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
			const parts = [];
			if (result.booksCreated > 0) parts.push(`${result.booksCreated} new`);
			if (result.booksUpdated > 0) parts.push(`${result.booksUpdated} updated`);
			if (result.booksSkipped > 0) parts.push(`${result.booksSkipped} unchanged`);

			new Notice(`MoonSync: ${parts.join(", ")}`);
		}
	} else {
		new Notice(`MoonSync: Sync failed - ${result.errors[0]}`);
	}

	// Log all errors to console
	for (const error of result.errors) {
		console.error("MoonSync:", error);
	}
}
