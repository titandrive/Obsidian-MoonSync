import {
	BookData,
	MoonReaderHighlight,
	MoonSyncSettings,
	getCalloutType,
	formatDuration,
	formatDate,
} from "../types";

/**
 * Generate a markdown note for a book with its highlights and reading progress
 */
export function generateBookNote(bookData: BookData, settings: MoonSyncSettings): string {
	const { book, highlights, statistics, progress } = bookData;

	const lines: string[] = [];

	// Frontmatter
	lines.push("---");
	lines.push(`title: "${escapeYaml(book.title)}"`);
	if (book.author) {
		lines.push(`author: "${escapeYaml(book.author)}"`);
	}
	if (book.category) {
		const category = parseCategory(book.category);
		if (category) {
			lines.push(`category: "${escapeYaml(category)}"`);
		}
	}
	if (progress !== null) {
		lines.push(`progress: ${progress.toFixed(1)}%`);
	}
	if (statistics?.usedTime) {
		lines.push(`reading_time: "${formatDuration(statistics.usedTime)}"`);
	}
	lines.push(`last_synced: ${new Date().toISOString().split("T")[0]}`);
	lines.push(`moon_reader_path: "${escapeYaml(book.filename)}"`);
	lines.push(`highlights_count: ${highlights.length}`);
	lines.push("---");
	lines.push("");

	// Title and author
	lines.push(`# ${book.title}`);
	if (book.author) {
		lines.push(`**Author:** ${book.author}`);
	}
	lines.push("");

	// Reading Progress section
	if (settings.showReadingProgress && (progress !== null || statistics)) {
		lines.push("## Reading Progress");
		if (progress !== null) {
			lines.push(`- **Progress:** ${progress.toFixed(1)}%`);
		}
		if (statistics?.usedTime) {
			lines.push(`- **Time Spent:** ${formatDuration(statistics.usedTime)}`);
		}
		if (statistics?.readWords) {
			lines.push(
				`- **Words Read:** ${statistics.readWords.toLocaleString()}`
			);
		}
		lines.push("");
	}

	// Description section (if available and not empty)
	if (settings.showDescription && book.description && book.description.trim().length > 0) {
		lines.push("## Description");
		lines.push(book.description.trim());
		lines.push("");
	}

	// Highlights section
	if (highlights.length > 0) {
		lines.push("## Highlights");
		lines.push("");

		for (const highlight of highlights) {
			lines.push(formatHighlight(highlight, settings.showHighlightColors));
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Format a single highlight as an Obsidian callout
 */
function formatHighlight(highlight: MoonReaderHighlight, useColors: boolean): string {
	const calloutType = useColors ? getCalloutType(highlight.highlightColor) : "quote";
	const dateStr = highlight.timestamp ? formatDate(highlight.timestamp) : "";
	const chapterStr = highlight.chapter > 0 ? `Chapter ${highlight.chapter}` : "";

	// Build the header
	const headerParts = [chapterStr, dateStr].filter((p) => p);
	const header = headerParts.length > 0 ? headerParts.join(" • ") : "";

	const lines: string[] = [];

	// Callout opening with optional header
	if (header) {
		lines.push(`> [!${calloutType}] ${header}`);
	} else {
		lines.push(`> [!${calloutType}]`);
	}

	// Highlight text
	if (highlight.originalText) {
		const text = highlight.originalText.trim();
		// Split into lines and prefix each with >
		const textLines = text.split("\n");
		for (const line of textLines) {
			lines.push(`> ${line}`);
		}
	}

	// User note (if present)
	if (highlight.note && highlight.note.trim()) {
		lines.push(">");
		lines.push(`> **Note:** ${highlight.note.trim()}`);
	}

	return lines.join("\n");
}

/**
 * Parse Moon Reader category field to extract primary category
 */
function parseCategory(categoryField: string): string {
	// Format is often: "<Series Name>\n#order#\nCategory1\nCategory2\n..."
	const lines = categoryField
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("<") && !l.startsWith("#"));

	return lines[0] || "";
}

/**
 * Escape special characters for YAML strings
 */
function escapeYaml(str: string): string {
	return str.replace(/"/g, '\\"').replace(/\n/g, " ");
}

/**
 * Generate a safe filename from book title
 */
export function generateFilename(title: string): string {
	return title
		.replace(/[<>:"/\\|?*]/g, "") // Remove invalid filename characters
		.replace(/\s+/g, " ") // Normalize whitespace
		.trim()
		.substring(0, 100); // Limit length
}
