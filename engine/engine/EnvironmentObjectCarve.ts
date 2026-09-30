import * as THREE from 'three';
import type { EnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { getFragmentCount } from 'engine/VoxelObjectPristineOps.js';

/**
 * EnvironmentObjectCarve — lifting one batched scenery instance out of the
 * InstancedMesh so bullet holes can be carved into that copy alone.
 *
 * A FRIEND MODULE, the same seam GameEnginePostFx and VoxelObjectPristineOps
 * use: EnvironmentObjectSystem sits at the repo's 2000-line ESLint cap, so this
 * belongs to the class conceptually but lives here and reaches private state
 * through TypeScript's sanctioned element-access escape hatch (typed, not
 * `any`).
 *
 * Import-cycle note: EnvironmentObjectSystem imports this function, so the
 * EnvironmentObjectSystem binding here is TYPE-ONLY — do not add a value
 * import of it.
 *
 * WHY THIS IS NEEDED AT ALL. Batched scenery — walls, crates, rubble, most of
 * what a player actually shoots — renders every copy of a type from ONE
 * template VoxelObject, and every copy's physics body reports that same
 * template. Carving it would punch identical holes in every copy in the level.
 * So a struck instance must first be given geometry of its own.
 *
 * That is the same trade PristineDestructible makes for explosions; the
 * difference is when it is paid. Explosions promote a handful of objects, so
 * they can afford to set proxies up in advance. Bullets touch far more, so
 * promotion here is LAZY (only instances somebody actually shoots) and BUDGETED
 * (past the cap the instance stays batched and keeps a decal).
 */

/** Most instances that may be promoted for carving in one session. */
const MAX_CARVE_PROMOTIONS = 48;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

/**
 * @param template the type's shared VoxelObject, as resolved from the hit body.
 * @returns the promoted per-instance object, or null when it cannot be promoted
 *          (unknown instance, no physics world, or the budget is spent).
 */
export function promoteEnvInstanceForCarving(
    system: EnvironmentObjectSystem,
    typeName: string,
    instanceIndex: number,
    template: VoxelObject,
): VoxelObject | null {
    // Pre-fragmented templates cannot take leaf edits (the parent's leaf list
    // is not what renders), so promoting one would trade the batch for a clone
    // that still cannot hold a hole. Refuse and let the hit keep its decal.
    if (getFragmentCount(template) > 1) return null;

    const key = `${typeName}:${instanceIndex}`;
    const promotions = system['carvePromotions'];
    const existing = promotions.get(key);
    if (existing) return existing;
    if (promotions.size >= MAX_CARVE_PROMOTIONS) return null;

    const storage = system['lodStorage'].get(typeName);
    const matrix = storage?.matrices[instanceIndex];
    const physicsWorld = system['physicsWorld'];
    if (!storage || !matrix || !physicsWorld) return null;

    const clone = new VoxelObject({
        voxelSize: template.getVoxelSize(),
        useAtlas: true,
        shadows: true,
    });
    template.cloneDataTo(clone);

    // The batch's baked matrix is authoritative — the instance is DRAWN from
    // it — so the clone lands exactly where the copy the player shot stood.
    matrix.decompose(_position, _quaternion, _scale);
    clone.position.copy(_position);
    clone.quaternion.copy(_quaternion);
    clone.scale.copy(_scale);
    clone.name = `${typeName}_carved_${instanceIndex}`;
    // Its geometry is now private to this instance, so per-hit mutation is safe.
    clone.setCarveable(true);
    system['world'].add(clone);

    // updateInstanceCulling skips null spheres, so every LOD and the
    // shadow-only mesh stop drawing this slot on the next culling pass. Exactly
    // how PristineDestructible hides an instance it has promoted.
    storage.spheres[instanceIndex] = null as unknown as THREE.Sphere;

    // Retire the batched body BEFORE building the clone's own, or the instance
    // collides twice. The old one is tagged with the template, so hits would
    // also keep resolving to the wrong object.
    const previous = system['carveBodies'].get(key);
    if (previous) {
        physicsWorld.removeRigidBody(previous);
        system['carveBodies'].delete(key);
    }

    _euler.setFromQuaternion(_quaternion);
    clone.createPhysicsBodyAtPosition(
        physicsWorld,
        _position.x, _position.y, _position.z,
        _euler.y,
        { width: _scale.x, height: _scale.y, depth: _scale.z },
        { x: _euler.x, y: _euler.y, z: _euler.z },
    );

    promotions.set(key, clone);
    system['individualObjects'].push(clone);
    return clone;
}
