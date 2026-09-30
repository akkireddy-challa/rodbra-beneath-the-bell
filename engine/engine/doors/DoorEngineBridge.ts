/**
 * DoorEngineBridge — the engine-side wiring for `DoorSystem`.
 *
 * Owns the pieces GameEngine would otherwise carry inline: the shared HUD
 * toast, the character-position sweep source, the multiplayer stream, and the
 * re-init hook on level switches. GameEngine is at the max-lines cap, so it
 * keeps only thin delegates and this class does the wiring — the same split
 * `engine/levels/LevelEngineBridge.ts` uses for the multi-level runtime.
 *
 * Constructed per `loadGame`, only for a game whose world.json declares doors
 * or key items; disposed on the next load.
 */

import type { EngineLike, GameData } from 'types/game.js';
import { InGameNotification } from 'engine/InGameNotification.js';
import { getActiveLevelIdOrNull, getActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import { DoorSystem, type DoorDelta } from 'engine/doors/DoorSystem.js';
import { DoorNetworkSync } from 'engine/doors/DoorNetworkSync.js';

/** How long a door/key toast stays up. */
const DOOR_NOTIFICATION_MS = 2500;

export class DoorEngineBridge {
    private readonly engine: EngineLike;
    private readonly notification: InGameNotification;
    private readonly system: DoorSystem;
    private network: DoorNetworkSync | null = null;
    /** Reused per proximity sweep — a fresh array every 100 ms is avoidable garbage. */
    private readonly positions: Array<{ x: number; y: number; z: number }> = [];
    private disposed = false;

    /** Whether this game declares any doors or key items (skip the bridge if not). */
    static gameDataHasDoors(gameData: GameData): boolean {
        return DoorSystem.gameDataHasDoors(gameData);
    }

    constructor(engine: EngineLike, gameData: GameData) {
        this.engine = engine;
        // One toast for every door and pickup — DungeonDoor's own
        // DEFAULT_DOOR_NOTIFY would build a second DOM container.
        this.notification = new InGameNotification();

        // Multiplayer is additive: no NetworkManager (single-player, or a genre
        // without networking) simply means no stream, and doors work in full.
        const networkManager = engine.genreModule?.getNetworkManager?.() ?? null;
        const gameDataService = engine.getGameDataService?.() ?? null;

        this.system = new DoorSystem(engine, {
            getGameData: () => gameData,
            getCharacterPositions: () => this.collectCharacterPositions(),
            // Late-bound: the sync needs the system, the system needs the pipe.
            network: networkManager && gameDataService ? {
                emit: (delta: DoorDelta) => this.network?.emit(delta),
                requestSnapshot: () => this.network?.requestSnapshot(),
            } : null,
            notify: (message: string) => this.notification.show(message, DOOR_NOTIFICATION_MS),
        });

        if (networkManager && gameDataService) {
            try {
                this.network = new DoorNetworkSync(this.system, { networkManager, gameDataService });
            } catch (err) {
                // The pipe above stays wired but resolves to null, so emits
                // would silently no-op. Say so once, loudly.
                console.warn('[DoorEngineBridge] door network sync could not be created — doors stay local to this client', err);
                this.network = null;
            }
        }

        this.system.initForLevel(getActiveLevelIdOrNull());
        // The LevelManager is rebuilt per loadGame, so these never accumulate.
        const levelManager = getActiveLevelManager();
        // Tear the old level's doors down BEFORE the switch: a locked door owns
        // a navmesh obstacle for as long as it lives, and the incoming level's
        // navmesh install would otherwise pick up the outgoing level's blockers.
        levelManager?.onLevelWillUnload(() => {
            if (!this.disposed) this.system.unloadLevel();
        });
        levelManager?.onLevelDidLoad((levelId) => {
            if (!this.disposed) this.system.initForLevel(levelId);
        });
    }

    /** The system game code reaches through `engine.getDoorSystem?.()`. */
    getSystem(): DoorSystem {
        return this.system;
    }

    /** Per-frame tick from `GameEngine.animate()`, in gameplay seconds. */
    update(deltaTime: number): void {
        this.system.update(deltaTime);
    }

    /** Positions that may trigger a door: the local player plus every live NPC. */
    private collectCharacterPositions(): ReadonlyArray<{ x: number; y: number; z: number }> {
        const out = this.positions;
        out.length = 0;
        const player = this.engine.getPlayerController()?.getPosition?.();
        if (player) out.push({ x: player.x, y: player.y, z: player.z });
        for (const npc of this.engine.getNpcRegistry?.()?.getAllControllers() ?? []) {
            const p = npc.getPosition();
            out.push({ x: p.x, y: p.y, z: p.z });
        }
        return out;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.network?.dispose();
        this.network = null;
        this.system.dispose();
        this.notification.dispose();
    }
}
