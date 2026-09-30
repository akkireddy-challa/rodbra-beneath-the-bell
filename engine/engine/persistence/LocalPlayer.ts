/**
 * The local player — who a game is played as on localhost.
 *
 * There are no player accounts on localhost: no portal session, no play-auth
 * bridge, no play token. Instead of "guest" (which on a deployed game means
 * "signed out, nothing leaves the browser"), localhost has exactly one
 * identity, the local player. Their saves persist in this browser through the
 * same sync machinery a signed-in player gets — `CloudSaveSync` over a
 * `LocalAccountTransport` in localStorage instead of api-server — so the whole
 * persistence system can be exercised and tested without a server.
 *
 * "Reset the local player" wipes everything that player accumulated for a
 * game (saves, sync journal, backups, the local account store) and issues a
 * fresh id, so the next load is a first visit. The creator's Save Data
 * Inspector exposes it.
 */

import { SAVE_KEY_PREFIX } from 'engine/persistence/StorageAdapter.js';
import { BACKUP_KEY_PREFIX, JOURNAL_KEY_PREFIX } from 'engine/persistence/CloudSaveSync.js';
import { LOCAL_ACCOUNT_KEY_PREFIX, type StorageLike } from 'engine/persistence/LocalAccountTransport.js';

export type { StorageLike } from 'engine/persistence/LocalAccountTransport.js';

export interface LocalPlayer {
    /** Stable until reset; opaque. */
    id: string;
    createdAt: number;
}

export const LOCAL_PLAYER_KEY = 'bm-local-player';

/** The page's localStorage, or null where touching it throws (some privacy modes). */
export function localStorageOrNull(): StorageLike | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
        return null;
    }
}

function newId(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    const raw = c && typeof c.randomUUID === 'function'
        ? c.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return raw.slice(0, 12);
}

function isLocalPlayer(value: unknown): value is LocalPlayer {
    return !!value && typeof value === 'object'
        && typeof (value as LocalPlayer).id === 'string' && (value as LocalPlayer).id !== ''
        && typeof (value as LocalPlayer).createdAt === 'number';
}

/** The current local player, created on first use. */
export function getLocalPlayer(storage: StorageLike | null = localStorageOrNull()): LocalPlayer {
    if (storage) {
        try {
            const raw = storage.getItem(LOCAL_PLAYER_KEY);
            if (raw !== null) {
                const parsed: unknown = JSON.parse(raw);
                if (isLocalPlayer(parsed)) return parsed;
            }
        } catch {
            // Fall through to a fresh player.
        }
    }
    return resetLocalPlayer(storage);
}

/** Issue a fresh local player id (the previous one is forgotten). */
export function resetLocalPlayer(storage: StorageLike | null = localStorageOrNull()): LocalPlayer {
    const player: LocalPlayer = { id: newId(), createdAt: Date.now() };
    try {
        storage?.setItem(LOCAL_PLAYER_KEY, JSON.stringify(player));
    } catch {
        // No storage: the id lives for this page only.
    }
    return player;
}

/** Every key prefix that holds player data for `gameId`. */
export function playerDataKeyPrefixes(gameId: string): string[] {
    return [
        `${SAVE_KEY_PREFIX}${gameId}:`,
        `${JOURNAL_KEY_PREFIX}${gameId}`,
        `${BACKUP_KEY_PREFIX}${gameId}:`,
        `${LOCAL_ACCOUNT_KEY_PREFIX}${gameId}:`,
    ];
}

/**
 * Remove everything the player accumulated for `gameId`: save slots (ghost
 * bookkeeping included), the sync journal, backups, and the local account
 * store. Returns how many keys went. Does NOT touch the player id — pair with
 * `resetLocalPlayer()` for a full reset.
 */
export function wipePlayerData(gameId: string, storage: StorageLike | null = localStorageOrNull()): number {
    if (!storage) return 0;
    const prefixes = playerDataKeyPrefixes(gameId);
    const doomed: string[] = [];
    try {
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key !== null && prefixes.some((p) => key.startsWith(p))) doomed.push(key);
        }
        for (const key of doomed) storage.removeItem(key);
    } catch {
        // Partial wipe is still a wipe of what we could reach.
    }
    return doomed.length;
}
