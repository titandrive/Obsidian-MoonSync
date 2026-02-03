import { App, normalizePath } from "obsidian";

export interface CachedBookInfo {
	description: string | null;
	rating: number | null;
	ratingsCount: number | null;
	author: string | null;
	publishedDate: string | null;
	publisher: string | null;
	pageCount: number | null;
	genres: string[] | null;
	series: string | null;
	language: string | null;
	fetchedAt: number; // timestamp
}

export interface BookInfoCache {
	[key: string]: CachedBookInfo;
}

const CACHE_FILE = ".moonsync-cache.json";

/**
 * Generate a cache key from title and author
 */
export function getCacheKey(title: string, author: string): string {
	return `${title.toLowerCase()}|${author.toLowerCase()}`;
}

/**
 * Load the book info cache from disk
 */
export async function loadCache(app: App, outputFolder: string): Promise<BookInfoCache> {
	const cachePath = normalizePath(`${outputFolder}/${CACHE_FILE}`);

	try {
		if (await app.vault.adapter.exists(cachePath)) {
			const data = await app.vault.adapter.read(cachePath);
			return JSON.parse(data);
		}
	} catch (error) {
		console.log("MoonSync: Failed to load cache, starting fresh", error);
	}

	return {};
}

/**
 * Save the book info cache to disk
 */
export async function saveCache(app: App, outputFolder: string, cache: BookInfoCache): Promise<void> {
	const cachePath = normalizePath(`${outputFolder}/${CACHE_FILE}`);

	try {
		await app.vault.adapter.write(cachePath, JSON.stringify(cache, null, 2));
	} catch (error) {
		console.log("MoonSync: Failed to save cache", error);
	}
}

/**
 * Get cached book info if available
 */
export function getCachedInfo(cache: BookInfoCache, title: string, author: string): CachedBookInfo | null {
	const key = getCacheKey(title, author);
	return cache[key] || null;
}

/**
 * Store book info in cache
 */
export function setCachedInfo(
	cache: BookInfoCache,
	title: string,
	author: string,
	info: Omit<CachedBookInfo, "fetchedAt">
): void {
	const key = getCacheKey(title, author);
	cache[key] = {
		...info,
		fetchedAt: Date.now(),
	};
}
