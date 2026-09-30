/**
 * Ground-type registry for the baked ground mask (VxlScene v6).
 *
 * CANONICAL copy — the world-forger mirrors these byte values in
 * `game-play-agent/src/mastra/world-forger/city/ground-style.ts` (packages
 * cannot cross-import). Keep the two in lockstep: the forger writes the NAMES
 * into `objectGroundTypes`; the bake maps them to these bytes; the runtime
 * ground-detail consumers classify cells through the helpers below.
 */

import { FoliageType } from 'engine/TerrainTypes.js';

export const GROUND_TYPE = {
    none: 0,
    asphalt: 1,
    cobble: 2,
    brick: 3,
    sidewalk: 4,
    grassLush: 5,
    grass: 6,
    grassDry: 7,
    dirt: 8,
    gravel: 9,
    sand: 10,
    pavers: 11,
} as const;

export type GroundTypeName = keyof typeof GROUND_TYPE;

/** Name → byte, tolerating unknown names from newer forgers (→ 0 = untyped). */
export function groundTypeByte(name: string): number {
    return (GROUND_TYPE as Record<string, number>)[name] ?? GROUND_TYPE.none;
}

/** Cells that get render-only stone detail (domes / brick pairs). */
export function isStoneDetail(t: number): boolean {
    return t === GROUND_TYPE.cobble || t === GROUND_TYPE.brick;
}

/**
 * Ground-cover density factor for a mask byte: fraction of grass cells that
 * spawn a tuft clump (multiplied into the detail system's per-cell rolls).
 * 0 = no grass cover for this type.
 */
export function grassDensity(t: number): number {
    switch (t) {
        case GROUND_TYPE.grassLush: return 1.0;
        case GROUND_TYPE.grass: return 0.6;
        case GROUND_TYPE.grassDry: return 0.25;
        default: return 0;
    }
}

/** Cells that get sparse pebble cover instead of grass. */
export function hasPebbles(t: number): boolean {
    return t === GROUND_TYPE.gravel || t === GROUND_TYPE.dirt;
}

/**
 * The ground cover a surface grows, in the SAME vocabulary the procedural voxel
 * terrain uses (`TerrainTypeProperties.foliageType`). Both worlds answer "what
 * grows here?" with a `FoliageType`, so game code written against one reads the
 * other: a baked level's `grassLush` is MEADOW exactly as a voxel GRASS block is.
 *
 * The two systems still RENDER their cover separately — `VoxelFoliageSystem` is
 * bound to VoxelWorld chunk meshes, `GroundDetailSystem` to the baked mask — this
 * is the shared classification, not shared geometry.
 */
export function groundFoliageType(t: number): FoliageType {
    switch (t) {
        case GROUND_TYPE.grassLush:
        case GROUND_TYPE.grass: return FoliageType.MEADOW;
        case GROUND_TYPE.grassDry: return FoliageType.FIELD;
        case GROUND_TYPE.sand: return FoliageType.BEACH;
        case GROUND_TYPE.dirt:
        case GROUND_TYPE.gravel: return FoliageType.BEACH; // sparse pebbles, no blades
        default: return FoliageType.NONE;
    }
}

/**
 * Tyre grip multiplier for a mask byte: 1.0 = full traction (dry asphalt),
 * lower = the wheels slide. Consumed by the raycast vehicle, which scales wheel
 * friction slip, engine force and braking by it (see `RapierVehicle`), so a car
 * cutting a corner onto grass loses drive and bite the same way it does on
 * procedural voxel terrain.
 *
 * The overlapping values match the voxel-terrain atlas defaults so the SAME
 * surface behaves the same in both worlds (grass 0.8, sand 0.6 — see
 * `VoxelTextureAtlas`). UNTYPED IS 1.0, never a penalty: a level with no ground
 * mask, or a cell no typed node covered, must drive exactly as it did before the
 * mask existed. (Note the atlas's own `getBlockGrip` defaults *unregistered*
 * blocks to 0.5 — half traction for a missing table entry. Do not copy that
 * here: absence of data is not a slippery surface.)
 */
export function groundGrip(t: number): number {
    switch (t) {
        case GROUND_TYPE.asphalt: return 1.0;
        case GROUND_TYPE.sidewalk:
        case GROUND_TYPE.pavers: return 0.95;
        case GROUND_TYPE.cobble:
        case GROUND_TYPE.brick: return 0.85;
        case GROUND_TYPE.grass:
        case GROUND_TYPE.grassDry: return 0.8;
        case GROUND_TYPE.grassLush: return 0.75;
        case GROUND_TYPE.dirt: return 0.7;
        case GROUND_TYPE.gravel: return 0.6;
        case GROUND_TYPE.sand: return 0.6;
        default: return 1.0;
    }
}
