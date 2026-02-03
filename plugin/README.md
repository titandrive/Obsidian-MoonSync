# MoonSync

Sync your reading highlights and progress from Moon+ Reader to Obsidian.

## How It Works

MoonSync is a **read-only** sync plugin. It reads your Moon+ Reader data from Dropbox and creates markdown notes in your Obsidian vault. It never modifies your Moon+ Reader data.

**Data flow:** Moon+ Reader → Dropbox → MoonSync → Obsidian

### What Gets Synced

- Book metadata (title, author, description, category)
- All highlights with timestamps and colors
- Your personal notes/annotations on highlights
- Reading progress (percentage and current chapter)
- Book covers and ratings (from Open Library/Google Books)
- Library index with summary statistics

### Requirements

- Moon+ Reader with Dropbox sync enabled
- Real-time sync enabled in Moon+ Reader (syncs to `Dropbox/Apps/Books/.Moon+/Cache/`)

## Installation

### Via BRAT (Recommended)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. Open BRAT settings and click "Add Beta Plugin"
3. Enter: `titandrive/moonsync`
4. Click "Add Plugin" and enable MoonSync in Community Plugins

### From Release

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/titandrive/moonsync/releases)
2. Create folder: `.obsidian/plugins/moonsync/` in your vault
3. Place both files in the folder
4. Enable MoonSync in Obsidian Settings → Community Plugins

### Manual Build

1. Clone the repository
2. `cd plugin && npm install && npm run build`
3. Copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/moonsync/`

## Settings

### Configuration

**Moon+ Reader Dropbox Path**
Path to your Books folder in Dropbox (e.g., `/Users/you/Dropbox/Apps/Books`). The plugin automatically looks for the hidden `.Moon+/Cache` folder inside.

**Tip:** On macOS, press `Cmd+Shift+.` in the folder picker to show hidden folders.

**Output Folder**
Vault folder where book notes are created. Defaults to `Books`.

### Sync

**Sync Now** - Manually trigger a sync. Creates or updates notes for all books with highlights.

**Sync on Startup** - Automatically sync when Obsidian starts.

**Show Ribbon Icon** - Show sync button in ribbon menu.

On your first sync, a summary modal shows your import stats (books, notes, highlights) with a link to MoonSync settings.

### Note Content

**Show Description** - Include book description (from Google Books/Open Library).

**Show Ratings** - Include Google Books rating and review count.

**Show Reading Progress** - Include reading progress section with percentage and current chapter.

**Show Highlight Colors** - Use different callout styles based on highlight color:
- Yellow → `[!quote]`
- Blue → `[!info]`
- Red → `[!warning]`
- Green → `[!tip]`

**Fetch Book Covers** - Download book covers from Open Library/Google Books. Saved in a `covers` subfolder.

**Show Notes** - Include your personal notes/annotations below highlights.

### Index

**Generate Library Index** - Create an index note with summary stats, cover collage, and links to all books.

**Index Note Title** - Customize the name of the library index note. Defaults to `1. Library Index`.

**Show Cover Collage** - Display clickable book covers at the top of the index. Click any cover to open that book's note.

**Cover Collage Limit** - Maximum number of covers to show (0 = show all).

**Cover Collage Sort** - Sort covers alphabetically or by most recently read.

## Output Format

### Book Notes

Each book creates a markdown file:

```markdown
---
title: "Book Title"
author: "Author Name"
progress: 45.5%
current_chapter: 12
reading_time: "2h 34m"
last_synced: 2026-02-02
highlights_count: 12
rating: 4.2
ratings_count: 1234
cover: "covers/Book Title.jpg"
---

# Book Title
**Author:** Author Name
**Rating:** ⭐ 4.2/5 (1,234 ratings)

![[covers/Book Title.jpg|200]]

## Reading Progress
- **Progress:** 45.5%
- **Chapter:** 12

## Description
Book description from Google Books...

## Highlights

> [!quote] Chapter 3 • Jan 15, 2026
> "Highlighted text from the book..."

> [!info] Chapter 4 • Jan 16, 2026
> "Blue highlighted text..."
>
> ---
> **Note:** Your personal annotation appears here
```

### Library Index

When enabled, creates `1. Library Index.md` with a clickable cover collage (uniform height, click to open book) and summary:

```markdown
# 1. Library Index

<a class="internal-link" href="Book Title"><img src="covers/Book Title.jpg" height="120"></a> <a class="internal-link" href="Another Book"><img src="covers/Another Book.jpg" height="120"></a>

## Summary
- **Books:** 5
- **Highlights:** 42
- **Notes:** 8
- **Average Progress:** 65.2%

## Books
- [[Book Title|Book Title]] by Author (75%) — 12 highlights, 3 notes
- [[Another Book|Another Book]] by Writer (30%) — 8 highlights
```

## Privacy & Security

- **Read-only access**: MoonSync only reads from your Dropbox folder. It never writes to or modifies your Moon+ Reader data.
- **Local processing**: All data stays on your machine. No external servers are contacted except for fetching book covers and metadata (Open Library/Google Books APIs).
- **No credentials stored**: The plugin accesses Dropbox through your local filesystem, not through any API.

## Troubleshooting

### "No annotation files found"
- Ensure Moon+ Reader is configured to sync to Dropbox
- Check that the path points to the folder containing `.Moon+` (usually `Dropbox/Apps/Books`)
- Make sure real-time sync is enabled in Moon+ Reader settings
- Add a highlight to a book and sync in Moon+ Reader

### Covers not loading
- Check your internet connection
- Some books may not have covers available in Open Library/Google Books
- Covers are only fetched once. Delete the cover file to re-fetch.

### Wrong book matched for cover/description
- The plugin searches by title and author. Uncommon books may get wrong matches.
- Delete the cover and the `.moonsync-cache.json` file to re-fetch.

## License

MIT
