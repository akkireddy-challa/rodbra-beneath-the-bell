import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { ROUNDED_EDGES_RADIUS_VOXELS } from 'engine/VoxelRoundedMesh.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { envObjectCollides } from 'engine/template/EnvObjectCollision.js';
import { activeLevelTag } from 'engine/template/EnvObjectRecord.js';
import { getActiveLevelIdOrNull } from 'engine/levels/levelManagerRegistry.js';
import { isInstanceInActiveLevel } from 'engine/levels/levelResolve.js';

interface BoundingBox {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

export interface PlacedObjectData {
    id: string;
    type?: string; // Object type for serialization — asset name used for grouping on reload
    /** Level this instance belongs to; absent = global (every level). */
    levelId?: string;
    assetId: string; // Asset library ID - used to look up URL/name/type from assets array
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale?: { x: number; y: number; z: number };
    boundingBox?: BoundingBox;
    /** Per-instance collision opt-out. Overrides the asset-level `collision` flag.
     * Defaults to true (collider created) when omitted. */
    collision?: boolean;
}

interface ResolvedAsset {
    url: string;
    name: string;
    type: string;
    flattenTerrain?: boolean;
    flattenMargin?: number;
    boundingBox?: BoundingBox;
    collision?: boolean;
    /** Creator voxelize-dialog settings persisted on the asset record. */
    voxelizeSettings?: { roundedEdges?: boolean };
}

interface PlacedObjectEntry {
    data: PlacedObjectData;
    object: THREE.Object3D | null;
    voxelObject: VoxelObject | null;
    placeholder: THREE.Mesh | null;
}

interface LoadedAsset {
    url: string;
    object?: THREE.Object3D;
}

export class PlacedObjectSystem {
    private scene: THREE.Scene;
    private engine: EngineLike;
    private placedObjects: Map<string, PlacedObjectEntry> = new Map();
    private loadedAssets: Map<string, LoadedAsset> = new Map();

    constructor(scene: THREE.Scene, engine: EngineLike) {
        this.scene = scene;
        this.engine = engine;
    }

    /**
     * Calculate position with bounding box offset for consistent object placement.
     * Centers X/Z based on bounding box, and for GLB also applies minY offset.
     */
    private calculatePositionWithBoundingBox(
        objectData: PlacedObjectData,
        includeYOffset: boolean
    ): { x: number; y: number; z: number } {
        let posX = objectData.position.x;
        let posY = objectData.position.y;
        let posZ = objectData.position.z;

        if (objectData.boundingBox) {
            const centerX = (objectData.boundingBox.minX + objectData.boundingBox.maxX) / 2;
            const centerZ = (objectData.boundingBox.minZ + objectData.boundingBox.maxZ) / 2;
            posX += centerX;
            posZ += centerZ;
            if (includeYOffset) {
                posY += objectData.boundingBox.minY;
            }
        }

        return { x: posX, y: posY, z: posZ };
    }

    /**
     * Look up asset from assets array by ID
     */
    private lookupAsset(assetId: string): ResolvedAsset | null {
        if (!assetId) return null;
        const gameData = this.engine.getGameData?.();
        const asset = gameData?.assets?.find((a: any) => a.id === assetId);
        return asset ?? null;
    }

    public async createPlacedObject(
        assetId: string,
        position: THREE.Vector3,
        rotation: THREE.Euler,
        boundingBox?: BoundingBox
    ): Promise<PlacedObjectData> {
        // Use ObjectIdService for globally unique ID
        const idService = getObjectIdService();
        const id = idService.generateId('object');

        // Resolve asset name for the type field — EnvironmentObjectSystem groups by type on reload,
        // so each distinct asset needs its own type to avoid all instances sharing the first asset.
        const asset = this.lookupAsset(assetId);
        const assetTypeName = asset?.name || assetId;

        // Levels mode: the instance belongs to the level open in the editor RIGHT
        // NOW. Without the tag it is global and shows up in every level. The tag
        // must live on `objectData` itself, not just on the record pushed below:
        // `objectData` is the ObjectIdService registration data that
        // `serializeEnvironmentObjects()` re-serializes on every save.
        const objectData: PlacedObjectData = {
            id,
            type: assetTypeName,
            ...activeLevelTag(),
            assetId,
            position: { x: position.x, y: position.y, z: position.z },
            rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
            boundingBox
        };

        // Add to gameData.environmentObjects (unified with procedural objects for consistent undo)
        const gameData = this.engine.getGameData?.();
        if (gameData) {
            if (!gameData.environmentObjects) {
                gameData.environmentObjects = [];
            }
            // Mirror `objectData` wholesale (level tag included) so the two
            // representations of the same instance can't drift apart.
            gameData.environmentObjects.push({
                ...objectData,
                scale: objectData.scale || { x: 1, y: 1, z: 1 }
            });
            console.log('[PlacedObjectSystem] Added asset object to gameData.environmentObjects, now has', gameData.environmentObjects.length, 'objects');
        }

        // Initialize entry
        const entry: PlacedObjectEntry = {
            data: objectData,
            object: null,
            voxelObject: null,
            placeholder: null
        };
        this.placedObjects.set(id, entry);

        if (!asset) {
            console.warn(`[PlacedObjectSystem] Cannot load asset: ID "${assetId}" not found in assets array`);
            return objectData;
        }

        // GLB clones can be instantiated synchronously from the cached source object;
        // VXL and Splat assets always need an async load step (each instance owns its data).
        const cachedGlb = this.loadedAssets.get(asset.url)?.object;
        if (cachedGlb) {
            this.instantiateGLBObject(entry, cachedGlb, asset);
        } else {
            this.createPlaceholder(entry);
            await this.loadAssetAndReplacePlaceholder(entry, asset);
        }

        return objectData;
    }

    private createPlaceholder(entry: PlacedObjectEntry): void {
        const objectData = entry.data;
        const boundingBox = objectData.boundingBox;

        let width = 1, height = 1, depth = 1;
        let offsetX = 0, offsetY = 0.5, offsetZ = 0;

        if (boundingBox) {
            width = boundingBox.maxX - boundingBox.minX;
            height = boundingBox.maxY - boundingBox.minY;
            depth = boundingBox.maxZ - boundingBox.minZ;
            const centerX = (boundingBox.minX + boundingBox.maxX) / 2;
            const centerZ = (boundingBox.minZ + boundingBox.maxZ) / 2;
            offsetX = centerX;
            offsetY = height / 2;
            offsetZ = centerZ;
        }

        const geometry = new THREE.BoxGeometry(width, height, depth);
        const material = new THREE.MeshBasicMaterial({
            color: 0x667eea,
            transparent: true,
            opacity: 0.5
        });
        const placeholder = new THREE.Mesh(geometry, material);
        placeholder.position.set(
            objectData.position.x + offsetX,
            objectData.position.y + offsetY,
            objectData.position.z + offsetZ
        );
        placeholder.rotation.set(objectData.rotation.x, objectData.rotation.y, objectData.rotation.z);
        placeholder.name = `Placeholder_${objectData.id}`;

        this.scene.add(placeholder);
        entry.placeholder = placeholder;
    }

    private removePlaceholder(entry: PlacedObjectEntry): void {
        if (entry.placeholder) {
            this.scene.remove(entry.placeholder);
            entry.placeholder.geometry.dispose();
            if (entry.placeholder.material instanceof THREE.Material) {
                entry.placeholder.material.dispose();
            }
            entry.placeholder = null;
        }
    }

    private isSplatAsset(asset: ResolvedAsset): boolean {
        return asset.type === 'gaussian-splat'
            || asset.type === 'spz'
            || !!asset.url?.toLowerCase().endsWith('.spz');
    }

    private isImageAsset(asset: ResolvedAsset): boolean {
        return asset.type === 'image'
            || /\.(webp|png|jpe?g|gif|bmp|svg)$/i.test(asset.url ?? '');
    }

    private async loadAssetAndReplacePlaceholder(entry: PlacedObjectEntry, asset: ResolvedAsset): Promise<void> {
        const objectData = entry.data;

        // Image assets (e.g. .webp backdrops) are not loadable as 3D objects.
        // Skip them rather than routing raster bytes to the GLTF loader, which
        // throws an opaque JSON parse error on the WebP/PNG magic bytes.
        if (this.isImageAsset(asset)) {
            console.warn(`[PlacedObjectSystem] Asset ${objectData.id} is an image and cannot be placed as a 3D object; use it as a texture/backdrop instead`);
            this.removePlaceholder(entry);
            return;
        }

        try {
            const assetType = asset.type;

            if (assetType === 'vxl' || assetType === 'voxels') {
                await this.loadAndInstantiateVoxel(entry, asset);
            } else if (this.isSplatAsset(asset)) {
                await this.loadAndInstantiateSplat(entry, asset);
            } else {
                await this.loadAndInstantiateGLB(entry, asset);
            }

            // Remove placeholder after successful load
            this.removePlaceholder(entry);

            // Refresh scene hierarchy display
            this.refreshSceneHierarchy();

        } catch (error) {
            console.error(`[PlacedObjectSystem] Failed to load asset for ${objectData.id}:`, error);
            // Turn placeholder red to indicate error
            if (entry.placeholder && entry.placeholder.material instanceof THREE.MeshBasicMaterial) {
                entry.placeholder.material.color.setHex(0xff0000);
            }
        }
    }

    private refreshSceneHierarchy(): void {
        if (this.engine.editorManager && typeof (this.engine.editorManager as { refreshSceneHierarchy?: () => void }).refreshSceneHierarchy === 'function') {
            (this.engine.editorManager as { refreshSceneHierarchy: () => void }).refreshSceneHierarchy();
        }
    }

    private async loadAndInstantiateGLB(entry: PlacedObjectEntry, asset: ResolvedAsset): Promise<void> {
        if (!this.engine.loader) {
            throw new Error('Loader not available');
        }

        // Load the GLB
        const gltf = await this.engine.loader.loadAsync(asset.url);
        const loadedObject = gltf.scene;

        // Store in cache for future use
        this.loadedAssets.set(asset.url, {
            url: asset.url,
            object: loadedObject
        });

        // Instantiate the object
        this.instantiateGLBObject(entry, loadedObject, asset);
    }

    private instantiateGLBObject(entry: PlacedObjectEntry, sourceObject: THREE.Object3D, asset: ResolvedAsset): void {
        const objectData = entry.data;
        const object = sourceObject.clone();

        const pos = this.calculatePositionWithBoundingBox(objectData, true);
        object.position.set(pos.x, pos.y, pos.z);
        object.rotation.set(objectData.rotation.x, objectData.rotation.y, objectData.rotation.z);

        if (objectData.scale) {
            object.scale.set(objectData.scale.x || 1, objectData.scale.y || 1, objectData.scale.z || 1);
        }

        object.name = asset.name || `PlacedObject_${objectData.id}`;

        // Enable shadows
        object.traverse((child: THREE.Object3D) => {
            if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        this.scene.add(object);
        entry.object = object;

        // Register with ObjectIdService
        getObjectIdService().register(objectData.id, 'object', object, objectData);
    }

    /**
     * Create and configure a VoxelObject from a VXL file buffer.
     * Handles positioning, rotation, scale, physics, and scene registration.
     */
    private async createVoxelObjectFromBuffer(
        entry: PlacedObjectEntry,
        asset: ResolvedAsset,
        arrayBuffer: ArrayBuffer
    ): Promise<void> {
        const objectData = entry.data;

        const voxelObject = new VoxelObject(
            asset.voxelizeSettings?.roundedEdges === true
                ? { voxelRoundingRadiusVoxels: ROUNDED_EDGES_RADIUS_VOXELS }
                : {},
        );
        voxelObject.name = asset.name || `VoxelObject_${objectData.id}`;
        await voxelObject.loadFromFile(arrayBuffer);

        const pos = this.calculatePositionWithBoundingBox(objectData, false);
        voxelObject.position.set(pos.x, pos.y, pos.z);
        voxelObject.rotation.set(objectData.rotation.x, objectData.rotation.y, objectData.rotation.z);

        if (objectData.scale) {
            voxelObject.scale.set(objectData.scale.x || 1, objectData.scale.y || 1, objectData.scale.z || 1);
        }

        // Decorative props (collision: false) skip the collider; the instance
        // flag overrides the asset-level default. See EnvObjectCollision.
        const physicsWorld = this.engine.physicsWorld;
        if (physicsWorld && envObjectCollides(objectData, asset)) {
            voxelObject.createPhysicsBody(physicsWorld);
        }

        this.scene.add(voxelObject);
        entry.voxelObject = voxelObject;
        entry.object = voxelObject;

        getObjectIdService().register(objectData.id, 'object', voxelObject, objectData);
    }

    private async loadAndInstantiateVoxel(entry: PlacedObjectEntry, asset: ResolvedAsset): Promise<void> {
        // Each VoxelObject instance needs its own data, so always re-fetch.
        const response = await fetch(asset.url);
        if (!response.ok) {
            throw new Error(`Failed to fetch VXL file: ${response.statusText}`);
        }
        await this.createVoxelObjectFromBuffer(entry, asset, await response.arrayBuffer());
    }

    private async loadAndInstantiateSplat(_entry: PlacedObjectEntry, asset: ResolvedAsset): Promise<void> {
        // Placing individual Gaussian splats here was backed by the WebGL/Spark
        // SplatMesh, which has been removed. Splats now render only via the
        // WebGPU path (EnvironmentObjectSystem → GaussianSplatRenderer), not as
        // ad-hoc placed objects.
        console.warn(`[PlacedObjectSystem] Placing Gaussian splats is no longer supported (WebGL/Spark removed): ${asset.url}`);
    }

    public getPlacedObject(id: string): THREE.Object3D | null {
        return this.placedObjects.get(id)?.object || null;
    }

    public removePlacedObject(id: string): void {
        const entry = this.placedObjects.get(id);
        if (entry) {
            // Dispose VoxelObject properly (includes physics cleanup)
            if (entry.voxelObject) {
                this.scene.remove(entry.voxelObject);
                entry.voxelObject.dispose();
            } else if (entry.object) {
                this.scene.remove(entry.object);
                entry.object.traverse((child: THREE.Object3D) => {
                    if (child instanceof THREE.Mesh) {
                        child.geometry.dispose();
                        if (child.material instanceof THREE.Material) {
                            child.material.dispose();
                        }
                    }
                });
            }
            this.removePlaceholder(entry);
            this.placedObjects.delete(id);

            // Unregister from ObjectIdService
            getObjectIdService().unregister(id);
        }
    }

    public async loadPlacedObjects(placedObjectsData: PlacedObjectData[]): Promise<void> {
        // Levels mode: only the active level's instances load (untagged = global).
        placedObjectsData = placedObjectsData.filter((o) =>
            isInstanceInActiveLevel(o, getActiveLevelIdOrNull()));
        for (const objectData of placedObjectsData) {
            await this.createPlacedObject(
                objectData.assetId,
                new THREE.Vector3(objectData.position.x, objectData.position.y, objectData.position.z),
                new THREE.Euler(objectData.rotation.x, objectData.rotation.y, objectData.rotation.z),
                objectData.boundingBox
            );
        }
    }

    public serializePlacedObjects(): PlacedObjectData[] {
        return Array.from(this.placedObjects.values()).map(entry => entry.data);
    }
}



