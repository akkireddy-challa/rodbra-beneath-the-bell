import * as THREE from 'three';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { INSTANCE_CULL_SPHERE_MARGIN } from 'engine/EnvLodPolicy.js';
import type { EnvironmentMeshUserData } from 'types/game.js';
import type { EnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';

/**
 * EnvObjectPackOps — the pack/unpack rendering transition for
 * EnvironmentObjectSystem: InstancedMeshes exploded into individually
 * selectable meshes for the Scene editor, and folded back afterwards.
 *
 * This is deliberately a FRIEND MODULE, the same seam VoxelObjectPristineOps
 * and GameEnginePostFx use: the operations belong to EnvironmentObjectSystem
 * conceptually, but that file sits at the repo's 2000-line ESLint cap, so
 * they live here and reach the class's private state through TypeScript's
 * sanctioned element-access escape hatch (`sys['unpackedTypes']` — typed, not
 * `any`). Keep the whole pack/unpack transition in THIS file so the seam
 * stays in one place.
 *
 * The class keeps `unpackInstancedMeshes`/`packInstancedMeshes` as public
 * methods delegating here — WorldGenerator and EditorManager call them, and
 * published games carry frozen template code compiled against that surface.
 *
 * Import-cycle note: EnvironmentObjectSystem.ts imports these functions, so
 * this module imports the class as a TYPE ONLY. Keep it that way — a value
 * import would close the cycle at module-evaluation time.
 */

/**
 * Unpack InstancedMeshes into individual meshes for Scene editor selection.
 * This allows individual selection and manipulation of environment objects,
 * works with all registered object types, and preserves all original
 * registration data (assetId, etc.) from world.json.
 */
export function unpackInstancedMeshes(sys: EnvironmentObjectSystem, typeName?: string): void {
    const idService = getObjectIdService();
    const types = typeName ? [typeName] : Array.from(sys['objectRegistry'].keys());
    let didUnpack = false;

    for (const t of types) {
        if (sys['unpackedTypes'].has(t)) continue;
        console.log(`📦 Unpacking InstancedMeshes for "${t}"...`);
        if (unpackOneType(sys, t, idService)) {
            sys['unpackedTypes'].add(t);
            didUnpack = true;
            console.log(`✅ Unpacked ${sys['getStorage'](t).unpackedMeshes.length} ${t}s`);
        }
    }

    if (didUnpack) {
        // Show every object (no distance/frustum cull) so any instance is selectable.
        sys.setCullingEnabled(false);
    }
}

/**
 * Unpack a single type's InstancedMesh (or per-chunk cube meshes) into
 * individual selectable/editable meshes. Returns true if any mesh was
 * produced. Internal helper for {@link unpackInstancedMeshes}.
 */
function unpackOneType(sys: EnvironmentObjectSystem, typeName: string, idService: ReturnType<typeof getObjectIdService>): boolean {
    const storage = sys['getStorage'](typeName);
    if (storage.instances.length === 0) return false;

    let baseGeometry: THREE.BufferGeometry | null = null;
    let material: THREE.MeshStandardMaterial | null = null;
    let sourceInstancedMesh: THREE.InstancedMesh | null = null;

    // Preserve full registration data (assetId, etc.) for each instance
    const originalDataMap = new Map<number, { id: string; data: any }>();

    if (storage.instancedMesh) {
        // VXL-based assets
        baseGeometry = storage.instancedMesh.geometry;
        material = storage.instancedMesh.material as THREE.MeshStandardMaterial;
        sourceInstancedMesh = storage.instancedMesh;

        // Collect and unregister all instances from the InstancedMesh
        for (const reg of idService.findAllByObject(storage.instancedMesh)) {
            const instanceIndex = reg.data?.instanceIndex;
            if (instanceIndex !== undefined && reg.id) {
                originalDataMap.set(instanceIndex, { id: reg.id, data: { ...reg.data } });
                idService.unregister(reg.id);
            }
        }

        sys['world'].remove(storage.instancedMesh);
    } else {
        // Cube-based procedural objects - geometry from this type's FIRST chunk
        // mesh, detaching every one of this type's chunk meshes from the scene + map.
        for (const [, chunkTypeMap] of sys['chunkMeshes']) {
            const chunkMesh = chunkTypeMap.get(typeName);
            if (!chunkMesh) continue;
            if (!baseGeometry) {
                baseGeometry = chunkMesh.geometry;
                material = chunkMesh.material as THREE.MeshStandardMaterial;
            }
            chunkMesh.removeFromParent();
            chunkTypeMap.delete(typeName);
        }
    }

    if (!baseGeometry || !material) return false;

    storage.unpackedMeshes = [];
    const tempMatrix = new THREE.Matrix4();
    const tempPosition = new THREE.Vector3();
    const tempQuaternion = new THREE.Quaternion();
    const tempScale = new THREE.Vector3();

    // For LOD-instanced types the InstancedMesh buffers are repacked every
    // frame by updateInstanceCulling (compacted visible subsets), so slot i
    // does NOT hold logical instance i. lodStorage.matrices is the
    // authoritative logical-order transform list — always prefer it.
    const lodData = sys['lodStorage'].get(typeName) ?? null;

    for (let i = 0; i < storage.instances.length; i++) {
        const instance = storage.instances[i];
        if (!instance) continue;

        // Extract transform from cube data or InstancedMesh matrix
        let position: THREE.Vector3;
        const rotationEuler = new THREE.Euler();
        let scale = instance.scale || { width: 1, height: 1, depth: 1 };

        const firstCube = instance.cubes?.[0];
        const logicalMatrix = lodData?.matrices[i];
        if (firstCube) {
            position = firstCube.position.clone();
        } else if (logicalMatrix) {
            logicalMatrix.decompose(tempPosition, tempQuaternion, tempScale);
            position = tempPosition.clone();
            rotationEuler.setFromQuaternion(tempQuaternion);
            scale = { width: tempScale.x, height: tempScale.y, depth: tempScale.z };
        } else if (sourceInstancedMesh) {
            sourceInstancedMesh.getMatrixAt(i, tempMatrix);
            tempMatrix.decompose(tempPosition, tempQuaternion, tempScale);
            position = tempPosition.clone();
            rotationEuler.setFromQuaternion(tempQuaternion);
            scale = { width: tempScale.x, height: tempScale.y, depth: tempScale.z };
        } else {
            console.warn(`[unpackInstancedMeshes] No position data for ${typeName} instance ${i}`);
            continue;
        }

        // Create individual mesh. The geometry is SHARED, not cloned: per-instance
        // differences are pure transforms (mesh.position/rotation/scale), sharing
        // reuses the already-uploaded GPU buffers, and for VXL types the source
        // geometry's non-position CPU arrays may already be released post-upload —
        // a clone would copy those zero-length arrays and upload empty buffers.
        const mesh = new THREE.Mesh(baseGeometry, material);
        mesh.position.copy(position);
        mesh.rotation.copy(rotationEuler);
        mesh.scale.set(scale.width, scale.height, scale.depth);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = typeName.charAt(0).toUpperCase() + typeName.slice(1);
        mesh.layers.set(0);
        sys['setChildMeshesToLayer3'](mesh);

        // Set up userData for selection
        const meshUserData = mesh.userData as EnvironmentMeshUserData;
        meshUserData.environmentInstanceId = i;
        meshUserData.isEnvironmentInstance = true;
        meshUserData.environmentType = typeName;

        // Register with ObjectIdService, preserving original data (assetId, etc.)
        const originalEntry = originalDataMap.get(i);
        const objectId = originalEntry?.id || idService.generateId('env');
        const envData = originalEntry?.data
            ? { ...originalEntry.data, instanceIndex: i, position: position.clone(), scale }
            : { id: objectId, type: typeName, instanceIndex: i, position: position.clone(), scale };
        idService.register(objectId, 'object', mesh, envData);

        storage.unpackedMeshes.push(mesh);
        sys['world'].add(mesh);
    }
    return true;
}

/**
 * Pack individual meshes back into InstancedMeshes for performance.
 * Preserves all original registration data (assetId, etc.) while updating transforms.
 *
 * INVARIANT: pack/unpack are rendering transitions owned by EditorManager
 * (only called from enable/disableEditorMode). Read paths must NOT call this —
 * serializeEnvironmentObjects() works in either packed or unpacked state.
 */
export function packInstancedMeshes(sys: EnvironmentObjectSystem, typeName?: string): void {
    if (sys['unpackedTypes'].size === 0) return;

    const idService = getObjectIdService();
    const types = typeName ? [typeName] : Array.from(sys['unpackedTypes']);

    for (const t of types) {
        if (!sys['unpackedTypes'].has(t)) continue;
        console.log(`📦 Packing "${t}" back into InstancedMeshes...`);
        packOneType(sys, t, idService);
        sys['unpackedTypes'].delete(t);
    }

    if (sys['unpackedTypes'].size === 0) {
        // Re-enable culling for performance once nothing is unpacked.
        sys.setCullingEnabled(true);
    }
}

/**
 * Pack a single type's individual editable meshes back into its
 * InstancedMesh (VXL) or per-chunk InstancedMeshes (cube-based), preserving
 * registration data. Internal helper for {@link packInstancedMeshes}.
 */
function packOneType(sys: EnvironmentObjectSystem, typeName: string, idService: ReturnType<typeof getObjectIdService>): void {
    const storage = sys['getStorage'](typeName);
    if (storage.unpackedMeshes.length === 0) return;

    const isVxlBased = storage.instancedMesh !== null;

    // Collect transforms and registration data from unpacked meshes
    interface UnpackedTransform {
        position: THREE.Vector3;
        quaternion: THREE.Quaternion;
        eulerXYZ: { x: number; y: number; z: number };
        scale: THREE.Vector3;
        instanceIdx: number;
        objectId: string | null;
        originalData: any;
    }
    const transforms: UnpackedTransform[] = [];

    for (let i = 0; i < storage.unpackedMeshes.length; i++) {
        const mesh = storage.unpackedMeshes[i];
        if (!mesh) continue;

        // Get registration data before unregistering
        const objectId = mesh.userData.objectId || null;
        const originalData = objectId ? { ...idService.getById(objectId)?.data } : null;
        if (objectId) idService.unregister(objectId);

        // Extract current transform
        mesh.updateMatrixWorld(true);
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        mesh.matrixWorld.decompose(position, quaternion, scale);
        const euler = new THREE.Euler().setFromQuaternion(quaternion);
        const eulerXYZ = { x: euler.x, y: euler.y, z: euler.z };

        // Update cube positions for cube-based objects
        const instance = storage.instances[i];
        if (instance?.cubes?.length) {
            instance.scale = { width: scale.x, height: scale.y, depth: scale.z };
            instance.cubes = instance.cubes.map(cube => ({
                ...cube,
                position: cube.position.clone().applyMatrix4(mesh.matrixWorld)
            }));
        }

        transforms.push({ position, quaternion: quaternion.clone(), eulerXYZ, scale, instanceIdx: i, objectId, originalData });

        sys['world'].remove(mesh);
        // Unpacked meshes SHARE their geometry (see unpackOneType). For VXL
        // types that is the live InstancedMesh geometry being re-added below —
        // disposing it would drop its GPU buffers, and the CPU arrays it
        // would re-upload from may be post-upload released (zero-length).
        if (mesh.geometry !== storage.instancedMesh?.geometry) {
            mesh.geometry.dispose();
        }
    }

    if (isVxlBased && storage.instancedMesh) {
        // VXL-based: update InstancedMesh transforms and re-register.
        // LOD-instanced types render from lodStorage.matrices (repacked into
        // the LOD buckets every frame), so edited transforms must be written
        // back there too — otherwise moved objects snap back visually on the
        // next updateInstanceCulling pass.
        const lodData = sys['lodStorage'].get(typeName) ?? null;
        const geomBox = (() => {
            if (!lodData) return null;
            if (!storage.instancedMesh.geometry.boundingBox) {
                storage.instancedMesh.geometry.computeBoundingBox();
            }
            return storage.instancedMesh.geometry.boundingBox;
        })();
        const tempMatrix = new THREE.Matrix4();
        for (const t of transforms) {
            tempMatrix.compose(t.position, t.quaternion, t.scale);
            storage.instancedMesh.setMatrixAt(t.instanceIdx, tempMatrix);
            if (lodData?.matrices[t.instanceIdx]) {
                lodData.matrices[t.instanceIdx]!.copy(tempMatrix);
                if (geomBox && lodData.spheres[t.instanceIdx]) {
                    // Mirror the load-time sphere: bbox center/half-extents
                    // scaled per axis, rotated, translated, with margin.
                    const halfExtents = new THREE.Vector3(
                        ((geomBox.max.x - geomBox.min.x) / 2) * t.scale.x,
                        ((geomBox.max.y - geomBox.min.y) / 2) * t.scale.y,
                        ((geomBox.max.z - geomBox.min.z) / 2) * t.scale.z,
                    );
                    const center = new THREE.Vector3(
                        ((geomBox.min.x + geomBox.max.x) / 2) * t.scale.x,
                        ((geomBox.min.y + geomBox.max.y) / 2) * t.scale.y,
                        ((geomBox.min.z + geomBox.max.z) / 2) * t.scale.z,
                    )
                        .applyQuaternion(t.quaternion)
                        .add(t.position);
                    lodData.spheres[t.instanceIdx]!.set(
                        center,
                        halfExtents.length() * INSTANCE_CULL_SPHERE_MARGIN,
                    );
                }
            }

            // Re-register preserving original data (assetId, etc.)
            if (t.objectId) {
                const scaleObj = { width: t.scale.x, height: t.scale.y, depth: t.scale.z };
                const registrationData = t.originalData
                    ? { ...t.originalData, instanceIndex: t.instanceIdx, position: t.position.clone(), rotation: t.eulerXYZ, scale: scaleObj }
                    : { id: t.objectId, type: typeName, instanceIndex: t.instanceIdx, position: t.position.clone(), rotation: t.eulerXYZ, scale: scaleObj };
                idService.register(t.objectId, 'object', storage.instancedMesh, registrationData);
            }
        }
        storage.instancedMesh.instanceMatrix.needsUpdate = true;
        sys['world'].add(storage.instancedMesh);
    } else {
        // Cube-based: create per-chunk InstancedMeshes
        const chunkGroups = new Map<string, Array<{position: THREE.Vector3; rotation: number; instanceIdx: number}>>();

        for (const transform of transforms) {
            const chunkKey = sys['getChunkKey'](transform.position.x, transform.position.z);
            // Cube-based procedural objects only use Y rotation; the other axes are
            // never meaningful for trees/rocks even if the user nudges them.
            let group = chunkGroups.get(chunkKey);
            if (!group) { group = []; chunkGroups.set(chunkKey, group); }
            group.push({ position: transform.position, rotation: transform.eulerXYZ.y, instanceIdx: transform.instanceIdx });
        }

        // Get geometry and material from first unpacked mesh
        const firstMesh = storage.unpackedMeshes[0];
        if (firstMesh) {
            const baseGeometry = firstMesh.geometry;
            const material = firstMesh.material as THREE.MeshStandardMaterial;

            // Create per-chunk InstancedMeshes
            const tempMatrix = new THREE.Matrix4();
            for (const [chunkKey, instances] of chunkGroups) {
                const chunkMesh = new THREE.InstancedMesh(baseGeometry.clone(), material, instances.length);
                chunkMesh.castShadow = true;
                chunkMesh.receiveShadow = true;
                chunkMesh.name = `${typeName}_chunk_${chunkKey}`;

                for (let i = 0; i < instances.length; i++) {
                    const inst = instances[i]!;
                    tempMatrix.makeTranslation(inst.position.x, inst.position.y, inst.position.z);
                    if (inst.rotation !== 0) {
                        tempMatrix.multiply(new THREE.Matrix4().makeRotationY(inst.rotation));
                    }
                    chunkMesh.setMatrixAt(i, tempMatrix);
                }

                chunkMesh.instanceMatrix.needsUpdate = true;
                sys['attachChunkMesh'](typeName, chunkKey, chunkMesh, sys['world']);
            }
        }
    }

    storage.unpackedMeshes = [];
    sys.markEnvironmentObjectsModified();
}
