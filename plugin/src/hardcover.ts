import { execFile } from "child_process";

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
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Rate limiter — ensures at least 1100ms between requests (under 60 req/min)
 */
let lastRequestTime = 0;
async function rateLimitDelay(): Promise<void> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < 1100) {
		await new Promise((resolve) => setTimeout(resolve, 1100 - elapsed));
	}
	lastRequestTime = Date.now();
}

/**
 * Send a GraphQL request to the Hardcover API via curl.
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
	const body = JSON.stringify(payload);

	return new Promise((resolve, reject) => {
		execFile("curl", [
			"-s",
			"-X", "POST",
			HARDCOVER_API,
			"-H", "Content-Type: application/json",
			"-H", `Authorization: Bearer ${cleanToken}`,
			"-d", body,
		], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr || error.message));
				return;
			}
			try {
				const json = JSON.parse(stdout);
				if (json.errors && json.errors.length > 0) {
					console.log("MoonSync: Hardcover GraphQL errors:", JSON.stringify(json.errors));
					reject(new Error(json.errors[0].message));
					return;
				}
				resolve(json);
			} catch {
				console.log("MoonSync: Hardcover raw response:", stdout.slice(0, 500));
				reject(new Error("Failed to parse Hardcover response"));
			}
		});
	});
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

	// Fallback to full-text search (returns less data, need to fetch pages separately)
	try {
		await rateLimitDelay();
		const searchQuery = `{
			search(
				query: "${escapeGraphQL(title + " " + author)}",
				query_type: "books",
				per_page: 5
			) {
				results
			}
		}`;
		const result = await hardcoverGraphQL(searchQuery, token);
		const hits = result.data?.search?.results?.hits;
		if (hits && Array.isArray(hits) && hits.length > 0) {
			// Prefer a hit whose author matches
			const authorLower = author.toLowerCase();
			let bestHit = hits[0].document;
			if (author) {
				for (const h of hits) {
					const names: string[] = h.document?.author_names || [];
					if (names.some((n: string) => n.toLowerCase().includes(authorLower))) {
						bestHit = h.document;
						break;
					}
				}
			}
			const doc = bestHit;
			if (doc?.id && (!excludeId || doc.id !== excludeId)) {
				// Fetch page count and slug for this book
				let pages: number | null = null;
				let slug = "";
				try {
					await rateLimitDelay();
					const detailQuery = `{ books(where: { id: { _eq: ${doc.id} } }, limit: 1) { slug pages } }`;
					const detailResult = await hardcoverGraphQL(detailQuery, token);
					const detail = detailResult.data?.books?.[0];
					pages = detail?.pages ?? null;
					slug = detail?.slug ?? "";
				} catch { /* ignore */ }
				return { id: doc.id, title: doc.title || title, slug, pages };
			}
		}
	} catch (error) {
		console.debug("MoonSync: Hardcover text search failed", error);
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

		console.log(`MoonSync: Hardcover book ${bookId} — existing user_book:`, JSON.stringify(myUserBook));

		// Only call insert_user_book if book isn't in library or status needs changing
		const needsStatusChange = !myUserBook || myUserBook.status_id !== statusId;

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
			console.log(`MoonSync: Hardcover book ${bookId} — insert_user_book vars:`, JSON.stringify(insertVars));
			const statusResult = await hardcoverGraphQL(INSERT_USER_BOOK, token, insertVars);
			const insertResult = statusResult.data?.insert_user_book;
			if (insertResult?.error) {
				console.log(`MoonSync: Hardcover insert_user_book error for book ${bookId}: ${insertResult.error}`);
			}
			console.log(`MoonSync: Hardcover insert_user_book response:`, JSON.stringify(insertResult?.user_book));

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
				console.log(`MoonSync: Hardcover book ${bookId} — no user_book found after insert (bad edition)`);
				return { success: false, badEdition: true };
			}
		} else {
			console.log(`MoonSync: Hardcover book ${bookId} — status already ${statusId}, skipping insert_user_book`);
		}

		if (!myUserBook) {
			console.log(`MoonSync: Hardcover book ${bookId} — no user_book found (bad edition)`);
			return { success: false, badEdition: true };
		}

		return await updateProgressForBook(bookId, myUserBook, progress, pages, today, token);
	} catch (error) {
		console.log(`MoonSync: Hardcover update failed for book ${bookId}`, error);
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
	console.log(`MoonSync: Hardcover book ${bookId} — editionId: ${editionId}, edition pages: ${myUserBook.edition?.pages}, book pages: ${pages}, using: ${editionPages}, progress: ${progress}%`);
	if (!editionPages || editionPages <= 0) {
		console.log(`MoonSync: Hardcover book ${bookId} — no page count, skipping progress`);
		return { success: true, badEdition: false };
	}

	const progressPages = Math.round((progress / 100) * editionPages);

	// Reads are ordered by id ASC. Find the last unfinished read (current session).
	// Clean up any duplicate unfinished reads left by previous buggy code.
	const allReads: any[] = myUserBook.user_book_reads ?? [];
	const unfinishedReads = allReads.filter((r: any) => !r.finished_at);
	const finishedReads = allReads.filter((r: any) => r.finished_at);

	console.log(`MoonSync: Hardcover book ${bookId} — ${allReads.length} total reads, ${unfinishedReads.length} unfinished, ${finishedReads.length} finished`);

	// If there are multiple unfinished reads, keep only the last one and delete the rest
	if (unfinishedReads.length > 1) {
		console.log(`MoonSync: Hardcover book ${bookId} — cleaning up ${unfinishedReads.length - 1} duplicate unfinished reads`);
		// Keep the last one (highest ID), delete the rest
		for (const dup of unfinishedReads.slice(0, -1)) {
			try {
				await rateLimitDelay();
				await hardcoverGraphQL(DELETE_USER_BOOK_READ, token, { id: dup.id });
				console.log(`MoonSync: Hardcover book ${bookId} — deleted duplicate read ${dup.id}`);
			} catch (err) {
				console.log(`MoonSync: Hardcover book ${bookId} — failed to delete read ${dup.id}:`, err);
			}
		}
	}

	// Use the last unfinished read as the current one (like KOReader does)
	const currentRead = unfinishedReads.length > 0 ? unfinishedReads[unfinishedReads.length - 1] : null;
	const existingReadId: number | null = currentRead?.id ?? null;
	const existingStartedAt: string | null = currentRead?.started_at ?? null;
	const existingEditionId: number | null = currentRead?.edition_id ?? null;
	console.log(`MoonSync: Hardcover book ${bookId} — target: ${progressPages}/${editionPages} pages, currentRead: id=${existingReadId}, started=${existingStartedAt}, edition=${existingEditionId}`);

	if (existingReadId) {
		// Update existing read entry — re-use existing started_at (like KOReader does)
		await rateLimitDelay();
		const vars = {
			id: existingReadId,
			pages: progressPages,
			editionId: editionId ?? existingEditionId,
			startedAt: existingStartedAt ?? today,
		};
		console.log(`MoonSync: Hardcover update_user_book_read vars:`, JSON.stringify(vars));
		const updateResult = await hardcoverGraphQL(UPDATE_USER_BOOK_READ, token, vars);
		const updateData = updateResult.data?.update_user_book_read;
		if (updateData?.error) {
			console.log(`MoonSync: Hardcover update_user_book_read error for book ${bookId}: ${updateData.error}`);
		}
		console.log(`MoonSync: Hardcover update_user_book_read response:`, JSON.stringify(updateData?.user_book_read));
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
		console.log(`MoonSync: Hardcover insert_user_book_read vars:`, JSON.stringify(vars));
		const insertResult = await hardcoverGraphQL(INSERT_USER_BOOK_READ, token, vars);
		const insertData = insertResult.data?.insert_user_book_read;
		if (insertData?.error) {
			console.log(`MoonSync: Hardcover insert_user_book_read error for book ${bookId}: ${insertData.error}`);
		}
		console.log(`MoonSync: Hardcover insert_user_book_read response:`, JSON.stringify(insertData?.user_book_read));
	}

	return { success: true, badEdition: false };
}

export interface HardcoverSyncItem {
	title: string;
	author: string;
	progress: number | null;
	hardcoverId: number | null; // from frontmatter
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
	};

	// Only process books that have progress data
	const booksToSync = books.filter((b) => b.progress !== null);
	if (booksToSync.length === 0) {
		return result;
	}

	console.log(`MoonSync: Hardcover syncing ${booksToSync.length} books (of ${books.length} total)`);
	for (let i = 0; i < booksToSync.length; i++) {
		const book = booksToSync[i];
		console.log(`MoonSync: Hardcover [${i + 1}/${booksToSync.length}] "${book.title}" — progress: ${book.progress}%, hardcoverId: ${book.hardcoverId}`);
		onProgress?.(`Hardcover: ${book.title} (${i + 1}/${booksToSync.length})`);

		try {
			let hardcoverId = book.hardcoverId;
			let pages: number | null = null;
			let slug = "";

			// Search for book if no ID from frontmatter
			if (hardcoverId === null) {
				const match = await searchHardcoverBook(book.title, book.author, token);
				if (match) {
					hardcoverId = match.id;
					pages = match.pages;
					slug = match.slug;
					result.newIds.push({ title: book.title, author: book.author, hardcoverId, slug });
				} else {
					console.log(`MoonSync: Could not find "${book.title}" on Hardcover, skipping`);
					result.notFoundTitles.push(book.title);
					continue;
				}
			} else {
				// Have ID but need pages and slug for progress update
				try {
					await rateLimitDelay();
					const detailQuery = `{ books(where: { id: { _eq: ${hardcoverId} } }, limit: 1) { slug pages } }`;
					const detailResult = await hardcoverGraphQL(detailQuery, token);
					const detail = detailResult.data?.books?.[0];
					pages = detail?.pages ?? null;
					slug = detail?.slug ?? "";
				} catch { /* ignore */ }
			}

			// Determine status based on progress
			const p = book.progress!;
			const statusId = p >= 99 ? STATUS_READ : p > 0 ? STATUS_CURRENTLY_READING : STATUS_WANT_TO_READ;

			let updated = await updateHardcoverBook(hardcoverId, statusId, p, pages, token);

			// If edition is bad, search for a working one and retry
			if (updated.badEdition) {
				console.log(`MoonSync: Bad edition ${hardcoverId} for "${book.title}", searching for alternative`);
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
			} else {
				result.booksFailed++;
			}
		} catch (error) {
			result.booksFailed++;
			console.log(`MoonSync: Hardcover sync failed for "${book.title}"`, error);
		}
	}

	return result;
}
