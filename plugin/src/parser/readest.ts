import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { BookData, MoonReaderBook, MoonReaderHighlight } from "../types";

interface ReadestConfig {
	schemaVersion?: number;
	bookHash?: string;
	config?: {
		progress?: [number, number];
		location?: string;
		updatedAt?: number;
	};
	booknotes?: ReadestAnnotation[];
	updatedAt?: number;
}

interface ReadestAnnotation {
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

// Maps Readest color names to ARGB integers compatible with getCalloutType()
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
	if (!color) return 0xFFFFFF00; // default yellow
	return COLOR_MAP[color.toLowerCase()] ?? 0xFFFFFF00;
}

// Extract spine index from epubcfi to use as a chapter proxy
// epubcfi(/6/32!/4/...) → spine item index = 32/2 = 16
function cfiToChapter(cfi: string): number {
	const match = cfi.match(/\/6\/(\d+)/);
	if (match) return Math.floor(parseInt(match[1], 10) / 2);
	return 0;
}

function makeBook(title: string): MoonReaderBook {
	return {
		id: 0,
		title,
		filename: title,
		author: "",
		description: "",
		category: "",
		thumbFile: "",
		coverFile: "",
		addTime: "",
		favorite: "",
	};
}

// Resolve the actual books directory from the user-supplied sync path.
// Readest stores books under <syncPath>/books/ — detect that automatically.
async function resolveBooksDir(syncPath: string): Promise<string> {
	const booksSubdir = join(syncPath, "books");
	try {
		const info = await stat(booksSubdir);
		if (info.isDirectory()) return booksSubdir;
	} catch { /* fall through */ }
	return syncPath;
}

// Derive a book title from the files inside a hash-named book folder.
// Prefers the epub filename; falls back to hash folder name.
async function titleFromBookDir(bookDir: string, folderName: string): Promise<string> {
	let entries: string[];
	try {
		entries = await readdir(bookDir);
	} catch {
		return folderName;
	}
	const epubFile = entries.find(f => /\.(epub|mobi|pdf|azw3?|fb2|txt)$/i.test(f));
	if (epubFile) {
		return epubFile.replace(/\.(epub|mobi|pdf|azw3?|fb2|txt)$/i, "").trim();
	}
	return folderName;
}

export async function parseReadestFiles(syncPath: string): Promise<BookData[]> {
	const results: BookData[] = [];

	const booksDir = await resolveBooksDir(syncPath);

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
			continue; // no config.json, skip
		}

		let config: ReadestConfig;
		try {
			config = JSON.parse(raw);
		} catch {
			continue;
		}

		// Derive title from epub filename inside the folder; fall back to hash folder name
		const title = await titleFromBookDir(bookDir, entry);

		// Progress
		let progress: number | null = null;
		if (config.config?.progress && config.config.progress[1] > 0) {
			progress = (config.config.progress[0] / config.config.progress[1]) * 100;
		}

		// Last read timestamp
		const lastReadTimestamp = config.config?.updatedAt ?? config.updatedAt ?? null;

		// Annotations — filter deleted entries
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

		// Cover: check for cover.png or cover.jpg in the book folder
		let localCoverData: Buffer | null = null;
		for (const coverName of ["cover.png", "cover.jpg", "cover.jpeg"]) {
			try {
				localCoverData = await readFile(join(bookDir, coverName));
				break;
			} catch {
				// try next
			}
		}

		const bookData: BookData = {
			book: makeBook(title),
			highlights,
			statistics: null,
			progress,
			currentChapter: null,
			lastReadTimestamp,
			coverPath: null, // set later after writing cover to vault
			fetchedDescription: null,
			publishedDate: null,
			publisher: null,
			pageCount: null,
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

		// Attach cover bytes as a transient field for the sync pipeline to consume
		if (localCoverData) {
			(bookData as BookData & { _readestCoverData?: Buffer })._readestCoverData = localCoverData;
		}

		results.push(bookData);
	}

	return results;
}
