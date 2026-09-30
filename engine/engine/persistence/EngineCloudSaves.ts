/**
 * Engine-side wiring for account-backed saves — kept out of `GameEngine` so
 * that class holds only the calls, not the decisions (the same split as
 * installGhostRacing / installEngineProgress). One sync instance exists per
 * loaded game, installed by GameEngine.loadGame() and reachable through the
 * module accessors below (the getPlayProgress() pattern: no public setX()).
 *
 * Where a game's saves are mirrored: with a play-auth bridge (deployed games)
 * to the player's account through api-server — or nowhere, for a guest.
 * Without one there are no accounts at all (localhost), so the mirror is the
 * LOCAL PLAYER's account store in this browser (LocalAccountTransport): the
 * same sync machinery runs end to end and can be tested without a server.
 */

import { PLAY_AUTH_URL } from 'engine/config.js';
import { getPlayerIdentity } from 'engine/identity/PlayerIdentity.js';
import { LocalStorageAdapter } from 'engine/persistence/StorageAdapter.js';
import {
    CloudSaveSync,
    DEFAULT_CLOUD_SAVE_SYNC_OPTIONS,
    createLocalStorageBackupStore,
    createLocalStorageJournalStore,
    type CloudSaveSyncDeps,
    type CloudSaveSyncStatus,
} from 'engine/persistence/CloudSaveSync.js';
import { CloudSaveClient } from 'engine/persistence/CloudSaveClient.js';
import { LocalAccountTransport } from 'engine/persistence/LocalAccountTransport.js';
import { getLocalPlayer, localStorageOrNull, resetLocalPlayer, wipePlayerData } from 'engine/persistence/LocalPlayer.js';

let current: CloudSaveSync | null = null;
let currentGameId = '';

/**
 * Start the play-token handshake before any game data loads: the play-auth
 * bridge derives the game from the page origin, so nothing here depends on
 * loadGame(), and the reconcile that gates genre start finds the token already
 * cached. Guests resolve instantly; failures resolve to guest.
 */
export function prewarmPlayerToken(): void {
    void getPlayerIdentity().getPlayerToken();
}

function cloudSaveSyncDeps(gameId: string): CloudSaveSyncDeps {
    const shared = {
        inner: new LocalStorageAdapter(),
        gameId,
        journal: createLocalStorageJournalStore(gameId),
        backup: createLocalStorageBackupStore(gameId),
        now: () => Date.now(),
        options: DEFAULT_CLOUD_SAVE_SYNC_OPTIONS,
    };
    if (PLAY_AUTH_URL === '') {
        const player = getLocalPlayer();
        return {
            ...shared,
            client: new LocalAccountTransport(gameId, `local:${player.id}`, localStorageOrNull(), () => Date.now()),
            getPlayerToken: async () => 'local',
            hasBridge: false,
            identity: { kind: 'local', id: player.id },
        };
    }
    return {
        ...shared,
        client: new CloudSaveClient(),
        getPlayerToken: () => getPlayerIdentity().getPlayerToken(),
        hasBridge: true,
        identity: { kind: 'account' },
    };
}

/**
 * Install the sync for a freshly loading game and start its reconcile. The
 * previous game's sync is flushed and stopped first — the engine instance
 * survives reloads. The returned sync's `adapter` is what GamePersistence
 * must be built on.
 */
export function installCloudSaves(gameId: string): CloudSaveSync {
    current?.dispose();
    current = new CloudSaveSync(cloudSaveSyncDeps(gameId));
    currentGameId = gameId;
    current.start();
    return current;
}

/**
 * Hold genre construction until the account copies are in localStorage (or
 * the cap passes). The sync started when persistence did, so this normally
 * resolves at once; a missed gate is safe — CloudSaveSync forks rather than
 * overwrites.
 */
export function gateCloudSaves(): Promise<void> {
    return current ? current.whenSettled(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.gateMs) : Promise.resolve();
}

/** Push any save still waiting on its debounce, then stop syncing. */
export function disposeCloudSaves(): void {
    current?.dispose();
    current = null;
}

/** The save-sync state for the loaded game (who the saves belong to, what is pending), or null before a game loads. */
export function getCloudSaveStatus(): CloudSaveSyncStatus | null {
    return current?.getStatus() ?? null;
}

/**
 * Forget everything the current player saved for the loaded game — save slots
 * (ghost bookkeeping included), sync journal, backups and, on localhost, the
 * local account store — and on localhost become a NEW local player. The
 * running game still holds its in-memory state; the caller reloads it.
 * Returns how many keys were removed. Creator-only.
 */
export function resetPlayerData(): number {
    const gameId = currentGameId;
    if (!gameId) return 0;
    // Abandon, not dispose: a parting flush would write back the very data
    // being erased.
    current?.abandon();
    current = null;
    const removed = wipePlayerData(gameId);
    if (PLAY_AUTH_URL === '') resetLocalPlayer();
    console.info(`[CloudSave] player data reset for ${gameId}: ${removed} key(s) removed`);
    return removed;
}
