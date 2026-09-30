/**
 * AssetSpawner — one-call runtime spawning of library assets (world.json
 * `assets[]` entries) from game code, by asset id or name.
 *
 * This is the code-side counterpart of the declarative `environmentObjects[]`
 * path (EnvironmentObjectSystem): use it when placements are computed at
 * runtime — procedural levels, pickups along generated geometry, drops,
 * respawning collectibles — and therefore can't be authored in world.json.
 *
 * The asset file is fetched once per asset; every spawn clones the loaded
 * data, so spawning N instances costs one network request.
 *
 * There is deliberately no `VoxelObject.loadFromUrl`: asset resolution
 * (id/name → URL → bundle remap), VXL metadata handling (atlas mode, voxel
 * size, rounded edges), physics, scene registration, and collectible wiring
 * all live here so game code never re-implements engine internals.
 */

import * as THREE from 'three';
import type { EngineLike, Asset } from 'types/game.js';
import { VoxelObject, type VoxelObjectOptions } from 'engine/VoxelObject.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import { CollectibleComponent } from 'engine/CollectibleComponent.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { ROUNDED_EDGES_RADIUS_VOXELS } from 'engine/VoxelRoundedMesh.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';
import { cloneSpawnedGlb, disposeGlbTemplate } from 'engine/SpawnedGlbResources.js';

export interface SpawnAssetOptions {
    /** World position of the object origin. */
    position: { x: number; y: number; z: number };
    /** Euler rotation in radians. */
    rotation: { x: number; y: number; z: number };
    /** Uniform scale factor. */
    scale: number;
    /** Object3D name — collection listeners receive it. null → the asset's name. */
    name: string | null;
    /** Create a static collider (VXL assets only; GLB spawns stay decorative). */
    collision: boolean;
    /**
     * Auto-wire pickup behaviour: a Rapier trigger sensor registered with the
     * InteractionManager. On player overlap the object is hidden, its physics
     * body removed, and `onCollect` (if set) invoked. Global listeners added
     * via `getInteractionManager().onCollected(...)` fire too (with the
     * object's name in `meta`). null → not collectible.
     */
    collectible: { radius: number; onCollect: ((spawned: SpawnedAsset) => void) | null } | null;
    /** Parent to attach to. null → the engine world group (recommended). */
    parent: THREE.Object3D | null;
    /** Cast/receive shadows. */
    shadows: boolean;
}

export const DEFAULT_SPAWN_ASSET_OPTIONS: SpawnAssetOptions = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: 1,
    name: null,
    collision: false,
    collectible: null,
    parent: null,
    shadows: true,
};

export interface SpawnedAsset {
    /** The scene object (a VoxelObject for VXL assets, a cloned GLB scene otherwise). */
    object: THREE.Object3D;
    /** Globally unique id (registered with ObjectIdService). */
    objectId: string;
    /** Resolved object name (listeners receive this). */
    name: string;
    /** The auto-wired collectible component, when `collectible` was requested. */
    collectibleComponent: CollectibleComponent | null;
    /**
     * Idempotently remove the object, physics, registrations and owned geometry/materials.
     * Resources assigned by game code remain the caller's responsibility.
     */
    dispose(): void;
}

type LoadedTemplate =
    /** `cloneOptions` describes the loaded template, so every spawn clones it verbatim. */
    | { kind: 'vxl'; template: VoxelObject; cloneOptions: VoxelObjectOptions }
    | { kind: 'glb'; scene: THREE.Object3D };

export class AssetSpawner {
    private engine: EngineLike;
    /** One in-flight/completed load per asset id — spawns share the fetch. */
    private templates = new Map<string, Promise<LoadedTemplate | null>>();
    private loadedTemplates = new Set<LoadedTemplate>();
    private spawns = new Set<SpawnedAsset>();
    private disposed = false;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    /** Find an assets[] entry by id first, then by name. */
    private resolveAsset(assetIdOrName: string): Asset | null {
        const assets = this.engine.getGameData?.()?.assets;
        if (!assets) return null;
        return assets.find((a) => a.id === assetIdOrName)
            ?? assets.find((a) => a.name === assetIdOrName)
            ?? null;
    }

    private isVxlAsset(asset: Asset): boolean {
        return asset.type === 'vxl' || asset.type === 'voxels' || asset.url.toLowerCase().endsWith('.vxl');
    }

    private isSpawnableAsset(asset: Asset): boolean {
        const url = asset.url ?? '';
        if (asset.type === 'gaussian-splat' || asset.type === 'spz' || url.toLowerCase().endsWith('.spz')) return false;
        if (asset.type === 'image' || /\.(webp|png|jpe?g|gif|bmp|svg)$/i.test(url)) return false;
        if (asset.type === 'animation' || asset.type === 'audio' || asset.type === 'json') return false;
        return true;
    }

    private loadTemplate(asset: Asset): Promise<LoadedTemplate | null> {
        const cached = this.templates.get(asset.id);
        if (cached) return cached;
        const promise = this.loadTemplateUncached(asset).then((loaded) => {
            if (!loaded) return null;
            if (this.disposed) {
                this.disposeTemplate(loaded);
                return null;
            }
            this.loadedTemplates.add(loaded);
            return loaded;
        }).catch((err) => {
            // Failed loads are not cached so a later spawn can retry.
            this.templates.delete(asset.id);
            console.warn(`[AssetSpawner] Failed to load asset '${asset.name}' (${asset.id}):`, err);
            return null;
        });
        this.templates.set(asset.id, promise);
        return promise;
    }

    private async loadTemplateUncached(asset: Asset): Promise<LoadedTemplate | null> {
        if (this.isVxlAsset(asset)) {
            const response = await fetch(ASSET_MAP.get(asset.url) ?? asset.url);
            if (!response.ok) {
                throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
            }
            const buffer = await response.arrayBuffer();

            // Opt-in rounded edges: persisted on the asset by the creator's voxelize dialog.
            const rounding = asset.voxelizeSettings?.roundedEdges === true
                ? { voxelRoundingRadiusVoxels: ROUNDED_EDGES_RADIUS_VOXELS }
                : {};
            // Constructed with the definition's values and CORRECTED by the load: the VXL3
            // header carries `useAtlas` and the voxel size, and `loadFromFile` applies both.
            // No metadata peek precedes this — see __tests__/NoWholeBufferJsonPeek.test.ts.
            // Clones therefore come from the LOADED values, which are strictly more accurate:
            // the definition's `voxelSize` can disagree with what the asset was baked at.
            const template = new VoxelObject({
                voxelSize: asset.voxelSize ?? 0.5,
                useAtlas: true,
                shadows: true,
                ...rounding,
            });
            try {
                await template.loadFromFile(buffer);
            } catch (error) {
                template.dispose();
                throw error;
            }
            return {
                kind: 'vxl',
                template,
                cloneOptions: { voxelSize: template.getVoxelSize(), useAtlas: template.useAtlas, ...rounding },
            };
        }

        // Everything else spawnable goes through the GLTF loader.
        if (!this.engine.loader) throw new Error('GLTF loader not available');
        const gltf = await this.engine.loader.loadAsync(ASSET_MAP.get(asset.url) ?? asset.url);
        return { kind: 'glb', scene: gltf.scene as THREE.Object3D };
    }

    async spawn(assetIdOrName: string, options: SpawnAssetOptions): Promise<SpawnedAsset | null> {
        if (this.disposed) return null;
        const asset = this.resolveAsset(assetIdOrName);
        if (!asset) {
            console.warn(`[AssetSpawner] No asset with id or name '${assetIdOrName}' in gameData.assets — generate it first`);
            return null;
        }
        if (!this.isSpawnableAsset(asset)) {
            console.warn(`[AssetSpawner] Asset '${asset.name}' (type '${asset.type}') cannot be spawned as a scene object`);
            return null;
        }

        const loaded = await this.loadTemplate(asset);
        if (!loaded || this.disposed) return null;

        // Instantiate
        let object: THREE.Object3D;
        let voxelObject: VoxelObject | null = null;
        let disposeGlb: (() => void) | null = null;
        if (loaded.kind === 'vxl') {
            voxelObject = new VoxelObject({ ...loaded.cloneOptions, shadows: options.shadows });
            loaded.template.cloneDataTo(voxelObject);
            object = voxelObject;
        } else {
            const cloned = cloneSpawnedGlb(loaded.scene);
            object = cloned.object;
            disposeGlb = cloned.dispose;
            object.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.castShadow = options.shadows;
                    child.receiveShadow = options.shadows;
                }
            });
        }

        const name = options.name ?? asset.name;
        object.name = name;
        object.position.set(options.position.x, options.position.y, options.position.z);
        object.rotation.set(options.rotation.x, options.rotation.y, options.rotation.z);
        object.scale.setScalar(options.scale);
        (options.parent ?? this.engine.getWorldGroup()).add(object);

        // Physics (static collider) — VXL only; GLB spawns stay decorative.
        const physicsWorld = this.engine.physicsWorld;
        if (options.collision) {
            if (voxelObject && physicsWorld) {
                voxelObject.createPhysicsBody(physicsWorld);
            } else if (!voxelObject) {
                console.warn(`[AssetSpawner] collision requested for GLB asset '${name}' — not supported, spawning without collider`);
            }
        }

        // Registrations: unique id + name lookup parity with placed env objects.
        const idService = getObjectIdService();
        const objectId = idService.generateId('object');
        idService.register(objectId, 'object', object, {
            id: objectId,
            assetId: asset.id,
            name,
            position: { ...options.position },
            rotation: { ...options.rotation },
        });
        if (voxelObject) {
            VoxelObjectBuilder.registerExternalObject(objectId, voxelObject);
        }

        let collectibleComponent: CollectibleComponent | null = null;
        let disposed = false;
        const spawned: SpawnedAsset = {
            object,
            objectId,
            name,
            collectibleComponent: null,
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this.spawns.delete(spawned);
                collectibleComponent?.dispose();
                object.parent?.remove(object);
                if (voxelObject) {
                    VoxelObjectBuilder.unregisterExternalObject(objectId);
                    voxelObject.dispose();
                } else {
                    disposeGlb?.();
                }
                idService.unregister(objectId);
            },
        };
        this.spawns.add(spawned);

        if (options.collectible) {
            if (physicsWorld) {
                const onCollect = options.collectible.onCollect;
                collectibleComponent = new CollectibleComponent(physicsWorld, {
                    collectible: {
                        onCollect: () => {
                            object.visible = false;
                            const rigidBody = object.userData.rigidBody;
                            if (rigidBody) {
                                physicsWorld.removeRigidBody(rigidBody);
                                object.userData.rigidBody = null;
                            }
                            onCollect?.(spawned);
                        },
                    },
                    object3D: object,
                    radius: options.collectible.radius,
                    meta: { objectId, name },
                });
                spawned.collectibleComponent = collectibleComponent;
            } else {
                console.warn(`[AssetSpawner] collectible requested for '${name}' but physics world is unavailable`);
            }
        }

        return spawned;
    }

    private disposeTemplate(loaded: LoadedTemplate): void {
        if (loaded.kind === 'vxl') loaded.template.dispose();
        else disposeGlbTemplate(loaded.scene);
    }

    /**
     * End this world's cache lifetime. Dispose live spawns before their shared textures;
     * in-flight loads dispose their templates on arrival and resolve their spawns to null.
     * Arena-only cleanup should dispose its handles, leaving this cache reusable.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const spawned of this.spawns) spawned.dispose();
        for (const loaded of this.loadedTemplates) this.disposeTemplate(loaded);
        this.loadedTemplates.clear();
        this.templates.clear();
    }
}
