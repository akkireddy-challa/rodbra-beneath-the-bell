import * as THREE from 'three';
import type { ProjectileConfig } from 'engine/ShootableComponent.js';
import type { RangedWeaponPreset } from 'engine/RangedWeaponTypes.js';
import { createTracerMesh } from 'engine/RangedWeaponMeshes.js';

/**
 * What a weapon preset's bullets look like and how fast they travel.
 *
 * Shared by RangedWeaponSystem and FirstPersonWeaponSystem so a weapon fires
 * the identical projectile whichever camera mode it is used in — a rocket
 * launcher that arced and exploded in third person but fired flat tracers in
 * first person would be the same weapon behaving like two.
 *
 * Damage is deliberately absent: hits are resolved by the projectile's own
 * collision handling, and the callback here is a hook for callers that want one.
 */
export function createRangedProjectileConfig(
    preset: RangedWeaponPreset,
    projectileColorOverride?: number,
): ProjectileConfig {
    const projectileRadius = preset.projectileRadius ?? 0.03;
    const projectileColor = projectileColorOverride ?? preset.projectileColor ?? 0xffaa00;
    const trailLength = preset.trailLength ?? 4;
    const hasCustomMesh = !!preset.createProjectileMesh;

    return {
        speed: preset.projectileSpeed,
        localFireDirection: new THREE.Vector3(0, 0, 1),
        visualConfig: {
            // Ballistic default is a slim TRACER, not a sphere — see
            // createTracerMesh for why. Weapons with their own mesh factory
            // (rockets, lasers, arrows) keep it.
            customMesh: preset.createProjectileMesh?.(projectileRadius, projectileColor)
                ?? createTracerMesh(projectileRadius, projectileColor),
            material: new THREE.MeshStandardMaterial({
                color: projectileColor,
                emissive: projectileColor,
                emissiveIntensity: hasCustomMesh ? 3.0 : 2.0,
                roughness: 0.2,
            }),
            trail: {
                enabled: true,
                length: trailLength,
                color: projectileColor,
            },
            explosion: preset.explosion,
            gravityScale: preset.gravityScale,
        },
    };
}
