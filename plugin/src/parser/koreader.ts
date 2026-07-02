import { readFile, readdir } from "fs/promises";
import { join } from "path";

export interface KOReaderLibraryEntry {
	bookHash: string;
	title: string;
	author: string;
	progress?: [number, number];
	readingStatus?: string;
	readingStatusUpdatedAt?: number;
	updatedAt: number;
	createdAt: number;
}

export interface KOReaderProgress {
	currentPage: number;
	pageCount: number;
	progressPercent: number;
	xpointer: string;
	updatedAt: number;
}

export interface KOReaderAnnotation {
	id: string;
	bookHash: string;
	type: "annotation" | "bookmark";
	style?: string;
	text: string;
	note?: string;
	color?: string;
	page: number;
	xpointer0?: string;
	xpointer1?: string;
	createdAt: number;
	updatedAt: number;
	deletedAt?: number | null;
}

interface KOReaderMetadataSidecar {
	bookHash: string;
	isbn?: string;
	coverFile?: string;
	metadata?: {
		language?: string;
		description?: string;
		publisher?: string;
		published?: string;
		series?: string;
		series_index?: number;
	};
}

export interface KOReaderBookData {
	hash: string;
	title: string;
	author: string;
	progress: number | null;
	currentPage: number | null;
	pageCount: number | null;
	readingStatus: string | null;
	lastUpdatedAt: number | null;
	annotations: KOReaderAnnotation[];
	coverPath: string | null;
	isbn10: string | null;
	isbn13: string | null;
	publisher: string | null;
	publishedDate: string | null;
	series: string | null;
	seriesIndex: number | null;
	language: string | null;
	description: string | null;
}

async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		const data = await readFile(filePath, "utf-8");
		return JSON.parse(data) as T;
	} catch {
		return null;
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await readFile(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Split a single ISBN string into its ISBN-10 or ISBN-13 form by length.
 * Strips hyphens/spaces first since some sources format ISBNs with separators.
 */
function splitIsbn(isbn: string | undefined): { isbn10: string | null; isbn13: string | null } {
	if (!isbn) return { isbn10: null, isbn13: null };
	const clean = isbn.replace(/[^0-9Xx]/g, "");
	if (clean.length === 13) return { isbn10: null, isbn13: clean };
	if (clean.length === 10) return { isbn10: clean, isbn13: null };
	return { isbn10: null, isbn13: null };
}

/**
 * Find and read the "_<title>.json" metadata sidecar in a book's books/<hash>/ folder.
 * The filename is derived from the book's title, so we scan for the "_*.json" pattern
 * rather than guessing the exact name.
 */
async function readMetadataSidecar(bookDir: string): Promise<KOReaderMetadataSidecar | null> {
	try {
		const files = await readdir(bookDir);
		const sidecarName = files.find((f) => f.startsWith("_") && f.endsWith(".json"));
		if (!sidecarName) return null;
		return await readJson<KOReaderMetadataSidecar>(join(bookDir, sidecarName));
	} catch {
		return null;
	}
}

export async function fetchAllBooks(syncPath: string): Promise<KOReaderBookData[]> {
	const library = await readJson<{ books: KOReaderLibraryEntry[] }>(
		join(syncPath, "library.json")
	);
	if (!library?.books?.length) return [];

	const books: KOReaderBookData[] = await Promise.all(
		library.books.map(async (entry) => {
			const hash = entry.bookHash;
			const bookDir = join(syncPath, "books", hash);

			const progressData = await readJson<{ configs: KOReaderProgress[] }>(
				join(syncPath, "sync", hash, "progress.json")
			);
			const annotationsData = await readJson<{ notes: KOReaderAnnotation[] }>(
				join(syncPath, "sync", hash, "annotations.json")
			);
			const sidecar = await readMetadataSidecar(bookDir);

			const config = progressData?.configs?.[0] ?? null;
			const annotations = (annotationsData?.notes ?? []).filter((n) => !n.deletedAt);

			let progressPercent: number | null = null;
			let currentPage: number | null = null;
			let pageCount: number | null = null;

			if (config) {
				progressPercent = config.progressPercent * 100;
				currentPage = config.currentPage;
				pageCount = config.pageCount;
			} else if (entry.progress) {
				const [cur, total] = entry.progress;
				if (total > 0) progressPercent = (cur / total) * 100;
				currentPage = cur;
				pageCount = total;
			}

			const coverFilename = sidecar?.coverFile || "cover.png";
			const coverFilePath = join(bookDir, coverFilename);
			const hasCover = await fileExists(coverFilePath);

			const { isbn10, isbn13 } = splitIsbn(sidecar?.isbn);

			return {
				hash,
				title: entry.title,
				author: entry.author,
				progress: progressPercent,
				currentPage,
				pageCount,
				readingStatus: entry.readingStatus ?? null,
				lastUpdatedAt: entry.updatedAt ?? null,
				annotations,
				coverPath: hasCover ? coverFilePath : null,
				isbn10,
				isbn13,
				publisher: sidecar?.metadata?.publisher ?? null,
				publishedDate: sidecar?.metadata?.published ?? null,
				series: sidecar?.metadata?.series ?? null,
				seriesIndex: sidecar?.metadata?.series_index ?? null,
				language: sidecar?.metadata?.language ?? null,
				description: sidecar?.metadata?.description ?? null,
			};
		})
	);

	return books;
}
