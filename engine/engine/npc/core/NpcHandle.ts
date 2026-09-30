import type { NpcManager } from 'engine/npc/core/NpcManager.js';
import type { SpawnNpcRelativeOptions } from 'engine/npc/core/NpcManager.js';

export interface NpcHandle {
    /**
     * Spawn at (x, z) on the topmost walkable surface, or — when `y` is given —
     * inside a roofed space: the floor is resolved by scanning DOWN from `y`,
     * so `spawn(4, -21, 1.5)` puts the NPC on a dungeon-room floor instead of
     * on the dungeon's roof. Pass `y` roughly at the room's walk height (floor
     * + ~0.5–2m); columns without standing headroom (walls) are rejected and
     * the spawn drifts to a nearby valid spot.
     */
    spawn(x: number, z: number, y?: number): Promise<void>;
    spawn(options: SpawnNpcRelativeOptions): Promise<void>;
    /** Re-tier this NPC type at runtime (rare; see docs). */
    setImportance(importance: 'hero' | 'crowd'): void;
}

export class NpcHandleImpl implements NpcHandle {
    constructor(
        private readonly name: string,
        private readonly manager: NpcManager,
    ) {}

    async spawn(xOrOptions: number | SpawnNpcRelativeOptions, z?: number, y?: number): Promise<void> {
        if (typeof xOrOptions === 'number') {
            await this.manager.spawnNpc(xOrOptions, z, undefined, 0, y);
        } else {
            await this.manager.spawnNpcRelativeTo(xOrOptions);
        }
    }

    setImportance(importance: 'hero' | 'crowd'): void {
        this.manager.setImportance(importance);
    }
}
