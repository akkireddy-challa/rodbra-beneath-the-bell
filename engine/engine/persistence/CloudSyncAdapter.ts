/**
 * CloudSyncAdapter — the StorageAdapter decorator that lets CloudSaveSync see
 * every durable write GamePersistence makes, without GamePersistence knowing.
 *
 * GamePersistence is frozen into every published bundle and its API is
 * synchronous, so the cloud layer cannot live inside it. It can live at the
 * adapter seam instead: `save()` funnels through `setItem` (including the
 * migration re-save), `deleteSave()` through `removeItem`, and every read
 * through `getItem`/`hasItem`. This decorator delegates everything to the real
 * local adapter FIRST — local truth is never blocked by sync — and then
 * notifies the hooks.
 *
 * It also records which slots the game has TOUCHED (read or written) since
 * construction. CloudSaveSync uses that to decide whether a cloud copy may
 * still be written into localStorage: once the game has read a slot, the state
 * it holds in memory came from the local copy, and swapping the bytes under it
 * would fork the two. Listing keys is not a touch — a slot picker that shows
 * names has not committed to any of them.
 */

import type { StorageAdapter } from 'engine/persistence/StorageAdapter.js';

/** Sync notifications; called AFTER the local write/delete succeeded. Must not throw. */
export interface CloudSyncHooks {
    onWrite(slot: string, value: string): void;
    onDelete(slot: string): void;
}

export class CloudSyncAdapter implements StorageAdapter {
    private readonly prefix: string;
    private readonly touched = new Set<string>();

    constructor(
        private readonly inner: StorageAdapter,
        gameId: string,
        private readonly hooks: CloudSyncHooks,
    ) {
        this.prefix = `${gameId}:`;
    }

    /** The slot a storage key addresses, or null when the key is not this game's. */
    private slotOf(key: string): string | null {
        return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : null;
    }

    private touch(key: string): string | null {
        const slot = this.slotOf(key);
        if (slot !== null) this.touched.add(slot);
        return slot;
    }

    getItem(key: string): string | null {
        this.touch(key);
        return this.inner.getItem(key);
    }

    setItem(key: string, value: string): void {
        this.inner.setItem(key, value);
        const slot = this.touch(key);
        if (slot !== null) this.hooks.onWrite(slot, value);
    }

    removeItem(key: string): void {
        this.inner.removeItem(key);
        const slot = this.touch(key);
        if (slot !== null) this.hooks.onDelete(slot);
    }

    hasItem(key: string): boolean {
        this.touch(key);
        return this.inner.hasItem(key);
    }

    listKeys(prefix?: string): string[] {
        return this.inner.listKeys(prefix);
    }

    isAvailable(): boolean {
        return this.inner.isAvailable();
    }

    /** Whether the game has read or written this slot since the adapter was created. */
    hasTouched(slot: string): boolean {
        return this.touched.has(slot);
    }

    /** Every slot touched so far (a live view). */
    touchedSlots(): ReadonlySet<string> {
        return this.touched;
    }
}
