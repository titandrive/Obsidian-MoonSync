import { readFile } from "fs/promises";
import { join } from "path";
import { inflateSync } from "zlib";

export interface BooksSyncEntry {
	filename: string;
	bookName: string;
	author: string;
	description: string;
	category: string;
	addTime: string;
	favorite: string;
	rate: string;
	deviceId: string;
	downloadUrl: string;
}

/**
 * Parse the books.sync file from .Moon+/ folder.
 * Returns a Map keyed by lowercase filename for fast lookup.
 * Returns null if the file does not exist or cannot be parsed.
 */
export async function parseBooksSyncFile(
	syncPath: string
): Promise<Map<string, BooksSyncEntry> | null> {
	const filePath = join(syncPath, ".Moon+", "books.sync");

	try {
		const data = await readFile(filePath);
		const decompressed = inflateSync(data).toString("utf-8");
		const entries: BooksSyncEntry[] = JSON.parse(decompressed);

		const map = new Map<string, BooksSyncEntry>();
		for (const entry of entries) {
			if (entry.filename) {
				map.set(entry.filename.toLowerCase().normalize("NFC"), entry);
			}
		}
		return map;
	} catch {
		// File doesn't exist or failed to parse — expected when
		// user hasn't enabled "Sync books across devices"
		return null;
	}
}

/**
 * Parse the category field into series info and genre list.
 * Format: "<Series Name>\n#1.0#\nGenre1\nGenre2\n"
 */
export function parseCategoryField(category: string): {
	series: string | null;
	seriesNumber: number | null;
	genres: string[];
} {
	const lines = category.split("\n").map(l => l.trim()).filter(l => l);
	let series: string | null = null;
	let seriesNumber: number | null = null;
	const genres: string[] = [];

	for (const line of lines) {
		if (line.startsWith("<") && line.endsWith(">")) {
			series = line.slice(1, -1);
		} else if (line.startsWith("#") && line.endsWith("#")) {
			const num = parseFloat(line.slice(1, -1));
			if (!isNaN(num)) {
				seriesNumber = num;
			}
		} else {
			genres.push(line);
		}
	}

	return { series, seriesNumber, genres };
}
