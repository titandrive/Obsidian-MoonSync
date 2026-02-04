# MoonSync

Sync your reading highlights and progress from Moon Reader+ to Obsidian.

## How It Works

MoonSync uses **real-time sync** by reading Moon Reader's cache files directly from Dropbox. When you make a highlight or read a book in Moon Reader and it syncs to the cloud, those changes are immediately available to MoonSync.

**Data flow:** Moon Reader → Dropbox Cloud Sync → MoonSync → Obsidian

### What Gets Synced

- Book highlights with timestamps and colors
- Reading progress (percentage and current chapter)
- Book metadata (title, author, publisher, page count, genres, series)
- Book covers, descriptions, and ratings (fetched from Google Books/Open Library)

### Requirements

- Moon Reader+ with Dropbox cloud sync enabled
- Sync folder at `Dropbox/Apps/Books/.Moon+/Cache/`

## Installation

1. Copy the `moonsync` folder to your vault's `.obsidian/plugins/` directory
2. Enable the plugin in Obsidian Settings → Community Plugins
3. Configure the Dropbox path in plugin settings

## Commands

MoonSync provides several commands accessible via the command palette (`Cmd/Ctrl + P`):

### Sync Now
Synchronize all books from Moon Reader. Only updates notes when highlights or progress have changed.

### Create Book Note
Create a new book note by searching Google Books/Open Library. Opens a visual grid of search results - click a book to create a note with full metadata, cover, and a placeholder highlights section.

### Fetch Book Cover
Re-fetch the cover image for the current note. Useful if a book didn't have a cover initially or you want a different edition's cover.

### Fetch Book Metadata
Replace all metadata for the current note by selecting from search results. Updates title, author, cover, description, publisher, page count, genres, series, and language. Also sets `custom_metadata: true` to prevent future syncs from overwriting your selection.

### Import Moon Reader Export
Import highlights from a Moon Reader backup export file (`.mrexport`). Useful for one-time imports or when Dropbox sync isn't available.

## Settings

### Sync Tab

#### Moon Reader Dropbox Path
Path to your Books folder in Dropbox (e.g., `/Users/you/Dropbox/Apps/Books`). The plugin automatically looks for the hidden `.Moon+/Cache` folder inside.

**Tip:** On macOS, press `Cmd+Shift+.` in the folder picker to show hidden folders.

#### Output Folder
Vault folder where book notes are created. Defaults to `Books`.

#### Sync Options
- **Sync on Startup** - Automatically sync when Obsidian starts
- **Show Ribbon Icon** - Show sync button in the ribbon menu

### Display Tab

#### Note Content Options
- **Show Description** - Include book description (from Google Books/Open Library)
- **Show Ratings** - Include star rating and rating count
- **Show Reading Progress** - Include progress percentage and current chapter in the highlights section
- **Show Highlight Colors** - Use different callout styles based on highlight color
- **Show Notes** - Include your annotations below highlights
- **Fetch Book Covers** - Download covers from Open Library/Google Books

#### Library Index
- **Show Library Index** - Generate a visual index page with cover thumbnails and statistics

### Highlight Colors

When "Show Highlight Colors" is enabled:
- Yellow → `[!quote]`
- Blue → `[!info]`
- Red → `[!warning]`
- Green → `[!tip]`

## Library Index

When enabled, MoonSync generates a `1. Library Index.md` file with:

- Visual grid of book covers (clickable links to each book)
- Summary statistics (total books, highlights, notes, average progress)
- List of all books with author, progress, and highlight counts

The index updates automatically after each sync.

## Output Format

Each book creates a markdown file with:

```markdown
---
title: "Book Title"
author: "Author Name"
published_date: "2024"
publisher: "Publisher Name"
page_count: 320
genres:
  - "Fiction"
  - "Science Fiction"
progress: "41.1%"
current_chapter: 25
last_synced: 2026-02-02
highlights_count: 12
notes_count: 3
rating: 4.2
ratings_count: 1234
cover: "covers/Book Title.jpg"
---

# Book Title
**Author:** Author Name

![[covers/Book Title.jpg|200]]

**Rating:** ⭐ 4.2/5 (1,234 ratings)

## Description
Book description from Google Books...

## Highlights

**Reading Progress:**
- Progress: 41.1%
- Chapter: 25

> [!quote] Chapter 3 • Jan 15, 2026
> "Highlighted text from the book..."

> [!info] Chapter 4 • Jan 16, 2026
> "Blue highlighted text..."
>
> **Note:** Your annotation appears here
```

## Custom Metadata Protection

MoonSync respects two special frontmatter flags:

### `custom_metadata: true`
Set automatically when you use "Fetch Book Metadata" command. When present:
- Sync preserves all your custom metadata (title, author, cover, etc.)
- Only highlights and reading progress are updated from Moon Reader

### `manual_note: true`
For notes created via "Create Book Note" command. When present:
- If the book later appears in Moon Reader, highlights are merged in
- Your custom content is preserved

## How Real-Time Sync Works

Moon Reader stores highlights and reading position in cache files that sync to Dropbox:

- **`.an` files** - Compressed annotation/highlight data for each book
- **`.po` files** - Reading position (progress percentage, current chapter)

When you sync Moon Reader to the cloud, these files update in your Dropbox. MoonSync reads them directly, so you don't need to create manual backups.

### Sync Efficiency

MoonSync only updates notes when something changes:
- New highlights added
- Reading progress changed

Unchanged books are skipped to keep syncs fast.

## Privacy & Security

- **Read-only access**: MoonSync only reads from your Dropbox folder. It never modifies your Moon Reader data.
- **Local processing**: All data stays on your machine. External APIs are only contacted for book metadata (Google Books, Open Library).
- **Caching**: API responses are cached locally to minimize external requests.

## Troubleshooting

### "No annotation files found"
- Ensure Moon Reader has cloud sync enabled (not just backup)
- Check that highlights exist and have synced to Dropbox
- Verify the path points to the folder containing `.Moon+` (usually `Dropbox/Apps/Books`)

### Progress not showing
- Progress requires a `.po` file for the book
- Open the book in Moon Reader and let it sync

### Covers/descriptions not loading
- Check your internet connection
- Some books (especially new releases) may not be in Google Books/Open Library
- Use "Fetch Book Cover" or "Fetch Book Metadata" to manually search for the correct edition

### Wrong book metadata
- Use "Fetch Book Metadata" command to search and select the correct book
- This sets `custom_metadata: true` to prevent future syncs from changing it

## Support

If you find this plugin useful, consider [buying me a coffee](https://ko-fi.com/titandrive)!

## License

MIT
