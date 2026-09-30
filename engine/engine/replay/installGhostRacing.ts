/**
 * Assemble the player identity and the ghost-racing subsystem for a loaded game.
 *
 * Kept out of `GameEngine` so that class holds only the accessors, not the
 * wiring — the same split `installEngineProgress` uses. Everything a ghost
 * needs (its own store, the player credential, the facade) is decided here.
 *
 * The identity is built separately from ghost racing because it is not a ghost
 * concern: a high-score table written straight through `GameDataService` needs
 * the same credential, and a game that never records a run must still be able
 * to reach it.
 */

import { GamePersistence } from 'engine/persistence/GamePersistence.js';
import { LocalStorageAdapter } from 'engine/persistence/StorageAdapter.js';
import { getPlayerIdentity } from 'engine/identity/PlayerIdentity.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';
import type { EngineLike } from 'types/game.js';
import { DEFAULT_GHOST_IDENTITY_OPTIONS, GhostIdentity } from 'engine/replay/GhostIdentity.js';
import { setLocalRunStore } from 'engine/replay/GhostLocalRuns.js';
import { GhostRacing } from 'engine/replay/GhostRacing.js';

/** The identity and the private store it lives in, built together. */
export interface PlayerIdentitySetup {
    identity: GhostIdentity;
    store: GamePersistence;
}

/**
 * The identity this device writes board rows as.
 *
 * ⚠ ONE per loaded game. `GhostIdentity.resolve()` collapses concurrent
 * callers onto a single mint precisely so a player cannot be issued two guest
 * ids — but that guard is per instance, so a second instance defeats it and
 * splits one player across two rows of the same board.
 */
export function createPlayerIdentity(gameId: string): PlayerIdentitySetup {
    // A persistence view of its own, with notifications OFF. Identity and ghost
    // bookkeeping — the credential, the local best lap — are internal state,
    // not a player-visible save, and the shared instance would pop "Progress
    // saved" after every single lap.
    const store = new GamePersistence(new LocalStorageAdapter(), gameId || 'unknown', 1);
    store.setNotification({ enabled: false });

    const identity = new GhostIdentity(
        { ...DEFAULT_GHOST_IDENTITY_OPTIONS, gameId },
        store,
        () => getPlayerIdentity().getPlayerToken(),
    );
    return { identity, store };
}

export function installGhostRacing(
    engine: EngineLike,
    service: GameDataService,
    gameId: string,
    player: PlayerIdentitySetup,
): GhostRacing {
    // Board reads are free functions that game code calls directly, so the
    // store is installed module-wide rather than injected — see GhostLocalRuns.
    // Without this a leaderboard read cannot see the player's own records.
    setLocalRunStore(player.store);

    return new GhostRacing(engine, service, player.store, player.identity, gameId);
}
