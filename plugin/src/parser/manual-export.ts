import { MoonReaderHighlight } from "../types";

export interface ManualExportData {
	title: string;
	author: string;
	highlights: MoonReaderHighlight[];
}

/**
 * Parse a Moon Reader manual export note
 * Format:
 * Title - Author (Highlight: X; Note: Y)
 * ───────────────
 * ◆ Chapter Name
 * ▪ highlight text
 * ▪ highlight text (note text)
 */
export function parseManualExport(content: string): ManualExportData | null {
	const lines = content.split("\n");

	if (lines.length === 0) {
		return null;
	}

	// Parse header line: "Title - Author (Highlight: X; Note: Y)"
	const headerMatch = lines[0].match(/^(.+?)\s+-\s+(.+?)\s+\(Highlight:\s+\d+;\s+Note:\s+\d+\)$/);
	if (!headerMatch) {
		return null;
	}

	const title = headerMatch[1].trim();
	const author = headerMatch[2].trim();
	const highlights: MoonReaderHighlight[] = [];

	let currentChapter = 0;
	let chapterName = "";

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();

		// Skip empty lines and separator
		if (!line || line.startsWith("───")) {
			continue;
		}

		// Chapter marker: ◆ Chapter Name
		if (line.startsWith("◆")) {
			chapterName = line.substring(1).trim();
			// Try to extract chapter number
			const chapterMatch = chapterName.match(/Chapter\s+(\d+)/i);
			if (chapterMatch) {
				currentChapter = parseInt(chapterMatch[1]);
			} else {
				currentChapter++;
			}
			continue;
		}

		// Highlight: ▪ text or ▪ text (note)
		if (line.startsWith("▪")) {
			let highlightText = line.substring(1).trim();
			let noteText = "";

			// Check for note in parentheses at the end
			const noteMatch = highlightText.match(/^(.*?)\s+\((.+)\)$/);
			if (noteMatch) {
				highlightText = noteMatch[1].trim();
				noteText = noteMatch[2].trim();
			}

			highlights.push({
				id: 0,
				book: title,
				filename: "",
				chapter: currentChapter,
				position: 0,
				highlightLength: highlightText.length,
				highlightColor: -256, // Yellow (default)
				timestamp: Date.now(),
				bookmark: "",
				note: noteText,
				originalText: highlightText,
				underline: false,
				strikethrough: false,
			});
		}
	}

	return {
		title,
		author,
		highlights,
	};
}
