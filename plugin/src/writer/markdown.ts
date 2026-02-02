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
	const { book, highlights, statistics, progress, currentChapter, lastReadTimestamp, coverPath, fetchedDescription, rating, ratingsCount } = bookData;

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
	if (currentChapter !== null) {
		lines.push(`current_chapter: ${currentChapter}`);
	}
	if (statistics?.usedTime) {
		lines.push(`reading_time: "${formatDuration(statistics.usedTime)}"`);
	}
	lines.push(`last_synced: ${new Date().toISOString().split("T")[0]}`);
	lines.push(`moon_reader_path: "${escapeYaml(book.filename)}"`);
	lines.push(`highlights_count: ${highlights.length}`);
	if (settings.showRatings && rating !== null) {
		lines.push(`rating: ${rating}`);
		if (ratingsCount !== null) {
			lines.push(`ratings_count: ${ratingsCount}`);
		}
	}
	if (coverPath) {
		lines.push(`cover: "${coverPath}"`);
	}
	lines.push("---");

	// Title and author
	lines.push(`# ${book.title}`);
	if (book.author) {
		lines.push(`**Author:** ${book.author}`);
	}
	if (settings.showRatings && rating !== null) {
		const ratingText = ratingsCount !== null
			? `**Rating:** ⭐ ${rating}/5 (${ratingsCount.toLocaleString()} ratings)`
			: `**Rating:** ⭐ ${rating}/5`;
		lines.push(ratingText);
	}
	lines.push("");

	// Cover image (using Obsidian wikilink syntax to handle spaces in filenames)
	if (coverPath) {
		lines.push(`![[${coverPath}]]`);
		lines.push("");
	}

	// Reading Progress section
	if (settings.showReadingProgress && (progress !== null || currentChapter !== null)) {
		lines.push("## Reading Progress");
		if (progress !== null) {
			lines.push(`- **Progress:** ${progress.toFixed(1)}%`);
		}
		if (currentChapter !== null) {
			lines.push(`- **Chapter:** ${currentChapter}`);
		}
		lines.push("");
	}

	// Description section - prefer fetched description over Moon Reader's
	const description = fetchedDescription || book.description;
	if (settings.showDescription && description && description.trim().length > 0) {
		lines.push("## Description");
		lines.push(description.trim());
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
