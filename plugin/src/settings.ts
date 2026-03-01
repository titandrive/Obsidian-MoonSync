import { App, PluginSettingTab, Setting, TextComponent, normalizePath, Notice } from "obsidian";
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
		new Setting(container).setName("Configuration").setDesc("Set up your Moon Reader backup location and note output folder.").setHeading();

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
					const folder = await this.openFolderPicker();
					if (folder) {
						this.plugin.settings.syncPath = folder;
						textComponent.setValue(folder);
						await this.plugin.saveSettings();
						this.validateSyncPath(folder, validationEl);
					}
				})
			);

		// Add validation message element
		validationEl = pathSetting.descEl.createDiv({ cls: "moonsync-path-validation" });

		// Validate on display
		if (this.plugin.settings.syncPath) {
			this.validateSyncPath(this.plugin.settings.syncPath, validationEl);
		}

		new Setting(container)
			.setName("Output folder")
			.setDesc("Folder in your vault where book notes will be created")
			.addText((text) =>
				text
					.setPlaceholder("Books")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value || "Books";
						await this.plugin.saveSettings();
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
			.setDesc("Automatically sync when Moon Reader cache files are updated. Best suited for setups where the sync folder is on a local filesystem.")
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
		new Setting(container)
			.setName("Hardcover.app")
			.setDesc("Sync your reading status and progress to Hardcover.")
			.setHeading();

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
				.setDesc("0% → Want to Read. 1–98% → Currently Reading. 99%+ → Read. No progress data → skipped.");
		}
	}

	private displayAboutTab(container: HTMLElement): void {
		new Setting(container).setName("About").setHeading();

		new Setting(container)
			.setName("Sync your Moon Reader highlights to Obsidian")
			.setDesc("Book covers, descriptions, and metadata from Google Books/Open Library")
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

	private async openFolderPicker(): Promise<string | null> {
		// Use osascript on macOS to show native folder picker
		return new Promise((resolve) => {
			if (platform() === "darwin") {
				// macOS: use osascript
				const script = `osascript -e 'POSIX path of (choose folder with prompt "Select Moon Reader sync folder")'`;
				exec(script, (error: Error | null, stdout: string) => {
					if (error) {
						resolve(null);
					} else {
						resolve(stdout.trim());
					}
				});
			} else if (platform() === "win32") {
				// Windows: use PowerShell folder picker
				const script = `powershell -command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog() | Out-Null; $f.SelectedPath"`;
				exec(script, (error: Error | null, stdout: string) => {
					if (error) {
						resolve(null);
					} else {
						resolve(stdout.trim());
					}
				});
			} else {
				// Linux: try zenity
				exec('zenity --file-selection --directory --title="Select Moon Reader folder"',
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
