/**
 * LOD policy for instanced environment objects — the distance schedule and LOD
 * count differ for large BUILDINGS/LANDMARKS vs small PROPS.
 *
 * Buildings dominate the far skyline, so they switch LODs on a WIDE schedule
 * (LOD1 @ 100 m, LOD2 @ 200 m, LOD3 @ 300 m) matching the forged terrain, and get
 * an extra (4th) coarse LOD baked for the 300 m+ band. Small props (benches,
 * hydrants, bushes, trees) keep the tighter default schedule and 3 LODs — a wide
 * schedule on a 2 m prop just wastes fine geometry a few metres further out.
 *
 * The two are told apart purely by size: in the real data every building is
 * ≥ ~14.7 m in its largest dimension and every prop is ≤ ~7.5 m, so a 12 m
 * threshold separates them with a comfortable margin. The engine uses the
 * rendered bounding box; the asset voxelizer uses the forger's allocated fitBox.
 */

/** Largest-dimension (m) at/above which an env asset is treated as a building. */
export const BUILDING_LOD_MAX_DIM_M = 12;

/** Building LOD switch distances (m), index = LOD level. LOD3 @ 300 needs a 4th LOD. */
export const BUILDING_LOD_DISTANCES_M = [0, 100, 200, 300];

/** Prop / default LOD switch distances (m) — unchanged tighter schedule. */
export const PROP_LOD_DISTANCES_M = [0, 70, 120, 180, 240];

/**
 * Multiplier on the per-instance bounding-sphere radius used for frustum
 * culling. A small fudge factor avoids the "object pops out at the corner
 * of the view" artifact when the stored asset bbox is slightly tighter
 * than the actual mesh (common for voxelized GLBs where surface voxels
 * extend a half-voxel past the source bbox).
 */
export const INSTANCE_CULL_SPHERE_MARGIN = 1.15;

/** Additional (beyond LOD0) LOD levels to bake for a building vs a prop. */
export const BUILDING_ADDITIONAL_LODS = 3;
export const PROP_ADDITIONAL_LODS = 2;

/**
 * The most finest-baked LODs any rung DROPS AT LOAD — the level is never meshed, so the
 * saving is CPU and resident geometry, not just polygons drawn.
 *
 * The top rungs drop none; how many a device actually drops is
 * `DeviceQualityPolicy.deferred.envLodDrop`, and this is the ceiling that ladder may not
 * exceed. The count is clamped per asset against the levels it actually baked, so at the
 * full 2 a building (4 levels) keeps LOD2+LOD3 and a prop (3 levels) collapses to its
 * coarsest level alone — a prop is small on screen at the range where the difference would
 * read, and a level's props are what exhaust a phone's memory, not its buildings.
 */
export const MAX_DROPPED_ENV_LODS = 2;

/** True when an asset's largest dimension marks it as a building/landmark. */
export function isBuildingSized(maxDimMeters: number): boolean {
    return maxDimMeters >= BUILDING_LOD_MAX_DIM_M;
}

/** Additional-LOD count to voxelize for an asset of the given largest dimension. */
export function additionalLodsForSize(maxDimMeters: number): number {
    return isBuildingSized(maxDimMeters) ? BUILDING_ADDITIONAL_LODS : PROP_ADDITIONAL_LODS;
}

/**
 * Additional-LOD count for a bake, from whichever size signal the caller has.
 *
 * The forger's allocated `fitBox` is the shared signal: both bake paths see it, so
 * both must read it the same way or the same asset gets a different LOD ladder
 * depending on whether it was forged to a mesh or straight to voxels. With no box
 * the caller passes what it knows instead — the GLB path only has the requested
 * `targetHeight` before it voxelizes, while the master path has already resampled
 * and can pass the true span.
 */
export function additionalLodsForBake(
    fitBox: { x: number; z: number; height: number } | undefined,
    fallbackMaxDimMeters: number,
): number {
    return additionalLodsForSize(fitBox
        ? Math.max(fitBox.x, fitBox.z, fitBox.height)
        : fallbackMaxDimMeters);
}
