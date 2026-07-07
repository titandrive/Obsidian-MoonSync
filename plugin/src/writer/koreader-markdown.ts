import { MoonSyncSettings, formatDuration, formatDate } from "../types";
import { escapeYaml, stripHtml } from "../utils";
import { KOReaderAnnotation, KOReaderBookData } from "../parser/koreader";
import { CachedBookInfo } from "../cache";

function getCalloutType(color: string | undefined): string {
	if (!color) return "quote";
	const c = color.toLowerCase();
	if (c === "yellow") return "quote";
	if (c === "green") return "tip";
	if (c === "blue") return "info";
	if (c === "red" || c === "violet" || c === "purple") return "warning";
	// hex colors: parse dominant channel
	const hex = c.replace("#", "");
	if (hex.length === 6) {
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		if (g > r && g > b && g > 120) return "tip";
		if (b > r && b > g && b > 120) return "info";
		if (r > g && r > b && r > 120) return "warning";
	}
	return "quote";
}

function computeAnnotationsHash(annotations: KOReaderAnnotation[]): string {
	// Hash on content, not updatedAt: KOReader re-saves the sidecar file (bumping
	// updatedAt for every annotation) whenever the book is opened/paged through,
	// even if no highlight actually changed — using updatedAt here would make the
	// currently-open book "changed" on every sync regardless of real edits.
	const str = annotations
		.map((a) => `${a.id}:${a.type}:${a.page}:${a.color ?? ""}:${a.text ?? ""}:${a.note ?? ""}`)
		.join("|");
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(36);
}

function formatAnnotation(annotation: KOReaderAnnotation, useColors: boolean): string {
	const calloutType = useColors ? getCalloutType(annotation.color) : "quote";
	const dateStr = annotation.createdAt ? formatDate(annotation.createdAt) : "";
	const header = dateStr ? `> [!${calloutType}] ${dateStr}` : `> [!${calloutType}]`;

	const lines: string[] = [header];

	if (annotation.text) {
		const textLines = annotation.text.trim().split("\n");
		for (const line of textLines) {
			lines.push(`> ${line}`);
		}
	}

	if (annotation.type === "bookmark" && !annotation.xpointer1) {
		// Pure bookmark with no highlighted range — show as bookmark callout
		lines[0] = `> [!note] Bookmark • ${dateStr}`;
	}

	const noteText = (annotation as KOReaderAnnotation & { note?: string }).note;
	if (noteText && noteText.trim()) {
		lines.push(">");
		lines.push("> ---");
		lines.push(`> **Note:** ${noteText.trim()}`);
	}

	return lines.join("\n");
}

export function computeKOReaderHash(annotations: KOReaderAnnotation[]): string {
	return computeAnnotationsHash(annotations);
}

export function generateKOReaderBookNote(
	bookData: KOReaderBookData,
	settings: MoonSyncSettings,
	cachedInfo: CachedBookInfo | null,
	coverPath: string | null,
	readingTime: string | null
): string {
	const lines: string[] = [];

	// Prefer metadata straight from the book's own file (via the KOReader sidecar) over
	// whatever an external API guessed via title/author search — only fill gaps from
	// cachedInfo for fields the sidecar doesn't have.
	const title = cachedInfo?.title ?? bookData.title;
	const author = bookData.author;
	const rawDescription = bookData.description ?? cachedInfo?.description ?? null;
	// Defensive re-strip regardless of source — a description written by an older
	// version of this note (before HTML-stripping existed) can otherwise persist
	// forever, since a book with no other changes is never rewritten.
	const description = rawDescription ? stripHtml(rawDescription) : null;
	const publishedDate = bookData.publishedDate ?? cachedInfo?.publishedDate ?? null;
	const publisher = bookData.publisher ?? cachedInfo?.publisher ?? null;
	const pageCount = cachedInfo?.pageCount ?? bookData.pageCount ?? null;
	const genres = cachedInfo?.genres ?? null;
	const series = bookData.series ?? cachedInfo?.series ?? null;
	const language = bookData.language ?? cachedInfo?.language ?? null;
	const notesCount = bookData.annotations.filter(
		(a) => (a as KOReaderAnnotation & { note?: string }).note?.trim()
	).length;

	// Frontmatter
	lines.push("---");
	lines.push(`title: "${escapeYaml(title)}"`);
	if (author) lines.push(`author: "${escapeYaml(author)}"`);
	if (bookData.progress !== null) {
		lines.push(`progress: ${bookData.progress.toFixed(1)}%`);
	}
	if (bookData.currentPage !== null) {
		lines.push(`current_page: ${bookData.currentPage}`);
	}
	if (pageCount !== null) {
		lines.push(`page_count: ${pageCount}`);
	}
	if (bookData.readingStatus) {
		lines.push(`reading_status: "${bookData.readingStatus}"`);
	}
	if (bookData.lastUpdatedAt) {
		lines.push(`last_read: ${new Date(bookData.lastUpdatedAt).toISOString().split("T")[0]}`);
	}
	if (readingTime) {
		lines.push(`reading_time: "${readingTime}"`);
	}
	lines.push(`last_synced: ${new Date().toISOString().split("T")[0]}`);
	lines.push(`book_source: koreader`);
	lines.push(`koreader_hash: "${bookData.hash}"`);
	lines.push(`highlights_count: ${bookData.annotations.length}`);
	lines.push(`highlights_hash: "${computeAnnotationsHash(bookData.annotations)}"`);
	lines.push(`notes_count: ${notesCount}`);
	if (publishedDate) lines.push(`published_date: "${escapeYaml(publishedDate)}"`);
	if (publisher) lines.push(`publisher: "${escapeYaml(publisher)}"`);
	if (genres && genres.length > 0) {
		lines.push("genres:");
		for (const g of genres) lines.push(`  - "${escapeYaml(g)}"`);
	}
	if (series) lines.push(`series: "${escapeYaml(series)}"`);
	if (language) lines.push(`language: "${language}"`);
	if (coverPath) lines.push(`cover: "${coverPath}"`);
	if (cachedInfo?.hardcoverId) {
		lines.push(`hardcover_id: ${cachedInfo.hardcoverId}`);
	}
	if (cachedInfo?.hardcoverSlug) {
		lines.push(`hardcover_url: "https://hardcover.app/books/${cachedInfo.hardcoverSlug}"`);
	}
	lines.push("---");
	lines.push("");

	// Header
	lines.push(`# ${title}`);
	if (author) lines.push(`**Author:** ${author}`);
	lines.push("");

	// Cover
	if (coverPath) {
		lines.push(`![[${coverPath}|200]]`);
		lines.push("");
	}

	// Reading progress callout
	if (bookData.progress !== null || bookData.lastUpdatedAt !== null) {
		lines.push("> [!moonsync-reading-progress]+ Reading progress");
		if (bookData.progress !== null) {
			lines.push(`> - **Progress:** ${bookData.progress.toFixed(1)}%`);
		}
		if (bookData.currentPage !== null && bookData.pageCount !== null) {
			lines.push(`> - **Page:** ${bookData.currentPage} of ${bookData.pageCount}`);
		}
		if (bookData.readingStatus) {
			const label = bookData.readingStatus === "finished" ? "Finished"
				: bookData.readingStatus === "reading" ? "Reading"
				: bookData.readingStatus;
			lines.push(`> - **Status:** ${label}`);
		}
		if (bookData.lastUpdatedAt) {
			lines.push(`> - **Last read:** ${formatDate(bookData.lastUpdatedAt)}`);
		}
		if (readingTime) {
			lines.push(`> - **Reading time:** ${readingTime}`);
		}
		lines.push("");
	}

	// Description
	if (description && description.trim()) {
		lines.push("> [!moonsync-description]+ Description");
		for (const line of description.trim().split("\n")) {
			lines.push(`> ${line}`);
		}
		lines.push("");
	}

	// Highlights
	if (bookData.annotations.length > 0) {
		lines.push("## KOReader highlights");
		lines.push("");

		const reverse = settings.highlightSort.endsWith("-reverse");
		const sortByDate = settings.highlightSort.startsWith("date");
		const sorted = [...bookData.annotations].sort((a, b) => {
			const cmp = sortByDate ? a.createdAt - b.createdAt : a.page - b.page;
			return reverse ? -cmp : cmp;
		});

		for (const annotation of sorted) {
			lines.push(formatAnnotation(annotation, settings.showHighlightColors));
			lines.push("");
		}
	}

	// My notes
	lines.push("## My notes");
	lines.push("");
	lines.push("> [!moonsync-user-notes]+ Your notes");
	lines.push("> Add your thoughts, analysis, and notes here. This section is preserved across syncs.");
	lines.push("");

	return lines.join("\n");
}

export function mergeKOReaderNote(
	existingContent: string,
	bookData: KOReaderBookData,
	settings: MoonSyncSettings,
	cachedInfo: CachedBookInfo | null,
	coverPath: string | null,
	readingTime: string | null
): string {
	// Extract user's "My notes" content to preserve it
	const myNotesPattern = /\n## My [Nn]otes\n([\s\S]*?)(?=\n## |\n---|\s*$)/;
	const myNotesMatch = existingContent.match(myNotesPattern);
	let userNotesContent = "";
	if (myNotesMatch) {
		let section = myNotesMatch[1];
		const placeholderPattern = /^> \[!moonsync-user-notes\]\+ Your [Nn]otes\n> Add your thoughts, analysis, and notes here\. This section is preserved across syncs\.\n?/;
		section = section.replace(placeholderPattern, "").trim();
		if (section) userNotesContent = section;
	}

	// Preserve hardcover fields from existing frontmatter that generateKOReaderBookNote
	// won't already re-write itself — otherwise they end up duplicated in the fresh output.
	// hardcover_id/hardcover_url ARE written by the generator when cachedInfo has a match,
	// but a manual "Update Hardcover link" writes them straight to frontmatter without
	// touching the cache, so they still need preserving when cachedInfo has none.
	const hardcoverFields: string[] = [];
	if (!cachedInfo?.hardcoverId) {
		const hcId = existingContent.match(/^hardcover_id: .+$/m);
		if (hcId) hardcoverFields.push(hcId[0]);
		const hcUrl = existingContent.match(/^hardcover_url: .+$/m);
		if (hcUrl) hardcoverFields.push(hcUrl[0]);
	}
	// hardcover_progress and hardcover_highlights_synced_at are never written by the
	// generator, always preserve them — losing the latter makes every highlight look
	// "never synced" and re-pushes all of them as duplicate Hardcover journal entries.
	const hcProgress = existingContent.match(/^hardcover_progress: .+$/m);
	if (hcProgress) hardcoverFields.push(hcProgress[0]);
	const hcHighlightsSyncedAt = existingContent.match(/^hardcover_highlights_synced_at: .+$/m);
	if (hcHighlightsSyncedAt) hardcoverFields.push(hcHighlightsSyncedAt[0]);

	let fresh = generateKOReaderBookNote(bookData, settings, cachedInfo, coverPath, readingTime);

	if (hardcoverFields.length > 0) {
		fresh = fresh.replace(/\n---\n/, `\n${hardcoverFields.join("\n")}\n---\n`);
	}

	if (userNotesContent) {
		const placeholder = "> [!moonsync-user-notes]+ Your notes\n> Add your thoughts, analysis, and notes here. This section is preserved across syncs.";
		fresh = fresh.replace(placeholder, userNotesContent);
	}

	return fresh;
}
