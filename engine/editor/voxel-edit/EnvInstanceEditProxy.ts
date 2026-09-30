/**
 * Editing proxies that stand in for a VXL asset during a voxel edit session.
 *
 * Two entry points, one job — put a real, editable `VoxelObject` in the scene
 * for something that isn't one:
 *
 *  - `createEnvInstanceEditProxy` — a placed environment instance. In the
 *    Editor tab those render as InstancedMesh batches that unpack to plain
 *    `THREE.Mesh`es sharing the template geometry, so there is no per-instance
 *    `VoxelObject` to edit. The proxy loads the instance's ASSET and sits
 *    exactly over it (same parent + local transform, both pivot-relative),
 *    hiding the instance mesh underneath.
 *
 *  - `createAssetEditProxy` — an asset opened straight from the Assets tab,
 *    with no placement anywhere in the world. The proxy is parked at the
 *    scene origin; the session's isolated view hides everything else and
 *    frames it, so where it sits is invisible to the user.
 *
 * Both tag the proxy with the assetId so `VoxelEditor.saveEditedObject` takes
 * the unique-asset path — the edit updates the ASSET record, i.e. every
 * instance, which is the designed prefab semantics
 * (docs/voxel-editor-design.md §3.1).
 */

import * as THREE from 'three';
import { VoxelObject } from 'engine/VoxelObject.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';
import type { GameData } from 'types/game.js';

export interface EnvInstanceEditProxy {
    voxelObject: VoxelObject;
    /** Remove the proxy from the scene and restore the hidden instance mesh. */
    dispose(): void;
}

export interface EnvInstanceProxyResult {
    proxy: EnvInstanceEditProxy | null;
    error: string | null;
}

interface AssetRecord {
    id: string;
    name?: string;
    url?: string;
    type?: string;
}

/** Fetch + decode an asset's `.vxl` into a standalone, unparented VoxelObject. */
async function loadAssetVoxelObject(
    asset: AssetRecord | null | undefined,
): Promise<{ voxelObject: VoxelObject | null; error: string | null }> {
    if (!asset?.url || asset.type !== 'vxl') {
        return { voxelObject: null, error: 'This object has no editable voxel asset' };
    }

    let buffer: ArrayBuffer;
    try {
        const response = await fetch(ASSET_MAP.get(asset.url) ?? asset.url);
        if (!response.ok) {
            return { voxelObject: null, error: `Could not load voxel data (${response.status})` };
        }
        buffer = await response.arrayBuffer();
    } catch (error) {
        console.warn('[EnvInstanceEditProxy] Asset fetch failed:', error);
        return { voxelObject: null, error: 'Could not load voxel data' };
    }

    // Constructor flags are refined by the file itself: VXL v3 headers carry
    // voxelSize/useAtlas; legacy JSON metadata is applied by loadFromFile.
    const voxelObject = new VoxelObject({ voxelSize: 0.5, useAtlas: false, shadows: true });
    try {
        await voxelObject.loadFromFile(buffer);
    } catch (error) {
        console.warn('[EnvInstanceEditProxy] Asset decode failed:', error);
        voxelObject.dispose();
        return { voxelObject: null, error: 'Could not decode voxel data' };
    }
    return { voxelObject, error: null };
}

/**
 * Load an asset for editing with no placed instance to hang it on — the
 * Assets-tab entry point. Parked at the scene origin because the session's
 * isolated view hides the rest of the world and frames the object anyway.
 */
export async function createAssetEditProxy(
    assetId: string,
    gameData: GameData,
    scene: THREE.Scene,
): Promise<EnvInstanceProxyResult> {
    const asset = (gameData.assets || []).find((a: { id: string }) => a.id === assetId);
    if (!asset) return { proxy: null, error: 'Asset not found' };

    const { voxelObject, error } = await loadAssetVoxelObject(asset);
    if (!voxelObject) return { proxy: null, error };

    voxelObject.position.set(0, 0, 0);
    voxelObject.name = asset.name || 'VoxelObject';
    (voxelObject.userData as { assetId?: string }).assetId = asset.id;

    scene.add(voxelObject);
    voxelObject.updateMatrixWorld(true);

    return {
        proxy: {
            voxelObject,
            dispose(): void {
                scene.remove(voxelObject);
                voxelObject.dispose();
            },
        },
        error: null,
    };
}

export async function createEnvInstanceEditProxy(
    instanceMesh: THREE.Object3D,
    gameData: GameData,
): Promise<EnvInstanceProxyResult> {
    const userData = instanceMesh.userData as {
        environmentType?: string;
        objectId?: string;
    };

    const envObj = userData.objectId
        ? (gameData.environmentObjects || []).find((o: { id: string }) => o.id === userData.objectId)
        : null;
    const asset = envObj?.assetId
        ? (gameData.assets || []).find((a) => a.id === envObj.assetId)
        : null;
    if (!asset) return { proxy: null, error: 'This object has no editable voxel asset' };

    const { voxelObject, error } = await loadAssetVoxelObject(asset);
    if (!voxelObject) return { proxy: null, error };

    // Same parent + same local transform as the clicked instance: both the
    // instance geometry and the proxy mesh are pivot-relative, so they
    // overlap exactly.
    voxelObject.position.copy(instanceMesh.position);
    voxelObject.rotation.copy(instanceMesh.rotation);
    voxelObject.scale.copy(instanceMesh.scale);
    voxelObject.name = instanceMesh.name || userData.environmentType || 'VoxelObject';

    // Save routing: assetId → VoxelEditor.saveEditedObject unique-asset path
    // (updates the asset record in place — all instances pick it up on reload).
    const proxyUserData = voxelObject.userData as { assetId?: string; environmentType?: string; objectId?: string };
    proxyUserData.assetId = asset.id;
    if (userData.environmentType) proxyUserData.environmentType = userData.environmentType;
    if (userData.objectId) proxyUserData.objectId = userData.objectId;

    const parent = instanceMesh.parent;
    if (!parent) {
        voxelObject.dispose();
        return { proxy: null, error: 'Object is not in the scene' };
    }
    parent.add(voxelObject);
    voxelObject.updateMatrixWorld(true);

    const instanceWasVisible = instanceMesh.visible;
    instanceMesh.visible = false;

    return {
        proxy: {
            voxelObject,
            dispose(): void {
                parent.remove(voxelObject);
                voxelObject.dispose();
                instanceMesh.visible = instanceWasVisible;
            },
        },
        error: null,
    };
}
