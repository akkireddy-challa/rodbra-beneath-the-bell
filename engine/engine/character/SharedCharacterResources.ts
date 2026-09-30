import * as THREE from 'three';

/**
 * Geometry and materials that belong to a character TEMPLATE, not to the instance holding
 * them.
 *
 * A crowd of NPCs is built by cloning one loaded model — `SkeletonUtils.clone` for skinned
 * characters, `Object3D.clone(true)` for block ones. Both share geometry and materials with
 * the source by reference: the clone gets its own bones and its own meshes, and every one of
 * those meshes points at the template's buffers.
 *
 * That makes per-instance teardown dangerous. Disposing a clone's meshes frees buffers that
 * the template and every sibling clone are still drawing with, and WebGL/WebGPU quietly
 * re-uploads them on the next frame — so nothing looks broken and the cost simply reappears.
 * In a game that spawns and despawns a horde continuously the same character geometry is
 * uploaded, freed and uploaded again for the whole session: measured at roughly 30 MB per
 * species per cycle, which is a heap that grows and stalls rather than one that settles.
 *
 * Marking the clone's resources here makes the ownership explicit — the instance disposes
 * only what it actually allocated, and the template's buffers live as long as the template.
 */

/** Set on a geometry or material owned by a shared template rather than by one instance. */
export const SHARED_TEMPLATE_FLAG = '__sharedCharacterTemplate';

interface FlaggableUserData { userData: Record<string, unknown> }

/** True when this resource belongs to a template (or a shared cache) and must not be disposed per instance. */
export function isSharedCharacterResource(resource: FlaggableUserData | null | undefined): boolean {
    if (!resource) return false;
    return resource.userData[SHARED_TEMPLATE_FLAG] === true || resource.userData['__sharedLodCache'] === true;
}

/**
 * Flag every geometry and material under `clone` as template-owned.
 *
 * Call this immediately after cloning a character model and before the clone is handed to
 * anything that might dispose it. Cheap: one traverse, no allocation beyond the flags.
 */
export function markSharedCharacterResources(clone: THREE.Object3D): void {
    clone.traverse((object: THREE.Object3D) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.geometry) mesh.geometry.userData[SHARED_TEMPLATE_FLAG] = true;
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const material of materials) material.userData[SHARED_TEMPLATE_FLAG] = true;
    });
}
