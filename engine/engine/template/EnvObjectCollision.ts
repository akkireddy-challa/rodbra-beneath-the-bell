/**
 * Read-side decision for a placed environment / voxel object: does it get a
 * physics collider (and count as a navmesh obstacle)?
 *
 * Per-instance `collision` (from the world.json env-object def) overrides the
 * asset-level `collision` flag; both default to true. `collision: false` marks
 * purely decorative props (vegetation, etc.) the player and NPCs walk straight
 * through — no collider, and no navmesh obstacle so NPCs don't path around them.
 *
 * This is the single source of truth for that decision: EnvironmentObjectSystem
 * (every collider/obstacle path) and PlacedObjectSystem both call it, so a new
 * collider path can't quietly forget the opt-out. The matching WRITE side that
 * puts `collision` into world.json lives in EnvObjectRecord.ts.
 *
 * Kept free of THREE / engine imports so it stays trivially unit testable.
 */
export function envObjectCollides(
    objDef: { collision?: boolean } | null | undefined,
    asset: { collision?: boolean } | null | undefined,
): boolean {
    return (objDef?.collision ?? asset?.collision) !== false;
}
