import { App, normalizePath } from "obsidian";
import { BookData, MoonReaderBook, MoonReaderHighlight } from "./types";
import { generateFilename } from "./writer/markdown";
import { parseFrontmatter as parseSharedFrontmatter } from "./utils";

/**
 * Parsed book data from a markdown file's frontmatter
 */
export interface ScannedBook {
	title: string;
	author: string | null;
	progress: number | null;
	highlightsCount: number;
	notesCount: number;
	coverPath: string | null;
	lastReadTimestamp: number | null;
	filePath: string;
	isMoonReader: boolean; // Has moon_reader_path in frontmatter
}

/**
 * Scan all markdown files in the output folder and parse their frontmatter
 * to find book notes (files with title in frontmatter)
 */
export async function scanAllBookNotes(app: App, outputPath: string): Promise<ScannedBook[]> {
	const books: ScannedBook[] = [];
	const normalizedPath = normalizePath(outputPath);

	// Check if folder exists
	if (!(await app.vault.adapter.exists(normalizedPath))) {
		return books;
	}

	// List all files in the output folder
	const listing = await app.vault.adapter.list(normalizedPath);

	for (const filePath of listing.files) {
		// Only process markdown files, skip the index
		if (!filePath.endsWith(".md")) continue;

		try {
			const content = await app.vault.adapter.read(filePath);
			const bookData = parseBookFrontmatter(content, filePath);

			if (bookData) {
				books.push(bookData);
			}
		} catch (error) {
			console.log(`MoonSync: Failed to read ${filePath}`, error);
		}
	}

	return books;
}

/**
 * Parse frontmatter from a markdown file to extract book data
 */
function parseBookFrontmatter(content: string, filePath: string): ScannedBook | null {
	const parsed = parseSharedFrontmatter(content);

	// Title is required
	if (!parsed.title) {
		return null;
	}

	// Count notes by looking for "**Note:**" in the content
	const notesCount = (content.match(/\*\*Note:\*\*/g) || []).length;

	// Estimate last read timestamp from last_synced date
	let lastReadTimestamp: number | null = null;
	if (parsed.lastSynced) {
		lastReadTimestamp = new Date(parsed.lastSynced).getTime();
	}

	return {
		title: parsed.title,
		author: parsed.author,
		progress: parsed.progress,
		highlightsCount: parsed.highlightsCount ?? 0,
		notesCount,
		coverPath: parsed.coverPath,
		lastReadTimestamp,
		filePath,
		isMoonReader: !!parsed.moonReaderPath,
	};
}

/**
 * Convert a scanned book to BookData format for use in index generation
 */
export function scannedBookToBookData(scanned: ScannedBook): BookData {
	// Extract the actual filename from the file path (without path and extension)
	const filenameWithExt = scanned.filePath.split("/").pop() || "";
	const actualFilename = filenameWithExt.replace(/\.md$/, "");

	const book: MoonReaderBook = {
		id: 0,
		title: scanned.title,
		filename: actualFilename, // Store actual filename for index links
		author: scanned.author || "",
		description: "",
		category: "",
		thumbFile: "",
		coverFile: "",
		addTime: "",
		favorite: "",
	};

	// Create placeholder highlights array with the right count
	// We don't need the actual highlight content, just the count
	const highlights: MoonReaderHighlight[] = [];
	for (let i = 0; i < scanned.highlightsCount; i++) {
		highlights.push({
			id: i,
			book: scanned.title,
			filename: "",
			chapter: 0,
			position: 0,
			highlightLength: 0,
			highlightColor: 0,
			timestamp: 0,
			bookmark: "",
			note: i < scanned.notesCount ? "note" : "", // Mark first N as having notes
			originalText: "",
			underline: false,
			strikethrough: false,
		});
	}

	return {
		book,
		highlights,
		statistics: null,
		progress: scanned.progress,
		currentChapter: null,
		lastReadTimestamp: scanned.lastReadTimestamp,
		coverPath: scanned.coverPath,
		fetchedDescription: null,
		publishedDate: null,
		publisher: null,
		pageCount: null,
		genres: null,
		series: null,
		isbn10: null,
		isbn13: null,
		language: null,
	};
}

/**
 * Merge Moon+ Reader books with scanned books, avoiding duplicates
 * Moon+ Reader books take precedence, but we preserve actual filenames from disk
 */
export function mergeBookLists(moonReaderBooks: BookData[], scannedBooks: ScannedBook[]): BookData[] {
	const result = [...moonReaderBooks];

	// Create a map of Moon+ Reader books by lowercase title for matching
	const moonReaderMap = new Map<string, BookData>();
	for (const book of result) {
		moonReaderMap.set(book.book.title.toLowerCase(), book);
	}

	// Helper to find a Moon Reader book by title, with fuzzy matching
	// Handles cases where titles differ (e.g., "We Are Legion" vs "We Are Legion (We Are Bob)")
	function findMoonReaderBook(scannedTitle: string): BookData | undefined {
		const scannedLower = scannedTitle.toLowerCase();

		// Try exact match first
		const exactMatch = moonReaderMap.get(scannedLower);
		if (exactMatch) return exactMatch;

		// Try prefix matching - one title starts with the other
		for (const [moonTitle, book] of moonReaderMap) {
			if (scannedLower.startsWith(moonTitle) || moonTitle.startsWith(scannedLower)) {
				return book;
			}
		}

		return undefined;
	}

	// Update Moon+ Reader books with actual filenames from scanned books
	// and add scanned books that aren't in Moon+ Reader
	for (const scanned of scannedBooks) {
		const moonReaderBook = findMoonReaderBook(scanned.title);

		if (moonReaderBook) {
			// This scanned book matches a Moon+ Reader book - update filename, title, and coverPath
			// Extract the actual filename from the file path
			const filenameWithExt = scanned.filePath.split("/").pop() || "";
			const actualFilename = filenameWithExt.replace(/\.md$/, "");
			moonReaderBook.book.filename = actualFilename;
			// Update title from scanned note (has canonical Google Books title)
			moonReaderBook.book.title = scanned.title;
			// Preserve cover path from the existing note
			if (scanned.coverPath) {
				moonReaderBook.coverPath = scanned.coverPath;
			}
		} else {
			// This is a manual book not from Moon+ Reader - add it
			result.push(scannedBookToBookData(scanned));
		}
	}

	return result;
}
