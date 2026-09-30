import * as THREE from 'three';
import type { AssetProduction } from 'types/game.js';
import { VoxelObjectBuilder, type VoxelObjectConfig, type VoxelPartConfig, SMART_PROP_BAKE } from 'engine/builders/VoxelObjectBuilder.js';
import { deriveSmartPropFromGlb, type SmartPropBake } from 'engine/import/SmartPropParts.js';
import type { SmartPropSpec } from 'types/smartObject.js';
import { VoxelObjectSaveService } from 'editor/VoxelObjectSaveService.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { PlacementHelper } from 'engine/PlacementHelper.js';
import { getVoxelPreviewRenderer } from 'engine/VoxelPreviewRenderer.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { voxelizeGLB, voxelizeFromExtracted } from 'engine/GLBVoxelizer.js';
import { extractGlbForVoxelization } from 'engine/ExtractGlbForVoxelization.js';
import { deriveVehicleFitment } from 'engine/vehicle/BmVehicleFitment.js';
import { buildAutoLodRamp } from 'engine/autoLodRamp.js';
import { additionalLodsForBake } from 'engine/EnvLodPolicy.js';
import { voxelizeGLBToVxlWorld } from 'engine/VxlWorldVoxelizer.js';
import { uploadFile } from 'engine/StorageUploadUtil.js';
import { decodeVxlV3 } from 'engine/VxlV3Format.js';
import { applyEmissiveToVxlBytes, collectVxlPalette } from 'engine/template/VxlEmissiveTransforms.js';
import { applyEmissiveByColor } from 'engine/vxlscene/emissiveByColor.js';
import { applyMaterialByColorToVxl } from 'engine/template/VxlMaterialByColor.js';
import { buildEnvObject, rotationDegToRad, type VoxelPlacementInput, findAssetById } from 'engine/template/EnvObjectRecord.js';
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';
import type { GameEngine } from 'engine/GameEngine.js';

type Asset = { id: string; name: string; [k: string]: unknown };

/**
 * Find an asset by name. Tries (1) exact, (2) case-insensitive, (3) trailing
 * parenthetical stripped, (4) alphanumeric-only. Returns the asset or undefined.
 */
function findAssetByName(assets: Asset[] | undefined, assetName: string): Asset | undefined {
    if (!assets) return undefined;
    const exact = assets.find(a => a.name === assetName);
    if (exact) return exact;
    const needle = assetName.toLowerCase().trim();
    const ci = assets.find(a => a.name.toLowerCase().trim() === needle);
    if (ci) return ci;
    const stripSuffix = (s: string) => s.replace(/\s*\(.*?\)\s*$/, '').trim().toLowerCase();
    const stripped = stripSuffix(assetName);
    const bySuffix = assets.find(a => stripSuffix(a.name) === stripped);
    if (bySuffix) return bySuffix;
    const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const alnumNeedle = alnum(assetName);
    return assets.find(a => alnum(a.name).startsWith(alnumNeedle) || alnumNeedle.startsWith(alnum(a.name)));
}

/**
 * VOXELIZE_GLB requests already handled (or in flight), by requestId. The
 * creator re-posts un-acknowledged requests (delivery across iframe reloads is
 * at-least-once), so duplicates must be dropped instead of re-baked.
 */
const handledVoxelizeRequestIds = new Set<string>();

/** Validates game engine, game data, scene and physics are available. Returns null if invalid. */
function validateSceneContext(
    ctx: GameTemplateContext,
    handlerName: string
): { gameEngine: GameEngine; currentGameData: any; scene: THREE.Scene; physicsWorld: any } | null {
    const gameEngine = ctx.getGameEngine();
    const currentGameData = ctx.getCurrentGameData();

    if (!gameEngine) {
        console.error(`[${handlerName}] Game engine not available`);
        return null;
    }
    if (!currentGameData) {
        console.error(`[${handlerName}] No current game data`);
        return null;
    }

    const scene = gameEngine.scene;
    const physicsWorld = gameEngine.physicsWorld;

    if (!scene || !physicsWorld) {
        console.error(`[${handlerName}] Scene or physics world not available`);
        return null;
    }

    return { gameEngine, currentGameData, scene, physicsWorld };
}

/**
 * Resolve the Y placement:
 *  - forcePosition: trust the caller's exact Y (`position.y ?? 0`), no snapping.
 *  - placeOnTerrain: snap to the current ground surface, ignoring any supplied Y.
 *    (The authoritative snap also runs at load time in EnvironmentObjectSystem
 *    against the fully-loaded terrain; this is the best-effort value at placement.)
 *  - explicit y (no flags): use it as given.
 *  - otherwise: fall back to a ground-height raycast.
 *
 * NOTE: `placeOnTerrain` must NOT be grouped with `forcePosition` — doing so made
 * "place on terrain" with no explicit Y resolve to `pos.y ?? 0` (= 0), i.e. it
 * skipped ground sampling entirely and buried objects at the world floor.
 */
function resolvePlacementY(
    physicsWorld: any,
    pos: { x: number; z: number; y?: number },
    forcePosition: boolean | undefined,
    placeOnTerrain: boolean | undefined,
): number {
    if (forcePosition) return pos.y ?? 0;
    if (placeOnTerrain) return PlacementHelper.findGroundHeight(physicsWorld, pos.x, pos.z);
    if (pos.y !== undefined) return pos.y;
    return PlacementHelper.findGroundHeight(physicsWorld, pos.x, pos.z);
}

/**
 * Handle CREATE_VOXEL_ASSET message from AI tool.
 * Creates a VoxelObject, uploads to S3, and adds to assets[] WITHOUT placing an instance.
 */
export async function handleCreateVoxelAsset(
    ctx: GameTemplateContext,
    data: {
        requestId: string;
        name: string;
        parts: VoxelPartConfig[];
        voxelSize: number;
        flattenTerrain?: boolean;
        flattenMargin?: number;
        assetId?: string; // pre-generated id from the AI manifest — honored as the asset id
        colliderShape?: 'box' | 'sphere'; // 'sphere' = dynamic instances roll (single ball collider)
        /** Moving parts and lights by the boxes' `part` names — a smart object from the first bake. */
        smart?: SmartPropSpec;
    }
): Promise<void> {
    console.log(`📦 CREATE_VOXEL_ASSET received: ${data.name} with ${data.parts?.length || 0} parts`);

    const sceneCtx = validateSceneContext(ctx, 'CREATE_VOXEL_ASSET');
    if (!sceneCtx) return;
    const { currentGameData, scene, physicsWorld } = sceneCtx;

    try {
        const voxelSize = data.voxelSize || 0.25;
        const config: VoxelObjectConfig = {
            name: data.name,
            parts: data.parts,
            voxelSize,
            physicsMode: 'static',
            ...(data.smart ? { smart: data.smart } : {}),
        };

        const atlas = getVoxelTextureAtlas();
        const tempPosition = new THREE.Vector3(0, 1000, 0);
        const { object: tempObject } = VoxelObjectBuilder.create(config, scene, physicsWorld, tempPosition, atlas);

        const bounds = tempObject.getBoundsInWorldUnits();
        const boundingBox = bounds ? { ...bounds } : undefined;
        // What the builder derived for a smart object: the fitment and the emitters,
        // in the asset frame. Absent when the config declared nothing usable.
        const smartBake = tempObject.userData[SMART_PROP_BAKE] as SmartPropBake | undefined;
        const smartFields = smartBake
            ? {
                smartObject: smartBake.fitment,
                ...(smartBake.light ? { light: smartBake.light } : {}),
                ...(smartBake.lights ? { lights: smartBake.lights } : {}),
            }
            : {};

        const saveService = new VoxelObjectSaveService();
        const uploadResult = await saveService.saveVoxelObjectAsAsset(tempObject, data.name, currentGameData);

        scene.remove(tempObject);
        if (physicsWorld && tempObject.userData.rigidBody) {
            physicsWorld.removeRigidBody(tempObject.userData.rigidBody);
        }

        if (!uploadResult) {
            console.error(`❌ [CREATE_VOXEL_ASSET] Failed to upload asset: ${data.name}`);
            return;
        }

        const assetId = saveService.addOrUpdateAsset(
            currentGameData, data.name, uploadResult.url, boundingBox,
            data.assetId, data.flattenTerrain, data.flattenMargin, voxelSize,
            data.colliderShape
        );

        console.log(`✅ [CREATE_VOXEL_ASSET] Asset created: ${data.name}, id: ${assetId}`);

        // Keep the spec that produced this. Without it a procedural asset could
        // never be made again — the parts list was thrown away the moment the
        // voxels existed, so "regenerate" had nothing to re-run and the only
        // route back was asking the agent, which usually re-rolled something
        // different.
        const production: AssetProduction = {
            method: 'procedural',
            at: new Date().toISOString(),
            spec: {
                name: data.name,
                parts: data.parts,
                voxelSize,
                ...(data.colliderShape ? { colliderShape: data.colliderShape } : {}),
                ...(data.flattenTerrain ? { flattenTerrain: data.flattenTerrain } : {}),
                ...(data.flattenMargin !== undefined ? { flattenMargin: data.flattenMargin } : {}),
                // Replayed by "Rebuild procedurally", so the rebuild stays smart.
                ...(data.smart ? { smart: data.smart } : {}),
            },
        };
        const storedAsset = (currentGameData.assets || []).find((a: { id: string }) => a.id === assetId);
        if (storedAsset) Object.assign(storedAsset, { production, ...smartFields });
        if (smartBake) {
            console.log(`⚙️ [CREATE_VOXEL_ASSET] Smart object: ${smartBake.table.map((p) => p.name).join(', ')}`);
        }

        ctx.safePostMessage({
            type: 'VOXEL_ASSET_SAVED',
            requestId: data.requestId,
            prefabType: data.name,
            asset: {
                id: assetId, name: data.name, url: uploadResult.url, type: 'vxl',
                size: uploadResult.size, boundingBox,
                flattenTerrain: data.flattenTerrain || false,
                flattenMargin: data.flattenMargin, voxelSize,
                colliderShape: data.colliderShape,
                production,
                ...smartFields,
            },
            environmentObjects: []
        });

    } catch (error) {
        console.error('[CREATE_VOXEL_ASSET] Error creating voxel asset:', error);
    }
}

/**
 * Handle PLACE_VOXEL_OBJECT message from AI tool.
 * Places a new instance of an existing asset using PlacementHelper.
 */
export async function handlePlaceVoxelObject(
    ctx: GameTemplateContext,
    data: VoxelPlacementInput & { requestId: string }
): Promise<void> {
    console.log(`📍 PLACE_VOXEL_OBJECT received: ${data.asset_name} at (${data.position.x}, ${data.position.z})`);

    const sceneCtx = validateSceneContext(ctx, 'PLACE_VOXEL_OBJECT');
    if (!sceneCtx) return;
    const { currentGameData, physicsWorld } = sceneCtx;

    try {
        const asset = findAssetById(currentGameData.assets as Asset[] | undefined, data.asset_id)
            ?? findAssetByName(currentGameData.assets as Asset[] | undefined, data.asset_name);
        if (!asset) {
            console.error(`[PLACE_VOXEL_OBJECT] Asset not found: ${data.asset_name}`);
            // Answer, so the caller fails at once instead of waiting out its timeout.
            ctx.safePostMessage({
                type: 'VOXEL_OBJECT_PLACED',
                requestId: data.requestId,
                error: `Asset "${data.asset_name}" is not in the running game (added since it loaded?). Reload the preview, or add the instance to world.json with world-edit write.`,
            });
            return;
        }

        const posY = resolvePlacementY(physicsWorld, data.position, data.force_position, data.placeOnTerrain);
        const usedAutoGround = !data.force_position && !data.placeOnTerrain && data.position.y === undefined;
        if (usedAutoGround) {
            console.log(`[PLACE_VOXEL_OBJECT] Auto-calculated ground Y: ${posY}`);
        }

        const position = { x: data.position.x, y: posY, z: data.position.z };
        const instanceId = getObjectIdService().generateId('inst');
        const envObject = buildEnvObject(data, asset.id, instanceId, position);

        if (!currentGameData.environmentObjects) {
            currentGameData.environmentObjects = [];
        }
        currentGameData.environmentObjects.push(envObject);

        console.log(`✅ [PLACE_VOXEL_OBJECT] Instance created: ${instanceId} at (${position.x}, ${position.y}, ${position.z})${data.force_position ? ' [forced]' : ''}`);

        ctx.safePostMessage({
            type: 'VOXEL_OBJECT_PLACED',
            requestId: data.requestId,
            instance: envObject
        });

    } catch (error) {
        console.error('[PLACE_VOXEL_OBJECT] Error placing voxel object:', error);
        ctx.safePostMessage({
            type: 'VOXEL_OBJECT_PLACED',
            requestId: data.requestId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * Handle BATCH_PLACE_VOXEL_OBJECTS message from AI tool.
 * Places multiple instances of existing assets in a single operation.
 */
export async function handleBatchPlaceVoxelObjects(
    ctx: GameTemplateContext,
    data: { requestId: string; objects: VoxelPlacementInput[] }
): Promise<void> {
    console.log(`📍 BATCH_PLACE_VOXEL_OBJECTS received: ${data.objects?.length || 0} objects`);

    const sceneCtx = validateSceneContext(ctx, 'BATCH_PLACE_VOXEL_OBJECTS');
    if (!sceneCtx) return;
    const { currentGameData, physicsWorld } = sceneCtx;

    try {
        if (!currentGameData.environmentObjects) {
            currentGameData.environmentObjects = [];
        }

        const results: Array<{ object_id: string; final_position: { x: number; y: number; z: number } }> = [];
        const instances: Array<Record<string, unknown>> = [];
        const idService = getObjectIdService();

        const assets = currentGameData.assets as Asset[] | undefined;
        for (const obj of data.objects) {
            // By id when the caller knows it (the forge does); by name otherwise.
            const asset = findAssetById(assets, obj.asset_id) ?? findAssetByName(assets, obj.asset_name);
            if (!asset) {
                console.error(`[BATCH_PLACE_VOXEL_OBJECTS] Asset not found: ${obj.asset_name}, skipping`);
                continue;
            }

            const posY = resolvePlacementY(physicsWorld, obj.position, obj.force_position, obj.placeOnTerrain);
            const position = { x: obj.position.x, y: posY, z: obj.position.z };
            const instanceId = idService.generateId('inst');
            const envObject = buildEnvObject(obj, asset.id, instanceId, position);

            currentGameData.environmentObjects.push(envObject);
            results.push({ object_id: instanceId, final_position: position });
            instances.push(envObject);
        }

        console.log(`✅ [BATCH_PLACE_VOXEL_OBJECTS] ${results.length} instances created`);

        ctx.safePostMessage({
            type: 'BATCH_VOXEL_OBJECTS_PLACED',
            requestId: data.requestId,
            results,
            instances
        });

    } catch (error) {
        console.error('[BATCH_PLACE_VOXEL_OBJECTS] Error placing voxel objects:', error);
    }
}

/**
 * Handle MODIFY_VOXEL_OBJECT message from AI tool.
 * Modifies an existing instance's position, rotation, or scale.
 */
export async function handleModifyVoxelObject(
    ctx: GameTemplateContext,
    data: {
        requestId: string;
        object_id: string;
        position?: { x: number; z: number; y?: number };
        rotation?: { x: number; y: number; z: number };
        scale?: { x: number; y: number; z: number };
        flatten_terrain?: boolean;
        force_position?: boolean;
        collision?: boolean;
    }
): Promise<void> {
    console.log(`✏️ MODIFY_VOXEL_OBJECT received: ${data.object_id}`);

    const sceneCtx = validateSceneContext(ctx, 'MODIFY_VOXEL_OBJECT');
    if (!sceneCtx) return;
    const { currentGameData, physicsWorld } = sceneCtx;

    try {
        const envObjects = currentGameData.environmentObjects || [];
        const instance = envObjects.find((obj: { id: string }) => obj.id === data.object_id);

        if (!instance) {
            console.error(`[MODIFY_VOXEL_OBJECT] Instance not found: ${data.object_id}`);
            return;
        }

        if (data.position) {
            let posY: number;
            if (data.force_position) {
                posY = data.position.y ?? instance.position?.y ?? 0;
            } else if (data.position.y !== undefined) {
                posY = data.position.y;
            } else if (physicsWorld) {
                posY = PlacementHelper.findGroundHeight(physicsWorld, data.position.x, data.position.z);
            } else {
                posY = instance.position?.y || 0;
            }
            instance.position = { x: data.position.x, y: posY, z: data.position.z };
        }

        if (data.rotation) {
            instance.rotation = rotationDegToRad(data.rotation);
        }

        if (data.scale) {
            instance.scale = data.scale;
        }

        if (data.flatten_terrain !== undefined) {
            instance.flattenTerrain = data.flatten_terrain;
        }

        if (data.force_position !== undefined) {
            if (data.force_position) {
                instance.forcePosition = true;
            } else {
                delete instance.forcePosition;
            }
        }

        if (data.collision !== undefined) {
            // Store only the non-default opt-out; clearing reverts to the
            // collidable default (and the asset-level flag, if any).
            if (data.collision === false) {
                instance.collision = false;
            } else {
                delete instance.collision;
            }
        }

        console.log(`✅ [MODIFY_VOXEL_OBJECT] Instance modified: ${data.object_id}`, instance);

        ctx.safePostMessage({
            type: 'VOXEL_OBJECT_MODIFIED',
            requestId: data.requestId,
            instance
        });

    } catch (error) {
        console.error('[MODIFY_VOXEL_OBJECT] Error modifying voxel object:', error);
    }
}

/**
 * Handle DELETE_VOXEL_OBJECT message from AI tool.
 * Removes an instance from environmentObjects.
 */
export async function handleDeleteVoxelObject(
    ctx: GameTemplateContext,
    data: { requestId: string; object_id: string }
): Promise<void> {
    console.log(`🗑️ DELETE_VOXEL_OBJECT received: ${data.object_id}`);

    const currentGameData = ctx.getCurrentGameData();

    if (!ctx.getGameEngine()) {
        console.error('[DELETE_VOXEL_OBJECT] Game engine not available');
        return;
    }

    if (!currentGameData) {
        console.error('[DELETE_VOXEL_OBJECT] No current game data');
        return;
    }

    try {
        const envObjects = currentGameData.environmentObjects || [];
        const instanceIndex = envObjects.findIndex((obj: { id: string }) => obj.id === data.object_id);

        if (instanceIndex === -1) {
            console.error(`[DELETE_VOXEL_OBJECT] Instance not found: ${data.object_id}`);
            return;
        }

        const removed = envObjects.splice(instanceIndex, 1)[0];
        console.log(`✅ [DELETE_VOXEL_OBJECT] Instance removed: ${data.object_id}`, removed);

        ctx.safePostMessage({
            type: 'VOXEL_OBJECT_DELETED',
            requestId: data.requestId,
            object_id: data.object_id
        });

    } catch (error) {
        console.error('[DELETE_VOXEL_OBJECT] Error deleting voxel object:', error);
    }
}

/**
 * Handle GENERATE_VOXEL_PREVIEW message from creator.
 * Generates a preview image for a voxel asset using Three.js.
 *
 * ACKed on receipt (same protocol as VOXELIZE_GLB): the creator re-posts a
 * request until it hears the ACK, because a postMessage sent while the iframe
 * is reloading lands in a navigating document and vanishes — the Assets tab
 * then showed "Generation failed" for an asset that renders fine.
 */
export async function handleGenerateVoxelPreview(
    ctx: GameTemplateContext,
    data: { requestId: string; vxlData: number[] }
): Promise<void> {
    console.log(`📸 GENERATE_VOXEL_PREVIEW received: requestId=${data.requestId}`);
    ctx.safePostMessage({ type: 'VOXEL_PREVIEW_ACK', requestId: data.requestId });

    try {
        if (!data.vxlData || !Array.isArray(data.vxlData)) {
            throw new Error('Invalid vxlData: expected number array');
        }

        const vxlBuffer = new Uint8Array(data.vxlData).buffer;
        const previewRenderer = getVoxelPreviewRenderer();
        const previewBase64 = await previewRenderer.generatePreview(vxlBuffer);

        console.log(`✅ Preview generated for requestId=${data.requestId}`);

        ctx.safePostMessage({
            type: 'VOXEL_PREVIEW_RESPONSE',
            requestId: data.requestId,
            previewBase64,
            success: true
        });

    } catch (error) {
        console.error('[GENERATE_VOXEL_PREVIEW] Error generating preview:', error);
        ctx.safePostMessage({
            type: 'VOXEL_PREVIEW_RESPONSE',
            requestId: data.requestId,
            error: error instanceof Error ? error.message : 'Unknown error',
            success: false
        });
    }
}

/**
 * Handle REGISTER_CUSTOM_BLOCK_TYPE message.
 *
 * Routes through `engine.blocks.registerCustom` so live registrations and
 * `customBlockTypes` loaded from world.json share a single code path
 * (idempotent name check, structured failure reporting, no throws).
 */
export async function handleRegisterCustomBlockType(
    ctx: GameTemplateContext,
    data: { name: string; textureUrl: string; sideTextureUrl?: string | null; textureSize: number }
): Promise<void> {
    console.log(`🧱 REGISTER_CUSTOM_BLOCK_TYPE received: name=${data.name}`);

    const gameEngine = ctx.getGameEngine();
    if (!gameEngine) {
        console.error('[REGISTER_CUSTOM_BLOCK_TYPE] Game engine not available');
        return;
    }

    const result = await gameEngine.blocks.registerCustom({
        name: data.name,
        textureUrl: data.textureUrl,
        sideTextureUrl: data.sideTextureUrl ?? null,
        textureSize: data.textureSize || 64,
    });

    if ('id' in result) {
        if (result.alreadyExisted) {
            console.log(`[REGISTER_CUSTOM_BLOCK_TYPE] Block type "${data.name}" already registered (id: ${result.id}), skipping`);
        } else {
            console.log(`✅ Custom block type registered: ${data.name} (id: ${result.id})`);
        }
    } else {
        console.error(`[REGISTER_CUSTOM_BLOCK_TYPE] Failed to register '${data.name}': ${result.error}`);
    }
}

/**
 * Handle VOXELIZE_GLB message.
 */
export async function handleVoxelizeGLB(
    ctx: GameTemplateContext,
    data: {
        requestId: string;
        glbData: number[];
        options: {
            minVoxelSize: number;
            maxVoxelSize: number;
            targetHeight?: number;
            fillInterior: boolean;
            preFragment?: { targetFragments?: number; individualVoxels?: number };
            additionalLods?: Array<{ minVoxelSize: number; maxVoxelSize: number }>;
            algorithm?: 'surface' | 'octree';
        };
    }
): Promise<void> {
    // ACK receipt immediately: the creator re-posts the SAME request until
    // acknowledged, because a postMessage sent while this iframe was reloading
    // vanishes silently. The re-posts make delivery at-least-once, so dedupe
    // by requestId — only the first delivery runs the (expensive) bake.
    ctx.safePostMessage({ type: 'VOXELIZE_GLB_ACK', requestId: data.requestId });
    if (handledVoxelizeRequestIds.has(data.requestId)) {
        console.log(`🧱 VOXELIZE_GLB duplicate delivery ignored: ${data.requestId}`);
        return;
    }
    handledVoxelizeRequestIds.add(data.requestId);
    if (handledVoxelizeRequestIds.size > 64) {
        const oldest = handledVoxelizeRequestIds.values().next().value;
        if (oldest !== undefined) handledVoxelizeRequestIds.delete(oldest);
    }

    const opts = data.options;
    const lodCount = 1 + (opts.additionalLods?.length ?? 0);
    console.log(`🧱 VOXELIZE_GLB received: minVoxelSize=${opts.minVoxelSize}, maxVoxelSize=${opts.maxVoxelSize}, targetHeight=${opts.targetHeight ?? 'auto'}, preFragment=${opts.preFragment ? `target=${opts.preFragment.targetFragments ?? 50}` : 'off'}, lods=${lodCount}, algorithm=${opts.algorithm ?? 'surface'}`);

    try {
        if (!data.glbData) {
            throw new Error('No GLB data provided');
        }

        const glbBuffer = new Uint8Array(data.glbData).buffer;

        const extracted = await extractGlbForVoxelization(glbBuffer, {
            minVoxelSize: opts.minVoxelSize,
            targetHeight: opts.targetHeight,
        });
        // Re-voxelizing a smart prop's GLB re-reads its declaration from the file,
        // so the re-bake keeps its parts; the reply carries the re-derived fitment.
        const smartDerivation = deriveSmartPropFromGlb(extracted);
        if (smartDerivation) {
            for (const warning of smartDerivation.warnings) console.warn(`⚠️ ${warning}`);
        }
        const result = await voxelizeFromExtracted(extracted, {
            minVoxelSize: opts.minVoxelSize,
            maxVoxelSize: opts.maxVoxelSize,
            targetHeight: opts.targetHeight,
            fillInterior: opts.fillInterior,
            preFragment: opts.preFragment,
            additionalLods: opts.additionalLods,
            algorithm: opts.algorithm,
            ...(smartDerivation ? { smartParts: smartDerivation.voxelizerInput } : {}),
            onProgress: (info) => {
                ctx.safePostMessage({
                    type: 'VOXELIZE_GLB_PROGRESS',
                    requestId: data.requestId,
                    index: info.index,
                    total: info.total,
                    label: info.label,
                });
            },
        });

        // Creator GLB imports of bmVehicle files (e.g. Blender-authored cars)
        // become drivable too: the reply carries the derived fitment and the
        // creator attaches it to the asset record it assembles.
        const vehicleDerivation = deriveVehicleFitment(extracted.sceneExtras, {
            bodyBounds: extracted.preRebaseBounds,
            hasWheelNodes: extracted.hasBmWheelNodes,
            appliedScale: extracted.appliedScale,
        });
        if (vehicleDerivation) {
            console.log(`🚗 bmVehicle extension found in imported GLB: ${vehicleDerivation.fitment.axles.length} axles`);
        }

        console.log(`✅ Voxelization complete: ${result.totalVoxels} voxels (LOD 0), ${result.lodCount} LOD${result.lodCount === 1 ? '' : 's'} [${result.voxelsPerLod.join(', ')}], ${result.fragmentCount} fragments, ${result.colliderBoxCount} physics boxes (${result.trimeshTriangles} tris), ${result.nodeCount} octree nodes`);

        ctx.safePostMessage({
            type: 'VOXELIZE_GLB_RESULT',
            requestId: data.requestId,
            success: true,
            vxlBytes: result.vxlBytes,
            bounds: result.bounds,
            totalVoxels: result.totalVoxels,
            colliderBoxCount: result.colliderBoxCount,
            trimeshTriangles: result.trimeshTriangles,
            nodeCount: result.nodeCount,
            fragmentCount: result.fragmentCount,
            lodCount: result.lodCount,
            voxelsPerLod: result.voxelsPerLod,
            warning: result.warning,
            ...(vehicleDerivation ? { vehicleFitment: vehicleDerivation.fitment } : {}),
            ...(smartDerivation ? smartDerivation.fields : {}),
        });
    } catch (error) {
        console.error('[VOXELIZE_GLB] Error:', error);
        ctx.safePostMessage({
            type: 'VOXELIZE_GLB_RESULT',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Voxelization failed',
        });
    }
}

/**
 * Build a ` label=…` fragment for the level-voxelize log line, or '' when the
 * map is missing/empty. `render` defaults to a comma-joined key list; pass a
 * custom renderer for maps whose values matter (e.g. LOD offsets, smooth axes).
 */
function summarizeObjectMap<T>(
    label: string,
    map: Record<string, T> | undefined,
    render: (m: Record<string, T>) => string = m => Object.keys(m).join(','),
): string {
    return map && Object.keys(map).length > 0 ? ` ${label}=${render(map)}` : '';
}

/**
 * Handle VOXELIZE_GLB_AS_LEVEL message — convert a GLB into a baked VWLD
 * (chunked voxel world) suitable as a drop-in level for `VxlChunkedTerrainSystem`.
 *
 * Drives `voxelizeGLBToVxlWorld(...)`, uploads the resulting VWLD blob to
 * the same storage backend the asset voxelizer uses, and returns the
 * CloudFront URL plus a ready-to-persist asset record to the creator. The
 * creator side wires those into `world.json` via `/api/edit-world-config`
 * (set `voxelUrl`, push an `assets[]` entry) and reloads the game.
 */
export async function handleVoxelizeGlbAsLevel(
    ctx: GameTemplateContext,
    data: {
        requestId: string;
        /** GLB bytes — used for first-time voxelize where the file was just picked. */
        glbData?: number[];
        /** Already-uploaded GLB URL — used for re-voxelize where the source GLB
         *  was uploaded on the original run and persisted on the asset record. */
        glbUrl?: string;
        /** User-friendly label for the asset record (typically the source GLB name). */
        levelName: string;
        options: {
            levelSizeX: number;
            levelSizeZ: number;
            levelSizeY?: number;
            chunkSize: number;
            minVoxelSize: number;
            maxVoxelSize: number;
            fillInterior: boolean;
            /** Per-LOD shape; `distance` is round-tripped onto the asset
             *  record so the runtime can apply it to the chunked-terrain
             *  system at load time. Voxelizer itself ignores `distance`. */
            additionalLods?: Array<{ minVoxelSize: number; maxVoxelSize: number; distance?: number }>;
            /** Per-object LOD-offset overrides keyed by top-level GLB node
             *  name. Missing/empty = no overrides (single-pass voxelize). */
            objectLodOffsets?: Record<string, number>;
            /** Per-object "pin LOD" flags (same key space as offsets).
             *  Pinned objects' triangles voxelize only at LOD 0; their
             *  LOD-0 leaves get replicated into every additional LOD slot
             *  so the object renders at constant quality regardless of
             *  camera distance. Missing/empty = no pins. */
            objectLodPins?: Record<string, true>;
            /** Per-object "trimesh collider" flags (same key space).
             *  Tagged objects' GLB triangles are baked into each chunk as
             *  a Rapier trimesh collider; their voxel leaves are marked
             *  "no-collider" so they only render. Missing/empty = no
             *  trimesh colliders (all objects use voxel-cube physics). */
            objectTrimeshColliders?: Record<string, true>;
            /** Per-object "no collider" flags (same key space). Tagged objects
             *  are decoration: their voxels/quads are excluded from ALL collision
             *  (no voxel, quad, or trimesh collider) so painted lines and similar
             *  surface detail aren't steps vehicles/players collide with. They
             *  still render. Missing/empty = all objects collide. */
            objectNoColliders?: Record<string, true>;
            /** Per-object collision-only nodes: named trimesh collision with no render output. */
            objectCollisionOnlyNodes?: Record<string, true>;
            /** Per-object smooth-surface axis ('x' | 'y' | 'z'). Voxels
             *  for that object slide along the chosen axis to put cube
             *  faces on the actual surface. One axis per object to avoid
             *  within-object gaps; missing = grid-aligned. */
            objectDisplacementAxes?: Record<string, 'x' | 'y' | 'z'>;
            /** Per-object "library-asset instance" flags (same key space).
             *  Tagged objects are EXCLUDED from the bake — they are
             *  placeholder instance groups for library assets placed as
             *  environment objects (World Forger levels). Missing/empty =
             *  every object bakes. */
            objectAssetInstances?: Record<string, true>;
            /** Per-object ground-type names (same key space; GroundTypes.ts
             *  registry). Rasterized into the v6 ground mask that drives the
             *  runtime cobble domes / grass cover. Missing/empty = no mask. */
            objectGroundTypes?: Record<string, string>;
            /**
             * Bake-time per-color emissive: keys are `#RRGGBB` authored colors, values
             * 1..255 strength. Matched EXACTLY (RGB444 cell equality — see
             * `emissiveByColor.ts`) against the colors this bake produces and written
             * into the v7 world-level emissive palette. Unmatched keys are reported
             * back as `emissiveUnmatched` (a bake note, not an error). Missing/empty =
             * no emissive palette section.
             */
            emissiveByColor?: Record<string, number>;
            /**
             * Bake-time per-color MATERIAL CLASSES: keys are `#RRGGBB` authored colors,
             * values `VoxelMaterialClass` names ('stone', 'wood', 'metal', …). Matched
             * with a small tolerance and budget-capped (see `classByColor.ts`) and
             * written into the v9 world-level class section. Unmatched keys come back
             * as `materialUnmatched`, collapse decisions as `materialNotes` (bake
             * notes, not errors). Missing/empty = no class section.
             */
            materialByColor?: Record<string, string>;
            /**
             * Trim the world to a corridor around the level's designed path (the
             * World Forger's `path` gameplay feature, which the creator reads off
             * the asset record and sends here as `points`). `distanceM` is the
             * horizontal keep radius from the centerline; `mode: 'outside'` keeps
             * everything a closed circuit encloses and trims only beyond the loop.
             * `pointSpace` is the level size the points were authored at, so
             * changing the world size in the same dialog pass still culls the
             * right ground. Missing = no cull.
             */
            pathCull?: {
                points: Array<{ x: number; y?: number; z: number }>;
                closed: boolean;
                distanceM: number;
                mode: 'both' | 'outside';
                pointSpace?: { levelSizeX: number; levelSizeZ: number; levelSizeY?: number; chunkSize: number };
            };
        };
    }
): Promise<void> {
    const opts = data.options;
    const objectSummaries = [
        summarizeObjectMap('lodOverrides', opts.objectLodOffsets,
            m => Object.entries(m).map(([n, o]) => `${n}:${o > 0 ? '+' : ''}${o}`).join(',')),
        summarizeObjectMap('lodPinned', opts.objectLodPins),
        summarizeObjectMap('trimeshCollider', opts.objectTrimeshColliders),
        summarizeObjectMap('collisionOnly', opts.objectCollisionOnlyNodes),
        summarizeObjectMap('smoothAxes', opts.objectDisplacementAxes,
            m => Object.entries(m).map(([n, a]) => `${n}:${a}`).join(',')),
        summarizeObjectMap('assetInstances', opts.objectAssetInstances),
    ].join('');
    console.log(
        `[VOXELIZE_GLB_AS_LEVEL] received: name="${data.levelName}", ` +
        `source=${data.glbUrl ? 'url' : 'bytes'}, ` +
        `size=${opts.levelSizeX}x${opts.levelSizeZ}m, chunkSize=${opts.chunkSize}, ` +
        `voxel=[${opts.minVoxelSize}, ${opts.maxVoxelSize}], lods=${1 + (opts.additionalLods?.length ?? 0)}` +
        objectSummaries +
        (opts.pathCull
            ? ` pathCull=${opts.pathCull.distanceM}m/${opts.pathCull.mode}(${opts.pathCull.points.length}pts${opts.pathCull.closed ? ',closed' : ''})`
            : ''),
    );

    const currentGameData = ctx.getCurrentGameData();

    try {
        if (!currentGameData?.gameId) throw new Error('No current game / gameId');

        // Source the GLB bytes — either from the inline payload (first
        // time) or by fetching the previously-uploaded URL (re-voxelize).
        let glbBuffer: ArrayBuffer;
        if (data.glbUrl) {
            const resp = await fetch(data.glbUrl);
            if (!resp.ok) throw new Error(`Failed to fetch source GLB: ${resp.status}`);
            glbBuffer = await resp.arrayBuffer();
        } else if (data.glbData) {
            glbBuffer = new Uint8Array(data.glbData).buffer;
        } else {
            throw new Error('Neither glbUrl nor glbData provided');
        }

        const result = await voxelizeGLBToVxlWorld(glbBuffer, {
            levelSizeX: opts.levelSizeX,
            levelSizeZ: opts.levelSizeZ,
            levelSizeY: opts.levelSizeY,
            chunkSize: opts.chunkSize,
            minVoxelSize: opts.minVoxelSize,
            maxVoxelSize: opts.maxVoxelSize,
            fillInterior: opts.fillInterior,
            additionalLods: opts.additionalLods,
            objectLodOffsets: opts.objectLodOffsets,
            objectLodPins: opts.objectLodPins,
            objectTrimeshColliders: opts.objectTrimeshColliders,
            objectNoColliders: opts.objectNoColliders,
            objectCollisionOnlyNodes: opts.objectCollisionOnlyNodes,
            objectDisplacementAxes: opts.objectDisplacementAxes,
            objectAssetInstances: opts.objectAssetInstances,
            objectGroundTypes: opts.objectGroundTypes,
            emissiveByColor: opts.emissiveByColor,
            materialByColor: opts.materialByColor,
            pathCull: opts.pathCull,
            onProgress: (info) => {
                ctx.safePostMessage({
                    type: 'VOXELIZE_GLB_AS_LEVEL_PROGRESS',
                    requestId: data.requestId,
                    chunkIndex: info.chunkIndex,
                    totalChunks: info.totalChunks,
                    nonEmptyChunks: info.nonEmptyChunks,
                    label: info.label,
                });
            },
        });

        const trimeshSuffix = result.totalTrimeshTriangles > 0
            ? `, ${result.totalTrimeshTriangles.toLocaleString()} tcol tris (${Math.round(result.totalTrimeshBytes / 1024)} KB)`
            : '';
        console.log(
            `[VOXELIZE_GLB_AS_LEVEL] complete: ${result.nonEmptyChunkCount} chunks, ` +
            `${result.totalLod0Leaves} LOD0 leaves, ${result.vwldBytes.byteLength} bytes` +
            trimeshSuffix,
        );

        // Upload the VWLD bytes to S3/CloudFront via the same path the
        // asset voxelizer uses. Mirrors `handleCreateAssetFromGlbUrl` so
        // the storage layout is consistent: gameId-prefixed key,
        // `.vwld` extension, octet-stream content type.
        ctx.safePostMessage({
            type: 'VOXELIZE_GLB_AS_LEVEL_PROGRESS',
            requestId: data.requestId,
            chunkIndex: -1,
            totalChunks: -1,
            nonEmptyChunks: result.nonEmptyChunkCount,
            label: 'Uploading .vwld…',
        });
        const safeName = data.levelName.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').slice(0, 48) || 'level';
        const filename = `${currentGameData.gameId}-${safeName}-${Date.now()}.vwld`;
        // The container is uploaded RAW and gzipped at upload (Content-Encoding), so the
        // at-rest/transfer size is far smaller than `vwldBytes.byteLength`. Capture it so
        // the creator can report the real (compressed) size, not the pre-compression bytes.
        let vwldCompressedSize = result.vwldBytes.byteLength;
        const vwldUrl = await uploadFile(result.vwldBytes, filename, {
            contentType: 'application/octet-stream',
            gameId: currentGameData.gameId,
            onUploaded: (n) => { vwldCompressedSize = n; },
        });
        if (!vwldUrl) throw new Error('Failed to upload VWLD file');
        console.log(`[VOXELIZE_GLB_AS_LEVEL] VWLD uploaded: ${vwldUrl}`);

        // Coarser variants of the same bake, for devices that should not download detail
        // they will not draw. A variant that fails to upload is simply absent — the
        // runtime falls back to the full file and sheds at load, which is what every level
        // baked before variants existed already does. Failing the whole level bake because
        // an optional smaller copy did not upload would be the wrong trade.
        const lodVariants: Array<{ drop: number; url: string; size: number; rawSize: number }> = [];
        for (const variant of result.lodVariants) {
            let variantSize = variant.bytes.byteLength;
            const variantUrl = await uploadFile(
                variant.bytes,
                `${currentGameData.gameId}-${safeName}-${Date.now()}-lod${variant.drop}.vwld`,
                {
                    contentType: 'application/octet-stream',
                    gameId: currentGameData.gameId,
                    onUploaded: (n) => { variantSize = n; },
                },
            );
            if (variantUrl) {
                // `size` is the at-rest/transfer size; `rawSize` is what the runtime inflates
                // into memory, which is the figure that predicts whether a device survives —
                // recording only the former left the catalog unable to show the one that matters.
                lodVariants.push({
                    drop: variant.drop,
                    url: variantUrl,
                    size: variantSize,
                    rawSize: variant.bytes.byteLength,
                });
                console.log(`[VOXELIZE_GLB_AS_LEVEL] LOD+${variant.drop} uploaded (${variantSize} B): ${variantUrl}`);
            } else {
                console.warn(`[VOXELIZE_GLB_AS_LEVEL] LOD+${variant.drop} variant upload failed — level keeps the full file only`);
            }
        }

        // Build the asset record the creator should hand to /api/add-asset.
        // `levelVoxelizeSettings` is echoed back so a future "Re-voxelize"
        // flow can read the exact inputs that produced this VWLD and
        // re-run with tweaked settings — same shape pattern the asset
        // voxelizer uses via `voxelizeSettings`.
        const idService = getObjectIdService();
        const assetId = idService.generateId('asset');
        const assetRecord = {
            id: assetId,
            name: safeName,
            url: vwldUrl,
            type: 'vwld' as const,
            // `size` is the at-rest/transfer (gzipped) size — what the catalog shows and
            // counts toward totals/publish limits. `rawSize` is the uncompressed container
            // the runtime inflates into memory (shown as a secondary figure).
            size: vwldCompressedSize,
            rawSize: result.vwldBytes.byteLength,
            ...(lodVariants.length > 0 ? { lodVariants } : {}),
            boundingBox: {
                minX: result.worldBounds.minX, minY: result.worldBounds.minY, minZ: result.worldBounds.minZ,
                maxX: result.worldBounds.maxX, maxY: result.worldBounds.maxY, maxZ: result.worldBounds.maxZ,
            },
            boundingBoxInMeters: true,
            sourceGlbName: data.levelName,
            // Echo the source GLB URL when we have one (re-voxelize path).
            // For the first-time path the creator side uploads the GLB and
            // fills this in before POSTing to /api/add-asset so the
            // Re-voxelize button appears on the resulting asset.
            sourceGlbUrl: data.glbUrl ?? null,
            levelVoxelizeSettings: {
                levelSizeX: opts.levelSizeX,
                levelSizeZ: opts.levelSizeZ,
                levelSizeY: opts.levelSizeY,
                chunkSize: opts.chunkSize,
                minVoxelSize: opts.minVoxelSize,
                maxVoxelSize: opts.maxVoxelSize,
                fillInterior: opts.fillInterior,
                additionalLods: opts.additionalLods ?? [],
                // Echo back so the Re-voxelize button can restore the
                // user's per-object +/- choices without making them
                // click through every object again.
                objectLodOffsets: opts.objectLodOffsets ?? {},
                objectLodPins: opts.objectLodPins ?? {},
                objectTrimeshColliders: opts.objectTrimeshColliders ?? {},
                objectNoColliders: opts.objectNoColliders ?? {},
                objectCollisionOnlyNodes: opts.objectCollisionOnlyNodes ?? {},
                objectDisplacementAxes: opts.objectDisplacementAxes ?? {},
                // Echo so re-voxelize keeps skipping library-asset instance
                // groups instead of baking the placeholder geometry.
                objectAssetInstances: opts.objectAssetInstances ?? {},
                // Echo so re-voxelize re-bakes the ground mask with the same typing.
                objectGroundTypes: opts.objectGroundTypes ?? {},
                // Echo so re-voxelize round-trips the same glow colors.
                emissiveByColor: opts.emissiveByColor ?? {},
                // Echo so re-voxelize round-trips the same material classes.
                materialByColor: opts.materialByColor ?? {},
                // Echo the path-cull CHOICE only — the polyline itself lives on
                // the asset's `worldForgerFeatures` and would just be a second,
                // drifting copy of it in world.json. Absent = the level was baked
                // whole (and the dialog opens with the cull switched off).
                pathCull: opts.pathCull
                    ? { distanceM: opts.pathCull.distanceM, mode: opts.pathCull.mode }
                    : undefined,
                // Per-object voxel counts from THIS bake — surfaced in
                // the next Re-voxelize dialog so users can see which
                // objects are heavy and pick the right ones to coarsen.
                perObjectVoxelCounts: result.perObjectVoxelCounts,
            },
        };

        ctx.safePostMessage({
            type: 'VOXELIZE_GLB_AS_LEVEL_RESULT',
            requestId: data.requestId,
            success: true,
            vwldUrl,
            vwldSize: result.vwldBytes.byteLength,
            vwldCompressedSize,
            assetRecord,
            worldBounds: result.worldBounds,
            chunkSize: result.chunkSize,
            nonEmptyChunkCount: result.nonEmptyChunkCount,
            totalLod0Leaves: result.totalLod0Leaves,
            totalTrimeshTriangles: result.totalTrimeshTriangles,
            totalTrimeshBytes: result.totalTrimeshBytes,
            emissiveUnmatched: result.emissiveUnmatched,
            materialUnmatched: result.materialUnmatched,
            materialNotes: result.materialNotes,
            warning: result.warning,
        });
    } catch (error) {
        console.error('[VOXELIZE_GLB_AS_LEVEL] Error:', error);
        ctx.safePostMessage({
            type: 'VOXELIZE_GLB_AS_LEVEL_RESULT',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Level voxelization failed',
        });
    }
}

/**
 * Apply a forger-authored `emissiveByColor` map (hex `#RRGGBB` → strength
 * 1..255) to already-encoded `.vxl` bytes: decode, resolve exact-cell matches
 * via `applyEmissiveByColor` (see `emissiveByColor.ts`), merge with whatever
 * emissive the bytes already carry (a match here never erases an existing
 * entry), and
 * re-encode ONLY when something actually matched (no pointless re-encode for
 * a no-op map). Decode, patch, encode — the v6 emissive block is the target.
 */
async function applyEmissiveByColorToVxl(
    vxlBytes: Uint8Array,
    emissiveByColor: Record<string, number>,
): Promise<{ bytes: Uint8Array; unmatched: string[] }> {
    // decodeVxlV3 wants a plain ArrayBuffer; copy the view (also detaches us
    // from any SharedArrayBuffer-backed input).
    const copy = new Uint8Array(vxlBytes.byteLength);
    copy.set(vxlBytes);
    const decoded = await decodeVxlV3(copy.buffer);
    const { colors, emissive: current } = collectVxlPalette(decoded);
    const { emissive: matched, unmatched } = applyEmissiveByColor(colors, emissiveByColor);
    if (!matched.some((v) => v > 0)) {
        return { bytes: vxlBytes, unmatched };
    }
    const merged = current.map((e, i) => Math.max(e, matched[i]!));
    const bytes = await applyEmissiveToVxlBytes(vxlBytes, merged);
    return { bytes, unmatched };
}

/**
 * Handle CREATE_ASSET_FROM_GLB_URL message from AI tool.
 * Fetches a GLB from URL, voxelizes it, uploads the VXL, and returns asset info.
 */
export async function handleCreateAssetFromGlbUrl(
    ctx: GameTemplateContext,
    data: {
        requestId: string;
        name: string;
        glbUrl: string;
        assetId?: string; // pre-generated id from the AI manifest — honored as the asset id
        options: {
            minVoxelSize: number;
            maxVoxelSize: number;
            targetHeight?: number;
            // Allocated box (m) from the World-Forger; when set and targetHeight is unset, the
            // voxelizer derives a height that fits the GLB within it (ExtractGlbForVoxelization).
            fitBox?: { x: number; z: number; height: number };
            fillInterior: boolean;
            preFragment?: { targetFragments?: number; individualVoxels?: number };
            algorithm?: 'surface' | 'octree';
            // True only for World-Forger placeholder bakes: the asset entry records it so the
            // editor can offer one-click HQ regeneration; any regeneration (which comes through
            // this same handler without the flag) clears it.
            placeholder?: boolean;
            /**
             * Bake-time per-color emissive: keys are `#RRGGBB` authored colors, values
             * 1..255 strength. Matched EXACTLY against the baked palette's RGB444 atlas
             * cells (see `emissiveByColor.ts`) and set on the `.vxl` v6 emissive block —
             * rune inlays, crystal veins, lava seams baked with zero manual editing.
             * Unmatched keys are reported back as `emissiveUnmatched` (a bake note, not
             * an error). Missing/empty = no emissive from this option (vehicle
             * auto-emissive, if any, still applies).
             */
            emissiveByColor?: Record<string, number>;
            /**
             * Bake-time per-color MATERIAL CLASSES: keys are `#RRGGBB` authored colors,
             * values the closed `VoxelMaterialClass` vocabulary. Each key claims the
             * baked colour group it lands in (exact cell, else one RGB444 step) and the
             * classes are written as the asset's material slots through the same plan
             * the classify path uses (`VxlMaterialByColor.ts`). Unmatched keys come
             * back as `materialUnmatched`, the slots written as `materialSlots`.
             */
            materialByColor?: Record<string, string>;
        };
    }
): Promise<void> {
    const opts = data.options;
    // Buildings/landmarks (large allocated box) bake an extra coarse LOD so they have
    // a LOD3 for the 300 m+ band (see EnvLodPolicy); small props keep the default 2.
    const additionalLods = buildAutoLodRamp(
        opts.minVoxelSize, opts.maxVoxelSize,
        additionalLodsForBake(opts.fitBox, opts.targetHeight ?? 0));
    console.log(`🧱 CREATE_ASSET_FROM_GLB_URL received: name=${data.name}, url=${data.glbUrl}, minVoxelSize=${opts.minVoxelSize}, preFragment=${opts.preFragment ? `target=${opts.preFragment.targetFragments ?? 50}` : 'off'}, lods=${1 + additionalLods.length}`);

    const currentGameData = ctx.getCurrentGameData();

    try {
        if (!data.glbUrl) {
            throw new Error('No GLB URL provided');
        }

        if (!currentGameData?.gameId) {
            throw new Error('No current game data or gameId');
        }

        // Fetch the GLB file
        console.log(`📥 Fetching GLB from: ${data.glbUrl}`);
        const glbResponse = await fetch(data.glbUrl);
        if (!glbResponse.ok) {
            throw new Error(`Failed to fetch GLB: ${glbResponse.status} ${glbResponse.statusText}`);
        }
        const glbBuffer = await glbResponse.arrayBuffer();
        console.log(`📦 GLB fetched: ${glbBuffer.byteLength} bytes`);

        // Read the object's description from the GLB scene extras (the World-Forger embeds it) so we
        // can store it on the asset — a later HQ regeneration is then prompted with the real
        // character (Helsinki Jugendstil, an invented landmark…), not a generic building.
        let glbDescription: string | undefined;
        try {
            const dv = new DataView(glbBuffer);
            if (dv.getUint32(0, true) === 0x46546C67) { // 'glTF' magic
                let off = 12;
                while (off + 8 <= dv.byteLength) {
                    const len = dv.getUint32(off, true);
                    if (dv.getUint32(off + 4, true) === 0x4E4F534A) { // 'JSON' chunk
                        const j = JSON.parse(new TextDecoder().decode(new Uint8Array(glbBuffer, off + 8, len)));
                        const d = j?.scenes?.[0]?.extras?.description;
                        if (typeof d === 'string' && d.trim()) glbDescription = d.trim();
                        break;
                    }
                    off += 8 + len;
                }
            }
        } catch { /* malformed GLB — skip description */ }

        // Voxelize the GLB. Extraction runs as its own phase so the vehicle
        // metadata it surfaces (bmVehicle extras, stripped BM_wheel_* nodes,
        // applied scale) is available for fitment derivation below.
        console.log(`🧱 Voxelizing GLB...`);
        const extracted = await extractGlbForVoxelization(glbBuffer, {
            minVoxelSize: opts.minVoxelSize,
            targetHeight: opts.targetHeight,
            fitBox: opts.fitBox,
        });
        // A smart prop (bmSmartObject extras + BM_part_* nodes, the World-Forger's
        // placeholders): its parts bake as the v12 part channel and its fitment and
        // lights go on the record, so the placeholder animates from this first bake.
        const smartDerivation = deriveSmartPropFromGlb(extracted);
        if (smartDerivation) {
            for (const warning of smartDerivation.warnings) console.warn(`⚠️ ${warning}`);
            console.log(`⚙️ bmSmartObject: ${smartDerivation.bake.table.map((p) => p.name).join(', ') || 'lights only'}`);
        }
        const voxResult = await voxelizeFromExtracted(extracted, {
            minVoxelSize: opts.minVoxelSize,
            maxVoxelSize: opts.maxVoxelSize,
            targetHeight: opts.targetHeight,
            fitBox: opts.fitBox,
            fillInterior: opts.fillInterior,
            preFragment: opts.preFragment,
            algorithm: opts.algorithm,
            ...(additionalLods.length > 0 ? { additionalLods } : {}),
            ...(smartDerivation ? { smartParts: smartDerivation.voxelizerInput } : {}),
        });

        // Vehicle GLBs (bmVehicle scene extras) get their fitment derived and
        // stored on the asset record — importing the GLB is all it takes to
        // make a drivable vehicle (VehicleSpawner.spawnFromAsset).
        const vehicleDerivation = deriveVehicleFitment(extracted.sceneExtras, {
            bodyBounds: extracted.preRebaseBounds,
            hasWheelNodes: extracted.hasBmWheelNodes,
            appliedScale: extracted.appliedScale,
        });
        if (vehicleDerivation) {
            console.log(`🚗 bmVehicle extension found: ${vehicleDerivation.fitment.axles.length} axles, wheels ${vehicleDerivation.fitment.hasWheelNodes ? 'from GLB nodes' : 'parametric'}`);
            for (const warning of vehicleDerivation.warnings) {
                console.warn(`⚠️ ${warning}`);
            }
        }

        console.log(`✅ Voxelization complete: ${voxResult.totalVoxels} voxels (LOD 0), ${voxResult.lodCount} LOD${voxResult.lodCount === 1 ? '' : 's'} [${voxResult.voxelsPerLod.join(', ')}], ${voxResult.fragmentCount} fragments, ${voxResult.nodeCount} octree nodes`);

        if (voxResult.warning) {
            console.warn(`⚠️ Voxelization warning: ${voxResult.warning}`);
        }

        // Vehicle lights are `BM_slot_*` MATERIALS, which the voxelizer has already
        // turned into material slots — each its own material, settable at runtime.
        let vxlData = voxResult.vxlBytes;

        // Bake-authored per-color emissive (World Forger rune inlays, crystal veins,
        // lava seams…): matched entries set the .vxl v6 emissive block; unmatched
        // keys are a bake note, never an error — see ASSET_FROM_GLB_URL_SAVED below.
        let emissiveUnmatched: string[] = [];
        if (opts.emissiveByColor && Object.keys(opts.emissiveByColor).length > 0) {
            try {
                const result = await applyEmissiveByColorToVxl(vxlData, opts.emissiveByColor);
                vxlData = result.bytes;
                emissiveUnmatched = result.unmatched;
            } catch (emissiveError) {
                console.warn('emissiveByColor bake failed — shipping without it:', emissiveError);
                emissiveUnmatched = Object.keys(opts.emissiveByColor);
            }
        }

        // Bake-authored material classes (a forged dungeon's plated bulkheads, a
        // ship's steel deck): written as slots now, so the asset shades as its
        // material from the first frame instead of waiting for a classifier.
        let materialUnmatched: string[] = [];
        let materialSlots: string[] = [];
        if (opts.materialByColor && Object.keys(opts.materialByColor).length > 0) {
            try {
                const result = await applyMaterialByColorToVxl(vxlData, opts.materialByColor);
                vxlData = result.bytes;
                materialUnmatched = result.unmatched;
                materialSlots = result.slots;
            } catch (materialError) {
                console.warn('materialByColor bake failed — shipping without it:', materialError);
                materialUnmatched = Object.keys(opts.materialByColor);
            }
        }

        // Upload the VXL to storage
        const timestamp = Date.now();
        const filename = `${currentGameData.gameId}-${data.name}-${timestamp}.vxl`;

        console.log(`📤 Uploading VXL: ${filename} (${vxlData.byteLength} bytes, ${voxResult.fragmentCount} fragments)`);
        const vxlUrl = await uploadFile(vxlData, filename, {
            contentType: 'application/octet-stream',
            gameId: currentGameData.gameId,
        });

        if (!vxlUrl) {
            throw new Error('Failed to upload VXL file');
        }

        console.log(`✅ VXL uploaded: ${vxlUrl}`);

        // What the voxelizer ACHIEVED, which is the requested size until the surface pass
        // overruns its leaf budget and re-bakes coarser. Recording the request instead leaves
        // world.json asserting a resolution the uploaded file contradicts — and the difference
        // is a doubling, so it is not a rounding detail.
        const bakedVoxelSize = voxResult.effectiveMinVoxelSize ?? opts.minVoxelSize;
        const budgetFactor = bakedVoxelSize / opts.minVoxelSize;

        // Create asset entry
        const saveService = new VoxelObjectSaveService();
        const assetId = saveService.addOrUpdateAsset(
            currentGameData, data.name, vxlUrl, voxResult.bounds,
            data.assetId, false, undefined, bakedVoxelSize
        );
        // The live record is MERGED by the save service, so a regeneration of a
        // smart placeholder into a static model must drop the stale parts itself.
        const registered = (currentGameData.assets ?? []).find((a: { id: string }) => a.id === assetId);
        if (registered) {
            if (smartDerivation) Object.assign(registered, smartDerivation.fields);
            else delete (registered as { smartObject?: unknown }).smartObject;
        }

        const asset = {
            id: assetId, name: data.name, url: vxlUrl, type: 'vxl',
            size: vxlData.length, boundingBox: voxResult.bounds,
            voxelSize: bakedVoxelSize, sourceGlbUrl: data.glbUrl,
            voxelCount: voxResult.totalVoxels,
            // The forger's allocated box — kept on the asset so a future HQ regen fits within it.
            ...(opts.fitBox ? { fitBox: opts.fitBox } : {}),
            // What this object should look like — used as the prompt when regenerating a HQ version.
            ...(glbDescription ? { description: glbDescription } : {}),
            // Explicit false (not absent) when the flag is unset: every regeneration rebuilds the
            // entry through this handler, so the stand-in marker self-clears on replacement.
            placeholder: opts.placeholder === true,
            // Vehicle assets: the derived fitment makes the asset drivable as-is.
            ...(vehicleDerivation ? { vehicleFitment: vehicleDerivation.fitment } : {}),
            // Smart props: the moving parts' fitment and the lights, in the asset frame.
            ...(smartDerivation ? smartDerivation.fields : {}),
            // How it was produced, kept so the Regenerate offer never expires.
            // This handler is the generator path; the creator's upload flow
            // overwrites the method with 'uploaded' when the GLB came from the
            // user, since only it knows that.
            //
            // EXCEPT for a forger stand-in. The World Forger voxelizes its
            // archetypes through this same handler, but its GLB is a composition
            // of primitive parts — the box model the placeholder badge names —
            // and no generator ever ran. Stamping those `generated` made the
            // inspector report "Produced by: AI-generated" on an obvious
            // placeholder, right above the button offering to generate it, which
            // reads as the generation having already happened. `placeholder` is
            // the one signal that separates the two, and only this call knows it.
            production: {
                method: opts.placeholder === true ? 'procedural' : 'generated',
                at: new Date().toISOString(),
                ...(glbDescription ? { prompt: glbDescription } : {}),
                ...(data.glbUrl ? { sourceUrl: data.glbUrl } : {}),
            } satisfies AssetProduction,
            voxelizeSettings: {
                // The achieved size, and the ladder scaled by the same factor, so this block and
                // `voxelSize` above can never describe two resolutions for one file.
                minVoxelSize: bakedVoxelSize, maxVoxelSize: opts.maxVoxelSize * budgetFactor,
                // fitBox-derived bakes store the ACHIEVED height, never "auto": the
                // re-voxelize dialog doesn't round-trip fitBox, so an undefined
                // targetHeight would rescale to the GLB's natural size on re-bake.
                targetHeight: opts.targetHeight
                    ?? (opts.fitBox ? Math.round((voxResult.bounds.maxY - voxResult.bounds.minY) * 100) / 100 : undefined),
                fillInterior: opts.fillInterior,
                // Persist the auto-derived LOD ramp so the re-voxelize dialog
                // round-trips it (otherwise CONVERT silently re-bakes as v3 and
                // drops the LODs baked into the binary). Matches the manual
                // creator voxelize path (useAssetsEditor persists additionalLods).
                ...(additionalLods.length > 0 ? { additionalLods } : {}),
                // Echo so a future regeneration/re-voxelize keeps the same glow colors.
                ...(opts.emissiveByColor ? { emissiveByColor: opts.emissiveByColor } : {}),
                ...(opts.materialByColor ? { materialByColor: opts.materialByColor } : {}),
            },
        };

        console.log(`✅ CREATE_ASSET_FROM_GLB_URL complete: ${data.name}, id: ${assetId}`);

        ctx.safePostMessage({
            type: 'ASSET_FROM_GLB_URL_SAVED',
            requestId: data.requestId,
            success: true,
            asset,
            emissiveUnmatched,
            materialUnmatched,
            materialSlots,
        });

    } catch (error) {
        console.error('[CREATE_ASSET_FROM_GLB_URL] Error:', error);
        ctx.safePostMessage({
            type: 'ASSET_FROM_GLB_URL_SAVED',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create asset from GLB URL',
        });
    }
}

/**
 * Handle REGISTER_GLB_ASSET message from AI tool.
 * Registers a pre-uploaded GLB as an asset in the game's in-memory data.
 * No voxelization or upload — the GLB URL must already be accessible.
 */
export async function handleRegisterGlbAsset(
    ctx: GameTemplateContext,
    data: {
        requestId: string;
        asset: {
            id: string;
            name: string;
            url: string;
            type: string;
            size: number;
            screenshotUrl?: string;
            source?: string;
            thrixelSubmissionId?: string;
        };
    }
): Promise<void> {
    console.log(`📦 REGISTER_GLB_ASSET received: name=${data.asset.name}, url=${data.asset.url}`);

    const currentGameData = ctx.getCurrentGameData();

    try {
        if (!currentGameData) {
            throw new Error('No current game data');
        }

        if (!currentGameData.assets) {
            currentGameData.assets = [];
        }

        const existing = currentGameData.assets.findIndex(
            (a: { id: string }) => a.id === data.asset.id
        );
        if (existing >= 0) {
            currentGameData.assets[existing] = data.asset;
        } else {
            currentGameData.assets.push(data.asset);
        }

        console.log(`✅ REGISTER_GLB_ASSET complete: ${data.asset.name}, id: ${data.asset.id}`);

        ctx.safePostMessage({
            type: 'GLB_ASSET_REGISTERED',
            requestId: data.requestId,
            success: true,
            asset: data.asset,
        });
    } catch (error) {
        console.error('[REGISTER_GLB_ASSET] Error:', error);
        ctx.safePostMessage({
            type: 'GLB_ASSET_REGISTERED',
            requestId: data.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Failed to register GLB asset',
        });
    }
}
