import type { EngineLike } from 'types/game.js';

/** The X/Z footprint of a baked level — the subset of the terrain systems' bounds we need. */
export interface XZBounds {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

/**
 * Grow `worldProfileData.groundWorldSizeX/Z` (in memory) to match a baked (.vwld) level's
 * footprint when the level is larger than the configured ground.
 *
 * `groundWorldSizeX/Z` is sized for the small procedural fallback plane (often the 64 m
 * default), but a baked level defines the real playable extent (e.g. a 768 m city). Anything
 * keyed off world size then uses the wrong, tiny value — most visibly NPC/animal spawn
 * clamping (`findValidatedSpawnPosition`), which collapses every spawn into a corner, and
 * top-down / screenshot camera framing. Call this once the level's bounds are known.
 *
 * Only ever grows the value, never shrinks it, and never touches the on-disk world.json —
 * the correction is recomputed from the level on every load.
 */
export function syncGroundWorldSizeToBakedLevel(engine: EngineLike, bounds: XZBounds): void {
    const worldProfile = engine.getGameData?.()?.worldProfileData;
    if (!worldProfile) return;

    const sizeX = bounds.maxX - bounds.minX;
    const sizeZ = bounds.maxZ - bounds.minZ;
    worldProfile.groundWorldSizeX = Math.max(worldProfile.groundWorldSizeX ?? 0, sizeX);
    worldProfile.groundWorldSizeZ = Math.max(worldProfile.groundWorldSizeZ ?? 0, sizeZ);
}
