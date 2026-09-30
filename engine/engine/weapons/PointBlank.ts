import * as THREE from 'three';
import { CollisionGroup } from 'engine/CollisionLayers.js';

/**
 * Point-blank shots: where a bullet must START when the target is closer than
 * the muzzle.
 *
 * A gun's muzzle sits 0.6–0.9 m in front of the shooter's body. Characters do
 * not collide with each other, so a charging enemy ends up INSIDE that gap —
 * measured 0.56 m from the player's centre with the M60's muzzle at ~0.75 m —
 * and every round spawned beyond its body, flew off, and did nothing: twenty
 * shots at a monster standing on the player's toes left it at full health.
 *
 * The rule: cast from the shooter's centre to the muzzle; if something the
 * projectile can hit sits on that segment, spawn the projectile at the centre
 * instead, so it flies INTO the target. Nothing changes for a normal shot.
 *
 * Pure with respect to physics — the caller hands in a ray query — so the
 * decision is unit-testable without Rapier.
 */

/** A ray query: does anything in `mask` sit within `maxDistance` along the ray? */
export type SegmentBlockedQuery = (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    mask: number,
) => boolean;

/** Scenery never moves the spawn point — a wall the shooter is pressed into keeps the old behaviour. */
const NOT_SCENERY = ~(CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);

const _dir = new THREE.Vector3();

/**
 * The world position a projectile should spawn at. `muzzle` when the path
 * from `shooterCentre` to the muzzle is clear (or unknown: `shooterCentre` null),
 * else `shooterCentre` — the centre is inside the shooter's own capsule, which
 * the projectile's mask never includes, so it cannot hit its own shooter.
 */
export function resolveProjectileSpawn(
    muzzle: THREE.Vector3,
    shooterCentre: THREE.Vector3 | null,
    projectileMask: number,
    blocked: SegmentBlockedQuery,
    out = new THREE.Vector3(),
): THREE.Vector3 {
    if (!shooterCentre) return out.copy(muzzle);
    const distance = _dir.subVectors(muzzle, shooterCentre).length();
    if (distance < 1e-3) return out.copy(muzzle);
    _dir.divideScalar(distance);
    const mask = projectileMask & NOT_SCENERY;
    if (mask === 0 || !blocked(shooterCentre, _dir, distance, mask)) return out.copy(muzzle);
    return out.copy(shooterCentre);
}
