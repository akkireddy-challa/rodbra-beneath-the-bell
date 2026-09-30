/**
 * Abstract storage contract for game persistence.
 * Swap implementations (localStorage, IndexedDB, server-side) without changing game code.
 */
export interface StorageAdapter {
    /** Read raw string value. Returns null if key doesn't exist. */
    getItem(key: string): string | null;
    /** Write raw string value. Throws StorageError on failure. */
    setItem(key: string, value: string): void;
    /** Delete a key. No-op if key doesn't exist. */
    removeItem(key: string): void;
    /** Check if a key exists. */
    hasItem(key: string): boolean;
    /** List all keys matching an optional prefix. */
    listKeys(prefix?: string): string[];
    /** Check if the storage backend is available and writable. */
    isAvailable(): boolean;
}

export class StorageError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'StorageError';
    }
}

/** localStorage key prefix of every save slot (`bm-save-<gameId>:<slot>`). */
export const SAVE_KEY_PREFIX = 'bm-save-';
const PREFIX = SAVE_KEY_PREFIX;

export class LocalStorageAdapter implements StorageAdapter {

    getItem(key: string): string | null {
        try {
            return localStorage.getItem(PREFIX + key);
        } catch (e) {
            throw new StorageError('localStorage read failed', e);
        }
    }

    setItem(key: string, value: string): void {
        try {
            localStorage.setItem(PREFIX + key, value);
        } catch (e) {
            throw new StorageError('localStorage write failed (possibly full)', e);
        }
    }

    removeItem(key: string): void {
        try {
            localStorage.removeItem(PREFIX + key);
        } catch (e) {
            throw new StorageError('localStorage remove failed', e);
        }
    }

    hasItem(key: string): boolean {
        try {
            return localStorage.getItem(PREFIX + key) !== null;
        } catch {
            return false;
        }
    }

    listKeys(prefix?: string): string[] {
        const results: string[] = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(PREFIX)) {
                    const stripped = key.slice(PREFIX.length);
                    if (!prefix || stripped.startsWith(prefix)) {
                        results.push(stripped);
                    }
                }
            }
        } catch {
            // localStorage unavailable
        }
        return results;
    }

    isAvailable(): boolean {
        const testKey = PREFIX + '__test__';
        try {
            localStorage.setItem(testKey, '1');
            localStorage.removeItem(testKey);
            return true;
        } catch {
            return false;
        }
    }
}
