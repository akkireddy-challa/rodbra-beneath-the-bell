/**
 * DoorSystem — the data-driven lifecycle for `worldProfileData.doors` and
 * `worldProfileData.keyItems`.
 *
 * Owns one session-scoped `Keyring`, one `DungeonDoor` per door definition in
 * the active level, and one `KeyPickup` per key definition the player doesn't
 * already hold. `GameEngine` constructs it during `loadGame` when
 * `gameDataHasDoors()` says the world declares any (the achievements pattern:
 * optional `EngineLike.getDoorSystem?()` + a thin delegate + a subsystem the
 * engine installs), calls `initForLevel()` at boot and again from
 * `LevelManager.onLevelDidLoad`, ticks `update()` from `animate()`, and
 * disposes it on the next load.
 *
 * Everything the system needs from outside — game data, the positions that
 * may trigger a door, the network pipe, the HUD toast — arrives through
 * `DoorSystemDeps`, so the whole class unit-tests against a stubbed engine.
 *
 * Multiplayer is optional and additive: `deps.network` is null in
 * single-player and every door/key behaviour works unchanged. When a network
 * manager exists, `DoorNetworkSync` wraps a `SharedMultiplayerState<DoorDelta,
 * DoorSnapshot>` named `'doors'` around this system — local transitions emit
 * deltas, remote deltas land in `applyDelta`, and a joining or level-switching
 * client catches up through `applySnapshot`.
 *
 * No echo loop is possible in either direction:
 *   - a remote door state goes through `DungeonDoor.applyRemoteState`, which
 *     fires no `onStateChanged` — including for the animation it starts;
 *   - a remote key goes through `Keyring.grant`, which is idempotent, and the
 *     `applyingRemote` flag stops the one listener call a NEW remote key does
 *     produce from being broadcast straight back out.
 *
 * ## Convergence is pull-based
 *
 * A snapshot only ever crosses the wire in response to an explicit
 * `snapshotRequest` — `SharedMultiplayerState`'s periodic host tick is a
 * GameDataService WRITE, not a broadcast, so nothing arrives unasked. Door
 * state is level-scoped and rebuilt closed on every switch, so `initForLevel`
 * asks for one (`network.requestSnapshot()`) whenever it built something: a
 * client entering a level adopts whatever the host's doors and keys are doing
 * there, instead of silently diverging until someone touches a door.
 *
 * ## Session-scoped by ruling
 *
 * The stream is constructed live-only (`persistFlushIntervalMs: 0`, see
 * `DoorNetworkSync`), so nothing is ever written to GameDataService.
 * Persisting `{ keys }` would permanently pre-solve the dungeon: every future
 * session would load the snapshot, hold every key, and despawn every pickup
 * for good. Dungeon progression is per-session by design; late joiners still
 * converge on the live state through `snapshotRequest`.
 *
 * ## The locked flag is NOT synced
 *
 * `DoorDelta` carries door STATE only. `lockDoor`/`unlockDoor` are therefore
 * per-client, and so is the engine's own key-unlock path: when a player presses
 * E on a locked door with the key, `DungeonDoor.onInteractStart` clears the
 * lock on THAT client only, so the other peers still consider the door locked
 * and their auto-close timer shuts it again in their faces. It self-heals —
 * `grantKey` IS networked, so every peer holds the key and any of them can
 * press E on their own copy. Co-op gates should not rely on one player's
 * unlock: drive `lockDoor`/`unlockDoor` from symmetric game logic that runs on
 * every client (boss defeated, puzzle solved). Propagating the lock as its own
 * delta is deferred by ruling, not an oversight.
 */

import type { EngineLike, GameData } from 'types/game.js';
import { isInstanceInActiveLevel } from 'engine/levels/levelResolve.js';
import { Keyring } from 'engine/doors/Keyring.js';
import { KeyPickup } from 'engine/doors/KeyPickup.js';
import { DungeonDoor, type DungeonDoorState } from 'engine/doors/DungeonDoor.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

/**
 * One synchronised change: a door reaching a state, or a key being granted.
 * Discriminated by the presence of `grantKey`.
 */
export type DoorDelta = { doorId: string; state: DungeonDoorState } | { grantKey: string };

/** Full door/key state, small enough to sit well inside GameDataService's 1 MB cap. */
export interface DoorSnapshot {
    /** Live door id → its state at capture time. */
    doors: Record<string, DungeonDoorState>;
    /** Every key id held, in grant order. */
    keys: string[];
}

export interface DoorSystemDeps {
    /** The loaded game data (re-read on every `initForLevel`, never cached). */
    getGameData: () => GameData | null;
    /**
     * Positions allowed to trigger a proximity auto-open — the local player
     * plus the NPCs the engine is simulating. Injected rather than read off
     * the engine so tests can stub it, and so the engine can reuse one scratch
     * array instead of allocating per sweep.
     */
    getCharacterPositions: () => ReadonlyArray<{ x: number; y: number; z: number }>;
    /**
     * Multiplayer pipe (`DoorNetworkSync`), or null in single-player.
     * `emit` broadcasts one local change; `requestSnapshot` asks the host for
     * the full live state (nothing arrives unasked — see the class header).
     */
    network: { emit: (delta: DoorDelta) => void; requestSnapshot: () => void } | null;
    /** HUD toast sink shared by every door and pickup (one `InGameNotification`). */
    notify: (message: string) => void;
}

/**
 * Seconds between proximity sweeps. Each sweep pulls a fresh position list
 * (the engine walks the NPC registry to build it), so it runs on a fixed
 * interval instead of every frame. At 10 Hz a sprinting player covers well
 * under a metre between sweeps against a 2.5 m default trigger radius and a
 * 700 ms open animation — imperceptible.
 */
export const DOOR_PROXIMITY_INTERVAL_SECONDS = 0.1;

export class DoorSystem {
    private readonly engine: EngineLike;
    private readonly deps: DoorSystemDeps;
    private readonly keyring = new Keyring();
    private readonly doors = new Map<string, DungeonDoor>();
    /** Live pickups, kept with their key id so a remote collect can drop ours. */
    private readonly pickups: Array<{ keyId: string; pickup: KeyPickup }> = [];
    private readonly unsubscribeKeyring: () => void;

    /** True while applying a remote delta/snapshot — suppresses re-broadcast. */
    private applyingRemote = false;
    /** Starts full so the first `update()` after a build sweeps immediately. */
    private proximityAccumulator = DOOR_PROXIMITY_INTERVAL_SECONDS;
    private disposed = false;

    constructor(engine: EngineLike, deps: DoorSystemDeps) {
        this.engine = engine;
        this.deps = deps;
        this.unsubscribeKeyring = this.keyring.onChanged((keyId) => this.handleKeyGranted(keyId));
    }

    /**
     * Whether the world declares any doors or key items — lets GameEngine skip
     * constructing the system (and its keyring listener) for the common game
     * that has none. Key items count on their own: a world may hand out a key
     * for game code to read without declaring a door for it.
     */
    static gameDataHasDoors(gameData: GameData): boolean {
        const profile = gameData.worldProfileData;
        return (profile?.doors?.length ?? 0) > 0 || (profile?.keyItems?.length ?? 0) > 0;
    }

    // ---- lifecycle -------------------------------------------------------

    /**
     * Rebuild every door and pickup for the level that just became active.
     * Prior entities are disposed first, so this is also the level-switch
     * teardown. `activeLevelId` follows the engine-wide instance rule
     * (`isInstanceInActiveLevel`): untagged definitions are global, a null
     * active level is legacy single-world mode and loads everything.
     *
     * The keyring is NOT reset — keys are session-scoped, so a player who
     * walks back into a level doesn't re-collect what they already carry (and
     * the pickup for a held key isn't spawned at all).
     */
    initForLevel(activeLevelId: string | null): void {
        if (this.disposed) return;
        this.teardownEntities();

        const profile = this.deps.getGameData()?.worldProfileData;
        if (!profile) return;

        const doorDefs = (profile.doors ?? []).filter((def) => isInstanceInActiveLevel(def, activeLevelId));
        const keyDefs = (profile.keyItems ?? []).filter((def) => isInstanceInActiveLevel(def, activeLevelId));
        if (doorDefs.length === 0 && keyDefs.length === 0) return;

        if (!this.engine.physicsWorld) {
            // physicsMode 'none'. Doors are kinematic bodies and pickups are
            // sensors — neither can exist. Loud, and the rest of the game loads.
            console.warn(`[DoorSystem] no physicsWorld — skipping ${doorDefs.length} door(s) and ${keyDefs.length} key pickup(s) (physicsMode "none"?)`);
            return;
        }
        if (isPlaneLockedPhysics(this.engine.physicsWorld)) {
            // 2D-physics lane. A door is a KINEMATIC 3D body that swings or slides
            // through a doorway, and its reader/key pickups are built from 3D
            // descriptors — none of which a 2D-only bundle can even construct.
            // Skipping loudly beats throwing: the level, its enemies and the rest
            // of the game load, and the creator is told what is missing rather
            // than reading a facade error from a failed load.
            // See game/docs/physics-2d-lane.md (known limits).
            console.warn(`[DoorSystem] doors are 3D-only — skipping ${doorDefs.length} door(s) and ${keyDefs.length} key pickup(s) on the 2D-physics lane`);
            return;
        }

        for (const def of doorDefs) {
            if (this.doors.has(def.id)) {
                console.warn(`[DoorSystem] duplicate door id "${def.id}" in worldProfileData.doors — keeping the first`);
                continue;
            }
            const door = new DungeonDoor(
                this.engine,
                def,
                this.keyring,
                { onStateChanged: (state) => this.handleLocalStateChange(def.id, state) },
                this.deps.notify,
            );
            this.doors.set(def.id, door);
        }

        for (const def of keyDefs) {
            // Already collected this session (or synced in) — nothing to spawn.
            if (this.keyring.has(def.keyId)) continue;
            this.pickups.push({
                keyId: def.keyId,
                pickup: new KeyPickup(this.engine, def, this.keyring, this.deps.notify),
            });
        }

        // Adopt whatever the host's copy of this level is doing. Doors were
        // just rebuilt closed and unlocked; without this, a client entering a
        // level the host has already opened up diverges until someone acts.
        this.deps.network?.requestSnapshot();
    }

    /**
     * Drop every live door and pickup without ending the session — the
     * counterpart to `initForLevel`, called from `LevelManager.onLevelWillUnload`.
     * A door that blocks pathing owns a navmesh obstacle provider for as long
     * as it lives; tearing the old level's doors down BEFORE the switch keeps
     * those obstacles from re-attaching over the incoming level's navmesh
     * install. The keyring is untouched — keys are session-scoped.
     */
    unloadLevel(): void {
        if (this.disposed) return;
        this.teardownEntities();
    }

    /**
     * Per-frame tick from `GameEngine.animate()`, in gameplay seconds (0 while
     * paused, which correctly freezes the sweep). Doors animate themselves off
     * the physics pre-step; the only thing owed here is the proximity sweep.
     */
    update(deltaTime: number): void {
        if (this.disposed || this.doors.size === 0) return;
        this.proximityAccumulator += deltaTime;
        if (this.proximityAccumulator < DOOR_PROXIMITY_INTERVAL_SECONDS) return;
        this.proximityAccumulator = 0;

        const positions = this.deps.getCharacterPositions();
        for (const door of this.doors.values()) door.updateProximity(positions);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeKeyring();
        this.teardownEntities();
    }

    private teardownEntities(): void {
        for (const door of this.doors.values()) door.dispose();
        this.doors.clear();
        for (const entry of this.pickups) entry.pickup.dispose();
        this.pickups.length = 0;
        this.proximityAccumulator = DOOR_PROXIMITY_INTERVAL_SECONDS;
    }

    // ---- game-facing API -------------------------------------------------

    /** Open a door by id, bypassing its lock. False when no such door is live. */
    openDoor(id: string): boolean {
        const door = this.doors.get(id);
        if (!door) return false;
        door.open();
        return true;
    }

    /** Close a door by id, bypassing its lock. False when no such door is live. */
    closeDoor(id: string): boolean {
        const door = this.doors.get(id);
        if (!door) return false;
        door.close();
        return true;
    }

    /** Lock a door by id (blocks pathing once shut). False when no such door is live. */
    lockDoor(id: string): boolean {
        const door = this.doors.get(id);
        if (!door) return false;
        door.setLocked(true);
        return true;
    }

    /** Unlock a door by id without needing its key. False when no such door is live. */
    unlockDoor(id: string): boolean {
        const door = this.doors.get(id);
        if (!door) return false;
        door.setLocked(false);
        return true;
    }

    /** Current state of a live door, or null when the active level has no such door. */
    getDoorState(id: string): DungeonDoorState | null {
        return this.doors.get(id)?.getState() ?? null;
    }

    /** The session-scoped keyring shared by every door and pickup. */
    getKeyring(): Keyring {
        return this.keyring;
    }

    // ---- network ---------------------------------------------------------

    private handleLocalStateChange(doorId: string, state: DungeonDoorState): void {
        if (this.applyingRemote) return;
        this.deps.network?.emit({ doorId, state });
    }

    private handleKeyGranted(keyId: string): void {
        // However the key arrived — local collect, remote peer, or snapshot —
        // its pickup must go. The locally collected one disposes itself too;
        // dispose() is idempotent.
        for (let i = this.pickups.length - 1; i >= 0; i--) {
            if (this.pickups[i]!.keyId !== keyId) continue;
            this.pickups[i]!.pickup.dispose();
            this.pickups.splice(i, 1);
        }
        if (this.applyingRemote) return;
        this.deps.network?.emit({ grantKey: keyId });
    }

    /**
     * Apply one delta from `SharedMultiplayerState` — remote peers AND the
     * local optimistic re-application of our own `emit()` (which lands as a
     * no-op: the door is already in that state, the key already held).
     */
    applyDelta(delta: DoorDelta): void {
        if (this.disposed) return;
        this.applyingRemote = true;
        try {
            if ('grantKey' in delta) {
                this.keyring.grant(delta.grantKey);
            } else {
                this.doors.get(delta.doorId)?.applyRemoteState(delta.state);
            }
        } finally {
            this.applyingRemote = false;
        }
    }

    /** Capture live door states + held keys for persistence and late joiners. */
    serializeSnapshot(): DoorSnapshot {
        const doors: Record<string, DungeonDoorState> = {};
        for (const [id, door] of this.doors) doors[id] = door.getState();
        return { doors, keys: [...this.keyring.keys()] };
    }

    /**
     * Restore a snapshot from the host or from persisted game data. Doors not
     * present in the active level are ignored — this client rebuilds its own
     * set on every level switch.
     */
    applySnapshot(snapshot: DoorSnapshot): void {
        if (this.disposed) return;
        // Wire payload — shape it before trusting it.
        const keys = Array.isArray(snapshot?.keys) ? snapshot.keys : [];
        const doorStates = snapshot?.doors && typeof snapshot.doors === 'object' ? snapshot.doors : {};

        this.applyingRemote = true;
        try {
            for (const keyId of keys) {
                if (typeof keyId === 'string') this.keyring.grant(keyId);
            }
            for (const [id, state] of Object.entries(doorStates)) {
                this.doors.get(id)?.applyRemoteState(state);
            }
        } finally {
            this.applyingRemote = false;
        }
    }
}
