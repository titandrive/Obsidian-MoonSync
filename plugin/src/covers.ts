import { requestUrl } from "obsidian";

export interface BookInfoResult {
	title: string | null;
	coverUrl: string | null;
	description: string | null;
	author: string | null;
	source: "openlibrary" | "googlebooks" | null;
	publishedDate: string | null;
	publisher: string | null;
	pageCount: number | null;
	genres: string[] | null;
	series: string | null;
	language: string | null;
}

interface OpenLibraryResult {
	title: string | null;
	coverUrl: string | null;
	description: string | null;
	author: string | null;
	publishedDate: string | null;
	publisher: string | null;
	pageCount: number | null;
	genres: string[] | null;
	series: string | null;
	language: string | null;
}

interface GoogleBooksResult {
	title: string | null;
	coverUrl: string | null;
	description: string | null;
	author: string | null;
	publishedDate: string | null;
	publisher: string | null;
	pageCount: number | null;
	genres: string[] | null;
	language: string | null;
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

	// Prefer Google Books for author and title (usually more accurate)
	const fetchedTitle = googleBooksResult.title || openLibraryResult.title;
	const fetchedAuthor = googleBooksResult.author || openLibraryResult.author;

	// Prefer Google Books for metadata (more complete)
	const publishedDate = googleBooksResult.publishedDate || openLibraryResult.publishedDate;
	const publisher = googleBooksResult.publisher || openLibraryResult.publisher;
	const pageCount = googleBooksResult.pageCount || openLibraryResult.pageCount;
	const language = googleBooksResult.language || openLibraryResult.language;

	// Merge genres from both sources
	const genres: string[] = [];
	if (googleBooksResult.genres) {
		genres.push(...googleBooksResult.genres);
	}
	if (openLibraryResult.genres) {
		// Add Open Library genres that aren't already included
		for (const genre of openLibraryResult.genres) {
			if (!genres.some(g => g.toLowerCase() === genre.toLowerCase())) {
				genres.push(genre);
			}
		}
	}

	// Series only comes from Open Library
	const series = openLibraryResult.series;

	// Determine source based on what we're using
	let source: "openlibrary" | "googlebooks" | null = null;
	if (coverUrl || description) {
		source = googleBooksResult.description ? "googlebooks" : "openlibrary";
	}

	return {
		title: fetchedTitle,
		coverUrl,
		description,
		author: fetchedAuthor,
		source,
		publishedDate,
		publisher,
		pageCount,
		genres: genres.length > 0 ? genres : null,
		series,
		language
	};
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
	const result: OpenLibraryResult = {
		title: null,
		coverUrl: null,
		description: null,
		author: null,
		publishedDate: null,
		publisher: null,
		pageCount: null,
		genres: null,
		series: null,
		language: null
	};

	try {
		const query = encodeURIComponent(`${title} ${author}`);
		const searchUrl = `https://openlibrary.org/search.json?q=${query}&limit=1`;

		const response = await requestUrl({ url: searchUrl });
		const data = response.json;

		if (data.docs && data.docs.length > 0) {
			const book = data.docs[0];

			// Get title
			if (book.title) {
				result.title = book.title;
			}

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

			// Get metadata from search results
			if (book.first_publish_year) {
				result.publishedDate = book.first_publish_year.toString();
			}

			if (book.publisher && book.publisher.length > 0) {
				result.publisher = book.publisher[0];
			}

			if (book.number_of_pages_median) {
				result.pageCount = book.number_of_pages_median;
			}

			if (book.subject && book.subject.length > 0) {
				// Take first 5 subjects as genres
				result.genres = book.subject.slice(0, 5);
			}

			if (book.language && book.language.length > 0) {
				result.language = book.language[0];
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

					// Check for series information
					if (workData.series && workData.series.length > 0) {
						result.series = workData.series[0];
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
	const result: GoogleBooksResult = {
		title: null,
		coverUrl: null,
		description: null,
		author: null,
		publishedDate: null,
		publisher: null,
		pageCount: null,
		genres: null,
		language: null
	};

	try {
		// Use field-specific search for better results
		const query = encodeURIComponent(`intitle:${title} inauthor:${author}`);
		const searchUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`;

		const response = await requestUrl({ url: searchUrl });
		const data = response.json;

		if (data.items && data.items.length > 0) {
			const book = data.items[0];
			const volumeInfo = book.volumeInfo;

			// Get title
			if (volumeInfo?.title) {
				result.title = volumeInfo.title;
			}

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

			// Get author
			if (volumeInfo?.authors && volumeInfo.authors.length > 0) {
				result.author = volumeInfo.authors[0];
			}

			// Get published date
			if (volumeInfo?.publishedDate) {
				result.publishedDate = volumeInfo.publishedDate;
			}

			// Get publisher
			if (volumeInfo?.publisher) {
				result.publisher = volumeInfo.publisher;
			}

			// Get page count
			if (volumeInfo?.pageCount) {
				result.pageCount = volumeInfo.pageCount;
			}

			// Get categories/genres
			if (volumeInfo?.categories && volumeInfo.categories.length > 0) {
				result.genres = volumeInfo.categories;
			}

			// Get language
			if (volumeInfo?.language) {
				result.language = volumeInfo.language;
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
