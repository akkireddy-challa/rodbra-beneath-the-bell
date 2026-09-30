import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { Projectile } from 'engine/Projectile.js';
import type { ShootableComponent } from 'engine/ShootableComponent.js';
import type { RangedWeaponPreset } from 'engine/RangedWeaponTypes.js';
import { OPEN_SKY_CONVERGENCE_DISTANCE } from 'engine/weapons/CameraAim.js';
import { scatterAimPoints, DEFAULT_PELLET_SPREAD_RAD } from 'engine/weapons/PelletSpread.js';

/**
 * One trigger pull, whether the weapon fires one bullet or a shotgun's spread.
 *
 * Shared by RangedWeaponSystem and FirstPersonWeaponSystem so a shotgun patterns
 * identically in every camera mode — the same reason CameraAim and
 * RangedProjectileConfig are shared rather than copied. Rate limiting, ammo and
 * shot feedback stay with the caller; this only decides how many projectiles
 * leave the muzzle and where each is aimed.
 */

const _muzzleWorld = new THREE.Vector3();
const _fallbackAim = new THREE.Vector3();
const _muzzleQuat = new THREE.Quaternion();

/**
 * @param muzzleTransform the object `shootable.muzzleOffset` is relative to; also
 *                        the source of the barrel direction.
 * @param aimPoint the world point the shot converges on, or null when the
 *                 reticle is over open sky.
 * @returns the projectiles spawned — empty if the weapon was still on cooldown.
 */
export function fireWeaponShot(
    shootable: ShootableComponent,
    muzzleTransform: THREE.Object3D,
    physicsWorld: PhysicsWorld,
    engine: EngineLike,
    preset: RangedWeaponPreset | null,
    aimPoint: THREE.Vector3 | null,
): Projectile[] {
    const pelletCount = Math.max(1, Math.floor(preset?.pelletCount ?? 1));
    if (pelletCount === 1) {
        const single = shootable.shoot(muzzleTransform, physicsWorld, engine, aimPoint ?? undefined);
        return single ? [single] : [];
    }

    // A VOLLEY: several pellets scattered around the aim point, for one round of
    // ammunition and one rate-limit tick.
    muzzleTransform.localToWorld(_muzzleWorld.copy(shootable.muzzleOffset));
    // Open sky under the reticle: scatter around a point down the barrel.
    const target = aimPoint ?? _fallbackAim.set(0, 0, 1)
        .applyQuaternion(muzzleTransform.getWorldQuaternion(_muzzleQuat))
        .multiplyScalar(OPEN_SKY_CONVERGENCE_DISTANCE)
        .add(_muzzleWorld);

    return shootable.shootVolley(muzzleTransform, physicsWorld, engine, scatterAimPoints(
        _muzzleWorld,
        target,
        pelletCount,
        preset?.pelletSpreadRad ?? DEFAULT_PELLET_SPREAD_RAD,
        Math.random,
    ));
}
