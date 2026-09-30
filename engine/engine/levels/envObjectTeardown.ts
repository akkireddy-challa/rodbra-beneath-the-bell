import * as THREE from 'three';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * The EnvironmentObjectSystem internals a level-switch teardown touches.
 * Passed explicitly by the system (its own privates) — this module exists so
 * the teardown logic doesn't push EnvironmentObjectSystem.ts over the
 * max-lines cap.
 */
export interface EnvObjectTeardownParts {
    physicsWorld: PhysicsWorld | null;
    objectStorage: Map<string, {
        instances: Array<{ voxelObject?: (THREE.Object3D & { dispose?: () => void }) | null }>;
        instancedMesh: THREE.InstancedMesh | null;
        unpackedMeshes: THREE.Mesh[];
    }>;
    lodStorage: Map<string, { meshes: THREE.InstancedMesh[]; shadowMesh: THREE.InstancedMesh | null }>;
    chunkMeshes: Map<string, Map<string, THREE.InstancedMesh>>;
    /** Every body the system created. Instanced props hang off NO Object3D, so
     *  this registry — not the scene graph — is what makes them removable. */
    worldBodies: Array<{ isValid?: () => boolean }>;
    /** Same bodies, bucketed for hibernation. Cleared alongside worldBodies. */
    chunkPhysicsBodies: Map<string, unknown[]>;
    /** Dynamic props synced each post-step; stale entries would sync forever.
     *  `dispose()` is the only handle on a dynamic GLB prop's body + chunk
     *  registration — the adapter closes over both. */
    dynamicObjects: Array<{ dispose?: () => void }>;
    /** Env objects with their own scene node (interactable / collectible /
     *  dynamic clones, GLB instances) — in no per-type storage. */
    individualObjects: Array<THREE.Object3D & { dispose?: () => void }>;
}

/**
 * Remove every spawned env-object from the scene, physics world and the
 * object-id service. The type REGISTRY survives (types re-spawn on the next
 * generateScenery); geometries/materials owned by loaders are left to the GC
 * via scene detachment — they may be shared across types, so they are never
 * force-disposed here. Returns the number of cleared instances.
 */
export function disposeSpawnedEnvObjectContent(parts: EnvObjectTeardownParts): number {
    const idService = getObjectIdService();
    const unregisterIds = (obj: THREE.Object3D): void => {
        for (const reg of idService.findAllByObject(obj)) {
            if (reg.id) idService.unregister(reg.id);
        }
    };
    /** Full take-down of one scene node: ids, its own body, parent, own resources. */
    const takeDown = (obj: THREE.Object3D & { dispose?: () => void }): void => {
        unregisterIds(obj);
        if (obj.userData.rigidBody && parts.physicsWorld) {
            parts.physicsWorld.removeRigidBody(obj.userData.rigidBody);
            obj.userData.rigidBody = null;
        }
        obj.removeFromParent();
        obj.dispose?.();
    };

    let clearedInstances = 0;
    for (const storage of parts.objectStorage.values()) {
        // The InstancedMesh is only detached, never dispose()d: that would free
        // GPU buffers other storage (LOD sets, chunk meshes) may still point at.
        if (storage.instancedMesh) {
            unregisterIds(storage.instancedMesh);
            storage.instancedMesh.removeFromParent();
        }
        for (const mesh of storage.unpackedMeshes) takeDown(mesh);
        for (const inst of storage.instances) {
            clearedInstances++;
            if (inst.voxelObject) takeDown(inst.voxelObject);
        }
        storage.instances = [];
        storage.instancedMesh = null;
        storage.unpackedMeshes = [];
    }
    for (const lod of parts.lodStorage.values()) {
        for (const mesh of lod.meshes) mesh.removeFromParent();
        lod.shadowMesh?.removeFromParent();
    }
    parts.lodStorage.clear();
    for (const chunkTypeMap of parts.chunkMeshes.values()) {
        for (const chunkMesh of chunkTypeMap.values()) chunkMesh.removeFromParent();
    }
    parts.chunkMeshes.clear();
    // Objects with their own scene node — no per-type storage holds them.
    for (const obj of parts.individualObjects) takeDown(obj);
    parts.individualObjects.length = 0;
    // Dynamic props: dispose() drops the body AND the chunk registration (a
    // dynamic GLB prop's body exists only inside that closure).
    for (const dyn of parts.dynamicObjects) dyn.dispose?.();
    parts.dynamicObjects.length = 0;
    // Bodies the scene graph can't reach: instanced-prop colliders (one fixed
    // body per instance, drawn by an InstancedMesh) and the GLB collider bodies.
    // removeRigidBody is deferred + de-duplicated, so bodies already dropped
    // above are safely re-offered here.
    let clearedBodies = 0;
    if (parts.physicsWorld) {
        for (const body of parts.worldBodies) {
            if (body.isValid?.() === false) continue;
            parts.physicsWorld.removeRigidBody(body as never);
            clearedBodies++;
        }
    }
    parts.worldBodies.length = 0;
    parts.chunkPhysicsBodies.clear();
    console.log(`[Levels] cleared ${clearedInstances} environment-object instances `
        + `and ${clearedBodies} physics bodies for level switch`);
    return clearedInstances;
}
