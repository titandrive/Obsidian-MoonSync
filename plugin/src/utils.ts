import { MoonReaderHighlight } from "./types";

/**
 * Escape special characters for YAML strings
 */
export function escapeYaml(str: string): string {
	return str.replace(/"/g, '\\"').replace(/\n/g, " ");
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
export function computeHighlightsHash(highlights: MoonReaderHighlight[]): string {
	if (highlights.length === 0) return "";

	// Sort by position to ensure consistent ordering
	const sorted = [...highlights].sort((a, b) => a.position - b.position);

	// Create a fingerprint from key properties that would change if highlights change
	const fingerprint = sorted
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
