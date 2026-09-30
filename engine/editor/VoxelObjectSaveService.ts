import { VoxelObject } from '../engine/VoxelObject.js';
import type { GameData, Asset } from '../types/game.js';
import type { EnvironmentObjectSystem } from '../engine/EnvironmentObjectSystem.js';
import { uploadFile } from '../engine/StorageUploadUtil.js';
import { convertChunkObjectToOctree } from '../engine/VoxelChunkToOctree.js';
import { VoxelObjectBuilder } from '../engine/builders/VoxelObjectBuilder.js';
import { getObjectIdService } from '../engine/ObjectIdService.js';
import { activeLevelTag } from '../engine/template/EnvObjectRecord.js';
import { safePostMessageToCreator } from '../engine/CreatorMode.js';

/**
 * Service for saving VoxelObject data to S3 and managing assets.
 * Handles the conversion of procedural objects to assets.
 */
export class VoxelObjectSaveService {
    /**
     * Save a VoxelObject to S3 and add/update it in the assets array.
     * Uses presigned URL for direct S3 upload.
     *
     * @param voxelObject - The VoxelObject to save
     * @param prefabType - The prefab type (e.g., 'voxelTree', 'voxelRock')
     * @param gameData - The current game data
     * @returns The S3 URL of the saved file, or null on failure
     */
    async saveVoxelObjectAsAsset(
        voxelObject: VoxelObject,
        prefabType: string,
        gameData: GameData | null
    ): Promise<{ url: string; size: number } | null> {
        const gameId = gameData?.gameId;
        if (!gameId) {
            console.error('[VoxelObjectSaveService] Cannot save: no gameId');
            return null;
        }

        // Generate timestamped filename (timestamp only in filename, not in asset name)
        const timestamp = Date.now();
        const filename = `${gameId}-${prefabType}-${timestamp}.vxl`;

        // Every write produces VXL3. A chunk-backed object (anything built by
        // VoxelObjectBuilder, i.e. all procedural props) would otherwise
        // serialise as the legacy `{"chunks":…}` JSON — wasteful, and unable to
        // carry material slots, so such a prop could never glow. Converting
        // here is the one choke point every save path goes through: procedural
        // creation, scene-unlock conversion, make-unique, and voxel edits.
        // Textured-block objects decline and keep the old format.
        convertChunkObjectToOctree(voxelObject);

        const vxlArrayBuffer = await voxelObject.toVXL();
        const vxlBytes = new Uint8Array(vxlArrayBuffer);

        try {
            // Upload directly to S3 using presigned URL (with long-term caching enabled)
            const s3Url = await uploadFile(vxlBytes, filename, {
                contentType: 'application/octet-stream',
                gameId
            });

            if (!s3Url) {
                console.error('[VoxelObjectSaveService] Upload failed');
                return null;
            }

            console.log(`[VoxelObjectSaveService] Uploaded ${filename} to ${s3Url} (${vxlBytes.length} bytes)`);

            return {
                url: s3Url,
                size: vxlBytes.length
            };
        } catch (error) {
            console.error('[VoxelObjectSaveService] Upload error:', error);
            return null;
        }
    }
    
    /**
     * Add or update an asset in the assets array.
     * Uses assetId for reliable matching when updating.
     * 
     * @param existingAssetId - If provided, updates the asset with this ID instead of creating new
     */
    addOrUpdateAsset(
        gameData: GameData,
        prefabType: string,
        url: string,
        boundingBox?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
        existingAssetId?: string,
        flattenTerrain?: boolean,
        flattenMargin?: number,
        voxelSize?: number,
        colliderShape?: 'box' | 'sphere'
    ): string {
        if (!gameData.assets) {
            gameData.assets = [];
        }
        
        // If we have an existing asset ID, find and update it
        if (existingAssetId) {
            const existingIndex = gameData.assets.findIndex(a => a.id === existingAssetId);
            if (existingIndex >= 0) {
                // Update existing asset - keep the ID and name, only update URL
                const existing = gameData.assets[existingIndex]!;
                console.log(`[VoxelObjectSaveService] Updating asset id="${existingAssetId}" URL`);
                gameData.assets[existingIndex] = {
                    ...existing,
                    url,
                    boundingBox,
                    boundingBoxInMeters: boundingBox ? true : existing.boundingBoxInMeters,
                    flattenTerrain: flattenTerrain ?? existing.flattenTerrain,
                    flattenMargin: flattenMargin ?? existing.flattenMargin,
                    voxelSize: voxelSize ?? existing.voxelSize,
                    colliderShape: colliderShape ?? existing.colliderShape
                };
                return existingAssetId;
            }
        }
        
        // Create new asset. Honor a supplied (pre-generated) id even when it has no existing
        // match: the AI orchestrator pre-mints asset ids that the coding agent references in
        // code, so the asset MUST land under that exact id. Only mint a fresh id when none
        // was supplied.
        const idService = getObjectIdService();
        const newAssetId = existingAssetId ?? idService.generateId('asset');
        const asset: Asset = {
            id: newAssetId,
            name: prefabType,  // Stable name like "voxelTree"
            url,
            type: 'vxl',
            boundingBox,
            boundingBoxInMeters: boundingBox ? true : undefined,
            flattenTerrain: flattenTerrain ?? false,
            flattenMargin,
            voxelSize,
            colliderShape
        };
        
        console.log(`[VoxelObjectSaveService] Adding new asset id="${newAssetId}", name="${prefabType}"`);
        gameData.assets.push(asset);
        return newAssetId;
    }
    
    /**
     * Update all environmentObjects of a prefabType to reference the asset by ID.
     * This converts procedural objects to asset references.
     */
    updateEnvironmentObjectsForPrefab(
        gameData: GameData,
        prefabType: string,
        assetId: string
    ): number {
        if (!gameData.environmentObjects) {
            return 0;
        }
        
        let count = 0;
        
        for (const obj of gameData.environmentObjects) {
            // Match objects by type (procedural prefabs) or by assetId (unique/uploaded assets)
            const isMatch = obj.type === prefabType || obj.assetId === assetId;
            
            if (isMatch) {
                // Convert to asset reference by ID
                obj.assetId = assetId;
                // Remove redundant fields - URL/name/type looked up from assets array
                delete obj.assetUrl;
                delete obj.assetName;
                delete obj.assetType;
                count++;
            }
        }
        
        console.log(`[VoxelObjectSaveService] Updated ${count} environmentObjects to reference assetId="${assetId}"`);
        return count;
    }
    
    /**
     * Find existing assetId for a prefabType from environmentObjects.
     * Returns the assetId if any object of this type already references an asset.
     */
    findExistingAssetIdForPrefab(gameData: GameData, prefabType: string): string | null {
        if (!gameData.environmentObjects) {
            return null;
        }
        
        for (const obj of gameData.environmentObjects) {
            // Check by type (procedural prefabs) - assetId links to the asset
            if (obj.type === prefabType && obj.assetId) {
                return obj.assetId;
            }
        }
        
        return null;
    }
    
    /**
     * Complete flow: Save voxel object, update assets, update environmentObjects.
     *
     * @param voxelObject - The VoxelObject to save
     * @param prefabType - The prefab type name (e.g., 'wooden_barrel')
     * @param gameData - Current game data
     * @param newInstance - Optional: placement info for a NEW instance (for AI tool creation)
     */
    async saveAndUpdateAll(
        voxelObject: VoxelObject,
        prefabType: string,
        gameData: GameData | null,
        newInstance?: { position: { x: number; y: number; z: number } }
    ): Promise<boolean> {
        console.log('[VoxelObjectSaveService] saveAndUpdateAll called for:', prefabType, newInstance ? '(with new instance)' : '');

        if (!gameData) {
            console.error('[VoxelObjectSaveService] Cannot save: no gameData');
            return false;
        }

        console.log('[VoxelObjectSaveService] gameData.assets:', gameData.assets?.length || 0, 'items');
        console.log('[VoxelObjectSaveService] gameData.environmentObjects:', gameData.environmentObjects?.length || 0, 'items');

        // Check if this prefab type already has an asset (re-editing)
        const existingAssetId = this.findExistingAssetIdForPrefab(gameData, prefabType);
        console.log('[VoxelObjectSaveService] existingAssetId:', existingAssetId);

        const bounds = voxelObject.getBoundsInWorldUnits();
        const boundingBox = bounds ? { ...bounds } : undefined;

        // Upload to S3
        const result = await this.saveVoxelObjectAsAsset(voxelObject, prefabType, gameData);
        if (!result) {
            return false;
        }

        // Add or update asset in assets array (use existing ID if re-editing)
        const assetId = this.addOrUpdateAsset(
            gameData,
            prefabType,
            result.url,
            boundingBox,
            existingAssetId || undefined
        );

        // Update environmentObjects to reference asset by ID
        this.updateEnvironmentObjectsForPrefab(gameData, prefabType, assetId);

        // If this is a NEW instance creation (from AI tool), create an environmentObjects entry
        let newEnvObject: Record<string, unknown> | undefined;
        if (newInstance) {
            const instanceId = getObjectIdService().generateId('inst');
            newEnvObject = {
                id: instanceId,
                type: prefabType,
                // Belongs to the level loaded right now — untagged would be global.
                ...activeLevelTag(),
                assetId: assetId,
                position: {
                    x: newInstance.position.x,
                    y: newInstance.position.y,
                    z: newInstance.position.z
                },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 }
            };

            // Add to gameData
            if (!gameData.environmentObjects) {
                gameData.environmentObjects = [];
            }
            gameData.environmentObjects.push(newEnvObject);
            console.log('[VoxelObjectSaveService] Created new environmentObject:', instanceId);
        }

        // Notify parent to save world.json with the full asset data we just wrote.
        //
        // The lookup must not be allowed to come back empty. The creator only
        // persists this message when it carries an asset with an id, and it has
        // no branch for one that doesn't — so an undefined `asset` here is a
        // save that uploads its bytes, reports success, and then quietly never
        // reaches world.json. Falling back to the record we just wrote (the same
        // thing `VoxelEditor.makeUnique` does) means a save either lands or says
        // why, never neither.
        const assetToSend = gameData.assets?.find(a => a.id === assetId)
            ?? { id: assetId, name: prefabType, url: result.url, type: 'vxl' as const, boundingBox };
        console.log('[VoxelObjectSaveService] Sending VOXEL_ASSET_SAVED:', JSON.stringify(assetToSend));

        safePostMessageToCreator({
            type: 'VOXEL_ASSET_SAVED',
            prefabType,
            asset: assetToSend,
            // Include the new environment object if created
            environmentObjects: newEnvObject ? [newEnvObject] : []
        });

        return true;
    }
    
    /**
     * Upload one representative of `typeName` and build the asset record plus one
     * environmentObjects record per instance. Shared by both discovery passes of
     * `convertAllProceduralToAssets` (EnvironmentObjectSystem-tracked types and
     * VoxelObjectBuilder-created objects). Returns null when the upload fails.
     */
    private async convertInstancesToAsset(
        typeName: string,
        objects: VoxelObject[],
        gameData: GameData
    ): Promise<{ asset: Asset; instances: Record<string, unknown>[] } | null> {
        const representative = objects[0]!;

        const uploadResult = await this.saveVoxelObjectAsAsset(representative, typeName, gameData);
        if (!uploadResult) {
            console.error(`[VoxelObjectSaveService] Failed to upload ${typeName}`);
            return null;
        }

        const bounds = representative.getBounds();
        const idService = getObjectIdService();
        const asset: Asset = {
            id: idService.generateId('asset'),
            name: typeName,
            url: uploadResult.url,
            type: 'vxl',
            size: uploadResult.size,
            boundingBox: bounds ? { ...bounds } : undefined
        };

        // Each instance gets a unique ID, mirrored onto the VoxelObject's userData
        // so the live object and its saved record stay linked.
        const instances = objects.map(obj => {
            const instanceId = idService.generateId('inst');
            obj.userData.id = instanceId;
            return {
                id: instanceId,
                type: typeName,
                assetId: asset.id,
                position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
                rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
                scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
            };
        });

        console.log(`[VoxelObjectSaveService] Created asset "${typeName}" with ${instances.length} instances`);
        return { asset, instances };
    }

    /**
     * Convert ALL procedural voxel objects to assets.
     * This is called when unlocking the scene for editing.
     * 
     * IMPORTANT: Only converts objects tracked by EnvironmentObjectSystem (procedurally generated).
     * Does NOT touch any manually placed objects that already exist in environmentObjects.
     * 
     * For each registered type (voxelTree, voxelRock, etc.):
     * 1. Gets objects from EnvironmentObjectSystem's tracked storage
     * 2. Picks one representative object per type
     * 3. Uploads it to S3 as an asset
     * 4. Creates asset entry in assets array
     * 5. Saves all instances as environmentObjects referencing the asset
     * 
     * @param environmentObjectSystem - The system that tracks procedurally generated objects
     * @param gameData - Current game data
     * @returns Object with assets and environmentObjects arrays for saving to world.json
     */
    async convertAllProceduralToAssets(
        environmentObjectSystem: EnvironmentObjectSystem,
        gameData: GameData | null
    ): Promise<{ 
        success: boolean; 
        assets: Asset[]; 
        environmentObjects: any[];
        message: string;
    }> {
        if (!gameData) {
            return { success: false, assets: [], environmentObjects: [], message: 'No gameData' };
        }
        
        console.log('[VoxelObjectSaveService] Converting procedural voxel objects to assets...');
        
        // Get all registered type names from EnvironmentObjectSystem
        const registeredTypes = environmentObjectSystem.getRegisteredTypeNames();
        
        const assets: Asset[] = [];
        const environmentObjects: any[] = [];
        
        // Every registered type, plus the VoxelObjectBuilder-created objects that
        // EnvironmentObjectSystem doesn't track at all. Tracked storage is typed as
        // Object3D[], so narrow it to the VoxelObjects that can actually be exported.
        const groups = registeredTypes.map((typeName): [string, VoxelObject[]] => [
            typeName,
            environmentObjectSystem.getVoxelObjects(typeName)
                .filter((obj): obj is VoxelObject => obj instanceof VoxelObject)
        ]);
        for (const [objectName, objects] of VoxelObjectBuilder.getObjectsGroupedByName()) {
            // Skip if this name was already processed as an EnvironmentObjectSystem type
            if (registeredTypes.includes(objectName)) {
                console.log(`[VoxelObjectSaveService] Skipping "${objectName}" - already processed as EnvironmentObjectSystem type`);
                continue;
            }
            groups.push([objectName, objects]);
        }

        for (const [typeName, objects] of groups) {
            if (objects.length === 0) {
                continue;
            }

            console.log(`[VoxelObjectSaveService] Processing ${objects.length} ${typeName} objects`);
            const converted = await this.convertInstancesToAsset(typeName, objects, gameData);
            if (!converted) {
                continue;
            }
            assets.push(converted.asset);
            environmentObjects.push(...converted.instances);
        }

        if (assets.length === 0) {
            return {
                success: true,
                assets: [],
                environmentObjects: [],
                message: 'No procedural voxel objects found'
            };
        }
        
        // IMPORTANT: Update gameData with the created assets and environmentObjects
        // This keeps the game's in-memory state in sync with what's saved to world.json.
        // Every asset above carries a freshly minted id, so these are all additions.
        if (!gameData.assets) {
            gameData.assets = [];
        }
        gameData.assets.push(...assets);

        // Replace environmentObjects with the new ones (they now have assetId references)
        gameData.environmentObjects = environmentObjects;

        console.log(`[VoxelObjectSaveService] Updated gameData: ${gameData.assets.length} assets, ${gameData.environmentObjects.length} environmentObjects`);
        
        return {
            success: true,
            assets,
            environmentObjects,
            message: `Converted ${assets.length} asset types with ${environmentObjects.length} total instances`
        };
    }
    
}

