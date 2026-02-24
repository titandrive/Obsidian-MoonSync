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
 * Pick the result from a list whose title most closely matches the target title.
 * Falls back to the first result if none are close.
 */
function pickBestTitleMatch<T>(items: T[], targetTitle: string, getTitle: (item: T) => string): T {
	if (items.length === 1) return items[0];

	const target = targetTitle.toLowerCase().trim();
	let bestItem = items[0];
	let bestScore = -1;

	for (const item of items) {
		const candidate = getTitle(item).toLowerCase().trim();
		// Exact match is best
		if (candidate === target) return item;
		// Score: how much of the target appears in the candidate (and vice versa)
		// Prefer candidates that are the same length as target (penalize extra words)
		const targetWords = target.split(/\s+/);
		const candidateWords = candidate.split(/\s+/);
		const commonWords = targetWords.filter(w => candidateWords.includes(w)).length;
		const score = commonWords / Math.max(targetWords.length, candidateWords.length);
		if (score > bestScore) {
			bestScore = score;
			bestItem = item;
		}
	}

	return bestItem;
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
	// Clean title/author for API searches — strip filename artifacts
	const cleanTitle = title.replace(/-{2,}/g, " ").replace(/[^a-zA-Z0-9\s\u00C0-\u024F'-]/g, " ").replace(/\s+/g, " ").trim();
	const cleanAuthor = author.replace(/-{2,}/g, " ").replace(/[^a-zA-Z0-9\s\u00C0-\u024F'-]/g, " ").replace(/\s+/g, " ").trim();

	// Fetch from both sources in parallel
	const [openLibraryResult, googleBooksResult] = await Promise.all([
		fetchFromOpenLibrary(cleanTitle, cleanAuthor),
		fetchFromGoogleBooks(cleanTitle, cleanAuthor),
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
 * Batch fetch book info for multiple books with concurrency control
 * Returns a Map of "title|author" -> BookInfoResult
 */
export async function batchFetchBookInfo(
	books: Array<{ title: string; author: string }>,
	concurrency: number = 5
): Promise<Map<string, BookInfoResult>> {
	const results = new Map<string, BookInfoResult>();

	// Process in chunks to avoid rate limiting
	for (let i = 0; i < books.length; i += concurrency) {
		const chunk = books.slice(i, i + concurrency);
		const chunkResults = await Promise.all(
			chunk.map(async (book) => {
				const key = `${book.title}|${book.author}`;
				try {
					const info = await fetchBookInfo(book.title, book.author);
					return { key, info };
				} catch (error) {
					console.debug(`MoonSync: Failed to fetch info for "${book.title}"`, error);
					return { key, info: null };
				}
			})
		);

		for (const { key, info } of chunkResults) {
			if (info) {
				results.set(key, info);
			}
		}
	}

	return results;
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
		const searchUrl = `https://openlibrary.org/search.json?q=${query}&limit=5`;

		const response = await requestUrl({ url: searchUrl });
		const data = response.json;

		if (data.docs && data.docs.length > 0) {
			// Pick the result whose title best matches the searched title
			const book = pickBestTitleMatch(data.docs, title, (d: any) => d.title || "");

			// Get title only (skip subtitle - often unreliable marketing blurbs)
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
		console.debug("MoonSync: Open Library search failed", error);
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
		// Use simple keyword search for better matching
		// Field operators (intitle:, inauthor:) are too strict and miss many books
		const query = author ? `${title} ${author}` : title;
		const searchUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;

		const response = await requestUrl({ url: searchUrl });
		const data = response.json;

		if (data.items && data.items.length > 0) {
			// Pick the result whose title best matches the searched title
			const book = pickBestTitleMatch(data.items, title, (item: any) => item.volumeInfo?.title || "");
			const volumeInfo = book.volumeInfo;

			// Get title only (skip subtitle - often unreliable marketing blurbs)
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
		console.debug("MoonSync: Google Books search failed", error);
	}

	return result;
}

/**
 * Fetch multiple book results with covers from both sources
 * Returns up to maxResults from each source (default 5)
 */
export async function fetchMultipleBookCovers(
	title: string,
	author: string,
	maxResults: number = 10
): Promise<BookInfoResult[]> {
	const results: BookInfoResult[] = [];

	try {
		// Fetch from Google Books (supports multiple results)
		// Use simple keyword search for better matching
		const googleQuery = author ? `${title} ${author}` : title;
		const googleUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(googleQuery)}&maxResults=${maxResults}`;

		const googleResponse = await requestUrl({ url: googleUrl });
		const googleData = googleResponse.json;

		if (googleData.items && googleData.items.length > 0) {
			for (const book of googleData.items) {
				const volumeInfo = book.volumeInfo;
				const imageLinks = volumeInfo?.imageLinks;

				// Only include books with covers
				if (imageLinks) {
					const coverUrl = (
						imageLinks.large ||
						imageLinks.medium ||
						imageLinks.thumbnail ||
						imageLinks.smallThumbnail
					)?.replace("http://", "https://");

					if (coverUrl) {
						results.push({
							title: volumeInfo?.title || null,
							author: volumeInfo?.authors?.[0] || null,
							coverUrl,
							description: volumeInfo?.description || null,
							source: "googlebooks",
							publishedDate: volumeInfo?.publishedDate || null,
							publisher: volumeInfo?.publisher || null,
							pageCount: volumeInfo?.pageCount || null,
							genres: volumeInfo?.categories || null,
							series: null,
							language: volumeInfo?.language || null
						});
					}
				}
			}
		}
	} catch (error) {
		console.debug("MoonSync: Google Books search failed", error);
	}

	try {
		// Fetch from Open Library (limit parameter)
		const olQuery = encodeURIComponent(`${title} ${author}`);
		const olUrl = `https://openlibrary.org/search.json?q=${olQuery}&limit=${maxResults}`;

		const olResponse = await requestUrl({ url: olUrl });
		const olData = olResponse.json;

		if (olData.docs && olData.docs.length > 0) {
			for (const book of olData.docs) {
				// Only include books with covers
				let coverUrl: string | null = null;
				if (book.cover_i) {
					coverUrl = `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`;
				} else if (book.isbn && book.isbn.length > 0) {
					coverUrl = `https://covers.openlibrary.org/b/isbn/${book.isbn[0]}-L.jpg`;
				}

				if (coverUrl) {
					results.push({
						title: book.title || null,
						author: book.author_name?.[0] || null,
						coverUrl,
						description: null, // Would need extra API call per book
						source: "openlibrary",
						publishedDate: book.first_publish_year?.toString() || null,
						publisher: book.publisher?.[0] || null,
						pageCount: book.number_of_pages_median || null,
						genres: book.subject?.slice(0, 5) || null,
						series: null,
						language: book.language?.[0] || null
					});
				}
			}
		}
	} catch (error) {
		console.debug("MoonSync: Open Library search failed", error);
	}

	// Remove duplicates based on cover URL
	const uniqueResults = results.filter((result, index, self) =>
		index === self.findIndex(r => r.coverUrl === result.coverUrl)
	);

	return uniqueResults;
}

/**
 * Download cover image and return as ArrayBuffer
 */
export async function downloadCover(url: string): Promise<ArrayBuffer | null> {
	try {
		const response = await requestUrl({ url });
		return response.arrayBuffer;
	} catch (error) {
		console.debug("MoonSync: Failed to download cover", error);
		return null;
	}
}

/**
 * Download and resize cover image
 * Returns resized image as ArrayBuffer (JPEG format)
 */
export async function downloadAndResizeCover(
	url: string,
	maxWidth: number = 400,
	maxHeight: number = 600
): Promise<ArrayBuffer | null> {
	try {
		const response = await requestUrl({ url });
		const arrayBuffer = response.arrayBuffer;

		// Convert to blob and create image
		const blob = new Blob([arrayBuffer]);
		const imageBitmap = await createImageBitmap(blob);

		// Calculate new dimensions maintaining aspect ratio
		let width = imageBitmap.width;
		let height = imageBitmap.height;

		if (width > maxWidth) {
			height = (height * maxWidth) / width;
			width = maxWidth;
		}
		if (height > maxHeight) {
			width = (width * maxHeight) / height;
			height = maxHeight;
		}

		// Create canvas and draw resized image
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;

		const ctx = canvas.getContext("2d");
		if (!ctx) {
			console.debug("MoonSync: Failed to get canvas context");
			return arrayBuffer; // Return original if resize fails
		}

		ctx.drawImage(imageBitmap, 0, 0, width, height);

		// Convert to JPEG blob
		const resizedBlob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
		});

		if (!resizedBlob) {
			return arrayBuffer; // Return original if conversion fails
		}

		return await resizedBlob.arrayBuffer();
	} catch (error) {
		console.debug("MoonSync: Failed to download/resize cover", error);
		return null;
	}
}
