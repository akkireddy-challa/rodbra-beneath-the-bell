/**
 * Voxel terrain → 2D physics colliders.
 *
 * The bridge that lets a voxel world — rendered exactly as it always is — be
 * collided against by Rapier **2D**. It consumes the SAME greedy-merged
 * `CollisionBox` list the 3D trimesh colliders are built from
 * (`VoxelWorld.updateChunkPhysics` assigns it to `chunk.collisionBoxes`, and
 * that assignment happens before any Rapier call precisely so this lane can
 * reuse it), filters it to the gameplay plane, and emits one 2D cuboid per
 * surviving box.
 *
 * WHY A BOX SOUP AND NOT A POLYLINE. Each box is CONVEX, so there are no
 * internal edges for a character to catch on — the artifact that forces
 * `TriMeshFlags.FIX_INTERNAL_EDGES` on the 3D side has nothing to bite here.
 * A polyline would be fewer colliders but reintroduces exactly that seam
 * problem, and greedy merging already keeps the count low (a level slice is
 * hundreds of cuboids, not thousands).
 *
 * PER-MATERIAL FRICTION survives the projection: each cuboid carries its box's
 * `blockType`, and `buildChunkColliders2D` applies `frictionForBlock(blockType)`
 * per collider when the caller supplies it (the 3D lane's `atlas.getBlockGrip`
 * grouping, one collider per box instead of per group). Without the lookup
 * every surface keeps Rapier's default.
 *
 * KNOWN LIMIT, because this consumes `chunk.collisionBoxes` and nothing else:
 * water, merged debris and the smooth-surface heightfield are NOT in
 * `collisionBoxes` — the 3D lane collides those through separate colliders — so
 * the 2D silhouette has holes exactly where they are. That is a limit of the
 * input, not of the slicing; fix it by feeding the other sources in, not by
 * changing the projection.
 *
 * THE SLICE IS ONE VOXEL DEEP, deliberately. A thicker slab makes the collision
 * silhouette the UNION of everything in the slab, so the character walks along
 * the highest surface anywhere in that depth range rather than the one the
 * camera shows — the mismatch is invisible in code and glaring in play.
 */
import RAPIER2D from '@dimforge/rapier2d-compat';
import type { CollisionBox } from 'engine/VoxelGeometry.js';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

/** The slab of world-Z that counts as "on the gameplay plane". */
export interface GameplaySlice {
    /** World-space Z the gameplay plane sits on (the sidescroller's locked Z). */
    z: number;
    /** Half-thickness in metres. One voxel total is the intended default. */
    halfDepth: number;
}

export interface VoxelTerrain2DOptions {
    voxelSize: number;
    /** World-space origin of the chunk the boxes are local to. */
    chunkWorldX: number;
    chunkWorldY: number;
    chunkWorldZ: number;
    slice: GameplaySlice;
    /**
     * Per-material grip for `buildChunkColliders2D` (receives `undefined` for a
     * box with no block type). Absent = Rapier's default friction everywhere.
     */
    frictionForBlock?: (blockType: number | undefined) => number;
}

/** One emitted cuboid, in world space. Exported for testing without a physics world. */
export interface Cuboid2D {
    /** Centre. */
    x: number;
    y: number;
    /** HALF extents, as Rapier's cuboid() takes. */
    hx: number;
    hy: number;
    /** The source box's block type, when it had one — what per-material friction keys on. */
    blockType?: number;
}

/**
 * Project the boxes of one chunk onto the gameplay plane.
 *
 * Pure: no Rapier, no world — so the projection is unit-testable on its own,
 * which is where the arithmetic mistakes actually live.
 */
export function sliceBoxesToPlane(
    boxes: readonly CollisionBox[],
    options: VoxelTerrain2DOptions,
): Cuboid2D[] {
    const { voxelSize, chunkWorldX, chunkWorldY, chunkWorldZ, slice } = options;
    const sliceMin = slice.z - slice.halfDepth;
    const sliceMax = slice.z + slice.halfDepth;
    const out: Cuboid2D[] = [];

    for (const box of boxes) {
        // The box occupies [z, z + d) voxels from the chunk origin.
        const zMin = chunkWorldZ + box.z * voxelSize;
        const zMax = zMin + box.d * voxelSize;
        // Half-open overlap: a box that merely TOUCHES the slice boundary is not
        // on the plane. Without this, the two chunks either side of a boundary
        // both contribute a collider at the same X and the character walks into
        // a doubled wall.
        if (zMax <= sliceMin || zMin >= sliceMax) continue;

        const xMin = chunkWorldX + box.x * voxelSize;
        const yMin = chunkWorldY + box.y * voxelSize;
        const w = box.w * voxelSize;
        const h = box.h * voxelSize;
        const cuboid: Cuboid2D = { x: xMin + w / 2, y: yMin + h / 2, hx: w / 2, hy: h / 2 };
        if (box.blockType !== undefined) cuboid.blockType = box.blockType;
        out.push(cuboid);
    }
    return out;
}

/**
 * Build the 2D colliders for one chunk and attach them to a fixed body.
 *
 * Returns the colliders so a caller can retire exactly this chunk's set when the
 * chunk is rebuilt — the streaming case rebuilds per chunk, never wholesale.
 */
export function buildChunkColliders2D(
    world: PhysicsWorld2D,
    body: RAPIER2D.RigidBody,
    boxes: readonly CollisionBox[],
    options: VoxelTerrain2DOptions,
): RAPIER2D.Collider[] {
    const groups = makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN);
    const colliders: RAPIER2D.Collider[] = [];
    // `sliceBoxesToPlane` returns WORLD space; `ColliderDesc.setTranslation` is
    // BODY-LOCAL. Subtracting the body's own translation is what makes the two
    // agree — without it the colliders are correct only for a body at the
    // origin, and silently offset by the body's position for any other, which
    // is the kind of error that looks fine in the first test anyone writes.
    const origin = body.translation();
    const frictionForBlock = options.frictionForBlock;
    for (const c of sliceBoxesToPlane(boxes, options)) {
        const desc = RAPIER2D.ColliderDesc.cuboid(c.hx, c.hy)
            .setTranslation(c.x - origin.x, c.y - origin.y)
            .setCollisionGroups(groups)
            // Terrain contacts must raise events for the same reasons they do in
            // 3D (collision callbacks, debris, gameplay hooks).
            .setActiveEvents(RAPIER2D.ActiveEvents.COLLISION_EVENTS);
        if (frictionForBlock) desc.setFriction(frictionForBlock(c.blockType));
        colliders.push(world.createCollider(desc, body));
    }
    return colliders;
}
