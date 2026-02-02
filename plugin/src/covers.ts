import { requestUrl } from "obsidian";

export interface BookInfoResult {
	coverUrl: string | null;
	description: string | null;
	rating: number | null;
	ratingsCount: number | null;
	author: string | null;
	source: "openlibrary" | "googlebooks" | null;
}

interface OpenLibraryResult {
	coverUrl: string | null;
	description: string | null;
	author: string | null;
}

interface GoogleBooksResult {
	coverUrl: string | null;
	description: string | null;
	rating: number | null;
	ratingsCount: number | null;
	author: string | null;
}

/**
 * Fetch book info (cover and description) from Open Library and Google Books
 * Tries both sources and combines best results:
 * - Cover: prefers Open Library (higher quality), falls back to Google
 * - Description: prefers Google Books (better descriptions), falls back to Open Library
 */
export async function fetchBookInfo(
	title: string,
	author: string
): Promise<BookInfoResult> {
	// Fetch from both sources in parallel
	const [openLibraryResult, googleBooksResult] = await Promise.all([
		fetchFromOpenLibrary(title, author),
		fetchFromGoogleBooks(title, author),
	]);

	// Prefer Open Library for covers (higher resolution)
	const coverUrl = openLibraryResult.coverUrl || googleBooksResult.coverUrl;

	// Prefer Google Books for descriptions (usually better quality)
	const description = googleBooksResult.description || openLibraryResult.description;

	// Ratings only come from Google Books
	const rating = googleBooksResult.rating;
	const ratingsCount = googleBooksResult.ratingsCount;

	// Prefer Google Books for author (usually more accurate)
	const fetchedAuthor = googleBooksResult.author || openLibraryResult.author;

	// Determine source based on what we're using
	let source: "openlibrary" | "googlebooks" | null = null;
	if (coverUrl || description) {
		source = googleBooksResult.description ? "googlebooks" : "openlibrary";
	}

	return { coverUrl, description, rating, ratingsCount, author: fetchedAuthor, source };
}

/**
 * Legacy function for backward compatibility
 */
export async function fetchBookCover(
	title: string,
	author: string
): Promise<{ url: string | null; source: "openlibrary" | "googlebooks" | null }> {
	const result = await fetchBookInfo(title, author);
	return { url: result.coverUrl, source: result.source };
}

/**
 * Search Open Library for book cover and description
 */
async function fetchFromOpenLibrary(
	title: string,
	author: string
): Promise<OpenLibraryResult> {
	const result: OpenLibraryResult = { coverUrl: null, description: null, author: null };

	try {
		const query = encodeURIComponent(`${title} ${author}`);
		const searchUrl = `https://openlibrary.org/search.json?q=${query}&limit=1`;

		const response = await requestUrl({ url: searchUrl });
		const data = response.json;

		if (data.docs && data.docs.length > 0) {
			const book = data.docs[0];

			// Get cover URL
			if (book.cover_i) {
				result.coverUrl = `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`;
			} else if (book.isbn && book.isbn.length > 0) {
				result.coverUrl = `https://covers.openlibrary.org/b/isbn/${book.isbn[0]}-L.jpg`;
			}

			// Get author
			if (book.author_name && book.author_name.length > 0) {
				result.author = book.author_name[0];
			}

			// Get description - Open Library search doesn't include full description
			// We need to fetch the work details if we have a work key
			if (book.key) {
				try {
					const workUrl = `https://openlibrary.org${book.key}.json`;
					const workResponse = await requestUrl({ url: workUrl });
					const workData = workResponse.json;

					if (workData.description) {
						// Description can be a string or an object with "value" property
						result.description =
							typeof workData.description === "string"
								? workData.description
								: workData.description.value || null;
					}
				} catch {
					// Work fetch failed, continue without description
				}
			}
		}
	} catch (error) {
		console.log("MoonSync: Open Library search failed", error);
	}

	return result;
}

/**
 * Search Google Books for book cover and description
 */
async function fetchFromGoogleBooks(
	title: string,
	author: string
): Promise<GoogleBooksResult> {
	const result: GoogleBooksResult = { coverUrl: null, description: null, rating: null, ratingsCount: null, author: null };

	try {
		const query = encodeURIComponent(`${title} ${author}`);
		const searchUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`;

		const response = await requestUrl({ url: searchUrl });
		const data = response.json;

		if (data.items && data.items.length > 0) {
			const book = data.items[0];
			const volumeInfo = book.volumeInfo;

			// Get cover URL
			const imageLinks = volumeInfo?.imageLinks;
			if (imageLinks) {
				result.coverUrl = (
					imageLinks.large ||
					imageLinks.medium ||
					imageLinks.thumbnail ||
					imageLinks.smallThumbnail
				)?.replace("http://", "https://"); // Ensure HTTPS
			}

			// Get description
			if (volumeInfo?.description) {
				result.description = volumeInfo.description;
			}

			// Get rating
			if (volumeInfo?.averageRating) {
				result.rating = volumeInfo.averageRating;
			}
			if (volumeInfo?.ratingsCount) {
				result.ratingsCount = volumeInfo.ratingsCount;
			}

			// Get author
			if (volumeInfo?.authors && volumeInfo.authors.length > 0) {
				result.author = volumeInfo.authors[0];
			}
		}
	} catch (error) {
		console.log("MoonSync: Google Books search failed", error);
	}

	return result;
}

/**
 * Download cover image and return as ArrayBuffer
 */
export async function downloadCover(url: string): Promise<ArrayBuffer | null> {
	try {
		const response = await requestUrl({ url });
		return response.arrayBuffer;
	} catch (error) {
		console.log("MoonSync: Failed to download cover", error);
		return null;
	}
}
