import { readFile, readdir } from "fs/promises";
import { join } from "path";

/**
 * Scan .Moon+/Cover/ for available local cover images.
 * Returns a Set of lowercase epub filenames that have covers.
 * Cover files are named {filename}_2.png
 */
export async function scanLocalCovers(syncPath: string): Promise<Set<string>> {
	const coverDir = join(syncPath, ".Moon+", "Cover");
	const available = new Set<string>();

	try {
		const files = await readdir(coverDir);
		for (const f of files) {
			if (f.endsWith("_2.png")) {
				// Strip "_2.png" suffix to get the original epub filename
				const bookFilename = f.slice(0, -6);
				available.add(bookFilename.toLowerCase().normalize("NFC"));
			}
		}
	} catch {
		// Cover directory doesn't exist
	}

	return available;
}

/**
 * Read a local Moon Reader cover image for a given book filename.
 * Returns the raw image data if found, null otherwise.
 */
export async function getLocalCover(
	syncPath: string,
	bookFilename: string
): Promise<ArrayBuffer | null> {
	const coverPath = join(syncPath, ".Moon+", "Cover", `${bookFilename}_2.png`);

	try {
		const data = await readFile(coverPath);
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	} catch {
		return null;
	}
}
