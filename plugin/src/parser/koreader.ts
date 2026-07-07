import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { stripHtml } from "../utils";

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
	title?: string;
	author?: string;
	isbn?: string;
	coverFile?: string;
	updatedAt?: number;
	bookUpdatedAt?: number;
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
 * Find and read the "_<title>.json" metadata sidecar in a book's sync/<hash>/ folder.
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

/**
 * Discover books by scanning sync/<hash>/ folders directly, rather than relying on
 * library.json — that file is only written when a book is exported to a cloud
 * library, which isn't always done, so it can't be trusted as the source of truth
 * for which books exist.
 */
export async function fetchAllBooks(syncPath: string): Promise<KOReaderBookData[]> {
	const syncRoot = join(syncPath, "sync");
	let hashDirs: string[];
	try {
		const entries = await readdir(syncRoot, { withFileTypes: true });
		hashDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}

	const books = await Promise.all(
		hashDirs.map(async (hash): Promise<KOReaderBookData | null> => {
			const bookDir = join(syncPath, "books", hash);
			const syncDir = join(syncRoot, hash);

			const progressData = await readJson<{
				configs: KOReaderProgress[];
				readingStatus?: string;
				readingStatusUpdatedAt?: number;
			}>(join(syncDir, "progress.json"));
			const annotationsData = await readJson<{ notes: KOReaderAnnotation[] }>(
				join(syncDir, "annotations.json")
			);
			const sidecar = await readMetadataSidecar(syncDir);

			// Without the sidecar there's no way to know the book's title/author.
			if (!sidecar?.title) return null;

			// Skip deleted annotations, and plain bookmarks (auto-labeled "in CHAPTER X"
			// with no highlighted text) that carry no user-added note — nothing of
			// substance to put in the note.
			const annotations = (annotationsData?.notes ?? []).filter(
				(n) => !n.deletedAt && !(n.type === "bookmark" && !n.note?.trim())
			);

			const config = progressData?.configs?.[0] ?? null;
			let progressPercent: number | null = null;
			let currentPage: number | null = null;
			let pageCount: number | null = null;

			if (config) {
				progressPercent = config.progressPercent * 100;
				currentPage = config.currentPage;
				pageCount = config.pageCount;
			}

			const coverFilename = sidecar.coverFile || "cover.png";
			const coverFilePath = join(bookDir, coverFilename);
			const hasCover = await fileExists(coverFilePath);

			const { isbn10, isbn13 } = splitIsbn(sidecar.isbn);

			// Prefer the real reading status from progress.json; fall back to a rough
			// approximation from progress percent if it's not present. Percentage alone
			// can't distinguish "unread" from "did not finish" (an abandoned book at 40%
			// looks identical to one actively being read at 40%), so DNF isn't derivable
			// here — only unread/reading/finished are.
			const readingStatus = progressData?.readingStatus ?? (
				progressPercent === null ? null
					: progressPercent >= 99 ? "finished"
					: progressPercent > 0 ? "reading"
					: "unread"
			);

			return {
				hash,
				title: sidecar.title,
				// Some sidecars join multiple contributors with literal newlines
				// (e.g. graphic novels crediting author/illustrator/adapter) — that
				// breaks YAML frontmatter, so normalize to a comma-separated list.
				author: (sidecar.author ?? "").replace(/\n+/g, ", ").trim(),
				progress: progressPercent,
				currentPage,
				pageCount,
				readingStatus,
				lastUpdatedAt: sidecar.updatedAt ?? sidecar.bookUpdatedAt ?? null,
				annotations,
				coverPath: hasCover ? coverFilePath : null,
				isbn10,
				isbn13,
				publisher: sidecar.metadata?.publisher ?? null,
				publishedDate: sidecar.metadata?.published ?? null,
				series: sidecar.metadata?.series ?? null,
				seriesIndex: sidecar.metadata?.series_index ?? null,
				language: sidecar.metadata?.language ?? null,
				description: sidecar.metadata?.description ? stripHtml(sidecar.metadata.description) : null,
			};
		})
	);

	return books.filter((b): b is KOReaderBookData => b !== null);
}
