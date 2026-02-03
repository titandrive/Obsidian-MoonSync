import { Plugin, Notice, setIcon } from "obsidian";
import { MoonSyncSettings, DEFAULT_SETTINGS } from "./src/types";
import { MoonSyncSettingTab } from "./src/settings";
import { syncFromMoonReader, showSyncResults, refreshIndexNote } from "./src/sync";
import { join } from "path";

export default class MoonSyncPlugin extends Plugin {
	settings: MoonSyncSettings = DEFAULT_SETTINGS;
	ribbonIconEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new MoonSyncSettingTab(this.app, this));

		// Add ribbon icon if enabled
		this.updateRibbonIcon();

		// Add sync command
		this.addCommand({
			id: "sync-now",
			name: "Sync Now",
			callback: () => this.runSync(),
		});

		// Sync on startup if enabled
		if (this.settings.syncOnStartup) {
			// Wait a bit for Obsidian to fully load
			this.app.workspace.onLayoutReady(() => {
				setTimeout(() => this.runSync(), 2000);
			});
		}
	}

	updateRibbonIcon() {
		// Remove existing icon if present
		if (this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}

		// Add icon if setting is enabled
		if (this.settings.showRibbonIcon) {
			this.ribbonIconEl = this.addRibbonIcon(
				"book-open",
				"MoonSync: Sync Now",
				() => this.runSync()
			);
		}
	}

	async runSync(): Promise<void> {
		if (!this.settings.dropboxPath) {
			new Notice("MoonSync: Please configure the Dropbox path in settings");
			return;
		}

		try {
			// Get the path to the WASM file
			const wasmPath = this.getWasmPath();

			const result = await syncFromMoonReader(
				this.app,
				this.settings,
				wasmPath
			);
			showSyncResults(this.app, result);
		} catch (error) {
			console.error("MoonSync sync error:", error);
			new Notice(`MoonSync: Sync failed - ${error}`);
		}
	}

	/**
	 * Get the path to the sql-wasm.wasm file bundled with the plugin
	 */
	private getWasmPath(): string {
		// The WASM file is copied to the plugin folder during build
		const pluginDir = (this.app.vault.adapter as any).basePath;
		const pluginPath = this.manifest.dir;
		if (pluginPath) {
			return join(pluginDir, pluginPath, "sql-wasm.wasm");
		}
		throw new Error("Could not determine plugin directory");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async refreshIndex(): Promise<void> {
		await refreshIndexNote(this.app, this.settings);
	}
}
