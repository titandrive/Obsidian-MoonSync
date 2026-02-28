import { App, Notice, normalizePath } from "obsidian";
import { SyncSummaryModal } from "./modal";
import { parseAnnotationFiles } from "./parser/annotations";
import { generateBookNote, generateFilename, generateIndexNote, generateBaseFile, formatHighlight } from "./writer/markdown";
import { fetchBookInfo, downloadCover, batchFetchBookInfo, BookInfoResult } from "./covers";
import { MoonSyncSettings, BookData } from "./types";
import { loadCache, saveCache, getCachedInfo, setCachedInfo, BookInfoCache } from "./cache";
import { scanAllBookNotes, mergeBookLists } from "./scanner";
import { computeHighlightsHash, parseFrontmatter, parseFrontmatterField, extractFrontmatter } from "./utils";
import { syncBooksToHardcover, HardcoverSyncItem } from "./hardcover";
import { enrichBooksWithSyncData } from "./enrichment";
import { getLocalCover } from "./parser/local-covers";

export interface SyncResult {
	success: boolean;
	booksProcessed: number;
	booksCreated: number;
	booksUpdated: number;
	booksSkipped: number;
	booksDeleted: number;
	manualBooksAdded: number;
	totalHighlights: number;
	totalNotes: number;
	isFirstSync: boolean;
	errors: string[];
	failedBooks: { title: string; error: string }[];
	hardcoverUpdated?: number;
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
		booksDeleted: 0,
		manualBooksAdded: 0,
		totalHighlights: 0,
		totalNotes: 0,
		isFirstSync: false,
		errors: [],
		failedBooks: [],
	};

	// Single progress notice that we'll hide when done
	const progressNotice = new Notice("MoonSync: Syncing...", 0);

	try {
		// Validate settings
		if (!settings.syncPath) {
			result.errors.push("Sync path not configured");
			progressNotice.hide();
			return result;
		}

		// Parse annotation files from Cache folder (real-time sync)
		const booksWithHighlights = await parseAnnotationFiles(settings.syncPath, settings.trackBooksWithoutHighlights);

		if (booksWithHighlights.length === 0) {
			result.errors.push("No annotation files found in .Moon+/Cache folder");
			progressNotice.hide();
			return result;
		}

		// Enrich books with data from books.sync, local covers, and backup statistics
		progressNotice.setMessage("MoonSync: Enriching book metadata...");
		const { enrichmentResult, booksWithSufficientMetadata } =
			await enrichBooksWithSyncData(booksWithHighlights, settings.syncPath, wasmPath);

		if (enrichmentResult.booksEnriched > 0) {
			console.log(
				`MoonSync: Enriched ${enrichmentResult.booksEnriched} books from sync data ` +
				`(${enrichmentResult.coversFound} covers, ${enrichmentResult.statisticsFound} statistics)`
			);
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

		// Build title cache once for efficient file matching
		progressNotice.setMessage("MoonSync: Scanning existing notes...");
		const titleCache = await buildTitleCache(app, outputPath);

		// Pre-fetch book info for books that need it (batch API calls)
		progressNotice.setMessage("MoonSync: Fetching book metadata...");
		const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);
		let existingCoversSet = new Set<string>();
		try {
			if (await app.vault.adapter.exists(coversFolder)) {
				const listing = await app.vault.adapter.list(coversFolder);
				existingCoversSet = new Set(listing.files.map(f => f.split("/").pop() || ""));
			}
		} catch {
			// Folder doesn't exist, use empty set
		}

		// Determine which books need API fetching
		const booksToFetch: Array<{ title: string; author: string }> = [];
		for (let i = 0; i < booksWithHighlights.length; i++) {
			const bookData = booksWithHighlights[i];

			// Skip API fetch if enrichment provided sufficient metadata and cover is available
			if (booksWithSufficientMetadata.has(i)) {
				const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
				const hasCover = existingCoversSet.has(coverFilename) || !!bookData.book.coverFile;
				if (hasCover) continue;
			}

			const cachedInfo = getCachedInfo(cache, bookData.book.title, bookData.book.author);
			const hasAttemptedFetch = cachedInfo && (
				cachedInfo.publishedDate !== undefined &&
				cachedInfo.publisher !== undefined &&
				cachedInfo.pageCount !== undefined
			);
			const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
			const coverExists = existingCoversSet.has(coverFilename);

			if (!coverExists || !hasAttemptedFetch) {
				booksToFetch.push({ title: bookData.book.title, author: bookData.book.author });
			}
		}

		// Batch fetch all needed book info
		const prefetchedInfo = booksToFetch.length > 0
			? await batchFetchBookInfo(booksToFetch, 5)
			: new Map<string, BookInfoResult>();

		// Process each book
		const totalBooks = booksWithHighlights.length;
		const changedBookTitles = new Set<string>();
		for (let i = 0; i < booksWithHighlights.length; i++) {
			const bookData = booksWithHighlights[i];
			progressNotice.setMessage(`MoonSync: ${bookData.book.title} (${i + 1}/${totalBooks})`);
			try {
				const prevCreated = result.booksCreated;
				const prevUpdated = result.booksUpdated;
				const processed = await processBook(app, outputPath, bookData, settings, result, cache, prefetchedInfo, titleCache);
				if (processed) {
					cacheModified = true;
				}
				if (result.booksCreated > prevCreated || result.booksUpdated > prevUpdated) {
					changedBookTitles.add(bookData.book.title);
				}
				result.booksProcessed++;
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				result.failedBooks.push({
					title: bookData.book.title,
					error: errorMsg
				});
				result.errors.push(`Error processing "${bookData.book.title}": ${errorMsg}`);
			}
		}

		// Process custom books (books not from Moon Reader database)
		const scannedBooks = await scanAllBookNotes(app, outputPath);
		const customBooks = scannedBooks.filter(book => !book.isMoonReader);

		if (customBooks.length > 0) {
			const totalCustom = customBooks.length;
			for (let i = 0; i < customBooks.length; i++) {
				const customBook = customBooks[i];
				progressNotice.setMessage(`MoonSync: ${customBook.title} (${i + 1}/${totalCustom} custom)`);
				try {
					const processed = await processCustomBook(app, outputPath, customBook, settings, result, cache);
					if (processed) {
						cacheModified = true;
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					result.failedBooks.push({
						title: customBook.title,
						error: errorMsg
					});
					result.errors.push(`Error processing custom book "${customBook.title}": ${errorMsg}`);
				}
			}
		}

		// Save cache if modified
		if (cacheModified) {
			await saveCache(app, outputPath, cache);
		}

		// Sync to Hardcover if enabled — sync changed books + books needing migration
		if (settings.hardcoverEnabled && settings.hardcoverToken) {
			try {
				progressNotice.setMessage("MoonSync: Syncing to Hardcover...");
				console.log(`MoonSync: Hardcover sync starting — ${changedBookTitles.size} changed books, ${booksWithHighlights.length} total books`);
				const hardcoverItems: HardcoverSyncItem[] = [];
				for (const b of booksWithHighlights) {
					if (b.progress === null) {
						console.log(`MoonSync: Hardcover skipping "${b.book.title}" — no progress data`);
						continue;
					}
					// Read hardcover_id and last-synced progress from frontmatter
					const filename = generateFilename(b.book.title);
					const filePath = normalizePath(`${outputPath}/${filename}.md`);
					let hardcoverId: number | null = null;
					let lastSyncedProgress: string | null = null;
					try {
						if (await app.vault.adapter.exists(filePath)) {
							const content = await app.vault.adapter.read(filePath);
							const fm = extractFrontmatter(content);
							if (fm) {
								const idStr = parseFrontmatterField(fm, "hardcover_id");
								if (idStr) hardcoverId = parseInt(idStr, 10) || null;
								lastSyncedProgress = parseFrontmatterField(fm, "hardcover_progress");
							}
						} else {
							console.log(`MoonSync: Hardcover "${b.book.title}" — note not found at ${filePath}`);
						}
					} catch { /* ignore read errors */ }

					// Skip if progress hasn't changed since last Hardcover sync
					const currentProgress = b.progress.toFixed(1);
					if (lastSyncedProgress && lastSyncedProgress.replace(/["%]/g, "") === currentProgress) {
						console.log(`MoonSync: Hardcover skipping "${b.book.title}" — progress unchanged (${currentProgress}%)`);
						continue;
					}

					console.log(`MoonSync: Hardcover queuing "${b.book.title}" — progress: ${b.progress}%, hardcoverId: ${hardcoverId}, lastSynced: ${lastSyncedProgress}`);
					hardcoverItems.push({
						title: b.book.title,
						author: b.book.author,
						progress: b.progress,
						hardcoverId,
					});
				}

				console.log(`MoonSync: Hardcover ${hardcoverItems.length} books queued for sync`);
				if (hardcoverItems.length > 0) {
					const hcResult = await syncBooksToHardcover(
						hardcoverItems,
						settings.hardcoverToken,
						(msg) => progressNotice.setMessage(`MoonSync: ${msg}`)
					);
					result.hardcoverUpdated = hcResult.booksUpdated;

					// Write hardcover_id, hardcover_url, and hardcover_progress to frontmatter
					console.log(`MoonSync: Hardcover write-back — ${hcResult.updatedTitles.length} updated, ${hcResult.newIds.length} new IDs, ${hcResult.slugs.size} slugs`);
					const newIdMap = new Map(hcResult.newIds.map(n => [n.title, n.hardcoverId]));
					const newSlugMap = new Map(hcResult.newIds.map(n => [n.title, n.slug]));
					const progressMap = new Map(hardcoverItems.map(i => [i.title, i.progress]));
					for (const title of hcResult.updatedTitles) {
						try {
							const fn = generateFilename(title);
							const fp = normalizePath(`${outputPath}/${fn}.md`);
							if (await app.vault.adapter.exists(fp)) {
								let content = await app.vault.adapter.read(fp);
								// Read existing hardcover_id before stripping
								const existingIdMatch = content.match(/^hardcover_id: (.+)$/m);
								const existingId = existingIdMatch ? existingIdMatch[1].trim() : null;
								// Remove old hardcover fields before inserting updated ones
								content = content.replace(/^hardcover_id: .*\n/m, "");
								content = content.replace(/^hardcover_progress: .*\n/m, "");
								content = content.replace(/^hardcover_url: .*\n/m, "");
								// Build new fields: use new ID if discovered, otherwise preserve existing
								const newId = newIdMap.get(title);
								const hardcoverId = newId || existingId;
								const slug = hcResult.slugs.get(title) || newSlugMap.get(title);
								const syncedProgress = progressMap.get(title);
								const fields: string[] = [];
								if (hardcoverId) fields.push(`hardcover_id: ${hardcoverId}`);
								if (slug) fields.push(`hardcover_url: "https://hardcover.app/books/${slug}"`);
								if (syncedProgress !== null && syncedProgress !== undefined) {
									fields.push(`hardcover_progress: "${syncedProgress.toFixed(1)}%"`);
								}
								if (fields.length > 0) {
									content = content.replace(/\n---\n/, `\n${fields.join("\n")}\n---\n`);
								}
								await app.vault.adapter.write(fp, content);
							}
						} catch (err) {
							console.log(`MoonSync: Failed to write hardcover data for "${title}"`, err);
						}
					}
				}
			} catch (error) {
				console.log("MoonSync: Hardcover sync failed", error);
			}
		}

		// Update index note if enabled
		if (settings.showIndex) {
			const indexPath = normalizePath(`${outputPath}/${settings.indexNoteTitle}.md`);
			const indexExists = await app.vault.adapter.exists(indexPath);

			// Check if there are manually-created book notes by comparing counts
			// Reuse scannedBooks from earlier scan instead of scanning again
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
			if (result.booksCreated > 0 || result.booksUpdated > 0 || result.booksDeleted > 0 || !indexExists || hasManualBooks) {
				// Populate cover paths for all books (for the collage)
				// Get directory listing once instead of checking each file individually
				const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);
				let existingCovers = new Set<string>();
				try {
					if (await app.vault.adapter.exists(coversFolder)) {
						const listing = await app.vault.adapter.list(coversFolder);
						existingCovers = new Set(listing.files.map(f => f.split("/").pop() || ""));
					}
				} catch {
					// Folder doesn't exist or can't be read, use empty set
				}

				for (const bookData of booksWithHighlights) {
					if (!bookData.coverPath) {
						const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
						if (existingCovers.has(coverFilename)) {
							bookData.coverPath = `moonsync-covers/${coverFilename}`;
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
			if (result.booksCreated > 0 || result.booksUpdated > 0 || result.booksDeleted > 0 || !baseExists) {
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
	highlightsHash: string | null;
	progress: number | null;
	lastRead: string | null;
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
		const parsed = parseFrontmatter(content);

		if (parsed.highlightsCount !== null) {
			return {
				highlightsCount: parsed.highlightsCount,
				highlightsHash: parsed.highlightsHash,
				progress: parsed.progress,
				lastRead: parsed.lastRead,
				isManualNote: parsed.isManualNote,
				hasCustomMetadata: parsed.hasCustomMetadata,
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
			    line.startsWith("highlights_hash:") ||
			    line.startsWith("notes_count:") ||
			    line.startsWith("last_synced:") ||
			    line.startsWith("manual_note:") ||
			    line.startsWith("published_date:") ||
			    line.startsWith("publisher:") ||
			    line.startsWith("page_count:") ||
			    line.startsWith("genres:") ||
			    line.startsWith("series:") ||
			    line.startsWith("language:") ||
			    line.trim().startsWith("-")) { // Skip genre array items
				continue;
			}
			lines.push(line);
		}
	}

	// Add Moon+ Reader metadata
	lines.push(`last_synced: ${new Date().toISOString().split("T")[0]}`);
	lines.push(`highlights_count: ${bookData.highlights.length}`);
	lines.push(`highlights_hash: "${computeHighlightsHash(bookData.highlights)}"`);
	const notesCount = bookData.highlights.filter((h) => h.note && h.note.trim()).length;
	lines.push(`notes_count: ${notesCount}`);

	if (settings.showReadingProgress && bookData.progress !== null) {
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

	// Add Moon Reader highlights section
	lines.push("## Moon Reader highlights");
	lines.push("");

	// Add progress info if enabled
	if (settings.showReadingProgress && (bookData.progress !== null || bookData.currentChapter !== null)) {
		lines.push("**Reading progress:**");
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
		lines.push(formatHighlight(highlight, settings.showHighlightColors));
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Check if an existing note has custom user content in the "My Notes" section.
 * Returns true if the user has written content beyond the default placeholder.
 */
function hasUserNotes(content: string): boolean {
	const myNotesPattern = /\n## My [Nn]otes\n([\s\S]*?)(?=\n## |\n---|\s*$)/;
	const myNotesMatch = content.match(myNotesPattern);

	if (!myNotesMatch) {
		return false;
	}

	let notesSection = myNotesMatch[1].trim();
	const placeholderPattern = /^> \[!moonsync-user-notes\]\+ Your [Nn]otes\n> Add your thoughts, analysis, and notes here\. This section is preserved across syncs\.\n?/;
	notesSection = notesSection.replace(placeholderPattern, "").trim();

	return notesSection.length > 0;
}

/**
 * Merge existing Moon Reader note with new data
 * Regenerates everything fresh EXCEPT the "My Notes" section which is preserved
 */
function mergeExistingNoteWithHighlights(
	existingContent: string,
	bookData: BookData,
	settings: MoonSyncSettings
): string {
	// Extract user's "My Notes" section content if it exists
	const myNotesPattern = /\n## My [Nn]otes\n([\s\S]*?)(?=\n## |\n---|\s*$)/;
	const myNotesMatch = existingContent.match(myNotesPattern);

	// Get the content inside My Notes (after the placeholder callout if present)
	let userNotesContent = "";
	if (myNotesMatch) {
		let notesSection = myNotesMatch[1];
		// Remove the default placeholder callout if it's still there unchanged
		const placeholderPattern = /^> \[!moonsync-user-notes\]\+ Your [Nn]otes\n> Add your thoughts, analysis, and notes here\. This section is preserved across syncs\.\n?/;
		notesSection = notesSection.replace(placeholderPattern, "").trim();
		if (notesSection) {
			userNotesContent = notesSection;
		}
	}

	// Preserve hardcover fields from existing frontmatter
	const hardcoverFields: string[] = [];
	const hcIdMatch = existingContent.match(/^hardcover_id: .+$/m);
	if (hcIdMatch) hardcoverFields.push(hcIdMatch[0]);
	const hcUrlMatch = existingContent.match(/^hardcover_url: .+$/m);
	if (hcUrlMatch) hardcoverFields.push(hcUrlMatch[0]);
	const hcProgressMatch = existingContent.match(/^hardcover_progress: .+$/m);
	if (hcProgressMatch) hardcoverFields.push(hcProgressMatch[0]);

	// Generate fresh note with all Moon Reader data
	let freshNote = generateBookNote(bookData, settings);

	// Inject hardcover fields at end of frontmatter
	if (hardcoverFields.length > 0) {
		freshNote = freshNote.replace(/\n---\n/, `\n${hardcoverFields.join("\n")}\n---\n`);
	}

	// If user had custom notes, replace the placeholder with their content
	if (userNotesContent) {
		// Replace the placeholder callout with user's content
		const placeholderInFresh = "> [!moonsync-user-notes]+ Your notes\n> Add your thoughts, analysis, and notes here. This section is preserved across syncs.";
		freshNote = freshNote.replace(placeholderInFresh, userNotesContent);
	}

	return freshNote;
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
 * Normalize a book title for fuzzy matching by removing file extensions
 */
function normalizeBookTitle(title: string): string {
	return title
		.replace(/\.(epub|mobi|pdf|azw3?|fb2|txt)$/i, '')
		.trim();
}

/**
 * Cache of normalized titles to file paths, built once per sync
 */
interface TitleCacheEntry {
	normalizedTitle: string;
	filePath: string;
}

/**
 * Build a cache of all book titles from markdown files in the output folder
 * This avoids reading every file for each book during sync
 */
async function buildTitleCache(app: App, outputPath: string): Promise<TitleCacheEntry[]> {
	const cache: TitleCacheEntry[] = [];

	try {
		const listing = await app.vault.adapter.list(normalizePath(outputPath));

		for (const filePath of listing.files) {
			if (!filePath.endsWith('.md')) continue;

			try {
				const content = await app.vault.adapter.read(filePath);
				const parsed = parseFrontmatter(content);

				if (parsed.title) {
					cache.push({
						normalizedTitle: normalizeBookTitle(parsed.title),
						filePath,
					});
				}
			} catch {
				// Failed to read file, skip it
			}
		}
	} catch {
		// Error listing folder
	}

	return cache;
}

const SIMILARITY_THRESHOLD = 0.80;

/**
 * Find existing file with fuzzy matching using pre-built title cache
 * Returns the actual file path if found, otherwise returns the preferred path
 */
async function findExistingFile(
	app: App,
	outputPath: string,
	preferredFilename: string,
	bookTitle: string,
	titleCache: TitleCacheEntry[]
): Promise<string> {
	const preferredPath = normalizePath(`${outputPath}/${preferredFilename}.md`);

	// Check if preferred path exists (fast path)
	if (await app.vault.adapter.exists(preferredPath)) {
		return preferredPath;
	}

	// Normalize the book title for comparison
	const normalizedBookTitle = normalizeBookTitle(bookTitle);

	// Fuzzy match against cached titles
	let bestMatch: { path: string; similarity: number } | null = null;

	for (const entry of titleCache) {
		const similarity = calculateSimilarity(normalizedBookTitle, entry.normalizedTitle);

		if (similarity >= SIMILARITY_THRESHOLD) {
			if (!bestMatch || similarity > bestMatch.similarity) {
				bestMatch = { path: entry.filePath, similarity };
			}
		}
	}

	if (bestMatch) {
		console.debug(`Best match: "${bestMatch.path}" (${(bestMatch.similarity * 100).toFixed(1)}%)`);

		if (bestMatch.path !== preferredPath) {
			// Found a match with different filename - rename to preferred filename
			try {
				await app.vault.adapter.rename(bestMatch.path, preferredPath);
				return preferredPath;
			} catch {
				return bestMatch.path;
			}
		}
		return bestMatch.path;
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
	cache: BookInfoCache,
	prefetchedInfo: Map<string, BookInfoResult> = new Map(),
	titleCache: TitleCacheEntry[] = []
): Promise<boolean> {
	// Store original title for cache key (before Google Books updates it)
	const originalTitle = bookData.book.title;
	const originalAuthor = bookData.book.author;

	const filename = generateFilename(bookData.book.title);
	const filePath = await findExistingFile(app, outputPath, filename, bookData.book.title, titleCache);
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

	// Check if book has changed (compare highlights hash and progress)
	const existingData = await getExistingBookData(app, filePath);
	const fileExists = existingData !== null;

	// Handle books with 0 highlights
	if (bookData.highlights.length === 0) {
		if (!fileExists) {
			// No file and no highlights — nothing to do unless tracking is on
			if (!settings.trackBooksWithoutHighlights) {
				result.booksSkipped++;
				return false;
			}
		} else if (settings.trackBooksWithoutHighlights) {
			// Keep note — skip if already cleaned up, otherwise fall through to update
			if (existingData.highlightsCount === 0) {
				result.booksSkipped++;
				return false;
			}
		} else if (hasUserNotes(existingData.fullContent!)) {
			// User has custom My Notes content — skip if already cleaned up, otherwise update
			if (existingData.highlightsCount === 0) {
				result.booksSkipped++;
				return false;
			}
		} else {
			// No tracking, no custom content — delete the note entirely
			const file = app.vault.getAbstractFileByPath(filePath);
			if (file) {
				await app.vault.trash(file, false);
				result.booksDeleted++;
			}
			return false;
		}
	}

	if (fileExists) {
		// Compute hash of current highlights for comparison
		const currentHash = computeHighlightsHash(bookData.highlights);

		// Use hash comparison if available, fall back to count comparison for older notes
		const highlightsUnchanged = existingData.highlightsHash
			? existingData.highlightsHash === currentHash
			: existingData.highlightsCount === bookData.highlights.length;
		const progressUnchanged = existingData.progress === bookData.progress;
		const newLastRead = bookData.lastReadTimestamp !== null
			? new Date(bookData.lastReadTimestamp).toISOString().split("T")[0]
			: null;
		const lastReadUnchanged = existingData.lastRead === newLastRead;

		console.debug(`[${bookData.book.title}] Existing hash: ${existingData.highlightsHash || 'none'} | New hash: ${currentHash}`);
		console.debug(`[${bookData.book.title}] Unchanged: highlights=${highlightsUnchanged}, progress=${progressUnchanged}, lastRead=${lastReadUnchanged}, hasAttemptedFetch=${hasAttemptedFetch}`);

		// Only skip if: nothing changed AND we've already attempted to fetch metadata
		// Once we've tried fetching once, don't keep retrying if data isn't available
		if (highlightsUnchanged && progressUnchanged && lastReadUnchanged && hasAttemptedFetch) {
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
		const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);
		const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);

		let coverExists = await app.vault.adapter.exists(coverPath);

		// Always prefer local Moon Reader cover (extracted from epub, usually higher quality)
		if (bookData.book.coverFile) {
			const localCoverData = await getLocalCover(settings.syncPath, bookData.book.coverFile);
			if (localCoverData) {
				if (!(await app.vault.adapter.exists(coversFolder))) {
					await app.vault.createFolder(coversFolder);
				}
				await app.vault.adapter.writeBinary(coverPath, localCoverData);
				bookData.coverPath = `moonsync-covers/${coverFilename}`;
				coverExists = true;
			}
		}

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

		// Use pre-fetched info if available, otherwise skip API call (was already batched)
		const prefetchKey = `${bookData.book.title}|${bookData.book.author}`;
		const bookInfo = prefetchedInfo.get(prefetchKey);

		if (bookInfo) {
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
					bookData.coverPath = `moonsync-covers/${coverFilename}`;
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

			// Update cache
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
		}

		// Set cover path if cover already exists
		if (coverExists) {
			bookData.coverPath = `moonsync-covers/${coverFilename}`;
		}
	}

	// Generate or merge markdown content
	let markdown: string;

	if (fileExists && existingData.isManualNote) {
		// Merge manual note with Moon+ Reader data
		markdown = mergeManualNoteWithMoonReader(existingData.fullContent!, bookData, settings);
	} else if (fileExists) {
		// Existing Moon Reader note: preserve user content outside highlights section
		markdown = mergeExistingNoteWithHighlights(existingData.fullContent!, bookData, settings);
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
				const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);
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
		lines.push(`cover: "moonsync-covers/${coverFilename}.jpg"`);
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
		// Get Moon+ Reader books if sync path is configured
		let moonReaderBooks: BookData[] = [];
		if (settings.syncPath) {
			try {
				moonReaderBooks = await parseAnnotationFiles(settings.syncPath, settings.trackBooksWithoutHighlights);
			} catch {
				// Sync path might not be accessible, that's ok for manual-only use
			}
		}

		const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);

		// Populate cover paths for Moon+ Reader books
		for (const bookData of moonReaderBooks) {
			if (!bookData.coverPath) {
				const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
				const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);
				if (await app.vault.adapter.exists(coverPath)) {
					bookData.coverPath = `moonsync-covers/${coverFilename}`;
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
export function showSyncResults(app: App, result: SyncResult, settings: MoonSyncSettings): void {
	const hasFailedBooks = result.failedBooks && result.failedBooks.length > 0;

	if (result.success) {
		if (result.booksProcessed === 0 && !hasFailedBooks) {
			new Notice("MoonSync: No books with highlights to sync");
		} else if (result.isFirstSync || hasFailedBooks) {
			// Show summary modal on first sync or if there were failures
			new SyncSummaryModal(app, result, settings).open();
		} else {
			const totalProcessed = result.booksCreated + result.booksUpdated + result.booksDeleted;
			const totalBooks = totalProcessed + result.booksSkipped + result.manualBooksAdded;

			if (totalProcessed === 0) {
				new Notice("MoonSync: All books up to date");
			} else {
				const parts: string[] = [];
				if (result.booksCreated + result.booksUpdated > 0) {
					parts.push(`Updated ${result.booksCreated + result.booksUpdated}`);
				}
				if (result.booksDeleted > 0) {
					parts.push(`Removed ${result.booksDeleted}`);
				}
				if (result.hardcoverUpdated && result.hardcoverUpdated > 0) {
					parts.push(`Hardcover: ${result.hardcoverUpdated} synced`);
				}
				new Notice(`MoonSync: ${parts.join(", ")} of ${totalBooks} books`);
			}
		}
	} else {
		// Complete failure - show error
		new Notice(`MoonSync: Sync failed - ${result.errors[0]}`);
	}

	// Log all errors to console
	for (const error of result.errors) {
		console.error("MoonSync:", error);
	}
}
