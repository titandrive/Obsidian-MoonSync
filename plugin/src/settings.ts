import { App, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type MoonSyncPlugin from "../main";
import { MoonSyncSettings } from "./types";

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

	constructor(app: App, plugin: MoonSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "MoonSync Settings" });

		containerEl.createEl("h3", { text: "About" });

		new Setting(containerEl)
			.setName("Sync your Moon Reader highlights to Obsidian")
			.setDesc("Book covers, descriptions, and ratings from Google Books/Open Library")
			.addButton((button) =>
				button.setButtonText("GitHub").onClick(() => {
					window.open("https://github.com/titandrive/moonsync");
				})
			);

		containerEl.createEl("h3", { text: "Configuration" });

		let textComponent: TextComponent;

		new Setting(containerEl)
			.setName("Moon Reader Dropbox Path")
			.setDesc(
				"Path to your Books folder in Dropbox (usually Dropbox/Apps/Books). The plugin will find the hidden .Moon+ folder automatically."
			)
			.addText((text) => {
				textComponent = text;
				text
					.setPlaceholder("/Users/you/Dropbox/Apps/Books")
					.setValue(this.plugin.settings.dropboxPath)
					.onChange(async (value) => {
						this.plugin.settings.dropboxPath = value;
						await this.plugin.saveSettings();
					});
			})
			.addButton((button) =>
				button.setButtonText("Browse").onClick(async () => {
					const folder = await this.openFolderPicker();
					if (folder) {
						this.plugin.settings.dropboxPath = folder;
						textComponent.setValue(folder);
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Output Folder")
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

		containerEl.createEl("h3", { text: "Sync" });

		new Setting(containerEl)
			.setName("Sync Now")
			.setDesc("Manually trigger a sync from Moon Reader")
			.addButton((button) =>
				button.setButtonText("Sync").onClick(async () => {
					await this.plugin.runSync();
				})
			);

		new Setting(containerEl)
			.setName("Sync on Startup")
			.setDesc("Automatically sync when Obsidian starts")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show Ribbon Icon")
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

		containerEl.createEl("h3", { text: "Note Content" });

		new Setting(containerEl)
			.setName("Show Description")
			.setDesc("Include book description in generated notes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showDescription)
					.onChange(async (value) => {
						this.plugin.settings.showDescription = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show Ratings")
			.setDesc("Include Google Books rating in generated notes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRatings)
					.onChange(async (value) => {
						this.plugin.settings.showRatings = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show Reading Progress")
			.setDesc("Include reading progress section. Note: Progress data may not always be accurate depending on Moon Reader sync.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showReadingProgress)
					.onChange(async (value) => {
						this.plugin.settings.showReadingProgress = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show Highlight Colors")
			.setDesc("Use different callout styles based on highlight color. When off, all highlights appear as quotes.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHighlightColors)
					.onChange(async (value) => {
						this.plugin.settings.showHighlightColors = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Fetch Book Covers")
			.setDesc("Download book covers from Open Library/Google Books. Covers are saved in a 'covers' subfolder.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.fetchCovers)
					.onChange(async (value) => {
						this.plugin.settings.fetchCovers = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Support" });

		new Setting(containerEl)
			.setName("Buy me a coffee")
			.setDesc("If you find this plugin useful, consider supporting its development!")
			.addButton((button) =>
				button.setButtonText("Ko-fi").onClick(() => {
					window.open("https://ko-fi.com/titandrive");
				})
			);

	}

	private async openFolderPicker(): Promise<string | null> {
		// Use osascript on macOS to show native folder picker
		const { exec } = require("child_process");
		const { platform } = require("os");

		return new Promise((resolve) => {
			if (platform() === "darwin") {
				// macOS: use osascript
				const script = `osascript -e 'POSIX path of (choose folder with prompt "Select Moon Reader Dropbox folder")'`;
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
