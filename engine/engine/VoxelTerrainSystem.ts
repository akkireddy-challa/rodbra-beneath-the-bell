import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { EngineLike } from 'types/game.js';
import type { TerrainTypeRegistry } from 'engine/TerrainTypes.js';
import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';
import { VoxelWorld } from 'engine/VoxelWorld.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { BlockType, type BlockTypeId } from 'engine/VoxelTextureAtlas.js';
import type { VoxelFoliageSystem, FoliageExclusionRect } from 'engine/VoxelFoliageSystem.js';
import { BuildingFoundationRegistry, DEFAULT_BUILDING_FOUNDATION_OPTIONS, type BuildingFoundationOptions } from 'engine/VoxelBuildingFoundation.js';
import type { EnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';
import { ChunkPhysicsManager, type ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import { uploadFile } from 'engine/StorageUploadUtil.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import { createPhysicsSpawnFinder } from 'engine/bakedSpawnResolver.js';
import { VoxelNavMesh, setGlobalNavMesh, type BuildOptions as NavMeshBuildOptions } from 'engine/VoxelNavMesh.js';
import { DeterministicDestruction, type DeterministicExplosionParams } from 'engine/DeterministicDestruction.js';
import { fpToFloat } from 'engine/FixedPointMath.js';
import type { PhysicsWorld as PhysicsWorldType } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics, queryPhysicsFor } from 'engine/physics/PlaneLockedPhysics.js';
import { VoxelTerrain2DBridge, DEFAULT_TERRAIN_FRICTION_2D } from 'engine/physics/VoxelTerrain2DBridge.js';

// Re-export ChunkManagedObject for consumers
export type { ChunkManagedObject };

/** Type alias for VoxelWorld debris return type */
type VoxelDebris = { body: RAPIER.RigidBody; collider: RAPIER.Collider };

/**
 * Spawn validation (findValidVoxelSpawnPosition): placed environment objects with an
 * occupancy radius above this are enclosure-scale structures (colosseum, stadium,
 * walled fort placed as ONE asset) whose bounding-box disc covers their own playable
 * interior. They're skipped in the occupancy gate and validated per-column by the
 * surface-height check instead. Props and trees stay well under this.
 */
const SPAWN_OCCUPANCY_MAX_OBJECT_RADIUS = 8;

/**
 * Spawn validation: max height (m) a spawn surface may sit above the underlying
 * terrain before the position is rejected as "on top of a building". Walkable
 * elevated floors — arena slabs, podiums, platforms — commonly sit 1–2m above
 * terrain (an AI-generated colosseum floor measures 1.3m); roofs of real
 * buildings start well above 2m.
 */
const MAX_SPAWN_SURFACE_ELEVATION = 2.0;

/**
 * Default terrain Y bounds (meters) used both to size a freshly initialized
 * VoxelWorld and as the fallback floor/ceiling for grid scans when a world's
 * own bounds are unavailable. minY allows terrain below sea level; maxY caps
 * the tallest terrain. Keeping both in one place ensures the scan fallbacks
 * mirror the bounds the world is actually built with.
 */
const TERRAIN_DEFAULT_MIN_Y = -20;
const TERRAIN_DEFAULT_MAX_Y = 100;

/**
 * Number of solid blocks placed beneath a surface block (Minecraft-style depth)
 * when generating or flattening terrain — e.g. grass over dirt. Shared so the
 * generate and flatten paths always bury the same depth.
 *
 * This is a count of BLOCKS, not a distance: the physical thickness is
 * `UNDERGROUND_FILL_DEPTH * voxelBlockSize`, so it scales with the world's voxel
 * size. At the default 1 m that is 3 m of fill (a 4 m shell including the surface
 * block); at `worldProfileData.voxelBlockSize: 0.5` it is 1.5 m (a 2 m shell).
 * Deliberate — filling a fixed metre depth would cost proportionally more
 * setBlock calls at small voxel sizes, on top of the extra columns those already
 * add.
 *
 * What matters when tuning it: **below the fill is air, not stone.** The fill is
 * the terrain's entire structure, not just a material layer over something solid.
 * Two consequences:
 *   - Neighbouring columns whose surfaces differ by more than this depth leave a
 *     gap of air visible in the exposed face. Since the depth is in blocks, that
 *     threshold shrinks with voxelBlockSize — a cliff that looks solid at 1 m can
 *     show holes at 0.25 m.
 *   - Flat worlds never expose it (no height steps, and nothing sees under the
 *     slab), which is the usual reason to lower voxelBlockSize in the first place.
 *
 * `genres/voxel/WorldGenerator.ts` keeps its own `fillDepth` for procedural
 * generation and does NOT read this constant — that path is per-game template code.
 * Keep the two in step, or generated and flattened terrain bury to different depths.
 */
const UNDERGROUND_FILL_DEPTH = 3;

/**
 * How far (meters) above a surface block the flatten paths look for blocks that
 * sit on top of it — overhangs and hillside above the target height. `isAreaFlat`
 * uses it to detect them, `flattenArea` to clear them, so an area reported flat
 * is exactly one flatten pass leaves behind.
 */
const MAX_OVERHANG_SCAN_HEIGHT = 50;

/**
 * Visit the Y levels buried below a surface block at `surfaceY`, top-down,
 * stopping at the world floor. Shared by the generate and flatten paths so both
 * bury `UNDERGROUND_FILL_DEPTH` blocks at exactly the same levels.
 */
function forEachUndergroundY(surfaceY: number, blockSize: number, minY: number, visit: (y: number) => void): void {
    for (let d = 1; d <= UNDERGROUND_FILL_DEPTH; d++) {
        const belowY = surfaceY - d * blockSize;
        if (belowY >= minY) visit(belowY);
    }
}

/**
 * Configuration for voxel terrain rendering.
 */
export interface VoxelTerrainConfig {
    /**
     * Size of each voxel block in meters (default: 1)
     */
    blockSize?: number;

    /**
     * Material properties for voxel blocks
     */
    material?: {
        roughness?: number;
        metalness?: number;
    };

    /**
     * Physics properties for voxel terrain
     */
    physics?: {
        friction?: number;
        restitution?: number;
    };
}

/**
 * VoxelTerrainSystem generates terrain as discrete voxel blocks based on heightmap data.
 * 
 * Uses the existing VoxelWorld system for proper voxel rendering with correct face winding,
 * greedy meshing optimization, and physics integration.
 */
export class VoxelTerrainSystem {
    private world: THREE.Object3D;
    private engine: EngineLike | null;
    private terrainHeightProvider: TerrainHeightProvider;
    private terrainRegistry: TerrainTypeRegistry;

    private voxelWorld: VoxelWorld | null = null;
    private foliageSystem: VoxelFoliageSystem | null = null;
    private environmentObjectSystem: EnvironmentObjectSystem | null = null;
    private chunkPhysicsManager: ChunkPhysicsManager | null = null;
    /** 2D-physics lane: the Rapier 2D colliders of `voxelWorld` (null on the 3D lane). */
    private terrain2D: VoxelTerrain2DBridge | null = null;

    /** True when terrain was loaded as a VoxelObject (v2 octree fallback) instead of VoxelWorld chunks */
    public loadedAsVoxelObject = false;

    // Configuration
    private blockSize: number;
    private worldSizeX: number;
    private worldSizeZ: number;
    
    // Custom terrain-to-block mappings (set by template code)
    private customTerrainMapping: Map<number, number> = new Map();
    // Underground block mappings (surface block -> underground block)
    private undergroundMapping: Map<number, number> = new Map();
    
    // Track if terrain colliders need a physics step before raycasts are reliable
    // This prevents getHeightAt from using stale physics data after terrain rebuild
    private collidersAwaitingPhysicsStep: boolean = false;
    private postStepCallback: (() => void) | null = null;
    
    // Stored terrain type resolver for automatic foliage regeneration after deferred build
    private terrainTypeResolver: ((blockType: number) => number) | null = null;
    // Callback fired when deferred chunk building completes
    private onDeferredBuildCompleteCallback: (() => void) | null = null;
    // Queue for deferred per-frame foliage generation after chunk building completes
    private deferredFoliageKeys: string[] | null = null;
    // Guard: skip automatic update() when processDeferredWork() was called this frame
    private deferredWorkProcessedThisFrame = false;

    // Snapshots of original terrain blocks before flattening, keyed by objectId
    // Used to restore terrain when unflattenArea() is called
    private flattenSnapshots: Map<string, Array<{x: number, y: number, z: number, block: number}>> = new Map();
    private readonly foundations = new BuildingFoundationRegistry(this, () => this.foliageSystem, () => this.terrainTypeResolver);

    // VoxelNavMesh for efficient NPC pathfinding (MinHeap A*)
    private navMesh: VoxelNavMesh | null = null;
    // Options applied every time the navmesh is (re)built. Empty = engine
    // defaults (1.0 m cells, 0.4 m agent radius). Set via setNavMeshResolution().
    private navMeshBuildOptions: NavMeshBuildOptions = {};

    constructor(
        world: THREE.Object3D,
        engine: EngineLike | null,
        terrainHeightProvider: TerrainHeightProvider,
        terrainRegistry: TerrainTypeRegistry,
        worldSizeX: number,
        worldSizeZ: number,
        config?: VoxelTerrainConfig
    ) {
        this.world = world;
        this.engine = engine;
        this.terrainHeightProvider = terrainHeightProvider;
        this.terrainRegistry = terrainRegistry;
        this.worldSizeX = worldSizeX;
        this.worldSizeZ = worldSizeZ;

        // Apply config with defaults
        this.blockSize = config?.blockSize ?? 1;

        console.log(`[VoxelTerrainSystem] Initialized with block size: ${this.blockSize}m, world: ${worldSizeX}x${worldSizeZ}m`);
    }

    /**
     * Set a custom terrain-to-block mapping.
     * Call this from template code to map terrain types to custom block types.
     * 
     * @param terrainTypeId - The terrain type ID (from TerrainTypeRegistry)
     * @param blockTypeId - The block type ID (from BlockType or custom ID)
     * 
     * Example from WorldGenerator.ts:
     */
    setTerrainBlockMapping(terrainTypeId: number, blockTypeId: number): void {
        this.customTerrainMapping.set(terrainTypeId, blockTypeId);
    }
    
    /**
     * Set what block type appears underground below a surface block type.
     * For example, grass typically has dirt underneath.
     * 
     * @param surfaceBlockId - The surface block type ID
     * @param undergroundBlockId - The block type to use underground
     */
    setUndergroundBlockMapping(surfaceBlockId: number, undergroundBlockId: number): void {
        this.undergroundMapping.set(surfaceBlockId, undergroundBlockId);
    }

    /**
     * Load terrain from a VXL file URL.
     * Returns true if loaded successfully, false otherwise.
     */
    async loadFromUrl(url: string): Promise<boolean> {
        console.log(`[VoxelTerrainSystem] Loading voxel terrain from URL: ${url}`);

        try {
            const response = await fetch(ASSET_MAP.get(url) ?? url);
            if (!response.ok) {
                console.error(`[VoxelTerrainSystem] Failed to fetch VXL: ${response.status} ${response.statusText}`);
                return false;
            }

            const buffer = await response.arrayBuffer();
            
            // Create VoxelWorld if not exists
            if (!this.voxelWorld) {
                this.voxelWorld = this.createVoxelWorld();
            }

            // Load the VXL data
            const metadata = await this.voxelWorld.loadFromFile(buffer);
            
            // Apply metadata
            if (metadata.voxelSize) {
                this.blockSize = metadata.voxelSize;
            }
            if (metadata.bounds) {
                this.voxelWorld.setBounds(metadata.bounds);
            }

            // Verify data was actually loaded (VoxelWorld silently skips v2 octree files)
            if (this.voxelWorld.getChunkCount() === 0) {
                console.log(`[VoxelTerrainSystem] VXL is v2 octree format — loading as VoxelObject`);
                return this.loadAsVoxelObject(buffer);
            }

            // NOTE: Mesh building is deferred - caller should call finalizeTerrain() after configuring smooth surfaces
            console.log(`[VoxelTerrainSystem] ✅ Loaded terrain data from VXL (${this.voxelWorld.getChunkCount()} chunks), awaiting finalization`);
            return true;
        } catch (error) {
            console.error('[VoxelTerrainSystem] Failed to load VXL:', error);
            return false;
        }
    }

    /**
     * Fallback: load a v2 octree VXL file as a VoxelObject (not VoxelWorld).
     * VoxelObject supports v2 octree with full rendering and physics colliders.
     */
    private async loadAsVoxelObject(buffer: ArrayBuffer): Promise<boolean> {
        try {
            // No metadata peek: the VXL3 header carries `useAtlas` and the voxel size,
            // and `loadFromFile` applies both over whatever is passed here — see
            // engine/__tests__/NoWholeBufferJsonPeek.test.ts.
            const mapObject = new VoxelObject({
                voxelSize: 0.5,
                useAtlas: true,
                shadows: true
            });
            await mapObject.loadFromFile(buffer);

            // Position the VoxelObject so the mesh geometry aligns with origin.
            // The octree leaf coordinates may not be centered at the bounds —
            // compute the offset between geometry center and bounds center.
            const mapMesh = mapObject.getMesh();
            const mapBounds = mapObject.getBounds();
            if (mapMesh && mapBounds) {
                mapMesh.geometry.computeBoundingBox();
                const geoBB = mapMesh.geometry.boundingBox!;
                // Offset = where bounds say center should be - where geometry actually is
                const offsetX = (mapBounds.minX + mapBounds.maxX) / 2 - (geoBB.min.x + geoBB.max.x) / 2;
                const offsetY = (mapBounds.minY + mapBounds.maxY) / 2 - (geoBB.min.y + geoBB.max.y) / 2;
                const offsetZ = (mapBounds.minZ + mapBounds.maxZ) / 2 - (geoBB.min.z + geoBB.max.z) / 2;
                mapObject.position.set(offsetX, offsetY, offsetZ);
                console.log(`  [VoxelTerrainSystem] Map position offset: (${offsetX.toFixed(1)}, ${offsetY.toFixed(1)}, ${offsetZ.toFixed(1)})`);
            } else {
                mapObject.position.set(0, 0, 0);
            }
            this.world.add(mapObject);

            this.loadedAsVoxelObject = true;

            // Create physics colliders using VoxelObject's own system.
            // Start with colliders DISABLED — they'll be enabled after player spawns
            // to prevent Rapier from pushing the player out of solid blocks.
            if (this.engine?.physicsWorld) {
                // Register the baked level map as TERRAIN (not ENVIRONMENT) so spawn
                // detection can separate the walkable ground from placed buildings/props.
                mapObject.createPhysicsBody(this.engine.physicsWorld, { asTerrain: true });

                // Disable all map colliders initially
                const mapBody = mapObject.getRigidBody();
                if (mapBody) {
                    const numColliders = mapBody.numColliders();
                    for (let i = 0; i < numColliders; i++) {
                        mapBody.collider(i).setEnabled(false);
                    }
                    console.log(`[VoxelTerrainSystem] Map colliders created but disabled (${numColliders} colliders)`);

                    // Re-enable after 15 frames (player will be spawned and positioned by then)
                    let frame = 0;
                    const enableColliders = () => {
                        if (++frame < 15) { requestAnimationFrame(enableColliders); return; }
                        if (mapBody.isValid()) {
                            for (let i = 0; i < numColliders; i++) {
                                mapBody.collider(i).setEnabled(true);
                            }
                        }
                        console.log(`[VoxelTerrainSystem] Map colliders enabled (frame ${frame})`);
                    };
                    requestAnimationFrame(enableColliders);
                }

                this.engine.physicsWorld.step(1 / 60);
            }

            // Provide a spawn-position resolver for v2-octree maps. These render as a
            // VoxelObject and expose no per-voxel grid to query, so the surface is
            // resolved with downward physics raycasts against the map colliders — the
            // shared finder in bakedSpawnResolver.ts (also used by mesh levels).
            if (this.engine) {
                this.engine.findValidVoxelSpawnPosition = createPhysicsSpawnFinder(this.engine, mapBounds, { requireHeadroom: false });
            }

            console.log(`[VoxelTerrainSystem] ✅ Loaded VXL as VoxelObject (voxelSize=${mapObject.getVoxelSize()}, useAtlas=${mapObject.useAtlas})`);
            return true;
        } catch (err) {
            console.error(`[VoxelTerrainSystem] VoxelObject fallback failed:`, err);
            return false;
        }
    }

    /**
     * Save terrain to S3 and return the URL.
     * Uses presigned URL for direct S3 upload.
     */
    async saveToS3(gameId: string): Promise<string | null> {
        if (!this.voxelWorld || this.voxelWorld.getChunkCount() === 0) {
            console.warn('[VoxelTerrainSystem] No voxels to save');
            return null;
        }

        const timestamp = Date.now();
        const vxlFilename = `${gameId}-terrain-${timestamp}.vxl`;

        try {
            const bounds = this.voxelWorld.getBounds();
            const fileContent = await this.voxelWorld.saveToFile(vxlFilename, {
                voxelSize: this.blockSize,
                bounds: bounds || undefined
            });

            // Upload directly to S3 using presigned URL (noCache for frequently updated voxel files)
            const s3Url = await uploadFile(fileContent, vxlFilename, {
                contentType: 'application/octet-stream',
                gameId,
                noCache: true
            });

            if (!s3Url) {
                console.error('[VoxelTerrainSystem] Failed to upload terrain to S3');
                return null;
            }

            // Note: world.json update is handled by creator via TERRAIN_SAVED_INTERNAL message
            // This ensures proper edit history tracking with session IDs

            console.log(`[VoxelTerrainSystem] ✅ Saved terrain to S3: ${s3Url}`);
            return s3Url;
        } catch (error) {
            console.error('[VoxelTerrainSystem] Error saving terrain:', error);
            return null;
        }
    }

    /**
     * The terrain VoxelWorld for whichever physics lane the engine runs.
     * 3D: chunks build their own Rapier 3D colliders. 2D: the world gets no 3D
     * physics (it still meshes), and a `VoxelTerrain2DBridge` rebuilds the 2D
     * colliders of every chunk the world re-meshes (engine/physics/VoxelTerrain2DBridge.ts).
     * No physics at all: meshes only.
     */
    private createVoxelWorld(): VoxelWorld {
        // On the 2D lane `engine.physicsWorld` is the plane-locked facade; VoxelWorld
        // must not build 3D colliders against it — the bridge below owns collision.
        const enginePhysics = this.engine?.physicsWorld ?? null;
        const facade = isPlaneLockedPhysics(enginePhysics) ? enginePhysics : null;
        const physicsWorld = facade ? null : enginePhysics;
        const world2D = physicsWorld ? null : (this.engine?.physicsWorld2D ?? null);
        this.terrain2D?.dispose();
        this.terrain2D = null;
        const options = {
            voxelSize: this.blockSize,
            generateNormals: true,   // Enable per-face normals for shadow casting/receiving
            materialType: 'atlas' as const,   // Texture atlas (more efficient, proper shadow support)
            skipShadowMesh: true,    // Skip expensive global shadow mesh - terrain chunks handle their own shadows
        };
        if (!world2D) {
            if (!physicsWorld) console.warn('[VoxelTerrainSystem] No physics world — terrain will render without collision');
            return new VoxelWorld(physicsWorld, this.world as THREE.Scene, options);
        }
        const atlas = getVoxelTextureAtlas();
        const bridgeHolder: { bridge: VoxelTerrain2DBridge | null } = { bridge: null };
        const voxelWorld = new VoxelWorld(null, this.world as THREE.Scene, {
            ...options,
            onChunkPhysicsRebuilt: (key, boxes, cx, cy, cz) => bridgeHolder.bridge?.onChunkRebuilt(key, boxes, cx, cy, cz),
        });
        bridgeHolder.bridge = new VoxelTerrain2DBridge({
            world2D,
            grid: voxelWorld,
            planeZ: this.engine?.getGameplayPlaneZ?.() ?? 0,
            frictionForBlock: (blockType) => (blockType === undefined ? DEFAULT_TERRAIN_FRICTION_2D : atlas.getBlockGrip(blockType)),
            // Top-down: the chunks feed the facade's heightmap + cliff walls instead of a sliced silhouette.
            ground: facade?.ground ?? null,
        });
        this.terrain2D = bridgeHolder.bridge;
        return voxelWorld;
    }

    /**
     * Initialize VoxelWorld without generating any terrain.
     * Use this when you want to fill voxels directly without using heightmap-based generation.
     * 
     * After calling this, use getVoxelWorld().setBlock() to fill terrain, then call finalizeTerrain().
     */
    initializeVoxelWorld(): void {
        console.log('[VoxelTerrainSystem] Initializing empty VoxelWorld...');

        // Create VoxelWorld with texture atlas for Minecraft-like look
        this.voxelWorld = this.createVoxelWorld();

        // Calculate world bounds (centered at origin)
        const halfWorldX = this.worldSizeX / 2;
        const halfWorldZ = this.worldSizeZ / 2;

        // Set bounds for VoxelWorld coordinate mapping
        this.voxelWorld.setBounds({
            minX: -halfWorldX,
            minY: TERRAIN_DEFAULT_MIN_Y,
            minZ: -halfWorldZ,
            maxX: halfWorldX,
            maxY: TERRAIN_DEFAULT_MAX_Y,
            maxZ: halfWorldZ
        });

        console.log(`[VoxelTerrainSystem] VoxelWorld initialized (${this.worldSizeX}x${this.worldSizeZ}m, block size: ${this.blockSize}m)`);
    }

    /**
     * Generate the voxel terrain mesh based on heightmap data.
     * Uses VoxelWorld for proper voxel rendering with correct face winding.
     * 
     * NOTE: For direct voxel generation without heightmap, use initializeVoxelWorld() instead,
     * then fill voxels manually using getVoxelWorld().setBlock().
     */
    generateVoxelTerrain(): void {
        console.log('[VoxelTerrainSystem] Generating voxel terrain from heightmap...');

        // Initialize VoxelWorld if not already done
        if (!this.voxelWorld) {
            this.initializeVoxelWorld();
        }
        
        if (!this.voxelWorld) {
            console.error('[VoxelTerrainSystem] Failed to initialize VoxelWorld');
            return;
        }

        // Calculate world bounds (centered at origin)
        const halfWorldX = this.worldSizeX / 2;
        const halfWorldZ = this.worldSizeZ / 2;
        const minY = TERRAIN_DEFAULT_MIN_Y;
        const voxelWorld = this.voxelWorld;

        let totalBlocks = 0;

        // Iterate over world in block-sized steps
        for (let x = -halfWorldX; x < halfWorldX; x += this.blockSize) {
            for (let z = -halfWorldZ; z < halfWorldZ; z += this.blockSize) {
                // Get height at center of this block
                const sampleX = x + this.blockSize / 2;
                const sampleZ = z + this.blockSize / 2;
                const height = this.terrainHeightProvider.getHeightAt(sampleX, sampleZ);

                // Quantize height to voxel grid
                const quantizedHeight = Math.floor(height / this.blockSize) * this.blockSize;

                // Get terrain type and convert to block type
                const terrainType = this.terrainHeightProvider.getTerrainTypeAt(sampleX, sampleZ);
                const surfaceBlockType = this.terrainTypeToBlockType(terrainType);

                // Set the top surface block - pass block type directly
                voxelWorld.setBlock(x, quantizedHeight, z, surfaceBlockType);
                totalBlocks++;

                // Fill in blocks below the surface for depth
                // Minecraft-style: grass has dirt underneath, other types continue with same material
                const undergroundBlockType = this.getUndergroundBlockType(surfaceBlockType);

                forEachUndergroundY(quantizedHeight, this.blockSize, minY, belowY => {
                    voxelWorld.setBlock(x, belowY, z, undergroundBlockType);
                    totalBlocks++;
                });
            }
        }

        console.log(`[VoxelTerrainSystem] Set ${totalBlocks} voxel blocks`);

        // NOTE: Mesh building is deferred - caller should call finalizeTerrain() after configuring smooth surfaces
        console.log(`[VoxelTerrainSystem] Voxel terrain data generation complete (${voxelWorld.getChunkCount()} chunks), awaiting finalization`);
    }
    
    /**
     * Finalize terrain by building meshes and physics.
     * Call this AFTER configuring smooth surface settings on the VoxelWorld.
     */
    finalizeTerrain(): void {
        if (!this.voxelWorld) {
            console.warn('[VoxelTerrainSystem] Cannot finalize - VoxelWorld not initialized');
            return;
        }
        console.log('[VoxelTerrainSystem] Finalizing terrain (building meshes and physics)...');
        this.voxelWorld.updatePhysicsAndMeshing(true);
        this.voxelWorld.setChunksVisible(true);
        this.enableShadows();
        
        // Mark that colliders need a physics step before raycasts are reliable
        this.markCollidersAwaitingPhysicsStep();
        
        // Initialize chunk physics manager for large worlds
        this.initializeChunkPhysicsManager();

        // Build VoxelNavMesh for NPC pathfinding (MinHeap A*, replaces slow LegacyNavMesh)
        this.buildNavMesh();

        console.log(`[VoxelTerrainSystem] ✅ Terrain finalized (${this.voxelWorld.getChunkCount()} chunks)`);
    }
    
    /**
     * Finalize terrain with lazy generation - only build chunks within initial radius.
     * Remaining chunks are built progressively as player explores.
     * This dramatically speeds up initial load for large worlds.
     * 
     * @param spawnX Player spawn X position (world coordinates)
     * @param spawnZ Player spawn Z position (world coordinates)
     * @param initialRadius Radius around spawn to build immediately (default 150m)
     */
    finalizeTerrainLazy(spawnX: number, spawnZ: number, initialRadius: number = 150): void {
        if (!this.voxelWorld) {
            console.warn('[VoxelTerrainSystem] Cannot finalize - VoxelWorld not initialized');
            return;
        }
        console.log(`[VoxelTerrainSystem] Lazy finalize: building ${initialRadius}m radius around (${spawnX}, ${spawnZ})...`);

        const t0 = performance.now();
        this.voxelWorld.enableLazyGeneration();
        // Build per-block InstancedMeshes for every uniform-flat column BEFORE the per-chunk
        // mesh+physics pass. updateCollisionVisualization then skips chunks already covered.
        this.voxelWorld.buildUniformFlatInstancing();
        const t1 = performance.now();
        this.voxelWorld.updatePhysicsAndMeshingInRadius(spawnX, spawnZ, initialRadius);
        const t2 = performance.now();
        this.voxelWorld.setChunksVisible(true);
        const t3 = performance.now();
        this.enableShadows();
        const t4 = performance.now();
        // Mark that colliders need a physics step before raycasts are reliable
        this.markCollidersAwaitingPhysicsStep();
        const t5 = performance.now();
        // Initialize chunk physics manager for large worlds
        this.initializeChunkPhysicsManager();
        const t6 = performance.now();
        // Build VoxelNavMesh for NPC pathfinding (MinHeap A*, replaces slow LegacyNavMesh)
        this.buildNavMesh();
        const t7 = performance.now();

        const stats = this.voxelWorld.getLazyGenerationStats();
        console.log(`[VoxelTerrainSystem] ✅ Lazy finalize complete: ${stats.builtChunks} built, ${stats.pendingChunks} pending`);
        console.log(
            `[Timing][finalizeTerrainLazy] total=${(t7 - t0).toFixed(1)}ms ` +
            `enableLazy+instancing=${(t1 - t0).toFixed(1)} ` +
            `physMeshRadius=${(t2 - t1).toFixed(1)} ` +
            `setVisible=${(t3 - t2).toFixed(1)} ` +
            `shadows=${(t4 - t3).toFixed(1)} ` +
            `markColliders=${(t5 - t4).toFixed(1)} ` +
            `chunkPhysInit=${(t6 - t5).toFixed(1)} ` +
            `navmesh=${(t7 - t6).toFixed(1)}ms ` +
            `(chunks: built=${stats.builtChunks} pending=${stats.pendingChunks})`
        );
        this.voxelWorld.logFillChunkFlatStats();
    }


    /**
     * Build VoxelNavMesh from the current voxel world for NPC pathfinding.
     * Uses MinHeap-based A* which is much faster than the fallback LegacyNavMesh.
     * Automatically registers as the global nav mesh so all NPCs use it.
     */
    private buildNavMesh(): void {
        if (!this.voxelWorld) return;
        const t = performance.now();
        const halfX = this.worldSizeX / 2;
        const halfZ = this.worldSizeZ / 2;
        const previous = this.navMesh;
        this.navMesh = new VoxelNavMesh();
        this.navMesh.buildFromVoxelWorld(this.voxelWorld, -halfX, halfX, -halfZ, halfZ, this.navMeshBuildOptions);
        // setGlobalNavMesh re-attaches every registered obstacle provider
        // (crates via VoxelObject, env objects) to the new instance, so dynamic
        // obstacles survive the rebuild. Dispose the old instance only AFTER the
        // providers have migrated off it.
        setGlobalNavMesh(this.navMesh);
        if (previous) previous.dispose();
        console.log(`[VoxelTerrainSystem] VoxelNavMesh built in ${(performance.now() - t).toFixed(1)}ms`);
    }

    /**
     * Change the navigation-mesh resolution (and optionally the agent radius)
     * and rebuild the navmesh immediately so the new grid is live.
     *
     * `cellSize` is the side length of each navigation cell in meters and
     * defaults to 1.0 (one voxel). Finer values (0.5, 0.25, 0.125) let NPCs
     * path and stop far more precisely — e.g. walk to an exact spot or thread
     * between small obstacles — at the cost of memory, which scales with
     * ~1/cellSize² per dense chunk (0.125 m ≈ 64× the cells of 1.0 m). Pick the
     * coarsest value that looks right; 0.25–0.5 m is plenty for most games.
     *
     * Call this once after world generation (e.g. in your Game setup, after
     * `getVoxelTerrainSystem()` is available). Safe to call before terrain is
     * built — the options are stored and applied on the next build.
     *
     * @param options.cellSize    Cell size in meters (default 1.0)
     * @param options.agentRadius Capsule radius for obstacle inflation (default 0.4 m)
     */
    setNavMeshResolution(options: NavMeshBuildOptions): void {
        this.navMeshBuildOptions = { ...this.navMeshBuildOptions, ...options };
        // Rebuild now if terrain already exists; otherwise the stored options
        // are picked up by the build that runs at terrain finalization.
        if (this.voxelWorld) this.buildNavMesh();
    }

    /** Current navmesh build options (cellSize / agentRadius). */
    getNavMeshResolution(): NavMeshBuildOptions {
        return { ...this.navMeshBuildOptions };
    }

    /**
     * Build pending chunks near the player position.
     * Call this every frame from the game update loop.
     * 
     * @param playerX Player world X position
     * @param playerZ Player world Z position
     * @param maxChunks Max chunks to build per frame (1-2 recommended)
     * @param buildRadius Only build chunks within this radius
     */
    buildPendingChunksNear(playerX: number, playerZ: number, maxChunks: number = 1, buildRadius: number = 200): void {
        if (!this.voxelWorld) return;
        this.voxelWorld.buildPendingChunksNear(playerX, playerZ, maxChunks, buildRadius);
    }
    
    /**
     * Get lazy generation statistics.
     */
    getLazyGenerationStats(): { builtChunks: number; pendingChunks: number; totalChunks: number } | null {
        return this.voxelWorld?.getLazyGenerationStats() ?? null;
    }
    
    /**
     * Check if all chunks have been built.
     */
    isLazyGenerationComplete(): boolean {
        return this.voxelWorld?.isLazyGenerationComplete() ?? true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LEVEL GENERATION API
    // AI AGENTS: Use these methods when building levels with procedural
    // terrain. beginLevelGeneration() suppresses expensive chunk rebuilds
    // during terrain construction. endLevelGeneration() defers all pending
    // chunks and builds only the player's corridor area immediately.
    // Remaining chunks are built automatically at 1/frame by update().
    // Foliage is auto-regenerated when all deferred chunks are built.
    //
    // Usage:
    //   const vt = worldGenerator.getVoxelTerrainSystem();
    //   vt.beginLevelGeneration();
    //   // ... clear terrain, generate terrain, carve trails, place decorations ...
    //   const result = vt.endLevelGeneration(corridorCenterX, corridorCenterZ, 40);
    //   // result.deferred chunks will be built automatically by update()
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Begin level generation phase. All chunk rebuilds are suppressed until
     * endLevelGeneration() is called. Use clearChunksInBounds() on the
     * VoxelWorld to efficiently clear terrain areas.
     *
     * AI AGENTS: Always call this before clearing/regenerating level terrain.
     */
    beginLevelGeneration(): void {
        this.voxelWorld?.beginLevelGeneration();
    }

    /**
     * End level generation phase. Builds corridor chunks immediately and
     * defers the rest for progressive per-frame building (handled by update()).
     * Foliage is automatically regenerated when all chunks are built.
     *
     * AI AGENTS: Call after all terrain modifications are complete.
     * @param corridorCenterX - X center of the corridor where the player spawns
     * @param corridorCenterZ - Z center of the corridor where the player spawns
     * @param corridorRadius - Radius around the corridor to build immediately (default 40)
     * @returns Object with count of built corridor chunks and deferred chunks.
     */
    endLevelGeneration(corridorCenterX: number, corridorCenterZ: number, corridorRadius: number = 40): { built: number; deferred: number } {
        if (!this.voxelWorld) return { built: 0, deferred: 0 };
        return this.voxelWorld.endLevelGeneration(corridorCenterX, corridorCenterZ, corridorRadius);
    }

    /** Register a callback to fire when deferred chunk building completes. */
    onDeferredBuildComplete(callback: () => void): void {
        this.onDeferredBuildCompleteCallback = callback;
    }

    /**
     * Whether deferred chunk building or foliage generation is still pending.
     * Use in the game update() to gate gameplay until terrain is fully ready.
     *
     * AI AGENTS: For games without a tunnel/corridor start where terrain must
     * be fully built before gameplay begins, use this with processDeferredWork():
     *   const vt = this.worldGenerator.getVoxelTerrainSystem();
     *   if (vt?.hasDeferredWork) { vt.processDeferredWork(); return; }
     */
    get hasDeferredWork(): boolean {
        return !!this.voxelWorld?.hasDeferredChunks()
            || (this.deferredFoliageKeys?.length ?? 0) > 0;
    }

    /**
     * Process deferred chunk building and foliage within a time budget.
     * Builds as many chunks and foliage as possible within budgetMs, then returns.
     * Call once per frame from the game update() to drain the deferred queue
     * as fast as possible while keeping the browser responsive.
     *
     * AI AGENTS: Use this in the game update() loop for games where terrain
     * must be fully built before gameplay starts (no tunnel/corridor start).
     * The default 200ms budget yields ~5fps during loading (fast processing).
     * Use a lower value for smoother visuals during loading, or higher to
     * finish faster. Returns true if more work remains.
     *
     * @param budgetMs - Maximum time to spend this frame (default 200ms).
     * @returns true if more deferred work remains, false if all done.
     */
    processDeferredWork(budgetMs: number = 200): boolean {
        this.deferredWorkProcessedThisFrame = true;
        const t0 = performance.now();

        // Process chunk building within budget
        while (this.voxelWorld?.hasDeferredChunks() && (performance.now() - t0) < budgetMs) {
            this.voxelWorld.tickDeferredBuild();
        }

        // Transition to foliage when all chunks are built
        if (!this.voxelWorld?.hasDeferredChunks() && !this.deferredFoliageKeys) {
            this.queueDeferredFoliage('processDeferredWork: chunks done');
        }

        // Process foliage within remaining budget
        this.drainDeferredFoliage(t0, budgetMs);

        return this.hasDeferredWork;
    }

    /**
     * Queue every chunk for foliage regeneration once its terrain is built.
     * No-op without a terrain-type resolver (no foliage was ever requested), so
     * callers must handle the "nothing queued" case themselves.
     * @returns true if chunks were queued.
     */
    private queueDeferredFoliage(reason: string): boolean {
        if (!this.terrainTypeResolver || !this.voxelWorld) return false;
        this.deferredFoliageKeys = [...this.voxelWorld.get2DChunkKeys()];
        console.log(`[VoxelTerrainSystem] ${reason} — queued ${this.deferredFoliageKeys.length} chunks for foliage`);
        return true;
    }

    /**
     * Drain the queued per-chunk foliage generation within a time budget
     * (measured from `t0`). Clears the queue and fires the deferred-build
     * completion callback once empty. No-op when no foliage is queued.
     */
    private drainDeferredFoliage(t0: number, budgetMs: number): void {
        if (!this.deferredFoliageKeys) return;
        while (this.deferredFoliageKeys.length > 0 && (performance.now() - t0) < budgetMs) {
            const key2D = this.deferredFoliageKeys.shift()!;
            if (this.terrainTypeResolver) {
                this.regenerateFoliageForChunk(key2D, this.terrainTypeResolver);
            }
        }
        if (this.deferredFoliageKeys.length === 0) {
            console.log('[VoxelTerrainSystem] Deferred foliage generation complete');
            this.deferredFoliageKeys = null;
            this.onDeferredBuildCompleteCallback?.();
        }
    }

    /**
     * Initialize chunk physics manager for large worlds.
     * Automatically enables/disables chunk colliders based on camera frustum visibility.
     * For top-down camera, this ensures chunks visible in the view have active physics.
     */
    private initializeChunkPhysicsManager(): void {
        if (!this.voxelWorld) {
            console.log('[VoxelTerrainSystem] ChunkPhysicsManager skipped: no voxelWorld');
            return;
        }
        
        const bounds = this.voxelWorld.getBounds();
        if (!bounds) {
            console.log('[VoxelTerrainSystem] ChunkPhysicsManager skipped: no bounds');
            return;
        }
        
        // Only enable for large worlds (same threshold as visibility culling: 64m)
        const worldSize = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
        if (worldSize < 64) {
            console.log(`[VoxelTerrainSystem] ChunkPhysicsManager skipped: world size ${worldSize}m < 64m threshold`);
            return;
        }
        
        const voxelSize = this.voxelWorld.getVoxelSize();
        this.chunkPhysicsManager = new ChunkPhysicsManager(voxelSize);
        
        this.chunkPhysicsManager.setBoundsOffset(bounds.minX, bounds.minZ);
        
        // Set physics distance same as render distance (fallback for distance-based updates)
        const physicsDistance = this.voxelWorld.getMaxRenderDistance();
        this.chunkPhysicsManager.setPhysicsDistance(physicsDistance);
        
        // Connect collider enable/disable callback (terrain + environment objects)
        this.chunkPhysicsManager.setChunkStateChangeCallback((chunkKey, enabled) => {
            this.voxelWorld?.setChunkCollidersEnabled(chunkKey, enabled);
            this.terrain2D?.setColumnEnabled(chunkKey, enabled);
            this.environmentObjectSystem?.setChunkPhysicsEnabled(chunkKey, enabled);
        });
        
        // Connect frustum-based visibility to physics activation
        // This makes physics follow camera view instead of just distance from player
        // Critical for top-down camera where view extends beyond player radius
        this.voxelWorld.setOnChunkVisibilityChanged((chunkKey2D, visible) => {
            this.chunkPhysicsManager?.setChunkActiveFromVisibility(chunkKey2D, visible);
        });
        
        // Initialize all chunks as active to prevent objects from falling through terrain
        // before visibility culling has a chance to run. Visibility updates will then
        // deactivate chunks that are out of view.
        const allChunkKeys = this.voxelWorld.get2DChunkKeys();
        const chunkKeySet = new Set(allChunkKeys);
        this.chunkPhysicsManager.initializeAllChunksActive(chunkKeySet);
        
        console.log(`[VoxelTerrainSystem] ChunkPhysicsManager initialized with frustum-based activation (worldSize=${worldSize}m, physicsDistance=${physicsDistance}m)`);
    }

    /**
     * @deprecated No longer mutates the spawn position. Kept as a no-op so any
     * stale callers (work-folder copies, custom templates, saved-game restores)
     * don't drag back the "scan-down for the topmost solid block" behaviour
     * that overwrote user-configured interior spawns with the roof Y. Spawn
     * clearing now happens in PlayerLoader.createPlayerPhysicsBody at spawn
     * time, in memory, and only when the configured pose actually overlaps a
     * collider — so the saved Y is preserved verbatim.
     */
    adjustSpawnPosition(_worldProfileData: { playerSpawnPosition: { x: number; y: number; z: number } }, _blockSize: number): void {
        // Intentionally empty.
    }

    /**
     * Convert terrain type ID to block type ID for procedural shader.
     *
     * First checks custom mappings set via setTerrainBlockMapping(),
     * then falls back to default BlockType constants.
     *
     * Template code should call setTerrainBlockMapping() for any terrain types
     * that need custom block textures (including standard types like SAND).
     */
    private terrainTypeToBlockType(terrainType: number): BlockTypeId {
        // All mappings must be provided by template via setTerrainBlockMapping()
        const mapped = this.customTerrainMapping.get(terrainType);
        if (mapped !== undefined) return mapped as BlockTypeId;

        // Fallback to BlockType.NONE if no mapping provided
        // Templates should call setTerrainBlockMapping() for all terrain types they use
        console.warn(`[VoxelTerrainSystem] No block mapping for terrain type ${terrainType}. Call setTerrainBlockMapping().`);
        return BlockType.NONE;
    }

    /**
     * Get the block type for underground blocks below a surface type.
     * Templates can configure this via setUndergroundBlockMapping().
     */
    private getUndergroundBlockType(surfaceBlockType: BlockTypeId): BlockTypeId {
        // Custom underground mapping if set, otherwise the same block continues underground
        return (this.undergroundMapping.get(surfaceBlockType) ?? surfaceBlockType) as BlockTypeId;
    }

    /**
     * Regenerate terrain after heightmap changes.
     */
    regenerateTerrain(): void {
        this.dispose();
        this.generateVoxelTerrain();
    }

    /**
     * Get the VoxelWorld instance for external access.
     */
    getVoxelWorld(): VoxelWorld | null {
        // When terrain was loaded as VoxelObject (v2 octree fallback),
        // the VoxelWorld exists but has 0 chunks — return null to prevent
        // callers from doing voxel queries against an empty world
        if (this.loadedAsVoxelObject) return null;
        return this.voxelWorld;
    }
    

    /**
     * Check if the chunk at the given world position has dirty (unbuilt) physics data.
     * Used by getHeightAt to decide whether to use voxel grid lookup instead of physics raycast.
     */
    isPositionChunkDirty(x: number, z: number): boolean {
        return this.voxelWorld?.isPositionChunkDirty(x, z) ?? false;
    }
    
    // Callbacks to invoke when colliders become ready
    private collidersReadyCallbacks: (() => void)[] = [];
    
    /**
     * Mark that terrain colliders need a physics step before raycasts are reliable.
     * Called internally after terrain is built/rebuilt. Templates should NOT call this.
     * 
     * This ensures getHeightAt uses voxel grid lookup until physics has stepped,
     * making height queries bullet-proof regardless of when they're called during
     * world generation.
     */
    markCollidersAwaitingPhysicsStep(): void {
        this.collidersAwaitingPhysicsStep = true;
        
        // Register callback to clear the flag after physics steps (once only) —
        // on whichever world steps this game (3D, or the 2D world behind the bridge).
        const stepper = this.engine?.physicsWorld ?? this.engine?.physicsWorld2D ?? null;
        if (!this.postStepCallback && stepper) {
            this.postStepCallback = () => {
                this.collidersAwaitingPhysicsStep = false;
                
                // Invoke all registered callbacks when colliders become ready
                const callbacks = [...this.collidersReadyCallbacks];
                this.collidersReadyCallbacks = [];
                for (const callback of callbacks) {
                    callback();
                }
                
                // Unregister after first call - we only need one step
                if (this.postStepCallback) {
                    stepper.unregisterPostStepCallback(this.postStepCallback);
                    this.postStepCallback = null;
                }
            };
            stepper.registerPostStepCallback(this.postStepCallback);
        }
    }
    
    /**
     * Check if terrain colliders are ready for physics queries.
     * Returns false if terrain was recently built but physics hasn't stepped yet.
     * Used by PlayerController to hold the player in place until ground is solid.
     */
    areCollidersReady(): boolean {
        return !this.collidersAwaitingPhysicsStep;
    }
    
    /**
     * Register a callback to be invoked when terrain colliders become ready.
     * If colliders are already ready, the callback is invoked immediately.
     * Used by DynamicObjectManager to release held physics when safe.
     */
    onCollidersReady(callback: () => void): void {
        if (this.areCollidersReady()) {
            callback();
        } else {
            this.collidersReadyCallbacks.push(callback);
        }
    }

    /**
     * Get surface height at world coordinates (terrain + buildings).
     * 
     * This is the authoritative height query method for all surfaces.
     * Uses physics raycast against TERRAIN and ENVIRONMENT collision groups.
     * Falls back to voxel grid lookup for terrain when terrain colliders are not ready.
     * 
     * IMPORTANT: Templates should use this method instead of implementing their own.
     * 
     * @param x World X coordinate
     * @param z World Z coordinate
     * @returns Height at the given position (top of terrain or building surface)
     */
    getHeightAt(x: number, z: number): number {
        const chunkIsDirty = this.isPositionChunkDirty(x, z);
        // Whichever world answers rays here: 3D, or the 2D world through its facade.
        const physicsWorld = queryPhysicsFor(this.engine);

        // IMPORTANT: If TERRAIN colliders were recently rebuilt but physics hasn't stepped yet,
        // those colliders aren't queryable. Use voxel grid for terrain height.
        // BUT: Building colliders (ENVIRONMENT) are separate and may already be ready!
        const terrainCollidersNotReady = this.collidersAwaitingPhysicsStep;

        // Fast path: if terrain chunk is clean AND terrain colliders are ready, use full raycast
        if (physicsWorld && !chunkIsDirty && !terrainCollidersNotReady) {
            const hitY = this.raycastSurfaceY(physicsWorld, x, z, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);
            if (hitY !== null) return hitY;
        }

        // Slow path: terrain chunk is dirty OR terrain colliders awaiting physics step
        // Use voxel grid for accurate terrain height (voxel grid = terrain only)
        if (!this.voxelWorld) {
            console.warn('[VoxelTerrainSystem] getHeightAt called before voxelWorld initialized');
            return 0;
        }

        // getTerrainOnlyHeight() reports the surface block's CENTRE, but the raycast fast
        // path above reports the block's walkable TOP (a voxel spans [base, base+blockSize),
        // so top = centre + blockSize/2). Convert, or getHeightAt() silently returns two
        // different answers for the same point depending on whether the chunk happens to be
        // dirty — and callers that place things on the surface bury them half a block deep.
        const terrainHeight = this.getTerrainOnlyHeight(x, z) + this.blockSize / 2;

        // ALWAYS raycast against ENVIRONMENT (buildings) - their colliders are independent
        // of terrain colliders and should be ready even when terrain isn't.
        // Return the higher of terrain or building height.
        if (physicsWorld) {
            const buildingY = this.raycastSurfaceY(physicsWorld, x, z, CollisionGroup.ENVIRONMENT);
            if (buildingY !== null && buildingY > terrainHeight) return buildingY;
        }

        return terrainHeight;
    }

    /**
     * Y where a ray straight down the (x, z) column first hits `collisionMask`,
     * or null for a miss. Starts high enough for 500m terrain and reaches -100m.
     */
    private raycastSurfaceY(physicsWorld: PhysicsWorldType, x: number, z: number, collisionMask: number): number | null {
        const result = physicsWorld.raycast(
            new THREE.Vector3(x, 500, z),
            new THREE.Vector3(0, -1, 0),
            600,
            collisionMask
        );
        return result.hasHit ? result.hitPoint.y : null;
    }

    /**
     * The voxel world's Y scan range, falling back to the defaults the world is
     * built with when it reports no bounds of its own.
     */
    private getScanRangeY(voxelWorld: VoxelWorld): { minY: number; maxY: number } {
        const bounds = voxelWorld.getBounds();
        return {
            minY: bounds?.minY ?? TERRAIN_DEFAULT_MIN_Y,
            maxY: bounds?.maxY ?? TERRAIN_DEFAULT_MAX_Y,
        };
    }

    /**
     * Y of the topmost non-air voxel in the (x, z) column, or null for an empty
     * column. The sample sits mid-voxel, matching the grid step it was found on.
     */
    private findTopmostSolidY(voxelWorld: VoxelWorld, x: number, z: number, step: number): number | null {
        const { minY, maxY } = this.getScanRangeY(voxelWorld);
        for (let y = maxY; y >= minY; y -= step) {
            if (voxelWorld.getBlock(x, y, z) !== 0) return y;
        }
        return null;
    }

    /**
     * Get terrain-only height at world coordinates (excludes buildings).
     *
     * Scans the voxel grid directly - the voxel grid contains ONLY terrain.
     * Buildings are separate VoxelObject instances on ENVIRONMENT collision layer.
     *
     * Used by spawn detection to compare with getHeightAt() - if they differ
     * significantly, there's a building at the position.
     *
     * @param x World X coordinate
     * @param z World Z coordinate
     * @returns Height of terrain only, or minY if no terrain found
     */
    getTerrainOnlyHeight(x: number, z: number): number {
        if (!this.voxelWorld) {
            return 0;
        }

        const blockSize = this.voxelWorld.getVoxelSize();

        // Scan voxel grid from top to bottom - voxel grid is terrain only
        const surfaceY = this.findTopmostSolidY(this.voxelWorld, x, z, blockSize);
        if (surfaceY !== null) return surfaceY + blockSize / 2;

        return this.getScanRangeY(this.voxelWorld).minY;
    }
    
    /**
     * @deprecated Use getTerrainOnlyHeight() instead
     */
    getVoxelTerrainHeight(x: number, z: number): number {
        return this.getTerrainOnlyHeight(x, z);
    }

    /**
     * Check if an entity at (x, feetY, z) has penetrated solid voxel terrain.
     * If so, returns the corrected Y position (top of the solid column).
     * Returns null if the entity is not embedded in terrain (no correction needed).
     *
     * Used as a safety net to prevent NPCs/animals from falling through terrain
     * when chunk colliders haven't been built yet (deferred building) or due to
     * physics edge cases.
     */
    getVoxelFloorY(x: number, feetY: number, z: number): number | null {
        if (!this.voxelWorld) return null;
        const blockSize = this.voxelWorld.getVoxelSize();
        const { minY, maxY } = this.getScanRangeY(this.voxelWorld);

        // Probe ABOVE the feet, not at them. Two reasons:
        // 1. Voxel-boundary ambiguity — an entity resting exactly on a surface
        //    samples the solid voxel below and gets falsely flagged.
        // 2. Smooth-surface terrain — the smoothed render/collider surface dips
        //    BELOW the voxel top, so feet legitimately rest INSIDE the top grid
        //    block (~0.2-0.4 blocks deep). Flagging that as "embedded" lifts the
        //    entity; it settles back into the smooth dip, gets flagged again,
        //    and visibly hops in place forever.
        // The margin must tolerate the deepest legitimate smooth-surface dip but
        // still rescue an entity sinking through unsupported terrain BEFORE it
        // is visibly buried (a full-block margin let characters sink to the
        // waist). 0.75 blocks splits those constraints.
        const probeY = feetY + blockSize * 0.75;
        if (this.isPassableBlock(this.voxelWorld.getBlock(x, probeY, z))) return null;

        // Entity is inside solid terrain — scan upward to find the surface.
        for (let scanY = probeY + blockSize; scanY <= maxY; scanY += blockSize) {
            if (this.isPassableBlock(this.voxelWorld.getBlock(x, scanY, z))) {
                // Return the BOTTOM boundary of the first passable voxel — the
                // actual top surface of the solid column — NOT the sample point,
                // which sits mid-voxel and would overshoot the correction by up
                // to a full block (the old "teleport up a metre, fall back down,
                // repeat" bounce).
                return minY + Math.floor((scanY - minY + 1e-6) / blockSize) * blockSize;
            }
        }
        return maxY;
    }

    /**
     * Whether a block can be stood in rather than on. Fluid blocks (water, lava)
     * are passable: otherwise an NPC walking into water finds water at its feet,
     * gets classified as "embedded", and is snapped up to the first air block
     * (the water surface) every frame — the "NPCs vibrating on top of water"
     * behaviour. An interior pool is likewise not a floor to spawn on.
     */
    private isPassableBlock(block: number): boolean {
        return block === 0 || getVoxelTextureAtlas().isFluidBlock(block);
    }

    /**
     * Get a terrain chunk mesh for a 2D chunk key.
     * Used for parenting foliage to terrain for automatic visibility inheritance.
     */
    getChunkMeshFor2DKey(key2D: string): THREE.Object3D | null {
        return this.voxelWorld?.getChunkMeshFor2DKey(key2D) ?? null;
    }

    /** Tick deferred chunk builds and foliage generation, spread across frames. */
    update(_deltaTime: number): void {
        // Skip if processDeferredWork() already handled this frame's deferred work
        if (this.deferredWorkProcessedThisFrame) {
            this.deferredWorkProcessedThisFrame = false;
            return;
        }

        // Phase B: Progressive foliage generation (after all chunks are built)
        if (this.deferredFoliageKeys) {
            const FOLIAGE_BUDGET_MS = 4;
            this.drainDeferredFoliage(performance.now(), FOLIAGE_BUDGET_MS);
            return;
        }

        // Phase A: Progressive chunk building
        if (!this.voxelWorld?.hasDeferredChunks()) return;
        const result = this.voxelWorld.tickDeferredBuild();
        if (!result.active) {
            // No foliage to grow — the build itself is the completion.
            if (!this.queueDeferredFoliage('All deferred chunks built')) {
                this.onDeferredBuildCompleteCallback?.();
            }
        }
    }
    
    /**
     * Update visibility of voxel chunks based on camera frustum.
     * Physics activation is handled via the visibility callback (frustum-based).
     * This works correctly for top-down camera where view extends beyond player radius.
     * Call this every frame before rendering for optimal performance.
     * @param camera The camera to cull against
     * @param playerPosition Optional player position — the chunks around it (and around
     *                       every NPC/animal) are pinned physics-active regardless of the
     *                       frustum result, so characters can't fall through terrain.
     */
    updateVisibility(camera: THREE.Camera, playerPosition?: THREE.Vector3): void {
        // Anchor the 3×3 chunks around every live character (player + NPCs + animals) physics-active
        // BEFORE the cull pass: the frustum test uses each chunk's whole 16×16 box, so a character
        // standing near a chunk corner whose box is off-screen gets that chunk culled — and its
        // collider disabled under their feet — while standing on visually solid ground. Anchoring
        // every character prevents the fall-through (off-camera NPCs/animals otherwise sink into the
        // terrain). Mesh visibility is unaffected.
        const anchors: THREE.Vector3[] = [];
        if (playerPosition) anchors.push(playerPosition);
        for (const c of this.engine?.getNpcRegistry?.()?.getAllControllers() ?? []) anchors.push(c.getPosition());
        for (const a of this.engine?.getAnimalRegistry?.()?.getAll() ?? []) anchors.push(a.getPosition());
        if (anchors.length > 0) this.chunkPhysicsManager?.keepActiveAround(anchors);
        // This triggers visibility change callbacks which update physics activation
        this.voxelWorld?.updateChunkVisibility(camera);
        // Note: ChunkPhysicsManager is updated via the onChunkVisibilityChanged callback
        // (frustum-based), with the character anchors above overriding it around every character.
    }

    /**
     * Enable or disable visibility culling for voxel chunks.
     * When enabled, chunks outside the camera frustum or beyond maxRenderDistance are hidden.
     */
    setCullingEnabled(enabled: boolean): void {
        this.voxelWorld?.setCullingEnabled(enabled);
    }

    /**
     * Check if visibility culling is enabled.
     */
    isCullingEnabled(): boolean {
        return this.voxelWorld?.isCullingEnabled() ?? false;
    }

    /**
     * Set the maximum render distance for chunk visibility culling.
     * @param distance Distance in meters (default: 150)
     */
    setMaxRenderDistance(distance: number): void {
        this.voxelWorld?.setMaxRenderDistance(distance);
    }
    
    /**
     * Get the current maximum render distance.
     */
    getMaxRenderDistance(): number {
        return this.voxelWorld?.getMaxRenderDistance() ?? 150;
    }
    
    /**
     * Get visibility culling statistics for debugging.
     */
    getCullingStats(): { visibleChunks: number; totalChunks: number; culledByDistance: number; culledByFrustum: number } | null {
        return this.voxelWorld?.getCullingStats() ?? null;
    }
    
    /**
     * Enable or disable physics colliders for a specific chunk.
     * Used by ChunkPhysicsManager to optimize physics for large worlds.
     */
    setChunkCollidersEnabled(chunkKey2D: string, enabled: boolean): void {
        this.voxelWorld?.setChunkCollidersEnabled(chunkKey2D, enabled);
    }
    
    /**
     * Get all chunk 2D keys (for ChunkPhysicsManager initialization).
     */
    getChunk2DKeys(): Set<string> {
        return this.voxelWorld?.getChunk2DKeys() ?? new Set();
    }
    
    // ==================== DYNAMIC OBJECT REGISTRATION ====================
    
    /**
     * Register a dynamic object (NPC, animal, vehicle) with the chunk physics manager.
     * Objects are automatically hibernated when their chunks become inactive.
     * @param obj Object implementing ChunkManagedObject interface
     * @param objectRadius Radius for chunk overlap detection (default: 0.5m)
     */
    registerDynamicObject(obj: ChunkManagedObject, objectRadius: number = 0.5): void {
        this.chunkPhysicsManager?.registerObject(obj, objectRadius);
    }
    
    /**
     * Unregister a dynamic object from chunk physics management.
     * Call this when the object is disposed.
     */
    unregisterDynamicObject(obj: ChunkManagedObject): void {
        this.chunkPhysicsManager?.unregisterObject(obj);
    }
    
    /**
     * Update a dynamic object's chunk registration after it moves.
     * Call this when an object crosses chunk boundaries.
     */
    updateDynamicObjectPosition(obj: ChunkManagedObject, objectRadius: number = 0.5): void {
        this.chunkPhysicsManager?.updateObjectPosition(obj, objectRadius);
    }
    
    /**
     * Check if chunk physics management is active for this terrain.
     */
    hasChunkPhysicsManager(): boolean {
        return this.chunkPhysicsManager !== null;
    }
    
    /**
     * Force-activate the chunk(s) at a world position.
     * Used during respawn to ensure terrain colliders are active before the player lands.
     */
    forceActivateChunksAtPosition(x: number, z: number): void {
        this.chunkPhysicsManager?.forceActivateAtPosition(x, z);
    }
    
    /**
     * Get chunk physics manager statistics for debugging.
     */
    getChunkPhysicsStats(): { activeChunks: number; trackedObjects: number; registrations: number; terrainAnchors: number } | null {
        return this.chunkPhysicsManager?.getStats() ?? null;
    }

    /**
     * Get the voxel chunk group for editor access.
     * Note: VoxelWorld adds chunks directly to the scene, so we return null.
     * Use getVoxelWorld() for direct VoxelWorld access.
     */
    getVoxelChunkGroup(): THREE.Group | null {
        return null;
    }

    /**
     * Get all chunk data.
     * Note: VoxelWorld manages chunks internally. Returns empty array for compatibility.
     * Use getVoxelWorld() for direct VoxelWorld access.
     */
    getVoxelChunkData(): Array<{ chunkX: number; chunkZ: number; worldMinX: number; worldMaxX: number; worldMinZ: number; worldMaxZ: number; mesh: THREE.Mesh; physicsBody: RAPIER.RigidBody | null }> {
        return [];
    }

    /**
     * Get height at world position from heightmap (quantized to voxel grid).
     * Note: This uses the original heightmap, not the actual voxel data.
     * Use getActualVoxelSurfaceHeight() to query actual voxel terrain after generation.
     */
    getVoxelHeightAt(x: number, z: number): number {
        const height = this.terrainHeightProvider.getHeightAt(x, z);
        return Math.floor(height / this.blockSize) * this.blockSize + this.blockSize;
    }

    getBlockSize(): number {
        return this.blockSize;
    }

    /**
     * Get actual voxel surface height at world position by querying the VoxelWorld.
     * This returns the height of the topmost solid voxel at the given XZ position.
     * Use this after terrain generation to query actual terrain height.
     * @returns Surface height in world units, or 0 if no voxels found
     */
    getActualVoxelSurfaceHeight(worldX: number, worldZ: number): number {
        if (!this.voxelWorld) {
            return this.getVoxelHeightAt(worldX, worldZ);
        }

        // Convert world coordinates to voxel coordinates
        const bounds = this.voxelWorld.getBounds();
        const voxelSize = this.voxelWorld.getVoxelSize();
        const originX = bounds?.minX ?? 0;
        const originY = bounds?.minY ?? 0;
        const originZ = bounds?.minZ ?? 0;

        const vx = Math.floor((worldX - originX) / voxelSize);
        const vz = Math.floor((worldZ - originZ) / voxelSize);

        // Query actual voxel height (returns voxel Y index)
        const voxelYIndex = this.voxelWorld.getTopmostVoxelHeight(vx, vz);
        
        if (voxelYIndex === -Infinity) {
            // No voxels at this position, fall back to heightmap
            return this.getVoxelHeightAt(worldX, worldZ);
        }

        // Convert voxel Y index back to world coordinates
        // voxelYIndex is the Y index of the topmost voxel, surface is at top of that voxel
        // Account for world origin offset
        return originY + (voxelYIndex + 1) * voxelSize;
    }

    /**
     * Enable shadow casting and receiving on voxel terrain chunks.
     */
    private enableShadows(): void {
        if (!this.voxelWorld) return;
        
        const chunks = this.voxelWorld.getChunks();
        let count = 0;
        for (const chunk of chunks.values()) {
            if (chunk.collisionMesh instanceof THREE.Mesh) {
                const mesh = chunk.collisionMesh;
                
                // Ensure geometry has bounding info for shadow calculations
                mesh.geometry.computeBoundingBox();
                mesh.geometry.computeBoundingSphere();
                
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                count++;
            }
        }
        
        console.log(`[VoxelTerrainSystem] Shadows enabled on ${count} voxel terrain chunks`);
    }

    // ============================================================================
    // Terrain Destruction API
    // ============================================================================

    /**
     * Remove a single terrain block at world position.
     * @returns true if a block was removed
     */
    destroyBlockAt(worldX: number, worldY: number, worldZ: number): boolean {
        if (!this.voxelWorld) return false;
        return this.voxelWorld.removeBlock(worldX, worldY, worldZ);
    }

    /**
     * Delete terrain blocks within a sphere (no debris, just removes blocks).
     * For editor/AI terrain modification. For explosions with debris, use explodeTerrainSphere().
     */
    deleteTerrainSphere(center: THREE.Vector3, radius: number): number {
        if (!this.voxelWorld) return 0;
        const removed = this.voxelWorld.removeBlocksInSphere(center.x, center.y, center.z, radius);
        return removed.length;
    }

    /**
     * Delete terrain blocks within a box (no debris, just removes blocks).
     * For editor/AI terrain modification. For explosions with debris, use explodeTerrainBox().
     */
    deleteTerrainBox(min: THREE.Vector3, max: THREE.Vector3): number {
        if (!this.voxelWorld) return 0;
        const removed = this.voxelWorld.removeBlocksInBox(min.x, min.y, min.z, max.x, max.y, max.z);
        return removed.length;
    }

    /**
     * Set the foliage system for coordinated destruction.
     * When terrain is destroyed, foliage on those blocks is also destroyed.
     */
    setFoliageSystem(foliageSystem: VoxelFoliageSystem): void {
        this.foliageSystem = foliageSystem;
        this.foundations.applyExclusionsTo(foliageSystem);
    }
    
    /**
     * Generate foliage for all terrain chunks.
     * Called after terrain is fully built. Foliage is parented to terrain chunk meshes
     * for automatic visibility inheritance (when chunk is hidden, foliage is hidden).
     * 
     * @param getTerrainType - Function to map block type to terrain type
     */
    generateAllFoliage(getTerrainType: (blockType: number) => number): void {
        this.terrainTypeResolver = getTerrainType;
        if (!this.voxelWorld || !this.foliageSystem) {
            console.warn('[VoxelTerrainSystem] Cannot generate foliage: missing voxelWorld or foliageSystem');
            return;
        }
        
        const startTime = performance.now();
        const chunkKeys = this.voxelWorld.get2DChunkKeys();
        let totalSurfaceVoxels = 0;
        
        for (const key2D of chunkKeys) {
            const chunkMesh = this.voxelWorld.getChunkMeshFor2DKey(key2D);
            if (!chunkMesh) continue;
            
            const surfaceVoxels = this.voxelWorld.getTopSurfaceVoxelsFor2DChunk(key2D);
            totalSurfaceVoxels += surfaceVoxels.length;
            
            this.foliageSystem.generateFoliageForChunk(key2D, surfaceVoxels, chunkMesh, getTerrainType);
        }
        
        console.log(`[VoxelTerrainSystem] Generated foliage for ${chunkKeys.length} chunks (${totalSurfaceVoxels} surface voxels) in ${(performance.now() - startTime).toFixed(0)}ms`);
    }
    
    /**
     * Regenerate foliage for a specific chunk (after terrain modification).
     * 
     * @param key2D - 2D chunk key "cx,cz"
     * @param getTerrainType - Function to map block type to terrain type
     */
    regenerateFoliageForChunk(key2D: string, getTerrainType: (blockType: number) => number): void {
        if (!this.voxelWorld || !this.foliageSystem) return;
        
        const chunkMesh = this.voxelWorld.getChunkMeshFor2DKey(key2D);
        if (!chunkMesh) return;
        
        const surfaceVoxels = this.voxelWorld.getTopSurfaceVoxelsFor2DChunk(key2D);
        this.foliageSystem.generateFoliageForChunk(key2D, surfaceVoxels, chunkMesh, getTerrainType);
    }
    
    /**
     * Set the environment object system.
     * Provides chunk parent for automatic visibility inheritance (parented to terrain chunks).
     */
    setEnvironmentObjectSystem(envSystem: EnvironmentObjectSystem): void {
        this.environmentObjectSystem = envSystem;
        envSystem.setVoxelSize(this.blockSize);
        
        // Provide chunk parent function for automatic visibility
        if (this.voxelWorld) {
            envSystem.setChunkParentProvider((key2D: string) => 
                this.voxelWorld!.getChunkMeshFor2DKey(key2D)
            );
        }
    }
    
    /**
     * Explode terrain within a sphere - creates flying debris with physics.
     * Use for weapons, explosions, destruction effects.
     */
    explodeTerrainSphere(
        center: THREE.Vector3, 
        radius: number,
        impulseStrength: number = 5,
        impulseUp: number = 2
    ): VoxelDebris[] {
        if (!this.voxelWorld) return [];
        
        // Also destroy foliage in the affected area
        if (this.foliageSystem) {
            this.foliageSystem.detachFoliageInSphere(
                center.x, center.y, center.z,
                radius * 1.2,
                impulseStrength * 0.5,
                impulseUp
            );
        }
        
        return this.voxelWorld.detachBlocksInSphere(
            center.x, center.y, center.z, 
            radius, 
            impulseStrength, 
            impulseUp
        );
    }

    /**
     * Explode terrain within a box - creates flying debris with physics.
     * Use for weapons, explosions, destruction effects.
     */
    explodeTerrainBox(
        min: THREE.Vector3,
        max: THREE.Vector3,
        impulseDirection?: THREE.Vector3,
        impulseStrength: number = 5
    ): VoxelDebris[] {
        if (!this.voxelWorld) return [];
        return this.voxelWorld.detachBlocksInBox(
            min.x, min.y, min.z,
            max.x, max.y, max.z,
            impulseDirection,
            impulseStrength
        );
    }

    // ============================================================================
    // Deterministic Terrain Destruction (for networked multiplayer)
    // ============================================================================

    /**
     * Deterministically destroy terrain within a sphere using fixed-point math.
     *
     * All clients receiving the same DeterministicExplosionParams will remove
     * the exact same voxels and spawn debris with the exact same initial velocities.
     * Debris simulation after that point is local to each client.
     *
     * Also destroys foliage in the affected area.
     *
     * @param params - Fixed-point explosion parameters (from server broadcast)
     * @param physicsWorld - Rapier physics world for debris bodies
     * @param parentGroup - THREE.Object3D to parent debris visuals under
     * @returns Array of debris { body, collider }
     */
    deterministicExplodeTerrainSphere(
        params: DeterministicExplosionParams,
        physicsWorld: PhysicsWorldType,
        parentGroup: THREE.Object3D,
    ): VoxelDebris[] {
        if (!this.voxelWorld) return [];

        if (this.foliageSystem) {
            this.foliageSystem.detachFoliageInSphere(
                fpToFloat(params.cx), fpToFloat(params.cy), fpToFloat(params.cz),
                fpToFloat(params.radius) * 1.2,
                fpToFloat(params.impulseStrength) * 0.5,
                fpToFloat(params.impulseUp),
            );
        }

        return DeterministicDestruction.explodeTerrainSphere(params, this.voxelWorld, physicsWorld, parentGroup);
    }

    /** @deprecated Debris updates are handled automatically by VoxelDebrisManager */
    updateDebris(): void {}

    /**
     * Immediately remove all debris
     */
    clearDebris(): void {
        this.voxelWorld?.clearDebris();
    }

    /**
     * Find a valid voxel spawn position for dynamic objects (animals, NPCs, etc.).
     * Snaps X/Z to voxel centers and validates the position is available.
     *
     * @param worldX Approximate world X coordinate
     * @param worldZ Approximate world Z coordinate
     * @param environmentObjectSystem Optional: Environment object system to check for occupied positions
     * @param fromY Optional spawn height for INTERIOR spawns. When provided, the
     *              floor is resolved by scanning DOWN from this height instead of
     *              taking the topmost surface — inside a roofed room that finds
     *              the room floor, where the default path would land on the roof.
     *              Columns without standing headroom above the found floor
     *              (walls, filled space) are rejected so callers retry nearby.
     * @returns Valid spawn position at voxel corner (integer X/Z) or null if no valid position found
     */
    public findValidVoxelSpawnPosition(
        worldX: number,
        worldZ: number,
        environmentObjectSystem?: EnvironmentObjectSystem,
        fromY?: number
    ): THREE.Vector3 | null {
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) {
            console.error(`[VoxelTerrainSystem] findValidVoxelSpawnPosition: voxelWorld is null!`);
            return null;
        }

        const voxelSize = voxelWorld.getVoxelSize(); // Should be 1.0

        // Snap X/Z to voxel center positions (floor + 0.5)
        const spawnX = Math.floor(worldX / voxelSize) * voxelSize + voxelSize * 0.5;
        const spawnZ = Math.floor(worldZ / voxelSize) * voxelSize + voxelSize * 0.5;

        // Skip if occupied by environment objects (trees, rocks, etc.).
        // Enclosure-scale objects (occupancy radius > SPAWN_OCCUPANCY_MAX_OBJECT_RADIUS —
        // a colosseum, stadium, or walled fort placed as one asset) are exempt: their
        // bounding-box disc covers their own playable interior, where spawning is
        // legitimate. Their solid parts (walls, tiers, roofs) are still rejected
        // per-column by the surface-height check below.
        if (environmentObjectSystem?.isPositionOccupied(spawnX, spawnZ, 1.0, SPAWN_OCCUPANCY_MAX_OBJECT_RADIUS)) {
            return null;
        }

        // Interior spawn: resolve the floor below the requested height instead
        // of the topmost surface (which is the roof for any enclosed room).
        if (fromY !== undefined) {
            return this.findInteriorFloorPosition(spawnX, spawnZ, fromY);
        }

        // Get terrain-only height from voxel grid (always accurate)
        const terrainY = this.getTerrainOnlyHeight(spawnX, spawnZ);

        // Get full surface height (includes buildings on ENVIRONMENT collision group)
        const surfaceY = this.getHeightAt(spawnX, spawnZ);

        // Validate that we got a reasonable height (not the minY fallback)
        const bounds = voxelWorld.getBounds();
        const minY = bounds?.minY ?? TERRAIN_DEFAULT_MIN_Y;

        if (terrainY <= minY) {
            return null;
        }

        // Reject positions where surface height differs significantly from terrain height
        // This indicates a building (on ENVIRONMENT collision layer) is at this position.
        // getTerrainOnlyHeight returns the surface block's CENTER; the walkable top —
        // which getHeightAt reports for bare ground — is half a voxel up. Compare against
        // the top so bare terrain measures 0 elevation, not half a block.
        const terrainTopY = terrainY + voxelSize * 0.5;
        const heightDifference = Math.abs(surfaceY - terrainTopY);
        if (heightDifference > MAX_SPAWN_SURFACE_ELEVATION) {
            return null;
        }

        // Use surfaceY (includes environment objects like floor surfaces, platforms, ice rinks)
        // instead of terrainY, so the player spawns ON TOP of thin environment objects
        // rather than under them. The building rejection above already filters out tall structures.
        return new THREE.Vector3(spawnX, surfaceY, spawnZ);
    }

    /** Standing room required above an interior floor before we accept it as a spawn. */
    private static readonly INTERIOR_SPAWN_HEADROOM_M = 2.0;

    /**
     * Resolve an interior spawn: the first solid floor at/below `fromY` in this
     * column, accepted only with standing headroom above it. Used by
     * findValidVoxelSpawnPosition(fromY) for spawns inside roofed rooms, where
     * the top-down surface scan would resolve to the roof.
     */
    private findInteriorFloorPosition(spawnX: number, spawnZ: number, fromY: number): THREE.Vector3 | null {
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) return null;

        const blockSize = voxelWorld.getVoxelSize();
        const { minY, maxY } = this.getScanRangeY(voxelWorld);

        // Scan DOWN from the requested height for the first solid voxel.
        const startY = Math.min(fromY, maxY);
        let floorTop: number | null = null;
        for (let sampleY = startY; sampleY >= minY; sampleY -= blockSize) {
            if (!this.isPassableBlock(voxelWorld.getBlock(spawnX, sampleY, spawnZ))) {
                // Top boundary of the solid voxel containing sampleY (grid-aligned
                // from minY — same convention as getVoxelFloorY).
                floorTop = minY + (Math.floor((sampleY - minY + 1e-6) / blockSize) + 1) * blockSize;
                break;
            }
        }
        if (floorTop === null) return null; // open void below — nothing to stand on

        // Headroom: the space above the floor must be clear for a standing
        // character. A wall column fails here (its own blocks fill the gap),
        // which makes callers retry a nearby position inside the room.
        const headroomSamples = Math.max(1, Math.ceil(VoxelTerrainSystem.INTERIOR_SPAWN_HEADROOM_M / blockSize));
        for (let k = 0; k < headroomSamples; k++) {
            const sampleY = floorTop + blockSize * 0.5 + k * blockSize;
            if (!this.isPassableBlock(voxelWorld.getBlock(spawnX, sampleY, spawnZ))) {
                return null;
            }
        }

        // Thin ENVIRONMENT-group objects (platforms, daises placed as
        // VoxelObjects) may stand on the voxel floor — spawn on top of them,
        // mirroring the surfaceY behaviour of the top-down path.
        const physicsWorld = this.engine?.physicsWorld;
        if (physicsWorld) {
            const envHit = physicsWorld.raycast(
                new THREE.Vector3(spawnX, fromY, spawnZ),
                new THREE.Vector3(0, -1, 0),
                Math.max(1, fromY - minY + 1),
                CollisionGroup.ENVIRONMENT
            );
            if (envHit.hasHit && envHit.hitPoint.y > floorTop) {
                return new THREE.Vector3(spawnX, envHit.hitPoint.y, spawnZ);
            }
        }

        return new THREE.Vector3(spawnX, floorTop, spawnZ);
    }

    /**
     * Check if a rectangular area of terrain is already flat (all surface blocks at the same height
     * with no blocks above the surface). Used to skip unnecessary flattenArea() calls.
     * Returns the quantized surface height if flat, or null if the area is uneven.
     */
    isAreaFlat(centerX: number, centerZ: number, width: number, depth: number, margin: number = 0): number | null {
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) return null;

        const blockSize = this.blockSize;
        const halfWidth = (width + margin * 2) / 2;
        const halfDepth = (depth + margin * 2) / 2;

        let referenceHeight: number | null = null;

        for (let x = centerX - halfWidth; x < centerX + halfWidth; x += blockSize) {
            for (let z = centerZ - halfDepth; z < centerZ + halfDepth; z += blockSize) {
                // Find top-most block in this column (terrain only — voxel grid has no environment).
                // No terrain block found in this column — not flat.
                const surfaceY = this.findTopmostSolidY(voxelWorld, x, z, blockSize);
                if (surfaceY === null) return null;

                const quantized = Math.floor(surfaceY / blockSize) * blockSize;

                if (referenceHeight === null) {
                    referenceHeight = quantized;
                } else if (quantized !== referenceHeight) {
                    return null;
                }

                // Check for blocks above the surface (natural overhangs)
                for (let y = surfaceY + blockSize; y <= surfaceY + MAX_OVERHANG_SCAN_HEIGHT; y += blockSize) {
                    if (voxelWorld.getBlock(x, y, z) !== 0) {
                        return null;
                    }
                }
            }
        }

        return referenceHeight;
    }

    /**
     * Flatten an area of terrain to a specific height.
     * Removes blocks above the target height, sets surface blocks, and fills underground.
     *
     * @param centerX - Center X coordinate of the area to flatten
     * @param centerZ - Center Z coordinate of the area to flatten
     * @param width - Width of the area in meters
     * @param depth - Depth of the area in meters
     * @param height - Target height in world units
     * @param blockType - Block type ID to use for flattened surface (default: uses atlas to find stone)
     * @param rebuildMeshes - Whether to rebuild meshes immediately (default: false, caller should rebuild)
     * @param margin - Additional margin around the area in meters (default: 0)
     */
    flattenArea(centerX: number, centerZ: number, width: number, depth: number, height: number, blockType?: number, rebuildMeshes: boolean = false, margin: number = 0, objectId?: string): void {
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) {
            console.warn('[FLATTEN] Cannot flatten area - terrain not initialized');
            return;
        }

        // Default to the atlas' stone block, falling back to COLOR if it has none.
        const block = blockType ?? getVoxelTextureAtlas().getBlockIdByName('stone') ?? BlockType.COLOR;

        const blockSize = this.blockSize;
        const halfWidth = (width + margin * 2) / 2;
        const halfDepth = (depth + margin * 2) / 2;
        const quantizedHeight = Math.floor(height / blockSize) * blockSize;

        // If objectId is provided, store snapshot of original blocks before flattening
        const snapshot: Array<{x: number, y: number, z: number, block: number}> | null = objectId ? [] : null;

        for (let x = centerX - halfWidth; x < centerX + halfWidth; x += blockSize) {
            for (let z = centerZ - halfDepth; z < centerZ + halfDepth; z += blockSize) {
                // Remove ALL blocks above the target height
                for (let y = quantizedHeight + blockSize; y <= quantizedHeight + MAX_OVERHANG_SCAN_HEIGHT; y += blockSize) {
                    const existingBlock = voxelWorld.getBlock(x, y, z);
                    if (existingBlock !== 0) {
                        if (snapshot) snapshot.push({x, y, z, block: existingBlock});
                        voxelWorld.setBlock(x, y, z, 0);
                    }
                }

                // Snapshot the surface and underground blocks before overwriting
                if (snapshot) {
                    snapshot.push({x, y: quantizedHeight, z, block: voxelWorld.getBlock(x, quantizedHeight, z)});
                    forEachUndergroundY(quantizedHeight, blockSize, TERRAIN_DEFAULT_MIN_Y, belowY => {
                        snapshot.push({x, y: belowY, z, block: voxelWorld.getBlock(x, belowY, z)});
                    });
                }

                // Set the surface block and fill underground
                voxelWorld.setBlock(x, quantizedHeight, z, block);
                forEachUndergroundY(quantizedHeight, blockSize, TERRAIN_DEFAULT_MIN_Y, belowY => {
                    voxelWorld.setBlock(x, belowY, z, block);
                });
            }
        }

        // Store snapshot for later unflatten
        if (objectId && snapshot) {
            this.flattenSnapshots.set(objectId, snapshot);
        }

        if (rebuildMeshes) {
            voxelWorld.updatePhysicsAndMeshing(true);
        }
    }

    /**
     * Restore terrain that was flattened for a specific object.
     * Uses the stored snapshot to put back original blocks.
     *
     * @param objectId - The object ID whose flatten snapshot to restore
     * @param rebuildMeshes - Whether to rebuild meshes immediately (default: true)
     */
    unflattenArea(objectId: string, rebuildMeshes: boolean = true): void {
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) return;

        const snapshot = this.flattenSnapshots.get(objectId);
        if (!snapshot) {
            console.warn(`[UNFLATTEN] No snapshot found for objectId: ${objectId}`);
            return;
        }

        for (const entry of snapshot) {
            voxelWorld.setBlock(entry.x, entry.y, entry.z, entry.block);
        }

        this.flattenSnapshots.delete(objectId);

        if (rebuildMeshes) {
            voxelWorld.updatePhysicsAndMeshing(true);
        }
    }

    /**
     * Clear a flatten snapshot without restoring terrain.
     */
    clearFlattenSnapshot(objectId: string): void {
        this.flattenSnapshots.delete(objectId);
    }

    /**
     * Check if a flatten snapshot exists for an object.
     */
    hasFlattenSnapshot(objectId: string): boolean {
        return this.flattenSnapshots.has(objectId);
    }

    /**
     * Flatten a building lot (`width` × `depth` + `margin`, centred) and keep foliage off it for good,
     * even after chunk rebuilds (plain `flattenArea` does not). The floor defaults to the most common ground
     * level across the footprint (`levelAt` picks a point instead, e.g. the path at the door). Same `id` replaces; see release.
     * @returns The walkable floor-top Y of the foundation.
     */
    placeBuildingFoundation(id: string, centerX: number, centerZ: number, width: number, depth: number, opts?: Partial<BuildingFoundationOptions>): number {
        return this.foundations.place(id, centerX, centerZ, width, depth, { ...DEFAULT_BUILDING_FOUNDATION_OPTIONS, ...opts });
    }

    /** Undo `placeBuildingFoundation(id)`: drop its foliage exclusion and (unless `restoreTerrain` is false) restore the ground. False for an unknown id. */
    releaseBuildingFoundation(id: string, restoreTerrain: boolean = true, rebuildMeshes: boolean = true): boolean {
        return this.foundations.release(id, restoreTerrain, rebuildMeshes);
    }

    /** Footprint registered for a building foundation, or null. */
    getBuildingFoundation(id: string): FoliageExclusionRect | null {
        return this.foundations.get(id);
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        if (this.navMesh) {
            this.navMesh.dispose();
            setGlobalNavMesh(null);
            this.navMesh = null;
        }
        if (this.chunkPhysicsManager) {
            this.chunkPhysicsManager.clear();
            this.chunkPhysicsManager = null;
        }
        if (this.voxelWorld) {
            this.voxelWorld.clear();
            this.voxelWorld = null;
        }
        if (this.terrain2D) {
            this.terrain2D.dispose();
            this.terrain2D = null;
        }
    }
}

