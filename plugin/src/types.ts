export interface MoonReaderBook {
	id: number;
	title: string;
	filename: string;
	author: string;
	description: string;
	category: string;
	thumbFile: string;
	coverFile: string;
	addTime: string;
	favorite: string;
}

export interface MoonReaderHighlight {
	id: number;
	book: string;
	filename: string;
	chapter: number;
	position: number;
	highlightLength: number;
	highlightColor: number;
	timestamp: number;
	bookmark: string;
	note: string;
	originalText: string;
	underline: boolean;
	strikethrough: boolean;
}

export interface MoonReaderStatistics {
	id: number;
	filename: string;
	usedTime: number; // milliseconds
	readWords: number;
	dates: string;
}

export interface BookData {
	book: MoonReaderBook;
	highlights: MoonReaderHighlight[];
	statistics: MoonReaderStatistics | null;
	progress: number | null; // percentage
	currentChapter: number | null; // current chapter number
	lastReadTimestamp: number | null; // when the book was last read
	coverPath: string | null; // path to cover image in vault
	fetchedDescription: string | null; // description from Google Books/Open Library
	publishedDate: string | null; // publication date
	publisher: string | null; // publisher name
	pageCount: number | null; // number of pages
	genres: string[] | null; // categories/genres/subjects
	series: string | null; // series information
	isbn10: string | null; // ISBN-10
	isbn13: string | null; // ISBN-13
	language: string | null; // language code (e.g., "en")
	previousTitle: string | null; // title before enrichment (for finding old notes to rename)
}

export interface MoonSyncSettings {
	syncPath: string;
	outputFolder: string;
	syncOnStartup: boolean;
	watchForChanges: boolean;
	showRibbonIcon: boolean;
	showDescription: boolean;
	showReadingProgress: boolean;
	showHighlightColors: boolean;
	showCovers: boolean;
	showIndex: boolean;
	indexNoteTitle: string;
	generateBaseFile: boolean;
	baseFileName: string;
	showCoverCollage: boolean;
	coverCollageLimit: number; // 0 = all
	coverCollageSort: "alpha" | "recent";
	trackBooksWithoutHighlights: boolean;
	hardcoverEnabled: boolean;
	hardcoverToken: string;
}

export const DEFAULT_SETTINGS: MoonSyncSettings = {
	syncPath: "",
	outputFolder: "Books",
	syncOnStartup: true,
	watchForChanges: false,
	showRibbonIcon: true,
	showDescription: true,
	showReadingProgress: true,
	showHighlightColors: true,
	showCovers: true,
	showIndex: true,
	indexNoteTitle: "1. Library Index",
	generateBaseFile: true,
	baseFileName: "2. Books Database",
	showCoverCollage: true,
	coverCollageLimit: 0, // 0 = show all
	coverCollageSort: "alpha",
	trackBooksWithoutHighlights: true,
	hardcoverEnabled: false,
	hardcoverToken: "",
};

// Moon Reader highlight colors (ARGB format)
// Common colors used in Moon Reader
export enum HighlightColor {
	YELLOW = "yellow",
	BLUE = "blue",
	GREEN = "green",
	RED = "red",
	PINK = "pink",
	ORANGE = "orange",
	PURPLE = "purple",
	DEFAULT = "default",
}

export function getCalloutType(colorInt: number): string {
	// Extract RGB from ARGB integer
	const r = (colorInt >> 16) & 0xff;
	const g = (colorInt >> 8) & 0xff;
	const b = colorInt & 0xff;

	// Classify color based on dominant channel
	// Yellow: high R, high G, low B
	if (r > 200 && g > 200 && b < 100) {
		return "quote";
	}
	// Blue: low R, low G, high B OR high saturation blue
	if (b > r && b > g && b > 150) {
		return "info";
	}
	// Green: low R, high G, low B
	if (g > r && g > b && g > 150) {
		return "tip";
	}
	// Red/Pink: high R, low G, low B
	if (r > g && r > b && r > 150) {
		return "warning";
	}
	// Orange: high R, medium G, low B
	if (r > 200 && g > 100 && g < 200 && b < 100) {
		return "warning";
	}

	// Default to quote
	return "quote";
}

export function formatDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

export function formatDate(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
