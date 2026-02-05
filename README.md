# MoonSync

Sync your reading highlights, notes, and progress from Moon+ Reader to Obsidian. MoonSync supports both automatic synchronization using Dropbox or via manual exports. 

<img src="BookScreenshot.png" alt="Book note example" width="420">

## How It Works
Whenever you sync a book to the cloud in Moon Reader, it saves this data to two cache files in Dropbox. These files contain all of your book's metadata including highlights, notes, reading progress and book information. MoonSync reads this data and syncs it to your Obsidian vault. 

When MoonSync detects a new book, it pulls metadata from Google Books and Open Library to create a note containing all of your highlights, notes, and book progress as well as book information (cover, genre, date published, etc). 

MoonSync will then keep track of that book and update the note as you make new highlights and your reading progress changes. 

**Data flow:** Moon Reader → Dropbox Cloud Sync → MoonSync → Obsidian

### What Gets Synced

- Book highlights with timestamps and colors
- Reading progress (percentage and current chapter)
- Book metadata (title, author, publisher, page count, genres, series)
- Book covers, descriptions, and ratings (fetched from Google Books/Open Library)

### Requirements

- [Moon Reader](https://play.google.com/store/apps/details?id=com.flyersoft.moonreader)
- [Dropbox Desktop App](https://www.dropbox.com/desktop) 
- [Obsidian](https://obsidian.md/) 
- [BRAT](https://github.com/TfTHacker/obsidian42-brat) 

## Installation
MoonSync can be installed either via the BRAT Plugin (recommended) or via a custom install:


### BRAT Installation
Using BRAT is the recommended, and easiest, way to install custom Obsidian plugins that are not available in the Obsidian Community Store.

1. Install BRAT via community plugins. 
2. Open BRAT and select "Add Beta Plugin"
3. Paste `https://github.com/titandrive/moonsync` into the text bar
4. Click "Add Plugin"
5. Configure MoonSync (see below)

BRAT will now automatically keep track of updates for you

### Custom Installation
1. Browse to MoonSync [Releases](https://github.com/titandrive/moonsync/releases)
2. Download the latest release
3. Extract the release and copy it to your obsidian vault: `.../MyVault/.obsidian/plugins/MoonSync`
4. Configure MoonSync (see below)

## How to Sync

### Configuring Automatic Sync
Once MoonSync is installed, you will need to configure it before it can complete its first sync. 
1. Open up Settings → Community Plugins → MoonSync
2. Enable MoonSync
3. Click on the settings Cog to open up MoonSync settings.
4. Under configuration, browse to your MoonSync folder within Dropbox on your computer. This is typically `.../Dropbox/Apps/Books/`
*Note: /Books will appear empty as the cache files MoonSync relies on are contained in a hidden folder (/Books/.Moon+)*
5. Press Sync

By default, MoonSync will now Sync your books anytime you open Obsidian. You can also trigger a manual sync at anytime via the ribbon menu shortcut or Command Palette (see below).

#### Typical Sync Workflow 
1. Read book and make highlights in Moon Reader
2. Once you are finished reading, sync your progress to the cloud. Depending on your app settings, you may need to trigger this manually. 
3. Trigger MoonSync by opening Obsidian or clicking the ribbon  button. 
4. Your highlights and reading progress should immediately become available. 

### Manual Book Sync
If you do not want to use automatic syncing, via Dropbox, MoonSync also supports manual exports. 

First, export your notes: 
1. While viewing a book in Moon Reader, open up the Bookmarks bar. You should see all of your existing notes and highlights 
2. Click the share button then "Share notes & highlights (TXT)"
3. Share the notes to Obsidian. 
*Note: It does not matter where the note is created. It does not need to be made in the /books directory.*
4. Choose a note in Obsidian to save it to. 

Once you have exported your notes, you can import it using the command palette:
1. Open the note that you just created.
2. While viewing the note, open the Command Palette (`Cmd/Ctrl + P`)
3. Choose `MoonSync: Import Note`
4. MoonSync will automatically create a new book note, find matching metadata, and update the index & base files. 

## Custom Books
Sometimes you may have books you wish to keep track of that you read outside of Moon Reader. MoonSync supports creating custom books that can be tracked in the same manner. 

To create a custom book, 
1. Open the Command Palette and select `MoonSync: Create Book Note`. 
2. Search for your book in the search prompt
3. Select your book

MoonSync will import all available metadata and create a new book note in `/Books`. You can then enter your favorite highlights and notes! 

If in the future, you begin reading that same book in Moon Reader, and make more highlights, MoonSync will intelligently update this note so you won't lose any of your past highlights. 

## Command Palette

MoonSync provides several commands accessible via the command palette (`Cmd/Ctrl + P`):

<img src="CommandPalette.png" alt="Command Palette" width="420">

### Sync Now
Synchronize all books from Moon Reader. Only updates notes when highlights or progress have changed.

### Import Note
Import highlights from a manual Moon Reader export. Useful for one-time imports or when Dropbox sync isn't available.

### Create Book Note
Create a new book note. The command opens up a search modal to find the book via Google Books. It then creates a new note for it. 

### Fetch Book Cover
Re-fetch the cover image for the current note. Useful if a cover is missing or you have a different edition you prefer. Covers can be selected via search or by importing from a url.

### Fetch Book Metadata
Replace all metadata for the current note by selecting from search results. Updates title, author, cover, description, publisher, page count, genres, series, and language. Also sets `custom_metadata: true` to prevent future syncs from overwriting your selection.

## Settings
MoonSync has a variety of settings to customize how the plugin works. Default settings should work for most readers but are available so you can tailor it to your preferences. 

### Configuration Tab
These settings configure how MoonSync works. 
#### Configuration
- **Moon Reader Dropbox Path** - path to your Moon Reader data. This is typically `.../Dropbox/Apps/Books`. The plugin automatically looks for the hidden `.Moon+/Cache` folder inside.
- **Output Folder** - Where your booknotes will be stored. Default: `/Books`

#### Sync Options
- **Sync Now** - Trigger manual sync
- **Sync on Startup** - Automatically sync when Obsidian starts
- **Show Ribbon Icon** - Show sync button in the ribbon menu
- **Track Books Without Highlights** - Track books that do not currently have highlights. If enabled, MoonSync will create notes for books you are currently reading but have not created highlights in. Useful if you want to track reading progress but you don't make a lot of higlights.  

### Content Tab
These settings configure what information is shown in your book notes. 

#### Note Content 
- **Show Description** - Include book description (from Google Books/Open Library)
- **Show Reading Progress** - Include progress percentage, current chapter, and date last read
- **Show Highlight Colors** - Use different callout styles based on highlight color
- **Show Book Covers** - Include book covers 

Note: Enabling/disabling these options will show/hide the feature in real time. 

### Index & Base Tab
MoonSync automatically generates an index and base note to give you different way to visualize your data. These settings allow you to customize your index and base. 

#### Library Index

- **Generate Library Index** - Control whether MoonSync will generate an index. MoonSync, by default, will generate an index upon first sync. Disabling this will delete the index file.  
- **Index Note Title** - By default, the index note is titled `1. Index Note` so that it stays at the top of the list. You can change the name here. 
- **Show Cover Collage** - Show or hide the cover collage 
- **Cover Collage Limit** - Control how many covers show in the collage. Setting it to `0` will show covers for all books in the index. 
- **Cover Collage Sort** - Controls whether the cover collage is sorted alphabetically or chronologically. 

#### Obsidian Bases
- **Generate Base File** - Control whether MoonSync will generate a Base file. MoonSync, by default, will generate a base upon first sync. Disabling this will delete the base file. 
- **Base File Name** - By default, the base note is titled `2. Base` so that it stays at the top of the list. You can change the name here. 


### About the Index and Base Notes

#### Library Index

When enabled, MoonSync generates an index file titled `1. Library Index.md` that shows the following: 

- Visual grid of book covers. Clicking on a cover will take you to the associated note. 
- Summary statistics: total books, highlights, notes, average progress
- List of all books with author, progress, and highlight counts

The index updates automatically after each sync.

<img src="IndexScreenshot.png" alt="Library index example" width="420">

#### Base Note
The base note provides a database-like view of your book data. 

The base note provides a Gallery view that shows each cover in your library. Clicking on a cover will take you to the associated link. 

It also provides a library view that shows a breakdown of the following statistics per book:
- Title (file name)
- Author
- Highlights count
- Progress percentage
- Notes count
- Manual note indicator
- Last read date
- Last synced date
- Genres
- Page count
- Publisher
- Published date
- Language

<img src="BaseScreenshot2.png" alt="Base Library View" width="420">

<img src="BaseScreenshot.png" alt="Base Gallery View" width="420">

## Privacy & Security

- **Read-only access**: MoonSync only reads from your Dropbox folder. It never modifies your Moon Reader data.
- **Local processing**: All data stays on your machine. External APIs are only contacted for book metadata (Google Books, Open Library).
- **Caching**: API responses are cached locally to minimize external requests.

## Troubleshooting

### "No annotation files found"
- Ensure Moon Reader has cloud sync enabled
- Check that highlights exist and have synced to Dropbox
- Depending on your device, and settings, you may have to trigger a manual sync in Moon Reader (Sync to Cloud)
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

## AI Disclosure
This plugin was made with the assistance of Claude Code. 

## License

MIT
