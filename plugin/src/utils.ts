import { MoonReaderHighlight } from "./types";

/**
 * Clean a string for external API searches by stripping filename artifacts.
 * Keeps letters, numbers, spaces, single hyphens, and apostrophes.
 */
export function cleanForSearch(str: string): string {
	return str
		.replace(/-{2,}/g, " ")
		.replace(/[^a-zA-Z0-9\s\u00C0-\u024F'-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Escape special characters for YAML strings
 */
export function escapeYaml(str: string): string {
	return str.replace(/"/g, '\\"').replace(/\n/g, " ");
}

/**
 * Extract author from a "Title - Author.ext" filename pattern
 * Returns null if the pattern isn't found
 */
export function extractAuthorFromFilename(filename: string): string | null {
	// Remove file extension
	const name = filename.replace(/\.[^.]+$/, "");
	// Match the last " - Author" segment (use last occurrence to handle titles with dashes)
	const dashIndex = name.lastIndexOf(" - ");
	if (dashIndex === -1 || dashIndex === name.length - 3) {
		return null;
	}
	return name.substring(dashIndex + 3).trim() || null;
}

/**
 * Clean download-site filename patterns (Anna's Archive, LibGen, Z-Library, etc.)
 * Format: "Title -- Author -- Year -- hex_hash -- Source"
 * Only triggers when a segment contains a hex hash (16+ chars), confirming it's a download filename.
 * Also extracts the author from the second segment if available.
 */
export function cleanDownloadFilename(title: string, currentAuthor?: string): { title: string; author: string | null } {
	if (!title.includes(" -- ")) return { title, author: null };
	const segments = title.split(" -- ").map(s => s.trim());
	const hasHash = segments.some(s => /^[0-9a-f]{16,}$/i.test(s));
	if (!hasHash) return { title, author: null };
	const cleanedTitle = segments[0].replace(/_/g, " ").trim();
	// Second segment is typically the author
	const author = segments.length > 1 && !/^[0-9a-f]{16,}$/i.test(segments[1]) && !/^\d{4}$/.test(segments[1])
		? segments[1]
		: null;
	return { title: cleanedTitle, author: !currentAuthor && author ? author : null };
}

/**
 * Strip leading bracket tags from a title (e.g. "[Collins Business Essentials] Title" → "Title")
 */
export function stripBracketPrefix(title: string): string {
	return title.replace(/^\[.*?\]\s*/, "").trim();
}

/**
 * Strip " - Author" suffix (or "Author - " prefix) from a title when the author is known.
 * Matches if the suffix/prefix starts with the author or vice versa (handles truncation).
 */
export function stripAuthorSuffix(title: string, author: string): string {
	if (!author) return title;
	const dashIndex = title.lastIndexOf(" - ");
	if (dashIndex <= 0) return title;
	const suffix = title.substring(dashIndex + 3).trim().toLowerCase();
	const prefix = title.substring(0, dashIndex).trim().toLowerCase();
	const authorLower = author.toLowerCase();
	// "Title - Author" format
	if (suffix.startsWith(authorLower) || authorLower.startsWith(suffix)) {
		return title.substring(0, dashIndex).trim();
	}
	// "Author - Title" format
	if (prefix === authorLower || authorLower.startsWith(prefix)) {
		return title.substring(dashIndex + 3).trim();
	}
	return title;
}

/**
 * Parsed frontmatter fields from a markdown file
 */
export interface ParsedFrontmatter {
	title: string | null;
	author: string | null;
	progress: number | null;
	highlightsCount: number | null;
	highlightsHash: string | null;
	coverPath: string | null;
	moonReaderPath: string | null;
	lastRead: string | null;
	lastSynced: string | null;
	isManualNote: boolean;
	hasCustomMetadata: boolean;
}

/**
 * Extract frontmatter section from markdown content
 * Returns null if no valid frontmatter found
 */
export function extractFrontmatter(content: string): string | null {
	if (!content.startsWith("---")) {
		return null;
	}
	const endIndex = content.indexOf("---", 3);
	if (endIndex === -1) {
		return null;
	}
	return content.substring(3, endIndex);
}

/**
 * Parse a single frontmatter field value
 * Handles quoted and unquoted values
 */
export function parseFrontmatterField(frontmatter: string, fieldName: string): string | null {
	const regex = new RegExp(`^${fieldName}:\\s*"?([^"\\n]+)"?`, "m");
	const match = frontmatter.match(regex);
	return match ? match[1].trim() : null;
}

/**
 * Parse common frontmatter fields from markdown content
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
	const frontmatter = extractFrontmatter(content);

	if (!frontmatter) {
		return {
			title: null,
			author: null,
			progress: null,
			highlightsCount: null,
			highlightsHash: null,
			coverPath: null,
			moonReaderPath: null,
			lastRead: null,
			lastSynced: null,
			isManualNote: false,
			hasCustomMetadata: false,
		};
	}

	const progressStr = parseFrontmatterField(frontmatter, "progress");
	const highlightsCountStr = parseFrontmatterField(frontmatter, "highlights_count");

	return {
		title: parseFrontmatterField(frontmatter, "title"),
		author: parseFrontmatterField(frontmatter, "author"),
		progress: progressStr ? parseFloat(progressStr) : null,
		highlightsCount: highlightsCountStr !== null ? parseInt(highlightsCountStr, 10) : null,
		highlightsHash: parseFrontmatterField(frontmatter, "highlights_hash"),
		coverPath: parseFrontmatterField(frontmatter, "cover"),
		moonReaderPath: parseFrontmatterField(frontmatter, "moon_reader_path"),
		lastRead: parseFrontmatterField(frontmatter, "last_read"),
		lastSynced: parseFrontmatterField(frontmatter, "last_synced"),
		isManualNote: /^manual_note:\s*true/m.test(frontmatter),
		hasCustomMetadata: /^custom_metadata:\s*true/m.test(frontmatter),
	};
}

/**
 * Generate a hash/fingerprint of highlights for change detection
 * Uses position + timestamp + text length to create a unique signature
 */
export function computeHighlightsHash(highlights: MoonReaderHighlight[], highlightSort: string = "position"): string {
	if (highlights.length === 0) return "";

	// Sort by position to ensure consistent ordering
	const sorted = [...highlights].sort((a, b) => a.position - b.position);

	// Create a fingerprint from key properties that would change if highlights change
	// Include sort setting so changing sort order invalidates the hash
	const fingerprint = `sort:${highlightSort}|` + sorted
		.map(h => `${h.position}:${h.timestamp}:${h.originalText.length}`)
		.join("|");

	// Simple hash function (djb2)
	let hash = 5381;
	for (let i = 0; i < fingerprint.length; i++) {
		hash = ((hash << 5) + hash) + fingerprint.charCodeAt(i);
		hash = hash & hash; // Convert to 32-bit integer
	}

	return Math.abs(hash).toString(36);
}
