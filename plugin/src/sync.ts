import { App, Notice, normalizePath, TFile } from "obsidian";
import { SyncSummaryModal } from "./modal";
import { parseAnnotationFiles } from "./parser/annotations";
import { readFile } from "fs/promises";
import { fetchAllBooks as fetchKOReaderBooks, KOReaderBookData } from "./parser/koreader";
import { generateKOReaderBookNote, mergeKOReaderNote, computeKOReaderHash } from "./writer/koreader-markdown";
import { generateBookNote, generateFilename, generateIndexNote, generateBaseFile, formatHighlight } from "./writer/markdown";
import { fetchBookInfo, downloadCover, batchFetchBookInfo, BookInfoResult } from "./covers";
import { MoonSyncSettings, BookData } from "./types";
import { loadCache, saveCache, getCachedInfo, setCachedInfo, BookInfoCache } from "./cache";
import { scanAllBookNotes, mergeBookLists } from "./scanner";
import { computeHighlightsHash, parseFrontmatter, parseFrontmatterField, extractFrontmatter, escapeYaml, extractAuthorFromFilename, stripAuthorSuffix } from "./utils";
import { syncBooksToHardcover, syncBookHighlights, syncKOReaderHighlights, HardcoverSyncItem } from "./hardcover";
import { enrichBooksWithSyncData } from "./enrichment";
import { getLocalCover } from "./parser/local-covers";

function koReaderToBookData(ko: KOReaderBookData, coverVaultPath: string | null, effectiveTitle?: string): BookData {
	const title = effectiveTitle ?? ko.title;
	return {
		book: {
			id: 0, title, filename: "", author: ko.author,
			description: "", category: "", thumbFile: "", coverFile: "",
			addTime: "", favorite: "",
		},
		highlights: ko.annotations.map((a, i) => ({
			id: i,
			highlightId: a.id,
			book: title,
			filename: "",
			chapter: 0,
			position: a.page,
			highlightLength: 0,
			highlightColor: 0,
			timestamp: a.createdAt,
			bookmark: "",
			note: a.note ?? "",
			originalText: a.text ?? "",
			underline: false,
			strikethrough: false,
		})),
		statistics: null,
		progress: ko.progress,
		currentChapter: null,
		lastReadTimestamp: ko.lastUpdatedAt,
		coverPath: coverVaultPath,
		fetchedDescription: ko.description,
		publishedDate: ko.publishedDate,
		publisher: ko.publisher,
		pageCount: ko.pageCount,
		genres: null,
		series: ko.series,
		isbn10: ko.isbn10,
		isbn13: ko.isbn13,
		language: ko.language,
		previousTitle: null,
		hardcoverId: null,
		hardcoverSlug: null,
		source: "koreader",
	};
}

export function getManualOutputPath(settings: MoonSyncSettings): string {
	const base = normalizePath(settings.outputFolder);
	if (settings.organizeManualBooks) {
		return normalizePath(`${base}/Manual Notes`);
	}
	return base;
}

export async function migrateManualBooks(app: App, settings: MoonSyncSettings): Promise<void> {
	if (!settings.organizeManualBooks) return;

	const base = normalizePath(settings.outputFolder);
	const manualPath = normalizePath(`${base}/Manual Notes`);

	// Scan all possible locations for manual notes
	const searchPaths = Array.from(new Set([
		base,
		getMoonReaderOutputPath(settings),
		getKOReaderOutputPath(settings),
	]));

	const toMove: string[] = [];

	for (const searchPath of searchPaths) {
		try {
			const listing = await app.vault.adapter.list(searchPath);
			for (const filePath of listing.files) {
				if (!filePath.endsWith(".md")) continue;
				// Skip if already in Manual/
				if (filePath.startsWith(manualPath + "/") || filePath.startsWith(manualPath + "\\")) continue;
				try {
					const content = await app.vault.adapter.read(filePath);
					if (/^manual_note:\s*true/m.test(content)) {
						toMove.push(filePath);
					}
				} catch { /* skip */ }
			}
		} catch { /* folder may not exist */ }
	}

	if (toMove.length === 0) return;

	if (!await app.vault.adapter.exists(manualPath)) {
		await app.vault.createFolder(manualPath);
	}

	for (const filePath of toMove) {
		const filename = filePath.split("/").pop()!;
		const dest = normalizePath(`${manualPath}/${filename}`);
		try {
			const content = await app.vault.adapter.read(filePath);
			await app.vault.adapter.write(dest, content);
			await app.vault.adapter.remove(filePath);
		} catch { /* skip — original stays, retry next sync */ }
	}
}

export function getMoonReaderOutputPath(settings: MoonSyncSettings): string {
	const base = normalizePath(settings.outputFolder);
	if (settings.moonReaderEnabled && settings.koreaderEnabled) {
		return normalizePath(`${base}/MoonReader`);
	}
	return base;
}

export function getKOReaderOutputPath(settings: MoonSyncSettings): string {
	const base = normalizePath(settings.outputFolder);
	if (settings.moonReaderEnabled && settings.koreaderEnabled) {
		return normalizePath(`${base}/KOReader`);
	}
	return base;
}

async function scanCustomBooks(
	app: App,
	baseOutputPath: string,
	mrOutputPath: string,
	koreaderOutputPath: string,
	indexFilename: string,
	manualOutputPath?: string
): Promise<ReturnType<typeof scanAllBookNotes> extends Promise<infer T> ? T : never> {
	const paths = Array.from(new Set([baseOutputPath, mrOutputPath, koreaderOutputPath, ...(manualOutputPath ? [manualOutputPath] : [])]));
	const all: Awaited<ReturnType<typeof scanAllBookNotes>> = [];
	const seen = new Set<string>();
	for (const p of paths) {
		const books = await scanAllBookNotes(app, p);
		for (const b of books) {
			if (b.isMoonReader || b.isReadest || b.isKOReader) continue;
			if (b.filePath.endsWith(indexFilename)) continue;
			if (seen.has(b.filePath)) continue;
			seen.add(b.filePath);
			all.push(b);
		}
	}
	return all;
}

async function hasNotesWithField(app: App, folderPath: string, field: string): Promise<boolean> {
	try {
		const listing = await app.vault.adapter.list(folderPath);
		for (const filePath of listing.files) {
			if (!filePath.endsWith(".md")) continue;
			try {
				const content = await app.vault.adapter.read(filePath);
				if (content.includes(field)) return true;
			} catch { /* skip */ }
		}
	} catch { /* folder unreadable */ }
	return false;
}


async function migrateToSubdirectories(app: App, settings: MoonSyncSettings): Promise<void> {
	const base = normalizePath(settings.outputFolder);
	const mrPath = normalizePath(`${base}/MoonReader`);
	const koreaderPath = normalizePath(`${base}/KOReader`);

	// List flat files in base — only direct children, not subdirectories
	let listing: { files: string[]; folders: string[] };
	try {
		listing = await app.vault.adapter.list(base);
	} catch {
		return;
	}

	const mdFiles = listing.files.filter(f => f.endsWith(".md"));
	if (mdFiles.length === 0) return;

	// Categorise flat notes — only consider files that actually need moving
	const mrFiles: string[] = [];
	const koreaderFiles: string[] = [];
	const mrCovers: string[] = [];
	const koreaderCovers: string[] = [];

	for (const filePath of mdFiles) {
		try {
			const content = await app.vault.adapter.read(filePath);
			const isMr = content.includes("book_source: moonreader") || /^moon_reader_path:/m.test(content);
			const isKOReader = content.includes("book_source: koreader");
			if (isMr) {
				mrFiles.push(filePath);
				const coverMatch = content.match(/^cover: "?([^"\n]+)"?/m);
				if (coverMatch) mrCovers.push(coverMatch[1].split("/").pop()!);
			} else if (isKOReader) {
				koreaderFiles.push(filePath);
				const coverMatch = content.match(/^cover: "?([^"\n]+)"?/m);
				if (coverMatch) koreaderCovers.push(coverMatch[1].split("/").pop()!);
			}
		} catch { /* skip unreadable files */ }
	}

	if (mrFiles.length === 0 && koreaderFiles.length === 0) return;

	// Ensure destination folders exist
	if (mrFiles.length > 0 && !await app.vault.adapter.exists(mrPath)) {
		await app.vault.createFolder(mrPath);
	}
	if (koreaderFiles.length > 0 && !await app.vault.adapter.exists(koreaderPath)) {
		await app.vault.createFolder(koreaderPath);
	}

	// Move files — write then delete so a write failure leaves the original intact.
	// If a note already exists at the destination (e.g. an already-synced, more
	// enriched copy from a normal sync), the flat root copy is a stale duplicate —
	// drop it instead of overwriting the good copy with older data.
	for (const filePath of mrFiles) {
		const filename = filePath.split("/").pop()!;
		const dest = normalizePath(`${mrPath}/${filename}`);
		try {
			if (await app.vault.adapter.exists(dest)) {
				await app.vault.adapter.remove(filePath);
			} else {
				const content = await app.vault.adapter.read(filePath);
				await app.vault.adapter.write(dest, content);
				await app.vault.adapter.remove(filePath);
			}
		} catch { /* skip — original stays, will retry on next sync */ }
	}
	for (const filePath of koreaderFiles) {
		const filename = filePath.split("/").pop()!;
		const dest = normalizePath(`${koreaderPath}/${filename}`);
		try {
			if (await app.vault.adapter.exists(dest)) {
				await app.vault.adapter.remove(filePath);
			} else {
				const content = await app.vault.adapter.read(filePath);
				await app.vault.adapter.write(dest, content);
				await app.vault.adapter.remove(filePath);
			}
		} catch { /* skip */ }
	}

	// Move root cache to MoonReader (MR owns the cache that existed before KOReader)
	const cacheSrc = normalizePath(`${base}/.moonsync-cache.json`);
	if (mrFiles.length > 0 && await app.vault.adapter.exists(cacheSrc)) {
		try {
			const cacheContent = await app.vault.adapter.read(cacheSrc);
			await app.vault.adapter.write(normalizePath(`${mrPath}/.moonsync-cache.json`), cacheContent);
			await app.vault.adapter.remove(cacheSrc);
		} catch { /* ignore */ }
	}

	// Move covers to the appropriate subdir based on which notes referenced them
	const coversSrc = normalizePath(`${base}/moonsync-covers`);
	if (await app.vault.adapter.exists(coversSrc)) {
		try {
			const coversListing = await app.vault.adapter.list(coversSrc);
			for (const coverFile of coversListing.files) {
				const coverName = coverFile.split("/").pop()!;
				const data = await app.vault.adapter.readBinary(coverFile);
				const destDir = koreaderCovers.includes(coverName)
					? normalizePath(`${koreaderPath}/moonsync-covers`)
					: normalizePath(`${mrPath}/moonsync-covers`);
				if (!await app.vault.adapter.exists(destDir)) {
					await app.vault.createFolder(destDir);
				}
				await app.vault.adapter.writeBinary(normalizePath(`${destDir}/${coverName}`), data);
				await app.vault.adapter.remove(coverFile);
			}
			await app.vault.adapter.rmdir(coversSrc, false);
		} catch { /* ignore */ }
	}
}

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
	// The book data actually used for this sync's index (freshly parsed, or reused from
	// a prior sync when this source was scoped out) — callers can cache these to pass
	// back in as cachedMoonReaderBooks/cachedKOReaderBooks on the next scoped sync.
	moonReaderBooksForIndex?: BookData[];
	koreaderBooksForIndex?: BookData[];
}

/**
 * Main sync function that orchestrates the entire sync process
 */
export async function syncFromMoonReader(
	app: App,
	settings: MoonSyncSettings,
	wasmPath: string,
	// When a source-specific file watcher fires, only that source needs reprocessing —
	// the other source's data for the index is reused from the caller's last sync
	// instead of being expensively re-parsed for no reason.
	sourceScope?: "moonreader" | "koreader",
	cachedMoonReaderBooks?: BookData[],
	cachedKOReaderBooks?: BookData[]
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
		// Validate that at least one source is enabled
		if (!settings.moonReaderEnabled && !settings.koreaderEnabled) {
			result.errors.push("No sync source enabled. Enable Moon Reader or KOReader in settings.");
			progressNotice.hide();
			return result;
		}

		// Base output folder (root of Books/)
		const baseOutputPath = normalizePath(settings.outputFolder);
		if (!await app.vault.adapter.exists(baseOutputPath)) {
			await app.vault.createFolder(baseOutputPath);
			result.isFirstSync = true;
		}

		// Determine whether to use per-source subdirectories.
		// Use subdirs when both are enabled, OR when flat notes from the other source already exist,
		// OR when Books/MoonReader/ already exists from a prior migration.
		const mrSubdirExists = await app.vault.adapter.exists(normalizePath(`${baseOutputPath}/MoonReader`));
		const koreaderSubdirExists = await app.vault.adapter.exists(normalizePath(`${baseOutputPath}/KOReader`));

		// Scan for stray flat notes regardless of whether the subdir already exists —
		// otherwise a note left behind at the root (e.g. from an interrupted move, or one
		// created before the other source was enabled) can never be picked up again once
		// the destination subdir has been created once.
		let hasFlatMrNotes = false;
		let hasFlatKOReaderNotes = false;
		if (settings.koreaderEnabled) {
			// Check for MR notes: book_source: moonreader (new) or moon_reader_path (legacy)
			hasFlatMrNotes = await hasNotesWithField(app, baseOutputPath, "book_source: moonreader") ||
				await hasNotesWithField(app, baseOutputPath, "moon_reader_path:");
		}
		if (settings.moonReaderEnabled) {
			// Check for KOReader notes: book_source: koreader
			hasFlatKOReaderNotes = await hasNotesWithField(app, baseOutputPath, "book_source: koreader");
		}

		const useSeparateDirs =
			(settings.moonReaderEnabled && settings.koreaderEnabled) ||
			(settings.koreaderEnabled && (mrSubdirExists || hasFlatMrNotes)) ||
			(settings.moonReaderEnabled && (koreaderSubdirExists || hasFlatKOReaderNotes));

		// Run migration if needed
		if (useSeparateDirs && (hasFlatMrNotes || hasFlatKOReaderNotes)) {
			await migrateToSubdirectories(app, settings);
		}

		// Move manual_note: true books to Books/Manual Notes/ if that setting is on
		await migrateManualBooks(app, settings);

		const outputPath = useSeparateDirs
			? normalizePath(`${baseOutputPath}/MoonReader`)
			: normalizePath(settings.outputFolder);
		const koreaderOutputPath = useSeparateDirs
			? normalizePath(`${baseOutputPath}/KOReader`)
			: normalizePath(settings.outputFolder);

		// --- Moon Reader source ---
		let booksWithHighlights: BookData[] = [];
		let booksWithSufficientMetadata = new Set<number>();

		if (settings.moonReaderEnabled && sourceScope !== "koreader") {
			if (!settings.syncPath) {
				result.errors.push("Moon Reader sync path not configured");
			} else {
				// Parse annotation files from Cache folder (real-time sync)
				booksWithHighlights = await parseAnnotationFiles(settings.syncPath, settings.trackBooksWithoutHighlights);
				booksWithHighlights.forEach(b => { b.source = "moonreader"; });

				// Enrich books with data from books.sync, local covers, and backup statistics.
				progressNotice.setMessage("MoonSync: Enriching book metadata...");
				const { enrichmentResult, booksWithSufficientMetadata: enrichedSet } =
					await enrichBooksWithSyncData(booksWithHighlights, settings.syncPath, wasmPath, settings.trackBooksWithoutHighlights);
				booksWithSufficientMetadata = enrichedSet;

				if (enrichmentResult.booksEnriched > 0) {
					console.debug(
						`MoonSync: Enriched ${enrichmentResult.booksEnriched} books from sync data ` +
						`(${enrichmentResult.coversFound} covers, ${enrichmentResult.statisticsFound} statistics)`
					);
				}
			}
		}

		// Check if Moon Reader output folder exists (for first sync detection)
		const outputFolderExisted = await app.vault.adapter.exists(outputPath);
		if (!result.isFirstSync) {
			result.isFirstSync = settings.moonReaderEnabled && !outputFolderExisted;
		}

		// Ensure Moon Reader output folder exists
		if (settings.moonReaderEnabled && !outputFolderExisted) {
			await app.vault.createFolder(outputPath);
		}

		// Deduplicate books that would write to the same output file
		// (e.g. same book under different filenames in Moon Reader)
		const seenFiles = new Map<string, number>();
		for (let i = booksWithHighlights.length - 1; i >= 0; i--) {
			const fname = generateFilename(booksWithHighlights[i].book.title).toLowerCase();
			if (seenFiles.has(fname)) {
				const keepIdx = seenFiles.get(fname)!;
				const keep = booksWithHighlights[keepIdx];
				const dupe = booksWithHighlights[i];
				// Merge: prefer the entry with highlights; take higher progress
				if (dupe.highlights.length > keep.highlights.length) {
					keep.highlights = dupe.highlights;
				}
				if ((dupe.progress || 0) > (keep.progress || 0)) {
					keep.progress = dupe.progress;
					keep.currentChapter = dupe.currentChapter;
					keep.lastReadTimestamp = dupe.lastReadTimestamp;
				}
				booksWithHighlights.splice(i, 1);
			} else {
				seenFiles.set(fname, i);
			}
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
		let koreaderCache: BookInfoCache | null = null;
		let koreaderCacheModified = false;

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

		// Fill empty authors from filename pattern ("Title - Author.ext")
		// and strip author suffix from titles derived from filenames
		for (const bookData of booksWithHighlights) {
			if (!bookData.book.author && bookData.book.filename) {
				const filenameAuthor = extractAuthorFromFilename(bookData.book.filename);
				if (filenameAuthor) {
					bookData.book.author = filenameAuthor;
					bookData.book.title = stripAuthorSuffix(bookData.book.title, filenameAuthor);
				}
			}
		}

		// Determine which books need API fetching
		const booksToFetch: Array<{ title: string; author: string }> = [];
		for (let i = 0; i < booksWithHighlights.length; i++) {
			const bookData = booksWithHighlights[i];

			const cachedInfo = getCachedInfo(cache, bookData.book.title, bookData.book.author);
			const hasAttemptedFetch = cachedInfo && (
				cachedInfo.publishedDate !== undefined &&
				cachedInfo.publisher !== undefined &&
				cachedInfo.pageCount !== undefined
			);

			// Re-fetch if Hardcover is enabled but was never attempted
			// Only for books actually fetched from another API (not placeholder entries)
			const needsHardcoverRefetch = hasAttemptedFetch &&
				settings.hardcoverEnabled && settings.hardcoverToken &&
				cachedInfo!.source !== null && cachedInfo!.source !== "hardcover" &&
				!cachedInfo!.hardcoverAttempted;

			// Always fetch if Hardcover needs to be tried, even if enrichment was sufficient
			if (needsHardcoverRefetch) {
				booksToFetch.push({ title: bookData.book.title, author: bookData.book.author });
				continue;
			}

			// Skip API fetch if enrichment provided sufficient metadata and cover is available
			// But don't skip if Hardcover is enabled and hasn't been attempted yet
			const hardcoverPending = settings.hardcoverEnabled && settings.hardcoverToken &&
				cachedInfo?.hardcoverAttempted !== true;
			if (booksWithSufficientMetadata.has(i) && !hardcoverPending) {
				const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
				const hasCover = existingCoversSet.has(coverFilename) || !!bookData.book.coverFile;
				if (hasCover) continue;
			}

			if (!hasAttemptedFetch || hardcoverPending) {
				booksToFetch.push({ title: bookData.book.title, author: bookData.book.author });
			}
		}

		// Batch fetch all needed book info
		if (booksToFetch.length > 0) {
			progressNotice.setMessage(`MoonSync: Fetching metadata (0/${booksToFetch.length})...`);
		}
		const hardcoverToken = settings.hardcoverEnabled && settings.hardcoverToken ? settings.hardcoverToken : undefined;
		const prefetchedInfo = booksToFetch.length > 0
			? await batchFetchBookInfo(booksToFetch, 5, (done, total, title) => {
				progressNotice.setMessage(`MoonSync: Fetching metadata (${done}/${total})${title ? ` — ${title}` : ""}...`);
			}, hardcoverToken)
			: new Map<string, BookInfoResult>();

		// Process each book
		const changedBookTitles = new Set<string>();
		let processedCount = 0;
		progressNotice.setMessage("MoonSync: Processing books...");
		for (let i = 0; i < booksWithHighlights.length; i++) {
			const bookData = booksWithHighlights[i];
			try {
				const prevCreated = result.booksCreated;
				const prevUpdated = result.booksUpdated;
				const processed = await processBook(app, outputPath, bookData, settings, result, cache, prefetchedInfo, titleCache);
				if (processed) {
					processedCount++;
					progressNotice.setMessage(`MoonSync: ${bookData.book.title} (${processedCount} updated)`);
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

		// Process custom books (books not from Moon Reader or KOReader) across all three dirs
		const scannedBooks = await scanAllBookNotes(app, outputPath);
		const customBooks = await scanCustomBooks(
			app, baseOutputPath, outputPath, koreaderOutputPath,
			`${settings.indexNoteTitle}.md`,
			settings.organizeManualBooks ? getManualOutputPath(settings) : undefined
		);

		if (customBooks.length > 0) {
			const totalCustom = customBooks.length;
			for (let i = 0; i < customBooks.length; i++) {
				const customBook = customBooks[i];
				progressNotice.setMessage(`MoonSync: ${customBook.title} (${i + 1}/${totalCustom} custom)`);
				try {
					const customBookPath = (settings.organizeManualBooks && customBook.filePath.includes("/Manual Notes/"))
					? getManualOutputPath(settings)
					: outputPath;
				const processed = await processCustomBook(app, customBookPath, customBook, settings, result, cache);
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

		// Save MR cache
		if (cacheModified) {
			await saveCache(app, outputPath, cache);
		}

		// --- KOReader source ---
		const koreaderBooksForIndex: BookData[] = [];
		if (settings.koreaderEnabled && settings.koreaderSyncPath && sourceScope !== "moonreader") {
			progressNotice.setMessage("MoonSync: Parsing KOReader books...");

			if (!await app.vault.adapter.exists(koreaderOutputPath)) {
				await app.vault.createFolder(koreaderOutputPath);
			}

			const koBooks = await fetchKOReaderBooks(settings.koreaderSyncPath);

			if (koBooks.length > 0) {
				koreaderCache = await loadCache(app, koreaderOutputPath);
				const koreaderCoversFolder = normalizePath(`${koreaderOutputPath}/moonsync-covers`);
				const hardcoverToken = settings.hardcoverEnabled && settings.hardcoverToken ? settings.hardcoverToken : undefined;

				// Copy KOReader covers from local filesystem to vault
				const coverVaultPaths = new Map<string, string | null>();
				for (const book of koBooks) {
					if (book.coverPath) {
						if (!await app.vault.adapter.exists(koreaderCoversFolder)) {
							await app.vault.createFolder(koreaderCoversFolder);
						}
						const coverFilename = `${generateFilename(book.title)}.png`;
						const coverVaultPath = normalizePath(`${koreaderCoversFolder}/${coverFilename}`);
						if (!await app.vault.adapter.exists(coverVaultPath)) {
							try {
								const coverData = await readFile(book.coverPath);
								await app.vault.adapter.writeBinary(coverVaultPath, coverData);
							} catch { /* skip if cover unreadable */ }
						}
						coverVaultPaths.set(book.hash, `moonsync-covers/${coverFilename}`);
					} else {
						coverVaultPaths.set(book.hash, null);
					}
				}

				// Determine which KOReader books need metadata fetch
				const koreaderToFetch: Array<{ title: string; author: string; isbn10?: string | null; isbn13?: string | null }> = [];
				for (const book of koBooks) {
					const cachedInfo = getCachedInfo(koreaderCache, book.title, book.author);
					const hasAttemptedFetch = cachedInfo && (
						cachedInfo.publishedDate !== undefined &&
						cachedInfo.publisher !== undefined &&
						cachedInfo.pageCount !== undefined
					);
					const needsHardcoverRefetch = hasAttemptedFetch &&
						settings.hardcoverEnabled && settings.hardcoverToken &&
						cachedInfo!.source !== null && cachedInfo!.source !== "hardcover" &&
						!cachedInfo!.hardcoverAttempted;
					const hardcoverPending = settings.hardcoverEnabled && settings.hardcoverToken &&
						cachedInfo?.hardcoverAttempted !== true;
					if (needsHardcoverRefetch || hardcoverPending || !hasAttemptedFetch) {
						koreaderToFetch.push({ title: book.title, author: book.author, isbn10: book.isbn10, isbn13: book.isbn13 });
					}
				}

				if (koreaderToFetch.length > 0) {
					progressNotice.setMessage(`MoonSync: Fetching KOReader metadata (0/${koreaderToFetch.length})...`);
				}
				const prefetchedKOReader = koreaderToFetch.length > 0
					? await batchFetchBookInfo(koreaderToFetch, 5, (done, total, title) => {
						progressNotice.setMessage(`MoonSync: Fetching KOReader metadata (${done}/${total})${title ? ` — ${title}` : ""}...`);
					}, hardcoverToken)
					: new Map<string, BookInfoResult>();

				// Process each KOReader book
				progressNotice.setMessage("MoonSync: Processing KOReader books...");
				for (const book of koBooks) {
					try {
						const coverVaultPath = coverVaultPaths.get(book.hash) ?? null;
						const cachedInfo = getCachedInfo(koreaderCache, book.title, book.author);

						// Apply prefetched metadata to cache
						const prefetchKey = `${book.title}|${book.author}`;
						const prefetchedInfo = prefetchedKOReader.get(prefetchKey);
						if (prefetchedInfo) {
							setCachedInfo(koreaderCache, book.title, book.author, {
								title: prefetchedInfo.title ?? book.title,
								description: prefetchedInfo.description,
								author: prefetchedInfo.author,
								publishedDate: prefetchedInfo.publishedDate,
								publisher: prefetchedInfo.publisher,
								pageCount: prefetchedInfo.pageCount ?? book.pageCount,
								genres: prefetchedInfo.genres,
								series: prefetchedInfo.series,
								language: prefetchedInfo.language,
								source: prefetchedInfo.source,
								hardcoverAttempted: !!(settings.hardcoverEnabled && settings.hardcoverToken),
								hardcoverId: prefetchedInfo.hardcoverId,
								hardcoverSlug: prefetchedInfo.hardcoverSlug ?? undefined,
							});
							koreaderCacheModified = true;
						} else if (!cachedInfo) {
							// Write placeholder so we don't re-fetch every sync
							setCachedInfo(koreaderCache, book.title, book.author, {
								title: book.title,
								description: null,
								author: book.author,
								publishedDate: null,
								publisher: null,
								pageCount: book.pageCount,
								genres: null,
								series: null,
								language: null,
								source: null,
								hardcoverAttempted: !!(settings.hardcoverEnabled && settings.hardcoverToken),
							});
							koreaderCacheModified = true;
						}

						// Determine the effective cachedInfo after potential update
						const effectiveCachedInfo = getCachedInfo(koreaderCache, book.title, book.author);

						const noteFilename = generateFilename(effectiveCachedInfo?.title ?? book.title);
						const noteFilePath = normalizePath(`${koreaderOutputPath}/${noteFilename}.md`);

						// If the resolved title changed since the last sync (e.g. Hardcover enrichment
						// just matched this book), the old note lives under a different filename —
						// rename it forward instead of leaving an orphaned duplicate behind.
						const previousTitle = cachedInfo?.title ?? book.title;
						const resolvedTitle = effectiveCachedInfo?.title ?? book.title;
						if (previousTitle !== resolvedTitle) {
							const oldFilePath = normalizePath(`${koreaderOutputPath}/${generateFilename(previousTitle)}.md`);
							if (oldFilePath !== noteFilePath && await app.vault.adapter.exists(oldFilePath)) {
								const oldFile = app.vault.getAbstractFileByPath(oldFilePath);
								if (oldFile instanceof TFile) {
									if (await app.vault.adapter.exists(noteFilePath)) {
										// Destination already exists too — drop the stale duplicate.
										await app.vault.delete(oldFile);
									} else {
										await app.fileManager.renameFile(oldFile, noteFilePath);
									}
								}
							}
						}

						// Skip-if-unchanged: compare highlights_hash and progress
						let skipBook = false;
						if (await app.vault.adapter.exists(noteFilePath)) {
							try {
								const existingContent = await app.vault.adapter.read(noteFilePath);
								const fm = extractFrontmatter(existingContent);
								if (fm) {
									const existingHash = parseFrontmatterField(fm, "highlights_hash");
									const existingProgress = parseFrontmatterField(fm, "progress");
									const currentHash = computeKOReaderHash(book.annotations);
									const currentProgress = book.progress !== null ? `${book.progress.toFixed(1)}%` : null;
									// Force a rewrite of notes written before HTML-stripping existed —
									// otherwise an unchanged book's corrupted description (and everything
									// after it, which Obsidian can fail to render past unclosed HTML) is
									// never touched again since nothing else about the book changed.
									const looksCorrupted = /<\/?(p|div|br|strong|em|li)\b[^>]*>|&#\d+;/i.test(existingContent);
									if (existingHash === currentHash &&
										existingProgress === currentProgress &&
										prefetchedInfo === undefined &&
										!looksCorrupted) {
										skipBook = true;
									}
								}
							} catch { /* proceed to update */ }
						}

						if (skipBook) {
							result.booksSkipped++;
						} else {
							// Generate or merge note
							let markdown: string;
							const fileExists = await app.vault.adapter.exists(noteFilePath);
							if (fileExists) {
								const existingContent = await app.vault.adapter.read(noteFilePath);
								markdown = mergeKOReaderNote(existingContent, book, settings, effectiveCachedInfo ?? null, coverVaultPath, null);
								await app.vault.adapter.write(noteFilePath, markdown);
								result.booksUpdated++;
							} else {
								markdown = generateKOReaderBookNote(book, settings, effectiveCachedInfo ?? null, coverVaultPath, null);
								try {
									await app.vault.create(noteFilePath, markdown);
									result.booksCreated++;
								} catch {
									await app.vault.adapter.write(noteFilePath, markdown);
									result.booksUpdated++;
								}
							}
							koreaderCacheModified = true;
						}

						result.booksProcessed++;

						// Build BookData adapter for index + Hardcover
						koreaderBooksForIndex.push(koReaderToBookData(book, coverVaultPath, effectiveCachedInfo?.title));
					} catch (error) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						result.failedBooks.push({ title: book.title, error: errorMsg });
						result.errors.push(`Error processing KOReader "${book.title}": ${errorMsg}`);
					}
				}

				if (koreaderCacheModified) {
					await saveCache(app, koreaderOutputPath, koreaderCache);
					koreaderCacheModified = false;
				}
			}
		}

		// Combined Hardcover sync — deduplicates by hardcoverId across both sources
		if (settings.hardcoverEnabled && settings.hardcoverToken && settings.hardcoverSyncProgress) {
			try {
				progressNotice.setMessage("MoonSync: Syncing to Hardcover...");

				// Internal entry type: one item per unique book, may map to notes in multiple source dirs
				interface HcEntry {
					item: HardcoverSyncItem;
					lastReadTimestamp: number | null;
					notePaths: string[];
					cacheRefs: Array<{ bookCache: BookInfoCache; title: string; author: string }>;
				}

				const buildEntries = async (
					books: BookData[],
					srcPath: string,
					srcCache: BookInfoCache
				): Promise<HcEntry[]> => {
					const entries: HcEntry[] = [];
					for (const b of books) {
						if (b.progress === null) continue;
						const cachedBook = getCachedInfo(srcCache, b.book.title, b.book.author);
						const hcLookupTitle = (cachedBook?.source === "hardcover" && cachedBook.title)
							? cachedBook.title : b.book.title;
						const filePath = normalizePath(`${srcPath}/${generateFilename(hcLookupTitle)}.md`);
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
							}
						} catch { /* ignore */ }
						const currentProgress = b.progress.toFixed(1);
						if (lastSyncedProgress && lastSyncedProgress.replace(/["%]/g, "") === currentProgress) continue;
						entries.push({
							item: {
								title: b.book.title,
								author: b.book.author,
								progress: b.progress,
								hardcoverId,
								cachedSlug: cachedBook?.hardcoverSlug,
								cachedPages: cachedBook?.hardcoverPages,
							},
							lastReadTimestamp: b.lastReadTimestamp,
							notePaths: [filePath],
							cacheRefs: [{ bookCache: srcCache, title: b.book.title, author: b.book.author }],
						});
					}
					return entries;
				};

				const mrEntries = settings.moonReaderEnabled
					? await buildEntries(booksWithHighlights, outputPath, cache)
					: [];
				const koreaderEntries = koreaderBooksForIndex.length > 0 && koreaderCache
					? await buildEntries(koreaderBooksForIndex, koreaderOutputPath, koreaderCache)
					: [];

				// Deduplicate: key by hardcoverId if known, else normalized title+author
				const dedupMap = new Map<string, HcEntry>();
				for (const entry of [...mrEntries, ...koreaderEntries]) {
					const key = entry.item.hardcoverId
						? `id:${entry.item.hardcoverId}`
						: `ta:${entry.item.title.toLowerCase()}|${(entry.item.author ?? "").toLowerCase()}`;
					const existing = dedupMap.get(key);
					if (!existing) {
						dedupMap.set(key, {
							item: { ...entry.item },
							lastReadTimestamp: entry.lastReadTimestamp,
							notePaths: [...entry.notePaths],
							cacheRefs: [...entry.cacheRefs],
						});
					} else {
						// Most recently read wins (handles restarts where progress is intentionally lower).
						// Fall back to higher progress when neither has a timestamp.
						const entryTs = entry.lastReadTimestamp ?? 0;
						const existingTs = existing.lastReadTimestamp ?? 0;
						const entryWins = entryTs !== existingTs
							? entryTs > existingTs
							: (entry.item.progress ?? 0) > (existing.item.progress ?? 0);
						if (entryWins) {
							existing.item.progress = entry.item.progress;
							existing.lastReadTimestamp = entry.lastReadTimestamp;
						}
						if (entry.item.hardcoverId && !existing.item.hardcoverId) {
							existing.item.hardcoverId = entry.item.hardcoverId;
						}
						for (const np of entry.notePaths) {
							if (!existing.notePaths.includes(np)) existing.notePaths.push(np);
						}
						existing.cacheRefs.push(...entry.cacheRefs);
					}
				}

				const allItems = [...dedupMap.values()].map(e => e.item);
				if (allItems.length > 0) {
					const hcResult = await syncBooksToHardcover(
						allItems,
						settings.hardcoverToken,
						(msg) => progressNotice.setMessage(`MoonSync: ${msg}`)
					);
					result.hardcoverUpdated = hcResult.booksUpdated;

					const newIdMap = new Map(hcResult.newIds.map(n => [n.title, n.hardcoverId]));
					const newSlugMap = new Map(hcResult.newIds.map(n => [n.title, n.slug]));
					const progressMap = new Map(allItems.map(i => [i.title, i.progress]));

					for (const title of hcResult.updatedTitles) {
						const entry = [...dedupMap.values()].find(
							e => e.item.title === title
						);
						if (!entry) continue;

						const newId = newIdMap.get(title);
						const slug = hcResult.slugs.get(title) || newSlugMap.get(title);
						const syncedProgress = progressMap.get(title);

						// Write back to ALL note files for this book (MR + KOReader)
						for (const filePath of entry.notePaths) {
							try {
								if (!await app.vault.adapter.exists(filePath)) continue;
								let content = await app.vault.adapter.read(filePath);
								const existingIdMatch = content.match(/^hardcover_id: (.+)$/m);
								const existingId = existingIdMatch ? existingIdMatch[1].trim() : null;
								content = content.replace(/^hardcover_id: .*\n/gm, "");
								content = content.replace(/^hardcover_progress: .*\n/gm, "");
								content = content.replace(/^hardcover_url: .*\n/gm, "");
								const hardcoverId = newId || existingId;
								const fields: string[] = [];
								if (hardcoverId) fields.push(`hardcover_id: ${hardcoverId}`);
								if (slug) fields.push(`hardcover_url: "https://hardcover.app/books/${slug}"`);
								if (syncedProgress != null) fields.push(`hardcover_progress: "${syncedProgress.toFixed(1)}%"`);
								if (fields.length > 0) {
									content = content.replace(/\n---\n/, `\n${fields.join("\n")}\n---\n`);
								}
								await app.vault.adapter.write(filePath, content);
							} catch { /* ignore */ }
						}

						// Update all caches
						for (const ref of entry.cacheRefs) {
							const cachedEntry = getCachedInfo(ref.bookCache, ref.title, ref.author);
							if (cachedEntry) {
								if (slug) cachedEntry.hardcoverSlug = slug;
								const pages = hcResult.pages.get(title);
								if (pages) cachedEntry.hardcoverPages = pages;
								if (newId) cachedEntry.hardcoverId = newId;
								// Mark the right cache as modified
								if (ref.bookCache === cache) cacheModified = true;
								else koreaderCacheModified = true;
							}
						}
					}

					// Save caches if modified by Hardcover sync
					if (cacheModified) await saveCache(app, outputPath, cache);
					if (koreaderCacheModified && koreaderCache) await saveCache(app, koreaderOutputPath, koreaderCache);
				}
			} catch (error) {
				console.debug("MoonSync: Hardcover sync failed", error);
			}
		}

		// Highlights sync — sends new highlights/notes to Hardcover reading journal
		if (settings.hardcoverEnabled && settings.hardcoverToken && settings.hardcoverSyncHighlights) {
			try {
				// Build list of all books with their output paths
				const allBooksWithPaths: Array<{ bookData: BookData; srcPath: string }> = [
					...booksWithHighlights.map(b => ({ bookData: b, srcPath: outputPath })),
					...koreaderBooksForIndex.map(b => ({ bookData: b, srcPath: koreaderOutputPath })),
				];

				let highlightsSynced = 0;
				let highlightsDeleted = 0;
				let hcCacheModified = false;
				let hcKoreaderCacheModified = false;
				for (const { bookData, srcPath } of allBooksWithPaths) {
					if (bookData.highlights.length === 0) continue;

					const isKOReader = bookData.source === "koreader";
					const targetCache = srcPath === outputPath ? cache : (koreaderCache ?? cache);

					// Find note and read hardcover_id + hardcover_highlights_synced_at
					const cachedBook = getCachedInfo(targetCache, bookData.book.title, bookData.book.author);
					const lookupTitle = (cachedBook?.source === "hardcover" && cachedBook.title && bookData.source !== "koreader")
						? cachedBook.title : bookData.book.title;
					const filePath = normalizePath(`${srcPath}/${generateFilename(lookupTitle)}.md`);

					let hardcoverId: number | null = null;
					let editionId: number | null = null;
					let lastSyncedAt: number | null = null;

					try {
						if (await app.vault.adapter.exists(filePath)) {
							const content = await app.vault.adapter.read(filePath);
							const fm = extractFrontmatter(content);
							if (fm) {
								const idStr = parseFrontmatterField(fm, "hardcover_id");
								if (idStr) hardcoverId = parseInt(idStr, 10) || null;
								const edStr = parseFrontmatterField(fm, "edition_id");
								if (edStr) editionId = parseInt(edStr, 10) || null;
								const syncedAtStr = parseFrontmatterField(fm, "hardcover_highlights_synced_at");
								if (syncedAtStr) lastSyncedAt = parseInt(syncedAtStr, 10) || null;
							}
						}
					} catch { /* ignore */ }

					if (!hardcoverId) continue;

					progressNotice.setMessage(`MoonSync: Syncing highlights — ${bookData.book.title}`);

					if (isKOReader) {
						// One-time migration: a book already synced under the old timestamp
						// system has no journal map yet — seed it with the highlights that
						// currently exist so they aren't re-inserted as duplicates. Their real
						// Hardcover entry id isn't known, so a future delete of one of these
						// specific highlights won't be auto-cleaned up on Hardcover's side.
						let journalMap = cachedBook?.hardcoverJournalMap;
						if (!journalMap && lastSyncedAt !== null) {
							journalMap = {};
							for (const h of bookData.highlights) {
								if (h.highlightId) journalMap[h.highlightId] = null;
							}
						}

						const hResult = await syncKOReaderHighlights(
							hardcoverId,
							editionId,
							bookData.highlights,
							bookData.pageCount,
							journalMap ?? {},
							settings.hardcoverHighlightsPrivacy,
							settings.hardcoverToken,
							(done, total) => {
								if (total > 5) {
									progressNotice.setMessage(
										`MoonSync: Syncing highlights — ${bookData.book.title} (${done}/${total})`
									);
								}
							}
						);

						highlightsSynced += hResult.synced;
						highlightsDeleted += hResult.deleted;

						if (cachedBook) {
							cachedBook.hardcoverJournalMap = hResult.journalMap;
							if (targetCache === cache) hcCacheModified = true;
							else hcKoreaderCacheModified = true;
						}
					} else {
						const hResult = await syncBookHighlights(
							hardcoverId,
							editionId,
							bookData.highlights,
							bookData.pageCount,
							lastSyncedAt,
							settings.hardcoverHighlightsPrivacy,
							settings.hardcoverToken,
							(done, total) => {
								if (total > 5) {
									progressNotice.setMessage(
										`MoonSync: Syncing highlights — ${bookData.book.title} (${done}/${total})`
									);
								}
							}
						);

						if (hResult.synced > 0) {
							highlightsSynced += hResult.synced;
							// Write hardcover_highlights_synced_at to frontmatter
							try {
								if (await app.vault.adapter.exists(filePath)) {
									let content = await app.vault.adapter.read(filePath);
									content = content.replace(/^hardcover_highlights_synced_at: .*\n/gm, "");
									content = content.replace(
										/\n---\n/,
										`\nhardcover_highlights_synced_at: ${hResult.newSyncedAt}\n---\n`
									);
									await app.vault.adapter.write(filePath, content);
								}
							} catch { /* ignore */ }
						}
					}
				}

				if (hcCacheModified) await saveCache(app, outputPath, cache);
				if (hcKoreaderCacheModified && koreaderCache) await saveCache(app, koreaderOutputPath, koreaderCache);

				if (highlightsSynced > 0 || highlightsDeleted > 0) {
					console.debug(`MoonSync: Synced ${highlightsSynced} highlights to Hardcover${highlightsDeleted > 0 ? `, removed ${highlightsDeleted}` : ""}`);
				}
			} catch (error) {
				console.debug("MoonSync: Hardcover highlights sync failed", error);
			}
		}

		// A scoped sync (triggered by one source's watcher) skips reprocessing the other
		// source entirely — reuse its last-known data for the index instead of showing it
		// as empty. It'll refresh next time that source is actually synced. Computed
		// unconditionally (not just when the index is shown) so the caller always gets
		// back the right data to cache for next time.
		const indexMoonReaderBooks = sourceScope === "koreader" && booksWithHighlights.length === 0
			? (cachedMoonReaderBooks ?? booksWithHighlights)
			: booksWithHighlights;
		const indexKOReaderBooks = sourceScope === "moonreader" && koreaderBooksForIndex.length === 0
			? (cachedKOReaderBooks ?? koreaderBooksForIndex)
			: koreaderBooksForIndex;
		result.moonReaderBooksForIndex = indexMoonReaderBooks;
		result.koreaderBooksForIndex = indexKOReaderBooks;

		// Update index note if enabled (written to base output folder)
		if (settings.showIndex) {
			const indexPath = normalizePath(`${baseOutputPath}/${settings.indexNoteTitle}.md`);
			const indexExists = await app.vault.adapter.exists(indexPath);

			const indexFilename = `${settings.indexNoteTitle}.md`;
			const hasManualBooks = customBooks.length > 0;
			if (hasManualBooks) {
				result.manualBooksAdded = customBooks.length;
			}

			if (result.booksCreated > 0 || result.booksUpdated > 0 || result.booksDeleted > 0 || !indexExists || hasManualBooks || koreaderBooksForIndex.length > 0) {
				// Populate MR cover paths
				const mrCoversFolder = normalizePath(`${outputPath}/moonsync-covers`);
				let mrExistingCovers = new Set<string>();
				try {
					if (await app.vault.adapter.exists(mrCoversFolder)) {
						const listing = await app.vault.adapter.list(mrCoversFolder);
						mrExistingCovers = new Set(listing.files.map(f => f.split("/").pop() || ""));
					}
				} catch { /* ignore */ }

				for (const bookData of booksWithHighlights) {
					if (!bookData.coverPath) {
						const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
						if (mrExistingCovers.has(coverFilename)) {
							bookData.coverPath = `moonsync-covers/${coverFilename}`;
						}
					}
				}

				await updateIndexNote(app, baseOutputPath, indexMoonReaderBooks, settings,
					indexKOReaderBooks.length > 0 ? indexKOReaderBooks : undefined,
					customBooks);
			}
		}

		// Update base file if enabled
		if (settings.generateBaseFile) {
			const baseFilePath = normalizePath(`${baseOutputPath}/${settings.baseFileName}.base`);
			const baseExists = await app.vault.adapter.exists(baseFilePath);
			if (result.booksCreated > 0 || result.booksUpdated > 0 || result.booksDeleted > 0 || !baseExists) {
				await updateBaseFile(app, baseOutputPath, settings);
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
		lines.push(`progress: ${bookData.progress.toFixed(1)}%`);
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

	// Generate highlights (sorted per user preference)
	const reverse = settings.highlightSort.endsWith("-reverse");
	const sortByDate = settings.highlightSort.startsWith("date");
	const sorted = [...bookData.highlights].sort((a, b) => {
		const cmp = sortByDate
			? a.timestamp - b.timestamp
			: a.chapter - b.chapter || a.position - b.position;
		return reverse ? -cmp : cmp;
	});

	for (const highlight of sorted) {
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
 * Update the title cache after a file rename to prevent stale entries
 */
function updateTitleCacheAfterRename(
	titleCache: TitleCacheEntry[],
	oldPath: string,
	newPath: string,
	newTitle?: string
): void {
	const idx = titleCache.findIndex(e => e.filePath === oldPath);
	if (idx !== -1) {
		titleCache[idx].filePath = newPath;
		if (newTitle) {
			titleCache[idx].normalizedTitle = normalizeBookTitle(newTitle);
		}
	}
}

/**
 * Find existing file with fuzzy matching using pre-built title cache
 * Returns the actual file path if found, otherwise returns the preferred path
 */
async function findExistingFile(
	app: App,
	outputPath: string,
	preferredFilename: string,
	bookTitle: string,
	titleCache: TitleCacheEntry[],
	previousTitle: string | null = null,
	legacyBasePath?: string
): Promise<string> {
	const preferredPath = normalizePath(`${outputPath}/${preferredFilename}.md`);

	// Check if preferred path exists (fast path)
	if (await app.vault.adapter.exists(preferredPath)) {
		return preferredPath;
	}

	// Check if a note exists at the old (pre-enrichment) title and rename it
	if (previousTitle) {
		const oldFilename = generateFilename(previousTitle);
		const oldPath = normalizePath(`${outputPath}/${oldFilename}.md`);
		if (oldPath !== preferredPath && await app.vault.adapter.exists(oldPath)) {
			try {
				await app.vault.adapter.rename(oldPath, preferredPath);
				updateTitleCacheAfterRename(titleCache, oldPath, preferredPath, bookTitle);
				console.debug(`MoonSync: Renamed "${oldFilename}.md" → "${preferredFilename}.md"`);
				return preferredPath;
			} catch {
				return oldPath;
			}
		}
	}

	// Also check the flat output root (when per-source subdirectories are in use) for a
	// note left behind before the subdir switch, or one whose title changed at the same
	// time it moved into a subdir — the bulk migration only runs once and only catches
	// same-filename stragglers, so a title change combined with the subdir move can hide
	// the old note from every other lookup here.
	if (legacyBasePath && legacyBasePath !== outputPath) {
		const rootCandidates = [preferredFilename];
		if (previousTitle) rootCandidates.push(generateFilename(previousTitle));
		for (const candidateFilename of rootCandidates) {
			const rootPath = normalizePath(`${legacyBasePath}/${candidateFilename}.md`);
			if (await app.vault.adapter.exists(rootPath)) {
				try {
					await app.vault.adapter.rename(rootPath, preferredPath);
					updateTitleCacheAfterRename(titleCache, rootPath, preferredPath, bookTitle);
					console.debug(`MoonSync: Moved stray flat note "${candidateFilename}.md" → "${preferredPath}"`);
					return preferredPath;
				} catch {
					return rootPath;
				}
			}
		}
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
				updateTitleCacheAfterRename(titleCache, bestMatch.path, preferredPath, bookTitle);
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
	// Store original title for cache key (before API updates it)
	const originalTitle = bookData.book.title;
	const originalAuthor = bookData.book.author;

	// Check cache first — if a curated source overrode the title, use that for file lookup
	const cachedInfo = getCachedInfo(cache, originalTitle, originalAuthor);
	// Apply cached Hardcover title immediately so the index uses it even if this book is skipped early
	if (cachedInfo?.source === "hardcover" && cachedInfo.title && bookData.source !== "koreader") {
		bookData.book.title = cachedInfo.title;
	}
	// For KOReader books, the source data is authoritative — never use a cached Hardcover title for lookup
	const lookupTitle = (cachedInfo?.source === "hardcover" && cachedInfo.title && cachedInfo.title !== originalTitle && bookData.source !== "koreader")
		? cachedInfo.title
		: bookData.book.title;
	const filename = generateFilename(lookupTitle);
	const baseOutputPath = normalizePath(settings.outputFolder);
	let filePath = await findExistingFile(app, outputPath, filename, lookupTitle, titleCache, bookData.previousTitle, baseOutputPath);
	let cacheModified = false;

	// Check if we've already attempted to fetch metadata
	// Once we've tried fetching (core fields are !== undefined), don't keep trying
	// Only check the original 3 fields — genres/series/language were added later
	// and may be missing from older cache entries
	const hasAttemptedBasicFetch = cachedInfo && (
		cachedInfo.publishedDate !== undefined &&
		cachedInfo.publisher !== undefined &&
		cachedInfo.pageCount !== undefined
	);

	// If Hardcover is enabled but was never attempted, re-fetch to give it a chance
	// Only for books actually fetched from another API (not placeholder entries)
	const hasAttemptedFetch = hasAttemptedBasicFetch && !(
		settings.hardcoverEnabled && settings.hardcoverToken &&
		cachedInfo!.source !== null && cachedInfo!.source !== "hardcover" &&
		!cachedInfo!.hardcoverAttempted
	);

	// If this book was pre-fetched (e.g. for Hardcover re-fetch), apply results to cache now.
	// This ensures the cache is updated even if processBook returns early (e.g. 0-highlight books).
	const prefetchKey = `${originalTitle}|${originalAuthor}`;
	const prefetchedBookInfo = prefetchedInfo.get(prefetchKey);
	if (prefetchedBookInfo) {
		const isCurated = prefetchedBookInfo.source === "hardcover" && bookData.source !== "koreader";
		setCachedInfo(cache, originalTitle, originalAuthor, {
			title: (isCurated && prefetchedBookInfo.title) ? prefetchedBookInfo.title : originalTitle,
			description: prefetchedBookInfo.description,
			author: prefetchedBookInfo.author,
			publishedDate: prefetchedBookInfo.publishedDate,
			publisher: prefetchedBookInfo.publisher,
			pageCount: prefetchedBookInfo.pageCount,
			genres: prefetchedBookInfo.genres,
			series: prefetchedBookInfo.series,
			language: prefetchedBookInfo.language,
			source: prefetchedBookInfo.source,
			hardcoverAttempted: !!(settings.hardcoverEnabled && settings.hardcoverToken),
			hardcoverId: prefetchedBookInfo.hardcoverId,
			hardcoverSlug: prefetchedBookInfo.hardcoverSlug ? prefetchedBookInfo.hardcoverSlug : undefined,
		});
		cacheModified = true;
	}

	// Check if book has changed (compare highlights hash and progress)
	const existingData = await getExistingBookData(app, filePath);
	const fileExists = existingData !== null;
	// Handle books with 0 highlights
	if (bookData.highlights.length === 0) {
		if (!fileExists) {
			// No file and no highlights — nothing to do unless tracking is on
			if (!settings.trackBooksWithoutHighlights) {
				result.booksSkipped++;
				return cacheModified;
			}
		} else if (settings.trackBooksWithoutHighlights) {
			// Keep note — skip only if highlights, progress, and last_read are all unchanged
			if (existingData.highlightsCount === 0) {
				const progressUnchanged = existingData.progress === bookData.progress;
				const newLastRead = bookData.lastReadTimestamp !== null
					? new Date(bookData.lastReadTimestamp).toISOString().split("T")[0]
					: null;
				const lastReadUnchanged = existingData.lastRead === newLastRead;
				if (progressUnchanged && lastReadUnchanged) {
					result.booksSkipped++;
					return cacheModified;
				}
			}
		} else if (hasUserNotes(existingData.fullContent!)) {
			// User has custom My Notes content — skip if already cleaned up, otherwise update
			if (existingData.highlightsCount === 0) {
				result.booksSkipped++;
				return cacheModified;
			}
		} else {
			// No tracking, no custom content — delete the note entirely
			const file = app.vault.getAbstractFileByPath(filePath);
			if (file) {
				await app.vault.trash(file, false);
				result.booksDeleted++;
			}
			return cacheModified;
		}
	}

	if (fileExists) {
		// Compute hash of current highlights for comparison
		const currentHash = computeHighlightsHash(bookData.highlights, settings.highlightSort);

		// Use hash comparison if available, fall back to count comparison for older notes
		const highlightsUnchanged = existingData.highlightsHash
			? existingData.highlightsHash === currentHash
			: existingData.highlightsCount === bookData.highlights.length;
		const progressUnchanged = existingData.progress === bookData.progress;
		const newLastRead = bookData.lastReadTimestamp !== null
			? new Date(bookData.lastReadTimestamp).toISOString().split("T")[0]
			: null;
		const lastReadUnchanged = existingData.lastRead === newLastRead;


		// Only skip if: nothing changed AND we've already attempted to fetch metadata
		// Don't skip if this book was prefetched (it was selected for a reason, e.g. Hardcover)
		if (highlightsUnchanged && progressUnchanged && lastReadUnchanged && hasAttemptedFetch && !prefetchedBookInfo) {
			// Book hasn't changed and we have complete cached data, skip
			result.booksSkipped++;
			return cacheModified;
		}
	}

	// Always fetch metadata if incomplete, regardless of settings
	// Settings only control what gets displayed, not what gets cached
	const shouldFetchMetadata = true; // Always fetch to keep cache complete
	if (shouldFetchMetadata) {
		const coverFilename = `${filename}.jpg`;
		const coversFolder = normalizePath(`${outputPath}/moonsync-covers`);
		const coverPath = normalizePath(`${coversFolder}/${coverFilename}`);

		// Skip cover download if already handled before processBook (e.g. KOReader pre-processing)
		let coverExists = bookData.coverPath ? true : await app.vault.adapter.exists(coverPath);

		// Always prefer local Moon Reader cover (extracted from epub, usually higher quality)
		if (bookData.book.coverFile && !bookData.coverPath) {
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
			// Curated sources (Hardcover) can override epub metadata;
			// other sources only fill empty fields
			const isCurated = cachedInfo.source === "hardcover" && bookData.source !== "koreader";

			if (isCurated && cachedInfo.title) {
				bookData.book.title = cachedInfo.title;
			}
			if (cachedInfo.description && (isCurated || !bookData.fetchedDescription)) {
				bookData.fetchedDescription = cachedInfo.description;
			}
			if (cachedInfo.author && (isCurated || !bookData.book.author)) {
				bookData.book.author = cachedInfo.author;
			}
			if (cachedInfo.publishedDate && (isCurated || !bookData.publishedDate)) {
				bookData.publishedDate = cachedInfo.publishedDate;
			}
			if (cachedInfo.publisher && (isCurated || !bookData.publisher)) {
				bookData.publisher = cachedInfo.publisher;
			}
			if (cachedInfo.pageCount !== null && (isCurated || bookData.pageCount === null)) {
				bookData.pageCount = cachedInfo.pageCount;
			}
			if (cachedInfo.genres && (isCurated || !bookData.genres)) {
				bookData.genres = cachedInfo.genres;
			}
			if (cachedInfo.series && (isCurated || !bookData.series)) {
				bookData.series = cachedInfo.series;
			}
			if (cachedInfo.language && (isCurated || !bookData.language)) {
				bookData.language = cachedInfo.language;
			}
		}

		// Use pre-fetched info if available; if not pre-fetched and still no cover, fetch now
		// Key uses original title/author since that's what booksToFetch used
		let bookInfo = prefetchedInfo.get(prefetchKey);

		// If book wasn't pre-fetched (e.g. local cover was expected but failed), fetch now
		if (!bookInfo && !coverExists) {
			const hcToken = settings.hardcoverEnabled && settings.hardcoverToken ? settings.hardcoverToken : undefined;
			bookInfo = await fetchBookInfo(bookData.book.title, bookData.book.author, hcToken);
		}

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

			// Curated sources (Hardcover) can override epub metadata;
			// other sources (Google Books, OpenLibrary) only fill empty fields
			const isCurated = bookInfo.source === "hardcover" && bookData.source !== "koreader";

			if (isCurated && bookInfo.title) {
				bookData.book.title = bookInfo.title;
			}

			if (bookInfo.description && (isCurated || !bookData.fetchedDescription)) {
				bookData.fetchedDescription = bookInfo.description;
			}

			if (bookInfo.author && (isCurated || !bookData.book.author)) {
				bookData.book.author = bookInfo.author;
			}

			if (bookInfo.publishedDate && (isCurated || !bookData.publishedDate)) {
				bookData.publishedDate = bookInfo.publishedDate;
			}
			if (bookInfo.publisher && (isCurated || !bookData.publisher)) {
				bookData.publisher = bookInfo.publisher;
			}
			if (bookInfo.pageCount !== null && (isCurated || bookData.pageCount === null)) {
				bookData.pageCount = bookInfo.pageCount;
			}
			if (bookInfo.genres && (isCurated || !bookData.genres)) {
				bookData.genres = bookInfo.genres;
			}
			if (bookInfo.series && (isCurated || !bookData.series)) {
				bookData.series = bookInfo.series;
			}
			if (bookInfo.language && (isCurated || !bookData.language)) {
				bookData.language = bookInfo.language;
			}
			if (bookInfo.hardcoverId && !bookData.hardcoverId) {
				bookData.hardcoverId = bookInfo.hardcoverId;
			}
			if (bookInfo.hardcoverSlug && !bookData.hardcoverSlug) {
				bookData.hardcoverSlug = bookInfo.hardcoverSlug;
			}

			// Update cache — store API title if curated, otherwise keep original
			setCachedInfo(cache, originalTitle, originalAuthor, {
				title: (isCurated && bookInfo.title) ? bookInfo.title : originalTitle,
				description: bookInfo.description,
				author: bookInfo.author,
				publishedDate: bookInfo.publishedDate,
				publisher: bookInfo.publisher,
				pageCount: bookInfo.pageCount,
				genres: bookInfo.genres,
				series: bookInfo.series,
				language: bookInfo.language,
				source: bookInfo.source,
				hardcoverAttempted: !!(settings.hardcoverEnabled && settings.hardcoverToken),
				hardcoverId: bookInfo.hardcoverId,
				hardcoverSlug: bookInfo.hardcoverSlug ? bookInfo.hardcoverSlug : undefined,
			});
			cacheModified = true;
		}

		// Write a cache entry for books that skipped the API fetch (had sufficient metadata)
		// so they don't get reprocessed every sync
		if (!cachedInfo && !bookInfo) {
			setCachedInfo(cache, originalTitle, originalAuthor, {
				title: originalTitle,
				description: bookData.book.description || null,
				author: bookData.book.author || null,
				publishedDate: bookData.publishedDate,
				publisher: bookData.publisher,
				pageCount: bookData.pageCount,
				genres: bookData.genres,
				series: bookData.series,
				language: bookData.language,
				source: null,
				hardcoverAttempted: !!(settings.hardcoverEnabled && settings.hardcoverToken),
			});
			cacheModified = true;
		}

		// Set cover path if cover already exists (don't overwrite if pre-set, e.g. by KOReader)
		if (coverExists && !bookData.coverPath) {
			bookData.coverPath = `moonsync-covers/${coverFilename}`;
		}
	}

	// Rename file if title was corrected by a curated source
	if (bookData.book.title !== originalTitle) {
		const newFilename = generateFilename(bookData.book.title);
		const newFilePath = normalizePath(`${outputPath}/${newFilename}.md`);
		if (newFilePath !== filePath) {
			if (fileExists && !(await app.vault.adapter.exists(newFilePath))) {
				try {
					await app.vault.adapter.rename(filePath, newFilePath);
					updateTitleCacheAfterRename(titleCache, filePath, newFilePath, bookData.book.title);
					console.debug(`MoonSync: Renamed "${filename}.md" → "${newFilename}.md"`);
					filePath = newFilePath;
				} catch {
					// Rename failed, keep original path
				}
			} else if (!fileExists) {
				filePath = newFilePath;
			}
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
		// Create new file (fall back to update if file was created by another path)
		try {
			await app.vault.create(filePath, markdown);
			result.booksCreated++;
		} catch {
			await app.vault.adapter.write(filePath, markdown);
			result.booksUpdated++;
		}
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
	// Once we've tried (core fields are !== undefined), don't keep trying
	if (cachedInfo &&
	    cachedInfo.publishedDate !== undefined &&
	    cachedInfo.publisher !== undefined &&
	    cachedInfo.pageCount !== undefined) {
		// Already attempted fetch, skip API calls
		return false;
	}

	// Fetch metadata from APIs
	const author = scannedBook.author || "Unknown";
	const hcToken = settings.hardcoverEnabled && settings.hardcoverToken ? settings.hardcoverToken : undefined;
	const bookInfo = await fetchBookInfo(scannedBook.title, author, hcToken);

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
 * Update the index note with summary and links to all books
 * Merges Moon+ Reader books with any manually-created book notes in the folder
 */
async function updateIndexNote(
	app: App,
	outputPath: string,
	moonReaderBooks: BookData[],
	settings: MoonSyncSettings,
	koreaderBooks?: BookData[],
	customBooks?: Awaited<ReturnType<typeof scanCustomBooks>>
): Promise<void> {
	const indexPath = normalizePath(`${outputPath}/${settings.indexNoteTitle}.md`);

	// Merge MR books with any custom (user-created) books passed in
	const allMrBooks = customBooks && customBooks.length > 0
		? mergeBookLists(moonReaderBooks, customBooks)
		: moonReaderBooks;

	const markdown = generateIndexNote(allMrBooks, settings, koreaderBooks);

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

	const baseOutputPath = normalizePath(settings.outputFolder);

	if (!(await app.vault.adapter.exists(baseOutputPath))) {
		new Notice("MoonSync: Output folder does not exist");
		return;
	}

	try {
		const mrOutputPath = getMoonReaderOutputPath(settings);
		let moonReaderBooks: BookData[] = [];
		if (settings.moonReaderEnabled && settings.syncPath) {
			try {
				moonReaderBooks = await parseAnnotationFiles(settings.syncPath, settings.trackBooksWithoutHighlights);
			} catch { /* sync path not accessible */ }
		}

		const mrCoversFolder = normalizePath(`${mrOutputPath}/moonsync-covers`);
		for (const bookData of moonReaderBooks) {
			if (!bookData.coverPath) {
				const coverFilename = `${generateFilename(bookData.book.title)}.jpg`;
				const coverPath = normalizePath(`${mrCoversFolder}/${coverFilename}`);
				if (await app.vault.adapter.exists(coverPath)) {
					bookData.coverPath = `moonsync-covers/${coverFilename}`;
				}
			}
		}

		let koreaderBooks: BookData[] | undefined;
		if (settings.koreaderEnabled && settings.koreaderSyncPath) {
			try {
				const koBooks = await fetchKOReaderBooks(settings.koreaderSyncPath);
				koreaderBooks = koBooks.map(b => koReaderToBookData(b, null));
			} catch { /* sync path not accessible */ }
		}

		await updateIndexNote(app, baseOutputPath, moonReaderBooks, settings, koreaderBooks);
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
