import { readFile, readdir } from "fs/promises";
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
		const bookTitle = parts[0] || baseName;
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
				const lowerPath = lines[i++] || "";
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

				// Collect highlight text (may span multiple lines until we hit trailing 0s)
				const textLines: string[] = [];
				while (i < lines.length && lines[i] !== "0") {
					textLines.push(lines[i]);
					i++;
				}

				// Skip the trailing 0, 0, 0
				while (i < lines.length && (lines[i] === "0" || lines[i] === "")) {
					i++;
				}

				const text = textLines.join("\n").replace(/<BR>/g, "\n").trim();

				if (text) {
					highlights.push({
						id,
						book: title,
						filename: fullPath,
						chapter,
						position,
						highlightLength: length,
						highlightColor: color,
						timestamp,
						bookmark: "",
						note: "",
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
		console.log(`MoonSync: Failed to parse annotation file ${filename}`, error);
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
export async function parseAnnotationFiles(dropboxPath: string): Promise<BookData[]> {
	const cacheDir = join(dropboxPath, ".Moon+", "Cache");
	const bookDataMap = new Map<string, BookData>();

	try {
		const files = await readdir(cacheDir);
		const anFiles = files.filter((f) => f.endsWith(".an"));

		for (const anFile of anFiles) {
			try {
				const filePath = join(cacheDir, anFile);
				const data = await readFile(filePath);
				const parsed = parseAnnotationFile(data, anFile);

				if (parsed && parsed.highlights.length > 0) {
					// Use the title from inside the annotation file (more reliable than filename)
					const actualTitle = parsed.highlights[0]?.book || parsed.bookTitle;
					const key = actualTitle.toLowerCase();

					if (!bookDataMap.has(key)) {
						const book: MoonReaderBook = {
							id: 0,
							title: actualTitle,
							filename: parsed.highlights[0]?.filename || "",
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
							rating: null,
							ratingsCount: null,
						});
					}

					// Add highlights to existing book
					const bookData = bookDataMap.get(key)!;
					bookData.highlights.push(...parsed.highlights);
				}
			} catch (error) {
				console.log(`MoonSync: Error reading ${anFile}`, error);
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
				// Convert underscores to spaces to match the title from inside .an files
				if (!bookTitle.includes(" ") && bookTitle.includes("_")) {
					bookTitle = bookTitle.replace(/_/g, " ");
				}
				const key = bookTitle.toLowerCase();

				// Only add progress if we have highlights for this book
				if (bookDataMap.has(key)) {
					const filePath = join(cacheDir, poFile);
					const data = await readFile(filePath);
					const progressData = parseProgressFile(data);
					if (progressData !== null) {
						const bookData = bookDataMap.get(key)!;
						bookData.progress = progressData.progress;
						bookData.currentChapter = progressData.chapter;
						bookData.lastReadTimestamp = progressData.timestamp;
					}
				}
			} catch (error) {
				console.log(`MoonSync: Error reading ${poFile}`, error);
			}
		}

		// Sort highlights by position for each book
		for (const bookData of bookDataMap.values()) {
			bookData.highlights.sort((a, b) => a.position - b.position);
		}

		return Array.from(bookDataMap.values());
	} catch (error) {
		console.log("MoonSync: Failed to read Cache directory", error);
		return [];
	}
}
