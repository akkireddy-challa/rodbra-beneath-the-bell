import RAPIER from '@dimforge/rapier3d-compat';

/** Options for VoxelObject.createDynamicPhysicsBody(). */
export interface DynamicPhysicsBodyOptions {
    /**
     * Collider shape:
     * - 'box' (default): cuboid colliders aggregated from the voxel grid
     * - 'sphere': single sphere collider sized to the voxel bounds, so the
     *   object rolls (soccer balls, boulders). Tuned via DEFAULT_BALL_PHYSICS;
     *   the `mass` parameter is ignored (mass comes from density × volume,
     *   keeping balls light enough to kick).
     */
    colliderShape: 'box' | 'sphere';
    /**
     * Create the body ASLEEP. For props placed at load time (street furniture,
     * knockable scatters) this skips the settle wave — hundreds of bodies
     * jittering through their first second — while any real contact (a vehicle,
     * a push, an explosion impulse) wakes them normally. Leave false for
     * runtime spawns that must move immediately (knocked-over trees, balls).
     */
    startAsleep: boolean;
}

export const DEFAULT_DYNAMIC_PHYSICS_BODY_OPTIONS: DynamicPhysicsBodyOptions = {
    colliderShape: 'box',
    startAsleep: false,
};

/** Rolling-ball tuning for sphere-collider dynamic objects (see mechanic-soccer.md). */
export const DEFAULT_BALL_PHYSICS = {
    friction: 0.6,
    restitution: 0.55,
    linearDamping: 0.6,
    angularDamping: 0.4,
    density: 0.4,
};

/**
 * True a dynamic body up to its requested mass by rescaling collider densities.
 * Densities are derived from the SOURCE voxel volume, but the physics colliders
 * are a coarser cover (octree aggregation, greedy boxes), so the body comes out
 * heavier than asked — ~2x on sparse shapes. An authored mass ("this cone is
 * 4 kg") must be honored exactly.
 */
export function trueUpBodyMass(
    body: { mass(): number },
    colliders: Array<{ density(): number; setDensity(d: number): void }>,
    targetMass: number,
): void {
    const actual = body.mass();
    if (actual <= 0 || targetMass <= 0 || Math.abs(actual - targetMass) / targetMass <= 0.01) return;
    const fix = targetMass / actual;
    for (const c of colliders) {
        c.setDensity(c.density() * fix);
    }
}

/**
 * Minimal view of a Rapier collider for radius estimation: a cuboid, or any
 * round shape that exposes `radius` — a Ball, or the zero-length capsule
 * `sphereColliderDesc` builds.
 */
export interface ColliderShapeView {
    translation(): { x: number; y: number; z: number };
    shape: { halfExtents?: { x: number; y: number; z: number }; radius?: number };
}

/**
 * Estimate a dynamic prop's bounding radius (m) from its actual physics
 * colliders — the maximum half-extent from `center` along any axis.
 *
 * Prefer this over `VoxelObject.getBoundsInWorldUnits()` when you need a
 * world-unit size: collider geometry is always in world units, whereas a VXL's
 * stored `bounds` metadata can be malformed (encoded in voxel-grid units),
 * which inflates a bounds-derived radius by 1/voxelSize (e.g. a 0.2 m ball read
 * as 4.0 m). The kick/contact gate must match the ball physics actually sees.
 */
export function computeColliderRadius(
    colliders: ColliderShapeView[],
    center: { x: number; y: number; z: number },
    fallback = 0.4,
): number {
    let radius = 0;
    for (const c of colliders) {
        const pos = c.translation();
        const he = c.shape.halfExtents
            ?? (typeof c.shape.radius === 'number'
                ? { x: c.shape.radius, y: c.shape.radius, z: c.shape.radius }
                : null);
        if (!he) continue;
        radius = Math.max(
            radius,
            Math.abs(pos.x - center.x) + he.x,
            Math.abs(pos.y - center.y) + he.y,
            Math.abs(pos.z - center.z) + he.z,
        );
    }
    return radius > 0 ? radius : fallback;
}

/**
 * The collider for anything spherical that MOVES — a rolling ball, a bail
 * body, a projectile. A zero-length capsule, never `ColliderDesc.ball`.
 *
 * Geometrically the two are the same object: a capsule with no segment is a
 * sphere — same surface, same mass properties, and it rolls. What differs is
 * the contact code path. In the Rapier this engine ships (rapier3d-compat
 * 0.20.0 = rapier 0.35.0 + parry 0.30.2) the ball-vs-Voxels manifold is
 * generated per voxel and rebuilt from scratch every step, which orphans the
 * solver's contact-graph slots the moment a fast ball's contact set collapses
 * — a wall, a block edge, a chunk seam, at roughly 3 m/s or more — and the
 * WASM dies with `RuntimeError: unreachable`, taking every later physics call
 * with it (dimforge/rapier#993, open; its reproduction panics verbatim against
 * our bundle). Every static voxel object is a Voxels collider, so a real Ball
 * shape on a dynamic body is a crash waiting for the first kick. Capsule
 * contacts go through the general convex path and survive the same impacts.
 *
 * Revisit when a Rapier release closes #993. Until then no dynamic body in the
 * engine may carry a Ball shape; sensors (pickups, drop zones) never generate
 * contacts and are unaffected.
 */
export function sphereColliderDesc(radius: number): RAPIER.ColliderDesc {
    return RAPIER.ColliderDesc.capsule(0, radius);
}

/**
 * Build the single sphere collider for a sphere-collider dynamic object:
 * radius is half the largest bounds dimension, centered on the bounds center
 * expressed relative to the body pivot. Mass is density-driven
 * (DEFAULT_BALL_PHYSICS.density), not caller-supplied.
 */
export function createBallColliderDesc(
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null,
    pivot: { x: number; y: number; z: number },
    collisionGroups: number
): RAPIER.ColliderDesc {
    const radius = bounds
        ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) / 2
        : 0.5;
    const center = bounds
        ? {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
            z: (bounds.minZ + bounds.maxZ) / 2,
        }
        : { x: 0, y: 0, z: 0 };
    return sphereColliderDesc(Math.max(radius, 0.05))
        .setTranslation(center.x - pivot.x, center.y - pivot.y, center.z - pivot.z)
        .setCollisionGroups(collisionGroups)
        .setFriction(DEFAULT_BALL_PHYSICS.friction)
        .setRestitution(DEFAULT_BALL_PHYSICS.restitution)
        .setDensity(DEFAULT_BALL_PHYSICS.density);
}
