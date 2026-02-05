import { MoonReaderHighlight } from "./types";

/**
 * Escape special characters for YAML strings
 */
export function escapeYaml(str: string): string {
	return str.replace(/"/g, '\\"').replace(/\n/g, " ");
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
