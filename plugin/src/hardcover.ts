import { requestUrl } from "obsidian";
import { BookInfoResult } from "./covers";
import { cleanForSearch } from "./utils";

const HARDCOVER_API = "https://api.hardcover.app/v1/graphql";

const STATUS_WANT_TO_READ = 1;
const STATUS_CURRENTLY_READING = 2;
const STATUS_READ = 3;

export interface HardcoverSyncResult {
	booksUpdated: number;
	booksFailed: number;
	/** Books where a Hardcover ID was newly discovered (needs writing to frontmatter) */
	newIds: { title: string; author: string; hardcoverId: number; slug: string }[];
	/** Titles of books that were successfully updated */
	updatedTitles: string[];
	/** Titles of books not found on Hardcover (so we can mark them to avoid retrying) */
	notFoundTitles: string[];
	/** Map of title -> slug for all successfully synced books (for building URLs) */
	slugs: Map<string, string>;
	/** Map of title -> pages for all successfully synced books (for caching) */
	pages: Map<string, number>;
}

interface HardcoverBookMatch {
	id: number;
	title: string;
	slug: string;
	pages: number | null;
}

/**
 * Escape a string for use inside a GraphQL string literal
 */
function escapeGraphQL(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}


/**
 * Score how well a candidate title matches a search title.
 * 3 = exact match, 2 = one starts with the other, 1 = one contains the other, 0 = no match
 */
function titleMatchScore(candidate: string, search: string): number {
	const c = candidate.toLowerCase();
	const s = search.toLowerCase();
	if (c === s) return 3;
	if (c.startsWith(s) || s.startsWith(c)) return 2;
	if (c.includes(s) || s.includes(c)) return 1;
	return 0;
}

/**
 * Build progressive search queries from a title.
 * Tries: full title, first half of words (drops subtitles), main word (skips articles).
 */
function buildSearchQueries(cleanTitle: string, cleanAuthor: string): string[] {
	const queries = [cleanAuthor ? `${cleanTitle} ${cleanAuthor}` : cleanTitle];
	const words = cleanTitle.split(" ");
	if (words.length > 3) {
		const halfQuery = words.slice(0, Math.ceil(words.length / 2)).join(" ");
		if (!queries.includes(halfQuery)) queries.push(halfQuery);
		const skipArticles = ["a", "an", "the"];
		const startIdx = skipArticles.includes(words[0].toLowerCase()) ? 1 : 0;
		const mainWord = words[startIdx] || words[0];
		if (!queries.includes(mainWord)) queries.push(mainWord);
	}
	return queries;
}

const MIN_USERS_THRESHOLD = 10;

/**
 * Full-text search for a book ID on Hardcover with progressive queries and title-similarity scoring.
 * Shared by both batchSearchHardcover and searchHardcoverBook.
 */
async function fullTextSearchForId(
	cleanTitle: string,
	cleanAuthor: string,
	token: string,
	excludeId?: number
): Promise<{ id: number; title: string } | null> {
	const searchQueries = buildSearchQueries(cleanTitle, cleanAuthor);
	const normalizedSearch = cleanTitle.toLowerCase();

	for (const query of searchQueries) {
		try {
			await rateLimitDelay();
			const searchQuery = `{
				search(
					query: "${escapeGraphQL(query)}",
					query_type: "books",
					per_page: 5
				) {
					results
				}
			}`;
			const result = await hardcoverGraphQL(searchQuery, token);
			const hits = result.data?.search?.results?.hits;
			if (hits && Array.isArray(hits) && hits.length > 0) {
				const validHits = hits.filter((h: any) => h.document);
				if (validHits.length > 0) {
					// Pick the best title match, breaking ties by popularity
					const doc = validHits.reduce((best: any, h: any) => {
						const bestTitle = (best?.title || "").toLowerCase();
						const hTitle = (h.document?.title || "").toLowerCase();
						const bestScore = titleMatchScore(bestTitle, normalizedSearch);
						const hScore = titleMatchScore(hTitle, normalizedSearch);
						if (hScore !== bestScore) return hScore > bestScore ? h.document : best;
						return (h.document?.users_count || 0) > (best?.users_count || 0) ? h.document : best;
					}, validHits[0].document);
					const docId = doc?.id ? parseInt(String(doc.id), 10) : null;
					const docUsers = doc?.users_count || 0;
					console.debug(`MoonSync: Hardcover search "${query}" — best hit: id=${docId}, users=${docUsers}, title="${doc?.title}"`);
					if (docId && (!excludeId || docId !== excludeId) && docUsers >= MIN_USERS_THRESHOLD) {
						return { id: docId, title: doc.title || cleanTitle };
					} else {
						console.debug(`MoonSync: Hardcover search "${query}" — rejected (users=${docUsers}, need >= ${MIN_USERS_THRESHOLD})`);
					}
				}
			}
		} catch (error) {
			console.debug("MoonSync: Hardcover text search failed", error);
		}
	}
	return null;
}

/**
 * Rate limiter — ensures at least 500ms between requests (under 120 req/min)
 */
let lastRequestTime = 0;
async function rateLimitDelay(): Promise<void> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < 500) {
		await new Promise((resolve) => setTimeout(resolve, 500 - elapsed));
	}
	lastRequestTime = Date.now();
}

/**
 * Send a GraphQL request to the Hardcover API using Obsidian's requestUrl.
 * Supports proper GraphQL variables (preferred) or inline queries.
 */
async function hardcoverGraphQL(
	query: string,
	token: string,
	variables?: Record<string, any>
): Promise<any> {
	const cleanToken = token.replace(/^Bearer\s+/i, "").replace(/\s/g, "");
	const payload: any = { query };
	if (variables) {
		payload.variables = variables;
	}

	const response = await requestUrl({
		url: HARDCOVER_API,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${cleanToken}`,
		},
		body: JSON.stringify(payload),
	});

	const json = response.json;
	if (json.errors && json.errors.length > 0) {
		console.debug("MoonSync: Hardcover GraphQL errors:", JSON.stringify(json.errors));
		throw new Error(json.errors[0].message);
	}
	return json;
}

/**
 * Validate a Hardcover API token by querying the current user
 */
export async function validateHardcoverToken(token: string): Promise<boolean> {
	try {
		const result = await hardcoverGraphQL("query { me { username } }", token);
		return result.data?.me?.[0]?.username != null;
	} catch (error) {
		console.error("MoonSync: Hardcover validate failed", error);
		return false;
	}
}

/**
 * Look up a book on Hardcover by its URL slug.
 * Returns id, title, slug, and page count.
 */
export async function lookupBookBySlug(
	slug: string,
	token: string
): Promise<HardcoverBookMatch | null> {
	try {
		await rateLimitDelay();
		const query = `{
			books(where: { slug: { _eq: "${escapeGraphQL(slug)}" } }, limit: 1) {
				id
				title
				slug
				pages
			}
		}`;
		const result = await hardcoverGraphQL(query, token);
		if (result.data?.books?.length > 0) {
			const book = result.data.books[0];
			return { id: book.id, title: book.title, slug: book.slug, pages: book.pages ?? null };
		}
	} catch (error) {
		console.debug("MoonSync: Hardcover slug lookup failed", error);
	}
	return null;
}

/**
 * Hydrate Hardcover book IDs into full BookInfoResult[].
 * Single GraphQL query for all IDs.
 */
async function hydrateHardcoverBooks(
	ids: number[],
	token: string
): Promise<BookInfoResult[]> {
	if (ids.length === 0) return [];

	await rateLimitDelay();
	const hydrateQuery = `{
		books(where: { id: { _in: [${ids.join(",")}] } }) {
			id
			title
			slug
			description
			release_date
			pages
			rating
			ratings_count
			image { url }
			cached_image
			contributions(order_by: { id: asc }, limit: 3) {
				author { name }
			}
			taggings(limit: 10) {
				tag { tag }
			}
			book_series {
				position
				series { name }
			}
			default_physical_edition {
				isbn_13
				pages
				publisher { name }
				language { language }
			}
			default_ebook_edition {
				isbn_13
				pages
				publisher { name }
				language { language }
			}
		}
	}`;
	const hydrateResult = await hardcoverGraphQL(hydrateQuery, token);
	const books = hydrateResult.data?.books;
	if (!books || !Array.isArray(books)) return [];

	// Sort results to match the original ID order
	const idOrder = new Map(ids.map((id, i) => [id, i]));
	books.sort((a: any, b: any) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999));

	return books.map((book: any): BookInfoResult => {
		let coverUrl: string | null = book.image?.url || null;
		if (!coverUrl && book.cached_image) {
			const cached = typeof book.cached_image === "string"
				? JSON.parse(book.cached_image)
				: book.cached_image;
			coverUrl = cached?.url || null;
		}

		const authors = (book.contributions || [])
			.map((c: any) => c.author?.name)
			.filter(Boolean);
		const authorStr = authors.length > 0 ? authors.join(", ") : null;

		const genres = (book.taggings || [])
			.map((t: any) => t.tag?.tag)
			.filter(Boolean);

		const seriesEntry = book.book_series?.[0];
		let series: string | null = null;
		if (seriesEntry?.series?.name) {
			series = seriesEntry.position
				? `${seriesEntry.series.name} #${seriesEntry.position}`
				: seriesEntry.series.name;
		}

		const edition = book.default_physical_edition || book.default_ebook_edition;
		const pageCount = book.pages || edition?.pages || null;
		const publisher = edition?.publisher?.name || null;
		const language = edition?.language?.language || null;

		return {
			title: book.title || null,
			coverUrl,
			description: book.description || null,
			author: authorStr,
			source: "hardcover",
			publishedDate: book.release_date || null,
			publisher,
			pageCount,
			genres: genres.length > 0 ? genres : null,
			series,
			language,
			hardcoverId: book.id,
			hardcoverSlug: book.slug || undefined,
		};
	});
}

/**
 * Search Hardcover for books and return full metadata as BookInfoResult[].
 * Used by the metadata modal's Hardcover tab.
 * Two-step: search for IDs, then hydrate with full book data.
 */
export async function searchHardcoverBooks(
	title: string,
	author: string,
	token: string,
	maxResults: number = 10
): Promise<BookInfoResult[]> {
	const query = author ? `${title} ${author}` : title;

	try {
		await rateLimitDelay();
		const searchQuery = `{
			search(
				query: "${escapeGraphQL(query)}",
				query_type: "books",
				per_page: ${maxResults}
			) {
				results
			}
		}`;
		const searchResult = await hardcoverGraphQL(searchQuery, token);
		const hits = searchResult.data?.search?.results?.hits;
		if (!hits || !Array.isArray(hits) || hits.length === 0) return [];

		const ids: number[] = hits
			.filter((h: any) => h.document?.id)
			.map((h: any) => parseInt(String(h.document.id), 10));
		if (ids.length === 0) return [];

		return await hydrateHardcoverBooks(ids, token);
	} catch (error) {
		console.error("MoonSync: Hardcover search failed", error);
		return [];
	}
}

/**
 * Batch search multiple books on Hardcover, then hydrate all results in one query.
 * Returns a Map of "title|author" -> BookInfoResult.
 * Much faster than searching+hydrating each book individually (N+1 calls instead of 2N).
 */
export async function batchSearchHardcover(
	books: Array<{ title: string; author: string }>,
	token: string,
	onProgress?: (completed: number, total: number, currentTitle?: string) => void
): Promise<Map<string, BookInfoResult>> {
	const results = new Map<string, BookInfoResult>();
	// Map from book ID to the key(s) that searched for it
	const idToKeys = new Map<number, string>();

	// Step 1: Search for each book's ID — try exact match first, then full-text search
	for (let i = 0; i < books.length; i++) {
		const book = books[i];
		const cleanTitle = cleanForSearch(book.title);
		const cleanAuthor = cleanForSearch(book.author);
		const key = `${book.title}|${book.author}`;
		let foundId: number | null = null;

		// Try exact title + author match (most reliable)
		if (cleanAuthor) {
			try {
				await rateLimitDelay();
				const exactQuery = `{
					books(
						where: {
							contributions: { author: { name: { _eq: "${escapeGraphQL(cleanAuthor)}" } } },
							title: { _eq: "${escapeGraphQL(cleanTitle)}" }
						},
						limit: 1,
						order_by: { users_read_count: desc }
					) { id }
				}`;
				const result = await hardcoverGraphQL(exactQuery, token);
				if (result.data?.books?.length > 0) {
					foundId = result.data.books[0].id;
				}
			} catch { /* try next approach */ }
		}

		// Try exact title match without author
		if (!foundId) {
			try {
				await rateLimitDelay();
				const titleQuery = `{
					books(
						where: { title: { _eq: "${escapeGraphQL(cleanTitle)}" } },
						limit: 1,
						order_by: { users_read_count: desc }
					) { id }
				}`;
				const result = await hardcoverGraphQL(titleQuery, token);
				if (result.data?.books?.length > 0) {
					foundId = result.data.books[0].id;
				}
			} catch { /* try next approach */ }
		}

		// Fallback: full-text search with progressive queries and title-similarity scoring
		if (!foundId) {
			const match = await fullTextSearchForId(cleanTitle, cleanAuthor, token);
			if (match) foundId = match.id;
		}

		if (foundId) {
			idToKeys.set(foundId, key);
		}

		onProgress?.(i + 1, books.length, book.title);
	}

	if (idToKeys.size === 0) return results;

	// Step 2: Hydrate all found IDs in one query
	try {
		const allIds = Array.from(idToKeys.keys());
		const hydrated = await hydrateHardcoverBooks(allIds, token);

		for (const info of hydrated) {
			if (info.hardcoverId) {
				const key = idToKeys.get(info.hardcoverId);
				if (key) {
					results.set(key, info);
				}
			}
		}
	} catch (error) {
		console.debug("MoonSync: Hardcover batch hydration failed", error);
	}

	return results;
}

/**
 * Search for a book on Hardcover by title and author.
 * Tries exact match first, then falls back to full-text search.
 * Returns id, title, and page count.
 */
async function searchHardcoverBook(
	title: string,
	author: string,
	token: string,
	excludeId?: number
): Promise<HardcoverBookMatch | null> {
	// Try exact match
	try {
		await rateLimitDelay();
		const exactQuery = `{
			books(
				where: {
					contributions: { author: { name: { _eq: "${escapeGraphQL(author)}" } } },
					title: { _eq: "${escapeGraphQL(title)}" }
				},
				limit: 1,
				order_by: { users_read_count: desc }
			) {
				id
				title
				slug
				pages
			}
		}`;
		const result = await hardcoverGraphQL(exactQuery, token);
		if (result.data?.books?.length > 0) {
			const book = result.data.books[0];
			if (!excludeId || book.id !== excludeId) {
				return { id: book.id, title: book.title, slug: book.slug, pages: book.pages ?? null };
			}
		}
	} catch (error) {
		console.debug("MoonSync: Hardcover exact search failed", error);
	}

	// Try exact title match WITHOUT author (handles wrong author in epub metadata)
	try {
		await rateLimitDelay();
		const titleOnlyQuery = `{
			books(
				where: { title: { _eq: "${escapeGraphQL(title)}" } },
				limit: 1,
				order_by: { users_read_count: desc }
			) {
				id
				title
				slug
				pages
			}
		}`;
		const result = await hardcoverGraphQL(titleOnlyQuery, token);
		if (result.data?.books?.length > 0) {
			const book = result.data.books[0];
			if (!excludeId || book.id !== excludeId) {
				return { id: book.id, title: book.title, slug: book.slug, pages: book.pages ?? null };
			}
		}
	} catch (error) {
		console.debug("MoonSync: Hardcover title-only search failed", error);
	}

	// Fallback to full-text search with progressive queries and title-similarity scoring
	const cleanTitle = cleanForSearch(title);
	const match = await fullTextSearchForId(cleanTitle, author, token, excludeId);
	if (match) {
		// Fetch slug and pages for the matched book
		let pages: number | null = null;
		let slug = "";
		try {
			await rateLimitDelay();
			const detailQuery = `{ books(where: { id: { _eq: ${match.id} } }, limit: 1) { slug pages } }`;
			const detailResult = await hardcoverGraphQL(detailQuery, token);
			const detail = detailResult.data?.books?.[0];
			pages = detail?.pages ?? null;
			slug = detail?.slug ?? "";
		} catch { /* ignore */ }
		return { id: match.id, title: match.title, slug, pages };
	}

	return null;
}

// ---- Mutations using proper GraphQL variables (matching KOReader plugin) ----

const USER_BOOK_PARTS = `
	id
	book_id
	status_id
	edition_id
	rating
	user_book_reads(order_by: { id: asc }) {
		id
		started_at
		finished_at
		edition_id
		progress_pages
	}
`;

const INSERT_USER_BOOK = `
mutation InsertUserBook($object: UserBookCreateInput!) {
	insert_user_book(object: $object) {
		error
		user_book {
			${USER_BOOK_PARTS}
		}
	}
}`;

const UPDATE_USER_BOOK_READ = `
mutation UpdateBookProgress($id: Int!, $pages: Int, $editionId: Int, $startedAt: date) {
	update_user_book_read(id: $id, object: {
		progress_pages: $pages,
		edition_id: $editionId,
		started_at: $startedAt,
	}) {
		error
		user_book_read {
			id
			started_at
			finished_at
			edition_id
			progress_pages
			user_book {
				id
				book_id
				status_id
				edition_id
				rating
			}
		}
	}
}`;

const INSERT_USER_BOOK_READ = `
mutation InsertUserBookRead($id: Int!, $pages: Int, $editionId: Int, $startedAt: date) {
	insert_user_book_read(user_book_id: $id, user_book_read: {
		progress_pages: $pages,
		edition_id: $editionId,
		started_at: $startedAt,
	}) {
		error
		user_book_read {
			id
			started_at
			finished_at
			edition_id
			progress_pages
			user_book {
				id
				book_id
				status_id
				edition_id
				rating
			}
		}
	}
}`;

const FIND_USER_BOOK = `
query FindUserBook($bookId: Int!) {
	me {
		id
		account_privacy_setting_id
		user_books(where: { book_id: { _eq: $bookId } }) {
			id
			book_id
			status_id
			edition_id
			rating
			edition {
				id
				pages
			}
			user_book_reads(order_by: { id: asc }) {
				id
				started_at
				finished_at
				edition_id
				progress_pages
			}
		}
	}
}`;

/**
 * Update a book's reading status and progress on Hardcover.
 */
interface UpdateResult {
	success: boolean;
	badEdition: boolean;
}

export async function updateHardcoverBook(
	bookId: number,
	statusId: number,
	progress: number,
	pages: number | null,
	token: string
): Promise<UpdateResult> {
	try {
		const today = new Date().toISOString().split("T")[0];

		// Query current state
		await rateLimitDelay();
		const meResult = await hardcoverGraphQL(FIND_USER_BOOK, token, { bookId });
		const meData = meResult.data?.me?.[0];
		const privacySettingId = meData?.account_privacy_setting_id ?? 1;
		let myUserBook = meData?.user_books?.[0];

		console.debug(`MoonSync: Hardcover book ${bookId} — existing user_book:`, JSON.stringify(myUserBook));

		// Check if progress has actually increased compared to what Hardcover knows.
		// This prevents overriding a manual status change (e.g. "Did Not Finish") when
		// the frontmatter cache is lost but the user hasn't actually read further.
		let progressIncreased = true;
		if (myUserBook) {
			const allReads: any[] = myUserBook.user_book_reads ?? [];
			const unfinished = allReads.filter((r: any) => !r.finished_at);
			const lastRead = unfinished.length > 0 ? unfinished[unfinished.length - 1] : null;
			const existingPages = lastRead?.progress_pages ?? 0;
			const edPages = myUserBook.edition?.pages ?? pages;
			const incomingPages = edPages && edPages > 0 ? Math.round((progress / 100) * edPages) : 0;
			progressIncreased = incomingPages > existingPages;
			console.debug(`MoonSync: Hardcover book ${bookId} — existing progress: ${existingPages} pages, incoming: ${incomingPages} pages, increased: ${progressIncreased}`);
		}

		// Only call insert_user_book if book isn't in library or status needs changing AND progress increased
		const needsStatusChange = !myUserBook || (myUserBook.status_id !== statusId && progressIncreased);

		if (needsStatusChange) {
			await rateLimitDelay();
			const insertVars: any = {
				object: {
					book_id: bookId,
					status_id: statusId,
					privacy_setting_id: privacySettingId,
				}
			};
			// Include edition_id if we know it from existing user_book
			if (myUserBook?.edition_id) {
				insertVars.object.edition_id = myUserBook.edition_id;
			}
			console.debug(`MoonSync: Hardcover book ${bookId} — insert_user_book vars:`, JSON.stringify(insertVars));
			const statusResult = await hardcoverGraphQL(INSERT_USER_BOOK, token, insertVars);
			const insertResult = statusResult.data?.insert_user_book;
			if (insertResult?.error) {
				console.debug(`MoonSync: Hardcover insert_user_book error for book ${bookId}: ${insertResult.error}`);
			}
			console.debug(`MoonSync: Hardcover insert_user_book response:`, JSON.stringify(insertResult?.user_book));

			// Use the response user_book as our state (it's the freshest)
			if (insertResult?.user_book) {
				myUserBook = insertResult.user_book;
				// We need edition info which isn't in insert response, re-query if needed
				if (!myUserBook.edition) {
					await rateLimitDelay();
					const reResult = await hardcoverGraphQL(FIND_USER_BOOK, token, { bookId });
					const freshUserBook = reResult.data?.me?.[0]?.user_books?.[0];
					if (freshUserBook) {
						myUserBook = freshUserBook;
					}
				}
			} else if (!myUserBook) {
				console.debug(`MoonSync: Hardcover book ${bookId} — no user_book found after insert (bad edition)`);
				return { success: false, badEdition: true };
			}
		} else {
			console.debug(`MoonSync: Hardcover book ${bookId} — status already ${statusId}, skipping insert_user_book`);
		}

		if (!myUserBook) {
			console.debug(`MoonSync: Hardcover book ${bookId} — no user_book found (bad edition)`);
			return { success: false, badEdition: true };
		}

		return await updateProgressForBook(bookId, myUserBook, progress, pages, today, token);
	} catch (error) {
		console.debug(`MoonSync: Hardcover update failed for book ${bookId}`, error);
		return { success: false, badEdition: false };
	}
}

const DELETE_USER_BOOK_READ = `
mutation DeleteRead($id: Int!) {
	delete_user_book_read(id: $id) {
		error
	}
}`;

async function updateProgressForBook(
	bookId: number,
	myUserBook: any,
	progress: number,
	pages: number | null,
	today: string,
	token: string
): Promise<UpdateResult> {
	if (progress <= 0) {
		return { success: true, badEdition: false };
	}

	// Use edition pages if available, fall back to book-level pages
	const editionId: number | null = myUserBook.edition?.id ?? myUserBook.edition_id ?? null;
	const editionPages = myUserBook.edition?.pages ?? pages;
	console.debug(`MoonSync: Hardcover book ${bookId} — editionId: ${editionId}, edition pages: ${myUserBook.edition?.pages}, book pages: ${pages}, using: ${editionPages}, progress: ${progress}%`);
	if (!editionPages || editionPages <= 0) {
		console.debug(`MoonSync: Hardcover book ${bookId} — no page count, skipping progress`);
		return { success: true, badEdition: false };
	}

	const progressPages = Math.round((progress / 100) * editionPages);

	// Reads are ordered by id ASC. Find the last unfinished read (current session).
	// Clean up any duplicate unfinished reads left by previous buggy code.
	const allReads: any[] = myUserBook.user_book_reads ?? [];
	const unfinishedReads = allReads.filter((r: any) => !r.finished_at);
	const finishedReads = allReads.filter((r: any) => r.finished_at);

	console.debug(`MoonSync: Hardcover book ${bookId} — ${allReads.length} total reads, ${unfinishedReads.length} unfinished, ${finishedReads.length} finished`);

	// If there are multiple unfinished reads, keep only the last one and delete the rest
	if (unfinishedReads.length > 1) {
		console.debug(`MoonSync: Hardcover book ${bookId} — cleaning up ${unfinishedReads.length - 1} duplicate unfinished reads`);
		// Keep the last one (highest ID), delete the rest
		for (const dup of unfinishedReads.slice(0, -1)) {
			try {
				await rateLimitDelay();
				await hardcoverGraphQL(DELETE_USER_BOOK_READ, token, { id: dup.id });
				console.debug(`MoonSync: Hardcover book ${bookId} — deleted duplicate read ${dup.id}`);
			} catch (err) {
				console.debug(`MoonSync: Hardcover book ${bookId} — failed to delete read ${dup.id}:`, err);
			}
		}
	}

	// Use the last unfinished read as the current one (like KOReader does)
	const currentRead = unfinishedReads.length > 0 ? unfinishedReads[unfinishedReads.length - 1] : null;
	const existingReadId: number | null = currentRead?.id ?? null;
	const existingStartedAt: string | null = currentRead?.started_at ?? null;
	const existingEditionId: number | null = currentRead?.edition_id ?? null;
	console.debug(`MoonSync: Hardcover book ${bookId} — target: ${progressPages}/${editionPages} pages, currentRead: id=${existingReadId}, started=${existingStartedAt}, edition=${existingEditionId}`);

	if (existingReadId) {
		// Update existing read entry — re-use existing started_at (like KOReader does)
		await rateLimitDelay();
		const vars = {
			id: existingReadId,
			pages: progressPages,
			editionId: editionId ?? existingEditionId,
			startedAt: existingStartedAt ?? today,
		};
		console.debug(`MoonSync: Hardcover update_user_book_read vars:`, JSON.stringify(vars));
		const updateResult = await hardcoverGraphQL(UPDATE_USER_BOOK_READ, token, vars);
		const updateData = updateResult.data?.update_user_book_read;
		if (updateData?.error) {
			console.debug(`MoonSync: Hardcover update_user_book_read error for book ${bookId}: ${updateData.error}`);
		}
		console.debug(`MoonSync: Hardcover update_user_book_read response:`, JSON.stringify(updateData?.user_book_read));
	} else {
		// No unfinished read exists — create new read entry
		const userBookId = myUserBook.id;
		await rateLimitDelay();
		const vars = {
			id: userBookId,
			pages: progressPages,
			editionId: editionId,
			startedAt: today,
		};
		console.debug(`MoonSync: Hardcover insert_user_book_read vars:`, JSON.stringify(vars));
		const insertResult = await hardcoverGraphQL(INSERT_USER_BOOK_READ, token, vars);
		const insertData = insertResult.data?.insert_user_book_read;
		if (insertData?.error) {
			console.debug(`MoonSync: Hardcover insert_user_book_read error for book ${bookId}: ${insertData.error}`);
		}
		console.debug(`MoonSync: Hardcover insert_user_book_read response:`, JSON.stringify(insertData?.user_book_read));
	}

	return { success: true, badEdition: false };
}

export interface HardcoverSyncItem {
	title: string;
	author: string;
	progress: number | null;
	hardcoverId: number | null; // from frontmatter
	cachedSlug?: string; // from cache, avoids re-fetching
	cachedPages?: number; // from cache, avoids re-fetching
}

/**
 * Sync books to Hardcover.
 * Uses hardcover_id from frontmatter when available, searches otherwise.
 * Returns newly discovered IDs so the caller can write them to frontmatter.
 */
export async function syncBooksToHardcover(
	books: HardcoverSyncItem[],
	token: string,
	onProgress?: (msg: string) => void
): Promise<HardcoverSyncResult> {
	const result: HardcoverSyncResult = {
		booksUpdated: 0,
		booksFailed: 0,
		newIds: [],
		updatedTitles: [],
		notFoundTitles: [],
		slugs: new Map(),
		pages: new Map(),
	};

	// Only process books that have progress data
	const booksToSync = books.filter((b) => b.progress !== null);
	if (booksToSync.length === 0) {
		return result;
	}

	console.debug(`MoonSync: Hardcover syncing ${booksToSync.length} books (of ${books.length} total)`);
	for (let i = 0; i < booksToSync.length; i++) {
		const book = booksToSync[i];
		console.debug(`MoonSync: Hardcover [${i + 1}/${booksToSync.length}] "${book.title}" — progress: ${book.progress}%, hardcoverId: ${book.hardcoverId}`);
		onProgress?.(`Hardcover: ${book.title} (${i + 1}/${booksToSync.length})`);

		try {
			let hardcoverId = book.hardcoverId;
			let pages: number | null = book.cachedPages ?? null;
			let slug = book.cachedSlug ?? "";

			// Search for book if no ID from frontmatter
			if (hardcoverId === null) {
				const match = await searchHardcoverBook(book.title, book.author, token);
				if (match) {
					hardcoverId = match.id;
					pages = match.pages;
					slug = match.slug;
					result.newIds.push({ title: book.title, author: book.author, hardcoverId, slug });
				} else {
					console.debug(`MoonSync: Could not find "${book.title}" on Hardcover, skipping`);
					result.notFoundTitles.push(book.title);
					continue;
				}
			} else if (!slug) {
				// Have ID but need pages and slug — only fetch if not cached
				try {
					await rateLimitDelay();
					const detailQuery = `{ books(where: { id: { _eq: ${hardcoverId} } }, limit: 1) { slug pages } }`;
					const detailResult = await hardcoverGraphQL(detailQuery, token);
					const detail = detailResult.data?.books?.[0];
					pages = detail?.pages ?? pages;
					slug = detail?.slug ?? "";
				} catch { /* ignore */ }
			}

			// Determine status based on progress
			const p = book.progress!;
			const statusId = p >= 99 ? STATUS_READ : p > 0 ? STATUS_CURRENTLY_READING : STATUS_WANT_TO_READ;

			let updated = await updateHardcoverBook(hardcoverId, statusId, p, pages, token);

			// If edition is bad, search for a working one and retry
			if (updated.badEdition) {
				console.debug(`MoonSync: Bad edition ${hardcoverId} for "${book.title}", searching for alternative`);
				const match = await searchHardcoverBook(book.title, book.author, token, hardcoverId);
				if (match) {
					hardcoverId = match.id;
					pages = match.pages;
					slug = match.slug;
					result.newIds.push({ title: book.title, author: book.author, hardcoverId, slug });
					updated = await updateHardcoverBook(hardcoverId, statusId, p, pages, token);
				}
			}

			if (updated.success) {
				result.booksUpdated++;
				result.updatedTitles.push(book.title);
				if (slug) result.slugs.set(book.title, slug);
				if (pages) result.pages.set(book.title, pages);
			} else {
				result.booksFailed++;
			}
		} catch (error) {
			result.booksFailed++;
			console.debug(`MoonSync: Hardcover sync failed for "${book.title}"`, error);
		}
	}

	return result;
}
