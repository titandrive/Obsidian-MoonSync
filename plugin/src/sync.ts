import { App, Notice, normalizePath } from "obsidian";
import { SyncSummaryModal } from "./modal";
import { parseAnnotationFiles } from "./parser/annotations";
import { generateBookNote, generateFilename, generateIndexNote, generateBaseFile, formatHighlight } from "./writer/markdown";
import { fetchBookInfo, downloadCover, BookInfoResult } from "./covers";
import { MoonSyncSettings, BookData } from "./types";
import { loadCache, saveCache, getCachedInfo, setCachedInfo, BookInfoCache } from "./cache";
import { scanAllBookNotes, mergeBookLists } from "./scanner";

export interface SyncResult {
	success: boolean;
	booksProcessed: number;
	booksCreated: number;
	booksUpdated: number;
	booksSkipped: number;
	manualBooksAdded: number;
	totalHighlights: number;
	totalNotes: number;
	isFirstSync: boolean;
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
		manualBooksAdded: 0,
		totalHighlights: 0,
		totalNotes: 0,
		isFirstSync: false,
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
		const booksWithHighlights = await parseAnnotationFiles(settings.dropboxPath, settings.trackBooksWithoutHighlights);

		if (booksWithHighlights.length === 0) {
			result.errors.push("No annotation files found in .Moon+/Cache folder");
			progressNotice.hide();
			return result;
		}

		// Check if output folder exists (for first sync detection)
		const outputPath = normalizePath(settings.outputFolder);
		const outputFolderExisted = await app.vault.adapter.exists(outputPath);
		result.isFirstSync = !outputFolderExisted;

		// Ensure output folder exists
		if (!outputFolderExisted) {
			await app.vault.createFolder(outputPath);
		}

		// Calculate total highlights and notes
		result.totalHighlights = booksWithHighlights.reduce((sum, b) => sum + b.highlights.length, 0);
		result.totalNotes = booksWithHighlights.reduce(
			(sum, b) => sum + b.highlights.filter((h) => h.note && h.note.trim()).length,
			0
		);

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

		// Process custom books (books not from Moon Reader database)
		const scannedBooks = await scanAllBookNotes(app, outputPath);
		const customBooks = scannedBooks.filter(book => !book.isMoonReader);

		for (const customBook of customBooks) {
			try {
				const processed = await processCustomBook(app, outputPath, customBook, settings, result, cache);
				if (processed) {
					cacheModified = true;
				}
			} catch (error) {
				result.errors.push(
					`Error processing custom book "${customBook.title}": ${error}`
				);
			}
		}

		// Save cache if modified
		if (cacheModified) {
			await saveCache(app, outputPath, cache);
		}

		// Update index note if enabled
		if (settings.showIndex) {
			const indexPath = normalizePath(`${outputPath}/${settings.indexNoteTitle}.md`);
			const indexExists = await app.vault.adapter.exists(indexPath);

			// Check if there are manually-created book notes by comparing counts
			const scannedBooks = await scanAllBookNotes(app, outputPath);
			const indexFilename = `${settings.indexNoteTitle}.md`;
			const filteredScanned = scannedBooks.filter((b) => !b.filePath.endsWith(indexFilename));
			const totalBookNotes = filteredScanned.length;
			const manualBookCount = totalBookNotes - booksWithHighlights.length;
			const hasManualBooks = manualBookCount > 0;

			// Track manual books for reporting
			if (hasManualBooks) {
				result.manualBooksAdded = manualBookCount;
			}

			// Regenerate if: books changed, index doesn't exist, or manual books detected
			if (result.booksCreated > 0 || result.booksUpdated > 0 || !indexExists || hasManualBooks) {
				// Populate cover paths for all books (for the collage)
				const coversFolder = normalizePath(`${outputPath}/covers`);
				for (const bookData of booksWithHighlights) {
					if (!bookData.coverPath) {
						const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
						const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);
						if (await app.vault.adapter.exists(coverPath)) {
							bookData.coverPath = `covers/${coverFilename}`;
						}
					}
				}
				await updateIndexNote(app, outputPath, booksWithHighlights, settings);
			}
		}

		// Update base file if enabled
		if (settings.generateBaseFile) {
			const baseFilePath = normalizePath(`${outputPath}/${settings.baseFileName}.base`);
			const baseExists = await app.vault.adapter.exists(baseFilePath);

			// Regenerate if: books changed or file doesn't exist
			if (result.booksCreated > 0 || result.booksUpdated > 0 || !baseExists) {
				await updateBaseFile(app, outputPath, settings);
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

interface ExistingBookData {
	highlightsCount: number;
	progress: number | null;
	isManualNote: boolean;
	hasCustomMetadata: boolean;
	fullContent?: string;
}

/**
 * Get highlights count, progress, and manual note status from an existing markdown file
 */
async function getExistingBookData(app: App, filePath: string): Promise<ExistingBookData | null> {
	try {
		if (!(await app.vault.adapter.exists(filePath))) {
			return null;
		}

		const content = await app.vault.adapter.read(filePath);

		const countMatch = content.match(/^highlights_count:\s*(\d+)/m);
		const progressMatch = content.match(/^progress:\s*"?(\d+(?:\.\d+)?)/m);
		const manualNoteMatch = content.match(/^manual_note:\s*true/m);
		const customMetadataMatch = content.match(/^custom_metadata:\s*true/m);

		if (countMatch) {
			return {
				highlightsCount: parseInt(countMatch[1], 10),
				progress: progressMatch ? parseFloat(progressMatch[1]) : null,
				isManualNote: !!manualNoteMatch,
				hasCustomMetadata: !!customMetadataMatch,
				fullContent: content,
			};
		}
	} catch {
		// File doesn't exist or can't be read
	}
	return null;
}

/**
 * Merge a manual note with Moon+ Reader data
 * Preserves manual content and adds Moon+ Reader highlights section
 */
function mergeManualNoteWithMoonReader(
	existingContent: string,
	bookData: BookData,
	settings: MoonSyncSettings
): string {
	const lines: string[] = [];

	// Parse existing frontmatter and content
	const frontmatterMatch = existingContent.match(/^---\n([\s\S]*?)\n---/);
	const contentAfterFrontmatter = frontmatterMatch
		? existingContent.slice(frontmatterMatch[0].length).trim()
		: existingContent.trim();

	// Start building new frontmatter
	lines.push("---");

	// Preserve existing frontmatter fields, update with Moon+ Reader data
	if (frontmatterMatch) {
		const frontmatter = frontmatterMatch[1];
		const frontmatterLines = frontmatter.split("\n");

		for (const line of frontmatterLines) {
			// Skip fields that Moon+ Reader will update
			if (line.startsWith("progress:") ||
			    line.startsWith("current_chapter:") ||
			    line.startsWith("highlights_count:") ||
			    line.startsWith("notes_count:") ||
			    line.startsWith("last_synced:") ||
			    line.startsWith("manual_note:") ||
			    line.startsWith("published_date:") ||
			    line.startsWith("publisher:") ||
			    line.startsWith("page_count:") ||
			    line.startsWith("genres:") ||
			    line.startsWith("series:") ||
			    line.startsWith("language:") ||
			    line.startsWith("rating:") ||
			    line.startsWith("ratings_count:") ||
			    line.trim().startsWith("-")) { // Skip genre array items
				continue;
			}
			lines.push(line);
		}
	}

	// Add Moon+ Reader metadata
	lines.push(`last_synced: ${new Date().toISOString().split("T")[0]}`);
	lines.push(`highlights_count: ${bookData.highlights.length}`);
	const notesCount = bookData.highlights.filter((h) => h.note && h.note.trim()).length;
	lines.push(`notes_count: ${notesCount}`);

	if (settings.showProgress && bookData.progress !== null) {
		lines.push(`progress: "${bookData.progress.toFixed(1)}%"`);
		if (bookData.currentChapter) {
			lines.push(`current_chapter: ${bookData.currentChapter}`);
		}
	}

	// Add fetched metadata if available
	if (bookData.publishedDate) {
		lines.push(`published_date: "${bookData.publishedDate.replace(/"/g, '\\"')}"`);
	}
	if (bookData.publisher) {
		lines.push(`publisher: "${bookData.publisher.replace(/"/g, '\\"')}"`);
	}
	if (bookData.pageCount !== null) {
		lines.push(`page_count: ${bookData.pageCount}`);
	}
	if (bookData.genres && bookData.genres.length > 0) {
		lines.push(`genres:`);
		for (const genre of bookData.genres) {
			lines.push(`  - "${genre.replace(/"/g, '\\"')}"`);
		}
	}
	if (bookData.series) {
		lines.push(`series: "${bookData.series.replace(/"/g, '\\"')}"`);
	}
	if (bookData.language) {
		lines.push(`language: "${bookData.language}"`);
	}

	lines.push("---");
	lines.push("");

	// Add existing content
	lines.push(contentAfterFrontmatter);
	lines.push("");

	// Add Moon+ Reader highlights section
	lines.push("## Moon+ Reader Highlights");
	lines.push("");

	// Add progress info if enabled
	if (settings.showReadingProgress && (bookData.progress !== null || bookData.currentChapter !== null)) {
		lines.push("**Reading Progress:**");
		if (bookData.progress !== null) {
			lines.push(`- Progress: ${bookData.progress.toFixed(1)}%`);
		}
		if (bookData.currentChapter !== null) {
			lines.push(`- Chapter: ${bookData.currentChapter}`);
		}
		lines.push("");
	}

	// Generate highlights
	for (const highlight of bookData.highlights) {
		lines.push(formatHighlight(highlight, settings.showHighlightColors, settings.showNotes));
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Merge existing note with custom metadata with new highlights from Moon+ Reader
 * Preserves all metadata (title, author, cover, description, etc.) and replaces only highlights
 */
function mergeCustomMetadataWithHighlights(
	existingContent: string,
	bookData: BookData,
	settings: MoonSyncSettings
): string {
	const lines: string[] = [];

	// Parse existing frontmatter and content
	const frontmatterMatch = existingContent.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) {
		// No frontmatter, fall back to generating new note
		return generateBookNote(bookData, settings);
	}

	const frontmatter = frontmatterMatch[1];
	let contentAfterFrontmatter = existingContent.slice(frontmatterMatch[0].length);

	// Start building new frontmatter - preserve all existing fields except sync stats
	lines.push("---");

	const frontmatterLines = frontmatter.split("\n");
	let skipNextLines = false;

	for (const line of frontmatterLines) {
		// Skip array items from previous field we're skipping
		if (line.trim().startsWith("-") && skipNextLines) {
			continue;
		}
		skipNextLines = false;

		// Skip fields that sync will update (stats only, not metadata)
		if (line.startsWith("progress:") ||
		    line.startsWith("current_chapter:") ||
		    line.startsWith("highlights_count:") ||
		    line.startsWith("notes_count:") ||
		    line.startsWith("last_synced:")) {
			continue;
		}

		lines.push(line);
	}

	// Add/update sync stats
	lines.push(`last_synced: ${new Date().toISOString().split("T")[0]}`);
	lines.push(`highlights_count: ${bookData.highlights.length}`);
	const notesCount = bookData.highlights.filter((h) => h.note && h.note.trim()).length;
	lines.push(`notes_count: ${notesCount}`);

	if (settings.showProgress && bookData.progress !== null) {
		lines.push(`progress: "${bookData.progress.toFixed(1)}%"`);
		if (bookData.currentChapter) {
			lines.push(`current_chapter: ${bookData.currentChapter}`);
		}
	}

	lines.push("---");

	// Replace just the Highlights section, preserve everything else
	const highlightsHeaderPattern = /\n## Highlights\n/;
	const nextSectionPattern = /\n## [^H]/; // Next section that's not Highlights

	const highlightsMatch = contentAfterFrontmatter.match(highlightsHeaderPattern);

	if (highlightsMatch && highlightsMatch.index !== undefined) {
		// Keep content before Highlights
		const beforeHighlights = contentAfterFrontmatter.slice(0, highlightsMatch.index);
		lines.push(beforeHighlights);

		// Check if there's content after Highlights section
		const afterHighlightsStart = highlightsMatch.index + highlightsMatch[0].length;
		const remainingContent = contentAfterFrontmatter.slice(afterHighlightsStart);
		const nextSectionMatch = remainingContent.match(nextSectionPattern);

		let afterHighlights = "";
		if (nextSectionMatch && nextSectionMatch.index !== undefined) {
			afterHighlights = remainingContent.slice(nextSectionMatch.index);
		}

		// Generate new Highlights section
		lines.push("");
		lines.push("## Highlights");
		lines.push("");

		if (settings.showReadingProgress && (bookData.progress !== null || bookData.currentChapter !== null)) {
			lines.push("**Reading Progress:**");
			if (bookData.progress !== null) {
				lines.push(`- Progress: ${bookData.progress.toFixed(1)}%`);
			}
			if (bookData.currentChapter !== null) {
				lines.push(`- Chapter: ${bookData.currentChapter}`);
			}
			lines.push("");
		}

		for (const highlight of bookData.highlights) {
			lines.push(formatHighlight(highlight, settings.showHighlightColors, settings.showNotes));
			lines.push("");
		}

		// Add content after Highlights if any
		if (afterHighlights) {
			lines.push(afterHighlights);
		}
	} else {
		// No Highlights section found, append to end
		lines.push(contentAfterFrontmatter);
		lines.push("");
		lines.push("## Highlights");
		lines.push("");

		for (const highlight of bookData.highlights) {
			lines.push(formatHighlight(highlight, settings.showHighlightColors, settings.showNotes));
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Calculate similarity between two strings (0 = completely different, 1 = identical)
 * Uses Levenshtein distance for fuzzy matching
 */
function calculateSimilarity(str1: string, str2: string): number {
	const s1 = str1.toLowerCase();
	const s2 = str2.toLowerCase();

	if (s1 === s2) return 1;

	const len1 = s1.length;
	const len2 = s2.length;

	if (len1 === 0) return len2 === 0 ? 1 : 0;
	if (len2 === 0) return 0;

	// Create distance matrix
	const matrix: number[][] = [];
	for (let i = 0; i <= len1; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= len2; j++) {
		matrix[0][j] = j;
	}

	// Calculate Levenshtein distance
	for (let i = 1; i <= len1; i++) {
		for (let j = 1; j <= len2; j++) {
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,     // deletion
				matrix[i][j - 1] + 1,     // insertion
				matrix[i - 1][j - 1] + cost // substitution
			);
		}
	}

	const distance = matrix[len1][len2];
	const maxLen = Math.max(len1, len2);
	return 1 - (distance / maxLen);
}

/**
 * Find existing file with fuzzy matching by comparing frontmatter titles
 * Returns the actual file path if found, otherwise returns the preferred path
 * Uses 85% similarity threshold for fuzzy matching
 */
/**
 * Normalize a book title for fuzzy matching by removing file extensions
 * Note: Author stripping is now handled at source in annotations.ts using known author data
 */
function normalizeBookTitle(title: string): string {
	return title
		// Remove file extensions
		.replace(/\.(epub|mobi|pdf|azw3?|fb2|txt)$/i, '')
		.trim();
}

async function findExistingFile(app: App, outputPath: string, preferredFilename: string, bookTitle: string): Promise<string> {
	const preferredPath = normalizePath(`${outputPath}/${preferredFilename}.md`);

	// Check if preferred path exists (fast path)
	if (await app.vault.adapter.exists(preferredPath)) {
		return preferredPath;
	}

	// Normalize the book title for comparison
	const normalizedBookTitle = normalizeBookTitle(bookTitle);

	// Fuzzy match against existing files by comparing frontmatter titles
	try {
		const listing = await app.vault.adapter.list(normalizePath(outputPath));
		const SIMILARITY_THRESHOLD = 0.80;
		let bestMatch: { path: string; similarity: number } | null = null;

		for (const filePath of listing.files) {
			if (!filePath.endsWith('.md')) continue;

			// Read file to get frontmatter title
			try {
				const content = await app.vault.adapter.read(filePath);

				// Extract title from frontmatter - handle both quoted and unquoted
				// Match: title: "value" or title: value
				const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
				if (!frontmatterMatch) continue;

				const frontmatter = frontmatterMatch[1];
				const titleMatch = frontmatter.match(/^title:\s*"?(.+?)"?\s*$/m);

				if (titleMatch) {
					// Remove escaped quotes from YAML value
					let existingTitle = titleMatch[1].trim().replace(/\\"/g, '"');
					const normalizedExistingTitle = normalizeBookTitle(existingTitle);
					const similarity = calculateSimilarity(normalizedBookTitle, normalizedExistingTitle);

					if (similarity >= SIMILARITY_THRESHOLD) {
						if (!bestMatch || similarity > bestMatch.similarity) {
							bestMatch = { path: filePath, similarity };
						}
					}
				}
			} catch (error) {
				// Failed to read file, skip it
				continue;
			}
		}

		if (bestMatch) {
			console.log(`Best match: "${bestMatch.path}" (${(bestMatch.similarity * 100).toFixed(1)}%)`);

			if (bestMatch.path !== preferredPath) {
				// Found a match with different filename - rename to preferred filename
				try {
						await app.vault.adapter.rename(bestMatch.path, preferredPath);
					return preferredPath;
				} catch (error) {
						return bestMatch.path;
				}
			}
			return bestMatch.path;
		}
	} catch (error) {
		// Error listing or renaming, fall through to preferred path
	}

	return preferredPath;
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
	// Store original title for cache key (before Google Books updates it)
	const originalTitle = bookData.book.title;
	const originalAuthor = bookData.book.author;

	const filename = generateFilename(bookData.book.title);
	const filePath = await findExistingFile(app, outputPath, filename, bookData.book.title);
	let cacheModified = false;

	// Check cache first to determine if we need to fetch metadata
	const cachedInfo = getCachedInfo(cache, originalTitle, originalAuthor);

	// Check if we've already attempted to fetch metadata
	// Once we've tried fetching (fields are !== undefined), don't keep trying
	const hasAttemptedFetch = cachedInfo && (
		cachedInfo.publishedDate !== undefined &&
		cachedInfo.publisher !== undefined &&
		cachedInfo.pageCount !== undefined &&
		cachedInfo.genres !== undefined &&
		cachedInfo.series !== undefined &&
		cachedInfo.language !== undefined
	);

	// Check if book has changed (compare highlights count and progress)
	const existingData = await getExistingBookData(app, filePath);
	const fileExists = existingData !== null;

	if (fileExists) {
		const highlightsUnchanged = existingData.highlightsCount === bookData.highlights.length;
		const progressUnchanged = existingData.progress === bookData.progress;

		console.log(`[${bookData.book.title}] Existing: ${existingData.highlightsCount} highlights, ${existingData.progress}% | New: ${bookData.highlights.length} highlights, ${bookData.progress}%`);
		console.log(`[${bookData.book.title}] Unchanged: highlights=${highlightsUnchanged}, progress=${progressUnchanged}, hasAttemptedFetch=${hasAttemptedFetch}`);

		// Only skip if: nothing changed AND we've already attempted to fetch metadata
		// Once we've tried fetching once, don't keep retrying if data isn't available
		if (highlightsUnchanged && progressUnchanged && hasAttemptedFetch) {
			// Book hasn't changed and we have complete cached data, skip
			result.booksSkipped++;
			return false;
		}
	}

	// Always fetch metadata if incomplete, regardless of settings
	// Settings only control what gets displayed, not what gets cached
	const shouldFetchMetadata = true; // Always fetch to keep cache complete
	if (shouldFetchMetadata) {
		const coverFilename = `${filename}.jpg`;
		const coversFolder = normalizePath(`${outputPath}/covers`);
		const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);

		const coverExists = await app.vault.adapter.exists(coverPath);

		if (cachedInfo) {
			// Use cached data
			if (cachedInfo.description) {
				bookData.fetchedDescription = cachedInfo.description;
			}
			if (!bookData.book.author && cachedInfo.author) {
				bookData.book.author = cachedInfo.author;
			}
			if (cachedInfo.publishedDate) {
				bookData.publishedDate = cachedInfo.publishedDate;
			}
			if (cachedInfo.publisher) {
				bookData.publisher = cachedInfo.publisher;
			}
			if (cachedInfo.pageCount !== null) {
				bookData.pageCount = cachedInfo.pageCount;
			}
			if (cachedInfo.genres) {
				bookData.genres = cachedInfo.genres;
			}
			if (cachedInfo.series) {
				bookData.series = cachedInfo.series;
			}
			if (cachedInfo.language) {
				bookData.language = cachedInfo.language;
			}
		}

	// Fetch from APIs if we need cover, description, ratings, or other metadata
		const needsApiFetch = !coverExists || !hasAttemptedFetch;

			if (needsApiFetch) {
			try {
				const bookInfo = await fetchBookInfo(
					bookData.book.title,
					bookData.book.author
				);

				// Save cover if fetched (covers are always downloaded)
				if (bookInfo.coverUrl && !coverExists) {
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

				// Use fetched author if book has no author from filename
				if (!bookData.book.author && bookInfo.author) {
					bookData.book.author = bookInfo.author;
				}

				// Don't use API title for Moon Reader books - epub metadata is more reliable
				// API titles can be truncated or contain junk

				// Use fetched metadata
				if (bookInfo.publishedDate) {
					bookData.publishedDate = bookInfo.publishedDate;
				}
				if (bookInfo.publisher) {
					bookData.publisher = bookInfo.publisher;
				}
				if (bookInfo.pageCount !== null) {
					bookData.pageCount = bookInfo.pageCount;
				}
				if (bookInfo.genres) {
					bookData.genres = bookInfo.genres;
				}
				if (bookInfo.series) {
					bookData.series = bookInfo.series;
				}
				if (bookInfo.language) {
					bookData.language = bookInfo.language;
				}

				// Update cache - store original epub title for Moon Reader books
				setCachedInfo(cache, originalTitle, originalAuthor, {
					title: originalTitle,
					description: bookInfo.description,
					author: bookInfo.author,
					publishedDate: bookInfo.publishedDate,
					publisher: bookInfo.publisher,
					pageCount: bookInfo.pageCount,
					genres: bookInfo.genres,
					series: bookInfo.series,
					language: bookInfo.language,
				});
				cacheModified = true;
			} catch (error) {
				console.log(`MoonSync: Failed to fetch book info for "${bookData.book.title}"`, error);
			}
		}

		// Set cover path if cover already exists
		if (coverExists) {
			bookData.coverPath = `covers/${coverFilename}`;
		}
	}

	// Generate or merge markdown content
	let markdown: string;

	if (fileExists && existingData.isManualNote) {
		// Merge manual note with Moon+ Reader data
		markdown = mergeManualNoteWithMoonReader(existingData.fullContent!, bookData, settings);
	} else if (fileExists && existingData.hasCustomMetadata) {
		// Preserve custom metadata, only update highlights
		markdown = mergeCustomMetadataWithHighlights(existingData.fullContent!, bookData, settings);
	} else {
		// Generate new Moon+ Reader note
		markdown = generateBookNote(bookData, settings);
	}

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

/**
 * Process a custom book (not from Moon Reader database) to fetch and update metadata
 */
async function processCustomBook(
	app: App,
	outputPath: string,
	scannedBook: { title: string; author: string | null; filePath: string },
	settings: MoonSyncSettings,
	result: SyncResult,
	cache: BookInfoCache
): Promise<boolean> {
	let cacheModified = false;

	// Check if note has custom_metadata flag - if so, skip metadata updates
	try {
		const content = await app.vault.adapter.read(scannedBook.filePath);
		if (/^custom_metadata:\s*true/m.test(content)) {
			// User has set custom metadata, don't overwrite
			return false;
		}
	} catch {
		// File read failed, continue with normal processing
	}

	// Check if we need to fetch metadata
	const cachedInfo = getCachedInfo(cache, scannedBook.title, scannedBook.author || "");

	// Skip if we've already attempted to fetch metadata
	// Once we've tried (fields are !== undefined), don't keep trying
	if (cachedInfo &&
	    cachedInfo.publishedDate !== undefined &&
	    cachedInfo.publisher !== undefined &&
	    cachedInfo.pageCount !== undefined &&
	    cachedInfo.genres !== undefined &&
	    cachedInfo.series !== undefined &&
	    cachedInfo.language !== undefined) {
		// Already attempted fetch, skip API calls
		return false;
	}

	// Fetch metadata from APIs
	const author = scannedBook.author || "Unknown";
	const bookInfo = await fetchBookInfo(scannedBook.title, author);

	// Only update if we got new information
		if (bookInfo.coverUrl || bookInfo.description ||
		    bookInfo.publishedDate || bookInfo.publisher || bookInfo.pageCount !== null ||
		    bookInfo.genres || bookInfo.series || bookInfo.language) {

			// Read existing file
			const content = await app.vault.adapter.read(scannedBook.filePath);

			// Update frontmatter with new metadata
			const updatedContent = updateCustomBookFrontmatter(content, bookInfo, settings);

			// Write back to file
			await app.vault.adapter.write(scannedBook.filePath, updatedContent);

			// Update cache
			setCachedInfo(cache, scannedBook.title, scannedBook.author, {
				title: bookInfo.title, // Canonical title from Google Books/Open Library
				description: bookInfo.description,
				author: bookInfo.author,
				publishedDate: bookInfo.publishedDate,
				publisher: bookInfo.publisher,
				pageCount: bookInfo.pageCount,
				genres: bookInfo.genres,
				series: bookInfo.series,
				language: bookInfo.language
			});

			cacheModified = true;
			result.booksUpdated++;

			// Download cover if available and not already present
			if (bookInfo.coverUrl) {
				const coverFilename = `${generateFilename(scannedBook.title)}.jpg`;
				const coversFolder = normalizePath(`${outputPath}/covers`);
				const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);

				if (!(await app.vault.adapter.exists(coverPath))) {
					// Create covers folder if needed
					if (!(await app.vault.adapter.exists(coversFolder))) {
						await app.vault.createFolder(coversFolder);
					}

					// Download and save cover
					const imageData = await downloadCover(bookInfo.coverUrl);
					if (imageData) {
						await app.vault.adapter.writeBinary(coverPath, imageData);
					}
				}
			}
		}

	return cacheModified;
}

/**
 * Update custom book frontmatter with fetched metadata
 */
function updateCustomBookFrontmatter(
	content: string,
	bookInfo: BookInfoResult,
	settings: MoonSyncSettings
): string {
	// Parse existing frontmatter
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) {
		return content; // No frontmatter, can't update
	}

	const frontmatter = frontmatterMatch[1];
	const contentAfterFrontmatter = content.slice(frontmatterMatch[0].length);

	const lines: string[] = [];
	lines.push("---");

	// Process existing frontmatter lines
	const frontmatterLines = frontmatter.split("\n");
	let skipNextLine = false;

	for (const line of frontmatterLines) {
		// Skip genre array items
		if (skipNextLine && line.trim().startsWith("-")) {
			continue;
		}
		skipNextLine = false;

		// Skip fields we'll update
		if (line.startsWith("published_date:") ||
		    line.startsWith("publisher:") ||
		    line.startsWith("page_count:") ||
		    line.startsWith("genres:") ||
		    line.startsWith("series:") ||
		    line.startsWith("language:") ||
		    line.startsWith("rating:") ||
		    line.startsWith("ratings_count:") ||
		    line.startsWith("cover:")) {
			if (line.startsWith("genres:")) {
				skipNextLine = true;
			}
			continue;
		}

		lines.push(line);
	}

	// Add new metadata
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

	// Add cover path if not already present
	const coverFilename = generateFilename(frontmatterLines.find(l => l.startsWith("title:"))?.split(":")[1]?.trim().replace(/"/g, "") || "");
	if (coverFilename) {
		lines.push(`cover: "covers/${coverFilename}.jpg"`);
	}

	lines.push("---");

	return lines.join("\n") + contentAfterFrontmatter;
}

/**
 * Escape special characters for YAML strings
 */
function escapeYaml(str: string): string {
	return str.replace(/"/g, '\\"').replace(/\n/g, " ");
}

/**
 * Update the index note with summary and links to all books
 * Merges Moon+ Reader books with any manually-created book notes in the folder
 */
async function updateIndexNote(app: App, outputPath: string, moonReaderBooks: BookData[], settings: MoonSyncSettings): Promise<void> {
	const indexPath = normalizePath(`${outputPath}/${settings.indexNoteTitle}.md`);

	// Scan for manually-created book notes
	const scannedBooks = await scanAllBookNotes(app, outputPath);

	// Filter out the index note itself from scanned books
	const indexFilename = `${settings.indexNoteTitle}.md`;
	const filteredScanned = scannedBooks.filter(
		(b) => !b.filePath.endsWith(indexFilename)
	);

	// Merge Moon+ Reader books with manually-created ones
	const allBooks = mergeBookLists(moonReaderBooks, filteredScanned);

	const markdown = generateIndexNote(allBooks, settings);

	if (await app.vault.adapter.exists(indexPath)) {
		await app.vault.adapter.write(indexPath, markdown);
	} else {
		await app.vault.create(indexPath, markdown);
	}
}

/**
 * Refresh just the index note without full sync (for settings changes or after adding manual books)
 * This scans all book notes in the output folder, including manually-created ones
 */
export async function refreshIndexNote(app: App, settings: MoonSyncSettings): Promise<void> {
	if (!settings.showIndex) {
		new Notice("MoonSync: Index generation is disabled in settings");
		return;
	}

	const outputPath = normalizePath(settings.outputFolder);

	// Check if output folder exists
	if (!(await app.vault.adapter.exists(outputPath))) {
		new Notice("MoonSync: Output folder does not exist");
		return;
	}

	try {
		// Get Moon+ Reader books if dropbox is configured
		let moonReaderBooks: BookData[] = [];
		if (settings.dropboxPath) {
			try {
				moonReaderBooks = await parseAnnotationFiles(settings.dropboxPath, settings.trackBooksWithoutHighlights);
			} catch {
				// Dropbox path might not be accessible, that's ok for manual-only use
			}
		}

		// Load cache to get canonical titles from Google Books/Open Library
		const cache = await loadCache(app, outputPath);

		// Don't update Moon Reader book titles from cache - epub metadata is more reliable

		const coversFolder = normalizePath(`${outputPath}/covers`);

		// Populate cover paths for Moon+ Reader books
		for (const bookData of moonReaderBooks) {
			if (!bookData.coverPath) {
				const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
				const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);
				if (await app.vault.adapter.exists(coverPath)) {
					bookData.coverPath = `covers/${coverFilename}`;
				}
			}
		}

		await updateIndexNote(app, outputPath, moonReaderBooks, settings);
		new Notice("MoonSync: Index refreshed");
	} catch (error) {
		console.error("MoonSync: Failed to refresh index", error);
		new Notice("MoonSync: Failed to refresh index");
	}
}

async function updateBaseFile(app: App, outputPath: string, settings: MoonSyncSettings): Promise<void> {
	const baseFilePath = normalizePath(`${outputPath}/${settings.baseFileName}.base`);
	const content = generateBaseFile(settings);

	if (await app.vault.adapter.exists(baseFilePath)) {
		await app.vault.adapter.write(baseFilePath, content);
	} else {
		await app.vault.create(baseFilePath, content);
	}
}

/**
 * Refresh the base file (for settings changes)
 */
export async function refreshBaseFile(app: App, settings: MoonSyncSettings): Promise<void> {
	if (!settings.generateBaseFile) {
		new Notice("MoonSync: Base file generation is disabled in settings");
		return;
	}

	const outputPath = normalizePath(settings.outputFolder);

	// Check if output folder exists
	if (!(await app.vault.adapter.exists(outputPath))) {
		new Notice("MoonSync: Output folder does not exist");
		return;
	}

	try {
		await updateBaseFile(app, outputPath, settings);
		new Notice("MoonSync: Base file refreshed");
	} catch (error) {
		console.error("MoonSync: Failed to refresh base file", error);
		new Notice("MoonSync: Failed to refresh base file");
	}
}

/**
 * Display sync results to the user
 */
export function showSyncResults(app: App, result: SyncResult): void {
	if (result.success) {
		if (result.booksProcessed === 0) {
			new Notice("MoonSync: No books with highlights to sync");
		} else if (result.isFirstSync) {
			// Show summary modal on first sync
			new SyncSummaryModal(app, result).open();
		} else {
			const totalProcessed = result.booksCreated + result.booksUpdated;
			const totalBooks = totalProcessed + result.booksSkipped + result.manualBooksAdded;

			if (totalProcessed === 0) {
				new Notice("MoonSync: All books up to date");
			} else {
				new Notice(`MoonSync: Updated ${totalProcessed} of ${totalBooks} books`);
			}
		}
	} else {
		new Notice(`MoonSync: Sync failed - ${result.errors[0]}`);
	}

	// Log all errors to console
	for (const error of result.errors) {
		console.error("MoonSync:", error);
	}
}
