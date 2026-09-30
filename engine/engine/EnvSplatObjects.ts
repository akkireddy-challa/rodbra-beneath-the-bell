/**
 * Loader for Gaussian Splat environment instances (the `gaussianSplat` asset
 * type in world.json's environmentObjects). Each instance becomes its own
 * GaussianSplatRenderer registered in `engine.gaussianSplatRenderers`, with the
 * singleton GaussianSplatEditor created lazily on the first one. Split out of
 * EnvironmentObjectSystem.ts to respect the max-lines limit.
 */
import * as THREE from 'three';
import { refreshSplatView } from 'engine/SplatViewMode.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';

/** Transform slice the loader needs from EnvironmentObjectSystem.parseObjectTransform. */
export interface SplatObjectTransform {
    x: number;
    y: number;
    z: number;
}

/** One asset's worth of splat instances, grouped by env-object type name. */
export interface SplatObjectGroup {
    typeName: string;
    objDefs: any[];
    asset: any;
}

/**
 * Load every Gaussian Splat instance in `splatGroups`.
 *
 * `engineRef` is EnvironmentObjectSystem's module-level engine reference (set
 * via setEnvironmentObjectSystemEngine); `parseObjectTransform` is the system's
 * own private transform parser, passed in so instance placement stays identical
 * to the other env-object loaders.
 */
export async function loadGaussianSplatObjects(
    splatGroups: SplatObjectGroup[],
    engineRef: any | null,
    parseObjectTransform: (objDef: any) => SplatObjectTransform,
): Promise<void> {
    const { GaussianSplatRenderer } = await import('engine/GaussianSplatRenderer.js');
    const idService = getObjectIdService();

    if (!engineRef) {
        console.warn('[EnvironmentObjectSystem] No engine reference — cannot load Gaussian Splats');
        return;
    }

    const scene: THREE.Scene | null = engineRef.scene;
    if (!scene) {
        console.warn('[EnvironmentObjectSystem] No scene available — cannot load Gaussian Splats');
        return;
    }

    const physicsWorld = engineRef.physicsWorld ?? null;
    const engine = engineRef as any;

    for (const { typeName, objDefs, asset } of splatGroups) {
        console.log(`📦 Loading Gaussian Splat asset for ${typeName}: ${asset.url}`);

        for (const objDef of objDefs) {
            const transform = parseObjectTransform(objDef);
            const { x, y, z } = transform;

            // Build a GaussianSplatConfig from the env-object instance + asset-level fields
            const rotation = objDef.rotation
                ? (typeof objDef.rotation === 'number'
                    ? { x: 0, y: objDef.rotation, z: 0 }
                    : { x: objDef.rotation.x ?? 0, y: objDef.rotation.y ?? 0, z: objDef.rotation.z ?? 0 })
                : { x: 0, y: 0, z: 0 };
            const scale = objDef.scale
                ? { x: objDef.scale.x ?? 1, y: objDef.scale.y ?? 1, z: objDef.scale.z ?? 1 }
                : { x: 1, y: 1, z: 1 };

            const splatConfig = {
                url: asset.url,
                // radUrl/colliderUrl/previewUrl are per-asset (shared by all instances).
                // voxelUrl/floorMeshUrl remain per-instance.
                radUrl: asset.radUrl as string | undefined,
                previewUrl: asset.previewUrl as string | undefined,
                voxelUrl: objDef.voxelUrl as string | undefined,
                floorMeshUrl: objDef.floorMeshUrl as string | undefined,
                walkableUrl: objDef.walkableUrl as string | undefined,
                pvsUrl: objDef.pvsUrl as string | undefined,
                colliderUrl: asset.colliderUrl as string | undefined,
                colliderType: asset.colliderType as 'mesh' | 'voxel' | undefined,
                position: { x, y, z },
                eulerAngles: rotation,
                scale,
            };

            const objectId = objDef.id || idService.generateId('object');
            const renderer = new GaussianSplatRenderer(scene, splatConfig, physicsWorld, engine, objectId);
            // Propagate Asset.cropBounds + Asset.cleanupBounds so runtime
            // bounds queries reflect the user's choices even if
            // voxelization ran before they were set.
            type RawBox = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
            const assetWithBounds = asset as { cropBounds?: RawBox; cleanupBounds?: RawBox; shadowCatcher?: boolean; shadowCatcherYOffset?: number } | null;
            const cropFromAsset = assetWithBounds?.cropBounds ?? null;
            if (cropFromAsset && typeof renderer.setCropBoundsRaw === 'function') {
                renderer.setCropBoundsRaw(cropFromAsset);
            }
            const cleanupFromAsset = assetWithBounds?.cleanupBounds ?? null;
            if (cleanupFromAsset && typeof renderer.setCleanupBoundsRaw === 'function') {
                renderer.setCleanupBoundsRaw(cleanupFromAsset);
            }
            if (typeof assetWithBounds?.shadowCatcherYOffset === 'number' && typeof renderer.setShadowCatcherYOffset === 'function') {
                renderer.setShadowCatcherYOffset(assetWithBounds.shadowCatcherYOffset);
            }
            if (assetWithBounds?.shadowCatcher && typeof renderer.setShadowCatcherEnabled === 'function') {
                renderer.setShadowCatcherEnabled(true);
            }

            // Register before load() so concurrent code can find it; renderer adds itself to scene during load()
            if (Array.isArray(engine.gaussianSplatRenderers)) {
                engine.gaussianSplatRenderers.push(renderer);
            } else {
                engine.gaussianSplatRenderers = [renderer];
            }
            if (!engine.gaussianSplatRenderer) {
                engine.gaussianSplatRenderer = renderer;
                if (typeof engine.ensureGaussianSplatEditor === 'function') {
                    await engine.ensureGaussianSplatEditor(renderer);
                }
            }
            // Wire every splat renderer (not just the first) to the singleton
            // collider editor. Without this, only the first splat's loadColliders
            // call routes through the editor — subsequent splats' .vxl files are
            // never loaded into the editor's per-splat VoxelWorld map, so the
            // `?splats=` collider view and runtime physics show only one splat's colliders.
            const sharedColliderEditor = engine.gaussianSplatRenderer && typeof engine.gaussianSplatRenderer.getColliderEditor === 'function'
                ? engine.gaussianSplatRenderer.getColliderEditor()
                : null;
            if (sharedColliderEditor && renderer !== engine.gaussianSplatRenderer && typeof renderer.setColliderEditor === 'function') {
                renderer.setColliderEditor(sharedColliderEditor);
            }
            engine.isGaussianSplatMode = true;
            // This renderer starts visible; if `?splats=` asked for something else, say so again.
            refreshSplatView();

            const registrationData = { ...objDef, assetId: objDef.assetId, boundingBox: asset.boundingBox };
            // Placeholder Object3D registered with ObjectIdService so that
            // `serializeEnvironmentObjects()` (which reads sceneObject.position/rotation/scale)
            // returns the live transform. The renderer mirrors its transform onto this placeholder.
            const placeholder = new THREE.Object3D();
            placeholder.name = asset.name || typeName;
            renderer.setSceneObject(placeholder);
            idService.register(objectId, 'object', placeholder, registrationData);

            try {
                await renderer.load();
                // Placed/overlay splats are world content, not an editor
                // preview, so render the full gaussians — not the default
                // 'points' preview cloud (which draws each splat as a single
                // dot). The creator's Splats panel can still switch back to
                // 'points' for editing. Without this, runtime/overlay splats
                // render as a sparse dot cloud.
                if (typeof renderer.setSplatRenderMode === 'function') {
                    renderer.setSplatRenderMode('gaussian');
                }
                console.log(`✅ Loaded Gaussian Splat instance: ${asset.name || typeName} at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
            } catch (error) {
                console.error(`❌ Failed to load Gaussian Splat instance for ${typeName}:`, error);
            }
        }
    }
}
