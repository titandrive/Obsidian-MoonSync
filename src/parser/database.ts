import initSqlJs, { Database } from "sql.js";
import { readFile } from "fs/promises";
import {
	MoonReaderBook,
	MoonReaderHighlight,
	MoonReaderStatistics,
	BookData,
} from "../types";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

/**
 * Initialize sql.js with the WASM binary
 */
export async function initDatabase(wasmPath: string): Promise<void> {
	if (!SQL) {
		// Read the WASM file as a buffer (Node.js context)
		const wasmBinary = await readFile(wasmPath);
		SQL = await initSqlJs({
			wasmBinary,
		});
	}
}

/**
 * Parse the Moon Reader database and extract all book data
 */
export async function parseDatabase(
	dbBuffer: ArrayBuffer,
	wasmPath: string
): Promise<BookData[]> {
	await initDatabase(wasmPath);

	if (!SQL) {
		throw new Error("sql.js not initialized");
	}

	const db = new SQL.Database(new Uint8Array(dbBuffer));

	try {
		const books = getBooks(db);
		const allHighlights = getHighlights(db);
		const allStatistics = getStatistics(db);

		// Group highlights by book filename
		const highlightsByBook = new Map<string, MoonReaderHighlight[]>();
		for (const highlight of allHighlights) {
			const key = highlight.filename.toLowerCase();
			if (!highlightsByBook.has(key)) {
				highlightsByBook.set(key, []);
			}
			highlightsByBook.get(key)!.push(highlight);
		}

		// Group statistics by book filename
		const statisticsByBook = new Map<string, MoonReaderStatistics>();
		for (const stat of allStatistics) {
			statisticsByBook.set(stat.filename.toLowerCase(), stat);
		}

		// Combine data for each book
		const bookDataList: BookData[] = [];
		for (const book of books) {
			const key = book.filename.toLowerCase();
			const highlights = highlightsByBook.get(key) || [];
			const statistics = statisticsByBook.get(key) || null;

			// Calculate progress from statistics dates field if available
			let progress: number | null = null;
			if (statistics?.dates) {
				const progressMatch = statistics.dates.match(/#([\d.]+)%/);
				if (progressMatch) {
					progress = parseFloat(progressMatch[1]);
				}
			}

			bookDataList.push({
				book,
				highlights: highlights.sort((a, b) => a.position - b.position),
				statistics,
				progress,
			});
		}

		return bookDataList;
	} finally {
		db.close();
	}
}

function getBooks(db: Database): MoonReaderBook[] {
	const results = db.exec(
		`SELECT _id, book, filename, author, description, category,
		        thumbFile, coverFile, addTime, favorite
		 FROM books`
	);

	if (results.length === 0) {
		return [];
	}

	const rows = results[0].values;
	return rows.map((row) => ({
		id: row[0] as number,
		title: (row[1] as string) || "",
		filename: (row[2] as string) || "",
		author: (row[3] as string) || "",
		description: (row[4] as string) || "",
		category: (row[5] as string) || "",
		thumbFile: (row[6] as string) || "",
		coverFile: (row[7] as string) || "",
		addTime: (row[8] as string) || "",
		favorite: (row[9] as string) || "",
	}));
}

function getHighlights(db: Database): MoonReaderHighlight[] {
	const results = db.exec(
		`SELECT _id, book, filename, lastChapter, lastPosition, highlightLength,
		        highlightColor, time, bookmark, note, original, underline, strikethrough
		 FROM notes`
	);

	if (results.length === 0) {
		return [];
	}

	const rows = results[0].values;
	return rows.map((row) => ({
		id: row[0] as number,
		book: (row[1] as string) || "",
		filename: (row[2] as string) || "",
		chapter: (row[3] as number) || 0,
		position: (row[4] as number) || 0,
		highlightLength: (row[5] as number) || 0,
		highlightColor: (row[6] as number) || 0,
		timestamp: (row[7] as number) || 0,
		bookmark: (row[8] as string) || "",
		note: (row[9] as string) || "",
		originalText: (row[10] as string) || "",
		underline: Boolean(row[11]),
		strikethrough: Boolean(row[12]),
	}));
}

function getStatistics(db: Database): MoonReaderStatistics[] {
	const results = db.exec(
		`SELECT _id, filename, usedTime, readWords, dates
		 FROM statistics`
	);

	if (results.length === 0) {
		return [];
	}

	const rows = results[0].values;
	return rows.map((row) => ({
		id: row[0] as number,
		filename: (row[1] as string) || "",
		usedTime: (row[2] as number) || 0,
		readWords: (row[3] as number) || 0,
		dates: (row[4] as string) || "",
	}));
}
