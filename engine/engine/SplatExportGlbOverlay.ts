/**
 * SplatExportGlbOverlay — for the Gaussian Splat export, temporarily replace
 * voxelised environment objects with their ORIGINAL textured GLB meshes.
 *
 * Why: Gaussian splatting reconstructs smooth, textured surfaces far better than
 * hard-edged, flat-shaded voxels. Each voxel asset that was voxelised from a GLB
 * keeps a `sourceGlbUrl`; here we load that GLB, fit it to the asset's metric
 * `boundingBox` (which reproduces the voxeliser's `targetHeight` scaling +
 * base-on-ground / XZ-centre placement), apply each instance's world transform,
 * and add it to a temporary overlay group — while hiding the matching voxel
 * meshes. The collider stays voxel-based; only the *captured appearance* upgrades.
 *
 * The result is fully reversible via `restore()`, which the exporter calls when
 * the capture finishes, errors, or is cancelled.
 *
 * Alignment note: bbox-fit handles position + uniform scale. It assumes the GLB's
 * authored orientation matches the voxelised orientation (true when both derive
 * from the same source asset). Verify visually after the first bake.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import type { GameData, Asset } from 'types/game.js';
import type { EnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';

/** Placement entry from `gameData.environmentObjects` (typed locally — the field
 *  is `any[]` on GameData). Only the fields the overlay needs are declared. */
interface EnvObjectPlacement {
    assetId?: string;
    type?: string;
    dynamic?: boolean;
    position?: { x: number; y: number; z: number };
    rotation?: { x: number; y: number; z: number };
    scale?: { x: number; y: number; z: number };
}

export interface SplatExportGlbOverlay {
    /** Number of GLB instances placed. */
    instanceCount: number;
    /** Number of distinct GLB types replaced (for logging). */
    typeCount: number;
    /** Remove the overlay and un-hide the voxel meshes. Idempotent. */
    restore: () => void;
}

// Module-level cache so repeated exports (and repeated instances of one asset)
// reuse a single GLTF load.
const glbCache = new Map<string, Promise<THREE.Group>>();

function loadGlbScene(url: string): Promise<THREE.Group> {
    let p = glbCache.get(url);
    if (!p) {
        p = createGltfLoader().loadAsync(url).then(gltf => gltf.scene);
        glbCache.set(url, p);
    }
    return p;
}

/**
 * Scale + translate `obj` (in its own local frame) so its world-AABB matches
 * `box`: uniform scale by height, base at `box.minY`, centred in XZ. Mutates
 * `obj.position` / `obj.scale`. `obj` must have no parent (or an identity parent)
 * so `matrixWorld` equals its local matrix.
 */
function fitToBox(obj: THREE.Object3D, box: NonNullable<Asset['boundingBox']>): void {
    obj.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
    const targetH = box.maxY - box.minY;
    const scale = size.y > 1e-6 ? targetH / size.y : 1;
    obj.scale.multiplyScalar(scale);

    obj.updateMatrixWorld(true);
    const fitted = new THREE.Box3().setFromObject(obj);
    const center = fitted.getCenter(new THREE.Vector3());
    obj.position.x += (box.minX + box.maxX) / 2 - center.x;
    obj.position.z += (box.minZ + box.maxZ) / 2 - center.z;
    obj.position.y += box.minY - fitted.min.y;
}

/**
 * Build the GLB overlay and hide the voxel meshes it replaces. Always resolves
 * (individual GLB failures are logged and skipped — those objects keep their
 * voxels). Call `restore()` to undo.
 */
export async function buildSplatExportGlbOverlay(
    scene: THREE.Scene,
    gameData: GameData | null,
    envSystem: EnvironmentObjectSystem | null,
): Promise<SplatExportGlbOverlay> {
    const noop: SplatExportGlbOverlay = { instanceCount: 0, typeCount: 0, restore: () => {} };
    const assets = gameData?.assets ?? [];
    const placements = (gameData?.environmentObjects ?? []) as EnvObjectPlacement[];
    if (assets.length === 0 || placements.length === 0) return noop;

    const assetById = new Map<string, Asset>(assets.map(a => [a.id, a]));
    const overlay = new THREE.Group();
    overlay.name = 'SplatExportGlbOverlay';
    const replacedTypes = new Set<string>();

    let skippedDynamic = 0;
    const tasks: Promise<void>[] = [];
    for (const place of placements) {
        // Dynamic objects (carts, barrels, chairs, doors — flagged in world.json)
        // move at runtime, so they must NOT be baked into the static splat. Their
        // voxel meshes are already excluded by the dynamic-physics tag; here we
        // just skip rendering their GLBs.
        if (place.dynamic) { skippedDynamic++; continue; }
        const asset = place.assetId ? assetById.get(place.assetId) : undefined;
        if (!asset?.sourceGlbUrl || !asset.boundingBox) continue;
        const glbUrl = asset.sourceGlbUrl;
        const box = asset.boundingBox;
        if (place.type) replacedTypes.add(place.type);

        tasks.push(
            loadGlbScene(glbUrl)
                .then(src => {
                    // Clone and enable shadows (mirrors EnvironmentObjectSystem's
                    // GLB loader) — raw GLB meshes default to castShadow=false, so
                    // without this the textured buildings cast/receive no shadows.
                    const glb = src.clone(true);
                    glb.traverse(child => {
                        const mesh = child as THREE.Mesh;
                        if (!mesh.isMesh) return;
                        mesh.castShadow = true;
                        mesh.receiveShadow = true;
                        // Forged GLBs ship with glTF default metallicFactor=1 (no
                        // explicit material setup), so they render BLACK in shadow —
                        // metals have no diffuse response to ambient/hemisphere light.
                        // Force matte so stone/wood buildings are lit naturally.
                        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        for (const m of mats) {
                            const sm = m as THREE.MeshStandardMaterial;
                            if (sm && typeof sm.metalness === 'number') sm.metalness = 0;
                        }
                    });
                    // inner: GLB fitted to the voxel bbox (asset-local frame)
                    const inner = new THREE.Group();
                    inner.add(glb);
                    fitToBox(inner, box);
                    // outer: the instance's world transform
                    const outer = new THREE.Group();
                    if (place.position) outer.position.set(place.position.x, place.position.y, place.position.z);
                    if (place.rotation) outer.rotation.set(place.rotation.x, place.rotation.y, place.rotation.z);
                    if (place.scale) outer.scale.set(place.scale.x || 1, place.scale.y || 1, place.scale.z || 1);
                    outer.add(inner);
                    overlay.add(outer);
                })
                .catch(err => {
                    console.warn(`[SplatExport] GLB overlay load failed for ${glbUrl} — keeping voxels:`, err);
                    if (place.type) replacedTypes.delete(place.type);
                }),
        );
    }
    await Promise.all(tasks);

    if (overlay.children.length === 0) {
        console.warn(`[SplatExport] GLB overlay: 0 GLBs placed (skippedDynamic=${skippedDynamic}). Capturing voxels.`);
        return noop;
    }
    scene.add(overlay);

    // Hide the voxel meshes behind the GLBs. Two independent mechanisms so no
    // storage path slips through: (1) the env system's type-collector (covers
    // chunk InstancedMeshes, unpacked meshes, instanced + voxelObject storage);
    // (2) a full scene traversal for objects tagged `glbSourceUrl` at creation
    // (covers per-instance VoxelObject clones not held in any storage map).
    // Tag each so the exporter keeps it hidden and never force-shows it.
    const hidden: THREE.Object3D[] = [];
    const hideMesh = (mesh: THREE.Object3D): boolean => {
        if (!mesh.visible && mesh.userData.excludeFromSplatExport) return false; // already handled
        mesh.userData.excludeFromSplatExport = true;
        mesh.visible = false;
        hidden.push(mesh);
        return true;
    };
    let viaCollector = 0, viaTag = 0, viaName = 0;
    for (const mesh of envSystem?.collectExportMeshesForTypes(replacedTypes) ?? []) {
        if (hideMesh(mesh)) viaCollector++;
    }
    // Primary, render-mode-agnostic hide: env objects render under names derived
    // from the type — `<type>_instanced`, `<type>_shadowOnly`, `<type>_instanced_lodN`,
    // or per-instance VoxelObjects named `<type>`/objDef.name. Hiding everything
    // whose name matches a replaced type catches all those variants (the collector
    // only finds the main instanced mesh, missing shadow-only + LOD copies, which
    // is why voxel buildings kept rendering under the GLBs).
    if (overlay) overlay.userData.isSplatExportOverlay = true;
    scene.traverse(obj => {
        if (!(obj as THREE.Mesh).isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh) return;
        if (obj.userData.glbSourceUrl) { if (obj.userData.glbDynamic !== true && hideMesh(obj)) viaTag++; return; }
        // skip our own overlay GLB meshes
        let p: THREE.Object3D | null = obj;
        while (p) { if (p.userData.isSplatExportOverlay) return; p = p.parent; }
        const n = obj.name || '';
        for (const t of replacedTypes) {
            if (n === t || n.startsWith(t + '_')) { if (hideMesh(obj)) viaName++; break; }
        }
    });
    console.log(`[SplatExport] GLB overlay: placed ${overlay.children.length} GLBs across ${replacedTypes.size} types; hid voxels (collector=${viaCollector}, tagged=${viaTag}, byName=${viaName}); skippedDynamic=${skippedDynamic}.`);

    let restored = false;
    return {
        instanceCount: overlay.children.length,
        typeCount: replacedTypes.size,
        restore: () => {
            if (restored) return;
            restored = true;
            scene.remove(overlay);
            overlay.traverse(obj => {
                const mesh = obj as THREE.Mesh;
                if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
            });
            for (const mesh of hidden) {
                delete mesh.userData.excludeFromSplatExport;
                mesh.visible = true;
            }
        },
    };
}
