import { BookData, MoonReaderStatistics } from "./types";
import { parseBooksSyncFile, parseCategoryField, BooksSyncEntry } from "./parser/books-sync";
import { scanLocalCovers } from "./parser/local-covers";
import { findLatestBackup, extractMrpro } from "./parser/mrpro";
import { initDatabase } from "./parser/database";
import initSqlJs from "sql.js";
import { readFile } from "fs/promises";
import { join } from "path";

export interface EnrichmentResult {
	booksEnriched: number;
	coversFound: number;
	statisticsFound: number;
}

/**
 * Extract reading statistics from the most recent .mrpro backup.
 * Returns a Map keyed by lowercase basename for matching.
 */
async function extractBackupStatistics(
	syncPath: string,
	wasmPath: string
): Promise<Map<string, MoonReaderStatistics> | null> {
	const backupDir = join(syncPath, ".Moon+", "Backup");

	try {
		const latestBackup = await findLatestBackup(backupDir);
		if (!latestBackup) return null;

		const mrpro = await extractMrpro(latestBackup);

		await initDatabase(wasmPath);
		const wasmBinary = await readFile(wasmPath);
		const SQL = await initSqlJs({ wasmBinary });
		const db = new SQL.Database(new Uint8Array(mrpro.database));

		try {
			const results = db.exec(
				"SELECT _id, filename, usedTime, readWords, dates FROM statistics"
			);

			if (results.length === 0) return new Map();

			const statsMap = new Map<string, MoonReaderStatistics>();
			for (const row of results[0].values) {
				const fullPath = (row[1] as string) || "";
				// Extract basename for matching (e.g. "/sdcard/Books/MoonReader/Dune.epub" → "dune.epub")
				const basename = (fullPath.includes("/")
					? (fullPath.split("/").pop() || "").toLowerCase()
					: fullPath.toLowerCase()
				).normalize("NFC");

				if (basename) {
					statsMap.set(basename, {
						id: row[0] as number,
						filename: fullPath,
						usedTime: (row[2] as number) || 0,
						readWords: (row[3] as number) || 0,
						dates: (row[4] as string) || "",
					});
				}
			}

			return statsMap;
		} finally {
			db.close();
		}
	} catch (error) {
		console.debug("MoonSync: Failed to extract backup statistics", error);
		return null;
	}
}

/**
 * Apply books.sync metadata to a BookData entry.
 * Only fills in fields that are currently empty/null.
 */
function enrichFromSyncEntry(bookData: BookData, entry: BooksSyncEntry): void {
	// Title: prefer books.sync if it looks like a real title
	// Skip if bookName is a hash, UUID, or shorter than 3 chars (bad epub metadata)
	if (entry.bookName && entry.bookName !== bookData.book.title &&
		entry.bookName.length >= 3 && !/^[0-9a-f-]{16,}$/i.test(entry.bookName)) {
		bookData.previousTitle = bookData.book.title;
		bookData.book.title = entry.bookName;
	}

	// Author
	if (!bookData.book.author && entry.author) {
		bookData.book.author = entry.author;
	}

	// Description
	if (!bookData.book.description && entry.description) {
		bookData.book.description = entry.description;
	}

	// Category (raw, used by markdown writer for frontmatter)
	if (!bookData.book.category && entry.category) {
		bookData.book.category = entry.category;
	}

	// Parse category into genres and series
	if (entry.category) {
		const parsed = parseCategoryField(entry.category);

		if (!bookData.genres && parsed.genres.length > 0) {
			bookData.genres = parsed.genres;
		}

		if (!bookData.series && parsed.series) {
			bookData.series = parsed.seriesNumber
				? `${parsed.series} #${parsed.seriesNumber}`
				: parsed.series;
		}
	}

	// Favorite
	if (!bookData.book.favorite && entry.favorite) {
		bookData.book.favorite = entry.favorite;
	}
}

/**
 * Enrich BookData[] with data from books.sync, local covers, and backup statistics.
 * Call this AFTER parseAnnotationFiles and BEFORE batchFetchBookInfo.
 *
 * Returns which book indices have enough metadata to skip API calls.
 */
export async function enrichBooksWithSyncData(
	books: BookData[],
	syncPath: string,
	wasmPath: string,
	trackBooksWithoutHighlights: boolean = false
): Promise<{
	enrichmentResult: EnrichmentResult;
	booksWithSufficientMetadata: Set<number>;
}> {
	const result: EnrichmentResult = {
		booksEnriched: 0,
		coversFound: 0,
		statisticsFound: 0,
	};
	const sufficientMetadata = new Set<number>();

	// Load all three data sources in parallel
	const [booksSyncMap, localCovers, backupStats] = await Promise.all([
		parseBooksSyncFile(syncPath),
		scanLocalCovers(syncPath),
		extractBackupStatistics(syncPath, wasmPath),
	]);

	// Track which books.sync entries were matched so we can discover unmatched ones
	const matchedSyncKeys = new Set<string>();

	for (let i = 0; i < books.length; i++) {
		const bookData = books[i];
		const epubFilename = bookData.book.filename;
		if (!epubFilename) continue;

		const key = epubFilename.toLowerCase().normalize("NFC");

		// 1. Enrich from books.sync
		if (booksSyncMap) {
			const syncEntry = booksSyncMap.get(key);
			if (syncEntry) {
				matchedSyncKeys.add(key);
				enrichFromSyncEntry(bookData, syncEntry);
				result.booksEnriched++;

				// If we have title + author + description, we can skip API
				if (bookData.book.title && bookData.book.author && bookData.book.description) {
					sufficientMetadata.add(i);
				}
			}
		}

		// 2. Flag local cover availability
		if (localCovers.has(key)) {
			bookData.book.coverFile = epubFilename;
			result.coversFound++;
		}

		// 3. Enrich from backup statistics
		if (backupStats) {
			const stats = backupStats.get(key);
			if (stats && !bookData.statistics) {
				bookData.statistics = stats;
				result.statisticsFound++;
			}
		}
	}

	// Discover books from books.sync that weren't found via .an/.po files
	if (trackBooksWithoutHighlights && booksSyncMap) {
		for (const [key, entry] of booksSyncMap) {
			if (matchedSyncKeys.has(key)) continue;

			const parsed = entry.category ? parseCategoryField(entry.category) : null;
			const hasValidBookName = entry.bookName && entry.bookName.length >= 3 && !/^[0-9a-f-]{16,}$/i.test(entry.bookName);
		const title = hasValidBookName ? entry.bookName : entry.filename.replace(/\.(epub|mobi|pdf|azw3?|fb2|txt)$/i, "").trim();

			const bookData: BookData = {
				book: {
					id: 0,
					title,
					filename: entry.filename,
					author: entry.author || "",
					description: entry.description || "",
					category: entry.category || "",
					thumbFile: "",
					coverFile: localCovers.has(key) ? entry.filename : "",
					addTime: entry.addTime || "",
					favorite: entry.favorite || "",
				},
				highlights: [],
				statistics: backupStats?.get(key) || null,
				progress: null,
				currentChapter: null,
				lastReadTimestamp: null,
				coverPath: null,
				fetchedDescription: null,
				publishedDate: null,
				publisher: null,
				pageCount: null,
				genres: parsed?.genres.length ? parsed.genres : null,
				series: parsed?.series
					? (parsed.seriesNumber ? `${parsed.series} #${parsed.seriesNumber}` : parsed.series)
					: null,
				isbn10: null,
				isbn13: null,
				language: null,
				previousTitle: null,
			};

			const idx = books.length;
			books.push(bookData);
			result.booksEnriched++;

			if (localCovers.has(key)) result.coversFound++;
			if (bookData.statistics) result.statisticsFound++;

			if (bookData.book.title && bookData.book.author && bookData.book.description) {
				sufficientMetadata.add(idx);
			}
		}
	}

	return { enrichmentResult: result, booksWithSufficientMetadata: sufficientMetadata };
}
