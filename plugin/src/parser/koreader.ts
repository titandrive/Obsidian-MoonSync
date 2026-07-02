import { readFile } from "fs/promises";
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

export async function fetchAllBooks(syncPath: string): Promise<KOReaderBookData[]> {
	const library = await readJson<{ books: KOReaderLibraryEntry[] }>(
		join(syncPath, "library.json")
	);
	if (!library?.books?.length) return [];

	const books: KOReaderBookData[] = await Promise.all(
		library.books.map(async (entry) => {
			const hash = entry.bookHash;

			const progressData = await readJson<{ configs: KOReaderProgress[] }>(
				join(syncPath, "sync", hash, "progress.json")
			);
			const annotationsData = await readJson<{ notes: KOReaderAnnotation[] }>(
				join(syncPath, "sync", hash, "annotations.json")
			);

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

			const coverFilePath = join(syncPath, "books", hash, "cover.png");
			const hasCover = await fileExists(coverFilePath);

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
			};
		})
	);

	return books;
}
