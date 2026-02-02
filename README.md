# MoonSync

Sync your reading highlights and progress from Moon Reader+ to Obsidian.

## How It Works

MoonSync is a **read-only** sync plugin. It reads your Moon Reader backup data from Dropbox and creates markdown notes in your Obsidian vault. It never modifies your Moon Reader data.

**Data flow:** Moon Reader → Dropbox → MoonSync → Obsidian

### What Gets Synced

- Book metadata (title, author, description, category)
- All highlights with timestamps and colors
- Reading progress and statistics
- Book covers (fetched from Open Library/Google Books)

### Requirements

- Moon Reader+ with Dropbox sync enabled
- Backup files synced to `Dropbox/Apps/Books/.Moon+/Backup/`

## Installation

1. Copy the `moonsync` folder to your vault's `.obsidian/plugins/` directory
2. Enable the plugin in Obsidian Settings → Community Plugins
3. Configure the Dropbox path in plugin settings

## Settings

### Sync Now
Manually trigger a sync. Creates or updates notes for all books with highlights.

### Sync on Startup
Automatically sync when Obsidian starts. Useful for keeping notes up to date.

### Show Ribbon Icon
Show sync button in ribbon menu. Click the book icon to trigger a sync.

### Moon Reader Dropbox Path
Path to your Books folder in Dropbox (e.g., `/Users/you/Dropbox/Apps/Books`). The plugin automatically looks for the hidden `.Moon+/Backup` folder inside.

**Tip:** On macOS, press `Cmd+Shift+.` in the folder picker to show hidden folders.

### Output Folder
Vault folder where book notes are created. Defaults to `Books`.

### Show Description
Include the book description in generated notes. Pulled from Moon Reader's metadata.

### Show Reading Progress
Include a reading progress section with:
- Progress percentage
- Time spent reading
- Words read

**Note:** Progress data depends on Moon Reader's sync and may not always be accurate.

### Show Highlight Colors
Use different callout styles based on highlight color:
- Yellow → `[!quote]`
- Blue → `[!info]`
- Red → `[!warning]`
- Green → `[!tip]`

When disabled, all highlights appear as standard quotes.

### Fetch Book Covers
Download book covers from Open Library or Google Books. Covers are saved in a `covers` subfolder within your output folder.

## Output Format

Each book creates a markdown file with:

```markdown
---
title: "Book Title"
author: "Author Name"
category: "Fiction"
progress: 45.5%
reading_time: "2h 34m"
last_synced: 2026-02-02
moon_reader_path: "/sdcard/Books/book.epub"
highlights_count: 12
cover: "covers/Book Title.jpg"
---

# Book Title
**Author:** Author Name

![[covers/Book Title.jpg]]

## Reading Progress
- **Progress:** 45.5%
- **Time Spent:** 2h 34m
- **Words Read:** 12,450

## Description
Book description from metadata...

## Highlights

> [!quote] Chapter 3 • Jan 15, 2026
> "Highlighted text from the book..."

> [!info] Chapter 4 • Jan 16, 2026
> "Blue highlighted text..."
>
> **Note:** Your annotation appears here
```

## Privacy & Security

- **Read-only access**: MoonSync only reads from your Dropbox folder. It never writes to or modifies your Moon Reader data.
- **Local processing**: All data stays on your machine. No external servers are contacted except for fetching book covers (Open Library/Google Books).
- **No credentials stored**: The plugin accesses Dropbox through your local filesystem, not through any API.

## Troubleshooting

### "No .mrpro backup files found"
- Ensure Moon Reader is configured to sync to Dropbox
- Check that the path points to the folder containing `.Moon+` (usually `Dropbox/Apps/Books`)
- Force a backup in Moon Reader: Settings → Backup & Restore → Backup to Cloud

### "Could not find mrbooks.db in backup"
- Your backup may be corrupted. Try creating a fresh backup in Moon Reader.

### Covers not loading
- Check your internet connection
- Some books may not have covers available in Open Library/Google Books
- Covers are only fetched once. Delete the cover file to re-fetch.

## License

MIT
