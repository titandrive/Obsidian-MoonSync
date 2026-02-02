import JSZip from "jszip";
import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";

export interface MrproContents {
	database: ArrayBuffer;
	namesMapping: Map<string, string>;
}

/**
 * Find the most recent .mrpro backup file in a directory
 */
export async function findLatestBackup(backupDir: string): Promise<string | null> {
	try {
		const files = await readdir(backupDir);
		const mrproFiles = files.filter((f) => f.endsWith(".mrpro"));

		if (mrproFiles.length === 0) {
			return null;
		}

		// Sort by modification time, most recent first
		const filesWithStats = await Promise.all(
			mrproFiles.map(async (f) => {
				const filePath = join(backupDir, f);
				const stats = await stat(filePath);
				return { path: filePath, mtime: stats.mtime.getTime() };
			})
		);

		filesWithStats.sort((a, b) => b.mtime - a.mtime);
		return filesWithStats[0].path;
	} catch (error) {
		console.error("Error finding backup files:", error);
		return null;
	}
}

/**
 * Parse the _names.list file to get the mapping of tag numbers to actual file paths
 * Format: one path per line, line number corresponds to N.tag
 */
function parseNamesList(content: string): Map<string, string> {
	const mapping = new Map<string, string>();
	const lines = content.split("\n").filter((line) => line.trim());

	lines.forEach((line, index) => {
		const tagFile = `${index + 1}.tag`;
		const actualPath = line.trim();
		mapping.set(tagFile, actualPath);
	});

	return mapping;
}

/**
 * Extract the SQLite database from a .mrpro backup file
 */
export async function extractMrpro(mrproPath: string): Promise<MrproContents> {
	const fileBuffer = await readFile(mrproPath);
	const zip = await JSZip.loadAsync(fileBuffer);

	// Read the names list to find database file
	const namesListFile = zip.file(/.*_names\.list$/);
	if (!namesListFile || namesListFile.length === 0) {
		throw new Error("Could not find _names.list in backup");
	}

	const namesContent = await namesListFile[0].async("string");
	const namesMapping = parseNamesList(namesContent);

	// Find the database file (mrbooks.db)
	let dbTagFile: string | null = null;
	for (const [tagFile, actualPath] of namesMapping.entries()) {
		if (actualPath.includes("mrbooks.db")) {
			dbTagFile = tagFile;
			break;
		}
	}

	if (!dbTagFile) {
		throw new Error("Could not find mrbooks.db in backup");
	}

	// Extract the database
	// The tag file is in format "N.tag" but stored under com.flyersoft.moonreaderp/N.tag
	const dbFile = zip.file(new RegExp(`.*/${dbTagFile}$`));
	if (!dbFile || dbFile.length === 0) {
		throw new Error(`Could not extract database file: ${dbTagFile}`);
	}

	const database = await dbFile[0].async("arraybuffer");

	return {
		database,
		namesMapping,
	};
}
