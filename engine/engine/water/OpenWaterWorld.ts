/**
 * Helpers for a world whose only surface is the sea.
 *
 * An open-water game has no terrain at all — no voxel ground, no heightmap, no
 * seafloor. That breaks an assumption baked into scenery placement: every
 * placed object normally asks the terrain how high the ground is under it. With
 * no terrain the answer is 0, so an island authored at y = -18 (its base well
 * under the surface) gets yanked up to the waterline, and the whole archipelago
 * ends up floating as a ring of flat discs.
 *
 * `pinEnvironmentObjectsToAuthoredPositions` is the fix: it marks every placed
 * object as absolutely positioned before the scenery pass runs, so world.json's
 * Y is used verbatim.
 */

/** The subset of a placed environment object this module touches. */
interface PlaceableObject {
    forcePosition?: boolean;
    placeOnTerrain?: boolean;
    flattenTerrain?: boolean;
}

interface GameDataWithObjects {
    environmentObjects?: PlaceableObject[];
}

/**
 * Force every placed environment object to keep its authored world.json
 * position. Mutates the IN-MEMORY game data only — world.json on disk is
 * untouched, so this never rewrites what the creator authored.
 *
 * Returns how many objects were pinned, for logging.
 */
export function pinEnvironmentObjectsToAuthoredPositions(gameData: unknown): number {
    const objects = (gameData as GameDataWithObjects | null | undefined)?.environmentObjects;
    if (!objects || objects.length === 0) return 0;
    for (const obj of objects) {
        obj.forcePosition = true;
        obj.placeOnTerrain = false;
        obj.flattenTerrain = false;
    }
    return objects.length;
}
