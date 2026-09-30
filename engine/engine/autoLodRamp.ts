/**
 * Auto-derived LOD ramp for AI-generated GLB assets (CREATE_ASSET_FROM_GLB_URL).
 *
 * The asset tool has no UI to configure LODs the way the creator's voxelize
 * dialog does, so we auto-derive a small ramp: each level doubles the previous
 * level's min/max voxel size — matching the "+ LOD level" button in
 * `assetsVoxelizeDialog.ts` — clamped to the same bounds. Coarser passes have
 * far fewer leaves, so the extra voxelization cost is modest relative to LOD 0.
 *
 * Passing a non-empty ramp makes `GLBVoxelizer` emit a v4 LOD trailer, which
 * `EnvironmentObjectSystem` consumes for distance-based instancing. No per-LOD
 * `distance` is set here — `deriveLodConfig` falls back to the runtime defaults
 * (DEFAULT_LOD_DISTANCES_M = 70/120/180/240m), which is what we want.
 */

/** Additional LODs beyond LOD 0. A non-zero value → v4 LOD trailer. */
export const AUTO_LOD_LEVELS = 2;
export const AUTO_LOD_MIN_BOUND = 0.02;  // mirrors assetsVoxelizeDialog LOD_MIN_BOUND
export const AUTO_LOD_MIN_MAX = 1.0;     // mirrors assetsVoxelizeDialog LOD_MIN_MAX
export const AUTO_LOD_MAX_BOUND = 4.0;   // mirrors assetsVoxelizeDialog LOD_MAX_BOUND

export interface AutoLodLevel {
    minVoxelSize: number;
    maxVoxelSize: number;
}

export function buildAutoLodRamp(
    baseMinVoxelSize: number,
    baseMaxVoxelSize: number,
    levels: number = AUTO_LOD_LEVELS,
): AutoLodLevel[] {
    const ramp: AutoLodLevel[] = [];
    let prevMin = baseMinVoxelSize;
    let prevMax = baseMaxVoxelSize;
    for (let i = 0; i < levels; i++) {
        const min = Math.min(AUTO_LOD_MIN_MAX, Math.max(AUTO_LOD_MIN_BOUND, prevMin * 2));
        const max = Math.min(AUTO_LOD_MAX_BOUND, Math.max(min, prevMax * 2));
        // Stop once a level can no longer get coarser (both bounds saturated):
        // a duplicate of the previous LOD costs a voxelization pass for nothing.
        if (min === prevMin && max === prevMax) break;
        ramp.push({ minVoxelSize: min, maxVoxelSize: max });
        prevMin = min;
        prevMax = max;
    }
    return ramp;
}
