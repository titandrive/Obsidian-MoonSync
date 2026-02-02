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
}

export interface MoonSyncSettings {
	dropboxPath: string;
	outputFolder: string;
	syncOnStartup: boolean;
	showDescription: boolean;
	showReadingProgress: boolean;
	showHighlightColors: boolean;
}

export const DEFAULT_SETTINGS: MoonSyncSettings = {
	dropboxPath: "",
	outputFolder: "Books",
	syncOnStartup: true,
	showDescription: true,
	showReadingProgress: true,
	showHighlightColors: true,
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
