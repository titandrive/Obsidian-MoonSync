import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { inflateSync } from "zlib";
import { MoonReaderHighlight, BookData, MoonReaderBook } from "../types";

interface AnnotationFile {
	filename: string;
	bookTitle: string;
	author: string;
	highlights: MoonReaderHighlight[];
}

/**
 * Normalize book title by removing file extensions and known author suffix
 */
function normalizeBookTitle(title: string, author?: string): string {
	let normalized = title.replace(/\.(epub|mobi|pdf|azw3?|fb2|txt)$/i, "");

	// Only strip author if we know what it is and the title ends with it
	if (author && normalized.endsWith(` - ${author}`)) {
		normalized = normalized.slice(0, -(` - ${author}`.length));
	}

	return normalized.trim();
}

/**
 * Parse a single .an annotation file
 */
function parseAnnotationFile(data: Buffer, filename: string): AnnotationFile | null {
	try {
		// Decompress zlib data
		const decompressed = inflateSync(data).toString("utf-8");
		const lines = decompressed.split("\n");

		// Extract book title and author from filename (fallback if not in annotation data)
		// Format: "Book Title - Author Name.epub.an"
		const baseName = filename.replace(/\.epub\.an$/, "").replace(/\.pdf\.an$/, "");
		const parts = baseName.split(" - ");
		const bookTitle = normalizeBookTitle(parts[0] || baseName);
		const author = parts.length > 1 ? parts.slice(1).join(" - ") : "";

		const highlights: MoonReaderHighlight[] = [];
		let i = 0;

		// Skip header lines until we hit the first #
		while (i < lines.length && lines[i] !== "#") {
			i++;
		}

		// Parse each highlight block
		while (i < lines.length) {
			if (lines[i] === "#") {
				i++;
				if (i >= lines.length) break;

				// Parse highlight block
				const id = parseInt(lines[i++] || "0", 10);
				const title = lines[i++] || "";
				const fullPath = lines[i++] || "";
				i++; // skip lower path
				const chapter = parseInt(lines[i++] || "0", 10);
				i++; // skip 0
				const position = parseInt(lines[i++] || "0", 10);
				const length = parseInt(lines[i++] || "0", 10);
				const color = parseInt(lines[i++] || "0", 10);
				const timestamp = parseInt(lines[i++] || "0", 10);

				// Skip empty lines before text
				while (i < lines.length && lines[i] === "") {
					i++;
				}

				// Read highlight text and optional note
				// Format: if two lines before 0s, first is note, second is highlight text
				// If only one line, it's just the highlight text with no note
				let text = "";
				let note = "";

				if (i < lines.length && lines[i] !== "0") {
					const firstLine = lines[i].replace(/<BR>/g, "\n").trim();
					i++;

					// Check if there's a second line (not "0" and not empty)
					if (i < lines.length && lines[i] !== "0" && lines[i] !== "") {
						// Two lines: first is note, second is highlight text
						note = firstLine;
						text = lines[i].replace(/<BR>/g, "\n").trim();
						i++;
					} else {
						// Only one line: it's the highlight text, no note
						text = firstLine;
					}
				}

				// Skip the trailing 0, 0, 0
				while (i < lines.length && (lines[i] === "0" || lines[i] === "")) {
					i++;
				}

				if (text) {
					highlights.push({
						id,
						book: normalizeBookTitle(title, author),
						filename: fullPath,
						chapter,
						position,
						highlightLength: length,
						highlightColor: color,
						timestamp,
						bookmark: "",
						note,
						originalText: text,
						underline: false,
						strikethrough: false,
					});
				}
			} else {
				i++;
			}
		}

		return {
			filename,
			bookTitle,
			author,
			highlights,
		};
	} catch (error) {
		console.debug(`MoonSync: Failed to parse annotation file ${filename}`, error);
		return null;
	}
}

interface ProgressData {
	progress: number;
	chapter: number;
	timestamp: number;
}

/**
 * Parse a .po position file to extract reading progress
 * Format: timestamp*chapter@marker#position:PERCENTAGE%
 * Example: 1761402987558*25@0#2018:41.1%
 */
function parseProgressFile(data: Buffer): ProgressData | null {
	try {
		const content = data.toString("utf-8").trim();
		// Parse the full format: timestamp*chapter@marker#position:percentage%
		const match = content.match(/^(\d+)\*(\d+)@\d+#\d+:(\d+(?:\.\d+)?)%$/);
		if (match) {
			return {
				timestamp: parseInt(match[1], 10),
				chapter: parseInt(match[2], 10),
				progress: parseFloat(match[3]),
			};
		}
	} catch {
		// Failed to parse progress
	}
	return null;
}

/**
 * Read all annotation files from the Cache folder
 */
/**
 * Normalize a book title into a stable map key by lowercasing and stripping punctuation.
 * This ensures .an titles (e.g. "Frankenstein; Or, The Modern Prometheus") and
 * .po filenames (e.g. "Frankenstein Or The Modern Prometheus") produce the same key.
 */
function normalizeKey(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

export async function parseAnnotationFiles(syncPath: string, trackBooksWithoutHighlights: boolean = false): Promise<BookData[]> {
	const cacheDir = join(syncPath, ".Moon+", "Cache");
	const bookDataMap = new Map<string, BookData>();

	try {
		const files = await readdir(cacheDir);
		const anFiles = files.filter((f) => f.endsWith(".an"));

		for (const anFile of anFiles) {
			try {
				const filePath = join(cacheDir, anFile);
				const data = await readFile(filePath);
				const parsed = parseAnnotationFile(data, anFile);

				if (parsed) {
					// Use the title from inside the annotation data when available (more reliable),
					// fall back to filename-derived title when there are no highlights
					const actualTitle = (parsed.highlights.length > 0 ? parsed.highlights[0]?.book : null) || parsed.bookTitle;
					const key = normalizeKey(actualTitle);

					if (!bookDataMap.has(key)) {
						const book: MoonReaderBook = {
							id: 0,
							title: actualTitle,
							filename: (parsed.highlights.length > 0 ? parsed.highlights[0]?.filename : null) || "",
							author: parsed.author,
							description: "",
							category: "",
							thumbFile: "",
							coverFile: "",
							addTime: "",
							favorite: "",
						};

						bookDataMap.set(key, {
							book,
							highlights: [],
							statistics: null,
							progress: null,
							currentChapter: null,
							lastReadTimestamp: null,
							coverPath: null,
							fetchedDescription: null,
							publishedDate: null,
							publisher: null,
							pageCount: null,
							genres: null,
							series: null,
							isbn10: null,
							isbn13: null,
							language: null,
						});
					}

					// Add highlights to existing book
					if (parsed.highlights.length > 0) {
						const bookData = bookDataMap.get(key)!;
						bookData.highlights.push(...parsed.highlights);
					}
				}
			} catch (error) {
				console.debug(`MoonSync: Error reading ${anFile}`, error);
			}
		}

		// Read .po files for reading progress
		const poFiles = files.filter((f) => f.endsWith(".po"));
		for (const poFile of poFiles) {
			try {
				// Extract book title from .po filename (same format as .an files)
				const baseName = poFile.replace(/\.epub\.po$/, "").replace(/\.pdf\.po$/, "");
				const parts = baseName.split(" - ");
				let bookTitle = parts[0] || baseName;
				const author = parts.length > 1 ? parts.slice(1).join(" - ") : "";
				// Convert underscores to spaces to match the title from inside .an files
				if (!bookTitle.includes(" ") && bookTitle.includes("_")) {
					bookTitle = bookTitle.replace(/_/g, " ");
				}
				const key = normalizeKey(bookTitle);

				const filePath = join(cacheDir, poFile);
				const data = await readFile(filePath);
				const progressData = parseProgressFile(data);
				// Use file modification time as "last read" date (the internal .po
				// timestamp is unreliable — often reflects initial sync, not last read)
				const fileStat = await stat(filePath);
				const fileMtime = fileStat.mtimeMs;

				if (bookDataMap.has(key)) {
					// Add progress to existing book with highlights
					// Only update if this .po file was modified more recently
					// (handles case where multiple .po files match the same book)
					if (progressData !== null) {
						const bookData = bookDataMap.get(key)!;
						const existingTimestamp = bookData.lastReadTimestamp || 0;
						if (fileMtime > existingTimestamp ||
						(fileMtime === existingTimestamp && progressData.progress > (bookData.progress || 0))) {
							bookData.progress = progressData.progress;
							bookData.currentChapter = progressData.chapter;
							bookData.lastReadTimestamp = fileMtime;
						}
					}
				} else if (trackBooksWithoutHighlights && progressData !== null) {
					// Create new book entry from .po file only (no highlights)
					const book: MoonReaderBook = {
						id: 0,
						title: bookTitle,
						filename: baseName,
						author: author,
						description: "",
						category: "",
						thumbFile: "",
						coverFile: "",
						addTime: "",
						favorite: "",
					};

					bookDataMap.set(key, {
						book,
						highlights: [],
						statistics: null,
						progress: progressData.progress,
						currentChapter: progressData.chapter,
						lastReadTimestamp: fileMtime,
						coverPath: null,
						fetchedDescription: null,
						publishedDate: null,
						publisher: null,
						pageCount: null,
						genres: null,
						series: null,
						isbn10: null,
						isbn13: null,
						language: null,
					});
				}
			} catch (error) {
				console.debug(`MoonSync: Error reading ${poFile}`, error);
			}
		}

		// Sort highlights by position for each book
		for (const bookData of bookDataMap.values()) {
			bookData.highlights.sort((a, b) => a.position - b.position);
		}

		return Array.from(bookDataMap.values());
	} catch (error) {
		console.debug("MoonSync: Failed to read Cache directory", error);
		return [];
	}
}
