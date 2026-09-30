/**
 * DoorNetworkSync — multiplayer sync for `DoorSystem`.
 *
 * A thin adapter around one `SharedMultiplayerState<DoorDelta, DoorSnapshot>`
 * named `'doors'`: local door/key changes go out through `emit()`, remote ones
 * come back through `DoorSystem.applyDelta`, and a joining or level-switching
 * client catches up through `requestSnapshot()` — the host answers a
 * `doors.snapshotRequest` with its live state. Constructed by GameEngine only
 * when the genre exposes a `NetworkManager` — single-player never builds one,
 * and `DoorSystem` works in full without it.
 *
 * **Live-only, by ruling.** `persistFlushIntervalMs: 0` disables the host's
 * periodic GameDataService write, so door and key state never outlives the
 * session. Persisting `{ keys }` would permanently pre-solve the dungeon: the
 * host writes every five seconds, and every future session's `start()` would
 * load that snapshot, hold every key, and despawn every pickup for good.
 * Dungeon progression is per-session by design.
 *
 * Host tracking mirrors `WorldShardSync`: `NetworkRoomOwnership` broadcasts
 * `_roomOwner` on claim, on migration, and as a periodic heartbeat, so
 * comparing its `ownerId` against the local player id keeps the flag current
 * without this class owning the ownership protocol itself.
 */

import type { NetworkManager } from 'engine/networking/NetworkManager.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';
import { SharedMultiplayerState } from 'engine/networking/SharedMultiplayerState.js';
import type { DoorDelta, DoorSnapshot, DoorSystem } from 'engine/doors/DoorSystem.js';

/** Event NetworkRoomOwnership broadcasts the current room owner on. */
const EVENT_ROOM_OWNER = '_roomOwner';

/** GameDataService category + network event prefix for the door state stream. */
export const DOORS_SHARED_STATE_NAME = 'doors';

/** The event the host answers with its live snapshot (SharedMultiplayerState's own name). */
export const DOORS_SNAPSHOT_REQUEST_EVENT = `${DOORS_SHARED_STATE_NAME}.snapshotRequest`;

export interface DoorNetworkSyncOptions {
    networkManager: NetworkManager;
    gameDataService: GameDataService;
}

export class DoorNetworkSync {
    private readonly networkManager: NetworkManager;
    private readonly shared: SharedMultiplayerState<DoorDelta, DoorSnapshot>;
    private readonly roomOwnerHandler: (senderId: string, data: Record<string, unknown>) => void;
    private isHost = false;
    private disposed = false;

    constructor(system: DoorSystem, options: DoorNetworkSyncOptions) {
        this.networkManager = options.networkManager;

        this.roomOwnerHandler = (_senderId, data) => {
            const ownerId = (data as { ownerId?: unknown }).ownerId;
            if (typeof ownerId !== 'string') return;
            this.isHost = ownerId === this.networkManager.getLocalPlayerId();
        };
        this.networkManager.events.on(EVENT_ROOM_OWNER, this.roomOwnerHandler);

        this.shared = new SharedMultiplayerState<DoorDelta, DoorSnapshot>({
            name: DOORS_SHARED_STATE_NAME,
            networkManager: options.networkManager,
            gameDataService: options.gameDataService,
            isHost: () => this.isHost,
            applyDelta: (delta) => system.applyDelta(delta),
            serializeSnapshot: () => system.serializeSnapshot(),
            applySnapshot: (snapshot) => system.applySnapshot(snapshot),
            // Live-only: never write door/key state to GameDataService (see header).
            persistFlushIntervalMs: 0,
        });

        // Subscribes, loads the latest persisted snapshot, and asks the host
        // for the live one. Doors are already playable before it resolves.
        this.shared.start().catch((err: unknown) => {
            console.warn('[DoorNetworkSync] start failed — doors stay local-only', err);
        });
    }

    /**
     * `DoorSystem`'s outbound pipe. `SharedMultiplayerState.emit` applies the
     * delta locally first (a no-op — the local change already happened) and
     * then broadcasts it.
     */
    emit(delta: DoorDelta): void {
        if (this.disposed) return;
        this.shared.emit(delta);
    }

    /**
     * Ask the room host to broadcast its live door/key state. Nothing arrives
     * unasked — `SharedMultiplayerState` sends a snapshot only in response to
     * this event (its periodic host tick is a storage write, not a broadcast),
     * and with persistence off it is the ONLY way a client catches up. Called
     * by `DoorSystem.initForLevel`, i.e. at boot and on every level switch.
     */
    requestSnapshot(): void {
        if (this.disposed) return;
        this.networkManager.sendEvent(DOORS_SNAPSHOT_REQUEST_EVENT, {});
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.networkManager.events.off(EVENT_ROOM_OWNER, this.roomOwnerHandler);
        this.shared.dispose();
    }
}
