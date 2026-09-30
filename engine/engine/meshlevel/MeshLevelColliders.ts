/**
 * MeshLevelColliders — the pure half of MeshLevel: turns validated collider
 * records into the numeric specs `PhysicsBodyFactory.createStaticBody` wants,
 * answers oriented-box containment for volumes, and derives the level's
 * extent. No renderer, no physics world, no DOM — tested under ts-jest node.
 *
 * Yaw follows agent-docs/coordinate-system.md: radians about +Y, the gameplay
 * convention where an entity's forward at yaw θ is (sin θ, 0, cos θ).
 */
import * as THREE from 'three';
import type { ColliderShape } from 'engine/physics/PhysicsBodyFactory.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import type { RasterTriangle } from 'engine/GlbColliderBuilder.js';
import type { TerrainBounds } from 'engine/DynamicObjectManager.js';
import type { XZBounds } from 'engine/syncGroundWorldSizeToBakedLevel.js';
import type { MeshLevelCollider, MeshLevelCollisionGroup, MeshLevelHeightfieldCollider, MeshLevelVec3 } from 'engine/meshlevel/MeshLevelSchema.js';

export interface ColliderPlan {
    name: string;
    group: MeshLevelCollisionGroup;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    shape: ColliderShape;
    collisionGroup: number;
    collisionMask: number;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Rotation about +Y by `yaw` radians, as a quaternion. */
export function yawQuaternion(yaw: number): THREE.Quaternion {
    return new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw);
}

/**
 * Rapier group/mask pair for a level collider. `terrain` is the default: the
 * camera always collides with TERRAIN, ground rays probe TERRAIN | ENVIRONMENT,
 * and the spawn finder reads "full surface well above TERRAIN" as a prop top,
 * so floors and walls on TERRAIN with world.json props on ENVIRONMENT reproduce
 * baked-level semantics. `environment` is for crates and furniture that should
 * read as obstacles rather than ground.
 */
export function collisionLayersFor(group: MeshLevelCollisionGroup): { collisionGroup: number; collisionMask: number } {
    return group === 'terrain'
        ? { collisionGroup: CollisionGroup.TERRAIN, collisionMask: CollisionMask.TERRAIN }
        : { collisionGroup: CollisionGroup.ENVIRONMENT, collisionMask: CollisionMask.ENVIRONMENT };
}

/**
 * Numeric static-body spec for one collider record; `defaultGroup` applies when
 * the record names none. Hull and trimesh vertices are world space, so those
 * bodies sit at the origin.
 */
export function planCollider(collider: MeshLevelCollider, defaultGroup: MeshLevelCollisionGroup): ColliderPlan {
    const group = collider.group ?? defaultGroup;
    const layers = collisionLayersFor(group);
    switch (collider.shape) {
        case 'box':
            return {
                name: collider.name,
                group,
                position: new THREE.Vector3(...collider.position),
                quaternion: yawQuaternion(collider.yaw),
                shape: { type: 'box', halfExtents: new THREE.Vector3(collider.size[0] / 2, collider.size[1] / 2, collider.size[2] / 2) },
                ...layers,
            };
        case 'convexHull':
            return {
                name: collider.name,
                group,
                position: new THREE.Vector3(0, 0, 0),
                quaternion: new THREE.Quaternion(),
                shape: { type: 'convexHull', vertices: new Float32Array(collider.vertices) },
                ...layers,
            };
        case 'trimesh':
            return {
                name: collider.name,
                group,
                position: new THREE.Vector3(0, 0, 0),
                quaternion: new THREE.Quaternion(),
                shape: { type: 'trimesh', vertices: new Float32Array(collider.vertices), indices: new Uint32Array(collider.indices) },
                ...layers,
            };
        case 'heightfield': {
            // Row-major along X (the record) → Rapier's column-major with rows along Z.
            const { nx, nz, cellSize } = collider;
            const heights = new Float32Array((nx + 1) * (nz + 1));
            for (let j = 0; j <= nz; j++) {
                for (let i = 0; i <= nx; i++) heights[i * (nz + 1) + j] = collider.heights[j * (nx + 1) + i]!;
            }
            const sizeX = nx * cellSize;
            const sizeZ = nz * cellSize;
            return {
                name: collider.name,
                group,
                position: new THREE.Vector3(collider.minX + sizeX / 2, 0, collider.minZ + sizeZ / 2),
                quaternion: new THREE.Quaternion(),
                shape: { type: 'heightfield', nrows: nz, ncols: nx, heights, scale: new THREE.Vector3(sizeX, 1, sizeZ) },
                ...layers,
            };
        }
    }
}

/**
 * Whether `point` lies inside an oriented box. The world offset is rotated by
 * −yaw into the box's local frame (inverse of the +Y rotation), then compared
 * against the half extents.
 */
export function orientedBoxContains(point: { x: number; y: number; z: number }, position: MeshLevelVec3, size: MeshLevelVec3, yaw: number): boolean {
    const dx = point.x - position[0];
    const dy = point.y - position[1];
    const dz = point.z - position[2];
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const localX = c * dx - s * dz;
    const localZ = s * dx + c * dz;
    return Math.abs(localX) <= size[0] / 2 && Math.abs(dy) <= size[1] / 2 && Math.abs(localZ) <= size[2] / 2;
}

/**
 * Bilinear ground height of a heightfield collider at world (x, z), or null off the grid —
 * the same surface Rapier collides with, sampled without a raycast.
 */
export function sampleHeightfield(collider: MeshLevelHeightfieldCollider, x: number, z: number): number | null {
    const fx = (x - collider.minX) / collider.cellSize;
    const fz = (z - collider.minZ) / collider.cellSize;
    if (fx < 0 || fz < 0 || fx > collider.nx || fz > collider.nz) return null;
    const i = Math.min(Math.floor(fx), collider.nx - 1);
    const j = Math.min(Math.floor(fz), collider.nz - 1);
    const tx = fx - i;
    const tz = fz - j;
    const row = collider.nx + 1;
    const h = collider.heights;
    const h00 = h[j * row + i]!;
    const h10 = h[j * row + i + 1]!;
    const h01 = h[(j + 1) * row + i]!;
    const h11 = h[(j + 1) * row + i + 1]!;
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** World AABB covering every collider, or null when there are none. */
export function colliderBounds(colliders: ReadonlyArray<MeshLevelCollider>): TerrainBounds | null {
    let bounds: TerrainBounds | null = null;
    const extend = (x: number, y: number, z: number) => {
        if (!bounds) { bounds = { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z }; return; }
        bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y); bounds.minZ = Math.min(bounds.minZ, z);
        bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y); bounds.maxZ = Math.max(bounds.maxZ, z);
    };
    const corner = new THREE.Vector3();
    for (const collider of colliders) {
        if (collider.shape === 'box') {
            const q = yawQuaternion(collider.yaw);
            const [hx, hy, hz] = [collider.size[0] / 2, collider.size[1] / 2, collider.size[2] / 2];
            for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
                corner.set(sx * hx, sy * hy, sz * hz).applyQuaternion(q);
                extend(corner.x + collider.position[0], corner.y + collider.position[1], corner.z + collider.position[2]);
            }
        } else if (collider.shape === 'heightfield') {
            let lo = Infinity;
            let hi = -Infinity;
            for (const h of collider.heights) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
            extend(collider.minX, lo, collider.minZ);
            extend(collider.minX + collider.nx * collider.cellSize, hi, collider.minZ + collider.nz * collider.cellSize);
        } else {
            for (let i = 0; i + 2 < collider.vertices.length; i += 3) {
                extend(collider.vertices[i]!, collider.vertices[i + 1]!, collider.vertices[i + 2]!);
            }
        }
    }
    return bounds;
}

/** Union of two AABBs (either may be null). */
export function unionBounds(a: TerrainBounds | null, b: TerrainBounds | null): TerrainBounds | null {
    if (!a) return b;
    if (!b) return a;
    return {
        minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ),
        maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ),
    };
}

/**
 * The origin-centred footprint that contains `bounds`. NPC spawn clamping
 * (`findValidatedSpawnPosition`) reads `groundWorldSizeX/Z` as a centred
 * [−size/2, size/2] box, so an off-centre level must grow the size to its
 * farthest edge on each axis, not just its width.
 */
export function symmetricExtent(bounds: TerrainBounds): XZBounds {
    const halfX = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX));
    const halfZ = Math.max(Math.abs(bounds.minZ), Math.abs(bounds.maxZ));
    return { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ };
}

/** Adapt a flat vertex/index soup (one GLB node) to the collider builder's triangle records. */
export function soupToRasterTriangles(verts: Float32Array, indices: Uint32Array, nodeName: string): RasterTriangle[] {
    const tris: RasterTriangle[] = [];
    const grey = { r: 0.5, g: 0.5, b: 0.5 };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const i0 = indices[i]! * 3, i1 = indices[i + 1]! * 3, i2 = indices[i + 2]! * 3;
        a.set(verts[i0]!, verts[i0 + 1]!, verts[i0 + 2]!);
        b.set(verts[i1]!, verts[i1 + 1]!, verts[i1 + 2]!);
        c.set(verts[i2]!, verts[i2 + 1]!, verts[i2 + 2]!);
        n.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        if (n.lengthSq() === 0) continue; // degenerate
        n.normalize();
        tris.push({
            v0: [a.x, a.y, a.z], v1: [b.x, b.y, b.z], v2: [c.x, c.y, c.z],
            normal: [n.x, n.y, n.z],
            nodeName,
            sampleColor: () => grey,
        });
    }
    return tris;
}
