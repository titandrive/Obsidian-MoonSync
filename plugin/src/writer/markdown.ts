import {
	BookData,
	MoonReaderHighlight,
	MoonSyncSettings,
	getCalloutType,
	formatDuration,
	formatDate,
} from "../types";
import { escapeYaml, computeHighlightsHash } from "../utils";

/**
 * Generate a markdown note for a book with its highlights and reading progress
 */
export function generateBookNote(bookData: BookData, settings: MoonSyncSettings): string {
	const { book, highlights, statistics, progress, currentChapter, lastReadTimestamp, coverPath, fetchedDescription, publishedDate, publisher, pageCount, genres, series, isbn10, isbn13, language } = bookData;

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
	if (lastReadTimestamp !== null) {
		lines.push(`last_read: ${new Date(lastReadTimestamp).toISOString().split("T")[0]}`);
	}
	if (statistics?.usedTime) {
		lines.push(`reading_time: "${formatDuration(statistics.usedTime)}"`);
	}
	lines.push(`last_synced: ${new Date().toISOString().split("T")[0]}`);
	lines.push(`moon_reader_path: "${escapeYaml(book.filename)}"`);
	lines.push(`highlights_count: ${highlights.length}`);
	lines.push(`highlights_hash: "${computeHighlightsHash(highlights)}"`);
	const notesCount = highlights.filter((h) => h.note && h.note.trim()).length;
	lines.push(`notes_count: ${notesCount}`);
	if (publishedDate) {
		lines.push(`published_date: "${escapeYaml(publishedDate)}"`);
	}
	if (publisher) {
		lines.push(`publisher: "${escapeYaml(publisher)}"`);
	}
	if (pageCount !== null) {
		lines.push(`page_count: ${pageCount}`);
	}
	if (genres && genres.length > 0) {
		// Format as YAML array
		lines.push(`genres:`);
		for (const genre of genres) {
			lines.push(`  - "${escapeYaml(genre)}"`);
		}
	}
	if (series) {
		lines.push(`series: "${escapeYaml(series)}"`);
	}
	if (isbn10) {
		lines.push(`isbn_10: "${isbn10}"`);
	}
	if (isbn13) {
		lines.push(`isbn_13: "${isbn13}"`);
	}
	if (language) {
		lines.push(`language: "${language}"`);
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
	lines.push("");

	// Cover image (using Obsidian wikilink syntax with width constraint)
	if (coverPath) {
		lines.push(`![[${coverPath}|200]]`);
		lines.push("");
	}

	// Reading Progress section (always generate if data exists, use callout for CSS toggle)
	if (progress !== null || currentChapter !== null || lastReadTimestamp !== null) {
		lines.push("> [!moonsync-reading-progress]+ Reading Progress");
		if (progress !== null) {
			lines.push(`> - **Progress:** ${progress.toFixed(1)}%`);
		}
		if (currentChapter !== null) {
			lines.push(`> - **Chapter:** ${currentChapter}`);
		}
		if (lastReadTimestamp !== null) {
			lines.push(`> - **Last Read:** ${formatDate(lastReadTimestamp)}`);
		}
		lines.push("");
	}

	// Description section - prefer fetched description over Moon Reader's
	// Always generate if data exists, use callout for CSS toggle
	const description = fetchedDescription || book.description;
	if (description && description.trim().length > 0) {
		lines.push("> [!moonsync-description]+ Description");
		// Split description into lines and prefix each with >
		const descLines = description.trim().split("\n");
		for (const line of descLines) {
			lines.push(`> ${line}`);
		}
		lines.push("");
	}

	// Highlights section
	if (highlights.length > 0) {
		lines.push("## Moon Reader Highlights");
		lines.push("");

		for (const highlight of highlights) {
			lines.push(formatHighlight(highlight, settings.showHighlightColors));
			lines.push("");
		}
	}

	// My Notes section - preserved across syncs
	lines.push("## My Notes");
	lines.push("");
	lines.push("> [!moonsync-user-notes]+ Your Notes");
	lines.push("> Add your thoughts, analysis, and notes here. This section is preserved across syncs.");
	lines.push("");

	return lines.join("\n");
}

/**
 * Format a single highlight as an Obsidian callout
 */
export function formatHighlight(highlight: MoonReaderHighlight, useColors: boolean): string {
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
		lines.push(`> ---`);
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
 * Generate a safe filename from book title
 * Case-insensitive to allow matching between manual notes and Moon+ Reader books
 */
export function generateFilename(title: string): string {
	return title
		.replace(/[<>:"/\\|?*]/g, "") // Remove invalid filename characters
		.replace(/\s+/g, " ") // Normalize whitespace
		.trim()
		.substring(0, 100); // Limit length
}

/**
 * Generate the index note with summary stats and links to all books
 */
export function generateIndexNote(books: BookData[], settings: MoonSyncSettings): string {
	const lines: string[] = [];

	// Header
	lines.push(`# ${settings.indexNoteTitle}`);
	lines.push("");

	// Cover collage - show small thumbnails of books with covers
	if (settings.showCoverCollage) {
		const booksWithCovers = books.filter((b) => b.coverPath);
		if (booksWithCovers.length > 0) {
			// Sort based on setting
			let sortedCovers: BookData[];
			if (settings.coverCollageSort === "recent") {
				// Sort by last read timestamp (most recent first), fallback to title
				sortedCovers = [...booksWithCovers].sort((a, b) => {
					const aTime = a.lastReadTimestamp || 0;
					const bTime = b.lastReadTimestamp || 0;
					if (bTime !== aTime) return bTime - aTime;
					return a.book.title.toLowerCase().localeCompare(b.book.title.toLowerCase());
				});
			} else {
				// Sort alphabetically
				sortedCovers = [...booksWithCovers].sort((a, b) =>
					a.book.title.toLowerCase().localeCompare(b.book.title.toLowerCase())
				);
			}

			// Apply limit if set (0 = no limit)
			const coversToShow = settings.coverCollageLimit > 0
				? sortedCovers.slice(0, settings.coverCollageLimit)
				: sortedCovers;

			// Display covers with height constraint using HTML img tags, linked to book notes
			const coverImgs = coversToShow.map(book => {
				const noteFilename = generateFilename(book.book.title);
				return `<a class="internal-link" href="${noteFilename}"><img src="${book.coverPath}" style="height: 120px; width: auto;"></a>`;
			}).join(" ");
			lines.push(coverImgs);
			lines.push("");
		}
	}

	// Calculate stats
	const totalBooks = books.length;
	const totalHighlights = books.reduce((sum, b) => sum + b.highlights.length, 0);
	const totalNotes = books.reduce(
		(sum, b) => sum + b.highlights.filter((h) => h.note && h.note.trim()).length,
		0
	);
	const booksWithProgress = books.filter((b) => b.progress !== null);
	const avgProgress =
		booksWithProgress.length > 0
			? booksWithProgress.reduce((sum, b) => sum + (b.progress || 0), 0) / booksWithProgress.length
			: 0;

	// Stats summary
	lines.push("## Summary");
	lines.push(`- **Books:** ${totalBooks}`);
	lines.push(`- **Highlights:** ${totalHighlights}`);
	lines.push(`- **Notes:** ${totalNotes}`);
	if (booksWithProgress.length > 0) {
		lines.push(`- **Average Progress:** ${avgProgress.toFixed(1)}%`);
	}
	lines.push("");

	// Book list sorted alphabetically
	lines.push("## Books");

	const sortedBooks = [...books].sort((a, b) =>
		a.book.title.toLowerCase().localeCompare(b.book.title.toLowerCase())
	);

	for (const bookData of sortedBooks) {
		// Use actual filename if available (from scanned books), otherwise generate from title
		// If filename looks like a path (contains /), generate from title instead
		const rawFilename = bookData.book.filename;
		const filename = (rawFilename && !rawFilename.includes("/"))
			? rawFilename
			: generateFilename(bookData.book.title);
		const author = bookData.book.author ? ` by ${bookData.book.author}` : "";
		const progress = bookData.progress !== null ? ` (${bookData.progress.toFixed(0)}%)` : "";
		const highlightCount = bookData.highlights.length;
		const noteCount = bookData.highlights.filter((h) => h.note && h.note.trim()).length;

		const statsText = noteCount > 0
			? `${highlightCount} highlights, ${noteCount} ${noteCount === 1 ? "note" : "notes"}`
			: `${highlightCount} highlights`;

		lines.push(`- [[${filename}|${bookData.book.title}]]${author}${progress} — ${statsText}`);
	}

	lines.push("");

	return lines.join("\n");
}

export function generateBaseFile(settings: MoonSyncSettings): string {
	const outputFolder = settings.outputFolder;
	const indexTitle = settings.indexNoteTitle;
	const baseTitle = settings.baseFileName;

	// Build YAML structure for Obsidian Bases plugin
	const lines: string[] = [];

	// Filters section - exclude index and database files
	lines.push("filters:");
	lines.push("  and:");
	lines.push(`    - file.folder == "${outputFolder}"`);
	lines.push(`    - file.name != "${indexTitle}"`);
	lines.push(`    - file.name != "${baseTitle}"`);
	lines.push('    - file.ext == "md"');

	// Properties section - define all frontmatter fields with display names
	lines.push("properties:");
	lines.push("  file.name:");
	lines.push("    displayName: Title");
	lines.push("  author:");
	lines.push("    displayName: Author");
	lines.push("  genres:");
	lines.push("    displayName: Genres");
	lines.push("  published_date:");
	lines.push("    displayName: Published");
	lines.push("  page_count:");
	lines.push("    displayName: Pages");
	lines.push("  highlights_count:");
	lines.push("    displayName: Highlights");
	lines.push("  notes_count:");
	lines.push("    displayName: Notes");
	lines.push("  last_synced:");
	lines.push("    displayName: Last Synced");
	lines.push("  last_read:");
	lines.push("    displayName: Last Read");
	lines.push("  publisher:");
	lines.push("    displayName: Publisher");
	lines.push("  series:");
	lines.push("    displayName: Series");
	lines.push("  language:");
	lines.push("    displayName: Language");
	lines.push("  progress:");
	lines.push("    displayName: Progress %");
	lines.push("  manual_note:");
	lines.push("    displayName: Manual");

	// Views section - configure table and gallery views
	lines.push("views:");

	// Table view
	lines.push("  - type: table");
	lines.push("    name: Library");
	lines.push("    order:");
	lines.push("      - file.name");
	lines.push("      - author");
	lines.push("      - highlights_count");
	lines.push("      - progress");
	lines.push("      - notes_count");
	lines.push("      - manual_note");
	lines.push("      - last_read");
	lines.push("      - last_synced");
	lines.push("      - genres");
	lines.push("      - page_count");
	lines.push("      - publisher");
	lines.push("      - published_date");
	lines.push("      - language");
	lines.push("    limit: 100");
	lines.push("    properties:");
	lines.push("      - file.name");
	lines.push("      - note.author");
	lines.push("      - note.genres");
	lines.push("      - note.highlights_count");
	lines.push("      - note.notes_count");
	lines.push("      - note.progress");
	lines.push("      - note.manual_note");
	lines.push("      - note.published_date");
	lines.push("      - note.publisher");
	lines.push("      - note.page_count");
	lines.push("      - note.series");
	lines.push("      - note.language");
	lines.push("      - note.last_read");
	lines.push("      - note.last_synced");

	// Gallery/Cards view
	lines.push("  - type: cards");
	lines.push("    name: Gallery");
	lines.push("    order:");
	lines.push("      - file.name");
	lines.push("    limit: 100");
	lines.push("    image: note.cover");
	lines.push("    imageFit: contain");
	lines.push("    cardSize: medium");
	lines.push("    properties:");
	lines.push("      - file.name");
	lines.push("      - note.author");
	lines.push("      - note.published_date");

	return lines.join("\n");
}
