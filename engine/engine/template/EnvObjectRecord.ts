/**
 * Pure construction of the `environmentObjects[]` record written to `world.json`.
 *
 * This is the SINGLE write path for voxel object placement: both
 * `PLACE_VOXEL_OBJECT` and `BATCH_PLACE_VOXEL_OBJECTS` build their record here,
 * and the voxel CLI persists whatever comes back verbatim. A per-instance flag
 * that the runtime reads but that is missing from `INSTANCE_FLAG_FIELDS` below is
 * silently dropped from `world.json` — the value never survives the round-trip.
 *
 * ⇒ When you add a new per-instance placement flag, add it to
 *   `INSTANCE_FLAG_FIELDS` AND to `__tests__/EnvObjectRecord.test.ts`. The test
 *   round-trips every flag so an omission fails loudly instead of silently.
 *
 * Kept free of THREE / heavy engine imports on purpose so it stays trivially
 * unit testable in isolation. The one allowed import is the level registry —
 * a zero-runtime-dependency module (type-only imports) that reports the
 * active level id for instance tagging.
 */
import { getActiveLevelIdOrNull } from 'engine/levels/levelManagerRegistry.js';

/** The asset a placement names by id — `undefined` when it names none, or none matches. */
export function findAssetById<A extends { id: string }>(assets: A[] | undefined, assetId: string | undefined): A | undefined {
    if (!assets || !assetId) return undefined;
    return assets.find((a) => a.id === assetId);
}

/** Shared shape for the single-place / batch-place payloads' transform fields. */
export interface VoxelPlacementInput {
    asset_name: string;
    /**
     * The asset's id, when the caller knows it. Preferred over `asset_name`: a
     * world that has seen several forges holds several assets with one name
     * (every forge bakes its own `Fixture_lamp_wall`), and a name lookup then
     * picks whichever comes first. Optional so older callers keep working.
     */
    asset_id?: string;
    position: { x: number; z: number; y?: number };
    rotation?: { x: number; y: number; z: number };
    scale?: { x: number; y: number; z: number };
    name?: string;
    interactable?: boolean;
    placeOnTerrain?: boolean;
    collectible?: boolean;
    destructible?: boolean;
    /** Individual VoxelObject with a dynamic physics body — required for props
     *  gameplay code moves at runtime (kicked balls, pushed crates). Without it
     *  the prop is batched into a static InstancedMesh and cannot be moved.
     *  With an asset whose `colliderShape` is 'sphere', the instance rolls. */
    dynamic?: boolean;
    /** Authored mass in kg for `dynamic` instances (a traffic cone ~4, a trash
     *  can ~15, a crate ~40). Omitted → estimated from the asset's bounding-box
     *  volume, which overestimates sparse shapes. Ignored for static props. */
    mass?: number;
    flatten_terrain?: boolean;
    force_position?: boolean;
    /**
     * Per-instance collision opt-out. Default true (collider created); set false
     * for purely decorative props (vegetation, etc.) the player and NPCs walk
     * straight through. Read at runtime by EnvironmentObjectSystem /
     * PlacedObjectSystem as `objDef.collision ?? asset.collision`.
     */
    collision?: boolean;
}

/**
 * How a placement flag is copied onto the world.json record:
 * - `flag`         — write `true` when the input value is truthy, omit otherwise
 *                    (boolean flags that only exist in the record when enabled).
 * - `truthyValue`  — write the literal value when truthy (e.g. a non-empty name).
 * - `definedValue` — write the literal value whenever it is not `undefined`
 *                    (flags whose `false` is meaningful, e.g. a collision opt-out).
 */
type FlagMode = 'flag' | 'truthyValue' | 'definedValue';

interface InstanceFlagField {
    /** Key on the placement input. */
    readonly in: keyof VoxelPlacementInput;
    /** Key written to the record (defaults to `in` when omitted). */
    readonly out?: string;
    readonly mode: FlagMode;
}

/**
 * The complete set of per-instance placement flags forwarded to `world.json`.
 * This is the one list to extend when adding a new flag — see the file header.
 */
export const INSTANCE_FLAG_FIELDS: ReadonlyArray<InstanceFlagField> = [
    { in: 'name', mode: 'truthyValue' },
    { in: 'interactable', mode: 'flag' },
    { in: 'placeOnTerrain', mode: 'flag' },
    { in: 'collectible', mode: 'flag' },
    { in: 'destructible', mode: 'flag' },
    { in: 'dynamic', mode: 'flag' },
    { in: 'mass', mode: 'definedValue' },
    { in: 'force_position', out: 'forcePosition', mode: 'flag' },
    { in: 'flatten_terrain', out: 'flattenTerrain', mode: 'definedValue' },
    { in: 'collision', mode: 'definedValue' },
];

/**
 * The level tag every NEWLY created instance must carry.
 *
 * Untagged means global — the instance loads in EVERY level (see
 * `levelResolve.isInstanceInActiveLevel`), which a live placement never is: the
 * user/agent placed it in the level open right now. Legacy games (no `levels[]`)
 * get `{}` so nothing changes for them.
 *
 * Spread this into the record at EVERY "new instance" write path — the editor's
 * PlacedObjectSystem, the voxel place/batch-place handlers, the voxel-object
 * save service. A path that forgets it silently makes the object appear in
 * every level.
 */
export function activeLevelTag(): { levelId?: string } {
    const activeLevelId = getActiveLevelIdOrNull();
    return activeLevelId !== null ? { levelId: activeLevelId } : {};
}

/** Convert degree-typed Euler angles (the wire format) to radians. */
export function rotationDegToRad(rotation?: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    if (!rotation) return { x: 0, y: 0, z: 0 };
    const D = Math.PI / 180;
    return {
        x: (rotation.x || 0) * D,
        y: (rotation.y || 0) * D,
        z: (rotation.z || 0) * D,
    };
}

/** Build the env-object record stored in `currentGameData.environmentObjects[]`. */
export function buildEnvObject(
    input: VoxelPlacementInput,
    assetId: string,
    instanceId: string,
    position: { x: number; y: number; z: number },
): Record<string, unknown> {
    const env: Record<string, unknown> = {
        id: instanceId,
        type: input.asset_name,
        assetId,
        position,
        rotation: rotationDegToRad(input.rotation),
        scale: input.scale ?? { x: 1, y: 1, z: 1 },
        ...activeLevelTag(),
    };
    for (const field of INSTANCE_FLAG_FIELDS) {
        const value = input[field.in];
        const out = field.out ?? field.in;
        switch (field.mode) {
            case 'flag':
                if (value) env[out] = true;
                break;
            case 'truthyValue':
                if (value) env[out] = value;
                break;
            case 'definedValue':
                if (value !== undefined) env[out] = value;
                break;
        }
    }
    return env;
}
