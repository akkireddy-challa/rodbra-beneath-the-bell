import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import { SeededRandom } from 'engine/SeededRandom.js';
import { TerrainTypeRegistry, FoliageType } from 'engine/TerrainTypes.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { getActiveLevelIdOrNull } from 'engine/levels/levelManagerRegistry.js';
import { isInstanceInActiveLevel } from 'engine/levels/levelResolve.js';
import { disposeSpawnedEnvObjectContent } from 'engine/levels/envObjectTeardown.js';
import { prefetchVxlAssets, prefetchAheadFor } from 'engine/AssetBufferPrefetch.js';
import { getZFightingRegistry } from 'engine/ZFightingRegistry.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';
import type { WorldProfileData, GameData, EnvironmentMeshUserData, RockGeometryUserData, Asset } from 'types/game.js';
import { GLB_INSTANCING_MIN_COPIES, GlbInstanceBatch, isInstanceableGlb } from 'engine/GlbInstancing.js';
import { GlbSmartObjectHost, canonicalAnchorNames, deriveGlbSmartObject } from 'engine/GlbSmartObject.js';
import { createGlbBoxColliders, createDynamicGlbBody, createGlbPlaneLockedColliders, createGlbTrimeshCollider, type GlbDynamicEngineRef } from 'engine/EnvGlbPhysics.js';
import { loadGaussianSplatObjects } from 'engine/EnvSplatObjects.js';
import { reportWorldSubProgress } from 'engine/progress/LoadProgress.js';
import type { WarmupProgressFn } from 'engine/GameEngineWarmup.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { CHUNK_SIZE, footprintGroundHeight, type BaseFootprint } from 'engine/VoxelGeometry.js';
import { CollectibleComponent } from 'engine/CollectibleComponent.js';
import { enableStructuralCollapse } from 'engine/VoxelStructuralCollapse.js';
import { spawnPristineDestructibleProxy, resolveDestructionMode, type PristineDestructibleInstance } from 'engine/PristineDestructible.js';
import { spawnPristineDynamicProxy, type PristineDynamicVoxelObject, type PristineDynamicInstance } from 'engine/PristineDynamic.js';
import { getFragmentVisualSources } from 'engine/VoxelObjectPristineOps.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { FragmentInstancePool } from 'engine/FragmentInstancePool.js';
import { registerObstacleProvider } from 'engine/VoxelNavMesh.js';
import { groundContactBounds } from 'engine/nav/PropFootprint.js';
import { envObjectCollides } from 'engine/template/EnvObjectCollision.js';
import { createFadedEnvMaterial, setEnvFadeBand, computeEnvFadeBand } from 'engine/EnvDistanceFade.js';
import { BUILDING_LOD_DISTANCES_M, PROP_LOD_DISTANCES_M, isBuildingSized, MAX_DROPPED_ENV_LODS, INSTANCE_CULL_SPHERE_MARGIN } from 'engine/EnvLodPolicy.js';
import { ROUNDED_EDGES_RADIUS_VOXELS } from 'engine/VoxelRoundedMesh.js';
import { mapWithConcurrency } from 'engine/AsyncConcurrency.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';
import { isStandaloneMode } from 'engine/CreatorMode.js';
import { releaseMeshCpuBuffersAfterUpload } from 'engine/GeometryCpuRelease.js';
import { packInstancedMeshes as packInstancedMeshesOp, unpackInstancedMeshes as unpackInstancedMeshesOp } from 'engine/EnvObjectPackOps.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';


// Re-export for convenience
export type { TerrainTypeProvider, TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';

// Module-level engine reference used for Gaussian Splat loading and dynamic-
// object physics. Set once by GameEngine during initialization.
let _moduleEngineRef: any = null;

/** @internal Set the module-level engine reference. Called by GameEngine. */
export function setEnvironmentObjectSystemEngine(engine: any): void {
    _moduleEngineRef = engine;
}

// Module-level reference to the most-recently-constructed
// EnvironmentObjectSystem. GameEngine reads this once per frame to drive
// the per-instance LOD culling pass; declaring it here (rather than as a
// field on GameEngine) avoids a circular import.
let _activeEnvObjSystem: EnvironmentObjectSystem | null = null;

/**
 * @internal Active-instance accessor for the GameEngine render loop. Returns
 * the most-recently-constructed EnvironmentObjectSystem (or null before any
 * has been built). Worlds with multiple concurrent EnvObjSystems are not a
 * scenario we support — the last one wins.
 */
export function getActiveEnvironmentObjectSystem(): EnvironmentObjectSystem | null {
    return _activeEnvObjSystem;
}

/** Internal fields added during registration that should not be persisted to world.json */
const INTERNAL_FIELDS = new Set(['instanceIndex', 'cubes', 'mergedGeometry', 'mesh', 'data']);

/**
 * Terrain type → its foliage-free twin, stamped under a procedurally placed
 * environment object so foliage doesn't grow through it. Terrain types absent
 * from this map have no twin and keep their own id.
 */
const NO_FOLIAGE_TERRAIN_TYPE = new Map<number, number>([[1, 8], [2, 10], [6, 9]]);

/**
 * Return the value stored at `key`, creating and inserting one via `make()`
 * when absent. Centralizes the "get-or-create map entry" idiom used by the
 * chunk/spatial bookkeeping maps throughout this system.
 */
function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
    let value = map.get(key);
    if (value === undefined) {
        value = make();
        map.set(key, value);
    }
    return value;
}

/**
 * Normalize Euler angles read from Three.js scene objects.
 * Three.js Euler decomposition can produce artifacts near gimbal lock, e.g.
 * (0, π, 0) may be represented as (-π, ~0, -π) in XYZ order.
 * This normalizes to the canonical (simplest) representation.
 */
function normalizeRotation(r: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
	const EPS = 1e-6;
	const PI = Math.PI;
	// Handle gimbal lock artifact: (±π, y, ±π) in XYZ order is equivalent to (0, π−y, 0)
	if (Math.abs(Math.abs(r.x) - PI) < 0.01 && Math.abs(Math.abs(r.z) - PI) < 0.01) {
		return { x: 0, y: PI - r.y, z: 0 };
	}
	// Round near-zero values to exactly 0
	return {
		x: Math.abs(r.x) < EPS ? 0 : r.x,
		y: Math.abs(r.y) < EPS ? 0 : r.y,
		z: Math.abs(r.z) < EPS ? 0 : r.z,
	};
}

/**
 * Serialize a registered environment object for persistence (world.json).
 * Preserves all original metadata fields (name, interactable, collectible, etc.)
 * from registration data while updating transforms from the current scene state.
 */
export function serializeEnvironmentObject(
	registrationData: Record<string, unknown>,
	id: string,
	position: { x: number; y: number; z: number },
	rotation: { x: number; y: number; z: number },
	scale: { x: number; y: number; z: number }
): Record<string, unknown> {
	const obj: Record<string, unknown> = {};
	if (registrationData) {
		for (const [key, value] of Object.entries(registrationData)) {
			if (!INTERNAL_FIELDS.has(key)) {
				obj[key] = value;
			}
		}
	}
	obj.id = id;
	obj.position = position;
	obj.rotation = normalizeRotation(rotation);
	obj.scale = scale;
	return obj;
}

/**
 * Interface for foliage systems that can clear foliage at specific positions.
 * Both FoliageSystem and VoxelFoliageSystem implement this interface.
 */
export interface FoliageClearable {
    clearFoliageAt(x: number, z: number, radius: number): void;
}

// Cube data for environment object explode functionality
interface EnvironmentCube {
    position: THREE.Vector3;
    materialType: 'trunk' | 'leaves' | 'rock';
    size: number;
}

// Environment object data structure
/**
 * Interactive environment objects (trees, rocks, etc.) follow the InstancedMesh pattern.
 * 
 * These objects have physics colliders and can be interacted with by players.
 * 
 * Note: Decorative small objects like flowers and mushrooms are part of the foliage system
 * (no interaction, no colliders), not environment objects.
 * 
 * ============================================================================
 * AI AGENTS: ADDING NEW ENVIRONMENT OBJECT TYPES
 * ============================================================================
 * 
 * To add a new environment object type (e.g., bushes, logs, crystals, mushrooms):
 * 
 * 1. Create a factory function that returns EnvironmentObjectData:
 * 
 * 2. Register the type using registerEnvironmentObjectType():
 * 
 * 3. The system automatically handles:
 *    - Procedural spawning (if proceduralCount > 0)
 *    - Serialization to world.json
 *    - Deserialization from world.json
 *    - Scene editor unpack/pack
 * 
 * That's it! No need to modify generateScenery(), serializeEnvironmentObjects(), or unpack/pack methods.
 * 
 * See registerTreeType() and registerRockType() for complete examples.
 */
export interface EnvironmentObjectData {
    cubes: EnvironmentCube[];
    mergedGeometry: THREE.BufferGeometry;
    mesh: THREE.Mesh | THREE.Object3D;
    instanceId?: number; // For InstancedMesh tracking
    scale?: { width: number; height: number; depth: number }; // Scale info for serialization
    voxelObject?: THREE.Object3D; // For VoxelObject-based environment objects
}

// Instance data for placement
export interface EnvironmentInstance {
    data: EnvironmentObjectData;
    x: number;
    z: number;
    y: number;
    /** Y-only Euler. Kept for procedural cube-based types (trees, rocks). */
    rotation?: number;
    /** Full XYZ Euler. Populated for VXL-asset placements where the user can rotate on any axis. */
    rotationXYZ?: { x: number; y: number; z: number };
    scale?: { width: number; height: number; depth: number };
    objDef?: any; // Reference to original object definition from world.json
}

/**
 * Registry entry for an environment object type.
 * 
 * AI AGENTS: To add a new environment object type (e.g., bushes, logs, crystals), create an object
 * implementing this interface and call environmentObjectSystem.registerEnvironmentObjectType().
 */
export interface EnvironmentObjectType {
    /** Unique type name (e.g., 'tree', 'rock', 'bush'). Used as key in world.json environmentObjects array */
    typeName: string;
    /** Factory function that creates a new instance of the object's geometry/data */
    factory: () => EnvironmentObjectData;
    /** Check if this object type can be placed at the given coordinates based on terrain type */
    canPlace: (x: number, z: number, terrainHeightProvider: TerrainHeightProvider, terrainRegistry: TerrainTypeRegistry) => boolean;
    /** Number of instances to spawn procedurally when generating scenery (0 = don't spawn procedurally) */
    proceduralCount: number;
    /** Create or update InstancedMesh for this object type. Can use createStandardInstancedMesh() helper for simple cases. */
    createInstancedMesh: (
        instances: EnvironmentInstance[],
        instancedMesh: THREE.InstancedMesh | null,
        instanceData: EnvironmentObjectData[],
        world: THREE.Object3D,
        worldBodies: any[],
        material: THREE.MeshStandardMaterial,
        physicsWorld: PhysicsWorld | null
    ) => { instancedMesh: THREE.InstancedMesh; instanceData: EnvironmentObjectData[] };
    /** Create physics body for collision detection */
    createPhysics: (instance: EnvironmentInstance, worldBodies: any[], physicsWorld: PhysicsWorld | null) => void;
    /** Calculate Y position for placement (usually ground height + offset) */
    getPlacementY: (instance: EnvironmentInstance, terrainHeightProvider: TerrainHeightProvider, groundOffset: number) => number;
    /** Radius to clear foliage around object (for simple circular clearing) */
    getClearRadius: (instance: EnvironmentInstance) => number;
    /** Width and depth for terrain type clearing (rectangular area) */
    getClearSize: (instance: EnvironmentInstance) => { width: number; depth: number };
}

/**
 * Default for the per-type frustum-culling opt-out. Off by default — every
 * type is frustum-culled as before. Set a `world.json` env-object's
 * `alwaysVisible: true` to flip it on for structural objects (walls/floors/
 * ceilings) so they never pop out of view at grazing camera angles.
 */
export const DEFAULT_DISABLE_FRUSTUM_CULLING = false;

export class EnvironmentObjectSystem {
    private world: THREE.Object3D;
    private worldBodies: any[];
    private rng: SeededRandom;
    private worldSize: number;
    private terrainHeightProvider: TerrainHeightProvider;
    private terrainRegistry: TerrainTypeRegistry;
    private foliageSystem: FoliageClearable | null;
    private groundOffset: number;
    private worldProfileData: WorldProfileData;
    private gameData: GameData | null;
    private physicsWorld: PhysicsWorld | null;
    private onBeforePhysicsStep: (() => void) | null = null;

    // Environment objects instancing system
    private environmentTexture: THREE.Texture | null = null;
    private environmentMaterial: THREE.MeshStandardMaterial | null = null;
    
    // Registry-based storage: Map<typeName, {instances, instancedMesh, unpackedMeshes}>
    private objectRegistry: Map<string, EnvironmentObjectType> = new Map();
    private objectStorage: Map<string, {
        instances: EnvironmentObjectData[];
        instancedMesh: THREE.InstancedMesh | null;
        unpackedMeshes: THREE.Mesh[];
    }> = new Map();

    /**
     * Per-LOD InstancedMesh + per-instance bookkeeping for the dynamic
     * culling path. Only populated for VXL-asset-backed types where the
     * loader actually built per-LOD meshes; non-VXL types and lookup
     * misses just skip the cull pass and keep their `objectStorage`
     * entry. Indexed by typeName.
     *
     * `meshes[k]` holds the InstancedMesh for LOD k (length = 1 + additional LODs).
     *   These are the *color-pass* meshes — visible to the main camera and
     *   also cast their own shadows.
     * `shadowMesh` is an optional separate InstancedMesh that only the shadow
     *   camera renders. Used for instances behind/beside the player whose
     *   shadows project into the visible scene — we don't want their vertex
     *   shader running for the color pass, so they live on a layer the main
     *   camera doesn't render. Uses the coarsest LOD's geometry.
     * `matrices[i]` is the per-instance world transform, pre-baked at load.
     * `spheres[i]` is the world-space bounding sphere used for the frustum cull
     *   (bounds the per-axis-scaled asset AABB: radius = half-diagonal of the
     *   scaled box × margin, centered at the scaled/rotated bbox center).
     * `lodDistances[k]` is the *start* distance for LOD k, in meters
     *   (`lodDistances[0]` is always 0). Instances are dropped beyond
     *   max(`maxRenderDistance`, `cullDistance`) — i.e. the configured render
     *   distance (default: the fog distance), but never inside the last LOD band.
     */
    /**
     * Instances promoted out of the batch so they can hold bullet holes, keyed
     * `typeName:index`. Capped: each one costs a per-instance geometry clone.
     */
    private carvePromotions = new Map<string, VoxelObject>();
    /** Batched bodies, so promotion can retire the one it replaces. */
    private carveBodies = new Map<string, RAPIER.RigidBody>();
    private static readonly MAX_CARVE_PROMOTIONS = 48;

    private lodStorage: Map<string, {
        /** Asset id this entry was built from (for live LOD-config updates). */
        assetId: string | null;
        /**
         * Number of FINEST asset LOD levels that were never built (mobile: 1 when
         * the asset ships multiple LODs — see MAX_DROPPED_ENV_LODS). `meshes[0]` then
         * holds asset LOD `startLod`, and `updateLodConfigForAsset` must re-derive
         * distances for `meshes.length + startLod` levels to keep the user's
         * per-LOD distance overrides aligned with their original indices.
         */
        startLod: number;
        meshes: THREE.InstancedMesh[];
        shadowMesh: THREE.InstancedMesh | null;
        matrices: THREE.Matrix4[];
        spheres: THREE.Sphere[];
        lodDistances: number[];
        cullDistance: number;
        /** Building-sized (wide 100/200/300 LOD schedule) vs small prop — stored so
         *  the live re-voxelize path re-derives with the same schedule. */
        isBuilding: boolean;
        /**
         * When true, every instance of this type within `cullDistance` is
         * forced visible in LOD 0 and the per-instance frustum test is skipped.
         * Lets structural objects (walls/floors/ceilings) opt out of culling so
         * they never pop out at grazing angles. See DEFAULT_DISABLE_FRUSTUM_CULLING.
         */
        disableFrustumCulling: boolean;
    }> = new Map();

    /**
     * Layer index used for per-type shadow-only meshes. The main camera
     * renders layer 0; the directional light's shadow camera also has
     * layer 1 enabled (set up in `GameEngine.applyShadowConfiguration`).
     * Putting shadow-only meshes on this layer means the color pass skips
     * them entirely while their shadows still project into visible geometry.
     */
    static readonly SHADOW_ONLY_LAYER = 1;

    // Pre-allocated frustum + scratch for updateInstanceCulling.
    private instanceFrustum = new THREE.Frustum();
    private instanceFrustumMatrix = new THREE.Matrix4();
    private shadowFrustum = new THREE.Frustum();
    private shadowFrustumMatrix = new THREE.Matrix4();
    private instanceSphereScratch = new THREE.Sphere();
    /** World-space box outside which no placed object is drawn (`setRenderRegion`); null draws all. */
    private renderRegion: THREE.Box3 | null = null;

    // Per-LOD start distances (meters) now live in `engine/EnvLodPolicy.ts`, split by
    // size: BUILDING_LOD_DISTANCES_M (100/200/300, wide — matches forged terrain) vs
    // PROP_LOD_DISTANCES_M (70/120/180/240, tighter). An asset's own baked
    // `additionalLods[k].distance` still overrides either.
    /** True when at least one type has lodStorage and the cull pass should run. */
    private instanceCullingActive: boolean = false;
    
    /**
     * Names of environment-object types currently unpacked into individually
     * editable meshes for the Scene editor (lazy per-type "unlock"). The editor
     * no longer unpacks everything on entry — types stay packed (locked) until
     * the user explicitly unlocks one, so opening the editor is instant even on
     * city-scale scenes.
     */
    private unpackedTypes: Set<string> = new Set();

    // Environment objects modification tracking
    private hasModifications: boolean = false;
    
    // Chunk-based InstancedMeshes for efficient visibility culling
    // Maps chunkKey (2D: "cx,cz") to map of typeName -> InstancedMesh
    private chunkMeshes: Map<string, Map<string, THREE.InstancedMesh>> = new Map();
    private voxelSize: number = 1.0;
    
    // Reference to VoxelTerrainSystem for terrain flattening
    private voxelTerrainSystem: any = null;

    // Chunk parent provider for automatic visibility inheritance
    private getChunkParent: ((chunkKey: string) => THREE.Object3D | null) | null = null;
    
    // Chunk-based physics tracking for hibernation
    // Maps chunkKey to the chunk's rigid bodies (for enabling/disabling with
    // terrain). Typed as real Rapier bodies so every access here goes through
    // isValid() — a body removed since it was tracked (a destroyed prop, a
    // rebuilt VoxelObject) would otherwise reach Rapier through a stale handle
    // and trap the WASM module.
    private chunkPhysicsBodies: Map<string, RAPIER.RigidBody[]> = new Map();
    
    // Spatial hash for O(1) position occupied checks
    // Cell size should be larger than max object radius for correct lookups
    private static readonly SPATIAL_CELL_SIZE = 4; // 4 meters per cell
    private spatialHash: Map<string, { x: number; z: number; radius: number }[]> = new Map();
    /** Flat registry behind spatialHash — entries appear once here but in every overlapped cell of the hash. */
    private placedPositions: Array<{ x: number; z: number; radius: number }> = [];

    // Dynamic environment objects that need physics→visual sync each frame.
    // A pristine dynamic prop is NOT in here while it sleeps — it joins only
    // when it is promoted, so this list tracks what is actually moving rather
    // than everything that could ever move.
    private dynamicObjects: { syncWithPhysics(): void; dispose?: () => void }[] = [];
    private physicsPostStepBound: (() => void) | null = null;
    /**
     * Un-promoted pristine dynamic props, keyed by rigid-body handle, so the
     * post-step wake sweep can resolve an awake body back to its proxy in O(1).
     * Entries are removed on promotion, so the map drains toward empty as a
     * level settles.
     */
    private pristineDynamicByHandle: Map<number, PristineDynamicVoxelObject> = new Map();
    private pristineDynamicWakeBound: (() => void) | null = null;
    /**
     * Env objects given their OWN scene node instead of an InstancedMesh slot
     * (interactable / collectible / dynamic VXL clones and every GLB instance).
     * They live in no per-type storage, so this is the only registry a level
     * switch can walk to take them down.
     */
    private individualObjects: Array<THREE.Object3D & { dispose?: () => void }> = [];
    /**
     * Per-type shared InstancedMesh pools for the fragments of BROKEN
     * destructible instances (lane geometry referenced from the template,
     * never cloned). Created lazily on a type's first break; pristine levels
     * never allocate one. See FragmentInstancePool / PristineDestructible.
     */
    private fragmentPools = new Map<string, FragmentInstancePool>();
    /**
     * True on the 2D-physics lane (`physicsWorld` is the plane-locked facade).
     * Placed objects then get sliced 2D colliders through VoxelObject's own
     * branches; the 3D-only extras — pristine destructible/dynamic proxies,
     * structural collapse, GLB colliders, procedural scenery physics — are
     * skipped here rather than reached, because their code builds 3D Rapier
     * descriptors a 2D-only bundle cannot construct.
     */
    private readonly planeLocked: boolean;
    
    constructor(
        world: THREE.Object3D,
        worldBodies: any[],
        rng: SeededRandom,
        worldSize: number,
        terrainHeightProvider: TerrainHeightProvider,
        terrainRegistry: TerrainTypeRegistry,
        foliageSystem: FoliageClearable | null,
        groundOffset: number,
        worldProfileData: WorldProfileData,
        gameData: GameData | null = null,
        physicsWorld: PhysicsWorld | null = null
    ) {
        this.world = world;
        this.worldBodies = worldBodies;
        this.rng = rng;
        this.worldSize = worldSize;
        this.terrainHeightProvider = terrainHeightProvider;
        this.terrainRegistry = terrainRegistry;
        this.foliageSystem = foliageSystem;
        this.groundOffset = groundOffset;
        this.worldProfileData = worldProfileData;
        this.gameData = gameData;
        this.physicsWorld = physicsWorld;
        this.planeLocked = isPlaneLockedPhysics(physicsWorld);

        // Register as the active EnvObjSystem so GameEngine's per-frame
        // render loop can drive updateInstanceCulling without a direct
        // back-reference (which would create a circular import).
        _activeEnvObjSystem = this;

        // Seed the env-object dissolve band from the default render distance so the
        // fade is active even if a genre never calls setMaxRenderDistance (WorldGenerator
        // normally does, from the fog far — which refreshes the shared band).
        setEnvFadeBand(computeEnvFadeBand(this.maxRenderDistance));

        // NOTE: Environment texture/material is NOT initialized here.
        // Template code must call initializeEnvironmentTexture() with desired colors
        // before registering environment object types.
        // This allows templates to customize colors (e.g., pink leaves, blue rocks).
    }
    
    /**
     * Register an environment object type (PRIVATE - use registerEnvironmentObjectType for external registration)
     */
    private registerObjectType(type: EnvironmentObjectType): void {
        this.objectRegistry.set(type.typeName, type);
        this.objectStorage.set(type.typeName, {
            instances: [],
            instancedMesh: null,
            unpackedMeshes: []
        });
    }
    
    /**
     * PUBLIC API: Register a new environment object type.
     * 
     * AI AGENTS: Use this method to add new environment object types (bushes, logs, crystals, etc.).
     * The system will automatically handle:
     * - Procedural spawning (if proceduralCount > 0)
     * - Serialization to world.json
     * - Deserialization from world.json
     * - Scene editor unpack/pack
     * 
     * @param type - The environment object type definition
     * @throws Error if type name already exists
     */
    public registerEnvironmentObjectType(type: EnvironmentObjectType): void {
        if (this.objectRegistry.has(type.typeName)) {
            throw new Error(`Environment object type '${type.typeName}' is already registered`);
        }
        this.registerObjectType(type);
        console.log(`✅ Registered environment object type: ${type.typeName}`);
    }
    
    /**
     * Get storage for a specific object type
     */
    private getStorage(typeName: string): {
        instances: EnvironmentObjectData[];
        instancedMesh: THREE.InstancedMesh | null;
        unpackedMeshes: THREE.Mesh[];
    } {
        const storage = this.objectStorage.get(typeName);
        if (!storage) {
            throw new Error(`Object type '${typeName}' not registered`);
        }
        return storage;
    }
    
    /**
     * Get registry entry for a specific object type
     */
    private getType(typeName: string): EnvironmentObjectType {
        const type = this.objectRegistry.get(typeName);
        if (!type) {
            throw new Error(`Object type '${typeName}' not registered`);
        }
        return type;
    }

    /**
     * Set the chunk parent provider for automatic visibility inheritance.
     * When set, environment object meshes are parented to terrain chunks
     * instead of the world, so they inherit visibility automatically.
     */
    public setChunkParentProvider(provider: (chunkKey: string) => THREE.Object3D | null): void {
        this.getChunkParent = provider;
    }
    
    /**
     * Get the environment material used for trees/rocks.
     * Template code can use this when creating custom environment objects.
     */
    public getEnvironmentMaterial(): THREE.MeshStandardMaterial | null {
        return this.environmentMaterial;
    }

    /**
     * Get the seeded random number generator.
     * Template code can use this for consistent procedural generation.
     */
    public getRng(): SeededRandom {
        return this.rng;
    }

    /**
     * Register a callback that runs after scenery is generated but before the
     * physics step that activates colliders. Use this to create additional
     * physics bodies (e.g., pending voxel object colliders) that should be
     * included in the same physics step.
     */
    public setOnBeforePhysicsStep(callback: () => void): void {
        this.onBeforePhysicsStep = callback;
    }

    /**
     * Get the terrain height provider for terrain queries.
     */
    public getTerrainHeightProvider(): TerrainHeightProvider {
        return this.terrainHeightProvider;
    }

    /**
     * Get the terrain registry for terrain type queries.
     */
    public getTerrainRegistry(): TerrainTypeRegistry {
        return this.terrainRegistry;
    }

    /**
     * Check if a position is occupied by any placed environment object.
     * Uses spatial hashing for O(1) average lookup time.
     *
     * @param x World X coordinate
     * @param z World Z coordinate
     * @param checkRadius Optional radius to check (default: 1m). Position is occupied if
     *                    any placed object's clear radius overlaps with this check radius.
     * @param maxObjectRadius When set, placed objects with a clear radius LARGER than this
     *                        are skipped. Enclosure-scale structures (a colosseum, stadium,
     *                        or walled fort placed as one asset) register their whole
     *                        bounding-box footprint, which covers their own playable
     *                        interior — callers that validate per-column instead (e.g. NPC
     *                        spawn checks comparing surface vs terrain height) use this to
     *                        ignore them. Default null = consider every placed object.
     * @returns true if the position overlaps with any placed object
     */
    public isPositionOccupied(x: number, z: number, checkRadius: number = 1.0, maxObjectRadius: number | null = null): boolean {
        // Check the cell containing the position and all neighboring cells.
        // Entries are registered into every cell their disc overlaps, so the
        // 3×3 scan only needs to cover checkRadius (≤ one 4m cell) of slack.
        const cellX = Math.floor(x / EnvironmentObjectSystem.SPATIAL_CELL_SIZE);
        const cellZ = Math.floor(z / EnvironmentObjectSystem.SPATIAL_CELL_SIZE);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const cell = this.spatialHash.get(`${cellX + dx},${cellZ + dz}`);
                if (!cell) continue;

                for (const placed of cell) {
                    if (maxObjectRadius !== null && placed.radius > maxObjectRadius) continue;
                    const distX = x - placed.x;
                    const distZ = z - placed.z;
                    const minDist = placed.radius + checkRadius;
                    if (distX * distX + distZ * distZ < minDist * minDist) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
    
    /**
     * Register a placed position for occupancy queries.
     * Called internally when scenery is generated, but can also be used by
     * templates to register custom placed objects.
     * Uses spatial hashing for efficient lookup.
     *
     * The entry is inserted into EVERY cell its disc overlaps, not just the
     * center cell — isPositionOccupied only scans the query's 3×3 neighborhood,
     * so a center-cell-only entry with a radius beyond ~2 cells (8m) would be
     * invisible to queries over most of its own footprint.
     */
    public registerPlacedPosition(x: number, z: number, radius: number): void {
        const entry = { x, z, radius };
        this.placedPositions.push(entry);
        const cellSize = EnvironmentObjectSystem.SPATIAL_CELL_SIZE;
        const minCellX = Math.floor((x - radius) / cellSize);
        const maxCellX = Math.floor((x + radius) / cellSize);
        const minCellZ = Math.floor((z - radius) / cellSize);
        const maxCellZ = Math.floor((z + radius) / cellSize);
        for (let cx = minCellX; cx <= maxCellX; cx++) {
            for (let cz = minCellZ; cz <= maxCellZ; cz++) {
                getOrCreate(this.spatialHash, `${cx},${cz}`, () => []).push(entry);
            }
        }
    }

    /**
     * Get all placed object positions with their radii.
     * Used to mark environment objects as obstacles on the VoxelNavMesh
     * so NPCs path around them instead of walking through them.
     */
    public getAllPlacedPositions(): Array<{ x: number; z: number; radius: number }> {
        return this.placedPositions.slice();
    }

    /**
     * Get the ground offset value.
     */
    public getGroundOffset(): number {
        return this.groundOffset;
    }

    /**
     * Get the number of instances for a specific object type.
     * Used by the voxel editor to display prefab instance counts.
     * @param typeName The type name (e.g., 'tree', 'voxelTree', 'rock', 'voxelRock')
     * @returns Number of instances of this type
     */
    public getInstanceCount(typeName: string): number {
        return this.objectStorage.get(typeName)?.instances.length ?? 0;
    }

    /**
     * Get all VoxelObjects for a specific object type.
     * Used by VoxelEditor to update prefab instances without scene traversal.
     * @param typeName The type name (e.g., 'voxelTree', 'voxelRock')
     * @returns Array of VoxelObjects (references to the actual objects in the scene)
     */
    public getVoxelObjects(typeName: string): THREE.Object3D[] {
        const storage = this.objectStorage.get(typeName);
        if (!storage) return [];
        return storage.instances
            .map(inst => inst.voxelObject)
            .filter((vo): vo is THREE.Object3D => vo !== undefined);
    }

    /**
     * Collect all rendered voxel meshes (chunk InstancedMeshes + VoxelObjects)
     * for the given object type names. Used by the Gaussian Splat export to hide
     * voxelised environment objects while their original textured GLBs are
     * rendered in their place. Returns scene objects; caller toggles visibility.
     */
    public collectExportMeshesForTypes(typeNames: Set<string>): THREE.Object3D[] {
        const out: THREE.Object3D[] = [];
        // Packed mode: per-chunk InstancedMeshes (keyed by typeName).
        for (const chunkTypeMap of this.chunkMeshes.values()) {
            for (const [typeName, mesh] of chunkTypeMap) {
                if (typeNames.has(typeName)) out.push(mesh);
            }
        }
        // All other render modes live in objectStorage. The creator/editor —
        // where the splat export runs — uses UNPACKED mode, storing individual
        // meshes in `unpackedMeshes`; those were being missed, so the voxels
        // rendered underneath the GLB overlay. Cover every mode to be safe.
        for (const typeName of typeNames) {
            const storage = this.objectStorage.get(typeName);
            if (!storage) continue;
            if (storage.instancedMesh) out.push(storage.instancedMesh);
            for (const mesh of storage.unpackedMeshes) out.push(mesh);
            for (const inst of storage.instances) {
                if (inst.voxelObject) out.push(inst.voxelObject);
            }
        }
        return out;
    }

    /**
     * Remove a specific VoxelObject from storage (used when making a prefab instance unique).
     * @param voxelObject The VoxelObject to remove
     * @returns true if the object was found and removed
     */
    public removeVoxelObjectFromStorage(voxelObject: THREE.Object3D): boolean {
        for (const [typeName, storage] of this.objectStorage.entries()) {
            const index = storage.instances.findIndex(inst => inst.voxelObject === voxelObject);
            if (index >= 0) {
                storage.instances.splice(index, 1);
                console.log(`[EnvironmentObjectSystem] Removed object from ${typeName} storage`);
                return true;
            }
        }
        return false;
    }

    /**
     * Get all registered object type names.
     * Used by VoxelEditor to iterate over all voxel object types.
     */
    public getRegisteredTypeNames(): string[] {
        return Array.from(this.objectRegistry.keys());
    }

    /**
     * Level switch: tear down every spawned instance (meshes, LOD sets,
     * physics bodies, id registrations — see engine/levels/envObjectTeardown)
     * while KEEPING the type registry and shared materials/textures, then
     * re-run the same load path the boot used — which re-filters instances by
     * the now-active level. Only meaningful on baked levels.
     */
    public async reloadForLevel(_activeLevelId: string): Promise<void> {
        disposeSpawnedEnvObjectContent({
            physicsWorld: this.physicsWorld,
            objectStorage: this.objectStorage,
            lodStorage: this.lodStorage,
            chunkMeshes: this.chunkMeshes,
            worldBodies: this.worldBodies,
            chunkPhysicsBodies: this.chunkPhysicsBodies,
            dynamicObjects: this.dynamicObjects,
            individualObjects: this.individualObjects,
        });
        // Rapier REUSES rigid-body handles once a body is removed, so a stale
        // entry here would let the next level's body promote the outgoing
        // level's proxy. The proxies themselves are torn down above.
        this.pristineDynamicByHandle.clear();
        // Broken-destructible fragment pools belong to the outgoing level's
        // templates; drop the lane meshes (shared geometry stays with the
        // templates) and void any outstanding slot handles.
        for (const pool of this.fragmentPools.values()) pool.dispose();
        this.fragmentPools.clear();
        await this.generateScenery();
        // The rebuild above created all-new meshes; each one's pipelines
        // compile on the frame that first draws it. Without a re-warm here, a
        // rebuild that lands after the level switch's own warmup (the
        // first-race fence realign runs async off onLevelDidLoad and
        // interleaves with loadLevel's tail — either order is possible) left
        // the whole level to recompile on live gameplay frames: on a
        // first-ever visit (cold on-disk pipeline cache) that reads as tens
        // of seconds of hitching, and every reload hides it. Always re-warm:
        // GameEngine serializes concurrent warmups, and a warmup of
        // already-compiled content is cheap (three's pipeline caches absorb
        // it), so the mid-switch double warm costs one extra un-culled frame
        // under the fade.
        const eng = _moduleEngineRef as { warmUpLoadedScene?: (onProgress: WarmupProgressFn) => Promise<void> } | null;
        if (eng?.warmUpLoadedScene) {
            // No progress surface here — this re-warm runs after the switch's
            // own reported warmup, possibly with the fade already released.
            await eng.warmUpLoadedScene(() => {});
        }
    }

    /**
     * Initialize the environment texture with custom colors.
     * Must be called from template code BEFORE registering environment object types.
     *
     * AI AGENTS: Call this method to customize tree/rock colors!
     *
     * @param colors - Object with color strings for trunk, leaves, and rock
     *                 Default: { trunk: '#8B4513', leaves: '#228B22', rock: '#696969' }
     *
     * Example - Pink trees:
     */
    public initializeEnvironmentTexture(colors?: {
        trunk?: string;
        leaves?: string;
        rock?: string;
    }): void {
        const trunkColor = colors?.trunk ?? '#8B4513';
        const leavesColor = colors?.leaves ?? '#228B22';
        const rockColor = colors?.rock ?? '#696969';

        // Create a small 1x4 texture (1 pixel wide, 4 pixels tall) - power of 2
        // Pixel 0 (row 0): Trunk color
        // Pixel 1 (row 1): Leaves color
        // Pixel 2 (row 2): Rock color
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 4; // Use 4 for power of 2, leave pixel 3 unused
        const ctx = canvas.getContext('2d')!;

        // Pixel 0 (row 0): Trunk
        ctx.fillStyle = trunkColor;
        ctx.fillRect(0, 0, 1, 1);

        // Pixel 1 (row 1): Leaves
        ctx.fillStyle = leavesColor;
        ctx.fillRect(0, 1, 1, 1);

        // Pixel 2 (row 2): Rock
        ctx.fillStyle = rockColor;
        ctx.fillRect(0, 2, 1, 1);

        // Pixel 3: unused (for power of 2)

        this.environmentTexture = new THREE.CanvasTexture(canvas);
        this.environmentTexture.magFilter = THREE.NearestFilter;
        this.environmentTexture.minFilter = THREE.NearestFilter;
        this.environmentTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.environmentTexture.wrapT = THREE.ClampToEdgeWrapping;
        // Disable mipmap generation for very small textures to avoid WebGL warnings
        this.environmentTexture.generateMipmaps = false;

        // Deliberately OUTSIDE the material-class ladder: three shipped
        // template-facing signatures type this as MeshStandardMaterial
        // (getEnvironmentMaterial, EnvironmentObjectType.createInstancedMesh,
        // createStandardInstancedMesh), and frozen published template code
        // calls them — a tier switch here would be a breaking API change, not
        // a visual tweak. The template-frozen category.
        this.environmentMaterial = new THREE.MeshStandardMaterial({
            map: this.environmentTexture,
            roughness: 0.8,
            metalness: 0.1
        });
    }

    public async generateScenery(): Promise<void> {
        // Check flag to determine if objects should be procedurally generated or loaded from world.json
        const generateProcedurally = this.gameData?.environmentObjectsGeneratedProcedurally !== false;
        
        if (generateProcedurally) {
            console.log('📦 Generating environment objects procedurally');
            this.generateSceneryProcedurally();
        } else {
            // Try to load from world.json
            try {
                await this.loadSceneryFromWorldJson();
            } catch (error) {
                console.warn('⚠️ Failed to load environment objects from world.json, falling back to procedural generation:', error);
                this.generateSceneryProcedurally();
            }
        }

        // Dispose-during-load: the creator can DISPOSE_GAME while the async
        // scenery load above is awaiting assets, freeing the rapier world this
        // system captured at construction. Creating the deferred colliders or
        // stepping that world would throw on freed WASM handles — the whole
        // post-placement tail is for a game instance that no longer exists.
        if (this.physicsWorld?.isDisposed()) {
            console.warn('[EnvironmentObjectSystem] Game disposed during scenery load — skipping physics finalization');
            return;
        }

        // Rebuild dirty terrain chunks ONCE after all scenery is placed
        // This applies all terrain modifications (flattenArea with rebuildMeshes=false) in a single batch
        // instead of rebuilding after each object placement (N times slower)
        if (this.voxelTerrainSystem) {
            const voxelWorld = this.voxelTerrainSystem.getVoxelWorld();
            if (voxelWorld?.rebuildDirtyChunks) {
                console.log('[EnvironmentObjectSystem] Rebuilding terrain chunks after scenery placement...');
                voxelWorld.rebuildDirtyChunks();
                // Mark that colliders need a physics step before raycasts are reliable
                // This makes getHeightAt bullet-proof during world generation
                this.voxelTerrainSystem.markCollidersAwaitingPhysicsStep();
            }

            // Note: world.json env objects auto-register as box-shaped navmesh
            // obstacles during their VoxelObject creation (see the
            // `setNavmeshObstacleEnabled` call in the env-object loader), which
            // routes through the swap-safe obstacle-provider registry in
            // VoxelNavMesh. Procedural scenery (trees, rocks placed by
            // `createInstancedMesh` types) that wants navmesh obstacles should
            // register the same way — via `registerObstacleProvider` /
            // `VoxelObject.setNavmeshObstacleEnabled` — so the obstacle survives
            // navmesh rebuilds (e.g. a resolution change via setNavMeshResolution).
        }

        // Allow template to create additional physics bodies (e.g., pending voxel object colliders)
        // before the step that activates them
        if (this.onBeforePhysicsStep) {
            this.onBeforePhysicsStep();
        }

        // Step physics so all environment object colliders (tracks, buildings, trees, rocks)
        // are registered with Rapier and visible to raycasts.
        // Without this, VehicleSpawner ground detection won't detect placed objects.
        if (this.physicsWorld) {
            this.physicsWorld.step(1 / 60);
        }
    }
    
    /**
     * Look up an asset definition by id in the loaded world data. Returns null
     * when no id was given or the world carries no assets — the same shape the
     * per-call-site lookups this replaces produced.
     */
    private static findAsset(worldData: GameData, assetId: unknown): any {
        if (!assetId || !worldData.assets) return null;
        return (worldData.assets as any[]).find((a: any) => a.id === assetId) ?? null;
    }

    /**
     * XZ footprint of a mesh's own geometry, scaled: half-extents plus the
     * local-frame bbox-centre offset (the mesh node's own position is folded in,
     * for assets whose origin isn't at the centroid — fences with x ∈ [0, 2.1]
     * etc.). Shared by both navmesh-obstacle registration paths; see the call
     * sites for why the bounds must come from the rendered geometry rather than
     * `asset.boundingBox`. Returns null when the geometry has no computable
     * bounds or the footprint is degenerate (nothing worth registering).
     */
    private static navmeshFootprint(
        mesh: THREE.Mesh,
        scaleX: number,
        scaleZ: number,
    ): { halfW: number; halfD: number; offsetX: number; offsetZ: number } | null {
        const gb = groundContactBounds(mesh.geometry);
        if (!gb) return null;
        const halfW = ((gb.max.x - gb.min.x) / 2) * scaleX;
        const halfD = ((gb.max.z - gb.min.z) / 2) * scaleZ;
        if (halfW <= 0 || halfD <= 0) return null;
        return {
            halfW,
            halfD,
            offsetX: ((gb.min.x + gb.max.x) / 2 + mesh.position.x) * scaleX,
            offsetZ: ((gb.min.z + gb.max.z) / 2 + mesh.position.z) * scaleZ,
        };
    }


    /**
     * Parse transform data from an object definition (supports both old and new formats).
     * Returns parsed position, rotation, and scale.
     */
    private parseObjectTransform(objDef: any): { x: number; y: number; z: number; rotation?: number; rotationXYZ?: { x: number; y: number; z: number }; scale?: { width: number; height: number; depth: number } } {
        let x: number, y: number, z: number;
        let rotation: number | undefined;
        let rotationXYZ: { x: number; y: number; z: number } | undefined;

        if (objDef.position) {
            x = objDef.position.x;
            y = objDef.position.y;
            z = objDef.position.z;
            if (objDef.rotation) {
                if (typeof objDef.rotation === 'number') {
                    rotation = objDef.rotation;
                    rotationXYZ = { x: 0, y: objDef.rotation, z: 0 };
                } else {
                    rotation = objDef.rotation.y || 0;
                    rotationXYZ = {
                        x: objDef.rotation.x || 0,
                        y: objDef.rotation.y || 0,
                        z: objDef.rotation.z || 0,
                    };
                }
            }
        } else {
            x = objDef.x;
            y = objDef.y;
            z = objDef.z;
            rotation = objDef.rotation;
            if (typeof objDef.rotation === 'number') {
                rotationXYZ = { x: 0, y: objDef.rotation, z: 0 };
            }
        }

        const scale = objDef.scale
            ? {
                width: objDef.scale.x || 1,
                height: objDef.scale.y || 1,
                depth: objDef.scale.z || 1
            }
            : undefined;

        return { x, y, z, rotation, rotationXYZ, scale };
    }

    /**
     * Apply terrain flattening for an object if configured, updating Y position accordingly.
     * Returns the adjusted Y position.
     */
    /**
     * Ground height under an object's BASE footprint, for `placeOnTerrain`.
     *
     * The old single sample at the instance origin `(x, z)` assumed the object is
     * drawn around its origin. It isn't: `boundsOffset`/`pivot` place the mesh
     * wherever the asset says, which for the default tree assets is ~2.1 m
     * diagonally from the origin — so the terrain got read at a point the tree
     * doesn't stand on, and a step in between left it floating a whole block.
     *
     * Sampling the base footprint instead grounds the object on the terrain it
     * actually rests on, whatever its placement. Returns the HIGHEST reading under
     * the footprint, which is where a box collider of that footprint would settle:
     * the object touches ground rather than hovering over the tallest column
     * beneath it.
     */
    private placeOnTerrainHeight(template: { getBaseFootprint?: () => BaseFootprint | null } | null | undefined,
        x: number, z: number, rotation: number | undefined, scale: { width: number; depth: number } | undefined): number {
        const footprint = template?.getBaseFootprint?.() ?? null;
        if (!footprint) return this.terrainHeightProvider.getHeightAt(x, z);
        const step = Math.max(0.25, (this.voxelTerrainSystem?.getBlockSize?.() ?? 1) / 2); // half a block: a one-block step under the base can't be missed
        return footprintGroundHeight(footprint, x, z, rotation ?? 0, scale?.width ?? 1, scale?.depth ?? 1, step, (px, pz) => this.terrainHeightProvider.getHeightAt(px, pz));
    }

    private applyTerrainFlattening(
        objDef: any,
        x: number,
        y: number,
        z: number,
        rotation: number | undefined,
        scale: { width: number; height: number; depth: number } | undefined,
        worldData: GameData
    ): number {
        // Look up asset definition for THIS specific object
        const objAssetDefinition = EnvironmentObjectSystem.findAsset(worldData, objDef.assetId);

        // Instance override takes priority over asset default for flattenTerrain
        const shouldFlatten = objDef.flattenTerrain !== undefined
            ? objDef.flattenTerrain
            : objAssetDefinition?.flattenTerrain;

        if (!shouldFlatten || !objAssetDefinition?.boundingBox || !this.voxelTerrainSystem) {
            return y;
        }

        const bbox = objAssetDefinition.boundingBox;
        let width = (bbox.maxX - bbox.minX) * (scale?.width || 1);
        let depth = (bbox.maxZ - bbox.minZ) * (scale?.depth || 1);
        const flattenMargin = objAssetDefinition.flattenMargin ?? 2;

        // Apply rotation to width/depth if object is rotated 90/270 degrees
        if (rotation !== undefined) {
            const rotY = Math.abs(rotation) % (Math.PI * 2);
            if (Math.abs(rotY - Math.PI / 2) < 0.1 || Math.abs(rotY - Math.PI * 3 / 2) < 0.1) {
                const temp = width;
                width = depth;
                depth = temp;
            }
        }

        const terrainBlockSize = this.voxelTerrainSystem.getBlockSize();
        const flatHeight = this.voxelTerrainSystem.isAreaFlat(x, z, width, depth, flattenMargin);

        if (flatHeight !== null) {
            // Already flat — position on terrain using the actual voxel surface height
            return flatHeight + terrainBlockSize;
        } else {
            // Terrain is uneven — flatten it.
            // getHeightAt returns the walkable TOP of the surface block. flattenArea wants the
            // block's BASE (it floors the argument onto the voxel grid), so step down one block:
            // the block whose top is terrainTop has base terrainTop - blockSize. Passing the top
            // straight through lands exactly on the next boundary up and raises the terrain a
            // whole block.
            const terrainTop = this.terrainHeightProvider.getHeightAt(x, z);
            const terrainBase = terrainTop - terrainBlockSize;
            // Don't rebuild meshes for each object - caller should rebuild once after all objects are placed
            // Pass objectId for snapshot tracking (enables unflatten)
            this.voxelTerrainSystem.flattenArea(x, z, width, depth, terrainBase, undefined, false, flattenMargin, objDef.id);
            return terrainTop;
        }
    }

    /**
     * Load scenery from world.json file using generic deserialization for all registered types
     */
    private async loadSceneryFromWorldJson(): Promise<void> {
        if (!this.gameData) {
            const error = new Error('gameData not available - world.json must be loaded once and passed through the system');
            console.error('❌ Failed to load environment objects:', error);
            throw error;
        }

        const worldData = this.gameData;
        console.log('📦 Loading environment objects from passed gameData');

        // Migrate legacy asset bounding boxes from grid units to meters.
        // Pre-1.1 CREATE_VOXEL_ASSET assets stored boundingBox in voxel grid coordinates.
        // Voxelized GLB assets (with sourceGlbUrl) and default assets (no voxelSize) were already metric.
        if (Array.isArray(worldData.assets)) {
            for (const asset of worldData.assets as any[]) {
                if (asset.boundingBox && !asset.boundingBoxInMeters && asset.voxelSize && !asset.sourceGlbUrl) {
                    const vs = asset.voxelSize;
                    asset.boundingBox.minX *= vs;
                    asset.boundingBox.minY *= vs;
                    asset.boundingBox.minZ *= vs;
                    asset.boundingBox.maxX *= vs;
                    asset.boundingBox.maxY *= vs;
                    asset.boundingBox.maxZ *= vs;
                    asset.boundingBoxInMeters = true;
                    console.log(`  [Migration] Converted bounding box to meters for asset '${asset.name}'`);
                }
            }
        }

        // Load instances from environmentObjects array in world.json
        const allObjects: any[] = [];

        if (Array.isArray(worldData.environmentObjects)) {
            // Standard format: single array with type field
            allObjects.push(...worldData.environmentObjects);
        } else if (worldData.environmentObjects && typeof worldData.environmentObjects === 'object') {
            // Legacy format: separate arrays per type (e.g., { trees: [...], rocks: [...] })
            for (const [arrayName, typeArray] of Object.entries(worldData.environmentObjects)) {
                if (Array.isArray(typeArray)) {
                    // Extract type name from plural (e.g., 'trees' -> 'tree')
                    const typeName = arrayName.endsWith('s') ? arrayName.slice(0, -1) : arrayName;
                    // Add type field to each object for consistent processing
                    (typeArray as any[]).forEach((obj: any) => {
                        if (!obj.type) {
                            obj.type = typeName;
                        }
                        allObjects.push(obj);
                    });
                }
            }
        }

        // Levels mode: keep only the active level's instances (untagged = global;
        // legacy games have a null active level and keep everything).
        const activeLevelId = getActiveLevelIdOrNull();
        const levelFiltered = allObjects.filter((o) =>
            isInstanceInActiveLevel(o as { levelId?: string }, activeLevelId));
        if (levelFiltered.length !== allObjects.length) {
            console.log(`[Levels] environment objects filtered for level ${activeLevelId}: ${levelFiltered.length}/${allObjects.length}`);
        }

        // Group objects by type and load them
        const objectsByType = new Map<string, any[]>();
        for (const objDef of levelFiltered) {
            const typeName = objDef.type;
            if (!typeName) {
                console.warn('⚠️ Skipping object without type field:', objDef);
                continue;
            }

            getOrCreate(objectsByType, typeName, () => []).push(objDef);
        }

        // Auto-register unknown types that have VXL or Gaussian Splat assets
        // This allows custom objects created by AI tools or user uploads to be loaded without manual registration
        const gaussianSplatObjects: { typeName: string; objDefs: any[]; asset: any }[] = [];
        const glbObjects: { typeName: string; objDefs: any[]; asset: Asset }[] = [];
        for (const [typeName, objDefs] of objectsByType) {
            if (this.objectRegistry.has(typeName)) continue;
            const firstObjWithAsset = objDefs.find(obj => obj.assetId);
            const asset = EnvironmentObjectSystem.findAsset(worldData, firstObjWithAsset?.assetId);
            if (asset?.url && asset.type === 'vxl') {
                console.log(`🔧 Auto-registering VXL asset type: ${typeName}`);
                this.registerObjectType({
                    typeName,
                    factory: () => ({ cubes: [], mergedGeometry: new THREE.BufferGeometry(), mesh: new THREE.Object3D() }),
                    canPlace: () => true,
                    proceduralCount: 0,
                    createInstancedMesh: (instances, mesh, data) => ({
                        instancedMesh: mesh || new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial(), 0),
                        instanceData: data
                    }),
                    createPhysics: () => {},
                    getPlacementY: (instance: EnvironmentInstance, heightProvider: TerrainHeightProvider, offset: number) =>
                        heightProvider?.getHeightAt?.(instance.x, instance.z) ?? 0 + offset,
                    getClearRadius: () => 1,
                    getClearSize: () => ({ width: 2, depth: 2 })
                });
            } else if (asset?.url && (asset.type === 'gaussian-splat' || asset.type === 'spz' || asset.url.toLowerCase().endsWith('.spz'))) {
                gaussianSplatObjects.push({ typeName, objDefs, asset });
            } else if (asset?.url && (asset.type === 'glb' || asset.type === 'gltf' || asset.type === 'polygon-mesh')) {
                glbObjects.push({ typeName, objDefs, asset });
            }
        }

        // Load Gaussian Splat assets as individual SplatMesh instances
        if (gaussianSplatObjects.length > 0) {
            await loadGaussianSplatObjects(
                gaussianSplatObjects,
                _moduleEngineRef,
                (objDef) => this.parseObjectTransform(objDef),
            );
        }

        // Load GLB/GLTF assets as individual cloned meshes
        if (glbObjects.length > 0) {
            await this.loadGlbObjects(glbObjects);
        }

        // Track gaussian splat type names so we don't warn about them
        const handledSplatTypes = new Set(gaussianSplatObjects.map(g => g.typeName));
        const handledGlbTypes = new Set(glbObjects.map(g => g.typeName));

        // Start the asset downloads BEFORE the per-type loop, a few ahead of where it is
        // reading. Each type used to fetch, build, then fetch again, so every round-trip
        // was paid with both the network and the main thread idle — ~1.7s of a 4765ms
        // scenery build on a forged circuit. A window rather than all-at-once because
        // holding every decoded asset simultaneously trades load time for the resource
        // that actually kills a phone. See AssetBufferPrefetch.
        const assetBuffers = prefetchVxlAssets(
            objectsByType.values(),
            (id) => EnvironmentObjectSystem.findAsset(worldData, id),
            (url) => ASSET_MAP.get(url) ?? url,
            prefetchAheadFor(activeQualityPolicy().deferred.prefetchAhead),
        );

        // Load instances for each type found in the file
        for (const [typeName, objDefs] of objectsByType) {
            // Per TYPE, not per load. `generateScenery` wraps this whole method in a try/catch that
            // falls back to PROCEDURAL generation, so before this guard one bad object type
            // discarded every authored object in the game — silently, because procedural scenery
            // renders perfectly well.
            //
            // Measured: a leftover template tree carrying `placeOnTerrain: true` on a baked level
            // reached `createInstancedMesh`, whose `getTerrainHeight` dereferenced a null
            // voxelTerrainSystem, and took 1317 forged city props down with it.
            //
            // The type is the right unit because the failure can come from either half — the
            // per-instance placement loop or the single per-type mesh build — and losing one type
            // is a missing prop, while losing the scene is a different game. Same reasoning as the
            // forge's archetype step, which drops one prop rather than forfeiting the level.
            try {
                // Check if this type is registered
                if (!this.objectRegistry.has(typeName)) {
                    if (!handledSplatTypes.has(typeName) && !handledGlbTypes.has(typeName)) {
                        console.warn(`⚠️ Skipping unknown object type '${typeName}' - not registered`);
                    }
                    continue;
                }

                const type = this.getType(typeName);
                const instances: EnvironmentInstance[] = [];

                // Check if this type has a saved asset (look at first object's assetId)
                const firstObjWithAsset = objDefs.find(obj => obj.assetId);
                let loadedVoxelObject: any = null;
                let assetDefinition: any = null; // Store asset definition for flattening check

                if (firstObjWithAsset?.assetId) {
                    assetDefinition = EnvironmentObjectSystem.findAsset(worldData, firstObjWithAsset.assetId);
                    if (assetDefinition?.url && assetDefinition.type === 'vxl') {
                        console.log(`📦 Loading VXL asset for ${typeName}: ${assetDefinition.url}`);
                        try {
                            // Already in flight (or landed) — see the prefetch above.
                            const buffer = await assetBuffers.take(assetDefinition.url);
                            if (buffer) {
                                // No metadata peek before construction: the VXL3 header carries
                                // `useAtlas` and the voxel size, and `loadFromFile` applies both
                                // over what is passed here — see
                                // engine/__tests__/NoWholeBufferJsonPeek.test.ts.
                                const { VoxelObject } = await import('./VoxelObject.js');
                                // Opt-in rounded edges: persisted on the asset by the
                                // creator's voxelize dialog (voxelizeSettings.roundedEdges).
                                const roundedEdges = assetDefinition.voxelizeSettings?.roundedEdges === true;
                                loadedVoxelObject = new VoxelObject({
                                    voxelSize: 0.5,
                                    useAtlas: true,
                                    shadows: true,
                                    primaryLod: activeQualityPolicy().deferred.envLodDrop,
                                    ...(roundedEdges ? { voxelRoundingRadiusVoxels: ROUNDED_EDGES_RADIUS_VOXELS } : {}),
                                });
                                await loadedVoxelObject.loadFromFile(buffer);
                                console.log(`✅ Loaded VXL asset for ${typeName}`);

                                // Replace the asset's metadata bounding box with one
                                // derived from the ACTUAL rendered geometry. The stored
                                // `boundingBox` is unreliable for non-GLB voxel assets:
                                // the legacy units migration above shrinks it, so every
                                // downstream spatial consumer that reads
                                // `assetDefinition.boundingBox` — the terrain-flatten
                                // footprint (`applyTerrainFlattening`), the placed-position
                                // clear radius, the cull sphere, and the ObjectIdService
                                // registration bounds — would otherwise size structural
                                // objects wrong (e.g. walls flattening/culling against a
                                // box smaller than the visible mesh). Geometry bounds are
                                // triangle-derived world-meters that always match what the
                                // player sees — the same source the navmesh-obstacle
                                // registration already trusts. We bake the mesh node offset
                                // so the box centre is correct too. Done once per type here
                                // so all consumers read the corrected value.
                                const templateMesh = loadedVoxelObject.getMesh?.();
                                if (templateMesh?.geometry) {
                                    if (!templateMesh.geometry.boundingBox) templateMesh.geometry.computeBoundingBox();
                                    const gb = templateMesh.geometry.boundingBox;
                                    if (gb && gb.max.x > gb.min.x) {
                                        assetDefinition.boundingBox = {
                                            minX: gb.min.x + templateMesh.position.x,
                                            minY: gb.min.y + templateMesh.position.y,
                                            minZ: gb.min.z + templateMesh.position.z,
                                            maxX: gb.max.x + templateMesh.position.x,
                                            maxY: gb.max.y + templateMesh.position.y,
                                            maxZ: gb.max.z + templateMesh.position.z,
                                        };
                                        assetDefinition.boundingBoxInMeters = true;
                                        assetDefinition.boundingBoxFromGeometry = true;
                                    }
                                }
                            } else {
                                console.warn(`⚠️ No buffer for VXL asset '${typeName}' — skipping its objects`);
                            }
                        } catch (error) {
                            console.warn(`⚠️ Error loading VXL asset for ${typeName}:`, error);
                        }
                    }
                }

                // Split into individual vs batch (InstancedMesh) groups.
                // These objects need individual VoxelObjects (not InstancedMesh) because they require
                // per-object physics bodies (dynamic) or interaction targets (interactable/collectible).
                // Destructible-ONLY instances stay in the batch: they render as
                // plain instances (zero pristine cost) behind a lightweight
                // PristineDestructibleVoxelObject proxy that owns physics and
                // promotes the instance out of the batch on its first real break.
                // `dynamic` ALONE no longer forces an instance out of the batch.
                // Needing your own physics BODY does not mean needing your own
                // render NODE, and leaving the batch costs an instance LOD and
                // distance culling entirely — a hundred parked wrecks each drew
                // full LOD-0 geometry from anywhere on the map, and the LOD
                // distances baked into their asset were never read. They get a
                // pristine dynamic proxy in the batch loop below instead
                // (PristineDynamic.ts).
                //
                // `dynamic` COMBINED WITH `destructible` stays individual: the two
                // pristine paths own the body in incompatible ways (one static
                // union trimesh vs one sleeping dynamic body), and that
                // combination already has a working individual path with
                // structural collapse wired up.
                // A smart object (moving parts baked into the asset — see
                // types/smartObject.ts) needs its own node: its parts are separate
                // meshes under pivot groups, which an InstancedMesh cannot carry.
                const isSmartAsset = Array.isArray(assetDefinition?.smartObject?.parts)
                    && assetDefinition.smartObject.parts.length > 0;
                const needsIndividual = (obj: any) =>
                    obj.interactable === true
                    || obj.collectible === true
                    || (obj.dynamic === true && obj.destructible === true)
                    || isSmartAsset;
                const individualObjDefs = loadedVoxelObject
                    ? objDefs.filter(needsIndividual)
                    : [];
                const batchObjDefs = individualObjDefs.length > 0
                    ? objDefs.filter((obj: any) => !needsIndividual(obj))
                    : objDefs;

                // Process individual objects (interactable and collectible) as individual VoxelObjects
                if (loadedVoxelObject && individualObjDefs.length > 0) {
                    await this.createInteractableObjects(individualObjDefs, loadedVoxelObject, typeName, type, worldData, assetDefinition);
                }

                for (const objDef of batchObjDefs) {
                    // For VXL assets, don't clone - we'll use InstancedMesh with the template's geometry
                    const objectData = loadedVoxelObject
                        ? { cubes: [], mergedGeometry: new THREE.BufferGeometry(), mesh: new THREE.Object3D(), isVxlInstance: true }
                        : type.factory();

                    // Parse transform from object definition
                    const transform = this.parseObjectTransform(objDef);
                    let { x, y, z } = transform;
                    const { rotation, rotationXYZ, scale } = transform;

                    // Restore scale if present (for rocks)
                    if (scale && typeName === 'rock') {
                        (objectData.mergedGeometry.userData as RockGeometryUserData).rockScale = scale;
                    }

                    // forcePosition: use exact coordinates from world.json, skip all Y adjustments
                    if (!objDef.forcePosition) {
                        // Handle placeOnTerrain flag: adjust Y to terrain height and check terrain validity
                        if (objDef.placeOnTerrain) {
                            // Check if terrain at this position allows this object type
                            if (!type.canPlace(x, z, this.terrainHeightProvider, this.terrainRegistry)) {
                                // Skip this instance - terrain doesn't support this object type
                                continue;
                            }
                            // Adjust Y to the terrain under the object's base footprint
                            y = this.placeOnTerrainHeight(loadedVoxelObject, x, z, rotation, scale) + this.groundOffset;
                        }

                        // Apply terrain flattening if configured
                        y = this.applyTerrainFlattening(objDef, x, y, z, rotation, scale, worldData);
                    }

                    instances.push({
                        data: objectData,
                        x,
                        z,
                        y,
                        rotation,
                        rotationXYZ,
                        scale,
                        objDef // Store reference to original definition for ObjectIdService registration
                    });

                    // Auto-register a navmesh obstacle for this static (batched /
                    // InstancedMesh) env object. Static instances don't have an
                    // individual VoxelObject we can hook into — the position is
                    // baked into the InstancedMesh matrix — so we register a
                    // provider with a fixed shape directly. The provider still
                    // survives `setGlobalNavMesh` instance swaps via the module
                    // registry. Opt out per-instance with `obstacle: false` in
                    // the env-object definition.
                    //
                    // Dimensions come from the template VoxelObject's own mesh
                    // geometry, not `assetDefinition.boundingBox`, which the legacy
                    // units migration wrongly shrinks for new non-GLB assets — see
                    // the comment in createInteractableObjects.
                    //
                    // Three kinds of instance are excluded here because they get a
                    // LIVE obstacle instead (a getter, so physics pushes and
                    // destruction keep it truthful), or none at all:
                    //   - interactable / collectible → their individual
                    //     VoxelObject calls setNavmeshObstacleEnabled in
                    //     createInteractableObjects.
                    //   - destructible → its pristine proxy owns a tracked
                    //     obstacle that dies with the object; a fixed provider here
                    //     would block NPC paths forever.
                    //   - dynamic → its pristine proxy owns a tracked obstacle that
                    //     FOLLOWS the body, so a wreck shoved aside stops blocking
                    //     where it used to stand. These instances are batched now
                    //     (see needsIndividual above), so they reach this code and
                    //     must be excluded explicitly.
                    //   - collision: false decorative props → not obstacles at all,
                    //     NPCs walk straight through them.
                    const templateMesh = loadedVoxelObject?.getMesh?.();
                    if (objDef.obstacle !== false && objDef.destructible !== true && objDef.dynamic !== true && envObjectCollides(objDef, assetDefinition) && templateMesh && templateMesh.geometry) {
                        const footprint = EnvironmentObjectSystem.navmeshFootprint(
                            templateMesh, scale?.width ?? 1, scale?.depth ?? 1);
                        if (footprint) {
                            // Rotate the local-frame bbox centre by yaw,
                            // then add to the instance world position.
                            // Static obstacles don't rotate at runtime so
                            // we bake the result.
                            const { halfW, halfD, offsetX, offsetZ } = footprint;
                            const yaw = rotationXYZ?.y ?? rotation ?? 0;
                            const cosY = Math.cos(yaw);
                            const sinY = Math.sin(yaw);
                            const worldX = x + cosY * offsetX + sinY * offsetZ;
                            const worldZ = z - sinY * offsetX + cosY * offsetZ;
                            const fixedShape = { kind: 'box' as const, x: worldX, z: worldZ, halfW, halfD, yaw };
                            registerObstacleProvider(() => fixedShape);
                        }
                    }
                }
            
                const storage = this.getStorage(typeName);
                const idService = getObjectIdService();

                // For VXL assets, create proper InstancedMesh from template geometry.
                // When the .vxl carries additionalLods (v4 trailer), build one
                // InstancedMesh per LOD up-front; the per-frame culling pass
                // (updateInstanceCulling) packs each instance into the right LOD
                // bucket based on distance.
                if (loadedVoxelObject && instances.length > 0) {
                    const templateMesh = loadedVoxelObject.getMesh();
                    if (templateMesh && templateMesh.geometry && templateMesh.material) {
                        const lodCount: number = (typeof loadedVoxelObject.getLodCount === 'function')
                            ? loadedVoxelObject.getLodCount()
                            : 1;

                        // Where the asset's own primary mesh landed: mobile asked
                        // VoxelObject to drop the finest levels outright (see
                        // MAX_DROPPED_ENV_LODS), so they were never meshed and every
                        // index at or below this one resolves to that same mesh.
                        // Desktop promotes nothing and starts at 0.
                        const startLod = loadedVoxelObject.getPrimaryLod?.() ?? 0;

                        // One InstancedMesh (capacity = every instance) from a LOD
                        // template mesh, with a fresh cloned geometry and the shared
                        // distance-fading material.
                        //
                        // Three.js can't frustum-cull individual instances; the
                        // per-frame `updateInstanceCulling` does that work in JS
                        // and uses `count` to gate which instances are drawn.
                        // Disabling Three's whole-mesh cull avoids the case where
                        // the mesh's bounding sphere (computed from instance 0's
                        // template only) gets stale as we re-pack matrices.
                        const makeLodInstancedMesh = (template: THREE.Mesh, name: string, visibleCount: number): THREE.InstancedMesh => {
                            const mesh = new THREE.InstancedMesh(
                                template.geometry.clone(),
                                this.fadedMaterial(template.material),
                                instances.length,
                            );
                            mesh.name = name;
                            mesh.castShadow = true;
                            mesh.receiveShadow = true;
                            mesh.frustumCulled = false;
                            mesh.count = visibleCount;
                            return mesh;
                        };

                        // Build the InstancedMeshes for asset LODs startLod..lodCount-1
                        // (LOD 0 = template above; LOD k = getMeshForLod(k)).
                        const lodMeshes: THREE.InstancedMesh[] = [];
                        for (let k = startLod; k < lodCount; k++) {
                            const lodTemplate: THREE.Mesh | null = k === 0
                                ? templateMesh
                                : (typeof loadedVoxelObject.getMeshForLod === 'function'
                                    ? loadedVoxelObject.getMeshForLod(k)
                                    : null);
                            if (!lodTemplate || !lodTemplate.geometry || !lodTemplate.material) {
                                // Missing LOD geometry → skip the rest; we still have lower-index LODs
                                // and the culling code degrades gracefully when a slot is absent.
                                console.warn(`[EnvironmentObjectSystem] ${typeName} LOD ${k} has no template mesh; skipping further LODs.`);
                                break;
                            }
                            lodMeshes.push(makeLodInstancedMesh(
                                lodTemplate,
                                lodCount > 1 ? `${typeName}_instanced_lod${k}` : `${typeName}_instanced`,
                                k === startLod ? instances.length : 0,
                            ));
                        }

                        // Safety net: a multi-LOD asset should always yield its first
                        // requested level, but if getMeshForLod came back empty, fall
                        // back to the guaranteed LOD-0 template instead of crashing.
                        if (lodMeshes.length === 0) {
                            lodMeshes.push(makeLodInstancedMesh(templateMesh, `${typeName}_instanced`, instances.length));
                        }

                        // The "primary" InstancedMesh that other systems (ObjectIdService,
                        // interaction lookups) reference stays at the finest BUILT level.
                        const instancedMesh = lodMeshes[0]!;

                        // Shadow-only mesh: instances behind/beside the player whose
                        // shadows still project into the visible scene. Uses the
                        // coarsest available LOD's geometry (cheap shadow rasterization).
                        // Lives on a non-default layer so the main camera skips it; the
                        // shadow camera has that layer enabled in GameEngine.
                        // (lodMeshes is never empty here — the safety net above guarantees
                        // at least the LOD-0 fallback.)
                        const coarsest = lodMeshes[lodMeshes.length - 1]!;
                        const shadowMesh = new THREE.InstancedMesh(
                            coarsest.geometry,    // share with the coarsest LOD — same vertex buffer, no extra GPU memory
                            coarsest.material,
                            instances.length,
                        );
                        shadowMesh.name = `${typeName}_shadowOnly`;
                        shadowMesh.castShadow = true;
                        shadowMesh.receiveShadow = false;
                        shadowMesh.frustumCulled = false;
                        shadowMesh.count = 0;
                        shadowMesh.layers.set(EnvironmentObjectSystem.SHADOW_ONLY_LAYER);
                        this.world.add(shadowMesh);

                        // Pre-compute per-instance transforms once; updateInstanceCulling
                        // repacks them into the current LOD's instanceMatrix each frame
                        // without ever recomputing the matrix itself.
                        const matrices: THREE.Matrix4[] = new Array(instances.length);
                        const spheres: THREE.Sphere[] = new Array(instances.length);

                        // World-space bounding sphere radius for the frustum test.
                        // Source the bounds from the ACTUAL rendered geometry, NOT
                        // `assetDefinition.boundingBox`: the latter is wrongly shrunk
                        // by the legacy units migration for non-GLB voxel assets (see
                        // the navmesh-obstacle bounds notes above and in
                        // createInteractableObjects), so a sphere built from it is too
                        // small, fails to contain the visible mesh, and frustum-culls
                        // structural walls/floors at grazing camera angles. The
                        // InstancedMesh clones exactly this geometry and draws it under
                        // `compose(position, quaternion, scaleVec)` with no node offset,
                        // so `geometry.boundingBox` is the frame the per-instance sphere
                        // must bound. Fall back to the asset bbox only if geometry has
                        // no computable bounds.
                        if (!templateMesh.geometry.boundingBox) templateMesh.geometry.computeBoundingBox();
                        const geomBox = templateMesh.geometry.boundingBox;
                        const bbox = geomBox
                            ? {
                                minX: geomBox.min.x, minY: geomBox.min.y, minZ: geomBox.min.z,
                                maxX: geomBox.max.x, maxY: geomBox.max.y, maxZ: geomBox.max.z,
                              }
                            : assetDefinition?.boundingBox;
                        const bboxDiagonal = bbox
                            ? Math.sqrt(
                                (bbox.maxX - bbox.minX) ** 2 +
                                (bbox.maxY - bbox.minY) ** 2 +
                                (bbox.maxZ - bbox.minZ) ** 2,
                              )
                            : 2.0;
                        // Center the sphere at the bbox center (in object space) so the
                        // building's body, not just the pivot at the base, is what gets
                        // frustum-tested.
                        const bboxCenter = bbox
                            ? new THREE.Vector3(
                                (bbox.minX + bbox.maxX) / 2,
                                (bbox.minY + bbox.maxY) / 2,
                                (bbox.minZ + bbox.maxZ) / 2,
                              )
                            : new THREE.Vector3(0, bboxDiagonal / 4, 0);

                        const quaternion = new THREE.Quaternion();
                        const scaleVec = new THREE.Vector3();
                        const positionVec = new THREE.Vector3();
                        for (let i = 0; i < instances.length; i++) {
                            const instance = instances[i];
                            if (!instance) continue;

                            // Use positions exactly as stored in world.json. Full XYZ rotation
                            // for VXL assets (user-edited via gizmo/inspector); Y-only for legacy.
                            positionVec.set(instance.x, instance.y, instance.z);
                            if (instance.rotationXYZ) {
                                quaternion.setFromEuler(new THREE.Euler(
                                    instance.rotationXYZ.x,
                                    instance.rotationXYZ.y,
                                    instance.rotationXYZ.z,
                                ));
                            } else {
                                quaternion.setFromEuler(new THREE.Euler(0, instance.rotation || 0, 0));
                            }
                            scaleVec.set(
                                instance.scale?.width || 1,
                                instance.scale?.height || 1,
                                instance.scale?.depth || 1,
                            );

                            const matrix = new THREE.Matrix4().compose(positionVec, quaternion, scaleVec);
                            matrices[i] = matrix;

                            // Bind LOD 0's instanceMatrix to the full set on the cheap path
                            // so the very first frame (before updateInstanceCulling runs)
                            // shows everything instead of an empty world.
                            instancedMesh.setMatrixAt(i, matrix);

                            // World-space sphere bounding this instance's true AABB.
                            // Apply the per-axis scale (NOT a single uniform maxScale)
                            // to the asset bbox: a uniform scalar over-/under-shoots
                            // each axis for non-uniformly scaled objects (a wall is
                            // wide + tall but thin), so the sphere drifts off the real
                            // AABB and the object gets culled at grazing angles. Scale
                            // the bbox half-extents per axis, then bound the scaled box
                            // with a rotation-invariant sphere (radius = half-diagonal).
                            const halfExtents = bbox
                                ? new THREE.Vector3(
                                    ((bbox.maxX - bbox.minX) / 2) * scaleVec.x,
                                    ((bbox.maxY - bbox.minY) / 2) * scaleVec.y,
                                    ((bbox.maxZ - bbox.minZ) / 2) * scaleVec.z,
                                  )
                                : new THREE.Vector3(
                                    (bboxDiagonal / 2) * scaleVec.x,
                                    (bboxDiagonal / 2) * scaleVec.y,
                                    (bboxDiagonal / 2) * scaleVec.z,
                                  );
                            const center = new THREE.Vector3(
                                bboxCenter.x * scaleVec.x,
                                bboxCenter.y * scaleVec.y,
                                bboxCenter.z * scaleVec.z,
                            )
                                .applyQuaternion(quaternion)
                                .add(positionVec);
                            spheres[i] = new THREE.Sphere(
                                center,
                                halfExtents.length() * INSTANCE_CULL_SPHERE_MARGIN,
                            );
                        }
                        instancedMesh.instanceMatrix.needsUpdate = true;

                        // Compute the LOD distance thresholds + cull distance from
                        // the asset's voxelizeSettings (with default fallbacks). Same
                        // logic is reused by `updateLodConfigForAsset` so live edits
                        // from the dialog produce identical values to load time.
                        // Derived for the asset's FULL LOD count (so per-LOD user
                        // overrides keep their indices), then sliced to the built
                        // levels: the new finest starts at 0, coarser bands keep
                        // their original start distances.
                        // Building vs prop by largest bbox dimension → wide (100/200/300) vs
                        // tight LOD schedule (see EnvLodPolicy). bbox is the rendered geometry box.
                        const isBuilding = isBuildingSized(
                            bbox ? Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, bbox.maxZ - bbox.minZ) : 0,
                        );
                        const derived = this.deriveLodConfig(
                            assetDefinition?.voxelizeSettings,
                            lodCount,
                            isBuilding,
                        );
                        const lodDistances = EnvironmentObjectSystem.sliceLodDistances(derived.lodDistances, startLod);
                        const cullDistance = derived.cullDistance;

                        // Structural objects (walls/floors/ceilings) can opt out of
                        // frustum culling via `alwaysVisible: true` on any of this
                        // type's world.json env-object definitions, so the agent can
                        // mark them instead of hand-rolling anti-cull game-loop code.
                        const disableFrustumCulling = instances.some(
                            inst => inst?.objDef?.alwaysVisible === true,
                        ) || DEFAULT_DISABLE_FRUSTUM_CULLING;

                        // Add LOD meshes to the scene (LOD 0 already at full count for first frame).
                        // Each LOD's cloned CPU geometry buffers are released once that LOD
                        // first draws with a non-zero count (published games drop every vertex
                        // attribute; the editor keeps position for click-select raycasts and
                        // the splat export). Indices are kept either way — a released index is
                        // re-uploaded as a 0-byte WebGPU buffer when the next level rebuilds
                        // these meshes, and the failed draw drops the whole frame (see
                        // GeometryCpuRelease). The shadow-only mesh is NOT registered: it shares the
                        // coarsest LOD's geometry and only ever draws under the shadow override
                        // material, so the coarsest LOD's own draw covers it.
                        const releaseMode = isStandaloneMode ? 'full' : 'keep-pickable';
                        for (const lodMesh of lodMeshes) {
                            this.world.add(lodMesh);
                            // Keep the shading attributes: this geometry is cloned,
                            // shared with the shadow-only mesh and re-bound on level
                            // switches, and a re-upload from a released array gives a
                            // 0-byte buffer — empty `normal` renders the surface
                            // uniformly black, empty `uv` renders it colourless.
                            releaseMeshCpuBuffersAfterUpload(lodMesh, releaseMode, true);
                        }

                        this.lodStorage.set(typeName, {
                            assetId: assetDefinition?.id ?? null,
                            startLod,
                            meshes: lodMeshes,
                            shadowMesh,
                            matrices,
                            spheres,
                            lodDistances,
                            cullDistance,
                            isBuilding,
                            disableFrustumCulling,
                        });
                        this.instanceCullingActive = true;

                        // Back-compat: ObjectIdService and several legacy code paths
                        // index into storage.instancedMesh by instance slot. Keep
                        // pointing it at LOD 0 — that's the mesh whose `instanceId`
                        // matches `instanceIndex` in the registration payload.
                        storage.instancedMesh = instancedMesh;
                        storage.instances = instances.map(inst => inst.data);
                    
                        // Create physics bodies for each instance
                        for (let i = 0; i < instances.length; i++) {
                            const instance = instances[i];
                            if (!instance) continue;

                            // Destructible-only instance: batched visuals + a
                            // pristine proxy that owns the physics body and
                            // promotes the instance out of the batch when it
                            // actually breaks. (ObjectIdService registration
                            // below stays on the batch, so editor picking works
                            // exactly like any other batched prop.)
                            if (instance.objDef?.destructible === true && !this.planeLocked) {
                                this.createPristineDestructibleProxy(typeName, i, instance, loadedVoxelObject, assetDefinition);
                            } else if (instance.objDef?.dynamic === true && !this.planeLocked) {
                                // Dynamic instance: batched visuals + a pristine
                                // proxy owning a SLEEPING dynamic body. It costs
                                // nothing per step until Rapier wakes it, and
                                // promotes out of the batch at that moment.
                                this.createPristineDynamicProxy(typeName, i, instance, loadedVoxelObject, assetDefinition);
                            } else if (this.physicsWorld && loadedVoxelObject.createPhysicsBodyAtPosition
                                && envObjectCollides(instance.objDef, assetDefinition)) {
                                // Full XYZ when the instance carries it — the SAME
                                // rotation the InstancedMesh matrix above is composed
                                // from, so a gizmo-tilted prop collides as drawn.
                                const body = loadedVoxelObject.createPhysicsBodyAtPosition(
                                    this.physicsWorld,
                                    instance.x, instance.y, instance.z,
                                    instance.rotation || 0,
                                    instance.scale,
                                    instance.rotationXYZ,
                                    // Which instance this is. The body's VoxelObject is the
                                    // shared TYPE TEMPLATE, so without this a hit cannot be
                                    // traced back to the copy that was actually struck.
                                    { typeName, index: i },
                                );
                                // The instances are drawn by an InstancedMesh, so this body
                                // hangs off no Object3D — without registering it here nothing
                                // could ever remove it, and a level switch left the whole set
                                // behind as invisible collision.
                                if (body) {
                                    this.worldBodies.push(body);
                                    this.trackPhysicsBodyInChunk(body, instance.x, instance.z);
                                    this.carveBodies.set(`${typeName}:${i}`, body);
                                }
                            }
                        
                            // Register with ObjectIdService (using stored objDef reference)
                            const objDef = instance.objDef;
                        
                            // Look up asset definition for THIS specific object (not just the first one)
                            // This matches the flattenTerrain logic which does the same lookup
                            const instanceAssetDef = EnvironmentObjectSystem.findAsset(worldData, objDef?.assetId);
                        
                            if (objDef?.id) {
                                const registrationData = { ...objDef, boundingBox: instanceAssetDef?.boundingBox, instanceIndex: i };
                                idService.register(objDef.id, 'object', instancedMesh, registrationData);
                            }
                        
                            // Register position for runtime occupancy queries
                            // Use actual bounding box from THIS object's asset for proper building footprints
                            // Must match the exact calculation used in flattenTerrain above
                            const bbox = instanceAssetDef?.boundingBox;
                            let clearRadius: number;
                            if (bbox) {
                                const flattenMargin = instanceAssetDef?.flattenMargin ?? 2;
                                const scaleX = instance.scale?.width || 1;
                                const scaleZ = instance.scale?.depth || 1;
                                const width = (bbox.maxX - bbox.minX) * scaleX;
                                const depth = (bbox.maxZ - bbox.minZ) * scaleZ;
                                // Use half the max dimension plus margin as clear radius
                                clearRadius = Math.max(width, depth) / 2 + flattenMargin;
                            } else {
                                clearRadius = type.getClearRadius(instance);
                            }
                            this.registerPlacedPosition(instance.x, instance.z, clearRadius);
                        }
                    } else {
                        console.warn(`⚠️ VXL template for ${typeName} has no mesh - cannot create InstancedMesh`);
                    }
                } else {
                    // Non-VXL objects: use the type's createInstancedMesh
                    const result = type.createInstancedMesh(
                        instances.map(inst => ({
                            data: inst.data,
                            x: inst.x,
                            z: inst.z,
                            y: inst.y,
                            rotation: inst.rotation,
                            scale: inst.scale
                        })),
                        storage.instancedMesh,
                        instances.map(inst => inst.data),
                        this.world,
                        this.worldBodies,
                        this.environmentMaterial!,
                        this.physicsWorld
                    );

                    storage.instancedMesh = result.instancedMesh;
                    storage.instances = result.instanceData;

                    // Create physics and register positions for each instance
                    for (let i = 0; i < instances.length; i++) {
                        const instance = instances[i];
                    
                        if (!instance) continue;
                    
                        // Track physics bodies created for this instance.
                        // Decorative props (collision: false) skip the collider.
                        const prevBodyCount = this.worldBodies.length;
                        if (envObjectCollides(instance.objDef, assetDefinition)) {
                            // Procedural scenery physics (trees, rocks) is 3D-only; the 2D lane hands it no world.
                            type.createPhysics(instance, this.worldBodies, this.planeLocked ? null : this.physicsWorld);
                        }
                    
                        // Associate new bodies with this chunk
                        for (let j = prevBodyCount; j < this.worldBodies.length; j++) {
                            this.trackPhysicsBodyInChunk(this.worldBodies[j], instance.x, instance.z);
                        }
                    
                        // Register with ObjectIdService (using stored objDef reference)
                        const objDef = instance.objDef;
                        if (objDef?.id && result.instancedMesh) {
                            const registrationData = { ...objDef, boundingBox: assetDefinition?.boundingBox, instanceIndex: i };
                            idService.register(objDef.id, 'object', result.instancedMesh, registrationData);
                        }
                    
                        // Register position for runtime occupancy queries
                        const clearRadius = type.getClearRadius(instance);
                        this.registerPlacedPosition(instance.x, instance.z, clearRadius);
                    }
                }
            
                console.log(`✅ Loaded ${instances.length} instances of type '${typeName}' from world.json`);
            } catch (error) {
                console.warn(
                    `⚠️ Skipping environment object type '${typeName}' (${objDefs.length} instance(s)) — `
                    + 'it could not be built; the rest of the scene is unaffected:',
                    error,
                );
                continue;
            }
        }
        
        console.log('✅ Finished loading environment objects from world.json');
    }
    
    /**
     * Lazily-created per-type pool for broken destructible fragments. Lane
     * meshes reference the template's fragment geometry — never cloned — so
     * the first break of a type pays a small pool setup and pristine levels
     * pay nothing. Null when the template has no built fragment meshes.
     */
    private getOrCreateFragmentPool(typeName: string, template: any): FragmentInstancePool | null {
        const existing = this.fragmentPools.get(typeName);
        if (existing) return existing;
        const sources = getFragmentVisualSources(template);
        if (!sources) return null;
        const pool = new FragmentInstancePool(this.world, sources, `${typeName}_fragpool`);
        this.fragmentPools.set(typeName, pool);
        return pool;
    }

    /**
     * Companion object for a destructible-only batched instance: renders
     * nothing while pristine (the batch does), but owns the physics body,
     * the navmesh obstacle and the game-code identity, and swaps the
     * instance out of the batch on its first real break. Mechanics live in
     * PristineDestructible.ts.
     */
    private createPristineDestructibleProxy(
        typeName: string,
        instanceIndex: number,
        instance: PristineDestructibleInstance,
        template: any,
        assetDefinition: any,
    ): void {
        const proxy = spawnPristineDestructibleProxy({
            typeName,
            instance,
            template,
            assetDefinition,
            world: this.world,
            physicsWorld: this.physicsWorld,
            destructionMode: resolveDestructionMode(instance.objDef, assetDefinition?.boundingBox, instance.scale),
            spheres: this.lodStorage.get(typeName)?.spheres ?? null,
            instanceIndex,
            getPool: () => this.getOrCreateFragmentPool(typeName, template),
        });
        // Game-code contract: destructible instances remain reachable via
        // VoxelObjectBuilder.getAllObjects(), exactly like the old
        // individual-object path. Editor picking stays on the batch's
        // ObjectIdService registration.
        const objectId = instance.objDef?.id || getObjectIdService().generateId('env');
        VoxelObjectBuilder.registerExternalObject(objectId, proxy);
        this.individualObjects.push(proxy);
    }

    /**
     * Companion object for a DYNAMIC batched instance: renders nothing while
     * pristine (the batch does, with full LOD and distance culling), but owns a
     * sleeping dynamic body, a tracked navmesh obstacle and the game-code
     * identity, and swaps the instance out of the batch the first time Rapier
     * wakes that body. Mechanics live in PristineDynamic.ts.
     */
    private createPristineDynamicProxy(
        typeName: string,
        instanceIndex: number,
        instance: PristineDynamicInstance,
        template: any,
        assetDefinition: any,
    ): void {
        const proxy = spawnPristineDynamicProxy({
            typeName,
            instance,
            template,
            assetDefinition,
            world: this.world,
            physicsWorld: this.physicsWorld,
            spheres: this.lodStorage.get(typeName)?.spheres ?? null,
            instanceIndex,
            onPromoted: (obj) => {
                // Only NOW does this object need per-step visual sync and chunk
                // management — while it slept it needed neither.
                this.trackDynamicObject(obj);
                _moduleEngineRef?.getDynamicObjectManager?.()?.register(obj, 'dynamic_prop', 1.0);
            },
        });

        // Same game-code contract as the destructible proxy: the instance stays
        // reachable through VoxelObjectBuilder.getAllObjects(), and editor
        // picking stays on the batch's ObjectIdService registration.
        const objectId = instance.objDef?.id || getObjectIdService().generateId('env');
        VoxelObjectBuilder.registerExternalObject(objectId, proxy);
        this.individualObjects.push(proxy);

        const body = proxy.getRigidBody();
        if (body) {
            this.pristineDynamicByHandle.set(body.handle, proxy);
            this.ensureDynamicSyncCallback();
            this.ensurePristineDynamicWakeSweep();
        }
    }

    /**
     * Post-step sweep that promotes any pristine dynamic prop whose body Rapier
     * has woken. Driven by `forEachActiveRigidBody`, which visits ONLY awake
     * bodies — so a level of resting props costs nothing here, and the sweep
     * scales with what actually moves rather than with how much was placed.
     * Registered once, on the first pristine dynamic instance.
     */
    private ensurePristineDynamicWakeSweep(): void {
        if (this.pristineDynamicWakeBound || !this.physicsWorld) return;
        this.pristineDynamicWakeBound = () => {
            if (this.pristineDynamicByHandle.size === 0) return;
            // Read the world at CALL time, never capture it: this callback
            // outlives a level switch, and a captured reference would go stale.
            // COLLECT inside the callback, PROMOTE after it.
            //
            // `forEachActiveRigidBody` holds a borrow of the rapier world for the whole
            // iteration, and `promote()` reaches `physicsWorld.createCollider()` — a
            // mutation of the very world being iterated. Rapier's guard rejects the
            // re-entrant borrow with "recursive use of an object detected which would lead
            // to unsafe aliasing in rust", and because that unwinds out through WASM the
            // borrow is never released: every rapier call for the rest of the session
            // throws, every vehicle disables itself, and physics halts permanently.
            //
            // It needed a prop to be struck hard enough to wake — so it struck mid-race,
            // a minute or two in, and looked random. The frame it happens in reports six
            // vehicles failing and a halted world, none of which name this.
            // Before the first step the query BVH does not exist: every raycast misses,
            // every wake would read as "hanging over nothing" and the whole level would
            // promote on frame one. Rapier reports all bodies active on that first step.
            if (!this.physicsWorld || this.physicsWorld.getStepsTaken() === 0) return;
            const waking: Array<{ handle: number; proxy: PristineDynamicVoxelObject }> = [];
            this.physicsWorld.forEachActiveRigidBody((body) => {
                const proxy = this.pristineDynamicByHandle.get(body.handle);
                if (proxy) waking.push({ handle: body.handle, proxy });
            });
            // A wake that is only the prop sitting inside the baked surface (or under a
            // lazily-enabled static collider, or on one that culling toggled) is settled and
            // slept, and the prop stays batched — promoting it would leave it awake and
            // pushed every step for the rest of the session. Decide for EVERY waking prop
            // first: the decision raycasts, and promote() adds colliders, which a raycast
            // in the same callback must not follow (see queryPipelineDirty).
            const promoting = waking.filter(({ proxy }) => proxy.shouldPromoteOnWake());
            for (const { handle, proxy } of promoting) {
                // Delete BEFORE promoting: promote() is idempotent, but dropping
                // the entry keeps the map shrinking toward empty so the sweep
                // costs nothing once a level's props have settled into place.
                this.pristineDynamicByHandle.delete(handle);
                proxy.promote();
            }
        };
        // PRE-SOLVE, not post-step. `promote()` creates colliders, and rapier 0.19 keeps its
        // query BVH up to date only inside `world.step()` — so a collider added after a step
        // leaves scene queries describing a world that no longer matches, and the next
        // raycast walks it and panics inside WASM, wedging the borrow for the session.
        // Running here puts `step()` immediately after the promotion, closing that window.
        //
        // The sweep reads the ACTIVE body set, which is one substep stale here rather than
        // fresh. That costs a prop one substep of batched rendering before it promotes,
        // which is invisible; the alternative killed races.
        this.physicsWorld.registerPreSolveCallback(this.pristineDynamicWakeBound);
    }

    /**
     * Register the physics→visual sync callback without adding anything to its
     * list yet. Split out of trackDynamicObject so the callback is in place
     * BEFORE the wake sweep can promote an object into it — registering a
     * post-step callback from inside another post-step callback mutates the set
     * being iterated.
     */
    private ensureDynamicSyncCallback(): void {
        if (this.physicsPostStepBound || !this.physicsWorld) return;
        this.physicsPostStepBound = () => {
            for (const dynObj of this.dynamicObjects) {
                dynObj.syncWithPhysics();
            }
        };
        this.physicsWorld.registerPostStepCallback(this.physicsPostStepBound);
    }

    /**
     * Create individual VoxelObjects for interactable/collectible environment object instances.
     * These get their own scene Object3D (instead of being batched into InstancedMesh)
     * so the interaction system (E-key) or collection system (auto-collect) can detect them.
     */
    private async createInteractableObjects(
        individualObjDefs: any[],
        templateVoxelObject: any,
        typeName: string,
        type: EnvironmentObjectType,
        worldData: GameData,
        _assetDefinition: any
    ): Promise<void> {
        const { VoxelObject } = await import('./VoxelObject.js');
        const idService = getObjectIdService();

        for (const objDef of individualObjDefs) {
            // Parse transform from object definition
            const transform = this.parseObjectTransform(objDef);
            let { x, y, z } = transform;
            const { rotation, rotationXYZ, scale } = transform;

            // Resolve the asset def once: drives the collision/obstacle opt-out
            // below and the bounding-box registration further down.
            const assetDef = EnvironmentObjectSystem.findAsset(worldData, objDef.assetId);
            // Decorative props (collision: false) get no collider and no navmesh
            // obstacle, so the player and NPCs pass straight through them.
            const collides = envObjectCollides(objDef, assetDef);

            // forcePosition: use exact coordinates, skip all Y adjustments
            if (!objDef.forcePosition) {
                // Handle placeOnTerrain
                if (objDef.placeOnTerrain) {
                    if (!type.canPlace(x, z, this.terrainHeightProvider, this.terrainRegistry)) {
                        continue;
                    }
                    y = this.placeOnTerrainHeight(templateVoxelObject, x, z, rotation, scale) + this.groundOffset;
                }

                // Apply terrain flattening if configured
                y = this.applyTerrainFlattening(objDef, x, y, z, rotation, scale, worldData);
            }

            // Create individual VoxelObject by cloning from template
            const clone = new VoxelObject({
                voxelSize: templateVoxelObject.voxelSize ?? 0.5,
                useAtlas: true,
                shadows: true
            });
            templateVoxelObject.cloneDataTo(clone);
            // This clone owns its geometry outright — nothing else renders from
            // it — so per-hit mutation (bullet holes) is safe here. The batched
            // instances further down share the TEMPLATE and must never be marked.
            clone.setCarveable(true);

            // Set transform — use full XYZ Euler when available, fall back to Y-only for legacy data
            clone.position.set(x, y, z);
            if (rotationXYZ) {
                clone.rotation.set(rotationXYZ.x, rotationXYZ.y, rotationXYZ.z);
            } else if (rotation !== undefined) {
                clone.rotation.y = rotation;
            }
            if (scale) {
                clone.scale.set(scale.width, scale.height, scale.depth);
            }
            clone.name = objDef.name || typeName;

            // Add to scene
            this.world.add(clone);

            // Tag GLB-backed env voxels so the Gaussian Splat export can find
            // them (regardless of storage path) and swap them for their original
            // textured GLB. `glbDynamic` marks objects the export must drop
            // entirely (they move — a baked splat would ghost).
            {
                const glbAsset = objDef.assetId
                    ? (worldData.assets ?? []).find(a => a.id === objDef.assetId)
                    : undefined;
                if (glbAsset?.sourceGlbUrl) {
                    clone.userData.glbSourceUrl = glbAsset.sourceGlbUrl;
                    clone.userData.glbBoundingBox = glbAsset.boundingBox;
                    clone.userData.glbDynamic = !!objDef.dynamic;
                }
            }

            // Create physics body (skipped for non-colliding decorative props)
            if (this.physicsWorld && collides) {
                if (objDef.dynamic) {
                    // Mass: an AUTHORED per-instance mass wins (the level designer
                    // knows a traffic cone is ~4 kg); otherwise estimate from the
                    // asset's bounds volume at loose-prop density (~120 kg/m3): a
                    // car-sized wreck lands near a tonne, a crate near 20 kg. The
                    // estimate overestimates sparse shapes (bbox ≠ solid volume).
                    // Both paths are clamped so extreme values can't destabilize
                    // the solver.
                    const bb = assetDef?.boundingBox;
                    const volume = bb
                        ? Math.max(0.01,
                            (bb.maxX - bb.minX) * (scale?.width ?? 1)
                            * (bb.maxY - bb.minY) * (scale?.height ?? 1)
                            * (bb.maxZ - bb.minZ) * (scale?.depth ?? 1))
                        : 0;
                    const authoredMass = typeof objDef.mass === 'number' && Number.isFinite(objDef.mass) && objDef.mass > 0
                        ? Math.min(3000, Math.max(0.1, objDef.mass))
                        : null;
                    const mass = authoredMass ?? (volume > 0 ? Math.min(3000, Math.max(5, volume * 120)) : 10);
                    // startAsleep: world.json props were authored at rest — no
                    // settle wave at load; a kart or push wakes them normally.
                    clone.createDynamicPhysicsBody(this.physicsWorld, mass, _moduleEngineRef ?? undefined, {
                        startAsleep: true,
                        ...(assetDef?.colliderShape ? { colliderShape: assetDef.colliderShape } : {}),
                    });
                    // Forced (forge-authored) Y is the terrain heightfield's; the baked surface
                    // is voxel-rounded, so the prop lands a few cm inside it and never sleeps.
                    // Rest it on the actual surface (see VoxelObject.restOnSurfaceBelow).
                    if (objDef.forcePosition) {
                        clone.requestSurfaceRest();
                    }
                    this.trackDynamicObject(clone);
                } else {
                    clone.createPhysicsBody(this.physicsWorld);
                }

                // Enable structural collapse for destructible pipeline assets:
                // disconnected voxel clusters fall and shatter on impact.
                // (Reached when `destructible` is combined with dynamic /
                // interactable / collectible — plain destructibles stay
                // batched and go through the pristine-proxy path instead.)
                if (objDef.destructible && !this.planeLocked) {
                    clone.setDestructionMode(resolveDestructionMode(objDef, assetDef?.boundingBox, scale));
                    enableStructuralCollapse(clone, this.physicsWorld, this.world);
                }
            }

            // Register with VoxelObjectBuilder so template code can find it via getAllObjects()
            const objectId = objDef.id || idService.generateId('env');
            VoxelObjectBuilder.registerExternalObject(objectId, clone);
            this.individualObjects.push(clone);

            // Smart object: swap the single mesh for per-part meshes under pivot
            // groups, and hand the instance to the system that animates them. The
            // collider built above stays the rest pose — blades are not solid.
            if (assetDef?.smartObject?.parts?.length > 0) {
                _moduleEngineRef?.getSmartObjectSystem?.()?.attach(objectId, clone, assetDef.smartObject);
            }

            // Register with ObjectIdService (assetDef resolved at loop top)
            const registrationData = {
                ...objDef,
                boundingBox: assetDef?.boundingBox
            };
            idService.register(objectId, 'object', clone, registrationData);

            // Auto-register as a navmesh obstacle so NPCs path around the object.
            // Skipped when the env-object definition has `obstacle: false`.
            // The obstacle is tracked: it follows the VoxelObject's live
            // position/yaw, so physics pushes update pathfinding automatically.
            //
            // Bounds come from the actual rendered mesh geometry — not from
            // metadata (`asset.boundingBox` is mutated by the legacy units
            // migration, and `voxelObject.getBounds()` is set from .vxl
            // metadata which doesn't always match the visible mesh). The
            // geometry's bounding box is computed from triangle vertices,
            // so it's always world-meters and always matches what the
            // player sees on screen.
            //
            // Mesh local-frame offset (`mesh.position`) is added to handle
            // assets whose origin isn't at the centroid (fences with
            // x ∈ [0, 2.1] etc.). The engine rotates the resulting offset
            // by the live yaw before adding to the object's world position.
            if (objDef.obstacle !== false && collides) {
                const mesh = clone.getMesh();
                if (mesh && mesh.geometry) {
                    const footprint = EnvironmentObjectSystem.navmeshFootprint(
                        mesh, objDef.scale?.x ?? 1, objDef.scale?.z ?? 1);
                    if (footprint) {
                        clone.setNavmeshObstacleEnabled(
                            true, footprint.halfW, footprint.halfD, footprint.offsetX, footprint.offsetZ);
                    }
                }
            }

            // Auto-wire CollectibleComponent for collectible objects
            if (objDef.collectible && this.physicsWorld) {
                new CollectibleComponent(this.physicsWorld, {
                    collectible: {
                        onCollect: () => {
                            // Hide the object on collection
                            clone.visible = false;
                            // Remove physics body
                            if (clone.userData.rigidBody && this.physicsWorld) {
                                this.physicsWorld.removeRigidBody(clone.userData.rigidBody);
                                clone.userData.rigidBody = null;
                            }
                        }
                    },
                    object3D: clone,
                    radius: 2.0,
                    meta: { objectId, name: objDef.name || typeName },
                });
            }

            // Register position for runtime occupancy queries
            const clearRadius = type.getClearRadius({
                data: { cubes: [], mergedGeometry: new THREE.BufferGeometry(), mesh: new THREE.Object3D() },
                x, z, y
            });
            this.registerPlacedPosition(x, z, clearRadius);
        }

    }

    /**
     * Load GLB/GLTF environment objects as individual cloned meshes.
     * Similar to Gaussian Splat loading — each instance is a cloned scene from the loaded GLTF.
     */
    private async loadGlbObjects(
        glbGroups: { typeName: string; objDefs: any[]; asset: Asset }[]
    ): Promise<void> {
        const idService = getObjectIdService();
        const loader = createGltfLoader();

        // Pre-fetch every GLB scene concurrently (bounded — mobile gets a lower
        // cap because decode memory, not connection count, is the limit). Order is
        // preserved so scenes[gi] matches glbGroups[gi]; placement stays serial.
        // Each completed fetch ticks the main-screen loading bar (reports are
        // dropped outside the boot 'world' phase, so level switches stay silent).
        let fetched = 0;
        const scenes = await mapWithConcurrency(
            glbGroups,
            activeQualityPolicy().deferred.loadConcurrency,
            async ({ typeName, asset }): Promise<THREE.Group | null> => {
                try {
                    return (await loader.loadAsync(asset.url)).scene;
                } catch (error) {
                    console.error(`❌ Failed to load GLB asset for ${typeName}:`, error);
                    return null;
                } finally {
                    fetched++;
                    reportWorldSubProgress('objects', fetched / glbGroups.length);
                }
            },
        );

        for (let gi = 0; gi < glbGroups.length; gi++) {
            const { typeName, objDefs, asset } = glbGroups[gi]!;
            const rawScene = scenes[gi];
            if (!rawScene) continue; // fetch failed (logged above)
            console.log(`📦 Loaded GLB asset for ${typeName}: ${asset.url}`);

            // Compute native bounding box before any transforms
            const bbox = new THREE.Box3().setFromObject(rawScene);
            const modelSize = new THREE.Vector3();
            bbox.getSize(modelSize);
            const modelCenter = new THREE.Vector3();
            bbox.getCenter(modelCenter);

            // Scale to match targetHeight
            let uniformScale = 1;
            const targetHeight = asset.targetHeight ?? 2.0;
            if (targetHeight && modelSize.y > 0) {
                uniformScale = targetHeight / modelSize.y;
            }

            // A smart prop (bmSmartObject extras + BM_part_* nodes) animates its parts like a voxel
            // smart object. Derived from the native scene, before the re-centre below moves it.
            const GLB_LIFT = 0.005;
            const smart = deriveGlbSmartObject(rawScene, {
                origin: { x: modelCenter.x, y: bbox.min.y, z: modelCenter.z },
                scale: uniformScale,
                lift: GLB_LIFT,
            });
            if (smart) {
                console.log(`⚙️ GLB smart object "${typeName}": ${smart.bake.table.map((p) => p.name).join(', ')}`);
                for (const warning of smart.warnings) console.warn(`[GlbSmartObject] ${typeName}: ${warning}`);
            }

            // Store scaled dimensions on the asset for the Creator UI
            asset.glbDimensions = {
                width: +(modelSize.x * uniformScale).toFixed(3),
                height: +(modelSize.y * uniformScale).toFixed(3),
                depth: +(modelSize.z * uniformScale).toFixed(3),
            };

            // Re-center the source scene: pivot at center X/Z, bottom Y
            // Wrap in a group so position.set() on the clone controls world placement
            const centeredGroup = new THREE.Group();
            rawScene.position.set(-modelCenter.x, -bbox.min.y, -modelCenter.z);
            centeredGroup.add(rawScene);

            // The collider GLB (createGlbTrimeshCollider) shares this native
            // frame, so its verts need the same recentering the visual gets.
            const recenterOffset = rawScene.position.clone();

            console.log(`📐 GLB "${typeName}": native=${modelSize.x.toFixed(2)}x${modelSize.y.toFixed(2)}x${modelSize.z.toFixed(2)}, scale=${uniformScale.toFixed(3)}, final=${asset.glbDimensions.width}x${asset.glbDimensions.height}x${asset.glbDimensions.depth}`);

            // Many copies of one asset (a forged forest, a scatter of rocks) draw through ONE
            // InstancedMesh per sub-mesh; each copy stays a real registered object whose meshes
            // the batch renders for it (see GlbInstancing.ts).
            // A smart instance is drawn per instance, like a voxel one: its parts move on their own.
            const batch = !smart && objDefs.length >= GLB_INSTANCING_MIN_COPIES && isInstanceableGlb(centeredGroup)
                ? new GlbInstanceBatch(centeredGroup, this.world, objDefs.length)
                : null;

            for (const objDef of objDefs) {
                const transform = this.parseObjectTransform(objDef);
                const { x, z } = transform;
                const y = transform.y;

                const objectId = objDef.id || idService.generateId('object');

                // The placed object carries ONLY the world.json transform (position, rotation, the
                // instance's own scale): it is what the editor selects and what
                // serializeEnvironmentObjects() writes back, so a save round-trips exactly. The
                // asset's fit-to-targetHeight scale and the tiny z-fighting lift live on a child —
                // on the object itself they were saved into objDef.scale and compounded every save.
                const object = smart ? new GlbSmartObjectHost(smart.bake) : new THREE.Group();
                object.name = asset.name || typeName;
                object.userData.isGlbEnvironmentObject = true;
                const body = centeredGroup.clone();
                body.scale.setScalar(uniformScale);
                body.position.y = GLB_LIFT; // tiny z-fighting offset
                object.add(body);
                // bmedit anchors (a door, a seat) get the short names game code looks up.
                canonicalAnchorNames(body);

                object.scale.set(objDef.scale?.x || 1, objDef.scale?.y || 1, objDef.scale?.z || 1);

                object.position.set(x, y, z);

                if (objDef.rotation) {
                    // Legacy definitions store a bare yaw number; newer ones a full XYZ Euler.
                    const r = objDef.rotation;
                    if (typeof r === 'number') {
                        object.rotation.set(0, r, 0);
                    } else {
                        object.rotation.set(r.x || 0, r.y || 0, r.z || 0);
                    }
                }

                // Apply shadows and polygon offset to prevent z-fighting with terrain
                const zOffset = getZFightingRegistry().acquireObjectOffset(objectId);
                object.traverse((child: THREE.Object3D) => {
                    if (child instanceof THREE.Mesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;

                        const applyOffset = (mat: THREE.Material) => {
                            mat.polygonOffset = true;
                            mat.polygonOffsetFactor = zOffset.factor;
                            mat.polygonOffsetUnits = zOffset.units;
                        };
                        if (Array.isArray(child.material)) {
                            child.material.forEach(applyOffset);
                        } else {
                            applyOffset(child.material);
                        }
                    }
                });

                this.world.add(object);
                this.individualObjects.push(object);
                batch?.add(object);

                // Force world matrix update so child matrixWorld values are correct
                object.updateMatrixWorld(true);

                // A smart instance's moving parts come out of the body BEFORE the colliders are
                // built: the static collider is the body alone, so no ghost cabin sits at its rest
                // pose while the drawn one moves. Code that makes the prop rideable adds kinematic
                // bodies that follow the parts (@docs smart-objects.md, "Riding a part").
                const smartParts = smart && object instanceof GlbSmartObjectHost && object.liftParts();

                // Create physics for the instance. Decorative props
                // (collision: false) skip the collider entirely.
                if (this.physicsWorld && this.planeLocked && envObjectCollides(objDef, asset) && isPlaneLockedPhysics(this.physicsWorld)) {
                    // Static mesh boxes sliced to the gameplay plane, like voxel objects;
                    // `dynamic` and `colliderUrl` are 3D-lane options.
                    createGlbPlaneLockedColliders(this.physicsWorld, this.worldBodies, object);
                }
                if (this.physicsWorld && !this.planeLocked && envObjectCollides(objDef, asset)) {
                    if (objDef.dynamic) {
                        // dynamic: true wins over colliderUrl — dynamic bodies
                        // always use compound boxes (trimesh is static-only).
                        this.trackDynamicObject(createDynamicGlbBody(
                            this.physicsWorld, object, _moduleEngineRef as GlbDynamicEngineRef | null));
                    } else if (asset.colliderUrl && asset.colliderType !== 'voxel') {
                        // Precise collision: trimesh from the generated collider GLB.
                        await createGlbTrimeshCollider(this.physicsWorld, this.worldBodies, object, asset, recenterOffset,
                            object.scale.clone().multiplyScalar(uniformScale));
                    } else {
                        createGlbBoxColliders(this.physicsWorld, this.worldBodies, object);
                    }
                }

                const registrationData = { ...objDef, assetId: objDef.assetId, boundingBox: asset.boundingBox };
                idService.register(objectId, 'object', object, registrationData);

                if (smart && smartParts && object instanceof GlbSmartObjectHost) {
                    const attached = _moduleEngineRef?.getSmartObjectSystem?.()?.attach(objectId, object, smart.bake.fitment);
                    if (!attached) object.restoreParts();
                }

                if (!batch) console.log(`✅ Loaded GLB instance: ${object.name} at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) scale=${uniformScale.toFixed(2)}`);
            }

            if (batch) {
                batch.update();
                const engine = _moduleEngineRef as { registerBeforeRender?: (cb: () => void) => () => void } | null;
                const unregister = engine?.registerBeforeRender?.(() => batch.update());
                // Torn down with the level's other placed objects (envObjectTeardown calls dispose).
                this.individualObjects.push(Object.assign(batch.root, {
                    dispose: () => { unregister?.(); batch.dispose(); },
                }));
                console.log(`✅ Loaded ${objDefs.length} instances of ${asset.name || typeName} (instanced)`);
            }
        }
    }

    /**
     * Generate scenery procedurally using registered object types
     */
    private generateSceneryProcedurally(): void {
        // Iterate through all registered object types
        for (const [typeName, type] of this.objectRegistry) {
            const instances: EnvironmentInstance[] = [];
            const count = type.proceduralCount;
            
            // Spawn instances for this type
            for (let i = 0; i < count; i++) {
                let x, z;
                let attempts = 0;
                do {
                    x = (this.rng.next() - 0.5) * (this.worldSize * 0.8);
                    z = (this.rng.next() - 0.5) * (this.worldSize * 0.8);
                    attempts++;
                } while ((Math.sqrt(x * x + z * z) < 10 || !type.canPlace(x, z, this.terrainHeightProvider, this.terrainRegistry)) && attempts < 100);

                if (attempts < 100) {
                    const objectData = type.factory();
                    
                    // Create instance with placement data
                    const instance: EnvironmentInstance = {
                        data: objectData,
                        x,
                        z,
                        y: 0, // Will be set by getPlacementY
                        rotation: typeName === 'rock' ? this.rng.next() * Math.PI * 2 : undefined
                    };
                    
                    // Set Y position using type-specific handler
                    instance.y = type.getPlacementY(instance, this.terrainHeightProvider, this.groundOffset);
                    
                    instances.push(instance);
                    
                    // Update terrain type to prevent foliage overlap
                    const currentTerrainType = this.terrainHeightProvider.getTerrainTypeAt(x, z);
                    const terrainProps = this.terrainRegistry.getType(currentTerrainType);
                    const noFoliageType = terrainProps && terrainProps.foliageType !== FoliageType.NONE
                        ? (NO_FOLIAGE_TERRAIN_TYPE.get(currentTerrainType) ?? currentTerrainType)
                        : currentTerrainType;

                    // Clear terrain at placement location
                    const clearSize = type.getClearSize(instance);
                    this.terrainHeightProvider.setTerrainTypeRect(x, z, clearSize.width, clearSize.depth, noFoliageType);
                    
                    // Register position for runtime occupancy queries
                    const clearRadius = type.getClearRadius(instance);
                    this.registerPlacedPosition(x, z, clearRadius);
                    
                    if (this.foliageSystem) {
                        this.foliageSystem.clearFoliageAt(x, z, clearRadius);
                    }
                }
            }
            
            // Create InstancedMesh for this type if we have instances
            if (instances.length > 0 && this.environmentMaterial) {
                const storage = this.getStorage(typeName);
                const prevBodyCount = this.worldBodies.length;
                
                const result = type.createInstancedMesh(
                    instances,
                    storage.instancedMesh,
                    storage.instances,
                    this.world,
                    this.worldBodies,
                    this.environmentMaterial,
                    this.physicsWorld
                );
                storage.instancedMesh = result.instancedMesh;
                storage.instances = result.instanceData;
                
                // Track physics bodies per chunk (bodies created during createInstancedMesh)
                this.trackNewPhysicsBodiesByChunk(prevBodyCount);
            }
        }
        
        console.log('✅ Scenery generated');
    }

    /**
     * Helper method for AI agents: Creates a standard InstancedMesh for simple object types.
     * 
     * AI AGENTS: Use this helper in your createInstancedMesh handler for simple object types
     * that don't need custom scaling or rotation logic. For complex cases (like rocks with
     * variable scale), implement your own handler following createRockInstancedMeshInternal().
     * 
     * @param typeName - The type name (for naming the InstancedMesh)
     * @param instances - Array of instances to create
     * @param instancedMesh - Existing InstancedMesh to reuse (or null to create new)
     * @param instanceData - Existing instance data array (or empty array)
     * @param world - The Three.js world object
     * @param worldBodies - Array of physics bodies
     * @param material - Material to use for the InstancedMesh
     * @returns Object with instancedMesh and instanceData
     */
    public createStandardInstancedMesh(
        typeName: string,
        instances: EnvironmentInstance[],
        instancedMesh: THREE.InstancedMesh | null,
        instanceData: EnvironmentObjectData[],
        world: THREE.Object3D,
        worldBodies: any[],
        material: THREE.MeshStandardMaterial
    ): { instancedMesh: THREE.InstancedMesh; instanceData: EnvironmentObjectData[] } {
        if (instances.length === 0) {
            throw new Error(`Cannot create InstancedMesh for ${typeName} with no instances`);
        }
        
        const firstInstance = instances[0];
        if (!firstInstance) {
            throw new Error(`First instance is missing for ${typeName}`);
        }
        const baseGeometry = firstInstance.data.mergedGeometry.clone();
        const resultInstances: EnvironmentObjectData[] = [];
        
        // Group instances by chunk for per-chunk InstancedMeshes
        const chunkGroups = new Map<string, EnvironmentInstance[]>();
        for (const instance of instances) {
            const chunkKey = this.getChunkKey(instance.x, instance.z);
            getOrCreate(chunkGroups, chunkKey, () => []).push(instance);
        }
        
        // Create one InstancedMesh per chunk
        let firstMesh: THREE.InstancedMesh | null = null;
        const matrix = new THREE.Matrix4();
        let globalInstanceId = 0;
        
        for (const [chunkKey, chunkInstances] of chunkGroups) {
            const chunkMesh = new THREE.InstancedMesh(baseGeometry.clone(), material, chunkInstances.length);
            chunkMesh.castShadow = true;
            chunkMesh.receiveShadow = true;
            chunkMesh.name = `${typeName}_chunk_${chunkKey}`;
            
            for (let i = 0; i < chunkInstances.length; i++) {
                const instance = chunkInstances[i]!;
                matrix.makeTranslation(instance.x, instance.y, instance.z);
                if (instance.rotation !== undefined && instance.rotation !== 0) {
                    matrix.multiply(new THREE.Matrix4().makeRotationY(instance.rotation));
                }
                chunkMesh.setMatrixAt(i, matrix);
                
                const data: EnvironmentObjectData = {
                    cubes: instance.data.cubes.map(cube => ({
                        ...cube,
                        position: cube.position.clone().add(new THREE.Vector3(instance.x, instance.y, instance.z))
                    })),
                    mergedGeometry: instance.data.mergedGeometry,
                    mesh: instance.data.mesh,
                    instanceId: globalInstanceId++
                };
                resultInstances.push(data);
            }
            
            chunkMesh.instanceMatrix.needsUpdate = true;
            this.attachChunkMesh(typeName, chunkKey, chunkMesh, world);

            if (!firstMesh) firstMesh = chunkMesh;
        }
        
        // Return first mesh for compatibility (legacy code expects single mesh)
        // The actual per-chunk meshes are stored in chunkMeshes
        return { instancedMesh: firstMesh!, instanceData: resultInstances };
    }

    /**
     * Track a dynamic VoxelObject so its visual syncs with physics each step.
     * Registers a post-step callback on the physics world (once) to sync all tracked objects.
     * `dispose()` (the only handle on a dynamic GLB prop's body) stays in the
     * tracked type so the level teardown can call it — see envObjectTeardown.
     */
    private trackDynamicObject(obj: { syncWithPhysics(): void; dispose?: () => void }): void {
        this.dynamicObjects.push(obj);
        this.ensureDynamicSyncCallback();
    }

    /**
     * Helper function to set all child meshes to layer 3 (non-clickable sub-objects)
     * This ensures sub-objects like individual cubes cannot be selected
     */
    private setChildMeshesToLayer3(object: THREE.Object3D): void {
        object.traverse((child: THREE.Object3D) => {
            if (child instanceof THREE.Mesh && child !== object) {
                // Set child meshes to layer 3 (non-clickable)
                child.layers.set(3);
            }
        });
    }
    
    /**
     * Unpack InstancedMeshes into individual meshes for Scene editor selection.
     * This allows individual selection and manipulation of environment objects,
     * works with all registered object types, and preserves all original
     * registration data (assetId, etc.) from world.json.
     *
     * @see EnvObjectPackOps.unpackInstancedMeshes
     */
    public unpackInstancedMeshes(typeName?: string): void {
        unpackInstancedMeshesOp(this, typeName);
    }

    /**
     * Pack individually editable meshes back into InstancedMeshes.
     *
     * INVARIANT: pack/unpack are rendering transitions owned by EditorManager
     * (only called from enable/disableEditorMode). Read paths must NOT call this —
     * serializeEnvironmentObjects() works in either packed or unpacked state.
     *
     * @see EnvObjectPackOps.packInstancedMeshes
     */
    public packInstancedMeshes(typeName?: string): void {
        packInstancedMeshesOp(this, typeName);
    }

    /** True if the given environment-object type is currently unpacked (unlocked for editing). */
    public isTypeUnpacked(typeName: string): boolean {
        return this.unpackedTypes.has(typeName);
    }

    /**
     * Reverse-lookup the environment-object type a clicked Object3D belongs to —
     * its LOD InstancedMesh, packed InstancedMesh, or per-chunk cube mesh — or
     * null if it isn't an environment-object mesh. Used by the Scene editor to
     * identify which locked type the user clicked so it can offer to unlock it.
     */
    public getEnvTypeForObject(object: THREE.Object3D): string | null {
        for (const [typeName, lod] of this.lodStorage) {
            if (lod.shadowMesh === object) return typeName;
            for (const m of lod.meshes) {
                if (m === object) return typeName;
            }
        }
        for (const [typeName, storage] of this.objectStorage) {
            if (storage.instancedMesh === object) return typeName;
        }
        for (const [, chunkTypeMap] of this.chunkMeshes) {
            for (const [typeName, mesh] of chunkTypeMap) {
                if (mesh === object) return typeName;
            }
        }
        return null;
    }

    /** Number of placed instances of a type (for the "X is instanced (N)" unlock prompt). */
    public getTypeInstanceCount(typeName: string): number {
        return this.getInstanceCount(typeName);
    }

    /**
     * Find the unpacked (unlocked) individual mesh of a type closest to a world
     * position. Used by the Scene editor to select the exact instance the user
     * clicked after its type has just been unpacked.
     */
    public findUnpackedMeshNear(typeName: string, position: THREE.Vector3): THREE.Object3D | null {
        const storage = this.getStorage(typeName);
        let best: THREE.Object3D | null = null;
        let bestDistSq = Infinity;
        for (const mesh of storage.unpackedMeshes) {
            const distSq = mesh.position.distanceToSquared(position);
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                best = mesh;
            }
        }
        return best;
    }

    /**
     * Write every LOD-instanced type's logical (authoritative) instance
     * transforms back into its primary InstancedMesh buffer at logical slots.
     *
     * updateInstanceCulling repacks that buffer every frame with a compacted
     * visible subset, so `getMatrixAt(instanceIndex)` — which the genre
     * WorldGenerator's serializeEnvironmentObjects() in existing games relies
     * on — reads the wrong instance whenever culling has run. Call this
     * immediately before any such read; the next culling pass repacks the
     * buffer for rendering again.
     */
    public restoreLogicalInstanceMatrices(): void {
        for (const [typeName, lodData] of this.lodStorage) {
            if (this.unpackedTypes.has(typeName)) continue;
            const storage = this.getStorage(typeName);
            const mesh = storage.instancedMesh;
            if (!mesh) continue;
            for (let i = 0; i < lodData.matrices.length; i++) {
                const m = lodData.matrices[i];
                if (m) mesh.setMatrixAt(i, m);
            }
            mesh.instanceMatrix.needsUpdate = true;
        }
    }
    
    /**
     * Mark that environment objects have been modified
     * Called when packing InstancedMeshes after Scene editor modifications
     */
    markEnvironmentObjectsModified(): void {
        this.hasModifications = true;
    }
    
    /**
     * Serialize environment objects to world.json format
     * Returns array of environment objects with standardized transform data
     * Format: [{ type: string, position: {x,y,z}, rotation: {x,y,z}, scale: {x,y,z} }, ...]
     */
    public serializeEnvironmentObjects(): any[] {
        const environmentObjects: any[] = [];
        
        // Serialize all registered types into a single array
        for (const [typeName] of this.objectRegistry) {
            const storage = this.getStorage(typeName);
            
            if (storage.instancedMesh && storage.instances.length > 0) {
                const matrix = new THREE.Matrix4();
                for (let i = 0; i < storage.instances.length; i++) {
                    storage.instancedMesh.getMatrixAt(i, matrix);
                    const position = new THREE.Vector3();
                    const quaternion = new THREE.Quaternion();
                    const scale = new THREE.Vector3();
                    matrix.decompose(position, quaternion, scale);
                    
                    // Extract rotation as Euler angles
                    const euler = new THREE.Euler();
                    euler.setFromQuaternion(quaternion);
                    
                    environmentObjects.push({
                        type: typeName,
                        position: {
                            x: position.x,
                            y: position.y,
                            z: position.z
                        },
                        rotation: {
                            x: euler.x,
                            y: euler.y,
                            z: euler.z
                        },
                        scale: {
                            x: scale.x,
                            y: scale.y,
                            z: scale.z
                        }
                    });
                }
            }
        }
        
        return environmentObjects;
    }

    /**
     * Get the count of instances for each registered type.
     * Used to determine how many procedural objects exist (for deduplication with ObjectIdService).
     */
    public getInstanceCounts(): Map<string, number> {
        const counts = new Map<string, number>();
        for (const [typeName] of this.objectRegistry) {
            const storage = this.getStorage(typeName);
            counts.set(typeName, storage.instances.length);
        }
        return counts;
    }

    /**
     * Check if environment objects have been modified and need saving
     */
    public hasEnvironmentObjectModifications(): boolean {
        return this.hasModifications;
    }
    
    // ==================== VISIBILITY CULLING ====================
    // NOTE: Environment object culling ONLY works in unpacked mode (editor mode).
    // In packed mode, all objects of each type are in a single InstancedMesh that spans
    // the entire world, so culling the entire mesh doesn't help.
    
    private cullingFrustum = new THREE.Frustum();
    private cullingMatrix = new THREE.Matrix4();
    // Environment objects stay visible to the fog distance by default (the genre sets this
    // from worldProfileData.fogConfig.far). Objects should fade into fog, not pop out early —
    // a small default made large objects (houses) vanish distractingly close. Per-LOD
    // instancing keeps distant objects cheap. A world can opt into a shorter distance.
    /**
     * What a caller ASKED for, before the quality tier's scale. Kept separately so a live
     * tier change re-derives from the request rather than scaling an already-scaled value —
     * two tier changes in a session would otherwise compound into a much shorter draw
     * distance than any rung actually asks for.
     */
    private requestedRenderDistance: number = 500;
    /** `requestedRenderDistance` after the tier's scale — what culling and fade read. */
    private maxRenderDistance: number = 500;
    /**
     * Distance-fade materials, one per source LOD material. Env objects (VXL
     * buildings/props) DISSOLVE into the sky over the last band before the cull
     * instead of popping; see `EnvDistanceFade`. Keyed by the atlas source material
     * so all LODs sharing it reuse one faded material. Never mutates the source.
     */
    private readonly fadedMaterialCache: WeakMap<THREE.Material, THREE.Material> = new WeakMap();
    private cullingEnabled: boolean = false;

    /**
     * Slice a full-LOD-count distance schedule down to the built levels when the
     * finest `startLod` levels were skipped: the new finest level starts at 0,
     * and every coarser band keeps its original start distance.
     */
    private static sliceLodDistances(lodDistances: number[], startLod: number): number[] {
        if (startLod <= 0) return lodDistances;
        return [0, ...lodDistances.slice(startLod + 1)];
    }

    /**
     * Derive per-LOD start distances + the cull distance from a `VoxelizeSettings`
     * record. User overrides on each LOD's `distance` field win over the absolute
     * defaults. Used at load time and by `updateLodConfigForAsset` so the dialog's
     * live-apply path produces identical values to the load-time computation.
     */
    private deriveLodConfig(
        voxelizeSettings: { additionalLods?: Array<{ distance?: number }> } | undefined,
        lodCount: number,
        isBuilding: boolean,
    ): { lodDistances: number[]; cullDistance: number } {
        const settingsLods = voxelizeSettings?.additionalLods ?? [];
        // Buildings/landmarks switch LODs on the wide 100/200/300 schedule (matching
        // the forged terrain); small props keep the tighter default. An asset's own
        // per-LOD `distance` (re-voxelize dialog) still overrides either.
        const defaults = isBuilding ? BUILDING_LOD_DISTANCES_M : PROP_LOD_DISTANCES_M;
        const lodDistances: number[] = new Array(lodCount).fill(0);
        for (let k = 1; k < lodCount; k++) {
            const userDist = settingsLods[k - 1]?.distance;
            if (typeof userDist === 'number' && userDist > 0) {
                lodDistances[k] = userDist;
            } else {
                lodDistances[k] = defaults[k] ?? defaults[defaults.length - 1]!;
            }
        }
        // The LOD-reach floor: keep instances at least until just past the last LOD band so the
        // coarsest LOD is always reachable. The ACTUAL cull distance is max(this, the configured
        // render distance) — see updateInstanceCulling — so objects render to the fog by default.
        const lastLodDist = lodDistances[lodCount - 1] ?? 0;
        const cullDistance = lastLodDist + 50;
        return { lodDistances, cullDistance };
    }

    /**
     * Live-apply new LOD distance overrides for every type that was loaded
     * from the given asset. Called by the creator's re-voxelize dialog when
     * the user clicks "Save" (settings-only path) — patches the running
     * lodStorage so the next `updateInstanceCulling` frame uses the new
     * thresholds without re-uploading any geometry.
     */
    updateLodConfigForAsset(
        assetId: string,
        voxelizeSettings: { additionalLods?: Array<{ distance?: number }> } | undefined,
    ): void {
        let updated = 0;
        for (const [, storage] of this.lodStorage) {
            if (storage.assetId !== assetId) continue;
            // Re-derive for the asset's FULL LOD count (built + skipped-finest) so
            // the dialog's per-LOD distance overrides keep their original indices,
            // then slice to the built levels exactly like the load-time path.
            const derived = this.deriveLodConfig(voxelizeSettings, storage.meshes.length + storage.startLod, storage.isBuilding);
            storage.lodDistances = EnvironmentObjectSystem.sliceLodDistances(derived.lodDistances, storage.startLod);
            storage.cullDistance = derived.cullDistance;
            updated++;
        }
        if (updated > 0) {
            console.log(`[EnvironmentObjectSystem] LOD config updated live for ${updated} type(s) of asset ${assetId}`);
        }
    }

    /**
     * Per-frame instance culling + LOD bucketing for VXL-asset-backed types.
     *
     * For each type registered in `lodStorage`:
     *  1. distance-cull instances beyond `cullDistance`,
     *  2. frustum-test against the camera frustum first (the common case),
     *  3. if not in camera but in the shadow frustum, pack into the
     *     type's dedicated shadow-only InstancedMesh (lives on a layer
     *     the main camera skips — color pass cost is zero),
     *  4. otherwise pick the LOD bucket whose start-distance ≤ instance
     *     distance < next-start-distance and pack into that LOD's mesh,
     *  5. set `count` + `instanceMatrix.needsUpdate` on every mesh
     *     (color LOD meshes + shadow-only mesh).
     *
     * Cost per frame: O(totalInstances) sphere-frustum tests + the same number
     * of matrix copies — sub-millisecond at city scale.
     *
     * @param shadowCamera Optional directional-light shadow camera. When
     *   passed, off-screen instances inside its orthographic frustum end up
     *   in the shadow-only mesh so their shadows still project into the view.
     */
    updateInstanceCulling(camera: THREE.Camera, shadowCamera?: THREE.Camera | null): void {
        if (!this.instanceCullingActive || this.lodStorage.size === 0) return;

        camera.updateMatrixWorld();
        this.instanceFrustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.instanceFrustum.setFromProjectionMatrix(this.instanceFrustumMatrix);

        let hasShadowFrustum = false;
        if (shadowCamera) {
            shadowCamera.updateMatrixWorld();
            this.shadowFrustumMatrix.multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
            this.shadowFrustum.setFromProjectionMatrix(this.shadowFrustumMatrix);
            hasShadowFrustum = true;
        }

        const cameraPos = camera.position;

        for (const [lodTypeName, lodData] of this.lodStorage) {
            // Unpacked (unlocked) types render as individual editable meshes; zero
            // their LOD instances so they don't double-render under the editor.
            if (this.unpackedTypes.has(lodTypeName)) {
                for (const mesh of lodData.meshes) { mesh.count = 0; mesh.instanceMatrix.needsUpdate = true; }
                if (lodData.shadowMesh) { lodData.shadowMesh.count = 0; lodData.shadowMesh.instanceMatrix.needsUpdate = true; }
                continue;
            }
            const { meshes, shadowMesh, matrices, spheres, lodDistances, cullDistance, disableFrustumCulling } = lodData;
            const K = meshes.length;
            const counts: number[] = new Array(K).fill(0);
            let shadowCount = 0;
            // Cull at the configured render distance (defaults to the fog distance, overridable
            // shorter) so objects fade into fog instead of popping early — but never before this
            // type's LOD-reach floor (`cullDistance`), so its coarsest LOD stays reachable.
            const effectiveCull = Math.max(this.maxRenderDistance, cullDistance);

            for (let i = 0; i < matrices.length; i++) {
                const sphere = spheres[i];
                if (!sphere) continue;

                // Cull and LOD distances are measured to the bounding-sphere
                // SURFACE, not its center: a long object (a 200 m bridge) must
                // count as "close" when the camera is near either end — the
                // center can be half the span away while the player stands on
                // it. Cheapest cull first, radius folded into the threshold so
                // no sqrt is spent on culled instances.
                const dx = sphere.center.x - cameraPos.x;
                const dy = sphere.center.y - cameraPos.y;
                const dz = sphere.center.z - cameraPos.z;
                const distSq = dx * dx + dy * dy + dz * dz;
                const cullReach = effectiveCull + sphere.radius;
                if (distSq > cullReach * cullReach) continue;
                // Outside the render region: neither drawn nor shadow-casting.
                if (this.renderRegion && !this.renderRegion.intersectsSphere(sphere)) continue;

                this.instanceSphereScratch.center.copy(sphere.center);
                this.instanceSphereScratch.radius = sphere.radius;
                // Structural opt-out: force visibility, skip the frustum test.
                const inCamera = disableFrustumCulling
                    || this.instanceFrustum.intersectsSphere(this.instanceSphereScratch);

                if (inCamera) {
                    // Structural objects stay in LOD 0 so they never drop to a
                    // coarser/empty mesh; everything else picks LOD by distance
                    // to the sphere surface (0 whenever the camera is inside it).
                    let lodK = 0;
                    if (!disableFrustumCulling) {
                        const dist = Math.max(0, Math.sqrt(distSq) - sphere.radius);
                        for (let k = 1; k < K; k++) {
                            if (dist >= lodDistances[k]!) lodK = k;
                            else break;
                        }
                    }
                    const slot = counts[lodK]!;
                    meshes[lodK]!.setMatrixAt(slot, matrices[i]!);
                    counts[lodK] = slot + 1;
                } else if (hasShadowFrustum && shadowMesh && this.shadowFrustum.intersectsSphere(this.instanceSphereScratch)) {
                    // Shadow-only: instance is behind/beside the camera but
                    // casts a shadow into the visible world. Pack into the
                    // dedicated shadow mesh (layer 1 — main camera skips it).
                    shadowMesh.setMatrixAt(shadowCount, matrices[i]!);
                    shadowCount++;
                }
            }

            for (let k = 0; k < K; k++) {
                const mesh = meshes[k]!;
                mesh.count = counts[k]!;
                mesh.instanceMatrix.needsUpdate = true;
                // InstancedMesh.raycast computes boundingSphere lazily ONCE and
                // never invalidates it; since we repack matrices/counts every
                // frame, a stale sphere makes editor click-raycasts miss any
                // instance outside the first-computed sphere (LOD 1+ meshes
                // start at count 0, so they were never clickable at all).
                // Invalidate so each raycast recomputes from current instances.
                mesh.boundingSphere = null;
            }
            if (shadowMesh) {
                shadowMesh.count = shadowCount;
                shadowMesh.instanceMatrix.needsUpdate = true;
                shadowMesh.boundingSphere = null;
            }
        }
    }

    /**
     * Enable or disable visibility culling for environment objects.
     * NOTE: Only effective in unpacked (editor) mode. Packed mode uses world-spanning InstancedMesh.
     */
    setCullingEnabled(enabled: boolean): void {
        this.cullingEnabled = enabled;
        if (!enabled) {
            // Show all objects when culling is disabled
            for (const [, storage] of this.objectStorage) {
                if (storage.instancedMesh) {
                    storage.instancedMesh.visible = true;
                }
                for (const mesh of storage.unpackedMeshes) {
                    mesh.visible = true;
                }
            }
        }
    }
    
    /**
     * Check if visibility culling is enabled.
     */
    isCullingEnabled(): boolean {
        return this.cullingEnabled;
    }
    
    /**
     * Draw only the placed objects whose bounds touch `region` (world space);
     * `null` draws them all again. Render-only — their colliders stay. The
     * placed-object counterpart of `VxlSceneTerrainSystem.setRenderRegion`: a
     * forged ship sailing open water (`engine/sailing/`) clips both, since a prop
     * on the forged coast could no more move than the coast could.
     */
    setRenderRegion(region: THREE.Box3 | null): void {
        this.renderRegion = region ? region.clone() : null;
    }

    /**
     * Set the maximum render distance for environment object visibility.
     * @param distance Distance in meters (default: 150)
     */
    setMaxRenderDistance(distance: number): void {
        // The tier's scale is applied HERE rather than at each caller so every path into
        // this setter — the genre's fog config, a live edit, a level's overrides — gets it,
        // and so the fade band below stays derived from the distance actually used.
        this.requestedRenderDistance = distance;
        this.maxRenderDistance = distance * activeQualityPolicy().live.envRenderDistanceScale;
        // Keep the env-object dissolve band just inside the cull so buildings fade
        // into the sky before they are hard-culled (shared across all faded materials).
        setEnvFadeBand(computeEnvFadeBand(this.maxRenderDistance));
    }

    /**
     * Re-derive the effective render distance after the quality tier changed mid-session.
     * Re-runs the setter with the ORIGINAL request, so the scale applies once however many
     * times the tier moves.
     */
    reapplyQualityScale(): void {
        this.setMaxRenderDistance(this.requestedRenderDistance);
    }

    /** The distance-fading equivalent of an env LOD material (cached, source-preserving). */
    /**
     * Distance-fading equivalent of a template mesh's material.
     *
     * Handles the ARRAY case: a voxel asset with material slots renders as
     * `[base, ...slots]` over matching geometry groups. That array used to be
     * cast to a single `THREE.Material` and handed to `createFadedEnvMaterial`,
     * whose property reads (`map`, `color`, `vertexColors`) all came back
     * undefined — so every placed instance of a slotted asset drew flat white
     * with no glow, while the same asset looked right in the voxel editor
     * (which uses the object's own mesh and its real material array).
     */
    private fadedMaterial(source: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
        if (Array.isArray(source)) return source.map((m) => this.fadedMaterialOne(m));
        return this.fadedMaterialOne(source);
    }

    private fadedMaterialOne(source: THREE.Material): THREE.Material {
        let faded = this.fadedMaterialCache.get(source);
        if (!faded) { faded = createFadedEnvMaterial(source); this.fadedMaterialCache.set(source, faded); }
        return faded;
    }
    
    /**
     * Get the current maximum render distance.
     */
    getMaxRenderDistance(): number {
        return this.maxRenderDistance;
    }
    
    /**
     * Update environment object visibility based on camera position and frustum.
     * NOTE: Only effective in unpacked (editor) mode.
     * 
     * @param camera The camera to cull against
     */
    updateVisibility(camera: THREE.Camera): void {
        if (!this.cullingEnabled) return;
        
        // No types unpacked → nothing to cull here (the packed InstancedMesh / LOD
        // path spans the world and is handled by updateInstanceCulling instead).
        if (this.unpackedTypes.size === 0) {
            return;
        }
        
        // Ensure camera matrices are up to date
        camera.updateMatrixWorld();
        
        // Update frustum from camera matrices
        this.cullingMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.cullingFrustum.setFromProjectionMatrix(this.cullingMatrix);
        
        const cameraPos = camera.position;

        // Unpacked mode: cull individual meshes
        for (const [, storage] of this.objectStorage) {
            for (const mesh of storage.unpackedMeshes) {
                // Frustum check uses the bounding sphere; compute it up front so
                // the distance cull can also measure to the sphere SURFACE — a
                // long object (bridge) stays visible while the camera is near
                // either end even though its origin is far away.
                if (!mesh.geometry.boundingSphere) {
                    mesh.geometry.computeBoundingSphere();
                }
                const bs = mesh.geometry.boundingSphere;
                const radius = bs ? bs.radius : 0;

                const meshPos = mesh.position;
                const dx = meshPos.x - cameraPos.x;
                const dz = meshPos.z - cameraPos.z;
                const distSq = dx * dx + dz * dz;
                const reach = this.maxRenderDistance + radius;

                if (distSq > reach * reach) {
                    mesh.visible = false;
                    continue;
                }
                if (this.renderRegion) {
                    this.instanceSphereScratch.set(meshPos, radius);
                    if (!this.renderRegion.intersectsSphere(this.instanceSphereScratch)) {
                        mesh.visible = false;
                        continue;
                    }
                }

                if (bs) {
                    const worldCenter = bs.center.clone().applyMatrix4(mesh.matrixWorld);
                    mesh.visible = this.cullingFrustum.intersectsSphere(new THREE.Sphere(worldCenter, bs.radius));
                } else {
                    mesh.visible = true;
                }
            }
        }
    }
    
    // ==================== CHUNK-BASED VISIBILITY ====================
    
    /**
     * Set the voxel size for chunk calculations.
     */
    setVoxelSize(size: number): void {
        this.voxelSize = size;
    }
    
    /**
     * Set reference to VoxelTerrainSystem for terrain flattening operations
     */
    setVoxelTerrainSystem(voxelTerrainSystem: any): void {
        this.voxelTerrainSystem = voxelTerrainSystem;
    }

    /**
     * @deprecated The engine reference is now installed by GameEngine via the
     * module-level `setEnvironmentObjectSystemEngine()` — templates and work
     * folders no longer need to wire it. This shim exists so pre-existing
     * work-folder WorldGenerator.ts files (which still contain a
     * `this.environmentObjectSystem.setEngine(this.engine)` call from when
     * the public method existed) keep loading after the migration. Do not
     * call from new code.
     */
    setEngine(engine: any): void {
        setEnvironmentObjectSystemEngine(engine);
    }

    /**
     * Convert world position to chunk key (2D, ignoring Y).
     */
    private getChunkKey(worldX: number, worldZ: number): string {
        const chunkWorldSize = CHUNK_SIZE * this.voxelSize;
        const halfWorld = this.worldSize / 2;
        const cx = Math.floor((worldX + halfWorld) / chunkWorldSize);
        const cz = Math.floor((worldZ + halfWorld) / chunkWorldSize);
        return `${cx},${cz}`;
    }

    /**
     * Add a per-chunk InstancedMesh to the scene and record it in `chunkMeshes`.
     * Parented to the terrain chunk when a chunk-parent provider is installed
     * (so it inherits chunk visibility automatically), otherwise to
     * `fallbackParent`.
     */
    private attachChunkMesh(typeName: string, chunkKey: string, chunkMesh: THREE.InstancedMesh, fallbackParent: THREE.Object3D): void {
        (this.getChunkParent?.(chunkKey) ?? fallbackParent).add(chunkMesh);
        getOrCreate(this.chunkMeshes, chunkKey, () => new Map()).set(typeName, chunkMesh);
    }

    /**
     * Bucket one physics body under the chunk covering (x, z), so chunk
     * hibernation can toggle it and the level teardown can find it.
     */
    private trackPhysicsBodyInChunk(body: RAPIER.RigidBody, x: number, z: number): void {
        getOrCreate(this.chunkPhysicsBodies, this.getChunkKey(x, z), () => []).push(body);
    }

    /**
     * Track physics bodies added since prevBodyCount, grouping by chunk based on position.
     */
    private trackNewPhysicsBodiesByChunk(prevBodyCount: number): void {
        for (let i = prevBodyCount; i < this.worldBodies.length; i++) {
            const body = this.worldBodies[i];
            if (!body) continue;

            // Get body position (Rapier rigid body has translation() method)
            const pos = typeof body.translation === 'function' ? body.translation() : { x: 0, z: 0 };
            this.trackPhysicsBodyInChunk(body, pos.x, pos.z);
        }
    }
    
    /**
     * Enable or disable physics for all environment objects in a chunk.
     * Called when chunk physics state changes (hibernation).
     */
    setChunkPhysicsEnabled(chunkKey: string, enabled: boolean): void {
        const bodies = this.chunkPhysicsBodies.get(chunkKey);
        if (!bodies) return;

        // Prune bodies removed since they were tracked BEFORE toggling: Rapier
        // reuses handles, so a stale entry either traps the WASM module or
        // silently hibernates whatever body inherited its handle.
        const live = bodies.filter((body) => body?.isValid());
        if (live.length !== bodies.length) this.chunkPhysicsBodies.set(chunkKey, live);

        // Rapier's setEnabled hibernates/wakes a body.
        for (const body of live) body.setEnabled(enabled);
    }
    
    // ==================== END VISIBILITY CULLING ====================
}

