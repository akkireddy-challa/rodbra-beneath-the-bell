/**
 * Placed voxel objects → 2D physics on the gameplay plane.
 *
 * A placed object's collision shape is its greedy-meshed `PhysicsBox` list
 * (`VoxelObject.getPhysicsBoxes()`), in the object's LOCAL frame. The 3D lane
 * attaches those boxes to a body carrying the instance transform; the 2D lane
 * has no Z, so the transform is applied HERE — every box becomes a world-space
 * AABB (scale, then rotation, then translation, the same composition the
 * InstancedMesh matrix uses) — and only the boxes whose Z extent overlaps the
 * gameplay slab survive, projected to X/Y cuboids.
 *
 * ROTATION IS CONSERVATIVE. Yaw multiples of 90° keep a box axis-aligned and
 * the projection is exact. Any other rotation is represented by the rotated
 * box's world AABB — a slightly larger silhouette, never a smaller one, so the
 * character can never walk INTO a rotated prop. Side-on levels place props
 * unrotated or turned by 90°, which is why v1 stops here.
 *
 * TWO PLANES. `envBoxesToPlaneCuboids` is the side-on lane (X/Y plane, a slab
 * of Z). `envBoxesToGroundCuboids` is the top-down lane (X/Z plane): the slab is
 * a band of world Y above the ground the object stands on — geometry a
 * character could step over (below `TOP_DOWN_STEP_MAX_M`) or walk under (above
 * `TOP_DOWN_HEAD_CLEARANCE_M`) is not an obstacle, everything in between is.
 *
 * Pure: no Rapier, no THREE — testable on its own.
 */
import type { PhysicsBox } from 'engine/VoxelOctreeRenderer.js';
import type { Cuboid2D, GameplaySlice } from 'engine/physics/VoxelTerrain2D.js';
import { TOP_DOWN_HEAD_CLEARANCE_M, TOP_DOWN_STEP_MAX_M, type GroundRect } from 'engine/physics/TopDownGround.js';

export interface EnvTransform {
    translation: { x: number; y: number; z: number };
    /** Unit quaternion. */
    rotation: { x: number; y: number; z: number; w: number };
    scale: { x: number; y: number; z: number };
}

/**
 * Half-thickness of the slab that counts as "on the gameplay plane" for placed
 * objects: one metre total, centred on the plane. The side-on forger places
 * gameplay props one block deep AT the plane and backdrop décor well behind it
 * (≥ 2.5 m), so this separates the two for every voxel block size the lane
 * ships; a thinner slab would drop a one-block prop whose voxel size exceeds
 * the slab.
 */
export const ENV_SLAB_HALF_DEPTH_M = 0.5;

export function envSliceFor(planeZ: number): GameplaySlice {
    return { z: planeZ, halfDepth: ENV_SLAB_HALF_DEPTH_M };
}

function rotate(q: EnvTransform['rotation'], x: number, y: number, z: number): [number, number, number] {
    // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    const cx = q.y * z - q.z * y + q.w * x;
    const cy = q.z * x - q.x * z + q.w * y;
    const cz = q.x * y - q.y * x + q.w * z;
    return [
        x + 2 * (q.y * cz - q.z * cy),
        y + 2 * (q.z * cx - q.x * cz),
        z + 2 * (q.x * cy - q.y * cx),
    ];
}

/** A box's world-space AABB after the instance transform. */
interface WorldAabb { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

function worldAabb(box: PhysicsBox, transform: EnvTransform): WorldAabb {
    const { translation: t, rotation: q, scale: s } = transform;
    const cx = box.cx * s.x, cy = box.cy * s.y, cz = box.cz * s.z;
    const hx = Math.abs(box.hx * s.x), hy = Math.abs(box.hy * s.y), hz = Math.abs(box.hz * s.z);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < 8; i++) {
        const [x, y, z] = rotate(q, cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz));
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX: minX + t.x, minY: minY + t.y, minZ: minZ + t.z, maxX: maxX + t.x, maxY: maxY + t.y, maxZ: maxZ + t.z };
}

/**
 * World-space X/Y cuboids for the boxes that lie on the plane. Returns world
 * coordinates; a caller attaching them to a body subtracts the body's own
 * translation (see `PlaneLockedPhysics.createEnvironmentBody`).
 */
export function envBoxesToPlaneCuboids(
    boxes: readonly PhysicsBox[],
    transform: EnvTransform,
    slice: GameplaySlice,
): Cuboid2D[] {
    const sliceMin = slice.z - slice.halfDepth;
    const sliceMax = slice.z + slice.halfDepth;
    const out: Cuboid2D[] = [];
    for (const box of boxes) {
        const a = worldAabb(box, transform);
        // Half-open, like the terrain slicer: touching the slab is not being in it.
        if (a.maxZ <= sliceMin || a.minZ >= sliceMax) continue;
        const halfW = (a.maxX - a.minX) / 2, halfH = (a.maxY - a.minY) / 2;
        if (halfW <= 0 || halfH <= 0) continue;
        out.push({ x: (a.minX + a.maxX) / 2, y: (a.minY + a.maxY) / 2, hx: halfW, hy: halfH });
    }
    return out;
}

/** A top-down obstacle cuboid: 2D y is world Z, and `topY` is the box's world-Y top (what a vertical probe reports). */
export interface GroundCuboid2D extends Cuboid2D {
    topY: number;
}

/**
 * World-space X/Z cuboids for the boxes a character on the ground would walk
 * INTO. `groundY` is the terrain height under the object (null when unknown —
 * then the object's own base is the ground, which is where placed props sit).
 * The obstacle band is `[ground + step, ground + head clearance)`: a floor
 * tile or a kerb is stepped over, an arch or a balcony is walked under.
 */
export function envBoxesToGroundCuboids(
    boxes: readonly PhysicsBox[],
    transform: EnvTransform,
    groundY: number | null,
): GroundCuboid2D[] {
    const aabbs = boxes.map((box) => worldAabb(box, transform));
    let base = groundY;
    if (base === null) {
        base = Infinity;
        for (const a of aabbs) if (a.minY < base) base = a.minY;
        if (!Number.isFinite(base)) return [];
    }
    const bandMin = base + TOP_DOWN_STEP_MAX_M;
    const bandMax = base + TOP_DOWN_HEAD_CLEARANCE_M;
    const out: GroundCuboid2D[] = [];
    for (const a of aabbs) {
        if (a.maxY <= bandMin || a.minY >= bandMax) continue;
        const halfW = (a.maxX - a.minX) / 2, halfD = (a.maxZ - a.minZ) / 2;
        if (halfW <= 0 || halfD <= 0) continue;
        out.push({ x: (a.minX + a.maxX) / 2, y: (a.minZ + a.maxZ) / 2, hx: halfW, hy: halfD, topY: a.maxY });
    }
    return out;
}

/**
 * A terrain-registered object (a baked level map loaded as a `VoxelObject`) on
 * the ground plane: every box is a patch of FLOOR at its top, not an obstacle
 * band — the heightmap and its cliff walls take it from there.
 */
export function envBoxesToGroundRects(boxes: readonly PhysicsBox[], transform: EnvTransform): GroundRect[] {
    const out: GroundRect[] = [];
    for (const box of boxes) {
        const a = worldAabb(box, transform);
        if (a.maxX <= a.minX || a.maxZ <= a.minZ) continue;
        out.push({ minX: a.minX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ, topY: a.maxY });
    }
    return out;
}
