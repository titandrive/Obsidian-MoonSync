# MoonSync

Sync your reading highlights and progress from Moon Reader+ to Obsidian.

## How It Works

MoonSync uses **real-time sync** by reading Moon Reader's cache files directly from Dropbox. When you make a highlight or read a book in Moon Reader and it syncs to the cloud, those changes are immediately available to MoonSync.

**Data flow:** Moon Reader → Dropbox Cloud Sync → MoonSync → Obsidian

### What Gets Synced

- Book highlights with timestamps and colors
- Reading progress (percentage and current chapter)
- Book metadata (title, author)
- Book covers, descriptions, and ratings (fetched from Google Books/Open Library)

### Requirements

- Moon Reader+ with Dropbox cloud sync enabled
- Sync folder at `Dropbox/Apps/Books/.Moon+/Cache/`

## Installation

1. Copy the `moonsync` folder to your vault's `.obsidian/plugins/` directory
2. Enable the plugin in Obsidian Settings → Community Plugins
3. Configure the Dropbox path in plugin settings

## Settings

### Moon Reader Dropbox Path
Path to your Books folder in Dropbox (e.g., `/Users/you/Dropbox/Apps/Books`). The plugin automatically looks for the hidden `.Moon+/Cache` folder inside.

**Tip:** On macOS, press `Cmd+Shift+.` in the folder picker to show hidden folders.

### Output Folder
Vault folder where book notes are created. Defaults to `Books`.

### Sync Options
- **Sync Now** - Manually trigger a sync
- **Sync on Startup** - Automatically sync when Obsidian starts
- **Show Ribbon Icon** - Show sync button in the ribbon menu

### Note Content Options
- **Show Description** - Include book description (from Google Books/Open Library)
- **Show Ratings** - Include Google Books rating
- **Show Reading Progress** - Include progress percentage and current chapter
- **Show Highlight Colors** - Use different callout styles based on highlight color
- **Fetch Book Covers** - Download covers from Open Library/Google Books

### Highlight Colors
When "Show Highlight Colors" is enabled:
- Yellow → `[!quote]`
- Blue → `[!info]`
- Red → `[!warning]`
- Green → `[!tip]`

## Output Format

Each book creates a markdown file with:

```markdown
---
title: "Book Title"
author: "Author Name"
progress: 41.1%
current_chapter: 25
last_synced: 2026-02-02
highlights_count: 12
rating: 4.2
cover: "covers/Book Title.jpg"
---

# Book Title
**Author:** Author Name
**Rating:** ⭐ 4.2/5 (1,234 ratings)

![[covers/Book Title.jpg]]

## Reading Progress
- **Progress:** 41.1%
- **Chapter:** 25

## Description
Book description from Google Books...

## Highlights

> [!quote] Chapter 3 • Jan 15, 2026
> "Highlighted text from the book..."

> [!info] Chapter 4 • Jan 16, 2026
> "Blue highlighted text..."
>
> **Note:** Your annotation appears here
```

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
- Covers are cached - delete the cover file to re-fetch

## Support

If you find this plugin useful, consider [buying me a coffee](https://ko-fi.com/titandrive)!

## License

MIT
