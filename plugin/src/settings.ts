import { App, PluginSettingTab, Setting, TextComponent, normalizePath, Notice, requestUrl } from "obsidian";
import type MoonSyncPlugin from "../main";
import { existsSync } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { platform } from "os";

// Electron types for folder picker
declare global {
	interface Window {
		electron?: {
			remote?: {
				dialog: {
					showOpenDialog: (options: {
						properties: string[];
						defaultPath?: string;
					}) => Promise<{ canceled: boolean; filePaths: string[] }>;
				};
			};
		};
	}
}

export class MoonSyncSettingTab extends PluginSettingTab {
	plugin: MoonSyncPlugin;
	private activeTab: string = "configuration";

	constructor(app: App, plugin: MoonSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Create tab navigation
		const tabNav = containerEl.createDiv({ cls: "moonsync-tab-nav" });

		const tabs = [
			{ id: "configuration", name: "Configuration" },
			{ id: "content", name: "Content" },
			{ id: "index-base", name: "Index & base" },
			{ id: "integrations", name: "Hardcover" },
			{ id: "about", name: "About" }
		];

		tabs.forEach(tab => {
			const tabButton = tabNav.createEl("button", {
				text: tab.name,
				cls: this.activeTab === tab.id ? "moonsync-tab-button moonsync-tab-active" : "moonsync-tab-button"
			});
			tabButton.addEventListener("click", () => {
				this.activeTab = tab.id;
				this.display();
			});
		});

		// Create tab content containers
		const configTab = containerEl.createDiv({ cls: this.activeTab === "configuration" ? "moonsync-tab-content moonsync-tab-visible" : "moonsync-tab-content moonsync-tab-hidden" });
		const contentTab = containerEl.createDiv({ cls: this.activeTab === "content" ? "moonsync-tab-content moonsync-tab-visible" : "moonsync-tab-content moonsync-tab-hidden" });
		const indexBaseTab = containerEl.createDiv({ cls: this.activeTab === "index-base" ? "moonsync-tab-content moonsync-tab-visible" : "moonsync-tab-content moonsync-tab-hidden" });
		const integrationsTab = containerEl.createDiv({ cls: this.activeTab === "integrations" ? "moonsync-tab-content moonsync-tab-visible" : "moonsync-tab-content moonsync-tab-hidden" });
		const aboutTab = containerEl.createDiv({ cls: this.activeTab === "about" ? "moonsync-tab-content moonsync-tab-visible" : "moonsync-tab-content moonsync-tab-hidden" });

		this.displayConfigurationTab(configTab);
		this.displayContentTab(contentTab);
		this.displayIndexBaseTab(indexBaseTab);
		this.displayIntegrationsTab(integrationsTab);
		this.displayAboutTab(aboutTab);
	}

	private displayConfigurationTab(container: HTMLElement): void {
		new Setting(container).setName("Configuration").setDesc("Set up your reading app sync locations and note output folder.").setHeading();

		// --- Moon Reader ---
		new Setting(container).setName("Moon Reader").setHeading();

		new Setting(container)
			.setName("Enable Moon Reader sync")
			.setDesc("Sync highlights and progress from Moon Reader")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.moonReaderEnabled)
					.onChange(async (value) => {
						this.plugin.settings.moonReaderEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.moonReaderEnabled) {
			let textComponent: TextComponent;
			let validationEl: HTMLElement;

			const pathSetting = new Setting(container)
				.setName("Moon Reader sync path")
				.setDesc(
					"Path to the folder containing your Moon Reader data. The .Moon+ folder will be detected automatically."
				)
				.addText((text) => {
					textComponent = text;
					text
						.setPlaceholder("/path/to/sync/folder")
						.setValue(this.plugin.settings.syncPath)
						.onChange(async (value) => {
							this.plugin.settings.syncPath = value;
							await this.plugin.saveSettings();
							this.validateSyncPath(value, validationEl);
						});
				})
				.addButton((button) =>
					button.setButtonText("Browse").onClick(async () => {
						const folder = await this.openFolderPicker("Select Moon Reader sync folder");
						if (folder) {
							this.plugin.settings.syncPath = folder;
							textComponent.setValue(folder);
							await this.plugin.saveSettings();
							this.validateSyncPath(folder, validationEl);
						}
					})
				);

			validationEl = pathSetting.descEl.createDiv({ cls: "moonsync-path-validation" });
			if (this.plugin.settings.syncPath) {
				this.validateSyncPath(this.plugin.settings.syncPath, validationEl);
			}
		}

		// --- Readest ---
		new Setting(container).setName("Readest").setHeading();

		new Setting(container)
			.setName("Enable Readest sync")
			.setDesc("Sync highlights and progress from Readest")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.readestEnabled)
					.onChange(async (value) => {
						this.plugin.settings.readestEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.readestEnabled) {
			let readestTextComponent: TextComponent;
			let readestValidationEl: HTMLElement;

			const readestPathSetting = new Setting(container)
				.setName("Readest sync path")
				.setDesc(
					"Path to the folder where Readest stores its book data (contains subfolders, one per book)."
				)
				.addText((text) => {
					readestTextComponent = text;
					text
						.setPlaceholder("/path/to/readest/data")
						.setValue(this.plugin.settings.readestSyncPath)
						.onChange(async (value) => {
							this.plugin.settings.readestSyncPath = value;
							await this.plugin.saveSettings();
							this.validateReadestPath(value, readestValidationEl);
						});
				})
				.addButton((button) =>
					button.setButtonText("Browse").onClick(async () => {
						const folder = await this.openFolderPicker("Select Readest sync folder");
						if (folder) {
							this.plugin.settings.readestSyncPath = folder;
							readestTextComponent.setValue(folder);
							await this.plugin.saveSettings();
							this.validateReadestPath(folder, readestValidationEl);
						}
					})
				);

			readestValidationEl = readestPathSetting.descEl.createDiv({ cls: "moonsync-path-validation" });
			if (this.plugin.settings.readestSyncPath) {
				this.validateReadestPath(this.plugin.settings.readestSyncPath, readestValidationEl);
			}
		}

		// --- Output ---
		new Setting(container).setName("Output").setHeading();

		new Setting(container)
			.setName("Output folder")
			.setDesc("Top-level folder in your vault where book notes will be created. When both sources are enabled, notes go into MoonReader/ and Readest/ subfolders automatically.")
			.addText((text) =>
				text
					.setPlaceholder("Books")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value || "Books";
						await this.plugin.saveSettings();
					})
			);

		new Setting(container)
			.setName("Organize manual books")
			.setDesc("Move notes with manual_note: true in their frontmatter into a Manual Notes/ subfolder. Applies immediately when enabled.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.organizeManualBooks)
					.onChange(async (value) => {
						this.plugin.settings.organizeManualBooks = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.organizeManualBooks();
						}
					})
			);

		new Setting(container).setName("Sync").setDesc("Control when and how MoonSync syncs your highlights.").setHeading();

		new Setting(container)
			.setName("Sync now")
			.setDesc("Manually trigger a sync from Moon Reader")
			.addButton((button) =>
				button.setButtonText("Sync").onClick(async () => {
					await this.plugin.runSync();
				})
			);

		new Setting(container)
			.setName("Sync on startup")
			.setDesc("Automatically sync when Obsidian starts")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(container)
			.setName("Show ribbon icon")
			.setDesc("Show sync button in ribbon menu")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRibbonIcon)
					.onChange(async (value) => {
						this.plugin.settings.showRibbonIcon = value;
						await this.plugin.saveSettings();
						this.plugin.updateRibbonIcon();
					})
			);

		new Setting(container)
			.setName("Track books without highlights")
			.setDesc("Track all books in your Moon Reader library, not just ones with highlights")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.trackBooksWithoutHighlights)
					.onChange(async (value) => {
						this.plugin.settings.trackBooksWithoutHighlights = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(container)
			.setName("Automatic sync")
			.setDesc("Automatically sync when Moon Reader cache files are updated. Best suited when Obsidian is hosted on an always-on server.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.watchForChanges)
					.onChange(async (value) => {
						this.plugin.settings.watchForChanges = value;
						await this.plugin.saveSettings();
						if (value) {
							this.plugin.startFileWatcher();
						} else {
							this.plugin.stopFileWatcher();
						}
					})
			);

		new Setting(container).setName("Maintenance").setHeading();

		new Setting(container)
			.setName("Force resync all books")
			.setDesc("Clears the metadata cache and resyncs all books with the latest data")
			.addButton((button) =>
				button.setButtonText("Resync").onClick(async () => {
					const outputPath = normalizePath(this.plugin.settings.outputFolder);
					const cachePath = normalizePath(`${outputPath}/.moonsync-cache.json`);
					try {
						if (await this.app.vault.adapter.exists(cachePath)) {
							await this.app.vault.adapter.remove(cachePath);
						}
						await this.plugin.runSync();
					} catch {
						new Notice("MoonSync: Failed to resync");
					}
				})
			);
	}

	private displayContentTab(container: HTMLElement): void {
		new Setting(container).setName("Note content").setDesc("Control what data is included in your book notes.").setHeading();

		new Setting(container)
			.setName("Show description")
			.setDesc("Include book description in generated notes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showDescription)
					.onChange(async (value) => {
						this.plugin.settings.showDescription = value;
						await this.plugin.saveSettings();
						this.plugin.updateContentVisibility();
					})
			);

		new Setting(container)
			.setName("Show reading progress")
			.setDesc("Include reading progress section. Note: Progress data may not always be accurate depending on Moon Reader sync.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showReadingProgress)
					.onChange(async (value) => {
						this.plugin.settings.showReadingProgress = value;
						await this.plugin.saveSettings();
						this.plugin.updateContentVisibility();
					})
			);

		new Setting(container)
			.setName("Show highlight colors")
			.setDesc("Use different callout styles based on highlight color. When off, all highlights appear as quotes.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHighlightColors)
					.onChange(async (value) => {
						this.plugin.settings.showHighlightColors = value;
						await this.plugin.saveSettings();
						this.plugin.updateContentVisibility();
					})
			);

		new Setting(container)
			.setName("Show book covers")
			.setDesc("Display book covers in notes. Covers are always downloaded to the 'covers' subfolder.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showCovers)
					.onChange(async (value) => {
						this.plugin.settings.showCovers = value;
						await this.plugin.saveSettings();
						this.plugin.updateContentVisibility();
					})
			);

		new Setting(container).setName("Moon Reader highlight order").setDesc("Control the order of highlights in your book notes.").setHeading();

		new Setting(container)
			.setName("Sort order")
			.setDesc("How Moon Reader highlights and notes are sorted. Change takes effect on next sync or when you regenerate.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("position", "Position in book (first to last)")
					.addOption("position-reverse", "Position in book (last to first)")
					.addOption("date", "Date added (oldest first)")
					.addOption("date-reverse", "Date added (newest first)")
					.setValue(this.plugin.settings.highlightSort)
					.onChange(async (value: "position" | "position-reverse" | "date" | "date-reverse") => {
						this.plugin.settings.highlightSort = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(container)
			.setName("Regenerate all notes")
			.setDesc("Force all book notes to be rewritten with the current settings")
			.addButton((button) =>
				button
					.setButtonText("Regenerate")
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Regenerating...");
						await this.plugin.forceResync();
						button.setButtonText("Done!");
						setTimeout(() => {
							button.setDisabled(false);
							button.setButtonText("Regenerate");
						}, 2000);
					})
			);
	}

	private displayIndexBaseTab(container: HTMLElement): void {
		new Setting(container).setName("Library index").setDesc("Configure the automatically generated index of all your books.").setHeading();

		new Setting(container)
			.setName("Generate library index")
			.setDesc("Create an index note with summary stats and links to all books. Turning this off will delete the existing index note.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showIndex)
					.onChange(async (value) => {
						this.plugin.settings.showIndex = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.refreshIndex();
						} else {
							await this.plugin.deleteIndex();
						}
					})
			);

		new Setting(container)
			.setName("Index note title")
			.setDesc("Name of the library index note. Changing this will rename the existing file.")
			.addText((text) =>
				text
					.setPlaceholder("1. Library Index")
					.setValue(this.plugin.settings.indexNoteTitle)
					.onChange(async (value) => {
						const oldName = this.plugin.settings.indexNoteTitle;
						const newName = value || "1. Library Index";
						if (oldName !== newName) {
							if (this.plugin.settings.showIndex) {
								await this.plugin.renameIndex(oldName, newName);
							}
							this.plugin.settings.indexNoteTitle = newName;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(container)
			.setName("Show cover collage")
			.setDesc("Display book covers at the top of the library index")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showCoverCollage)
					.onChange(async (value) => {
						this.plugin.settings.showCoverCollage = value;
						await this.plugin.saveSettings();
						await this.plugin.refreshIndex();
					})
			);

		new Setting(container)
			.setName("Cover collage limit")
			.setDesc("Maximum number of covers to show (0 = show all)")
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.coverCollageLimit))
					.onChange(async (value) => {
						const num = parseInt(value) || 0;
						this.plugin.settings.coverCollageLimit = Math.max(0, num);
						await this.plugin.saveSettings();
						await this.plugin.refreshIndex();
					})
			);

		new Setting(container)
			.setName("Cover collage sort")
			.setDesc("How to sort covers in the collage")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("alpha", "Alphabetical")
					.addOption("recent", "Most recent")
					.setValue(this.plugin.settings.coverCollageSort)
					.onChange(async (value: "alpha" | "recent") => {
						this.plugin.settings.coverCollageSort = value;
						await this.plugin.saveSettings();
						await this.plugin.refreshIndex();
					})
			);

		new Setting(container).setName("Obsidian Bases").setDesc("Automatically generate a database configuration file for the Obsidian Bases plugin.").setHeading();

		new Setting(container)
			.setName("Generate base file")
			.setDesc("Automatically create and update the .base file for the Obsidian Bases plugin. Turning this off will delete the existing base file.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.generateBaseFile)
					.onChange(async (value) => {
						this.plugin.settings.generateBaseFile = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.refreshBase();
						} else {
							await this.plugin.deleteBase();
						}
					})
			);

		new Setting(container)
			.setName("Base file name")
			.setDesc("Name of the .base file (without extension). Changing this will rename the existing file.")
			.addText((text) =>
				text
					.setPlaceholder("2. Books Database")
					.setValue(this.plugin.settings.baseFileName)
					.onChange(async (value) => {
						const oldName = this.plugin.settings.baseFileName;
						const newName = value || "2. Books Database";
						if (oldName !== newName) {
							if (this.plugin.settings.generateBaseFile) {
								await this.plugin.renameBase(oldName, newName);
							}
							this.plugin.settings.baseFileName = newName;
							await this.plugin.saveSettings();
						}
					})
			);
	}

	private displayIntegrationsTab(container: HTMLElement): void {
		const hardcoverHeading = new Setting(container)
			.setName("Hardcover.app")
			.setHeading();
		const hardcoverDesc = hardcoverHeading.descEl;
		hardcoverDesc.appendText("Sync your reading status and progress to Hardcover. ");
		hardcoverDesc.createEl("a", {
			text: "Get your API key",
			href: "https://docs.hardcover.app/api/getting-started/",
		});

		new Setting(container)
			.setName("Enable Hardcover sync")
			.setDesc("Update reading status on Hardcover after each sync")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hardcoverEnabled)
					.onChange(async (value) => {
						this.plugin.settings.hardcoverEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.hardcoverEnabled) {
			let tokenValidationEl: HTMLElement;

			const tokenSetting = new Setting(container)
				.setName("API token")
				.setDesc("Your Hardcover bearer token from hardcover.app/account/api")
				.addText((text) =>
					text
						.setPlaceholder("Enter your API token")
						.setValue(this.plugin.settings.hardcoverToken)
						.onChange(async (value) => {
							this.plugin.settings.hardcoverToken = value.trim();
							await this.plugin.saveSettings();
						})
				);

			tokenValidationEl = tokenSetting.descEl.createDiv({
				cls: "moonsync-path-validation",
			});

			new Setting(container)
				.setName("Test connection")
				.setDesc("Verify your API token is working")
				.addButton((button) =>
					button.setButtonText("Test").onClick(async () => {
						if (!this.plugin.settings.hardcoverToken) {
							tokenValidationEl.empty();
							tokenValidationEl.createSpan({
								text: "Please enter a token first",
								attr: { style: "color: var(--text-warning); font-size: 0.85em; margin-top: 0.5em; display: block;" },
							});
							return;
						}
						button.setDisabled(true);
						button.setButtonText("Testing...");

						const { validateHardcoverToken } = await import("./hardcover");
						const valid = await validateHardcoverToken(this.plugin.settings.hardcoverToken);

						tokenValidationEl.empty();
						if (valid) {
							tokenValidationEl.createSpan({
								text: "✓ Connected to Hardcover",
								attr: { style: "color: var(--text-success); font-size: 0.85em; margin-top: 0.5em; display: block;" },
							});
						} else {
							tokenValidationEl.createSpan({
								text: "✗ Connection failed. Check your token.",
								attr: { style: "color: var(--text-error); font-size: 0.85em; margin-top: 0.5em; display: block;" },
							});
						}

						button.setDisabled(false);
						button.setButtonText("Test");
					})
				);

			new Setting(container)
				.setName("Sync reading progress")
				.setDesc("Update reading status and progress on Hardcover after each sync. Disable to use Hardcover only for metadata (covers, descriptions, etc.).")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.hardcoverSyncProgress)
						.onChange(async (value) => {
							this.plugin.settings.hardcoverSyncProgress = value;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (this.plugin.settings.hardcoverSyncProgress) {
				new Setting(container)
					.setDesc("0% → Want to Read. 1–98% → Currently Reading. 99%+ → Read. No progress data → skipped.");
			}

			new Setting(container)
				.setName("Sync highlights & notes")
				.setDesc("Send highlights and notes to your Hardcover reading journal. New highlights are synced on each run; existing ones are only sent once.")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.hardcoverSyncHighlights)
						.onChange(async (value) => {
							this.plugin.settings.hardcoverSyncHighlights = value;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (this.plugin.settings.hardcoverSyncHighlights) {
				new Setting(container)
					.setName("Highlight privacy")
					.setDesc("Who can see synced highlights on Hardcover")
					.addDropdown((dropdown) =>
						dropdown
							.addOption("1", "Public")
							.addOption("2", "Followers")
							.addOption("3", "Private")
							.setValue(String(this.plugin.settings.hardcoverHighlightsPrivacy))
							.onChange(async (value) => {
								this.plugin.settings.hardcoverHighlightsPrivacy = parseInt(value) as 1 | 2 | 3;
								await this.plugin.saveSettings();
							})
					);
			}
		}
	}

	private displayAboutTab(container: HTMLElement): void {
		new Setting(container).setName("About").setHeading();

		new Setting(container)
			.setName("MoonSync")
			.setDesc("Sync your Moon Reader highlights, notes, and progress to Obsidian")
			.addButton((button) =>
				button.setButtonText("GitHub").onClick(() => {
					window.open("https://github.com/titandrive/Obsidian-MoonSync");
				})
			);

		new Setting(container).setName("Support").setHeading();

		new Setting(container)
			.setName("Buy me a coffee")
			.setDesc("If you find this plugin useful, consider supporting its development!")
			.addButton((button) =>
				button.setButtonText("Ko-fi").onClick(() => {
					window.open("https://ko-fi.com/titandrive");
				})
			);

		new Setting(container).setName(`Version: ${this.plugin.manifest.version}`).setHeading();

		const releaseNotesSetting = new Setting(container)
			.setName("What's new")
			.setDesc("Loading...");
		this.fetchChangelog(releaseNotesSetting);
	}

	private async fetchChangelog(setting: Setting): Promise<void> {
		try {
			const response = await requestUrl({
				url: `https://api.github.com/repos/titandrive/Obsidian-MoonSync/releases/tags/${this.plugin.manifest.version}`,
				headers: { "Accept": "application/vnd.github.v3+json" },
			});
			const release = response.json;

			if (release.body) {
				const lines = release.body.split("\n")
					.filter((line: string) => line.startsWith("- "))
					.map((line: string) => line
						.replace(/^- /, "")
						.replace(/\*\*/g, "")
						.replace(/`/g, "")
					);

				const descEl = setting.descEl;
				descEl.empty();
				const ul = descEl.createEl("ul", { attr: { style: "margin: 0; padding-left: 1.5em;" } });
				for (const line of lines) {
					ul.createEl("li", { text: line });
				}
			} else {
				setting.setDesc("No release notes available");
			}
		} catch {
			setting.setDesc("Could not load release notes");
		}
	}

	private validateSyncPath(path: string, validationEl: HTMLElement): void {
		validationEl.empty();

		if (!path) {
			return;
		}

		const cachePath = join(path, ".Moon+", "Cache");

		if (existsSync(cachePath)) {
			validationEl.createSpan({
				text: "✓ Moon Reader sync folder found",
				attr: { style: "color: var(--text-success); font-size: 0.85em; margin-top: 0.5em; display: block;" }
			});
		} else {
			validationEl.createSpan({
				text: "⚠ .Moon+/Cache folder not found at this path",
				attr: { style: "color: var(--text-warning); font-size: 0.85em; margin-top: 0.5em; display: block;" }
			});
		}
	}

	private validateReadestPath(path: string, validationEl: HTMLElement): void {
		validationEl.empty();

		if (!path) {
			return;
		}

		if (!existsSync(path)) {
			validationEl.createSpan({
				text: "⚠ Folder not found",
				attr: { style: "color: var(--text-warning); font-size: 0.85em; margin-top: 0.5em; display: block;" }
			});
			return;
		}

		const { readdirSync, statSync } = require("fs");

		// Readest stores books under <path>/books/ — check both the path itself and the books subdir
		const pathsToCheck = [path, join(path, "books")];
		const hasBookFolder = pathsToCheck.some(dir => {
			try {
				return readdirSync(dir).some((entry: string) => {
					try {
						return statSync(join(dir, entry)).isDirectory() &&
							existsSync(join(dir, entry, "config.json"));
					} catch {
						return false;
					}
				});
			} catch {
				return false;
			}
		});

		if (hasBookFolder) {
			validationEl.createSpan({
				text: "✓ Readest sync folder found",
				attr: { style: "color: var(--text-success); font-size: 0.85em; margin-top: 0.5em; display: block;" }
			});
		} else {
			validationEl.createSpan({
				text: "⚠ Folder exists but no Readest book data found",
				attr: { style: "color: var(--text-warning); font-size: 0.85em; margin-top: 0.5em; display: block;" }
			});
		}
	}

	private async openFolderPicker(prompt = "Select sync folder"): Promise<string | null> {
		return new Promise((resolve) => {
			if (platform() === "darwin") {
				const script = `osascript -e 'POSIX path of (choose folder with prompt "${prompt}")'`;
				exec(script, (error: Error | null, stdout: string) => {
					if (error) {
						resolve(null);
					} else {
						resolve(stdout.trim());
					}
				});
			} else if (platform() === "win32") {
				const script = `powershell -command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '${prompt}'; $f.ShowDialog() | Out-Null; $f.SelectedPath"`;
				exec(script, (error: Error | null, stdout: string) => {
					if (error) {
						resolve(null);
					} else {
						resolve(stdout.trim());
					}
				});
			} else {
				exec(`zenity --file-selection --directory --title="${prompt}"`,
					(error: Error | null, stdout: string) => {
						if (error) {
							resolve(null);
						} else {
							resolve(stdout.trim());
						}
					}
				);
			}
		});
	}
}
