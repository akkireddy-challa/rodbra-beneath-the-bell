/**
 * Area-clearing gameplay on a FORGED (.vwld) level — mowing, ploughing, burning,
 * paving: anything where driving over ground converts it and scores the area.
 *
 * Referenced from agent docs (read-docs name: `samples/ground-type-clearing`).
 * Compiled against the live engine by game's `pnpm run check`
 * (tsconfig.docs-samples.json) — an engine API change breaks this file loudly.
 *
 * The level's ground mask stores ONE surface material per 0.5 m cell, and the
 * engine grows ground cover from it (long grass on `grassLush`, sparse on
 * `grassDry`, nothing on `sand`/`asphalt`). Repainting a cell therefore both
 * scores the work and changes what visibly grows there — the engine refreshes the
 * cover for whatever changed, so game code never touches meshes.
 *
 * This only works on a forged level. Procedural voxel terrain has its own
 * foliage system driven by block types (see `voxel-terrain-foliage.md`).
 */
import type * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import type { VxlSceneTerrainSystem } from 'engine/VxlSceneTerrainSystem.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';

/**
 * The forged level's terrain system, or null when this game runs on procedural
 * voxel terrain instead. Everything below is a no-op without it, so a game can
 * ship the same code for both and simply score nothing on the wrong world.
 */
export function getForgedTerrain(engine: GameEngine): VxlSceneTerrainSystem | null {
    const genre = (engine as unknown as { genreModule?: { worldGenerator?: { getVxlSceneTerrain?: () => VxlSceneTerrainSystem | null } } }).genreModule;
    return genre?.worldGenerator?.getVxlSceneTerrain?.() ?? null;
}

/** Area cleared by one mower pass, in square metres. */
export interface ClearResult {
    /** Mask cells converted this call — 0 when the patch was already cut. */
    cells: number;
    /** `cells` × cell area. The number to award points from. */
    squareMeters: number;
}

/**
 * Cut the long grass under a mower and report how much was actually cut.
 *
 * `onlyReplacing: grassLush` is what keeps this honest: the mower converts long
 * grass and nothing else, so crossing sand, a path or already-cut ground scores
 * zero instead of repainting the world. Call it every frame from the mower's
 * update — cells already cut return 0 and cost nothing.
 */
export function mowAt(
    terrain: VxlSceneTerrainSystem,
    position: THREE.Vector3,
    deckRadius: number,
): ClearResult {
    const cells = terrain.setGroundTypeInRadius(
        position.x, position.z, deckRadius,
        GROUND_TYPE.grassDry,     // what it becomes: short, sparse stubble
        GROUND_TYPE.grassLush,    // what it may replace: only long grass
    );
    const cell = terrain.getGroundMaskCellSize();
    return { cells, squareMeters: cells * cell * cell };
}

/** True when there is still long grass directly under this point. */
export function hasUncutGrass(terrain: VxlSceneTerrainSystem, position: THREE.Vector3): boolean {
    return terrain.getGroundTypeAt(position.x, position.y, position.z) === GROUND_TYPE.grassLush;
}

/**
 * Per-mower running total. Keep one per player (and per AI rival); the winner is
 * simply the highest `squareMeters` when the match timer ends.
 *
 * Drive it from your mower's update with the mower's world position:
 *   `score.add(mowAt(terrain, mower.position, DECK_RADIUS))`
 */
export class ClearedAreaScore {
    private total = 0;

    add(result: ClearResult): void {
        this.total += result.squareMeters;
    }

    /** Total cleared area in square metres. */
    get squareMeters(): number {
        return this.total;
    }

    reset(): void {
        this.total = 0;
    }
}
