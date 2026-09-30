import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, If, attribute, positionLocal, vec3 } from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';
import { activeMaterialQuality } from 'engine/DeviceQuality.js';
import { clampVoxelMaterialLighting } from 'engine/VoxelMaterialClass.js';
import {
    type BlockID,
    type ChunkKey,
    type CollisionBox,
    CHUNK_SIZE,
    CHUNK_MASK,
    FACE_TEMPLATES,
    FACE_INDICES,
    ColorChunk,
    VoxelChunk,
    generateCollisionBoxes,
    makeChunkKey,
} from 'engine/VoxelGeometry.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import {
    getVoxelTextureAtlas,
    createGrassBlockType,
    createSandBlockType,
    createIceBlockType,
    createStoneBlockType,
    createDirtBlockType,
    createAsphaltBlockType,
    createLavaBlockType,
    createTrunkBlockType,
    createLeavesBlockType,
    createPlanksBlockType,
    createWaterBlockType,
    createSlimeBlockType,
    createQuicksandBlockType,
    BlockType
} from 'engine/VoxelTextureAtlas.js';
import { VoxelSmoothSurfaceManager, type VoxelHeightProvider } from 'engine/VoxelSmoothSurface.js';
import { VoxelShadowSystem, type VoxelChunkProvider } from 'engine/VoxelShadowSystem.js';
import { registerPhysicsBody } from 'engine/PhysicsBodyRegistry.js';
import {
    voxelCollidersEnabled, voxelsDesc, cellsFromIntBoxes, coupleChunkVoxelColliders, decoupleChunkVoxelColliders,
    type ChunkVoxelCollider,
} from 'engine/physics/VoxelColliders.js';
import { VoxelDebrisManager } from 'engine/VoxelDebrisManager.js';
import { VoxelLazyGeneration } from 'engine/VoxelLazyGeneration.js';
import { VoxelColumnTopIndex } from 'engine/VoxelColumnTopIndex.js';
import { buildUniformFlatInstancedMeshes, evictChunkFromInstance, disposeInstancingState, createEmptyInstancingState, type UniformFlatInstancingState } from 'engine/VoxelUniformFlatInstancing.js';
import { VoxelChunkCulling } from 'engine/VoxelChunkCulling.js';
import { isVxlV3 } from 'engine/VxlV3Format.js';
import { encodeVoxelWorldAsVxlV3, loadVxlV3IntoVoxelWorld } from 'engine/VoxelWorldVxlIO.js';
import { getWaterBuoyancySystem } from 'engine/WaterBuoyancySystem.js';
import { getMaterialRegistry } from 'engine/MaterialRegistry.js';
import { VoxelWaterRefill } from 'engine/VoxelWaterRefill.js';
import { getChunkDistanceToPlayer, sortChunksByDistance, CHUNK_PRIORITY_CONFIG } from 'engine/VoxelChunkUpdateHelper.js';
import { getZFightingRegistry } from 'engine/ZFightingRegistry.js';
import { mergeVoxelRoundingRadiusVoxels, appendRoundedVoxelMesh, appendFloorBridgeQuads, type RoundedAtlasContext, type DiagonalVoxelInfo } from 'engine/VoxelRoundedMesh.js';
import {
    clearDebris as clearDebrisOp,
    detachBlocksInBox as detachBlocksInBoxOp,
    detachBlocksInSphere as detachBlocksInSphereOp,
    removeBlocksInBox as removeBlocksInBoxOp,
    removeBlocksInSphere as removeBlocksInSphereOp,
} from 'engine/VoxelWorldDestruction.js';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

const BLOCK_TYPE_CREATORS: Record<string, (atlas: ReturnType<typeof getVoxelTextureAtlas>) => number> = {
    'grass': createGrassBlockType,
    'sand': createSandBlockType,
    'ice': createIceBlockType,
    'stone': createStoneBlockType,
    'dirt': createDirtBlockType,
    'asphalt': createAsphaltBlockType,
    'lava': createLavaBlockType,
    'trunk': createTrunkBlockType,
    'leaves': createLeavesBlockType,
    'planks': createPlanksBlockType,
    'water': createWaterBlockType,
    'slime': createSlimeBlockType,
    'quicksand': createQuicksandBlockType
};

// Debris geometry that has been merged into a chunk (non-grid-aligned cubes)
export interface MergedDebris {
    vertices: Float32Array; // 8 vertices * 3 floats = 24 floats (world space, already transformed)
    blockType: number;
    rotation: { x: number; y: number; z: number; w: number }; // Quaternion for transforming normals
    zFightingOffset: number; // Unique offset to apply along face normals to prevent z-fighting
    color?: { r: number; g: number; b: number }; // RGB 0–1 for colored debris (octree V2); when set, uses atlas color palette UVs
    debrisSize?: number; // Actual size of the debris cube (when different from terrain voxelSize)
}

// WorldChunk extends VoxelChunk with physics-specific fields
class Chunk extends VoxelChunk {
    body: RAPIER.RigidBody | null = null;
    colliders: RAPIER.Collider[] = [];
    /** The voxels colliders among `colliders`, with their cells — seam-coupled to the six neighbours. */
    voxelColliders: ChunkVoxelCollider[] = [];
    collisionMesh: THREE.Object3D | null = null;
    mergedDebris: MergedDebris[] = []; // Debris cubes that have settled and been merged into this chunk
}

export type VoxelMaterialType = 'standard' | 'lambert' | 'atlas';

export interface VoxelWorldOptions {
    voxelSize?: number;
    parentGroup?: THREE.Object3D;
    generateNormals?: boolean; // Per-face normals for shadow receiving (Voxel genre)
    materialType?: VoxelMaterialType; // 'atlas'|'lambert'|'standard'
    disableGreedyMeshing?: boolean; // Individual quads (required for atlas mode)
    skipShadowMesh?: boolean; // Skip global shadow mesh for large terrains
    /** Corner roundness in voxel units (× voxelSize → world meters). 0 = sharp cubes only. */
    voxelRoundingRadiusVoxels?: number;
    /** Segments along each rounded corner (Three.js RoundedBoxGeometry segments). Default 2. */
    voxelRoundingSegments?: number;
    /**
     * 2D-physics lane only (a null `physicsWorld`): called each time
     * `updateChunkPhysics` settles a chunk's `collisionBoxes` — with null when
     * the chunk became empty — so a 2D collider owner can rebuild that chunk
     * (see engine/physics/VoxelTerrain2DBridge.ts). The 3D lane builds its own
     * colliders and never fires it.
     */
    onChunkPhysicsRebuilt?: (key: ChunkKey, collisionBoxes: CollisionBox[] | null, cx: number, cy: number, cz: number) => void;
}

export class VoxelWorld {
    private chunks = new Map<ChunkKey, Chunk>();
    /** Null on the 2D-physics lane: the world still meshes and exposes `chunk.collisionBoxes`
     *  (VoxelTerrain2D slices those into Rapier 2D), but creates no 3D bodies. */
    private physicsWorld: PhysicsWorld | null;
    private dirtyChunks = new Set<Chunk>();
    private scene: THREE.Scene;
    private parentGroup: THREE.Object3D; // Where to add meshes (defaults to scene)
    private voxelSize: number = 1.0;
    private bounds: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null = null;
    private isPlacedObject: boolean = false;
    private skipShadowMesh: boolean = false;
    private generateNormals: boolean = false;
    private materialType: VoxelMaterialType = 'standard';
    private disableGreedyMeshing: boolean = false;
    private voxelRoundingRadiusVoxels: number = 0;
    private voxelRoundingSegments: number = 2;
    private revealInstancedMesh: THREE.InstancedMesh | null = null;
    private revealScales: Float32Array | null = null;
    private revealVisible: Uint8Array | null = null;
    private revealMode: boolean = false;
    private revealProgress: number = 0;
    private chunksShouldBeVisible: boolean = true;
    private batchMode: boolean = false;
    private autoRebuildSuppressed: boolean = false;
    private autoRebuildScheduled: boolean = false;
    private levelGenerationActive: boolean = false;
    // Shadow system (delegated to VoxelShadowSystem)
    private shadowSystem: VoxelShadowSystem;
    private chunkChecksums = new Map<ChunkKey, number>();
    private dirtyChecksumChunks = new Set<ChunkKey>();
    private cachedTerrainChecksum: number = 0;
    private smoothSurfaceManager: VoxelSmoothSurfaceManager;
    private heightCache = new Map<string, { height: number; blockType: BlockID }>(); // Fast topmost height lookup
    // Physics statistics for OOM diagnostics
    private physicsStats = { totalRigidBodies: 0, totalCompoundShapes: 0, totalBoxShapes: 0, totalTriMeshShapes: 0, lastUpdateStats: null as { chunksProcessed: number; boxShapesCreated: number; rigidBodiesCreated: number; triMeshShapesCreated: number } | null };
    
    // HeightField collider for smooth surfaces (replaces chunked trimesh)
    private smoothHeightfieldBody: RAPIER.RigidBody | null = null;
    private smoothHeightfieldCollider: RAPIER.Collider | null = null;
    private heightfieldResolution: number = 2.0;  // Sample every 2 meters for heightfield (reduced for stability)
    
    // Visibility culling (delegated to VoxelChunkCulling)
    private chunkCulling: VoxelChunkCulling | null = null;
    
    // Lazy chunk generation (delegated to VoxelLazyGeneration)
    private lazyGeneration: VoxelLazyGeneration | null = null;

    // Deferred dirty chunk rebuild queue (chunks moved here to skip immediate rebuild)
    private deferredDirtyChunks: { key: ChunkKey; chunk: Chunk }[] = [];

    // Chunks whose physics was built last frame and need visual mesh creation this frame
    private deferredVisualKeys: Set<ChunkKey> | null = null;

    // Water refill after terrain destruction (delegated to VoxelWaterRefill)
    private waterRefill: VoxelWaterRefill;

    // Callback to trigger fluid mesh rebuild (set by WorldGenerator after creating VoxelFluidSystem)
    private onFluidBlocksChanged: ((dirtyChunkKeys: Set<string>) => void) | null = null;

    private mutationObserver: ((vx: number, vy: number, vz: number, block: BlockID, color: number | undefined) => void) | null = null;

    /** 2D lane's collider owner (see VoxelWorldOptions.onChunkPhysicsRebuilt); never set on the 3D lane. */
    private readonly onChunkPhysicsRebuilt: VoxelWorldOptions['onChunkPhysicsRebuilt'] | null;

    constructor(physicsWorld: PhysicsWorld | null, scene: THREE.Scene, options: VoxelWorldOptions = {}) {
        this.physicsWorld = physicsWorld; this.scene = scene; this.voxelSize = options.voxelSize ?? 1.0; this.onChunkPhysicsRebuilt = options.onChunkPhysicsRebuilt ?? null;
        this.parentGroup = options.parentGroup ?? scene; this.isPlacedObject = options.parentGroup !== undefined;
        this.generateNormals = options.generateNormals ?? false; this.materialType = options.materialType ?? 'standard';
        this.disableGreedyMeshing = options.disableGreedyMeshing ?? (this.materialType === 'atlas'); this.skipShadowMesh = options.skipShadowMesh ?? false;
        this.voxelRoundingRadiusVoxels = options.voxelRoundingRadiusVoxels ?? 0;
        this.voxelRoundingSegments = Math.max(1, options.voxelRoundingSegments ?? 2);
        this.smoothSurfaceManager = new VoxelSmoothSurfaceManager(); this.smoothSurfaceManager.setHeightProvider(this as VoxelHeightProvider);
        this.waterRefill = new VoxelWaterRefill(this);
        // Initialize shadow system with this as provider
        const self = this;
        this.shadowSystem = new VoxelShadowSystem({
            getChunks: () => self.chunks as Map<string, { get(x: number, y: number, z: number): BlockID; colors: { get(x: number, y: number, z: number): number } }>,
            getBounds: () => self.bounds, getVoxelSize: () => self.voxelSize, getParentGroup: () => self.parentGroup,
            isPlacedObject: () => self.isPlacedObject, shouldSkipShadowMesh: () => self.skipShadowMesh
        });
    }

    /**
     * Create voxel material based on materialType option.
     * 'atlas' - MeshLambertMaterial with texture atlas (recommended for Voxel genre)
     * 'lambert' - MeshLambertMaterial, forced flat look (published API contract)
     * 'standard' - the default: PBR when the quality ladder allows the
     *              environment tier, Lambert otherwise (see
     *              createVertexColourTerrainMaterial)
     *
     * All terrain materials use base polygon offset (0,0) from ZFightingRegistry.
     * VoxelObjects use negative offsets to render in front of terrain.
     */
    // Cached shared terrain material — used by every visible voxel chunk.
    // Previously each chunk allocated its own (e.g. 274 separate MeshStandardMaterials on a
    // 1920×1920 world's initial radius, each triggering a Three.js program-cache lookup).
    // Sharing one instance turns updateCollisionVisualization from 734ms → much lower.
    private sharedTerrainMaterial: THREE.Material | null = null;
    private createVoxelMaterial(): THREE.Material {
        if (this.sharedTerrainMaterial) return this.sharedTerrainMaterial;
        const o = getZFightingRegistry().terrainOffset;
        let m: THREE.Material;
        if (this.materialType === 'atlas') { m = getVoxelTextureAtlas().createMaterial(); m.polygonOffset = true; m.polygonOffsetFactor = o.factor; m.polygonOffsetUnits = o.units; }
        else m = createVertexColourTerrainMaterial(this.materialType === 'lambert' ? 'lambert' : 'standard', o);
        return this.sharedTerrainMaterial = m;
    }
    /** Dispose a chunk-mesh material only if it's not the shared cached instance (depth materials etc.). */
    private disposeChunkMaterial(m: THREE.Material): void { if (m !== this.sharedTerrainMaterial) m.dispose(); }
    

    setVoxelSize(voxelSize: number): void {
        this.voxelSize = voxelSize;
        // Mark all chunks as dirty so they get remeshed with new size
        for (const chunk of this.chunks.values()) this.dirtyChunks.add(chunk);
    }

    setBounds(bounds: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null): void {
        this.bounds = bounds;
        // Mark all chunks as dirty so they get repositioned with new bounds
        for (const chunk of this.chunks.values()) this.dirtyChunks.add(chunk);
    }

    private getChunkKey(cx: number, cy: number, cz: number): ChunkKey { return `${cx},${cy},${cz}`; }

    /** Fast voxel-grid-coordinate block lookup that works across chunk boundaries. */
    private getBlockAtVoxel(vx: number, vy: number, vz: number): BlockID {
        const cx = Math.floor(vx / CHUNK_SIZE), cy = Math.floor(vy / CHUNK_SIZE), cz = Math.floor(vz / CHUNK_SIZE);
        const chunk = this.chunks.get(this.getChunkKey(cx, cy, cz));
        if (!chunk) return 0;
        return chunk.get(vx & CHUNK_MASK, vy & CHUNK_MASK, vz & CHUNK_MASK);
    }

    /** Is voxel at global grid coords solid (non-air, non-fluid)? Works across chunk boundaries. */
    private isSolidAtVoxel(vx: number, vy: number, vz: number): boolean {
        const bt = this.getBlockAtVoxel(vx, vy, vz);
        return bt !== 0 && !this.isTransparentForCulling(bt);
    }

    private getChunk(cx: number, cy: number, cz: number): Chunk {
        const key = this.getChunkKey(cx, cy, cz); let chunk = this.chunks.get(key);
        if (!chunk) { chunk = new Chunk(); this.chunks.set(key, chunk); this._chunkAllocCount++; }
        return chunk;
    }
    // Perf counters + per-column top-Y index (for fast navmesh ground scans) + uniform-flat InstancedMesh state
    private _chunkAllocCount = 0; private _fillChunkFlatCount = 0; private _fillChunkFlatTotalMs = 0; private columnTopIndex = new VoxelColumnTopIndex();
    private instancingState: UniformFlatInstancingState = createEmptyInstancingState();
    logFillChunkFlatStats(): void { console.log(`[VoxelWorld] chunkAllocs=${this._chunkAllocCount} fillChunkFlatCalls=${this._fillChunkFlatCount} fillChunkFlatTotalMs=${this._fillChunkFlatTotalMs.toFixed(1)}ms chunkMapSize=${this.chunks.size} columnTopEntries=${this.columnTopIndex.size} uniformColumns=${this.columnTopIndex.uniformSize} instancedChunks=${this.instancingState.totalInstances}`); }
    /** Build per-block InstancedMeshes for every column currently flagged uniform-flat. Call once after terrain stamp. */
    buildUniformFlatInstancing(): void {
        disposeInstancingState(this.instancingState, this.parentGroup);
        this.instancingState = buildUniformFlatInstancedMeshes({ columnTopIndex: this.columnTopIndex, bounds: this.bounds, voxelSize: this.voxelSize, parentGroup: this.parentGroup, material: this.createVoxelMaterial() });
    }
    /** Highest world-Y above any solid block in the chunk-column containing (x, z), or null if empty. */
    getColumnMaxWorldY(x: number, z: number): number | null {
        const bX=this.bounds?.minX??0, bZ=this.bounds?.minZ??0, bY=this.bounds?.minY??0, EPS=1e-6, vs=this.voxelSize;
        const cx=Math.floor(Math.floor((x-bX+EPS)/vs)/CHUNK_SIZE), cz=Math.floor(Math.floor((z-bZ+EPS)/vs)/CHUNK_SIZE);
        const vy=this.columnTopIndex.getMax(cx,cz); return vy===undefined ? null : bY+(vy+1)*vs;
    }
    /** Ground top-surface world-Y of a column known to be uniformly fillFlat-stamped (non-fluid). null otherwise. Hot path: keeps no allocations. */
    getColumnUniformGroundY(x: number, z: number): number | null {
        const bX=this.bounds?.minX??0, bZ=this.bounds?.minZ??0, bY=this.bounds?.minY??0, EPS=1e-6, vs=this.voxelSize;
        const cx=Math.floor(Math.floor((x-bX+EPS)/vs)/CHUNK_SIZE), cz=Math.floor(Math.floor((z-bZ+EPS)/vs)/CHUNK_SIZE);
        const vy=this.columnTopIndex.getUniform(cx,cz); return vy===undefined ? null : bY+(vy+1)*vs;
    }

    getBlock(x: number, y: number, z: number): BlockID {
        const bX = this.bounds ? this.bounds.minX : 0, bY = this.bounds ? this.bounds.minY : 0, bZ = this.bounds ? this.bounds.minZ : 0, EPS = 1e-6;
        const vx = Math.floor((x - bX + EPS) / this.voxelSize), vy = Math.floor((y - bY + EPS) / this.voxelSize), vz = Math.floor((z - bZ + EPS) / this.voxelSize);
        return this.getBlockAtVoxel(vx, vy, vz);
    }

    /** Check if any chunk column at the given world position has dirty or deferred (unbuilt) data.
     *  Deferred chunks have stale physics colliders from previous terrain — raycasts against them
     *  would return wrong heights. Callers must use voxel-grid lookup instead. */
    isPositionChunkDirty(x: number, z: number): boolean {
        const bX = this.bounds?.minX ?? 0, bZ = this.bounds?.minZ ?? 0, EPS = 1e-6;
        const cx = Math.floor(Math.floor((x - bX + EPS) / this.voxelSize) / CHUNK_SIZE);
        const cz = Math.floor(Math.floor((z - bZ + EPS) / this.voxelSize) / CHUNK_SIZE);
        for (const chunk of this.dirtyChunks) {
            for (const [key, c] of this.chunks) {
                if (c === chunk) { const p = key.split(','); if (p.length === 3 && parseInt(p[0]!, 10) === cx && parseInt(p[2]!, 10) === cz) return true; break; }
            }
        }
        for (const entry of this.deferredDirtyChunks) {
            const p = entry.key.split(',');
            if (p.length === 3 && parseInt(p[0]!, 10) === cx && parseInt(p[2]!, 10) === cz) return true;
        }
        return false;
    }

    getAllBlocks(): Array<{ x: number; y: number; z: number; blockType: number }> {
        const blocks: Array<{ x: number; y: number; z: number; blockType: number }> = [];
        for (const [key, chunk] of this.chunks.entries()) {
            const parts = key.split(','); if (parts.length !== 3) continue;
            const [cxS, cyS, czS] = parts; if (!cxS || !cyS || !czS) continue;
            const cx = parseInt(cxS, 10), cy = parseInt(cyS, 10), cz = parseInt(czS, 10);
            if (isNaN(cx) || isNaN(cy) || isNaN(cz)) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                const blockType = chunk.get(lx, ly, lz);
                if (blockType !== 0) blocks.push({ x: cx * CHUNK_SIZE + lx, y: cy * CHUNK_SIZE + ly, z: cz * CHUNK_SIZE + lz, blockType });
            }
        }
        return blocks;
    }

    setBlock(x: number, y: number, z: number, block: BlockID, color?: number): void {
        const bX = this.bounds ? this.bounds.minX : 0, bY = this.bounds ? this.bounds.minY : 0, bZ = this.bounds ? this.bounds.minZ : 0, EPS = 1e-6;
        const vx = Math.floor((x - bX + EPS) / this.voxelSize), vy = Math.floor((y - bY + EPS) / this.voxelSize), vz = Math.floor((z - bZ + EPS) / this.voxelSize);
        const cx = Math.floor(vx / CHUNK_SIZE), cy = Math.floor(vy / CHUNK_SIZE), cz = Math.floor(vz / CHUNK_SIZE);
        const chunk = this.getChunk(cx, cy, cz);
        const lx = vx & CHUNK_MASK, ly = vy & CHUNK_MASK, lz = vz & CHUNK_MASK;
        const old = chunk.get(lx, ly, lz);
        if (old === block && color === undefined) return;
        if (this.mutationObserver) {
            this.mutationObserver(vx, vy, vz, block, color);
        }
        chunk.set(lx, ly, lz, block);
        if (color !== undefined) {
            chunk.colors.set(lx, ly, lz, color);
        } else if (block === 0) {
            // If setting to air, clear color
            chunk.colors.set(lx, ly, lz, 0);
        }
        this.dirtyChunks.add(chunk);
        
        // Invalidate height cache for this column
        this.invalidateHeightCacheAt(vx, vz);
        // Invalidate smooth height cache when terrain changes
        this.smoothSurfaceManager.invalidateCache();
        
        // Mark chunk checksum as dirty for efficient change detection
        const chunkKey = this.getChunkKey(cx, cy, cz);
        this.dirtyChecksumChunks.add(chunkKey);
        if (this.columnTopIndex.invalidateUniform(cx, cz)) evictChunkFromInstance(this.instancingState, chunkKey);
        if (block !== 0) this.columnTopIndex.bump(cx, cz, vy);

        // Also mark 6 neighbors if on border
        if (lx === 0) this.markDirty(cx - 1, cy, cz);
        if (lx === 15) this.markDirty(cx + 1, cy, cz);
        if (ly === 0) this.markDirty(cx, cy - 1, cz);
        if (ly === 15) this.markDirty(cx, cy + 1, cz);
        if (lz === 0) this.markDirty(cx, cy, cz - 1);
        if (lz === 15) this.markDirty(cx, cy, cz + 1);

        // Auto-rebuild dirty chunks on the next microtask, so a burst of setBlock
        // calls in one synchronous task rebuilds exactly once after the burst.
        // Callers that manage their own rebuild cadence opt out via either
        // beginBatchUpdate() (paired with endBatchUpdate()) or suppressAutoRebuild().
        if (!this.batchMode && !this.autoRebuildSuppressed && !this.autoRebuildScheduled) {
            this.autoRebuildScheduled = true;
            queueMicrotask(() => {
                this.autoRebuildScheduled = false;
                this.rebuildDirtyChunks();
            });
        }
    }

    /** Fast block setting for bulk generation - skips cache invalidation. Call finalizeBulkGeneration() when done. */
    setBlockFast(x: number, y: number, z: number, block: BlockID, color?: number): void {
        const bX = this.bounds ? this.bounds.minX : 0, bY = this.bounds ? this.bounds.minY : 0, bZ = this.bounds ? this.bounds.minZ : 0, EPS = 1e-6;
        const vx = Math.floor((x - bX + EPS) / this.voxelSize), vy = Math.floor((y - bY + EPS) / this.voxelSize), vz = Math.floor((z - bZ + EPS) / this.voxelSize);
        const cx = Math.floor(vx / CHUNK_SIZE), cz = Math.floor(vz / CHUNK_SIZE), chunk = this.getChunk(cx, Math.floor(vy / CHUNK_SIZE), cz);
        chunk.set(vx & CHUNK_MASK, vy & CHUNK_MASK, vz & CHUNK_MASK, block);
        if (color !== undefined) chunk.colors.set(vx & CHUNK_MASK, vy & CHUNK_MASK, vz & CHUNK_MASK, color);
        this.dirtyChunks.add(chunk);
        if (this.columnTopIndex.invalidateUniform(cx, cz)) evictChunkFromInstance(this.instancingState, this.getChunkKey(cx, Math.floor(vy / CHUNK_SIZE), cz));
        if (block !== 0) this.columnTopIndex.bump(cx, cz, vy);
    }
    
    /** Call after setBlockFast() bulk generation to clear caches. */
    finalizeBulkGeneration(): void {
        this.heightCache.clear();
        this.smoothSurfaceManager.invalidateCache();
        for (const key of this.chunks.keys()) this.dirtyChecksumChunks.add(key);
    }

    /** Bulk-fill one chunk with a flat stack. See `VoxelChunk.fillFlat`. */
    fillChunkFlat(cx: number, cy: number, cz: number, surfaceLocalY: number, yLowLocal: number, surfaceBlock: BlockID, subLayers?: BlockID[]): void {
        const t0 = performance.now(); const chunk = this.getChunk(cx, cy, cz);
        chunk.fillFlat(surfaceLocalY, yLowLocal, surfaceBlock, subLayers);
        this.dirtyChunks.add(chunk); this.dirtyChecksumChunks.add(this.getChunkKey(cx, cy, cz));
        if (surfaceLocalY >= yLowLocal && surfaceLocalY >= 0) {
            const sy = cy * CHUNK_SIZE + Math.min(surfaceLocalY, CHUNK_SIZE - 1);
            if (surfaceBlock !== 0 && !getVoxelTextureAtlas().isFluidBlock(surfaceBlock)) this.columnTopIndex.bumpUniform(cx, cz, sy, surfaceBlock); else this.columnTopIndex.bump(cx, cz, sy);
        }
        this._fillChunkFlatCount++; this._fillChunkFlatTotalMs += performance.now() - t0;
    }

    /**
     * Bulk-clear all chunks overlapping a world-coordinate bounding box to air.
     * O(numChunks) instead of O(numBlocks). Call finalizeBulkGeneration() after.
     */
    clearChunksInBounds(minX: number, minZ: number, maxX: number, maxZ: number, minY: number, maxY: number): void {
        const bX = this.bounds ? this.bounds.minX : 0, bY = this.bounds ? this.bounds.minY : 0, bZ = this.bounds ? this.bounds.minZ : 0, EPS = 1e-6;
        const cxMin = Math.floor(Math.floor((minX - bX + EPS) / this.voxelSize) / CHUNK_SIZE);
        const cxMax = Math.floor(Math.floor((maxX - bX + EPS) / this.voxelSize) / CHUNK_SIZE);
        const cyMin = Math.floor(Math.floor((minY - bY + EPS) / this.voxelSize) / CHUNK_SIZE);
        const cyMax = Math.floor(Math.floor((maxY - bY + EPS) / this.voxelSize) / CHUNK_SIZE);
        const czMin = Math.floor(Math.floor((minZ - bZ + EPS) / this.voxelSize) / CHUNK_SIZE);
        const czMax = Math.floor(Math.floor((maxZ - bZ + EPS) / this.voxelSize) / CHUNK_SIZE);
        let cleared = 0;
        for (const [key, chunk] of this.chunks.entries()) {
            const parts = key.split(',');
            if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) continue;
            const cx = parseInt(parts[0], 10), cy = parseInt(parts[1], 10), cz = parseInt(parts[2], 10);
            if (isNaN(cx) || isNaN(cy) || isNaN(cz)) continue;
            if (cx >= cxMin && cx <= cxMax && cy >= cyMin && cy <= cyMax && cz >= czMin && cz <= czMax) {
                chunk.clearToAir();
                this.dirtyChunks.add(chunk);
                this.dirtyChecksumChunks.add(key);
                cleared++;
            }
        }
        console.log(`[VoxelWorld] clearChunksInBounds: cleared ${cleared} chunks`);
    }

    getColor(x: number, y: number, z: number): number {
        const bX = this.bounds ? this.bounds.minX : 0, bY = this.bounds ? this.bounds.minY : 0, bZ = this.bounds ? this.bounds.minZ : 0, EPS = 1e-6;
        const vx = Math.floor((x - bX + EPS) / this.voxelSize), vy = Math.floor((y - bY + EPS) / this.voxelSize), vz = Math.floor((z - bZ + EPS) / this.voxelSize);
        const cx = Math.floor(vx / CHUNK_SIZE), cy = Math.floor(vy / CHUNK_SIZE), cz = Math.floor(vz / CHUNK_SIZE);
        const chunk = this.chunks.get(this.getChunkKey(cx, cy, cz));
        if (!chunk) return 0;
        return chunk.colors.get(vx & CHUNK_MASK, vy & CHUNK_MASK, vz & CHUNK_MASK);
    }

    /** Get the height and type of the topmost solid voxel at (vx, vz). Uses cache. */
    private getTopmostVoxelInfo(vx: number, vz: number): { height: number; blockType: BlockID } {
        const k = `${vx},${vz}`, cached = this.heightCache.get(k);
        if (cached !== undefined) return cached;
        const cx = Math.floor(vx / CHUNK_SIZE), cz = Math.floor(vz / CHUNK_SIZE);
        const lx = ((vx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, lz = ((vz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        for (let cy = 20; cy >= -20; cy--) { const ch = this.chunks.get(`${cx},${cy},${cz}`); if (!ch) continue;
            for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) { const bt = ch.get(lx, ly, lz);
                if (bt !== 0) { const info = { height: cy * CHUNK_SIZE + ly, blockType: bt }; this.heightCache.set(k, info); return info; } } }
        const empty = { height: -Infinity, blockType: 0 as BlockID }; this.heightCache.set(k, empty); return empty;
    }
    /** Get the height of the topmost solid voxel at (vx, vz). Returns -Infinity if none. */
    getTopmostVoxelHeight(vx: number, vz: number): number { return this.getTopmostVoxelInfo(vx, vz).height; }
    /** Get height of topmost voxel IF it's the requested type. Returns -Infinity if topmost is different type or no voxel. */
    getTopmostVoxelHeightOfType(vx: number, vz: number, blockType: BlockID): number {
        const info = this.getTopmostVoxelInfo(vx, vz);
        return info.blockType === blockType ? info.height : -Infinity;
    }
    private invalidateHeightCacheAt(vx: number, vz: number): void { this.heightCache.delete(`${vx},${vz}`); }
    invalidateHeightCache(): void { this.heightCache.clear(); }

    enableSmoothSurfaceForBlockType(blockId: BlockID): void {
        this.smoothSurfaceManager.enableForBlockType(blockId);
        for (const chunk of this.chunks.values()) this.dirtyChunks.add(chunk);
    }
    disableSmoothSurfaceForBlockType(blockId: BlockID): void { this.smoothSurfaceManager.disableForBlockType(blockId); for (const chunk of this.chunks.values()) this.dirtyChunks.add(chunk); }
    isSmoothSurfaceEnabledForBlockType(blockId: BlockID): boolean { return this.smoothSurfaceManager.isEnabledForBlockType(blockId); }
    setSmoothSurfaceFilterDistance(distance: number): void { this.smoothSurfaceManager.setFilterDistance(distance); for (const chunk of this.chunks.values()) this.dirtyChunks.add(chunk); }
    getSmoothSurfaceFilterDistance(): number { return this.smoothSurfaceManager.getFilterDistance(); }
    
    /**
     * Create a HeightField collider for smooth surfaces.
     * This replaces chunked trimesh colliders with a single efficient heightfield.
     * Call this AFTER terrain generation is complete and smooth surfaces are enabled.
     * 
     * @param friction - Friction coefficient for the heightfield (default: 0.1 for snow)
     */
    createSmoothSurfaceHeightfield(friction: number = 0.1): void {
        console.log(`[SpawnHeight] createSmoothSurfaceHeightfield called with friction=${friction}`);
        if (!this.physicsWorld) return; // physics-only feature: nothing to build on the 2D lane

        if (!this.bounds) {
            console.warn('[SpawnHeight] Cannot create heightfield - bounds not set');
            return;
        }
        
        const smoothBlockTypes = this.smoothSurfaceManager.getSmoothBlockTypes();
        if (smoothBlockTypes.size === 0) {
            console.log('[SpawnHeight] No smooth block types enabled, skipping heightfield');
            return;
        }
        console.log(`[SpawnHeight] Smooth block types: ${Array.from(smoothBlockTypes).join(', ')}`);
        console.log(`[SpawnHeight] Bounds: X=${this.bounds.minX} to ${this.bounds.maxX}, Z=${this.bounds.minZ} to ${this.bounds.maxZ}, Y=${this.bounds.minY} to ${this.bounds.maxY}`);
        
        // Remove existing heightfield if any
        this.removeSmoothSurfaceHeightfield();
        
        const vs = this.voxelSize;
        const minX = this.bounds.minX, maxX = this.bounds.maxX;
        const minZ = this.bounds.minZ, maxZ = this.bounds.maxZ;
        const minY = this.bounds.minY; // Y offset for height values
        const worldSizeX = maxX - minX;
        const worldSizeZ = maxZ - minZ;
        
        // Scale heightfield resolution based on world size.
        // Target ~1 vertex per meter for smooth collision, capped at 512x512 for performance.
        const worldSizeMax = Math.max(worldSizeX, worldSizeZ);
        const targetResolution = Math.min(512, Math.max(64, Math.ceil(worldSizeMax)));
        const nsubdivs = targetResolution - 1;
        const numVertices = nsubdivs + 1;
        console.log(`[SpawnHeight] HeightField resolution: ${numVertices}x${numVertices} for ${worldSizeX.toFixed(0)}x${worldSizeZ.toFixed(0)}m world`);
        
        // Sample heights in column-major order (Rapier format)
        // Check ALL smooth block types and use the maximum height found
        const heights = new Float32Array(numVertices * numVertices);
        const blockTypeArray = Array.from(smoothBlockTypes);
        
        let minHeight = Infinity;
        
        for (let col = 0; col < numVertices; col++) {
            for (let row = 0; row < numVertices; row++) {
                // Map grid to world coordinates
                const worldX = minX + (col / nsubdivs) * worldSizeX;
                const worldZ = minZ + (row / nsubdivs) * worldSizeZ;
                
                // Convert world coords to voxel coords
                // The voxel system uses 0-based coordinates internally, but world is centered
                // Offset by bounds.min to convert world -> voxel
                const vx = (worldX - this.bounds.minX) / vs;
                const vz = (worldZ - this.bounds.minZ) / vs;
                
                // Get smooth spline height for each block type
                // The spline returns voxel Y, need to convert to world Y by adding bounds.minY
                let voxelY = 0;
                for (const blockType of blockTypeArray) {
                    const splineHeight = this.smoothSurfaceManager.getSmoothedHeight(vx, vz, blockType);
                    if (splineHeight > voxelY) {
                        voxelY = splineHeight;
                    }
                }
                // Convert voxel Y to world Y
                // Add vs because voxelY is the bottom of the voxel, surface is at top
                const worldY = (voxelY * vs) + minY + vs;
                
                heights[col * numVertices + row] = worldY;
                minHeight = Math.min(minHeight, worldY);
            }
        }
        
        // Rapier heightfield: body at center of X-Z plane, heights are absolute Y values
        // scale.x/z = total size of terrain, scale.y = height multiplier (1.0 = use heights directly)
        const centerX = (minX + maxX) / 2;
        const centerZ = (minZ + maxZ) / 2;
        const scale = { x: worldSizeX, y: 1.0, z: worldSizeZ };
        
        // Body at center of terrain, y=0 since heights are absolute world Y
        const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, 0, centerZ);
        this.smoothHeightfieldBody = this.physicsWorld.createRigidBody(bodyDesc);
        
        try {
            // Fill gaps with a reasonable default (minHeight) so there's still collision there
            const defaultHeight = minHeight > 0 ? minHeight : 1.0;
            for (let i = 0; i < heights.length; i++) {
                if (heights[i]! < defaultHeight + 0.1) {
                    heights[i] = defaultHeight; // Ensure minimum collision surface
                }
            }
            
            const colliderDesc = RAPIER.ColliderDesc.heightfield(nsubdivs, nsubdivs, heights, scale)
                .setFriction(friction)
                .setCollisionGroups(makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN))
                .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
            
            this.smoothHeightfieldCollider = this.physicsWorld.createCollider(colliderDesc, this.smoothHeightfieldBody);
            
            if (!this.smoothHeightfieldCollider) {
                console.error('[SpawnHeight] HeightField collider is null after creation!');
            } else {
                console.log(`[SpawnHeight] HeightField created: ${numVertices}x${numVertices} vertices, center=(${centerX}, ${centerZ}), size=${worldSizeX}x${worldSizeZ}m, friction=${friction}`);
            }
        } catch (e) {
            console.error('[VoxelWorld] Failed to create heightfield collider:', e);
            if (this.smoothHeightfieldBody) {
                this.physicsWorld.removeRigidBodyImmediate(this.smoothHeightfieldBody);
                this.smoothHeightfieldBody = null;
            }
        }
    }
    
    /**
     * Remove the smooth surface heightfield collider.
     */
    removeSmoothSurfaceHeightfield(): void {
        if (!this.physicsWorld) { this.smoothHeightfieldCollider = null; this.smoothHeightfieldBody = null; return; }
        if (this.smoothHeightfieldCollider) {
            this.physicsWorld.removeColliderImmediate(this.smoothHeightfieldCollider);
            this.smoothHeightfieldCollider = null;
        }
        if (this.smoothHeightfieldBody) {
            this.physicsWorld.removeRigidBodyImmediate(this.smoothHeightfieldBody);
            this.smoothHeightfieldBody = null;
        }
    }
    
    /**
     * Check if heightfield collider is active for smooth surfaces.
     */
    hasSmoothSurfaceHeightfield(): boolean {
        return this.smoothHeightfieldCollider !== null;
    }
    
    private markDirty(cx: number, cy: number, cz: number): void {
        const chunk = this.chunks.get(this.getChunkKey(cx, cy, cz));
        if (chunk) this.dirtyChunks.add(chunk);
    }

    // forceAll: process all chunks (initial load). playerPos: prioritize nearby chunks, limit distant ones
    updatePhysicsAndMeshing(forceAll: boolean = false, playerPos?: { x: number; z: number }): void {
        const bounds = this.bounds ? { minX: this.bounds.minX, minZ: this.bounds.minZ } : null;
        let chunksToProcess = forceAll ? Array.from(this.chunks.entries()) : Array.from(this.chunks.entries()).filter(([_, chunk]) => this.dirtyChunks.has(chunk));
        const processedChunkKeys = new Set<string>();
        this.resetPhysicsStats();
        let processedCount = 0, distantChunksProcessed = 0;
        if (playerPos && !forceAll && chunksToProcess.length > 1) chunksToProcess = sortChunksByDistance(chunksToProcess, playerPos, bounds, this.voxelSize);
        for (const [chunkKey, chunk] of chunksToProcess) {
            if (playerPos && !forceAll) {
                const dist = getChunkDistanceToPlayer(chunkKey, playerPos, bounds, this.voxelSize);
                if (dist > CHUNK_PRIORITY_CONFIG.NEAR_DISTANCE && distantChunksProcessed++ >= CHUNK_PRIORITY_CONFIG.MAX_DISTANT_CHUNKS) continue;
            }
            const parts = chunkKey.split(',');
            if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
                const cx = parseInt(parts[0], 10), cy = parseInt(parts[1], 10), cz = parseInt(parts[2], 10);
                if (!isNaN(cx) && !isNaN(cy) && !isNaN(cz)) {
                    try { this.updateChunkPhysicsAndVisuals(chunk, cx, cy, cz); processedChunkKeys.add(chunkKey); processedCount++; this.dirtyChunks.delete(chunk); }
                    catch (error) {
                        if (error instanceof Error && (error.message.includes('OOM') || error.message.includes('Aborted'))) {
                            const s = this.getPhysicsStats();
                            console.error(`Out of Memory! ${processedCount}/${chunksToProcess.length} chunks, ${s.totalBoxShapes} shapes.`); throw error;
                        }
                        throw error;
                    }
                }
            }
        }
        if (!playerPos || forceAll) this.dirtyChunks.clear();
        if (processedChunkKeys.size > 0) {
            this.updateCollisionVisualization(forceAll ? undefined : processedChunkKeys);
            forceAll ? this.updateShadowMesh() : this.scheduleShadowUpdate();
            this.triggerFluidMeshRebuild(processedChunkKeys);
        }
    }

    /** Enable lazy chunk generation - only builds chunks within radius initially, builds rest progressively. */
    enableLazyGeneration(): void {
        if (!this.lazyGeneration) {
            this.lazyGeneration = new VoxelLazyGeneration(
                () => this.chunks,
                () => this.voxelSize,
                () => this.bounds ? { minX: this.bounds.minX, minZ: this.bounds.minZ } : null,
                (chunkKey: ChunkKey) => this.buildSingleChunk(chunkKey),
                (chunkKeys: Set<string>) => this.updateCollisionVisualization(chunkKeys)
            );
        }
        this.lazyGeneration.enable();
    }
    
    private buildSingleChunk(chunkKey: ChunkKey): void {
        const parts = chunkKey.split(',');
        if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return;
        const cx = parseInt(parts[0], 10), cy = parseInt(parts[1], 10), cz = parseInt(parts[2], 10);
        if (isNaN(cx) || isNaN(cy) || isNaN(cz)) return;
        const chunk = this.chunks.get(chunkKey);
        if (chunk) this.updateChunkPhysicsAndVisuals(chunk, cx, cy, cz);
    }
    
    updatePhysicsAndMeshingInRadius(centerX: number, centerZ: number, radius: number): void {
        const t0 = performance.now();
        this.enableLazyGeneration();
        this.resetPhysicsStats();
        const result = this.lazyGeneration!.buildChunksInRadius(centerX, centerZ, radius);
        this.dirtyChunks.clear();
        this.updateShadowMesh();
        console.log(`[VoxelWorld] Lazy init: ${result.built} in radius, ${result.deferred} deferred (${(performance.now() - t0).toFixed(1)}ms)`);
    }
    
    buildPendingChunksNear(playerX: number, playerZ: number, maxChunks: number = 1, buildRadius: number = 200): void { this.lazyGeneration?.buildPendingChunksNear(playerX, playerZ, maxChunks, buildRadius); }
    
    getLazyGenerationStats() { return this.lazyGeneration?.getStats() ?? { builtChunks: this.chunks.size, pendingChunks: 0, totalChunks: this.chunks.size }; }
    isLazyGenerationComplete(): boolean { return this.lazyGeneration?.isComplete() ?? true; }

    private updateChunkPhysics(chunk: Chunk, cx: number, cy: number, cz: number): void {
        // Voxels colliders of the face neighbours, for seam coupling (see VoxelColliders.ts).
        const neighbourVoxelColliders = (dx: number, dy: number, dz: number): RAPIER.Collider[] | undefined =>
            this.chunks.get(this.getChunkKey(cx + dx, cy + dy, cz + dz))?.voxelColliders.map(v => v.collider);
        if (chunk.body && this.physicsWorld) {
            // A coupled neighbour keeps believing our cells exist unless told otherwise — clear
            // the seam marks BEFORE the colliders go, or bodies pass through the seam.
            decoupleChunkVoxelColliders(chunk.voxelColliders, CHUNK_SIZE, neighbourVoxelColliders);
            for (const collider of chunk.colliders) this.physicsWorld.removeColliderImmediate(collider);
            this.physicsStats.totalTriMeshShapes -= chunk.colliders.length;
            chunk.colliders = []; chunk.voxelColliders = [];
            this.physicsWorld.removeRigidBodyImmediate(chunk.body);
            if (chunk.collisionMesh) { delete chunk.collisionMesh.userData.physicsBody; delete chunk.collisionMesh.userData.collisionGroup; delete chunk.collisionMesh.userData.collisionMask; }
            this.physicsStats.totalRigidBodies--;
            this.physicsStats.totalCompoundShapes--;
        }
        const hasVoxels = chunk.palette.length > 1, hasMergedDebris = chunk.mergedDebris.length > 0;
        const clearPhysicsUserData = () => { if (chunk.collisionMesh) { delete chunk.collisionMesh.userData.physicsBody; delete chunk.collisionMesh.userData.collisionGroup; delete chunk.collisionMesh.userData.collisionMask; } };
        if (!hasVoxels && !hasMergedDebris) { chunk.body = null; clearPhysicsUserData(); this.onChunkPhysicsRebuilt?.(this.getChunkKey(cx, cy, cz), null, cx, cy, cz); return; }
        
        const greedyBoxes = hasVoxels ? this.greedyMeshBoxes(chunk) : [], fluidBoxes = hasVoxels ? this.greedyMeshFluidBoxes(chunk) : [];
        
        // If heightfield is active, skip smooth surface blocks entirely (they use heightfield collision)
        // Otherwise, split smooth-surface boxes into 1x1 units for proper physics interpolation
        const useHeightfield = this.hasSmoothSurfaceHeightfield();
        const solidBoxes: CollisionBox[] = []; for (const box of greedyBoxes) { const bt = box.blockType;
            const isSmooth = bt !== undefined && this.smoothSurfaceManager.isEnabledForBlockType(bt);
            if (useHeightfield && isSmooth) {
                // Skip smooth blocks - heightfield handles their collision
                continue;
            } else if (isSmooth && (box.w > 1 || box.d > 1)) {
                for (let dz = 0; dz < box.d; dz++) for (let dx = 0; dx < box.w; dx++) solidBoxes.push({ x: box.x + dx, y: box.y, z: box.z + dz, w: 1, h: box.h, d: 1, blockType: bt });
            } else solidBoxes.push(box); }
        if (solidBoxes.length === 0 && fluidBoxes.length === 0 && !hasMergedDebris) { chunk.body = null; chunk.collisionBoxes = null; clearPhysicsUserData(); this.onChunkPhysicsRebuilt?.(this.getChunkKey(cx, cy, cz), null, cx, cy, cz); return; }
        chunk.collisionBoxes = solidBoxes.length > 0 ? solidBoxes : null;
        // 2D lane: `collisionBoxes` above is MESH input too (the visual chunk mesh reads it), so this
        // return must sit after that assignment and before the first Rapier call — one line earlier
        // renders a black world. See VoxelWorldNullPhysics.test.ts.
        if (!this.physicsWorld) { chunk.body = null; chunk.colliders = []; chunk.voxelColliders = []; clearPhysicsUserData(); this.onChunkPhysicsRebuilt?.(this.getChunkKey(cx, cy, cz), chunk.collisionBoxes, cx, cy, cz); return; }
        const bx = this.bounds?.minX ?? 0, by = this.bounds?.minY ?? 0, bz = this.bounds?.minZ ?? 0;
        const chunkWorldX = bx + cx * CHUNK_SIZE * this.voxelSize, chunkWorldY = by + cy * CHUNK_SIZE * this.voxelSize, chunkWorldZ = bz + cz * CHUNK_SIZE * this.voxelSize;

        const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
        const body = this.physicsWorld.createRigidBody(rigidBodyDesc);
        chunk.body = body;
        chunk.colliders = [];
        
        const collisionGroups = makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN);
        // Group boxes by friction for per-material physics colliders
        const atlas = getVoxelTextureAtlas(), boxesByFriction = new Map<number, CollisionBox[]>();
        for (const box of solidBoxes) {
            const friction = box.blockType !== undefined ? atlas.getBlockGrip(box.blockType) : 0.5;
            const key = Math.round(friction * 1000);
            if (!boxesByFriction.has(key)) boxesByFriction.set(key, []); boxesByFriction.get(key)!.push(box); }
        if (chunk.mergedDebris?.length && !boxesByFriction.has(500)) boxesByFriction.set(500, []); // Debris uses default friction
        // Create separate collider for each material friction group. In voxels
        // mode, plain boxes become one voxels collider per group; smooth-surface
        // boxes stay on the trimesh path (cube cells can't carry the interpolated
        // smooth geometry buildTrimeshFromBoxes emits), as does merged debris.
        const useVoxelColliders = voxelCollidersEnabled();
        for (const [frictionKey, boxes] of boxesByFriction) { const friction = frictionKey / 1000;
            const debris = frictionKey === 500 ? chunk.mergedDebris : undefined;
            let trimeshBoxes = boxes;
            if (useVoxelColliders) {
                const plain: CollisionBox[] = []; const smooth: CollisionBox[] = [];
                for (const box of boxes) {
                    const bt = box.blockType;
                    (bt !== undefined && this.smoothSurfaceManager.isEnabledForBlockType(bt) ? smooth : plain).push(box);
                }
                if (plain.length > 0) {
                    const cells = cellsFromIntBoxes(plain);
                    const voxDesc = voxelsDesc(cells, this.voxelSize, this.voxelSize, this.voxelSize, chunkWorldX, chunkWorldY, chunkWorldZ)
                        .setCollisionGroups(collisionGroups).setFriction(friction).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
                    const collider = this.physicsWorld.createCollider(voxDesc, body);
                    chunk.colliders.push(collider); chunk.voxelColliders.push({ collider, cells }); this.physicsStats.totalTriMeshShapes++;
                }
                if (smooth.length === 0 && !debris?.length) continue;
                trimeshBoxes = smooth;
            }
            const trimeshData = this.buildTrimeshFromBoxes(trimeshBoxes, chunkWorldX, chunkWorldY, chunkWorldZ, debris, chunk, cx, cy, cz);
            if (trimeshData) { const colliderDesc = RAPIER.ColliderDesc.trimesh(trimeshData.vertices, trimeshData.indices, 144).setCollisionGroups(collisionGroups).setFriction(friction).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
                chunk.colliders.push(this.physicsWorld.createCollider(colliderDesc, body)); this.physicsStats.totalTriMeshShapes++; } }
        
        // Water SENSOR collider - detects overlap without blocking movement
        if (fluidBoxes.length > 0) {
            const waterTrimesh = this.buildTrimeshFromBoxes(fluidBoxes, chunkWorldX, chunkWorldY, chunkWorldZ);
            if (waterTrimesh) {
                const sensorDesc = RAPIER.ColliderDesc.trimesh(waterTrimesh.vertices, waterTrimesh.indices).setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
                const sensor = this.physicsWorld.createCollider(sensorDesc, body); sensor.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL); chunk.colliders.push(sensor);
                let maxY = chunkWorldY; for (const box of fluidBoxes) maxY = Math.max(maxY, chunkWorldY + (box.y + box.h) * this.voxelSize);
                const buoyancy = getWaterBuoyancySystem(); if (!buoyancy['initialized']) buoyancy.initialize(this.physicsWorld); buoyancy.registerWaterSensor(sensor, 1000, maxY - this.voxelSize / 8);
            }
        }
        // Every collider of this chunk exists now: couple the voxels ones with each other and
        // with the six neighbours, so a body crossing a chunk seam meets no phantom faces.
        coupleChunkVoxelColliders(chunk.voxelColliders.map(v => v.collider), CHUNK_SIZE, neighbourVoxelColliders);
        registerPhysicsBody(body, 'voxel-chunk'); this.physicsStats.totalRigidBodies++;
        if (this.physicsStats.lastUpdateStats) { this.physicsStats.lastUpdateStats.chunksProcessed++; this.physicsStats.lastUpdateStats.rigidBodiesCreated++; this.physicsStats.lastUpdateStats.triMeshShapesCreated++; }
        if (chunk.collisionMesh) Object.assign(chunk.collisionMesh.userData, { physicsBody: body, collisionGroup: CollisionGroup.TERRAIN, collisionMask: CollisionMask.TERRAIN });
    }
    
    private greedyMeshFluidBoxes(chunk: Chunk): CollisionBox[] { const atlas = getVoxelTextureAtlas(); return generateCollisionBoxes(chunk, (b) => !atlas.isFluidBlock(b)); }
    
    // Physics mesh subdivision for smooth surfaces (4x4 grid = 32 triangles per voxel vs 2)
    private readonly SMOOTH_PHYSICS_SUBDIVISIONS = 4;
    
    private buildTrimeshFromBoxes(boxes: CollisionBox[], chunkWorldX: number, chunkWorldY: number, chunkWorldZ: number, mergedDebris?: MergedDebris[], chunk?: Chunk, cx?: number, cy?: number, cz?: number): { vertices: Float32Array; indices: Uint32Array } | null {
        const debrisCount = mergedDebris?.length ?? 0; if (boxes.length === 0 && debrisCount === 0) return null;
        const gX = (cx ?? 0) * CHUNK_SIZE, gY = (cy ?? 0) * CHUNK_SIZE, gZ = (cz ?? 0) * CHUNK_SIZE;
        const sm = this.smoothSurfaceManager, vs = this.voxelSize, subdiv = this.SMOOTH_PHYSICS_SUBDIVISIONS;
        
        // Separate smooth and non-smooth boxes
        const smoothBoxes: CollisionBox[] = [], regularBoxes: CollisionBox[] = [];
        for (const box of boxes) {
            const bt = box.blockType;
            if (bt !== undefined && sm.isEnabledForBlockType(bt)) smoothBoxes.push(box);
            else regularBoxes.push(box);
        }
        
        // Calculate buffer sizes: regular = 8 verts + 36 indices per box
        // Smooth top surface: (subdiv+1)^2 verts + subdiv^2*2*3 indices, plus 4 side faces (8 verts + 24 indices)
        const regularVertCount = regularBoxes.length * 8, regularIdxCount = regularBoxes.length * 36;
        const smoothVertsPerBox = (subdiv + 1) * (subdiv + 1) + 8, smoothIdxPerBox = subdiv * subdiv * 6 + 24;
        const totalVerts = regularVertCount + smoothBoxes.length * smoothVertsPerBox + debrisCount * 8;
        const totalIdx = regularIdxCount + smoothBoxes.length * smoothIdxPerBox + debrisCount * 36;
        
        const vertices = new Float32Array(totalVerts * 3), indices = new Uint32Array(totalIdx);
        const boxIndices = [0,2,1,0,3,2,4,5,6,4,6,7,0,4,7,0,7,3,1,2,6,1,6,5,0,1,5,0,5,4,3,7,6,3,6,2];
        let vIdx = 0, iIdx = 0;
        
        // Build regular boxes (non-smooth) - simple 8-vertex cubes
        for (const box of regularBoxes) {
            const x = chunkWorldX + box.x * vs, y = chunkWorldY + box.y * vs, z = chunkWorldZ + box.z * vs;
            const w = box.w * vs, h = box.h * vs, d = box.d * vs, baseV = vIdx / 3;
            vertices[vIdx++]=x; vertices[vIdx++]=y; vertices[vIdx++]=z; vertices[vIdx++]=x+w; vertices[vIdx++]=y; vertices[vIdx++]=z;
            vertices[vIdx++]=x+w; vertices[vIdx++]=y+h; vertices[vIdx++]=z; vertices[vIdx++]=x; vertices[vIdx++]=y+h; vertices[vIdx++]=z;
            vertices[vIdx++]=x; vertices[vIdx++]=y; vertices[vIdx++]=z+d; vertices[vIdx++]=x+w; vertices[vIdx++]=y; vertices[vIdx++]=z+d;
            vertices[vIdx++]=x+w; vertices[vIdx++]=y+h; vertices[vIdx++]=z+d; vertices[vIdx++]=x; vertices[vIdx++]=y+h; vertices[vIdx++]=z+d;
            for (const bi of boxIndices) indices[iIdx++] = baseV + bi;
        }
        
        // Build smooth boxes with subdivided top surface for proper physics
        for (const box of smoothBoxes) {
            const x = chunkWorldX + box.x * vs, y = chunkWorldY + box.y * vs, z = chunkWorldZ + box.z * vs;
            const w = vs, h = box.h * vs, d = vs; // Each smooth box is 1x1 after splitting
            const bt = box.blockType!, ty = gY + box.y + box.h - 1, cVx = gX + box.x + 0.5, cVz = gZ + box.z + 0.5;
            const topBaseV = vIdx / 3;
            
            // Generate subdivided top surface grid
            for (let sz = 0; sz <= subdiv; sz++) {
                for (let sx = 0; sx <= subdiv; sx++) {
                    const fx = sx / subdiv, fz = sz / subdiv;
                    const sampleX = gX + box.x + fx, sampleZ = gZ + box.z + fz;
                    const smoothY = sm.calculateSmoothOffset(sampleX, sampleZ, cVx, cVz, ty, bt, vs);
                    vertices[vIdx++] = x + fx * w;
                    vertices[vIdx++] = y + h + smoothY;
                    vertices[vIdx++] = z + fz * d;
                }
            }
            // Generate top surface triangles
            for (let sz = 0; sz < subdiv; sz++) {
                for (let sx = 0; sx < subdiv; sx++) {
                    const i00 = topBaseV + sz * (subdiv + 1) + sx;
                    const i10 = i00 + 1, i01 = i00 + (subdiv + 1), i11 = i01 + 1;
                    indices[iIdx++] = i00; indices[iIdx++] = i01; indices[iIdx++] = i11;
                    indices[iIdx++] = i00; indices[iIdx++] = i11; indices[iIdx++] = i10;
                }
            }
            
            // Add side faces (simplified - just 4 walls using corner heights from top grid)
            const sideBaseV = vIdx / 3;
            const h00 = vertices[(topBaseV) * 3 + 1]!, h10 = vertices[(topBaseV + subdiv) * 3 + 1]!;
            const h01 = vertices[(topBaseV + subdiv * (subdiv + 1)) * 3 + 1]!, h11 = vertices[(topBaseV + subdiv * (subdiv + 1) + subdiv) * 3 + 1]!;
            // Bottom corners + top corners for 4 side walls
            vertices[vIdx++]=x; vertices[vIdx++]=y; vertices[vIdx++]=z;       // 0: bottom front-left
            vertices[vIdx++]=x+w; vertices[vIdx++]=y; vertices[vIdx++]=z;     // 1: bottom front-right
            vertices[vIdx++]=x+w; vertices[vIdx++]=y; vertices[vIdx++]=z+d;   // 2: bottom back-right
            vertices[vIdx++]=x; vertices[vIdx++]=y; vertices[vIdx++]=z+d;     // 3: bottom back-left
            vertices[vIdx++]=x; vertices[vIdx++]=h00; vertices[vIdx++]=z;     // 4: top front-left
            vertices[vIdx++]=x+w; vertices[vIdx++]=h10; vertices[vIdx++]=z;   // 5: top front-right
            vertices[vIdx++]=x+w; vertices[vIdx++]=h11; vertices[vIdx++]=z+d; // 6: top back-right
            vertices[vIdx++]=x; vertices[vIdx++]=h01; vertices[vIdx++]=z+d;   // 7: top back-left
            // Side faces: -Z, +Z, -X, +X (skip bottom)
            const s = sideBaseV;
            indices[iIdx++]=s+0; indices[iIdx++]=s+4; indices[iIdx++]=s+5; indices[iIdx++]=s+0; indices[iIdx++]=s+5; indices[iIdx++]=s+1; // -Z
            indices[iIdx++]=s+2; indices[iIdx++]=s+6; indices[iIdx++]=s+7; indices[iIdx++]=s+2; indices[iIdx++]=s+7; indices[iIdx++]=s+3; // +Z
            indices[iIdx++]=s+3; indices[iIdx++]=s+7; indices[iIdx++]=s+4; indices[iIdx++]=s+3; indices[iIdx++]=s+4; indices[iIdx++]=s+0; // -X
            indices[iIdx++]=s+1; indices[iIdx++]=s+5; indices[iIdx++]=s+6; indices[iIdx++]=s+1; indices[iIdx++]=s+6; indices[iIdx++]=s+2; // +X
        }
        
        // Add debris
        if (mergedDebris) for (const debris of mergedDebris) { const baseV = vIdx / 3; for (let i = 0; i < 24; i++) vertices[vIdx++] = debris.vertices[i]!; for (const bi of boxIndices) indices[iIdx++] = baseV + bi; }
        
        return { vertices: vertices.slice(0, vIdx), indices: indices.slice(0, iIdx) }; }

    private updateChunkPhysicsAndVisuals(chunk: Chunk, cx: number, cy: number, cz: number): void { this.updateChunkPhysics(chunk, cx, cy, cz); }

    /** Check if a block type is transparent for face culling (air or fluid). */
    private isTransparentForCulling(blockType: number): boolean {
        if (blockType === 0) return true;
        const atlas = getVoxelTextureAtlas();
        return atlas.isFluidBlock(blockType);
    }

    /** Check which faces of a box are exposed. Returns [-Z, +Z, -X, +X, -Y, +Y]. Treats fluid blocks as transparent. */
    private getExposedFaces(chunk: Chunk, box: CollisionBox, cx: number, cy: number, cz: number): boolean[] {
        const exp = [true, true, true, true, true, true];
        const selfType = chunk.get((box.x + Math.floor(box.w / 2)) & 15, box.y & 15, (box.z + Math.floor(box.d / 2)) & 15);
        const selfSmooth = selfType !== 0 && this.smoothSurfaceManager.isEnabledForBlockType(selfType);
        const hasAdjSmooth = (x: number, z: number) => { for (let y = box.y; y < box.y + box.h; y++) { const t = chunk.get(x & 15, y & 15, z & 15); if (t !== 0 && this.smoothSurfaceManager.isEnabledForBlockType(t)) return true; } return false; };
        
        // -Z (0): keep visible if self or adjacent is smooth, or if adjacent is transparent (air/fluid)
        if (box.z > 0 && !selfSmooth) { let skip = false; for (let x = box.x; x < box.x + box.w && !skip; x++) if (hasAdjSmooth(x, box.z - 1)) skip = true;
            if (!skip) { let solid = true; for (let x = box.x; x < box.x + box.w && solid; x++) for (let y = box.y; y < box.y + box.h && solid; y++) if (this.isTransparentForCulling(chunk.get(x, y, box.z - 1))) solid = false; if (solid) exp[0] = false; } }
        // +Z (1)
        if (box.z + box.d < CHUNK_SIZE && !selfSmooth) { let skip = false; for (let x = box.x; x < box.x + box.w && !skip; x++) if (hasAdjSmooth(x, box.z + box.d)) skip = true;
            if (!skip) { let solid = true; for (let x = box.x; x < box.x + box.w && solid; x++) for (let y = box.y; y < box.y + box.h && solid; y++) if (this.isTransparentForCulling(chunk.get(x, y, box.z + box.d))) solid = false; if (solid) exp[1] = false; } }
        // -X (2)
        if (box.x > 0 && !selfSmooth) { let skip = false; for (let z = box.z; z < box.z + box.d && !skip; z++) if (hasAdjSmooth(box.x - 1, z)) skip = true;
            if (!skip) { let solid = true; for (let y = box.y; y < box.y + box.h && solid; y++) for (let z = box.z; z < box.z + box.d && solid; z++) if (this.isTransparentForCulling(chunk.get(box.x - 1, y, z))) solid = false; if (solid) exp[2] = false; } }
        // +X (3)
        if (box.x + box.w < CHUNK_SIZE && !selfSmooth) { let skip = false; for (let z = box.z; z < box.z + box.d && !skip; z++) if (hasAdjSmooth(box.x + box.w, z)) skip = true;
            if (!skip) { let solid = true; for (let y = box.y; y < box.y + box.h && solid; y++) for (let z = box.z; z < box.z + box.d && solid; z++) if (this.isTransparentForCulling(chunk.get(box.x + box.w, y, z))) solid = false; if (solid) exp[3] = false; } }
        // -Y (4): keep exposed if block below has smooth surface or is transparent
        if (box.y > 0) { let adjSmooth = false; for (let x = box.x; x < box.x + box.w && !adjSmooth; x++) for (let z = box.z; z < box.z + box.d && !adjSmooth; z++) { const bt = chunk.get(x, box.y - 1, z); if (bt !== 0 && this.smoothSurfaceManager.isEnabledForBlockType(bt)) adjSmooth = true; }
            if (!adjSmooth) { let solid = true; for (let x = box.x; x < box.x + box.w && solid; x++) for (let z = box.z; z < box.z + box.d && solid; z++) if (this.isTransparentForCulling(chunk.get(x, box.y - 1, z))) solid = false; if (solid) exp[4] = false; } }
        // +Y (5): keep exposed if block above has smooth surface or is transparent
        if (box.y + box.h < CHUNK_SIZE) { let adjSmooth = false; for (let x = box.x; x < box.x + box.w && !adjSmooth; x++) for (let z = box.z; z < box.z + box.d && !adjSmooth; z++) { const bt = chunk.get(x, box.y + box.h, z); if (bt !== 0 && this.smoothSurfaceManager.isEnabledForBlockType(bt)) adjSmooth = true; }
            if (!adjSmooth) { let solid = true; for (let x = box.x; x < box.x + box.w && solid; x++) for (let z = box.z; z < box.z + box.d && solid; z++) if (this.isTransparentForCulling(chunk.get(x, box.y + box.h, z))) solid = false; if (solid) exp[5] = false; } }
        return exp;
    }

    /**
     * For the rounding path, check face neighbors across chunk boundaries (patches
     * the chunk-boundary cases that getExposedFaces can't see across).
     */
    private getRoundingExposedFaces(chunk: Chunk, box: CollisionBox, cx: number, cy: number, cz: number): boolean[] {
        const exp = this.getExposedFaces(chunk, box, cx, cy, cz);
        const gx = cx * CHUNK_SIZE, gy = cy * CHUNK_SIZE, gz = cz * CHUNK_SIZE;
        const allSolid = (
            xLo: number, xHi: number, yLo: number, yHi: number, zLo: number, zHi: number,
        ): boolean => {
            for (let x = xLo; x <= xHi; x++) for (let y = yLo; y <= yHi; y++) for (let z = zLo; z <= zHi; z++) {
                if (!this.isSolidAtVoxel(x, y, z)) return false;
            }
            return true;
        };
        const x0 = gx + box.x, x1 = gx + box.x + box.w - 1;
        const y0 = gy + box.y, y1 = gy + box.y + box.h - 1;
        const z0 = gz + box.z, z1 = gz + box.z + box.d - 1;
        if (box.z === 0 && exp[0] && allSolid(x0, x1, y0, y1, z0 - 1, z0 - 1)) exp[0] = false;
        if (box.z + box.d >= CHUNK_SIZE && exp[1] && allSolid(x0, x1, y0, y1, z1 + 1, z1 + 1)) exp[1] = false;
        if (box.x === 0 && exp[2] && allSolid(x0 - 1, x0 - 1, y0, y1, z0, z1)) exp[2] = false;
        if (box.x + box.w >= CHUNK_SIZE && exp[3] && allSolid(x1 + 1, x1 + 1, y0, y1, z0, z1)) exp[3] = false;
        if (box.y === 0 && exp[4] && allSolid(x0, x1, y0 - 1, y0 - 1, z0, z1)) exp[4] = false;
        if (box.y + box.h >= CHUNK_SIZE && exp[5] && allSolid(x0, x1, y1 + 1, y1 + 1, z0, z1)) exp[5] = false;
        return exp;
    }

    /**
     * Compute 8 corner-rounding flags for a box in the rounding pass.
     * A corner is flagged true when it forms an L-shape concave inner corner:
     * exactly 2 of the 3 corner-faces are hidden (face neighbors present)
     * AND the diagonal voxel between those 2 hidden axes is empty.
     * In that case, two perpendicular rounded edges from the face neighbors
     * meet at this corner, so the corner sphere should be preserved.
     *
     * Octant index = ((sx>0 ? 1 : 0) << 2) | ((sy>0 ? 1 : 0) << 1) | (sz>0 ? 1 : 0)
     * Face indices in `exposedFaces`: [-Z=0, +Z=1, -X=2, +X=3, -Y=4, +Y=5]
     */
    private getCornerRoundedFlags(box: CollisionBox, exposedFaces: readonly boolean[], cx: number, cy: number, cz: number): boolean[] {
        const flags: boolean[] = [false, false, false, false, false, false, false, false];
        const gx = cx * CHUNK_SIZE, gy = cy * CHUNK_SIZE, gz = cz * CHUNK_SIZE;
        for (let i = 0; i < 8; i++) {
            const sxPos = (i & 4) !== 0;
            const syPos = (i & 2) !== 0;
            const szPos = (i & 1) !== 0;
            const sx = sxPos ? 1 : -1;
            const sy = syPos ? 1 : -1;
            const sz = szPos ? 1 : -1;
            const fx = sxPos ? 3 : 2;
            const fy = syPos ? 5 : 4;
            const fz = szPos ? 1 : 0;
            const hX = !exposedFaces[fx];
            const hY = !exposedFaces[fy];
            const hZ = !exposedFaces[fz];
            const hiddenCount = (hX ? 1 : 0) + (hY ? 1 : 0) + (hZ ? 1 : 0);
            if (hiddenCount !== 2) continue;
            // Corner-most voxel of the box in this octant
            const cvX = gx + box.x + (sxPos ? box.w - 1 : 0);
            const cvY = gy + box.y + (syPos ? box.h - 1 : 0);
            const cvZ = gz + box.z + (szPos ? box.d - 1 : 0);
            // Diagonal voxel: offset by sign on the 2 hidden axes
            const dx = cvX + (hX ? sx : 0);
            const dy = cvY + (hY ? sy : 0);
            const dz = cvZ + (hZ ? sz : 0);
            if (!this.isSolidAtVoxel(dx, dy, dz)) {
                flags[i] = true;
            }
        }
        return flags;
    }

    /** Sample a voxel's blockType and color (null if empty/fluid). Cross-chunk. */
    private sampleSolidVoxelInfo(vx: number, vy: number, vz: number): DiagonalVoxelInfo | null {
        const ccx = Math.floor(vx / CHUNK_SIZE), ccy = Math.floor(vy / CHUNK_SIZE), ccz = Math.floor(vz / CHUNK_SIZE);
        const ch = this.chunks.get(this.getChunkKey(ccx, ccy, ccz));
        if (!ch) return null;
        const lx = vx & CHUNK_MASK, ly = vy & CHUNK_MASK, lz = vz & CHUNK_MASK;
        const bt = ch.get(lx, ly, lz);
        if (bt === 0) return null;
        const atlas = getVoxelTextureAtlas();
        if (atlas.isFluidBlock(bt)) return null;
        const c24 = ch.colors.get(lx, ly, lz);
        return { blockType: bt, r: ((c24 >> 16) & 255) / 255, g: ((c24 >> 8) & 255) / 255, b: (c24 & 255) / 255 };
    }

    private greedyMeshBoxes(chunk: Chunk): CollisionBox[] {
        // Skip fluid blocks during greedy meshing - they shouldn't have collision
        const atlas = getVoxelTextureAtlas();
        return generateCollisionBoxes(chunk, (blockType) => atlas.isFluidBlock(blockType));
    }
    
    /** Get block type adjacent to box in direction (0=-Z, 1=+Z, 2=-X, 3=+X). Returns 0 if out of bounds. */
    private getAdjacentBlockType(chunk: Chunk, box: CollisionBox, f: number, cx: number, cy: number, cz: number): number {
        const y = box.y & 15, cX = box.x + Math.floor(box.w / 2), cZ = box.z + Math.floor(box.d / 2);
        if (f === 0) return box.z > 0 ? chunk.get(cX & 15, y, (box.z - 1) & 15) : 0;
        if (f === 1) return box.z + box.d < CHUNK_SIZE ? chunk.get(cX & 15, y, (box.z + box.d) & 15) : 0;
        if (f === 2) return box.x > 0 ? chunk.get((box.x - 1) & 15, y, cZ & 15) : 0;
        if (f === 3) return box.x + box.w < CHUNK_SIZE ? chunk.get((box.x + box.w) & 15, y, cZ & 15) : 0;
        return 0;
    }

    // Reveal effect methods
    enableRevealEffect(): void {
        this.revealMode = true;
        this.revealProgress = 0;

        // Count total solid voxels across all chunks
        let totalVoxels = 0;
        const offsets: THREE.Vector3[] = [];
        const chunkPositions: THREE.Vector3[] = [];

        for (const [key, chunk] of this.chunks) {
            const parts = key.split(',');
            if (parts.length !== 3) continue;
            const cxStr = parts[0];
            const cyStr = parts[1];
            const czStr = parts[2];
            if (!cxStr || !cyStr || !czStr) continue;
            const cx = parseInt(cxStr, 10);
            const cy = parseInt(cyStr, 10);
            const cz = parseInt(czStr, 10);
            if (isNaN(cx) || isNaN(cy) || isNaN(cz)) continue;
            const worldOffset = new THREE.Vector3(cx * 16, cy * 16, cz * 16);

            let pos = 0; // iterate RLE for solid voxels
            chunk.forEachRun((paletteIndex, len) => {
                const blockId = chunk.palette[paletteIndex] ?? 0;

                if (blockId === 0) {
                    pos += len;
                    return;
                }

                for (let j = 0; j < len; j++) {
                    const vx = pos % 16;
                    const vy = Math.floor(pos / 256);
                    const vz = Math.floor((pos / 16)) % 16;
                    offsets.push(new THREE.Vector3(
                        worldOffset.x + vx + 0.5,
                        worldOffset.y + vy + 0.5,
                        worldOffset.z + vz + 0.5
                    ));
                    totalVoxels++;
                    pos++;
                }
            });
        }

        if (totalVoxels === 0) return;

        const geometry = new THREE.BoxGeometry(1, 1, 1);
        // Per-instance scale + visibility, applied two ways depending on backend.
        let material: THREE.Material;
        if (isWebGpuActive()) {
            const nodeMat = new MeshStandardNodeMaterial({ color: 0xffffff });
            nodeMat.positionNode = Fn(() => {
                const scale = attribute('instanceScale', 'float' as const);
                const visible = attribute('instanceVisible', 'float' as const);
                const transformed = positionLocal.mul(scale).toVar();
                If(visible.lessThan(0.5), () => {
                    transformed.assign(vec3(0, 0, 0));
                });
                return transformed;
            })();
            material = nodeMat;
        } else {
            const stdMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
            stdMat.onBeforeCompile = (shader) => {
                shader.uniforms.time = { value: 0 };
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    `
                    float scale = instanceScale;
                    float visible = instanceVisible;
                    vec3 transformed = vec3(position) * scale;
                    if (visible < 0.5) transformed = vec3(0.0); // cull if invisible
                    `
                );
            };
            material = stdMat;
        }

        const instanced = new THREE.InstancedMesh(geometry, material, totalVoxels);
        instanced.name = 'VoxelRevealEffect';
        instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        instanced.frustumCulled = false;

        this.revealScales = new Float32Array(totalVoxels);
        this.revealVisible = new Uint8Array(totalVoxels);

        // Start invisible and zero scale
        this.revealScales.fill(0);
        this.revealVisible.fill(0);

        instanced.geometry.setAttribute(
            'instanceScale',
            new THREE.InstancedBufferAttribute(this.revealScales, 1)
        );
        instanced.geometry.setAttribute(
            'instanceVisible',
            new THREE.InstancedBufferAttribute(this.revealVisible, 1)
        );

        // Apply positions
        const dummy = new THREE.Object3D();
        offsets.forEach((pos, i) => {
            dummy.position.copy(pos);
            dummy.updateMatrix();
            instanced.setMatrixAt(i, dummy.matrix);
        });

        this.revealInstancedMesh = instanced;
        this.parentGroup.add(instanced);
    }

    updateRevealEffect(deltaTime: number): void {
        if (!this.revealMode || !this.revealInstancedMesh) return;
        this.revealProgress += deltaTime * 0.5; // adjust speed
        const total = this.revealScales!.length;
        const targetVisible = Math.floor(total * this.revealProgress);

        // Animate in order
        if (this.revealVisible && this.revealScales) {
            for (let i = 0; i < total; i++) {
                if (i < targetVisible) {
                    const currentScale = this.revealScales[i];
                    if (currentScale !== undefined) {
                        this.revealVisible[i] = 1;
                        this.revealScales[i] = Math.min(1, currentScale + deltaTime * 8);
                    }
                }
            }
        }

        if (this.revealInstancedMesh) {
            this.revealInstancedMesh.instanceMatrix.needsUpdate = true;
            const scaleAttr = this.revealInstancedMesh.geometry.attributes.instanceScale as THREE.InstancedBufferAttribute | undefined;
            if (scaleAttr) {
                scaleAttr.needsUpdate = true;
            }
        }
    }

    startRevealRandom(): void {
        if (!this.revealVisible || !this.revealScales) return;
        const order = Array.from({ length: this.revealScales.length }, (_, i) => i);
        order.sort(() => Math.random() - 0.5);
        let idx = 0;
        const interval = setInterval(() => {
            if (idx >= order.length) {
                clearInterval(interval);
                return;
            }
            const i = order[idx++];
            if (i !== undefined && this.revealVisible && this.revealScales) {
                this.revealVisible[i] = 1;
                this.revealScales[i] = 0.01;
            }
        }, 2); // 500 voxels per second
    }

    // Save: emits VXL v3 (gzipped binary, ~30× smaller than the legacy JSON).
    // See VoxelWorldVxlIO.ts for the encoder + load-time format limits.
    async saveToFile(_filename: string, metadata?: {
        voxelSize?: number;
        bounds?: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number };
        transform?: { position?: { x: number, y: number, z: number }, rotation?: { x: number, y: number, z: number }, scale?: { x: number, y: number, z: number } };
    }): Promise<Uint8Array> {
        const ioView = { chunks: this.chunks, dirtyChunks: this.dirtyChunks, clear: () => this.clear() };
        return encodeVoxelWorldAsVxlV3(ioView, { voxelSize: metadata?.voxelSize ?? this.voxelSize, bounds: metadata?.bounds });
    }

    async loadFromFile(buffer: ArrayBuffer): Promise<{
        voxelSize?: number;
        bounds?: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number };
        transform?: { position?: { x: number, y: number, z: number }, rotation?: { x: number, y: number, z: number }, scale?: { x: number, y: number, z: number } };
    }> {
        // VXL v3 binary path. New collision saves (saveToFile above) emit this
        // format; older URLs still serve JSON and fall through to the parser
        // below. Magic-byte sniff is cheap (no copy, 4 bytes).
        if (isVxlV3(buffer)) {
            const ioView = { chunks: this.chunks, dirtyChunks: this.dirtyChunks, clear: () => this.clear() };
            const result = await loadVxlV3IntoVoxelWorld(ioView, buffer, () => new Chunk());
            if (result.voxelSize !== undefined) this.voxelSize = result.voxelSize;
            return result;
        }

        const decoder = new TextDecoder();
        const json = decoder.decode(buffer);

        let data: any;
        try {
            data = JSON.parse(json);
        } catch (error) {
            console.error(`Failed to parse voxel file:`, error);
            throw error;
        }

        if (data.version === 2) {
            // v2 octree files are handled by VoxelObject fallback in VoxelTerrainSystem
            return {};
        }
        
        // Handle both old format (direct chunks) and new format (with metadata)
        const chunksData = data.chunks || data;
        const metadata = data.metadata || {};
        
        if (metadata.voxelSize) {
            this.voxelSize = metadata.voxelSize;
        }
        
        // Build ID remapping table: savedId -> currentId
        // This handles the case where block types were created in a different order
        const idRemap = new Map<number, number>();
        idRemap.set(0, 0); // Air/NONE is always 0
        
        if (metadata.blockTypes) {
            const atlas = getVoxelTextureAtlas();
            const savedBlockTypes = metadata.blockTypes as Record<string, string>;
            
            for (const [savedIdStr, name] of Object.entries(savedBlockTypes)) {
                const savedId = parseInt(savedIdStr);
                const lowerName = name.toLowerCase();
                
                // Look up current ID for this block type name
                let currentId = atlas.getBlockTypeByName(lowerName);
                
                if (currentId === undefined) {
                    // Block type not registered - try to auto-register
                    const creator = BLOCK_TYPE_CREATORS[lowerName];
                    if (creator) {
                        currentId = creator(atlas);
                        console.log(`[VoxelWorld] Auto-registered block type '${name}' with ID ${currentId}`);
                    } else {
                        console.warn(`[VoxelWorld] Unknown block type '${name}' in VXL - cannot load, using NONE`);
                        currentId = 0;
                    }
                }
                
                idRemap.set(savedId, currentId);
                
                if (savedId !== currentId) {
                    console.log(`[VoxelWorld] Remapping block type '${name}': ${savedId} -> ${currentId}`);
                }
            }
        }

        // Clear existing chunks
        this.clear();

        for (const [key, chunkData] of Object.entries(chunksData)) {
            const chunk = new Chunk();
            const dataObj = chunkData as { 
                p: BlockID[], 
                d?: number[], 
                voxels?: Array<{x: number, y: number, z: number, blockId: number, color?: number}>,
                cd?: number[]
            };
            
            // Remap the palette using saved->current ID mapping
            // Palette stores block type IDs directly, no encoding
            chunk.palette = dataObj.p.map(savedId => {
                const currentId = idRemap.get(savedId);
                return (currentId !== undefined ? currentId : savedId) as BlockID;
            });
            
            // Load color data if present (for custom colors only)
            if (dataObj.cd) {
                chunk.colors.data = new Uint32Array(dataObj.cd);
                chunk.colors.length = dataObj.cd.length;
            }
            
            // Handle two formats:
            // 1. RLE format: { p: [...], d: [...] }
            // 2. Voxel list format: { p: [...], voxels: [{x, y, z, blockId, color?}, ...] }
            if (dataObj.d) {
                // RLE format - load directly
                chunk.setRleData(dataObj.d);
            } else if (dataObj.voxels) {
                // Voxel list format - build RLE by setting each voxel
                // Clear the initial air run
                chunk.clearRleRuns();
                
                // Set each voxel (this will rebuild RLE)
                for (const voxel of dataObj.voxels) {
                    const paletteIndex = chunk.palette.indexOf(voxel.blockId);
                    if (paletteIndex === -1) {
                        // Block ID not in palette - skip
                        continue;
                    }
                    chunk.set(voxel.x, voxel.y, voxel.z, voxel.blockId);
                    // Set color if provided
                    if (voxel.color !== undefined) {
                        chunk.colors.set(voxel.x, voxel.y, voxel.z, voxel.color);
                    }
                }
            } else {
                continue;
            }
            
            chunk.needsRemesh = true;
            this.chunks.set(key, chunk);
            this.dirtyChunks.add(chunk);
        }
        
        // NOTE: Do NOT call updatePhysicsAndMeshing here!
        // Caller (VoxelTerrainSystem) will call finalizeTerrain() AFTER configuring smooth surfaces.
        // Building meshes here would create duplicate meshes without smooth surface settings.
        
        // Return metadata for caller to use
        return {
            voxelSize: metadata.voxelSize,
            bounds: metadata.bounds,
            transform: metadata.transform
        };
    }

    clear(): void {
        // Remove heightfield collider first
        this.removeSmoothSurfaceHeightfield();
        // 2D lane: every chunk's colliders go with the chunks.
        if (this.onChunkPhysicsRebuilt) for (const key of this.chunks.keys()) { const [cx, cy, cz] = key.split(',').map(Number); this.onChunkPhysicsRebuilt(key, null, cx ?? 0, cy ?? 0, cz ?? 0); }
        
        // Clean up all physics bodies
        for (const chunk of this.chunks.values()) {
            if (chunk.body && this.physicsWorld) {
                // Remove all colliders first
                for (const collider of chunk.colliders) {
                    this.physicsWorld.removeCollider(collider);
                }
                chunk.colliders = [];
                
                // Then remove the rigid body
                this.physicsWorld.removeRigidBody(chunk.body);
                chunk.body = null;
            }
        }

        // Remove reveal mesh
        if (this.revealInstancedMesh) {
            this.parentGroup.remove(this.revealInstancedMesh);
            this.revealInstancedMesh.geometry.dispose();
            (this.revealInstancedMesh.material as THREE.Material).dispose();
            this.revealInstancedMesh = null;
        }

        // Clean up shadow system
        this.shadowSystem.dispose();

        // Remove all chunk meshes
        for (const chunk of this.chunks.values()) {
            // Remove collision meshes (visual voxel meshes)
            if (chunk.collisionMesh) {
                this.parentGroup.remove(chunk.collisionMesh);
                if (chunk.collisionMesh instanceof THREE.Mesh) {
                    chunk.collisionMesh.geometry.dispose();
                    this.disposeChunkMaterial(chunk.collisionMesh.material as THREE.Material);
                }
                chunk.collisionMesh = null;
            }
        }

        this.chunks.clear(); this.dirtyChunks.clear(); this.revealMode = false; this.revealProgress = 0;
        this.physicsStats = { totalRigidBodies: 0, totalCompoundShapes: 0, totalBoxShapes: 0, totalTriMeshShapes: 0, lastUpdateStats: null };
        this.clearCullingCache();
    }

    /** User-facing "voxels visible" intent — separate from per-chunk PVS culling decisions. */
    areChunksVisible(): boolean { return this.chunksShouldBeVisible; }

    /**
     * Set visibility mode of all chunk meshes
     * - visible = false → invisible colliders that write depth + global ShadowMaterial mesh receives shadows
     * - visible = true → normal colored voxels that receive shadows directly
     */
    setChunksVisible(visible: boolean): void {
        // Store visibility state for newly created chunks
        this.chunksShouldBeVisible = visible;
        
        // Only create meshes if they don't exist yet (avoid duplicate work after updatePhysicsAndMeshing)
        let needsMeshCreation = false;
        for (const chunk of this.chunks.values()) {
            if (!chunk.collisionMesh && chunk.collisionBoxes && chunk.collisionBoxes.length > 0) {
                needsMeshCreation = true;
                break;
            }
        }
        if (needsMeshCreation) {
            this.updateCollisionVisualization();
        }
        
        // Control collision meshes (visual voxel meshes)
        for (const chunk of this.chunks.values()) {
            if (chunk.collisionMesh) { const mesh = chunk.collisionMesh as THREE.Mesh;
                if (visible) { mesh.visible = true; if (mesh.material instanceof THREE.Material) this.disposeChunkMaterial(mesh.material); mesh.material = this.createVoxelMaterial(); mesh.castShadow = true; mesh.receiveShadow = true; }
                else { mesh.visible = false; if (mesh.material instanceof THREE.Material) this.disposeChunkMaterial(mesh.material); mesh.castShadow = false; mesh.receiveShadow = false; } }
        }

        // Global shadow receiver (outer shell) — disabled: causes translucent dark overlay on gaussians
        // TODO: re-enable when shadow mesh is scoped to non-splat voxel worlds
        const shadowMesh = this.shadowSystem.getShadowMesh();
        if (shadowMesh) {
            shadowMesh.visible = false;
        }
    }


    /**
     * Create or update visual voxel meshes (runtime visualization)
     * 
     * NOTE: These are the actual visual voxels used at runtime, NOT collision visualization.
     * The actual physics colliders are created separately in updateChunkPhysics().
     * 
     * Optimized: Combines all greedy-meshed boxes into a single mesh with vertex colors,
     * reducing draw calls from N (one per box) to 1 (one per chunk) for maximum efficiency.
     * 
     * @param onlyChunks - If provided, only update these specific chunk keys (for incremental updates)
     */
    private updateCollisionVisualization(onlyChunks?: Set<string>): void {
        const t0 = performance.now();
        let chunksProcessed = 0, smoothChunks = 0;
        for (const [key, chunk] of this.chunks.entries()) {
            // Skip chunks not in the filter (if filter provided)
            if (onlyChunks && !onlyChunks.has(key)) continue;
            // Skip chunks fully represented by a uniform-flat InstancedMesh — no per-chunk Mesh needed.
            if (this.instancingState.chunksCoveredByInstance.has(key)) continue;
            const parts = key.split(',');
            if (parts.length !== 3) continue;
            const cxStr = parts[0];
            const cyStr = parts[1];
            const czStr = parts[2];
            if (!cxStr || !cyStr || !czStr) continue;
            const cx = parseInt(cxStr, 10);
            const cy = parseInt(cyStr, 10);
            const cz = parseInt(czStr, 10);
            if (isNaN(cx) || isNaN(cy) || isNaN(cz)) continue;

            // Remove old collision mesh, preserving children (foliage) for re-parenting
            const preservedChildren: THREE.Object3D[] = [];
            if (chunk.collisionMesh) {
                // Save children (foliage meshes) before removing
                while (chunk.collisionMesh.children.length > 0) {
                    const child = chunk.collisionMesh.children[0]!;
                    chunk.collisionMesh.remove(child);
                    preservedChildren.push(child);
                }
                
                this.parentGroup.remove(chunk.collisionMesh);
                if (chunk.collisionMesh instanceof THREE.Mesh) {
                    chunk.collisionMesh.geometry.dispose();
                    this.disposeChunkMaterial(chunk.collisionMesh.material as THREE.Material);
                }
                chunk.collisionMesh = null;
            }

            if (!chunk.collisionBoxes || chunk.collisionBoxes.length === 0) {
                // No new mesh being created, re-add foliage to parent group instead
                for (const child of preservedChildren) {
                    this.parentGroup.add(child);
                }
                continue;
            }

            // Convert chunk coordinates to world coordinates
            const chunkVoxelGridX = cx * CHUNK_SIZE;
            const chunkVoxelGridY = cy * CHUNK_SIZE;
            const chunkVoxelGridZ = cz * CHUNK_SIZE;
            
            const boundsOffsetX = this.bounds ? this.bounds.minX : 0;
            const boundsOffsetY = this.bounds ? this.bounds.minY : 0;
            const boundsOffsetZ = this.bounds ? this.bounds.minZ : 0;
            
            const chunkWorldX = boundsOffsetX + chunkVoxelGridX * this.voxelSize;
            const chunkWorldY = boundsOffsetY + chunkVoxelGridY * this.voxelSize;
            const chunkWorldZ = boundsOffsetZ + chunkVoxelGridZ * this.voxelSize;

            // Combine all boxes into a single geometry (like updateChunkVisuals)
            const geometry = new THREE.BufferGeometry();
            const positions: number[] = [];
            const colors: number[] = [];
            const uvs: number[] = [];  // UV coordinates for atlas mode
            const normals: number[] = []; // Only used when generateNormals is true
            const indices: number[] = [];
            let vertexOffset = 0;
            
            // Get atlas for UV lookup if using atlas mode
            const useAtlas = this.materialType === 'atlas';
            const atlas = useAtlas ? getVoxelTextureAtlas() : null;
            // Atlas reference for rounding lookups (block properties are global, regardless of texture mode)
            const atlasForRounding = atlas ?? getVoxelTextureAtlas();
            const anyRoundingPossible = this.voxelRoundingRadiusVoxels > 0 || atlasForRounding.hasAnyBlockWithRounding();

            // Use shared face templates and indices from VoxelGeometry
            const faceTemplate = FACE_TEMPLATES;
            const faceIndices = FACE_INDICES;
            
            // Per-face normals matching FACE_TEMPLATES order: [-Z, +Z, -X, +X, -Y, +Y]
            const faceNormals = [
                [0, 0, -1],  // -Z (back)
                [0, 0, 1],   // +Z (front)
                [-1, 0, 0],  // -X (left)
                [1, 0, 0],   // +X (right)
                [0, -1, 0],  // -Y (bottom)
                [0, 1, 0]    // +Y (top)
            ];

            // Generate boxes to render - either from greedy meshing or individual voxels
            let boxesToRender: Array<{x: number, y: number, z: number, w: number, h: number, d: number, blockType: number, r: number, g: number, b: number}> = [];
            
            if (this.disableGreedyMeshing) {
                // Render individual voxels - no merging, correct UV tiling
                for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                            const blockType = chunk.get(lx, ly, lz);
                            if (blockType !== 0) {
                                const rgb24 = chunk.colors.get(lx, ly, lz);
                                boxesToRender.push({
                                    x: lx, y: ly, z: lz,
                                    w: 1, h: 1, d: 1,
                                    blockType,
                                    r: ((rgb24 >> 16) & 255) / 255,
                                    g: ((rgb24 >> 8) & 255) / 255,
                                    b: (rgb24 & 255) / 255
                                });
                            }
                        }
                    }
                }
            } else {
                // Use greedy-meshed collision boxes, but split boxes with smooth surfaces
                // into individual voxels so each vertex can have its own smoothed height
                for (const box of chunk.collisionBoxes) {
                    const lx = (box.x + Math.floor(box.w / 2)) & 15;
                    const ly = (box.y + box.h - 1) & 15;
                    const lz = (box.z + Math.floor(box.d / 2)) & 15;
                    const blockType = chunk.get(lx, ly, lz);
                    const rgb24 = chunk.colors.get(lx, ly, lz);
                    const r = ((rgb24 >> 16) & 255) / 255;
                    const g = ((rgb24 >> 8) & 255) / 255;
                    const b = (rgb24 & 255) / 255;
                    
                    // Split merged boxes with smooth surfaces into individual voxels for proper interpolation
                    if (this.smoothSurfaceManager.isEnabledForBlockType(blockType) && (box.w > 1 || box.d > 1)) {
                        for (let dz = 0; dz < box.d; dz++) {
                            for (let dx = 0; dx < box.w; dx++) {
                                boxesToRender.push({ x: box.x + dx, y: box.y, z: box.z + dz, w: 1, h: box.h, d: 1, blockType, r, g, b });
                            }
                        }
                    } else {
                        boxesToRender.push({ x: box.x, y: box.y, z: box.z, w: box.w, h: box.h, d: box.d, blockType, r, g, b });
                    }
                }
            }

            // Separate solid and fluid boxes - fluid blocks render with transparency
            const solidBoxes: typeof boxesToRender = [], fluidBoxes: Array<typeof boxesToRender[0] & { opacity: number }> = [];
            for (const box of boxesToRender) { if (atlas && atlas.isFluidBlock(box.blockType)) fluidBoxes.push({ ...box, opacity: atlas.getBlockOpacity(box.blockType) }); else solidBoxes.push(box); }

            for (const box of solidBoxes) {
                const w = box.w * this.voxelSize;
                const h = box.h * this.voxelSize;
                const d = box.d * this.voxelSize;
                
                const boxMinWorldX = chunkWorldX + box.x * this.voxelSize;
                const boxMinWorldY = chunkWorldY + box.y * this.voxelSize;
                const boxMinWorldZ = chunkWorldZ + box.z * this.voxelSize;
                
                const centerX = boxMinWorldX + w / 2;
                const centerY = boxMinWorldY + h / 2;
                const centerZ = boxMinWorldZ + d / 2;

                const r = box.r;
                const g = box.g;
                const b = box.b;
                
                const exposedFaces = this.getExposedFaces(chunk, box, cx, cy, cz);
                const rndVox = anyRoundingPossible ? mergeVoxelRoundingRadiusVoxels(this.voxelRoundingRadiusVoxels, atlasForRounding.getVoxelRoundingRadiusVoxels(box.blockType)) : 0;
                const rndWorld = rndVox * this.voxelSize;
                const willRound = rndWorld > 1e-6;
                const roundingExposed: readonly boolean[] = willRound ? this.getRoundingExposedFaces(chunk, box, cx, cy, cz) : exposedFaces;

                // Precompute bottom extension: for smooth boxes, only extend lowest in column; for non-smooth, extend to meet smooth below
                const isSmooth = this.smoothSurfaceManager.isEnabledForBlockType(box.blockType);
                let bottom_extend = 0;
                if (isSmooth) { let isLowestSmooth = true; if (box.y > 0) { for (let lx = box.x; lx < box.x + box.w && isLowestSmooth; lx++) for (let lz = box.z; lz < box.z + box.d && isLowestSmooth; lz++) { const bT = chunk.get(lx & 15, (box.y - 1) & 15, lz & 15); if (bT !== 0 && this.smoothSurfaceManager.isEnabledForBlockType(bT)) isLowestSmooth = false; } }
                    if (isLowestSmooth) { const dirs = [{dx:-1,dz:0},{dx:1,dz:0},{dx:0,dz:-1},{dx:0,dz:1}]; let lowestAdjRegY = Infinity;
                        for (const d of dirs) for (let lx = box.x; lx < box.x + box.w; lx++) for (let lz = box.z; lz < box.z + box.d; lz++) { const ax = lx + d.dx, az = lz + d.dz; if (ax < 0 || ax >= CHUNK_SIZE || az < 0 || az >= CHUNK_SIZE) continue; for (let y = box.y; y >= 0; y--) { const adjT = chunk.get(ax & 15, y & 15, az & 15); if (adjT !== 0 && !this.smoothSurfaceManager.isEnabledForBlockType(adjT)) lowestAdjRegY = Math.min(lowestAdjRegY, y); } }
                        if (lowestAdjRegY < Infinity && lowestAdjRegY < box.y) bottom_extend = (box.y - lowestAdjRegY) * this.voxelSize; }
                } else { if (box.y > 0) { for (let lx = box.x; lx < box.x + box.w; lx++) for (let lz = box.z; lz < box.z + box.d; lz++) { const bT = chunk.get(lx & 15, (box.y - 1) & 15, lz & 15);
                        if (bT !== 0 && this.smoothSurfaceManager.isEnabledForBlockType(bT)) { const cVx = chunkVoxelGridX + lx + 0.5, cVz = chunkVoxelGridZ + lz + 0.5, bY = chunkVoxelGridY + box.y - 1; const so = this.smoothSurfaceManager.calculateSmoothOffset(cVx, cVz, cVx, cVz, bY, bT, this.voxelSize); if (so < 0) bottom_extend = Math.max(bottom_extend, -so); } } }
                    let emptyBelow = true; for (let y = box.y - 1; y >= 0 && emptyBelow; y--) for (let lx = box.x; lx < box.x + box.w && emptyBelow; lx++) for (let lz = box.z; lz < box.z + box.d && emptyBelow; lz++) if (chunk.get(lx & 15, y & 15, lz & 15) !== 0) emptyBelow = false;
                    if (emptyBelow && box.y > 0) { const dirs = [{dx:-1,dz:0},{dx:1,dz:0},{dx:0,dz:-1},{dx:0,dz:1}]; let lowY = Infinity;
                        for (const d of dirs) for (let lx = box.x; lx < box.x + box.w; lx++) for (let lz = box.z; lz < box.z + box.d; lz++) { const ax = lx + d.dx, az = lz + d.dz; if (ax < 0 || ax >= CHUNK_SIZE || az < 0 || az >= CHUNK_SIZE) continue;
                            for (let y = box.y - 1; y >= 0; y--) { const adjT = chunk.get(ax & 15, y & 15, az & 15); if (adjT !== 0 && this.smoothSurfaceManager.isEnabledForBlockType(adjT)) { lowY = Math.min(lowY, y); break; } } }
                        if (lowY < Infinity) bottom_extend = Math.max(bottom_extend, (box.y - lowY) * this.voxelSize); }
                }

                const useRoundedMesh = willRound && !isSmooth && bottom_extend < 1e-6;
                if (useRoundedMesh) {
                    const cornerFlags = this.getCornerRoundedFlags(box, roundingExposed, cx, cy, cz);
                    const rgb24 = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
                    const roundedAtlas: RoundedAtlasContext | null = useAtlas && atlas !== null ? {
                        isColorPalette: box.blockType === BlockType.COLOR,
                        rgb24,
                        getAtlasRegionForFace(fi: number) {
                            let ft: 'top' | 'side' | 'bottom' = 'side';
                            if (fi === 5) ft = 'top';
                            else if (fi === 4) ft = 'bottom';
                            return atlas.getBlockUV(box.blockType, ft);
                        },
                        getPaletteUV(r24: number) {
                            return atlas.getColorPaletteUV((r24 >>> 16) & 255, (r24 >>> 8) & 255, r24 & 255);
                        },
                    } : null;
                    appendRoundedVoxelMesh({
                        positions, colors, normals, uvs, indices,
                        centerX, centerY, centerZ,
                        width: w, height: h, depth: d,
                        radius: rndWorld,
                        segments: this.voxelRoundingSegments,
                        exposedFaces: roundingExposed,
                        cornerInnerFlags: cornerFlags,
                        rgb: [r, g, b],
                        atlas: roundedAtlas,
                        generateNormals: this.generateNormals,
                    });
                    appendFloorBridgeQuads({
                        positions, colors, normals, uvs, indices,
                        centerX, centerY, centerZ,
                        halfA: w / 2, halfB: h / 2, halfC: d / 2,
                        radius: rndWorld,
                        exposedFaces: roundingExposed,
                        boxMinVoxX: chunkVoxelGridX + box.x,
                        boxMinVoxY: chunkVoxelGridY + box.y,
                        boxMinVoxZ: chunkVoxelGridZ + box.z,
                        boxW: box.w, boxH: box.h, boxD: box.d,
                        sampleVoxel: (vx, vy, vz) => this.sampleSolidVoxelInfo(vx, vy, vz),
                        useAtlas,
                        getAtlasRegion: useAtlas && atlas !== null ? (d2, ft) => d2.blockType === BlockType.COLOR ? atlas.getColorPaletteUV(Math.round(d2.r * 255), Math.round(d2.g * 255), Math.round(d2.b * 255)) : atlas.getBlockUV(d2.blockType, ft) : null,
                        generateNormals: this.generateNormals,
                    });
                    vertexOffset = positions.length / 3;
                    continue;
                }

                const boxVertexOffset = vertexOffset;
                const vertexRemap: number[] = [];
                let newVertexIdx = 0;

                // For smooth blocks, generate subdivided top face separately
                const VISUAL_SMOOTH_SUBDIVISIONS = 4;
                const smoothTopFaceBaseVertex = isSmooth && exposedFaces[5] ? vertexOffset : -1;
                
                if (isSmooth && exposedFaces[5]) {
                    // Generate subdivided top face grid for smooth surface
                    const subdiv = VISUAL_SMOOTH_SUBDIVISIONS;
                    const atlasUV = atlas ? atlas.getBlockUV(box.blockType, 'top') : null;
                    const boxTopY = chunkVoxelGridY + box.y + box.h - 1;
                    const topY = boxMinWorldY + box.h * this.voxelSize;
                    
                    // Generate (subdiv+1) x (subdiv+1) grid of vertices
                    for (let gz = 0; gz <= subdiv; gz++) {
                        for (let gx = 0; gx <= subdiv; gx++) {
                            const fx = gx / subdiv;  // 0 to 1
                            const fz = gz / subdiv;
                            
                            const worldX = boxMinWorldX + fx * w;
                            const worldZ = boxMinWorldZ + fz * d;
                            
                            // Sample smooth offset at this grid point
                            const sampleVx = chunkVoxelGridX + box.x + fx * box.w;
                            const sampleVz = chunkVoxelGridZ + box.z + fz * box.d;
                            const smoothOffset = this.smoothSurfaceManager.calculateSmoothOffset(
                                sampleVx, sampleVz,
                                chunkVoxelGridX + box.x + 0.5, chunkVoxelGridZ + box.z + 0.5,
                                boxTopY, box.blockType, this.voxelSize
                            );
                            
                            positions.push(worldX, topY + smoothOffset, worldZ);
                            colors.push(r, g, b);
                            
                            if (atlasUV) {
                                const u = atlasUV.u0 + fx * (atlasUV.u1 - atlasUV.u0);
                                const vCoord = atlasUV.v0 + fz * (atlasUV.v1 - atlasUV.v0);
                                uvs.push(u, vCoord);
                            }
                            
                            if (this.generateNormals) {
                                // For smooth surface, compute normal from gradient
                                const normal = this.smoothSurfaceManager.getSurfaceNormal(sampleVx, sampleVz, box.blockType, this.voxelSize);
                                normals.push(normal.x, normal.y, normal.z);
                            }
                            
                            vertexOffset++;
                        }
                    }
                    
                    // Generate triangles for the subdivided grid
                    const gridW = subdiv + 1;
                    for (let gz = 0; gz < subdiv; gz++) {
                        for (let gx = 0; gx < subdiv; gx++) {
                            const i00 = smoothTopFaceBaseVertex + gz * gridW + gx;
                            const i10 = i00 + 1;
                            const i01 = i00 + gridW;
                            const i11 = i01 + 1;
                            
                            // Two triangles per grid cell (CCW winding for top face)
                            indices.push(i00, i01, i10);
                            indices.push(i10, i01, i11);
                        }
                    }
                }
                
                for (let f = 0; f < 6; f++) {
                    // Skip top face for smooth blocks (handled above with subdivision)
                    if (isSmooth && f === 5) {
                        for (let v = 0; v < 4; v++) vertexRemap[f * 4 + v] = -1;
                        continue;
                    }
                    
                    if (!exposedFaces[f]) {
                        // Mark vertices for this hidden face as unused
                        for (let v = 0; v < 4; v++) {
                            vertexRemap[f * 4 + v] = -1;
                        }
                        continue;
                    }
                    
                    const base = f * 4;
                    const faceNormal = faceNormals[f];
                    
                    // Determine face type for atlas UV lookup
                    // Face order: [-Z, +Z, -X, +X, -Y, +Y] = [0, 1, 2, 3, 4, 5]
                    // -Y (4) = bottom, +Y (5) = top, others = side
                    let faceType: 'top' | 'side' | 'bottom' = 'side';
                    if (f === 5) faceType = 'top';
                    else if (f === 4) faceType = 'bottom';
                    
                    // Get atlas UVs if using atlas mode - block type stored directly
                    const atlasUV = atlas ? atlas.getBlockUV(box.blockType, faceType) : null;
                    
                    for (let v = 0; v < 4; v++) {
                        const faceVtx = faceTemplate[base + v];
                        if (!faceVtx || faceVtx.length < 3) continue;
                        const vx = (faceVtx[0] ?? 0) * w;
                        const vy = (faceVtx[1] ?? 0) * h;
                        const vz = (faceVtx[2] ?? 0) * d;
                        
                        let finalY = centerY + vy;
                        // Apply uniform bottom extension for all bottom vertices
                        if ((faceVtx[1] ?? 0) < 0) finalY -= bottom_extend;
                        // For smoothed boxes on side faces, apply smooth offset to top vertices
                        if (isSmooth && (faceVtx[1] ?? 0) > 0) {
                            const cornerVx = chunkVoxelGridX + box.x + ((faceVtx[0] ?? 0) + 0.5) * box.w;
                            const cornerVz = chunkVoxelGridZ + box.z + ((faceVtx[2] ?? 0) + 0.5) * box.d;
                            const boxTopY = chunkVoxelGridY + box.y + box.h - 1;
                            const smoothOffset = this.smoothSurfaceManager.calculateSmoothOffset(cornerVx, cornerVz, chunkVoxelGridX + box.x + 0.5, chunkVoxelGridZ + box.z + 0.5, boxTopY, box.blockType, this.voxelSize);
                            if (smoothOffset !== 0) finalY = boxMinWorldY + box.h * this.voxelSize + smoothOffset;
                        }
                        
                        positions.push(centerX + vx, finalY, centerZ + vz);
                        colors.push(r, g, b); // Preserve colors via vertex colors (or for non-atlas modes)
                        
                        // Add UV coordinates for atlas mode
                        if (atlasUV) {
                            // Hard-coded UV coordinates per vertex for each face
                            // Based on FACE_TEMPLATES vertex order (counter-clockwise from outside)
                            // Each face: vertex 0,1,2,3 maps to UV corners
                            const faceUVMaps: number[][][] = [
                                // -Z (back): looking from -Z, X+ is right, Y+ is up
                                [[0,0], [1,0], [1,1], [0,1]],
                                // +Z (front): looking from +Z, X- is right, Y+ is up  
                                [[1,0], [1,1], [0,1], [0,0]],
                                // -X (left): looking from -X, Z- is right, Y+ is up
                                [[1,0], [1,1], [0,1], [0,0]],
                                // +X (right): looking from +X, Z+ is right, Y+ is up
                                [[0,0], [1,0], [1,1], [0,1]],
                                // -Y (bottom): looking from -Y, X+ is right, Z- is up
                                [[0,1], [0,0], [1,0], [1,1]],
                                // +Y (top): looking from +Y, X+ is right, Z+ is up
                                [[0,0], [1,0], [1,1], [0,1]],
                            ];
                            
                            const uvMap = faceUVMaps[f];
                            const vertexUV = uvMap ? uvMap[v] : undefined;
                            if (vertexUV && vertexUV[0] !== undefined && vertexUV[1] !== undefined) {
                                let u01 = vertexUV[0];
                                let v01 = vertexUV[1];
                                
                                // Map [0,1] UV to atlas region (texture stretches on extended portions)
                                const u = atlasUV.u0 + u01 * (atlasUV.u1 - atlasUV.u0);
                                const vCoord = atlasUV.v0 + v01 * (atlasUV.v1 - atlasUV.v0);
                                uvs.push(u, vCoord);
                            }
                        }
                        
                        // Add per-face normal for shadow support (when enabled)
                        if (this.generateNormals && faceNormal) {
                            normals.push(faceNormal[0] ?? 0, faceNormal[1] ?? 0, faceNormal[2] ?? 0);
                        }
                        vertexRemap[f * 4 + v] = boxVertexOffset + newVertexIdx;
                        newVertexIdx++;
                        vertexOffset++;
                    }
                }

                // Second pass: add indices only for exposed faces, using remap
                // Skip top face (f=5) for smooth blocks as it was handled with subdivision above
                for (let f = 0; f < 6; f++) {
                    if (isSmooth && f === 5) continue;  // Already added subdivided indices
                    if (!exposedFaces[f]) continue;
                    const b = f * 6;
                    if (b + 5 < faceIndices.length && faceIndices[b] !== undefined) {
                        for (let i = 0; i < 6; i++) indices.push(vertexRemap[faceIndices[b + i]!]!);
                    }
                }
            }
            
            // Add merged debris (rotated cubes) - face data: [v0,v1,v2,v3,nx,ny,nz], uvCorners: [0,0],[1,0],[1,1],[0,1]
            // Each debris has a unique zFightingOffset applied along face normals to prevent z-fighting
            const dFD=[[0,3,2,1,0,0,-1],[5,6,7,4,0,0,1],[4,7,3,0,-1,0,0],[1,2,6,5,1,0,0],[0,1,5,4,0,-1,0],[3,7,6,2,0,1,0]], uvC=[[0,0],[1,0],[1,1],[0,1]];
            for (const d of chunk.mergedDebris) {
                const v=d.vertices, q=new THREE.Quaternion(d.rotation.x,d.rotation.y,d.rotation.z,d.rotation.w), zOff=d.zFightingOffset;
                const hasColor = d.color !== undefined;
                const colorUV = hasColor && atlas ? atlas.getColorPaletteUV(d.color!.r * 255, d.color!.g * 255, d.color!.b * 255) : undefined;
                const us = colorUV ?? atlas?.getBlockUV(d.blockType,'side');
                const ut = colorUV ?? atlas?.getBlockUV(d.blockType,'top');
                const ub = colorUV ?? atlas?.getBlockUV(d.blockType,'bottom');
                for (let f=0;f<6;f++) { const fd=dFD[f]!, uv=f<4?us:(f===4?ub:ut), bi=vertexOffset, n=new THREE.Vector3(fd[4]!,fd[5]!,fd[6]!).applyQuaternion(q);
                    for (let i=0;i<4;i++) { const vi=fd[i]!; positions.push(v[vi*3]!+n.x*zOff,v[vi*3+1]!+n.y*zOff,v[vi*3+2]!+n.z*zOff); colors.push(.8,.8,.8); if(uv){const c=uvC[i]!;uvs.push(uv.u0+c[0]!*(uv.u1-uv.u0),uv.v0+c[1]!*(uv.v1-uv.v0));} if(this.generateNormals)normals.push(n.x,n.y,n.z); vertexOffset++; }
                    indices.push(bi,bi+1,bi+2,bi,bi+2,bi+3); }
            }

            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            // Add UV coordinates for atlas mode
            if (useAtlas && uvs.length > 0) {
                geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            }
            // Add per-face normals for shadow support (when enabled for Voxel genre terrain)
            if (this.generateNormals && normals.length > 0) {
                geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
            }
            // When generateNormals is false (Gaussian Splatting mode), flatShading computes face normals at render time
            geometry.setIndex(indices);

            // Create material based on materialType option
            const material = this.createVoxelMaterial();

            const mesh = new THREE.Mesh(geometry, material);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = true;
            mesh.renderOrder = 1000; // Render after splats
            mesh.name = `VoxelChunk_${cx}_${cy}_${cz}`;
            Object.assign(mesh.userData, { isTerrainChunk: true, isVoxelWorld: true });
            // Apply current visibility state to newly created chunk
            // Note: setChunksVisible() will update the material based on visibility state
            mesh.visible = this.chunksShouldBeVisible;
            
            // Position mesh at chunk origin (vertices are already in world space)
            mesh.position.set(0, 0, 0);
            this.parentGroup.add(mesh);
            chunk.collisionMesh = mesh;
            chunksProcessed++;
            
            // Re-attach preserved children (foliage) to the new mesh
            for (const child of preservedChildren) {
                mesh.add(child);
            }
            
            // Store physics body reference in mesh userData for Object Inspector
            if (chunk.body) {
                mesh.userData.physicsBody = chunk.body;
                mesh.userData.collisionGroup = CollisionGroup.TERRAIN;
                mesh.userData.collisionMask = CollisionMask.TERRAIN;
            }
            
            // Apply visibility state immediately to ensure correct material
            if (!this.chunksShouldBeVisible) {
                // Invisible mode: depth-only rendering. Deliberately outside the
                // material-class ladder — colorMask(false) means this material
                // never shades a visible pixel, so its lighting model is moot.
                const depthMaterial = new THREE.MeshStandardMaterial({
                    vertexColors: true,
                    side: THREE.FrontSide,
                    flatShading: true,
                    depthWrite: true,
                    depthTest: true,
                });
                const originalOnBeforeRender = depthMaterial.onBeforeRender;
                depthMaterial.onBeforeRender = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, object: THREE.Object3D, group: THREE.Group) => {
                    const gl = renderer.getContext() as WebGLRenderingContext;
                    gl.colorMask(false, false, false, false); // Disable color writes
                    if (originalOnBeforeRender) {
                        originalOnBeforeRender.call(depthMaterial, renderer, scene, camera, geometry, object, group);
                    }
                };
                (depthMaterial as any)._restoreColorMask = (renderer: THREE.WebGLRenderer) => {
                    const gl = renderer.getContext() as WebGLRenderingContext;
                    gl.colorMask(true, true, true, true); // Re-enable color writes
                };
                mesh.material = depthMaterial;
                mesh.castShadow = false;
                mesh.receiveShadow = false;
            }
            
        }
        if (chunksProcessed > 10) { console.log(`[VoxelWorld] updateCollisionVisualization: ${chunksProcessed} chunks in ${(performance.now() - t0).toFixed(1)}ms`); this.smoothSurfaceManager.logStats('vis'); }
    }

    /**
     * Show visual voxels in solid mode
     */
    setCollisionBoxesVisible(visible: boolean): void {
        // Ensure visual voxel meshes exist (only creates if missing)
        let needsUpdate = false;
        for (const chunk of this.chunks.values()) {
            if (!chunk.collisionMesh && chunk.collisionBoxes && chunk.collisionBoxes.length > 0) {
                needsUpdate = true;
                break;
            }
        }
        
        if (needsUpdate) {
            // Temporarily set visibility state to match desired state before creating meshes
            const oldState = this.chunksShouldBeVisible;
            this.chunksShouldBeVisible = visible;
            this.updateCollisionVisualization();
            // Restore old state after creating meshes
            this.chunksShouldBeVisible = oldState;
        }
        
        // Update existing meshes (visibility and material)
        for (const chunk of this.chunks.values()) {
            if (chunk.collisionMesh && chunk.collisionMesh instanceof THREE.Mesh) {
                const mesh = chunk.collisionMesh; mesh.visible = visible;
                if (visible) { if (mesh.material instanceof THREE.Material) this.disposeChunkMaterial(mesh.material); mesh.material = this.createVoxelMaterial(); mesh.castShadow = true; mesh.receiveShadow = true; } }
        }
    }


    getChunkCount(): number {
        return this.chunks.size;
    }

    // Expose chunks for voxel counting (read-only access)
    getChunks(): Map<ChunkKey, Chunk> {
        return this.chunks;
    }
    
    /**
     * Count total non-empty voxels across all chunks.
     * Iterates through RLE-encoded chunk data to count solid blocks.
     */
    getTotalVoxelCount(): number {
        let totalVoxels = 0;
        for (const chunk of this.chunks.values()) {
            chunk.forEachRun((paletteIndex, runLength) => {
                // palette[0] is always empty (BlockID 0), so only count non-zero indices
                if (paletteIndex !== 0 && chunk.palette[paletteIndex] !== 0) {
                    totalVoxels += runLength;
                }
            });
        }
        return totalVoxels;
    }
    
    /**
     * Get estimated memory usage for voxel data in megabytes.
     * Includes chunk data arrays, palette, colors, and collision boxes.
     */
    getEstimatedMemoryMB(): number {
        let totalBytes = 0;
        for (const chunk of this.chunks.values()) {
            // Uint16Array data (2 bytes per entry)
            totalBytes += chunk.getRleBufferByteLength();
            // Palette (4 bytes per entry estimate)
            totalBytes += chunk.palette.length * 4;
            // Colors (if used)
            totalBytes += chunk.colors.data.byteLength;
            // Collision boxes (if computed) - rough estimate
            if (chunk.collisionBoxes) {
                totalBytes += chunk.collisionBoxes.length * 24; // 6 numbers * 4 bytes
            }
        }
        return totalBytes / (1024 * 1024);
    }
    
    private ensureCulling(): VoxelChunkCulling { if (!this.chunkCulling) this.chunkCulling = new VoxelChunkCulling(this.voxelSize, this.bounds, this.chunksShouldBeVisible); return this.chunkCulling; }
    setCullingEnabled(en: boolean): void { this.ensureCulling().setCullingEnabled(en, this.chunks); }
    isCullingEnabled(): boolean { return this.chunkCulling?.isCullingEnabled() ?? false; }
    setMaxRenderDistance(d: number): void { this.ensureCulling().setMaxRenderDistance(d); }
    getMaxRenderDistance(): number { return this.chunkCulling?.getMaxRenderDistance() ?? 150; }
    updateChunkVisibility(cam: THREE.Camera): void { this.chunkCulling?.updateVisibility(cam, this.chunks); }
    getCullingStats() { return this.chunkCulling?.getCullingStats() ?? { visibleChunks: 0, totalChunks: 0, culledByDistance: 0, culledByFrustum: 0 }; }
    clearCullingCache(): void { this.chunkCulling?.clearCache(); }
    setOnChunkVisibilityChanged(cb: (k: string, v: boolean) => void): void { this.ensureCulling().setOnChunkVisibilityChanged(cb); }
    getChunkMeshFor2DKey(key2D: string): THREE.Object3D | null { const parts = key2D.split(','); if (parts.length !== 2) return null; const cx = parseInt(parts[0]!, 10), cz = parseInt(parts[1]!, 10); if (isNaN(cx) || isNaN(cz)) return null; for (const [k, c] of this.chunks) { if (!c.collisionMesh) continue; const p = k.split(','); if (p.length === 3 && parseInt(p[0]!, 10) === cx && parseInt(p[2]!, 10) === cz) return c.collisionMesh; } return null; }
    
    get2DChunkKeys(): string[] { const s = new Set<string>(); for (const k of this.chunks.keys()) { const p = k.split(','); if (p.length === 3) s.add(`${p[0]},${p[2]}`); } return [...s]; }
    getTopSurfaceVoxelsFor2DChunk(k2D: string): Array<{worldX: number, worldY: number, worldZ: number, blockType: number}> { const r: Array<{worldX: number, worldY: number, worldZ: number, blockType: number}> = [], pts = k2D.split(','); if (pts.length !== 2) return r; const tcx = parseInt(pts[0]!, 10), tcz = parseInt(pts[1]!, 10); if (isNaN(tcx) || isNaN(tcz)) return r; const ox = this.bounds?.minX ?? 0, oy = this.bounds?.minY ?? 0, oz = this.bounds?.minZ ?? 0, vs = this.voxelSize; for (const [k, ch] of this.chunks) { const kp = k.split(','); if (kp.length !== 3) continue; const cx = parseInt(kp[0]!, 10), cy = parseInt(kp[1]!, 10), cz = parseInt(kp[2]!, 10); if (isNaN(cx) || isNaN(cy) || isNaN(cz) || cx !== tcx || cz !== tcz) continue; for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) { const bt = ch.get(lx, ly, lz); if (bt === 0) continue; const ab = ly < CHUNK_SIZE - 1 ? ch.get(lx, ly + 1, lz) : this.getBlock(ox + (cx * CHUNK_SIZE + lx) * vs, oy + (cy * CHUNK_SIZE + ly + 1) * vs, oz + (cz * CHUNK_SIZE + lz) * vs); if (ab === 0) r.push({ worldX: ox + (cx * CHUNK_SIZE + lx + 0.5) * vs, worldY: oy + (cy * CHUNK_SIZE + ly + 1) * vs, worldZ: oz + (cz * CHUNK_SIZE + lz + 0.5) * vs, blockType: bt }); } } return r; }
    
    getPhysicsStats(): { totalRigidBodies: number; totalBoxShapes: number; totalTriMeshShapes: number; estimatedPhysicsMemoryMB: number } {
        let totalBoxShapes = 0; for (const c of this.chunks.values()) if (c.body && c.collisionBoxes) totalBoxShapes += c.collisionBoxes.length;
        return { totalRigidBodies: this.physicsStats.totalRigidBodies, totalBoxShapes, totalTriMeshShapes: this.physicsStats.totalTriMeshShapes, estimatedPhysicsMemoryMB: (this.physicsStats.totalRigidBodies * 400 + this.physicsStats.totalCompoundShapes * 64 + totalBoxShapes * 96 + this.physicsStats.totalTriMeshShapes * 500) / 1048576 };
    }
    resetPhysicsStats(): void { this.physicsStats.lastUpdateStats = { chunksProcessed: 0, boxShapesCreated: 0, rigidBodiesCreated: 0, triMeshShapesCreated: 0 }; }
    
    
    /**
     * Enable or disable physics colliders for a specific chunk (by 2D key "cx,cz").
     * Used by ChunkPhysicsManager to optimize physics for large worlds.
     */
    setChunkCollidersEnabled(chunkKey2D: string, enabled: boolean): void {
        const [cxStr, czStr] = chunkKey2D.split(',');
        const cx = parseInt(cxStr!, 10);
        const cz = parseInt(czStr!, 10);
        
        // Find all chunks in this column (all Y values)
        for (const [key, chunk] of this.chunks) {
            const [kcx, , kcz] = key.split(',').map(Number);
            if (kcx === cx && kcz === cz) {
                for (const collider of chunk.colliders) {
                    collider.setEnabled(enabled);
                }
            }
        }
    }
    
    /**
     * Get all chunk 2D keys (for ChunkPhysicsManager initialization).
     */
    getChunk2DKeys(): Set<string> {
        const keys = new Set<string>();
        for (const key of this.chunks.keys()) {
            const [cx, , cz] = key.split(',');
            keys.add(`${cx},${cz}`);
        }
        return keys;
    }

    /**
     * Get the current voxel size
     */
    getVoxelSize(): number {
        return this.voxelSize;
    }

    /**
     * Get the current bounds
     */
    getBounds(): { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null {
        return this.bounds;
    }

    /** Install/remove a setBlock observer used by WorldShardSync. setBlockFast() bypasses it. */
    setMutationObserver(observer: ((vx: number, vy: number, vz: number, block: BlockID, color: number | undefined) => void) | null): void { this.mutationObserver = observer; }

    /**
     * Calculate checksum for a single chunk.
     * Uses FNV-1a-like hash with deterministic iteration order.
     */
    private calculateChunkChecksum(chunk: Chunk, cx: number, cy: number, cz: number): number {
        let hash = 2166136261; // FNV offset basis
        // Include chunk position in hash
        hash = this.hashCombine(hash, cx);
        hash = this.hashCombine(hash, cy);
        hash = this.hashCombine(hash, cz);
        // Hash the chunk's compact RLE representation directly instead of iterating
        // 4096 voxels per chunk. Same uniqueness property (different contents →
        // different hash) at ~1000× the speed. For a fillFlat-stamped flat world
        // this used to take ~25s for 14400 chunks; with RLE hashing it's <50ms.
        for (let i = 0; i < chunk.palette.length; i++) hash = this.hashCombine(hash, chunk.palette[i] ?? 0);
        const rle = chunk.getCompactedRle();
        for (let i = 0; i < rle.length; i++) hash = this.hashCombine(hash, rle[i] ?? 0);
        return hash;
    }

    private hashCombine(hash: number, value: number): number {
        hash = hash ^ (value | 0);
        hash = Math.imul(hash, 16777619) | 0;
        return hash >>> 0;
    }

    /**
     * Get terrain checksum efficiently using per-chunk caching.
     * Only recalculates checksums for chunks that have changed since last call.
     */
    getTerrainChecksum(): number {
        // Update checksums for dirty chunks only
        for (const chunkKey of this.dirtyChecksumChunks) {
            const chunk = this.chunks.get(chunkKey);
            if (chunk) {
                const parts = chunkKey.split(',');
                if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
                    const cx = parseInt(parts[0], 10);
                    const cy = parseInt(parts[1], 10);
                    const cz = parseInt(parts[2], 10);
                    if (!isNaN(cx) && !isNaN(cy) && !isNaN(cz)) {
                        const chunkChecksum = this.calculateChunkChecksum(chunk, cx, cy, cz);
                        this.chunkChecksums.set(chunkKey, chunkChecksum);
                    }
                }
            } else {
                // Chunk was removed
                this.chunkChecksums.delete(chunkKey);
            }
        }
        this.dirtyChecksumChunks.clear();

        // Combine all chunk checksums into terrain checksum
        // Sort keys for deterministic order
        const sortedKeys = Array.from(this.chunkChecksums.keys()).sort();
        let hash = 2166136261;
        for (const key of sortedKeys) {
            const chunkChecksum = this.chunkChecksums.get(key);
            if (chunkChecksum !== undefined) {
                hash = this.hashCombine(hash, chunkChecksum);
            }
        }

        this.cachedTerrainChecksum = hash;
        return hash;
    }

    /**
     * Initialize all chunk checksums (call once after terrain is fully loaded)
     */
    initializeChecksums(): void {
        this.chunkChecksums.clear();
        this.dirtyChecksumChunks.clear();
        
        for (const [chunkKey, chunk] of this.chunks.entries()) {
            const parts = chunkKey.split(',');
            if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
                const cx = parseInt(parts[0], 10);
                const cy = parseInt(parts[1], 10);
                const cz = parseInt(parts[2], 10);
                if (!isNaN(cx) && !isNaN(cy) && !isNaN(cz)) {
                    const chunkChecksum = this.calculateChunkChecksum(chunk, cx, cy, cz);
                    this.chunkChecksums.set(chunkKey, chunkChecksum);
                }
            }
        }
        
        // Calculate initial terrain checksum
        this.getTerrainChecksum();
    }

    // Shadow system delegations
    private scheduleShadowUpdate(): void { this.shadowSystem.scheduleShadowUpdate(); }
    private updateShadowMesh(): void { this.shadowSystem.updateShadowMesh(); }


    // Light sphere delegations to shadow system
    addLightSphere(position: THREE.Vector3, radius: number, color: THREE.Color = new THREE.Color(1, 0.5, 0), intensity: number = 1.0): number { return this.shadowSystem.addLightSphere(position, radius, color, intensity); }
    removeLightSphere(id: number): void { this.shadowSystem.removeLightSphere(id); }
    clearLightSpheres(): void { this.shadowSystem.clearLightSpheres(); }
    updateLightSpherePosition(id: number, newPosition: THREE.Vector3): void { this.shadowSystem.updateLightSpherePosition(id, newPosition); }
    /** Begin batch update mode - block changes accumulate dirty chunks but don't trigger updates until endBatchUpdate(). */
    beginBatchUpdate(): void { this.batchMode = true; }

    /** End batch update mode and apply all pending updates via single updatePhysicsAndMeshing() call. */
    endBatchUpdate(): void {
        this.batchMode = false;
        if (this.autoRebuildSuppressed) return;
        if (this.dirtyChunks.size > 0) {
            const chunksToProcess = Array.from(this.chunks.entries()).filter(([_, chunk]) => this.dirtyChunks.has(chunk));
            const processedKeys = new Set<string>();
            
            for (const [chunkKey, chunk] of chunksToProcess) {
                const parts = chunkKey.split(',');
                if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
                    const cx = parseInt(parts[0], 10);
                    const cy = parseInt(parts[1], 10);
                    const cz = parseInt(parts[2], 10);
                    if (!isNaN(cx) && !isNaN(cy) && !isNaN(cz)) {
                        this.updateChunkPhysicsAndVisuals(chunk, cx, cy, cz);
                        processedKeys.add(chunkKey);
                    }
                }
            }
            this.dirtyChunks.clear();
            
            this.updateChunkVisualizationBatch(chunksToProcess);
            this.triggerFluidMeshRebuild(processedKeys);
        }
    }
    
    /**
     * Update visualization for specific chunks only (not all chunks).
     */
    private updateChunkVisualizationBatch(chunksToUpdate: Array<[string, Chunk]>): void {
        // Convert to a Set for fast lookup
        const chunkSet = new Set(chunksToUpdate.map(([key]) => key));
        // Call the existing visualization function with the filter
        this.updateCollisionVisualization(chunkSet);
    }

    /** Check if batch mode is active */
    isInBatchMode(): boolean { return this.batchMode; }

    /** Remove a single block at world position. @returns true if block was removed, false if already air */
    removeBlock(x: number, y: number, z: number): boolean {
        if (this.getBlock(x, y, z) === 0) return false;
        this.setBlock(x, y, z, 0);
        return true;
    }

    /** Remove all blocks within a sphere (uses batch mode). @returns Array of removed block positions and types */
    removeBlocksInSphere(
        centerX: number,
        centerY: number,
        centerZ: number,
        radius: number
    ): Array<{ x: number; y: number; z: number; blockType: number }> {
        return removeBlocksInSphereOp(this, centerX, centerY, centerZ, radius);
    }

    /** Remove all blocks within an axis-aligned box (uses batch mode). @returns Array of removed block positions and types */
    removeBlocksInBox(
        minX: number, minY: number, minZ: number,
        maxX: number, maxY: number, maxZ: number
    ): Array<{ x: number; y: number; z: number; blockType: number }> {
        return removeBlocksInBoxOp(this, minX, minY, minZ, maxX, maxY, maxZ);
    }

    /** Detach every block in a sphere as physics debris. @see VoxelWorldDestruction.detachBlocksInSphere */
    detachBlocksInSphere(centerX: number, centerY: number, centerZ: number, radius: number, impulseStrength: number = 5, impulseUp: number = 2): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> {
        return detachBlocksInSphereOp(this, centerX, centerY, centerZ, radius, impulseStrength, impulseUp);
    }

    /** Detach every block in a box as physics debris. @see VoxelWorldDestruction.detachBlocksInBox */
    detachBlocksInBox(
        minX: number, minY: number, minZ: number,
        maxX: number, maxY: number, maxZ: number,
        impulseDirection?: THREE.Vector3,
        impulseStrength: number = 5
    ): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }> {
        return detachBlocksInBoxOp(this, minX, minY, minZ, maxX, maxY, maxZ, impulseDirection, impulseStrength);
    }

    /** Clear every live debris body for this world. @see VoxelWorldDestruction.clearDebris */
    clearDebris(): void {
        clearDebrisOp(this);
    }

    /** Merge settled debris cube into terrain chunk (with unique z-fighting offset). */
    mergeDebrisIntoChunk(
        position: THREE.Vector3,
        quaternion: THREE.Quaternion,
        blockType: number,
        debrisSize?: number,
        color?: { r: number; g: number; b: number },
    ): void {
        const bx = this.bounds?.minX ?? 0, by = this.bounds?.minY ?? 0, bz = this.bounds?.minZ ?? 0;
        const cx = Math.floor(Math.floor((position.x - bx) / this.voxelSize) / CHUNK_SIZE);
        const cy = Math.floor(Math.floor((position.y - by) / this.voxelSize) / CHUNK_SIZE);
        const cz = Math.floor(Math.floor((position.z - bz) / this.voxelSize) / CHUNK_SIZE);
        const chunkKey = makeChunkKey(cx, cy, cz);
        let chunk = this.chunks.get(chunkKey);
        if (!chunk) { chunk = new Chunk(); this.chunks.set(chunkKey, chunk); }
        
        const zFightingOffset = getZFightingRegistry().acquireDebrisVertexOffset();
        
        const h = (debrisSize ?? this.voxelSize) / 2, vertices = new Float32Array(24);
        const offsets = [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]];
        for (let i = 0; i < 8; i++) {
            const o = offsets[i]!, v = new THREE.Vector3(o[0]!, o[1]!, o[2]!).applyQuaternion(quaternion).add(position);
            vertices[i*3] = v.x; vertices[i*3+1] = v.y; vertices[i*3+2] = v.z;
        }
        const md: MergedDebris = { vertices, blockType, rotation: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }, zFightingOffset };
        if (color) md.color = color;
        if (debrisSize !== undefined) md.debrisSize = debrisSize;
        chunk.mergedDebris.push(md);
        this.dirtyChunks.add(chunk);
        this.dirtyChecksumChunks.add(chunkKey);
    }
    rebuildDirtyChunks(): void { if (!this.autoRebuildSuppressed && this.dirtyChunks.size > 0) this.updatePhysicsAndMeshing(); }

    /**
     * Suppress all automatic chunk rebuilds (rebuildDirtyChunks / endBatchUpdate).
     * Dirty chunks accumulate but are not processed until resumeAutoRebuild().
     */
    suppressAutoRebuild(): void { this.autoRebuildSuppressed = true; }

    /** Resume automatic chunk rebuilds after suppressAutoRebuild(). Does NOT flush — call rebuildDirtyChunks() or deferAllDirtyChunks() after. */
    resumeAutoRebuild(): void { this.autoRebuildSuppressed = false; }

    /**
     * Move all currently dirty chunks into a deferred queue.
     * Subsequent rebuildDirtyChunks() calls will NOT process them.
     * Use rebuildDirtyChunksNear() to build a subset immediately and
     * buildNextDeferredChunk() to drain the rest one per frame.
     */
    deferAllDirtyChunks(): void {
        for (const [key, chunk] of this.chunks.entries()) {
            if (this.dirtyChunks.has(chunk)) {
                this.deferredDirtyChunks.push({ key, chunk });
            }
        }
        this.dirtyChunks.clear();
        console.log(`[VoxelWorld] Deferred ${this.deferredDirtyChunks.length} dirty chunks for progressive rebuild`);
    }

    /**
     * Rebuild deferred dirty chunks within a world-coordinate radius.
     * Chunks outside the radius remain in the deferred queue.
     * @returns Object with count of built and remaining chunks.
     */
    rebuildDirtyChunksNear(centerX: number, centerZ: number, radius: number): { built: number; remaining: number } {
        const radiusSq = radius * radius;
        const bX = this.bounds ? this.bounds.minX : 0, bZ = this.bounds ? this.bounds.minZ : 0;
        const still: { key: ChunkKey; chunk: Chunk }[] = [];
        const toBuild: { key: ChunkKey; chunk: Chunk }[] = [];
        for (const entry of this.deferredDirtyChunks) {
            const parts = entry.key.split(',');
            if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) { still.push(entry); continue; }
            const cx = parseInt(parts[0], 10), cz = parseInt(parts[2], 10);
            if (isNaN(cx) || isNaN(cz)) { still.push(entry); continue; }
            const worldX = bX + (cx * CHUNK_SIZE + CHUNK_SIZE / 2) * this.voxelSize;
            const worldZ = bZ + (cz * CHUNK_SIZE + CHUNK_SIZE / 2) * this.voxelSize;
            const dx = worldX - centerX, dz = worldZ - centerZ;
            if (dx * dx + dz * dz <= radiusSq) toBuild.push(entry);
            else still.push(entry);
        }
        const builtKeys = new Set<string>();
        for (const entry of toBuild) {
            const parts = entry.key.split(',');
            if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) continue;
            const cx = parseInt(parts[0], 10), cy = parseInt(parts[1], 10), cz = parseInt(parts[2], 10);
            if (isNaN(cx) || isNaN(cy) || isNaN(cz)) continue;
            this.updateChunkPhysicsAndVisuals(entry.chunk, cx, cy, cz);
            builtKeys.add(entry.key);
        }
        if (builtKeys.size > 0) {
            this.updateCollisionVisualization(builtKeys);
            this.scheduleShadowUpdate();
            this.triggerFluidMeshRebuild(builtKeys);
        }
        this.deferredDirtyChunks = still;
        console.log(`[VoxelWorld] rebuildDirtyChunksNear: built ${toBuild.length}, remaining ${still.length}`);
        return { built: toBuild.length, remaining: still.length };
    }

    /**
     * Build one deferred dirty chunk (call once per frame for progressive loading).
     * @returns true if more deferred chunks remain, false if queue is empty.
     */
    buildNextDeferredChunk(): boolean {
        if (this.deferredDirtyChunks.length === 0) return false;
        const entry = this.deferredDirtyChunks.shift()!;
        const parts = entry.key.split(',');
        if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
            const cx = parseInt(parts[0], 10), cy = parseInt(parts[1], 10), cz = parseInt(parts[2], 10);
            if (!isNaN(cx) && !isNaN(cy) && !isNaN(cz)) {
                this.updateChunkPhysicsAndVisuals(entry.chunk, cx, cy, cz);
                const builtKeys = new Set<string>([entry.key]);
                this.updateCollisionVisualization(builtKeys);
                this.scheduleShadowUpdate();
                this.triggerFluidMeshRebuild(builtKeys);
            }
        }
        return this.deferredDirtyChunks.length > 0;
    }

    /** Check whether there are deferred dirty chunks or pending visual builds waiting. */
    hasDeferredChunks(): boolean { return this.deferredDirtyChunks.length > 0 || this.deferredVisualKeys !== null; }

    // ═══════════════════════════════════════════════════════════════════════
    // HIGH-LEVEL LEVEL GENERATION API
    // Call beginLevelGeneration() before building/regenerating a level.
    // All rebuildDirtyChunks() and endBatchUpdate() calls become no-ops.
    // Call endLevelGeneration() when done — it defers all dirty chunks and
    // builds only those near the specified corridor. Remaining chunks are
    // built automatically by tickDeferredBuild() (called from
    // VoxelTerrainSystem.update() every frame).
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Begin level generation phase. Suppresses all automatic chunk rebuilds
     * so that terrain modifications (clearing, placing blocks, carving trails,
     * placing decorations) accumulate dirty chunks without rebuilding.
     *
     * AI AGENTS: Call this before any level terrain generation sequence
     * (clearing old terrain, generating new terrain, carving paths, etc.)
     */
    beginLevelGeneration(): void {
        this.levelGenerationActive = true;
        this.autoRebuildSuppressed = true;
        console.log('[VoxelWorld] Level generation started — chunk rebuilds suppressed');
    }

    /**
     * End level generation phase. Defers all accumulated dirty chunks and
     * immediately builds only those near the specified corridor position
     * (so the player has ground to walk on). Remaining chunks are built
     * progressively via tickDeferredBuild().
     *
     * AI AGENTS: Call this after all terrain modifications are complete.
     * Pass the corridor center where the player spawns and a radius that
     * covers the walkable corridor area.
     *
     * @returns Object with count of corridor chunks built and total deferred.
     */
    endLevelGeneration(corridorCenterX: number, corridorCenterZ: number, corridorRadius: number): { built: number; deferred: number } {
        this.autoRebuildSuppressed = false;
        this.levelGenerationActive = false;
        this.deferAllDirtyChunks();
        const result = this.rebuildDirtyChunksNear(corridorCenterX, corridorCenterZ, corridorRadius);
        console.log(`[VoxelWorld] Level generation ended — built ${result.built} corridor chunks, ${result.remaining} deferred`);
        return { built: result.built, deferred: result.remaining };
    }

    /** Whether level generation is currently active (rebuilds suppressed). */
    isLevelGenerationActive(): boolean { return this.levelGenerationActive; }

    /**
     * Build deferred chunks progressively, splitting each chunk's work across
     * two frames to reduce per-frame cost:
     *   Frame N:   physics (greedy mesh + trimesh + Rapier colliders)
     *   Frame N+1: visual mesh (Three.js BufferGeometry + scene add)
     *
     * Called automatically by VoxelTerrainSystem.update() every frame.
     * @returns { active: true if more work remains, remaining: deferred chunk count }
     */
    tickDeferredBuild(): { active: boolean; remaining: number } {
        // Phase 2: Create visual mesh for chunk whose physics was built last frame
        if (this.deferredVisualKeys) {
            this.updateCollisionVisualization(this.deferredVisualKeys);
            this.scheduleShadowUpdate();
            this.triggerFluidMeshRebuild(this.deferredVisualKeys);
            this.deferredVisualKeys = null;
            const remaining = this.deferredDirtyChunks.length;
            return { active: remaining > 0, remaining };
        }

        // Phase 1: Build physics for next deferred chunk (visual deferred to next frame)
        if (this.deferredDirtyChunks.length === 0) return { active: false, remaining: 0 };
        const entry = this.deferredDirtyChunks.shift()!;
        const parts = entry.key.split(',');
        if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
            const cx = parseInt(parts[0], 10), cy = parseInt(parts[1], 10), cz = parseInt(parts[2], 10);
            if (!isNaN(cx) && !isNaN(cy) && !isNaN(cz)) {
                this.updateChunkPhysics(entry.chunk, cx, cy, cz);
                this.deferredVisualKeys = new Set([entry.key]);
            }
        }
        return { active: true, remaining: this.deferredDirtyChunks.length };
    }

    /** Set callback to trigger fluid mesh rebuild (called by WorldGenerator after creating VoxelFluidSystem). */
    setFluidUpdateCallback(callback: (dirtyChunkKeys: Set<string>) => void): void { this.onFluidBlocksChanged = callback; }
    
    /** Trigger fluid mesh rebuild for specific chunks (called after water added/removed). */
    triggerFluidMeshRebuild(dirtyChunkKeys: Set<string>): void { if (this.onFluidBlocksChanged && dirtyChunkKeys.size > 0) this.onFluidBlocksChanged(dirtyChunkKeys); }
}

/**
 * The vertex-colour terrain material for `'standard'` / `'lambert'` worlds.
 *
 * `'lambert'` forces Lambert — a published `VoxelWorldOptions.materialType`
 * contract (no in-tree caller, but frozen template code may pass it). For the
 * default `'standard'`, the LIGHTING TIER is owned by the material-quality
 * ladder rather than decided here: only the environment tier pays for
 * Standard+IBL, and `'direct'` deliberately collapses to Lambert too — a Phong
 * lobe on flat-shaded vertex-colour voxels buys nothing visible. Quality is
 * resolved when the world builds its one shared material (per-world, the
 * `VxlCharacterLoader` per-template precedent).
 *
 * Module-level and exported so the tier decision is testable without
 * constructing a `VoxelWorld`.
 */
export function createVertexColourTerrainMaterial(
    materialType: 'standard' | 'lambert',
    offset: { factor: number; units: number },
): THREE.Material {
    const params = {
        vertexColors: true,
        side: THREE.FrontSide,
        flatShading: true,
        depthWrite: true,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: offset.factor,
        polygonOffsetUnits: offset.units,
    };
    if (materialType === 'lambert') return new THREE.MeshLambertMaterial(params);
    const lighting = clampVoxelMaterialLighting('environment', activeMaterialQuality());
    return lighting === 'environment'
        ? new THREE.MeshStandardMaterial(params)
        : new THREE.MeshLambertMaterial(params);
}

