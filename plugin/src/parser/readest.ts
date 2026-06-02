import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { BookData, MoonReaderBook, MoonReaderHighlight } from "../types";

// ── library.json types ──────────────────────────────────────────────────────

interface LibraryBook {
	hash: string;
	format: string;
	title: string;
	author: string;
	groupId: string | null;
	groupName: string | null;
	tags: string[] | null;
	progress: [number, number] | null;
	readingStatus: string | null;
	sourceTitle: string;
	metadata: LibraryMetadata;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	primaryLanguage: string | null;
	coverImageUrl?: string;
}

interface LibraryMetadata {
	title?: string;
	description?: string;
	publisher?: string;
	published?: string;
	language?: string;
	isbn?: string;
	author?: { name?: string } | string;
	subject?: string | string[];
	belongsTo?: {
		series?: { name?: string; position?: number };
	};
	series?: string;
	seriesIndex?: number;
}

interface Library {
	schemaVersion?: number;
	books: LibraryBook[];
	updatedAt?: number;
}

// ── per-book config.json types ───────────────────────────────────────────────

interface BookConfig {
	config?: {
		progress?: [number, number];
		location?: string;
		updatedAt?: number;
	};
	booknotes?: Annotation[];
	updatedAt?: number;
}

interface Annotation {
	id: string;
	type: string;
	cfi: string;
	page: number;
	text: string;
	style: string | null;
	color: string | null;
	note: string;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, number> = {
	yellow:  0xFFFFFF00,
	blue:    0xFF0000FF,
	green:   0xFF00FF00,
	red:     0xFFFF0000,
	violet:  0xFF8000FF,
	purple:  0xFF8000FF,
	pink:    0xFFFF69B4,
	orange:  0xFFFF8C00,
};

function colorToArgb(color: string | null): number {
	if (!color) return 0xFFFFFF00;
	return COLOR_MAP[color.toLowerCase()] ?? 0xFFFFFF00;
}

function cfiToChapter(cfi: string): number {
	const match = cfi.match(/\/6\/(\d+)/);
	if (match) return Math.floor(parseInt(match[1], 10) / 2);
	return 0;
}

// Clean up comic/CBZ filenames that include scene release group tags.
// Strips trailing parenthetical groups like (2015), (digital), (F), (Son of Ultron-Empire).
// Only applied to non-EPUB formats where metadata.title == sourceTitle (no real metadata).
function cleanComicTitle(title: string): string {
	// Repeatedly strip trailing (...) groups separated by optional whitespace
	let cleaned = title.replace(/(\s*\([^)]*\))+\s*$/, "").trim();
	// Strip trailing " -" or "- " left after removal
	cleaned = cleaned.replace(/\s*[-–]\s*$/, "").trim();
	return cleaned || title; // fall back to original if we stripped everything
}

function stripHtml(html: string): string {
	return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
}

function resolveAuthor(entry: LibraryBook): string {
	if (entry.author) return entry.author;
	const meta = entry.metadata?.author;
	if (!meta) return "";
	if (typeof meta === "string") return meta;
	return meta.name ?? "";
}

function resolveGenres(entry: LibraryBook): string[] | null {
	const subject = entry.metadata?.subject;
	if (!subject) return null;
	if (Array.isArray(subject)) return subject.filter(Boolean);
	if (typeof subject === "string" && subject.trim()) return [subject.trim()];
	return null;
}

function resolveSeries(entry: LibraryBook): string | null {
	const series = entry.metadata?.belongsTo?.series?.name || entry.metadata?.series;
	return series ?? null;
}

function makeBook(title: string, author: string): MoonReaderBook {
	return {
		id: 0,
		title,
		filename: title,
		author,
		description: "",
		category: "",
		thumbFile: "",
		coverFile: "",
		addTime: "",
		favorite: "",
	};
}

// Resolve the books/ subdirectory from the user-supplied sync path.
async function resolveBooksDir(syncPath: string): Promise<string> {
	const booksSubdir = join(syncPath, "books");
	try {
		const info = await stat(booksSubdir);
		if (info.isDirectory()) return booksSubdir;
	} catch { /* fall through */ }
	return syncPath;
}

// ── main export ──────────────────────────────────────────────────────────────

export async function parseReadestFiles(syncPath: string): Promise<BookData[]> {
	const results: BookData[] = [];

	// Find the books/ subdirectory
	const booksDir = await resolveBooksDir(syncPath);
	// library.json lives next to the books/ folder (i.e. in syncPath root)
	const libraryPath = join(syncPath, "library.json");

	// Load library.json — this is our primary metadata source
	let library: Library | null = null;
	try {
		const raw = await readFile(libraryPath, "utf-8");
		library = JSON.parse(raw);
	} catch { /* no library.json, fall back to scanning */ }

	if (library?.books?.length) {
		// Primary path: use library.json
		for (const entry of library.books) {
			if (entry.deletedAt !== null) continue;

			const bookDir = join(booksDir, entry.hash);

			// Read per-book config.json for annotations and precise last-read timestamp
			let bookConfig: BookConfig | null = null;
			try {
				const raw = await readFile(join(bookDir, "config.json"), "utf-8");
				bookConfig = JSON.parse(raw);
			} catch { /* no config, use library data only */ }

			let title = entry.title || entry.sourceTitle || entry.hash;
			// CBZ/PDF files often have scene-release filenames as titles — strip trailing tags
			const isRawFilename = entry.format !== "EPUB" && entry.format !== "MOBI" &&
				!entry.metadata?.description && !entry.metadata?.publisher;
			if (isRawFilename) title = cleanComicTitle(title);
			const author = resolveAuthor(entry);

			// Progress: prefer library.json (master state); fall back to config.json
			let progress: number | null = null;
			const progressArr = entry.progress ?? bookConfig?.config?.progress;
			if (progressArr && progressArr[1] > 0) {
				progress = (progressArr[0] / progressArr[1]) * 100;
			}

			// Last-read timestamp
			const lastReadTimestamp = bookConfig?.config?.updatedAt
				?? bookConfig?.updatedAt
				?? entry.updatedAt
				?? null;

			// Annotations from config.json
			const annotations = (bookConfig?.booknotes ?? []).filter(n => n.deletedAt === null);
			const highlights: MoonReaderHighlight[] = annotations.map((ann, idx) => ({
				id: idx,
				book: title,
				filename: title,
				chapter: cfiToChapter(ann.cfi),
				position: ann.page,
				highlightLength: ann.text?.length ?? 0,
				highlightColor: colorToArgb(ann.color),
				timestamp: ann.createdAt,
				bookmark: "",
				note: ann.note ?? "",
				originalText: ann.text ?? "",
				underline: false,
				strikethrough: false,
			}));

			// Metadata from library.json
			const meta = entry.metadata ?? {};
			const description = meta.description ? stripHtml(meta.description) : null;
			const publisher = meta.publisher ?? null;
			const publishedDate = meta.published ?? null;
			const isbn = meta.isbn ?? null;
			const language = entry.primaryLanguage ?? (typeof meta.language === "string" ? meta.language.split("-")[0].toLowerCase() : null);
			const genres = resolveGenres(entry);
			const series = resolveSeries(entry);
			const seriesIndex = entry.metadata?.belongsTo?.series?.position ?? entry.metadata?.seriesIndex ?? null;
			const seriesStr = series && seriesIndex ? `${series} #${seriesIndex}` : series;

			// Cover: try sync folder first, then fall back to local Readest app storage
			let localCoverData: Buffer | null = null;
			for (const coverName of ["cover.png", "cover.jpg", "cover.jpeg"]) {
				try {
					localCoverData = await readFile(join(bookDir, coverName));
					break;
				} catch { /* try next */ }
			}
			if (!localCoverData && entry.coverImageUrl) {
				// coverImageUrl is asset://localhost/<url-encoded-path>
				try {
					const localPath = decodeURIComponent(
						entry.coverImageUrl.replace(/^asset:\/\/localhost/, "")
					);
					localCoverData = await readFile(localPath);
				} catch { /* not available locally */ }
			}

			const bookData: BookData = {
				book: makeBook(title, author),
				highlights,
				statistics: null,
				progress,
				currentChapter: null,
				lastReadTimestamp,
				coverPath: null,
				fetchedDescription: description,
				publishedDate,
				publisher,
				pageCount: progressArr?.[1] ?? null,
				genres,
				series: seriesStr,
				isbn10: null,
				isbn13: isbn ?? null,
				language,
				previousTitle: entry.hash, // rename any old hash-named notes to title-based names
				hardcoverId: null,
				hardcoverSlug: null,
				source: "readest",
			};

			if (localCoverData) {
				(bookData as BookData & { _readestCoverData?: Buffer })._readestCoverData = localCoverData;
			}

			results.push(bookData);
		}

		return results;
	}

	// Fallback path: no library.json — scan hash folders directly
	let entries: string[];
	try {
		entries = await readdir(booksDir);
	} catch {
		return results;
	}

	for (const entry of entries) {
		const bookDir = join(booksDir, entry);
		try {
			const info = await stat(bookDir);
			if (!info.isDirectory()) continue;
		} catch {
			continue;
		}

		const configPath = join(bookDir, "config.json");
		let raw: string;
		try {
			raw = await readFile(configPath, "utf-8");
		} catch {
			continue;
		}

		let config: BookConfig;
		try {
			config = JSON.parse(raw);
		} catch {
			continue;
		}

		// Derive title from epub filename in the folder; fall back to hash
		let title = entry;
		try {
			const dirEntries = await readdir(bookDir);
			const epubFile = dirEntries.find(f => /\.(epub|mobi|pdf|azw3?|fb2|txt)$/i.test(f));
			if (epubFile) title = epubFile.replace(/\.(epub|mobi|pdf|azw3?|fb2|txt)$/i, "").trim();
		} catch { /* keep hash */ }

		let progress: number | null = null;
		if (config.config?.progress && config.config.progress[1] > 0) {
			progress = (config.config.progress[0] / config.config.progress[1]) * 100;
		}

		const lastReadTimestamp = config.config?.updatedAt ?? config.updatedAt ?? null;
		const annotations = (config.booknotes ?? []).filter(n => n.deletedAt === null);
		const highlights: MoonReaderHighlight[] = annotations.map((ann, idx) => ({
			id: idx,
			book: title,
			filename: title,
			chapter: cfiToChapter(ann.cfi),
			position: ann.page,
			highlightLength: ann.text?.length ?? 0,
			highlightColor: colorToArgb(ann.color),
			timestamp: ann.createdAt,
			bookmark: "",
			note: ann.note ?? "",
			originalText: ann.text ?? "",
			underline: false,
			strikethrough: false,
		}));

		let localCoverData: Buffer | null = null;
		for (const coverName of ["cover.png", "cover.jpg", "cover.jpeg"]) {
			try {
				localCoverData = await readFile(join(bookDir, coverName));
				break;
			} catch { /* try next */ }
		}

		const bookData: BookData = {
			book: makeBook(title, ""),
			highlights,
			statistics: null,
			progress,
			currentChapter: null,
			lastReadTimestamp,
			coverPath: null,
			fetchedDescription: null,
			publishedDate: null,
			publisher: null,
			pageCount: config.config?.progress?.[1] ?? null,
			genres: null,
			series: null,
			isbn10: null,
			isbn13: null,
			language: null,
			previousTitle: null,
			hardcoverId: null,
			hardcoverSlug: null,
			source: "readest",
		};

		if (localCoverData) {
			(bookData as BookData & { _readestCoverData?: Buffer })._readestCoverData = localCoverData;
		}

		results.push(bookData);
	}

	return results;
}
