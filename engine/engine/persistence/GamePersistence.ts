import type { StorageAdapter } from 'engine/persistence/StorageAdapter.js';
import { StorageError } from 'engine/persistence/StorageAdapter.js';
import { InGameNotification } from 'engine/InGameNotification.js';

/** Data envelope stored in the adapter. */
export interface SaveEnvelope {
    gameId: string;
    version: number;
    savedAt: number;
    slot: string;
    data: unknown;
}

/** Function that transforms save data from one version to the next. */
export type MigrationFn = (oldData: unknown) => unknown;

/**
 * Map of target version → migration function.
 * Each function transforms data from (version - 1) to (version).
 * Example: { 2: (v1Data) => v2Data, 3: (v2Data) => v3Data }
 */
export type MigrationMap = Record<number, MigrationFn>;

export interface SaveResult {
    success: boolean;
    error?: string;
}

export interface LoadResult<T = unknown> {
    data: T | null;
    version: number | null;
    migrated: boolean;
    error?: string;
}

/** Configuration for automatic save/load notifications. */
export interface PersistenceNotificationConfig {
    /** Whether to show notifications. Default: true. */
    enabled: boolean;
    /** Message shown on save. Use {name} as placeholder for the save name. Default: 'Progress saved'. */
    saveMessage: string;
    /** Message shown when save data is loaded. Use {name} as placeholder. Default: 'Progress restored'. */
    loadMessage: string;
    /** How long the notification stays visible in ms. Default: 2000. */
    durationMs: number;
}

const DEFAULT_NOTIFICATION_CONFIG: PersistenceNotificationConfig = {
    enabled: true,
    saveMessage: 'Progress saved',
    loadMessage: 'Progress restored',
    durationMs: 2000,
};

export class GamePersistence {
    private adapter: StorageAdapter;
    private gameId: string;
    private version: number;
    private migrations: MigrationMap = {};
    private available: boolean;
    private notificationConfig: PersistenceNotificationConfig;
    private notification: InGameNotification | null = null;

    constructor(adapter: StorageAdapter, gameId: string, version: number) {
        this.adapter = adapter;
        this.gameId = gameId;
        this.version = version;
        this.available = adapter.isAvailable();
        this.notificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG };

        if (!this.available) {
            this.getNotification().show('Progress cannot be saved in private browsing mode', 5000);
        }
    }

    /** Configure automatic save/load notifications. Pass partial config to override defaults. */
    setNotification(config: Partial<PersistenceNotificationConfig>): void {
        Object.assign(this.notificationConfig, config);
    }

    private getNotification(): InGameNotification {
        if (!this.notification) {
            this.notification = new InGameNotification();
        }
        return this.notification;
    }

    private showNotification(template: string, name?: string): void {
        if (!this.notificationConfig.enabled) return;
        const message = name ? template.replace('{name}', name) : template;
        this.getNotification().show(message, this.notificationConfig.durationMs);
    }

    /** Register migration functions for upgrading save data between versions. */
    registerMigrations(migrations: MigrationMap): void {
        this.migrations = migrations;
    }

    /** Save data to a named slot. Optional name is used in the auto-notification (e.g. 'Checkpoint 3'). */
    save(data: unknown, slot: string = 'default', name?: string): SaveResult {
        if (!this.available) {
            return { success: false, error: 'Storage unavailable' };
        }

        const envelope: SaveEnvelope = {
            gameId: this.gameId,
            version: this.version,
            savedAt: Date.now(),
            slot,
            data,
        };

        try {
            this.adapter.setItem(this.storageKey(slot), JSON.stringify(envelope));
            this.showNotification(this.notificationConfig.saveMessage, name);
            return { success: true };
        } catch (e) {
            const message = e instanceof StorageError ? e.message : 'Save failed';
            return { success: false, error: message };
        }
    }

    /** Load data from a named slot. Optional name is used in the auto-notification. Returns null data if no save exists. */
    load<T = unknown>(slot: string = 'default', name?: string): LoadResult<T> {
        if (!this.available) {
            return { data: null, version: null, migrated: false };
        }

        let raw: string | null;
        try {
            raw = this.adapter.getItem(this.storageKey(slot));
        } catch {
            return { data: null, version: null, migrated: false, error: 'Failed to read save data' };
        }

        if (raw === null) {
            return { data: null, version: null, migrated: false };
        }

        let envelope: SaveEnvelope;
        try {
            envelope = JSON.parse(raw) as SaveEnvelope;
        } catch {
            return { data: null, version: null, migrated: false, error: 'Save data is corrupted' };
        }

        if (envelope.gameId !== this.gameId) {
            return { data: null, version: null, migrated: false, error: 'Save belongs to a different game' };
        }

        // Same version — return directly
        if (envelope.version === this.version) {
            this.showNotification(this.notificationConfig.loadMessage, name);
            return { data: envelope.data as T, version: envelope.version, migrated: false };
        }

        // Older save — attempt migration chain
        if (envelope.version < this.version) {
            const result = this.migrateAndReturn<T>(envelope, slot);
            if (result.data !== null) {
                this.showNotification(this.notificationConfig.loadMessage, name);
            }
            return result;
        }

        // Newer save than current code — return raw data
        this.showNotification(this.notificationConfig.loadMessage, name);
        return { data: envelope.data as T, version: envelope.version, migrated: false };
    }

    /** Load the raw save envelope (for debugging/inspection). Returns null if no save exists. */
    loadRaw(slot: string = 'default'): SaveEnvelope | null {
        if (!this.available) return null;
        try {
            const raw = this.adapter.getItem(this.storageKey(slot));
            if (raw === null) return null;
            return JSON.parse(raw) as SaveEnvelope;
        } catch {
            return null;
        }
    }

    /** Delete a save slot. */
    deleteSave(slot: string = 'default'): void {
        try {
            this.adapter.removeItem(this.storageKey(slot));
        } catch {
            // Best-effort deletion
        }
    }

    /** Check if a save exists in a slot. */
    hasSave(slot: string = 'default'): boolean {
        if (!this.available) return false;
        return this.adapter.hasItem(this.storageKey(slot));
    }

    /** List all save slots for this game. */
    listSlots(): string[] {
        const prefix = this.gameId + ':';
        const keys = this.adapter.listKeys(prefix);
        return keys.map(k => k.slice(prefix.length));
    }

    private storageKey(slot: string): string {
        return `${this.gameId}:${slot}`;
    }

    private migrateAndReturn<T>(envelope: SaveEnvelope, slot: string): LoadResult<T> {
        // Check if all migrations in the chain exist
        let allMigrationsExist = true;
        for (let v = envelope.version + 1; v <= this.version; v++) {
            if (!this.migrations[v]) {
                allMigrationsExist = false;
                break;
            }
        }

        // No migrations defined — return raw data ignoring version
        if (!allMigrationsExist) {
            return { data: envelope.data as T, version: envelope.version, migrated: false };
        }

        // Apply migration chain
        let data = envelope.data;
        try {
            for (let v = envelope.version + 1; v <= this.version; v++) {
                const migrateFn = this.migrations[v];
                if (!migrateFn) break; // Shouldn't happen — checked above
                data = migrateFn(data);
            }
        } catch {
            return { data: envelope.data as T, version: envelope.version, migrated: false, error: 'Migration failed, returning original data' };
        }

        // Auto-save migrated data so migration only runs once
        this.save(data, slot);

        return { data: data as T, version: this.version, migrated: true };
    }
}
