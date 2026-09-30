import { VoxelObject } from '../engine/VoxelObject.js';
import type { EnvironmentObjectSystem } from '../engine/EnvironmentObjectSystem.js';
import type { GameData } from '../types/game.js';
import { VoxelObjectSaveService } from './VoxelObjectSaveService.js';
import { safePostMessageToCreator } from '../engine/CreatorMode.js';

/**
 * VoxelEditor - Handles voxel editing production features
 * Manages updating prefab instances after editing, saving, etc.
 */
export class VoxelEditor {
    private environmentObjectSystem: EnvironmentObjectSystem;
    private saveService: VoxelObjectSaveService;

    constructor(environmentObjectSystem: EnvironmentObjectSystem) {
        this.environmentObjectSystem = environmentObjectSystem;
        this.saveService = new VoxelObjectSaveService();
    }

    /**
     * Get the save service for direct access (e.g., for make unique operations)
     */
    getSaveService(): VoxelObjectSaveService {
        return this.saveService;
    }

    /**
     * Update all instances of a prefab with the edited object's data.
     * Called when editing is finished and changes were made.
     */
    updateAllPrefabInstances(editedObject: VoxelObject): void {
        const prefabType = this.getPrefabType(editedObject);
        if (!prefabType) {
            console.log('[VoxelEditor] No prefab type found, skipping instance update');
            return;
        }
        
        console.log(`[VoxelEditor] Updating all instances of prefab type: ${prefabType}`);
        
        // Get all VoxelObjects of this type from the EnvironmentObjectSystem
        const allObjects = this.environmentObjectSystem.getVoxelObjects(prefabType);
        const instances = allObjects.filter(obj => obj !== editedObject && obj instanceof VoxelObject) as VoxelObject[];
        
        console.log(`[VoxelEditor] Found ${instances.length} other instances to update`);
        
        // Clone data to each instance
        for (const instance of instances) {
            editedObject.cloneDataTo(instance);
        }
        
        if (instances.length > 0) {
            console.log(`[VoxelEditor] Updated ${instances.length} instances of ${prefabType}`);
        }
    }
    
    /**
     * Get the prefab type for a VoxelObject
     */
    getPrefabType(voxelObject: VoxelObject): string | null {
        // Check userData.environmentType FIRST (for unique objects)
        const userData = voxelObject.userData as { environmentType?: string };
        if (userData.environmentType) {
            return userData.environmentType;
        }
        
        // Fall back to name-based detection for procedural prefabs
        const name = voxelObject.name.toLowerCase();
        if (name.includes('tree')) return 'voxelTree';
        if (name.includes('rock')) return 'voxelRock';
        
        return null;
    }
    
    /**
     * Check if a VoxelObject is a prefab (has other instances)
     */
    isPrefab(voxelObject: VoxelObject): boolean {
        const prefabType = this.getPrefabType(voxelObject);
        if (!prefabType) return false;
        
        // Get count from EnvironmentObjectSystem
        const count = this.environmentObjectSystem.getInstanceCount(prefabType);
        return count > 1;
    }
    
    /**
     * Get instance count for a prefab type
     */
    getInstanceCount(prefabType: string): number {
        return this.environmentObjectSystem.getInstanceCount(prefabType);
    }
    
    /**
     * Unlock scene for editing - converts all procedural voxel objects to assets.
     * Only converts objects tracked by EnvironmentObjectSystem (procedurally generated).
     * Does NOT touch manually placed objects already in environmentObjects.
     * 
     * @param gameData - Current game data
     * @returns Result containing assets and environmentObjects to save to world.json
     */
    async unlockScene(gameData: GameData | null): Promise<{
        success: boolean;
        assets: any[];
        environmentObjects: any[];
        message: string;
    }> {
        if (!gameData) {
            console.error('[VoxelEditor] Cannot unlock: no gameData');
            return { success: false, assets: [], environmentObjects: [], message: 'No gameData' };
        }
        
        console.log('[VoxelEditor] Unlocking scene - converting procedural objects to assets...');
        
        // Convert only procedurally generated voxel objects to assets
        const result = await this.saveService.convertAllProceduralToAssets(
            this.environmentObjectSystem,
            gameData
        );
        
        if (!result.success) {
            console.error('[VoxelEditor] Failed to convert:', result.message);
            return result;
        }
        
        console.log(`[VoxelEditor] ${result.message}`);
        return result;
    }
    
    /**
     * Save edited voxel object as asset and update all instances.
     * Called when editing is finished and changes were made.
     */
    async saveEditedObject(
        editedObject: VoxelObject,
        gameData: GameData | null
    ): Promise<boolean> {
        console.log('[VoxelEditor] saveEditedObject called');
        console.log('[VoxelEditor] gameData available:', !!gameData);
        
        if (!gameData) {
            console.warn('[VoxelEditor] Cannot save: no gameData');
            return false;
        }
        
        // Check if this is a unique object (has its own assetId in userData)
        const userData = editedObject.userData as { assetId?: string; environmentType?: string };
        if (userData.assetId) {
            console.log('[VoxelEditor] Saving unique object with assetId:', userData.assetId);
            return this.saveUniqueObject(editedObject, userData.assetId, userData.environmentType || 'unique', gameData);
        }
        
        // Otherwise, it's a shared prefab - use type-based saving
        const prefabType = this.getPrefabType(editedObject);
        console.log('[VoxelEditor] prefabType:', prefabType);
        
        if (!prefabType) {
            console.warn('[VoxelEditor] Cannot save: no prefab type');
            return false;
        }
        
        // Update all other instances with the edited data
        this.updateAllPrefabInstances(editedObject);
        
        // Save to S3 and update assets/environmentObjects
        console.log('[VoxelEditor] Calling saveService.saveAndUpdateAll...');
        const saved = await this.saveService.saveAndUpdateAll(
            editedObject,
            prefabType,
            gameData
        );
        
        if (saved) {
            console.log(`[VoxelEditor] ✅ Successfully saved ${prefabType}`);
        } else {
            console.warn(`[VoxelEditor] ❌ Failed to save ${prefabType}`);
        }
        
        return saved;
    }

    /**
     * Save a unique object (identified by assetId, not by type)
     */
    private async saveUniqueObject(
        editedObject: VoxelObject,
        assetId: string,
        typeName: string,
        gameData: GameData
    ): Promise<boolean> {
        // Log checksum of object being saved
        const { calculateVoxelObjectChecksum } = await import('./VoxelChecksum.js');
        const saveChecksum = calculateVoxelObjectChecksum(editedObject);
        console.log(`[VoxelEditor] saveUniqueObject: checksum=${saveChecksum}`);
        
        // Upload to S3
        const uploadResult = await this.saveService.saveVoxelObjectAsAsset(editedObject, typeName, gameData);
        if (!uploadResult) {
            console.error('[VoxelEditor] Failed to upload unique object');
            return false;
        }

        // Update the asset URL in gameData by assetId
        if (gameData.assets) {
            const asset = gameData.assets.find(a => a.id === assetId);
            if (asset) {
                asset.url = uploadResult.url;
                // Size travels with the bytes. Leaving it stale makes the catalog report a
                // figure from whenever the asset was FIRST created — one asset in a real
                // game read 341.8 KB for a 2.4 KB file, a 145x overstatement, on the very
                // screen used to hunt for heavy assets. Every path that rewrites the bytes
                // rewrites this.
                asset.size = uploadResult.size;
                // Source-retained assets are now hand-edited: the creator's
                // Re-voxelize / Re-import flows warn before overwriting
                // (docs/voxel-editor-design.md §3.1). The flag rides the
                // VOXEL_ASSET_SAVED asset record into world.json.
                // sourceVxlMasterUrl counts too — `revoxelizeFromMaster` reads
                // the same flag, so leaving it out silently discarded hand
                // edits on every forged asset.
                if (asset.sourceGlbUrl || asset.sourceModelUrl || asset.sourceVxlMasterUrl) {
                    asset.voxelEdited = true;
                }
                console.log('[VoxelEditor] Updated asset URL for', assetId);
            }
        }

        // Collect updated environment objects (no URL stored - looked up from assets)
        const updatedEnvObjects: any[] = [];
        if (gameData.environmentObjects) {
            for (const obj of gameData.environmentObjects) {
                if (obj.assetId === assetId) {
                    // Remove any redundant fields
                    delete obj.assetUrl;
                    delete obj.assetName;
                    delete obj.assetType;
                    updatedEnvObjects.push(obj);
                }
            }
        }

        // Notify parent to save the updated asset
        const asset = gameData.assets?.find(a => a.id === assetId);
        safePostMessageToCreator({
            type: 'VOXEL_ASSET_SAVED',
            prefabType: typeName,
            asset: asset || {
                id: assetId, name: typeName, url: uploadResult.url, type: 'vxl',
                size: uploadResult.size,
            },
            environmentObjects: updatedEnvObjects
        });
        return true;
    }
}
