import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
    type BlockID,
    type ChunkKey,
    type VoxelBounds,
    type CollisionBox,
    CHUNK_SIZE,
    FACE_TEMPLATES,
    FACE_INDICES,
    VoxelChunk,
    generateCollisionBoxes,
    parseChunkKey,
    baseFootprint,
    type BaseFootprint,
    sphereIntersectsAabb,
} from 'engine/VoxelGeometry.js';
import { mergeVoxelRoundingRadiusVoxels, appendRoundedVoxelMesh, type RoundedAtlasContext } from 'engine/VoxelRoundedMesh.js';
import { getVoxelTextureAtlas, BlockType, type BlockTypeId } from 'engine/VoxelTextureAtlas.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { getMaterialRegistry } from 'engine/MaterialRegistry.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';
import { getZFightingRegistry } from 'engine/ZFightingRegistry.js';
import { convertChunkObjectToOctree } from 'engine/VoxelChunkToOctree.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { planeLockedDynamicBody, planeLockedStaticBody } from 'engine/VoxelObjectPlaneLocked.js';
import { finishDynamicVoxelBody } from 'engine/VoxelObjectColliderOps.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import {
    type OctreeNodeV2, type OctreeLeaf, type OctreeVoxelCells, type PhysicsBox, type OctreeMeshRounding, type LeafSource, LeafBuffer,
    flattenOctreeLeaves, buildOctreeMesh, buildOctreeMeshFromBuffers, createOctreeColliders, octreeTotalVolume, leafListCentroid,
    greedyMeshOctreeLeaves, leafSourceCount, octreeLeafIntersectsSpherePivotLocal,
    VOXEL_SLOT_HANDLES,
} from 'engine/VoxelOctreeRenderer.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import type { VoxelSlotMaterialHandle } from 'engine/VoxelSlotMaterial.js';
import { isVxlV3, decodeVxlV3, encodeVxlV3, type DecodedVxlV3, type DecodedFragment, type DecodedLodLevel, type VxlV3Data, type VxlV3RigInput } from 'engine/VxlV3Format.js';
import type { VxlV3Part } from 'engine/VxlV3Parts.js';
import { buildEditedVxlV3Data } from 'engine/VoxelObjectLeafEdit.js';
import { voxelObjectDebris } from 'engine/VoxelObjectDebris.js';
import { groundPlaneY, type FragmentAabb } from 'engine/FragmentConnectivity.js';
// Friend module (see its header): safe cycle — bindings only used at call time.
import {
    collapseUnsupportedAndFinalize, detachFragmentAt, getUnionVoxelCells, shatterAllFragments,
} from 'engine/VoxelObjectPristineOps.js';
import {
    attachUnionVoxelCollider, clearColliders, collectChunkPhysicsBoxes, createStaticVoxelBody, rebuildPhysicsColliders,
    type EnvInstanceRef,
    voxelCellCollidersFromChunks,
} from 'engine/VoxelObjectColliderOps.js';
import { radialBlastImpulse, pushDebrisOutward, debrisRigidBodyDesc, decodedToEncodable } from 'engine/VoxelExplosionHelpers.js';
import type { FragmentSlot } from 'engine/FragmentInstancePool.js';
import { type ObstacleHandle, type ObstacleProvider, registerObstacleProvider, unregisterObstacleProvider } from 'engine/VoxelNavMesh.js';
import { spatialMidpointPartition } from 'engine/VoxelLeafPartition.js';
import {
    type DynamicPhysicsBodyOptions, DEFAULT_DYNAMIC_PHYSICS_BODY_OPTIONS, DEFAULT_BALL_PHYSICS, createBallColliderDesc, trueUpBodyMass,
} from 'engine/physics/BallPhysics.js';
import { type VoxelFinishOptions, type VoxelFinishSettings, resolveVoxelFinishSettings, buildVoxelFinishMaterial, applyVoxelFinishToMesh } from 'engine/VoxelSurfaceFinish.js';

/**
 * How a pre-fragmented object comes apart when a blast hits it.
 *
 * `'partial'` keeps unaffected, still-supported fragments standing (a wall
 * loses the section you shot); `'shatter'` releases the whole object as loose
 * rigid bodies (a cactus or crate breaks up entirely rather than leaving its
 * top half floating where the bottom used to be).
 */
export type VoxelDestructionMode = 'partial' | 'shatter';

/**
 * Options for VoxelObject construction.
 */
export interface VoxelObjectOptions {
    /** Voxel size in world units (default 0.5m for environment objects) */
    voxelSize?: number;
    /** Use texture atlas for rendering (default false, uses vertex colors) */
    useAtlas?: boolean;
    /** Enable shadow casting and receiving (default true) */
    shadows?: boolean;
    /** Rounded voxel mesh in voxel lengths (× voxelSize). 0 = sharp cubes. */
    voxelRoundingRadiusVoxels?: number;
    /** Segments for rounded corners (default 2). */
    voxelRoundingSegments?: number;
    /**
     * Surface finish and shading-normal smoothing. Defaults reproduce the
     * historical faceted Lambert look; see engine/VoxelSurfaceFinish.ts.
     */
    finish?: VoxelFinishOptions;
    /**
     * Drop this many of the FINEST baked LOD levels at load time, promoting the
     * first surviving level to be this object's primary mesh. 0 (default) keeps
     * the baked resolution.
     *
     * The point is to not BUILD what will never be drawn. A caller that merely
     * skips the fine levels downstream still pays for them here — meshing the
     * finest level is the expensive half of loading a `.vxl`, and on a
     * hundred-thousand-voxel asset it is hundreds of milliseconds and a
     * geometry that then sits resident for the level's lifetime.
     *
     * Clamped at load against the levels the file actually carries, so an asset
     * baked with fewer LODs than requested still yields its coarsest one rather
     * than nothing. Read the effective value back with `getPrimaryLod()`.
     */
    primaryLod?: number;
}

/**
 * VoxelObject - A voxel-based 3D object for individual assets
 * 
 * Unlike VoxelWorld (designed for full level voxelization), VoxelObject is designed for:
 * - Individual placed objects (barrels, chairs, etc.)
 * - Local coordinate system (centered at 0,0,0 for proper rotation)
 * - Simple transform hierarchy (add to Group, rotate freely)
 * - No shadow/light receiver meshes (not needed for objects)
 * - Maintains voxel data for destruction effects
 */

import { VoxelDebrisManager, type VoxelDebris } from 'engine/VoxelDebrisManager.js';
import { chunksToOctreeLeaves } from 'engine/VoxelWorldVxlIO.js';
import { additionalLodsForSize } from 'engine/EnvLodPolicy.js';

export type { VoxelBounds as VoxelObjectBounds };
export type { PhysicsBox };

// Type alias for VoxelObject's debris
export type VoxelObjectDebris = VoxelDebris;

// Counter for generating unique VoxelObject IDs
let voxelObjectIdCounter = 0;

// Module-level engine reference for auto-registration of dynamic objects.
// Set once by GameEngine during initialization.
let _engineRef: { getDynamicObjectManager?: () => { register(obj: ChunkManagedObject, type: string, radius?: number): void; updatePosition(obj: ChunkManagedObject): void; getVoxelFloorY(x: number, feetY: number, z: number): number | null } } | null = null;

/** @internal Set the engine reference for auto-registration. Called by GameEngine. */
export function setVoxelObjectEngine(engine: typeof _engineRef): void {
    _engineRef = engine;
}

export type { DynamicPhysicsBodyOptions };
export { DEFAULT_BALL_PHYSICS };

/** Scratch matrix for the fragment-slot write in syncWithPhysics. */
const _slotMatrix = new THREE.Matrix4();

/** Per-face outward normals, in FACE_TEMPLATES order: [-Z, +Z, -X, +X, -Y, +Y]. */
const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
    [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0],
];

/** Per-vertex UVs of each face, matching the FACE_TEMPLATES vertex order. */
const FACE_UV_MAPS: readonly (readonly (readonly [number, number])[])[] = [
    [[0, 0], [1, 0], [1, 1], [0, 1]], // -Z (back)
    [[1, 0], [1, 1], [0, 1], [0, 0]], // +Z (front)
    [[1, 0], [1, 1], [0, 1], [0, 0]], // -X (left)
    [[0, 0], [1, 0], [1, 1], [0, 1]], // +X (right)
    [[0, 1], [0, 0], [1, 0], [1, 1]], // -Y (bottom)
    [[0, 0], [1, 0], [1, 1], [0, 1]], // +Y (top)
];

/** Whoever can register a dynamic prop for chunk-based hibernation (the engine, or a test double). */
type DynamicObjectManagerHost = { getDynamicObjectManager?: () => { register(obj: ChunkManagedObject, type: string, radius?: number): void } };

export class VoxelObject extends THREE.Group implements ChunkManagedObject {
    private chunks = new Map<ChunkKey, VoxelChunk>();
    private voxelSize: number;
    private bounds: VoxelBounds | null = null;
    private boundsInWorldUnits: boolean = false; // true if bounds from file (world units), false if from setVoxel (voxel units)
    private mesh: THREE.Mesh | null = null;
    private rigidBody: RAPIER.RigidBody | null = null;
    private colliders: RAPIER.Collider[] = [];
    private physicsWorld: PhysicsWorld | null = null;
    /**
     * Colors are atlas-quantised rather than plain RGB444. Readable because the
     * voxel editor needs to know whether a leaf color has an RGB inverse
     * (it drives which palette cell a leaf lands in on save); write through
     * `setUseAtlas`, which must still happen before finalize().
     */
    public useAtlas: boolean;
    private shadows: boolean;
    private voxelRoundingRadiusVoxels: number = 0;
    private voxelRoundingSegments: number = 2;
    private finish: VoxelFinishSettings;
    private _loadedFromFile: boolean = false; // true if loaded via loadFromFile (asset catalog)
    private _isDestroyed: boolean = false; // true after all voxels exploded (debris may still exist)
    private _cachedVoxelCount: number = -1; // Cache for voxel count (-1 = invalid)
    
    // Chunk-based hibernation for dynamic objects
    private _isHibernating: boolean = false;
    private _isDynamic: boolean = false; // Set when createDynamicPhysicsBody is called
    // Position at the last chunk re-registration; chunk registration is refreshed
    // in syncWithPhysics() once the body has moved meaningfully away from it.
    private _lastChunkRegPos: THREE.Vector3 = new THREE.Vector3();
    // Y offset from the body origin to the LOWEST point of its colliders.
    // The pivot is an arbitrary authoring point (often well below the physical
    // bottom), so terrain checks must use origin + this offset as the "feet".
    private _colliderBottomOffsetY: number = 0;
    /** Remaining sync frames a requested surface rest keeps retrying (0 = none pending). */
    private _surfaceRestFramesLeft: number = 0;
    /** Load-time prop: re-rest it whenever it wakes up barely moving inside a surface. */
    private _restsOnWake: boolean = false;
    /** Where a load-time prop came to rest; a wake that leaves it near here is an artifact. */
    private _restPosition: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
    /** ~15 s at 60 fps: covers a long menu stay before Play, after which the level is surely stepped. */
    private static readonly SURFACE_REST_MAX_FRAMES = 900;
    private _alwaysActive: boolean = false;

    // Navmesh obstacle bookkeeping. The engine auto-registers a tracked
    // obstacle for every world.json env object via setNavmeshObstacleEnabled()
    // — when the VoxelObject moves (physics push, drag, drop), the navmesh
    // re-paints. Game code can toggle the obstacle at runtime (e.g. tavern
    // chairs disable themselves while a villager sits on them). The provider
    // survives navmesh-instance swaps (Game.ts's rebuildHighResNavMesh).
    //
    // `navmeshObstacleOffsetX/Z` is the bbox centre in the OBJECT'S LOCAL
    // frame — non-zero whenever the asset's bounding box isn't centred on
    // the object's origin (e.g. a fence asset whose bbox runs from x=0 to
    // x=2.1 instead of x=−1.05 to x=+1.05). The tracked-obstacle getter
    // rotates this offset by the live yaw before adding it to the world
    // position, so the blocker lines up with the actual mesh regardless of
    // rotation.
    private navmeshObstacleProvider: ObstacleProvider | null = null;
    private navmeshObstacleHalfW: number = 0;
    private navmeshObstacleHalfD: number = 0;
    private navmeshObstacleOffsetX: number = 0;
    private navmeshObstacleOffsetZ: number = 0;

    // Captured at `detachAsDynamic()` so settled chunks can rebuild their
    // colliders (cuboids → one trimesh) using the same parent-pivot + scale
    // the dynamic colliders were built with. Without this we can't swap a
    // detached fragment's collider topology after the parent is gone.
    private _detachPivot: THREE.Vector3 | null = null;
    private _detachScale: THREE.Vector3 = new THREE.Vector3(1, 1, 1);

    // Multi-fragment lazy-split state. When non-null, this object's body
    // carries ONE union trimesh spanning every fragment — the pristine state.
    // The per-fragment `child.colliders` arrays are empty in this mode.
    // On the first `detachAsDynamic()` we call `splitPristineColliders()`
    // which removes the union and builds per-fragment trimeshes, so the
    // normal peel-by-fragment detach path takes over from then on.
    private _pristineUnionCollider: RAPIER.Collider | null = null;

    // Companion to `_pristineUnionCollider`: a single position-only mesh
    // covering every fragment's silhouette, used as the lone shadow caster
    // while the building is pristine. Per-fragment meshes get
    // `castShadow=false` during this state. On split we tear it down and
    // restore each fragment's `castShadow`.
    private _pristineShadowMesh: THREE.Mesh | null = null;

    // Slot in a shared per-fragment InstancedMesh pool (FragmentInstancePool).
    // Set on fragments materialised for a promoted batched destructible: the
    // slot IS the fragment's visual — the object carries no mesh of its own
    // unless a leaf-level mutation later forces one (rebuildOctreeMesh then
    // releases the slot and the own mesh takes over).
    private _fragmentSlot: FragmentSlot | null = null;

    // Per-TEMPLATE caches of the union collider geometry, built once per asset
    // type so every placed instance reuses them instead of re-greedy-meshing
    // 60+ fragments per instance at load. The boxes feed the dynamic (cuboid)
    // paths; the cell set is the static voxels collider (scale composes at
    // attach time). `undefined` = not computed yet; `null` = computed, no cells.
    private _unionColliderBoxes: PhysicsBox[] | null = null;
    private _unionVoxelCells: OctreeVoxelCells | null | undefined = undefined;

    // Post-explosion callback for structural collapse checks
    private _onPostExplosion: ((obj: VoxelObject) => void) | null = null;

    // Unique ID for z-fighting prevention - each VoxelObject gets unique polygon offset.
    // Multi-fragment children override this with the parent's id so every fragment of one
    // asset shares the same polygon offset — otherwise adjacent voxels in different
    // fragments draw with different depth biases and you see seams along fragment edges.
    private _zFightingId: string;

    // Pivot point for the mesh - calculated once and never changes during editing
    // This is the point around which the object is centered (in world units, snapped to voxel grid)
    private voxelPivot: { x: number; y: number; z: number } | null = null;
    
    // Bounds offset for coordinate conversion (stored when pivot is set)
    private storedBoundsOffset: { x: number; y: number; z: number } | null = null;
    
    // Octree v2 data — variable-sized voxels rendered directly without chunk conversion
    private _isOctreeV2 = false;
    // Voxel leaves: stored compactly as a LeafBuffer (~9 B/leaf) and materialised to
    // OctreeLeaf[] (`_octreeLeaves`) only on demand. Read `octreeLeaves` ONLY when the
    // leaves will be MUTATED (editor, carve, split) — the getter's expansion is
    // permanent, ~10× the bytes, and one object per voxel for the GC to trace.
    // Geometry-only consumers (collision, volume, the pristine shadow proxy) read
    // `octreeLeafSource` instead and iterate whichever form is resident, so an asset
    // that is never edited keeps its buffer for life (see the getter's doc for the
    // iPhone-jetsam incident this distinction exists for).
    private _octreeLeaves: OctreeLeaf[] | null = null;
    private _leafBuffer: LeafBuffer | null = null;
    private get octreeLeaves(): OctreeLeaf[] | null {
        if (this._octreeLeaves) return this._octreeLeaves;
        if (this._leafBuffer) { this._octreeLeaves = this._leafBuffer.toArray(this.useAtlas); this._leafBuffer = null; return this._octreeLeaves; }
        return null;
    }
    private set octreeLeaves(v: OctreeLeaf[] | null) { this._octreeLeaves = v; this._leafBuffer = null; }
    /**
     * The resident leaf storage in whichever form it holds — WITHOUT converting.
     * Geometry-only consumers (collision, volume, the pristine shadow proxy)
     * iterate this via forEachLeaf/createOctreeColliders, so a large asset keeps
     * its ~9 B/leaf buffer for its whole life. Reading `octreeLeaves` instead
     * materialises one JS object per voxel (~10× the bytes) and drops the buffer
     * permanently — on a city's landmark set that difference alone was ~600 MB,
     * enough to push iPhone loads over the jetsam line.
     */
    private get octreeLeafSource(): LeafSource | null { return this._octreeLeaves ?? this._leafBuffer; }
    /**
     * Every resident leaf source the object owns — one per fragment for a
     * multi-fragment container, its own single source otherwise — with nothing
     * converted and nothing flattened. This is the list form the collision and
     * volume helpers take (`LeafSources`), so the union paths can hand a whole
     * asset over without ever building the concatenated OctreeLeaf[].
     */
    private get octreeLeafSources(): LeafSource[] {
        if (this._fragments) {
            return this._fragments.map(c => c.octreeLeafSource).filter((s): s is LeafSource => s !== null);
        }
        const own = this.octreeLeafSource;
        return own ? [own] : [];
    }
    private _octreeRawData: { version: 2; metadata: Record<string, unknown>; root: OctreeNodeV2 } | null = null;
    private _vxlV3Data: DecodedVxlV3 | null = null;
    /**
     * Named material slots this object's voxels reference (v7 assets). Empty for
     * everything else, which then builds the usual single-material mesh. Held
     * separately from `_vxlV3Data` because fragment children and promoted pieces
     * carry only a leaf buffer, and their leaves' slot indices still have to
     * resolve to the same materials.
     */
    private _slots: VoxelSlot[] = [];
    private _smartParts: { rig: VxlV3RigInput; parts: VxlV3Part[] } | null = null;
    // True once the editor mutated `octreeLeaves` after load. toVXL() then
    // re-encodes from the LIVE leaves (with regenerated LODs) instead of
    // round-tripping `_vxlV3Data`, which no longer matches what's rendered.
    private _octreeLeafEdited = false;
    /**
     * Pre-built sub-fragment children for multi-fragment v3 assets. When set,
     * `this` is a container only (no own leaves / mesh / body); each child is
     * a normal static VoxelObject. Explosions detach affected children
     * whole-cloth rather than re-meshing the parent.
     */
    private _fragments: VoxelObject[] | null = null;
    /** Local AABB of each fragment in `_fragments` (object-local, not world). */
    private _fragmentAabbs: FragmentAabb[] | null = null;
    /**
     * The object's ORIGINAL base plane (min fragment Y over the full set at
     * load). Structural-collapse support must be measured against this, never
     * against the surviving fragments — once the base is blown away the lowest
     * survivor is the floating remnant itself, which would anchor the flood
     * fill and leave a smashed cactus hanging in mid-air.
     */
    private _fragmentGroundY = 0;
    /**
     * What a blast does to the REST of a pre-fragmented object.
     *  - `'partial'` — only fragments the blast touches detach, plus anything
     *    that loses its support path to the ground. Right for buildings and
     *    large structures that should break up piece by piece.
     *  - `'shatter'` — any qualifying hit releases EVERY remaining fragment as
     *    a rigid body. Right for small props (cacti, crates, signs): they come
     *    apart as a whole rather than leaving a hovering top half.
     * Placed env objects get this set by size (see EnvironmentObjectSystem);
     * the class default stays `'partial'` so directly-constructed VoxelObjects
     * keep their existing behaviour.
     */
    private _destructionMode: VoxelDestructionMode = 'partial';
    /** True for child fragments produced by multi-fragment v3 loading. */
    private _isFragment: boolean = false;
    /** Lazily-built unified mesh for the InstancedMesh batch path (LOD 0). */
    private _combinedFragmentMesh: THREE.Mesh | null = null;
    /**
     * Lazily-built unified meshes for LODs 1..N (additionalLods). Indexed
     * by `additionalLods` position so `_lodMeshes[k - 1]` is LOD k. Used by
     * the per-LOD InstancedMesh batch path; null entries are filled on
     * first request via getMeshForLod().
     */
    private _lodMeshes: (THREE.Mesh | null)[] | null = null;

    /** Finest-LOD drop REQUESTED via options; `_primaryLod` is what survived clamping. */
    private _requestedPrimaryLod: number = 0;

    /**
     * The baked LOD level this object's primary mesh was built from. 0 means the
     * finest (the normal case). Non-zero only on the single-fragment load path,
     * where promoting a coarser level is a pure substitution of leaf buffers.
     */
    private _primaryLod: number = 0;
    private _physicsGridStep: number | null = null;
    
    private getPhysicsGridStep(): number {
        return this._physicsGridStep ?? this.voxelSize;
    }

    /**
     * Resolve bounds offset and pivot for the current state, without locking
     * either in (see ensureVoxelPivot for that). The bounds offset is what gets
     * added to a global voxel index × voxelSize to get world coords: bounds read
     * from a file already are that offset, while voxel-unit bounds (accumulated
     * by setVoxel) start at the grid origin, so their offset is 0. Both fall back
     * to 0 when there are no bounds yet.
     */
    private getBoundsAndPivot(): {
        boundsOffsetX: number; boundsOffsetY: number; boundsOffsetZ: number;
        pivotX: number; pivotY: number; pivotZ: number;
    } {
        const sbo = this.storedBoundsOffset;
        const fileBounds = this.boundsInWorldUnits ? this.bounds : null;
        const pivot = this.voxelPivot ?? (this.bounds ? this.pivotFromBounds(this.bounds) : { x: 0, y: 0, z: 0 });
        return {
            boundsOffsetX: sbo?.x ?? fileBounds?.minX ?? 0,
            boundsOffsetY: sbo?.y ?? fileBounds?.minY ?? 0,
            boundsOffsetZ: sbo?.z ?? fileBounds?.minZ ?? 0,
            pivotX: pivot.x, pivotY: pivot.y, pivotZ: pivot.z,
        };
    }

    /**
     * Pivot implied by a bounds box: centre of the X/Z extent, bottom of Y.
     * `bounds.max` is EXCLUSIVE (one past the last voxel), so no +1 is needed.
     * File-loaded bounds are already in world units; bounds accumulated by
     * setVoxel are in voxel units and get scaled here.
     */
    private pivotFromBounds(bounds: VoxelBounds): { x: number; y: number; z: number } {
        const scale = this.boundsInWorldUnits ? 1 : this.voxelSize;
        return {
            x: (bounds.minX + bounds.maxX) / 2 * scale,
            y: bounds.minY * scale,
            z: (bounds.minZ + bounds.maxZ) / 2 * scale,
        };
    }

    /** Detach and dispose the current mesh (geometry + material). No-op if absent. */
    private disposeMesh(): void {
        const dropMesh = (m: THREE.Mesh | null): void => {
            if (!m) return;
            m.geometry.dispose();
            if (m.material instanceof THREE.Material) m.material.dispose();
        };
        dropMesh(this._combinedFragmentMesh);
        this._combinedFragmentMesh = null;
        if (this._lodMeshes) {
            for (const lodMesh of this._lodMeshes) dropMesh(lodMesh);
            this._lodMeshes = null;
        }
        if (this.mesh) {
            this.remove(this.mesh);
            dropMesh(this.mesh);
            this.mesh = null;
        }
    }

    /**
     * Lock in the object pivot (and the matching bounds offset) from `bounds`
     * if they haven't been resolved yet — computed once, never changed again, so
     * every mesh and collider path anchors at the same world-space origin.
     * Falls back to the origin when there are no bounds at all.
     */
    private ensureVoxelPivot(): { x: number; y: number; z: number } {
        if (!this.voxelPivot && this.bounds) {
            this.voxelPivot = this.pivotFromBounds(this.bounds);
            this.storedBoundsOffset = this.boundsInWorldUnits
                ? { x: this.bounds.minX, y: this.bounds.minY, z: this.bounds.minZ }
                : { x: 0, y: 0, z: 0 };
        }
        return this.voxelPivot ?? { x: 0, y: 0, z: 0 };
    }

    getPivot(): { x: number; y: number; z: number } | null {
        return this.voxelPivot;
    }

    /** Pre-set pivot + boundsOffset so finalize()/buildMesh() won't recalculate them.
     *  Used by structural collapse to keep fragments in the same coordinate space as the source. */
    setPivotAndBoundsOffset(
        pivot: { x: number; y: number; z: number },
        boundsOffset: { x: number; y: number; z: number }
    ): void {
        this.voxelPivot = { ...pivot };
        this.storedBoundsOffset = { ...boundsOffset };
    }

    getOctreeLeaves(): OctreeLeaf[] | null {
        return this.octreeLeaves;
    }

    /**
     * Leaf list ONLY if already materialised — never forces LeafBuffer
     * expansion. Checksum paths that sweep the whole scene use this so a
     * mere change-detection pass doesn't inflate every buffer-backed object
     * (~6× memory per leaf); buffer-backed objects keep their pre-edit
     * transform-only hash, which is correct — they can't have leaf edits.
     */
    getMaterializedOctreeLeaves(): OctreeLeaf[] | null {
        return this._octreeLeaves;
    }

    /** Whether this object uses octree V2 rendering */
    get isOctreeV2(): boolean {
        return this._isOctreeV2;
    }

    /** Remove octree leaves by index and rebuild mesh + physics. Returns removed leaves. */
    removeOctreeLeavesByIndex(indices: Set<number>): OctreeLeaf[] {
        const leaves = this.octreeLeaves;
        if (!leaves) return [];
        const removed: OctreeLeaf[] = [];
        const remaining: OctreeLeaf[] = [];
        for (let i = 0; i < leaves.length; i++) {
            (indices.has(i) ? removed : remaining).push(leaves[i]!);
        }
        this.octreeLeaves = remaining;
        this._cachedVoxelCount = -1;
        this.finalizeAfterRemoval(remaining.length > 0, false);
        return removed;
    }

    /**
     * Replace the octree leaf list after an editor mutation and rebuild the
     * mesh. Physics is deliberately NOT rebuilt here — editors batch that
     * through `refreshAfterLeafEdit()` when the edit session ends. Marks the
     * object leaf-edited so `toVXL()` re-encodes from the live leaves.
     * No-op for non-octree or pre-fragmented (multi-fragment) objects.
     */
    setOctreeLeavesForEdit(leaves: OctreeLeaf[]): void {
        if (!this._isOctreeV2 || this._fragments) return;
        this.octreeLeaves = leaves;
        this._cachedVoxelCount = -1;
        this._octreeLeafEdited = true;
        this.rebuildOctreeMesh();
    }

    /** Rebuild mesh + physics once at the end of an edit session (both voxel generations). */
    refreshAfterLeafEdit(): void {
        this.finalizeAfterRemoval(this.getVoxelCount() > 0, false);
    }

    /** True once the editor mutated this object's octree leaves after load. */
    get isOctreeLeafEdited(): boolean {
        return this._octreeLeafEdited;
    }

    /** Initialize this VoxelObject directly from octree leaves (for structural collapse fragments) */
    initFromOctreeLeaves(leaves: OctreeLeaf[], voxelSize: number, pivot: { x: number; y: number; z: number }): void {
        this._isOctreeV2 = true;
        this.octreeLeaves = leaves;
        this.voxelSize = voxelSize;
        this.voxelPivot = { ...pivot };
        this._cachedVoxelCount = -1;
        this._loadedFromFile = true;
        this.rebuildOctreeMesh();
    }

    /**
     * Show/hide ONLY the LOD-0 geometry — `this.mesh` for a
     * single-fragment object, or the fragment children for a
     * multi-fragment one. Additional-LOD meshes that a caller
     * (`VxlChunkedTerrainSystem`) has parented under this object are
     * deliberately left untouched, so the chunk LOD switch can hide
     * LOD 0 without also hiding the LOD-k mesh it's about to show.
     *
     * Needed because multi-fragment objects carry their LOD-0 geometry
     * on child VoxelObjects, not on `this.mesh` — so a caller can't just
     * toggle one mesh reference.
     */
    setLod0Visible(visible: boolean): void {
        if (this.mesh) this.mesh.visible = visible;
        if (this._fragments) {
            for (const child of this._fragments) child.visible = visible;
        }
    }

    /** Get the physics world reference */
    getPhysicsWorld(): PhysicsWorld | null {
        return this.physicsWorld;
    }

    /**
     * The rigid body, but only while it is still alive in the physics world.
     * Every mutation path goes through this — Rapier throws when a body that has
     * already been removed is touched.
     */
    private get liveBody(): RAPIER.RigidBody | null {
        return this.rigidBody?.isValid() ? this.rigidBody : null;
    }

    /**
     * This object's up-to-date world transform, split into the pieces the
     * physics paths need: bodies are placed at the world position/rotation and
     * colliders are baked with the world scale (Rapier has no node scale).
     */
    private decomposeWorld(): { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 } {
        this.updateMatrixWorld(true);
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        this.matrixWorld.decompose(pos, quat, scale);
        return { pos, quat, scale };
    }

    /**
     * Express a world-space point in this object's local frame — the frame its
     * mesh vertices, octree leaves and fragment AABBs all live in. Blast callers
     * also need the world transform it was derived from, so that comes back too.
     */
    private toLocalFrame(worldPoint: THREE.Vector3): {
        localPoint: THREE.Vector3; worldPos: THREE.Vector3; worldQuat: THREE.Quaternion;
    } {
        const worldPos = new THREE.Vector3();
        this.getWorldPosition(worldPos);
        const worldQuat = new THREE.Quaternion();
        this.getWorldQuaternion(worldQuat);
        const localPoint = worldPoint.clone().sub(worldPos).applyQuaternion(worldQuat.clone().invert());
        return { localPoint, worldPos, worldQuat };
    }

    /** Get the physics colliders */
    getColliders(): RAPIER.Collider[] {
        return this.colliders;
    }

    getPhysicsGridStepValue(): number {
        return this.getPhysicsGridStep();
    }

    /**
     * The decoded file this object was loaded from (null when built procedurally).
     * Read-only by contract: the smart-object view reads the parts table and rig
     * off it; nothing outside this class mutates it.
     */
    getDecodedVxlV3(): DecodedVxlV3 | null { return this._vxlV3Data; }

    /**
     * One mesh per smart-object joint that owns leaves (v12), built by the same
     * mesher, pivot, atlas flag, rounding and slot table as `getMesh()`, so a part
     * looks identical to the batched neighbour it was cut from. Joint 0 is the
     * body; LOD 0 only; null when the file declares no parts. The meshes are NOT
     * added here — `SmartObjectView` parents each under its pivot group — and they
     * share `getMesh()`'s vertex space (object local, relative to the voxel pivot),
     * which is what lets the view place them by pivot alone.
     */
    buildSmartPartMeshes(): Array<{ joint: number; mesh: THREE.Mesh }> | null {
        const data = this._vxlV3Data;
        if (!data?.parts?.length) return null;
        const pivot = this.ensureVoxelPivot();
        const out: Array<{ joint: number; mesh: THREE.Mesh }> = [];
        for (let joint = 0; joint <= data.parts.length; joint++) {
            const subsets = data.fragments
                .map((f) => f.leaves.subset((i) => (f.leaves.bone?.[i] ?? 0) === joint))
                .filter((buf) => buf.count > 0);
            const mesh = subsets.length > 0 ? buildOctreeMeshFromBuffers(subsets, pivot.x, pivot.y, pivot.z,
                this.shadows, `${this._zFightingId}_part${joint}`, this.useAtlas, this.getOctreeRounding(), this._slots) : null;
            if (mesh) out.push({ joint, mesh });
        }
        return out;
    }

    getMesh(): THREE.Mesh | null {
        if (this.mesh) return this.mesh;
        // Multi-fragment v3 templates have no own mesh — the children carry
        // the geometry. The InstancedMesh batch path in EnvironmentObjectSystem
        // needs a single template mesh, so build a combined one lazily here
        // by re-running the octree mesher on the flattened leaf list.
        if (this._fragments && this._vxlV3Data) {
            return this.buildCombinedFragmentMesh();
        }
        return null;
    }

    /**
     * Build (and cache) a unified mesh from every leaf across all fragments,
     * for callers that need one "template" geometry — primarily the
     * InstancedMesh batch path. Disposed in `disposeMesh`.
     */
    private buildCombinedFragmentMesh(): THREE.Mesh | null {
        if (this._combinedFragmentMesh) return this._combinedFragmentMesh;
        if (!this._vxlV3Data) return null;
        this._combinedFragmentMesh = this.buildMeshFromFragments(this._vxlV3Data.fragments, this._zFightingId);
        return this._combinedFragmentMesh;
    }

    /**
     * Flatten every fragment's leaves into one octree mesh anchored at the
     * object pivot. Shared by the LOD-0 combined mesh and the per-LOD meshes
     * so they line up at the same world-space origin. Returns null when there
     * are no leaves.
     */
    private buildMeshFromFragments(fragments: DecodedFragment[], zFightingId: string): THREE.Mesh | null {
        const pivot = this.ensureVoxelPivot();
        return buildOctreeMeshFromBuffers(fragments.map(f => f.leaves), pivot.x, pivot.y, pivot.z, this.shadows, zFightingId, this.useAtlas, this.getOctreeRounding(), this._slots);
    }

    /**
     * Total LOD count (>=1). LOD 0 is the primary fragments; LODs 1..N are
     * the coarser levels baked into the v4 trailer. Returns 1 for objects
     * not loaded from a v4 file (or with no additionalLods).
     */
    getLodCount(): number {
        return 1 + (this._vxlV3Data?.additionalLods?.length ?? 0);
    }

    /**
     * The baked LOD level this object's primary mesh was built from — the requested
     * `primaryLod` after clamping to the levels the file carries (0 when nothing was
     * promoted). Callers building per-LOD meshes should start their loop here, since
     * every finer level resolves to this same mesh.
     */
    getPrimaryLod(): number {
        return this._primaryLod;
    }

    /**
     * Return a unified template mesh for LOD `k`. k=0 returns the primary
     * combined mesh (same as `getMesh()`); k>0 builds-and-caches a mesh
     * from `additionalLods[k - 1].fragments`. Returns null when the
     * requested LOD doesn't exist or has no leaves.
     *
     * The same pivot used by LOD 0 anchors every LOD so they line up at the
     * same world-space origin when slotted into per-LOD InstancedMeshes.
     */
    getMeshForLod(k: number): THREE.Mesh | null {
        if (k <= this._primaryLod) return this.getMesh();
        if (!this._vxlV3Data?.additionalLods) return null;
        const lodIdx = k - 1;
        const lod = this._vxlV3Data.additionalLods[lodIdx];
        if (!lod) return null;
        if (!this._lodMeshes) {
            this._lodMeshes = new Array(this._vxlV3Data.additionalLods.length).fill(null);
        }
        const cached = this._lodMeshes[lodIdx];
        if (cached) return cached;

        // Anchored at the same pivot as LOD 0 so transforms align across LODs.
        const mesh = this.buildMeshFromFragments(lod.fragments, `${this._zFightingId}_lod${k}`);
        this._lodMeshes[lodIdx] = mesh;
        return mesh;
    }

    getPhysicsInfo(): {
        hasCollider: boolean;
        isDynamic: boolean;
        colliderCount: number;
        colliderType: string;
        triangleCount?: number;
    } {
        if (!this.rigidBody || this.colliders.length === 0) {
            return { hasCollider: false, isDynamic: false, colliderCount: 0, colliderType: 'none' };
        }
        const count = this.colliders.length;
        const isDynamic = this._isDynamic;
        if (count === 1 && !isDynamic) {
            const shape = this.colliders[0]?.shape;
            if (shape?.type === 3) { // RAPIER ShapeType.TriMesh = 3
                const numTris = (shape as unknown as { numTriangles(): number }).numTriangles?.() ?? 0;
                return { hasCollider: true, isDynamic, colliderCount: 1, colliderType: 'trimesh', triangleCount: numTris };
            }
        }
        return { hasCollider: true, isDynamic, colliderCount: count, colliderType: isDynamic ? 'box (dynamic)' : 'box' };
    }

    constructor(options: VoxelObjectOptions = {}) {
        super();
        this.voxelSize = options.voxelSize ?? 0.5;
        this.useAtlas = options.useAtlas ?? false;
        this.shadows = options.shadows ?? true;
        this.voxelRoundingRadiusVoxels = options.voxelRoundingRadiusVoxels ?? 0;
        this.voxelRoundingSegments = Math.max(1, options.voxelRoundingSegments ?? 2);
        this.finish = resolveVoxelFinishSettings(options.finish);
        this._requestedPrimaryLod = Math.max(0, Math.floor(options.primaryLod ?? 0));
        this.name = 'VoxelObject';
        this._zFightingId = `voxelObject_${voxelObjectIdCounter++}`;
    }

    // ─── Navmesh obstacle (engine auto-registers; game code can toggle) ─────

    /**
     * Enable or disable this VoxelObject as a navmesh obstacle.
     *
     * The engine automatically calls `setNavmeshObstacleEnabled(true, …)` for
     * every world.json env object during placement (skipping any with
     * `obstacle: false`). Game code can call it again at runtime to toggle the
     * obstacle without destroying/recreating the VoxelObject — e.g. a tavern
     * chair disables its obstacle while a villager sits on it, then re-enables
     * it on stand-up.
     *
     * The obstacle is **tracked**: its world position and yaw are read live from
     * `this.position` / `this.rotation.y` each `VoxelNavMesh.tick()`, so physics
     * pushes are picked up automatically.
     *
     * `halfW` / `halfD` are the bbox half-extents in the object's local frame
     * (world meters). `offsetX` / `offsetZ` are the bbox centre in that frame —
     * pass them whenever the asset's bbox is NOT centred on the object's origin
     * (e.g. a fence with bbox `x ∈ [0, 2.1]`, centre at local X = 1.05); the
     * engine rotates the offset by the live yaw each frame before adding it to
     * the world position. Pass dimensions only when they change; subsequent
     * toggle calls reuse the stored values.
     */
    setNavmeshObstacleEnabled(enabled: boolean, halfW?: number, halfD?: number, offsetX?: number, offsetZ?: number): void {
        if (halfW !== undefined && halfW > 0) this.navmeshObstacleHalfW = halfW;
        if (halfD !== undefined && halfD > 0) this.navmeshObstacleHalfD = halfD;
        if (offsetX !== undefined) this.navmeshObstacleOffsetX = offsetX;
        if (offsetZ !== undefined) this.navmeshObstacleOffsetZ = offsetZ;
        if (enabled) {
            if (this.navmeshObstacleProvider) return; // already enabled
            const hw = this.navmeshObstacleHalfW;
            const hd = this.navmeshObstacleHalfD;
            if (hw <= 0 || hd <= 0) {
                console.warn(`[VoxelObject] setNavmeshObstacleEnabled(true) called without bbox dimensions; obstacle not registered for "${this.name}".`);
                return;
            }
            const ox = this.navmeshObstacleOffsetX;
            const oz = this.navmeshObstacleOffsetZ;
            // Provider getter rotates the local-frame offset by the live
            // yaw and adds to world position. Matches the world-to-local
            // forward rotation used by paintBox (R_y per gameplay yaw):
            //   wx = cosθ·lx + sinθ·lz, wz = −sinθ·lx + cosθ·lz.
            this.navmeshObstacleProvider = registerObstacleProvider(() => {
                const yaw = this.rotation.y;
                const cosY = Math.cos(yaw);
                const sinY = Math.sin(yaw);
                return {
                    kind: 'box',
                    x: this.position.x + cosY * ox + sinY * oz,
                    z: this.position.z + -sinY * ox + cosY * oz,
                    halfW: hw,
                    halfD: hd,
                    yaw,
                };
            });
        } else {
            if (!this.navmeshObstacleProvider) return; // already disabled
            unregisterObstacleProvider(this.navmeshObstacleProvider);
            this.navmeshObstacleProvider = null;
        }
    }

    /** True if this VoxelObject is currently registered as a navmesh obstacle. */
    isNavmeshObstacleEnabled(): boolean {
        return this.navmeshObstacleProvider !== null;
    }

    /** The obstacle handle on the current navmesh. 0 if no navmesh is active. */
    getNavmeshObstacleHandle(): ObstacleHandle {
        return this.navmeshObstacleProvider?.currentHandle ?? 0;
    }

    /** Returns true if this object was loaded from a file (asset catalog) or marked as unique */
    isFromAssetCatalog(): boolean {
        return this._loadedFromFile;
    }
    
    /** Returns true if all voxels have been destroyed (debris may still exist) */
    isDestroyed(): boolean {
        return this._isDestroyed;
    }

    /**
     * Choose how this object comes apart — see `VoxelDestructionMode`. Small
     * props want `'shatter'` (the whole thing is released on a hit); buildings
     * and large structures want `'partial'` (the default). Placed environment
     * objects are configured automatically by size and can override it with
     * `destructionMode` in world.json.
     */
    setDestructionMode(mode: VoxelDestructionMode): void {
        this._destructionMode = mode;
    }

    getDestructionMode(): VoxelDestructionMode {
        return this._destructionMode;
    }

    /** Set a callback invoked after explodeAt() when voxels remain (for structural collapse checks) */
    setOnPostExplosion(cb: ((obj: VoxelObject) => void) | null): void {
        this._onPostExplosion = cb;
    }
    
    /**
     * Get VoxelObject from a Rapier rigid body (if it belongs to a VoxelObject).
     * Use this in projectile hit callbacks to check if you hit a VoxelObject.
     */
    static fromRigidBody(body: RAPIER.RigidBody, physicsWorld: PhysicsWorld): VoxelObject | null {
        const userData = physicsWorld.getUserDataFromHandle(body.handle) as { voxelObject?: VoxelObject } | null;
        return userData?.voxelObject ?? null;
    }

    /** Mark this object as unique (no longer shared with other instances) */
    markAsUnique(): void {
        this._loadedFromFile = true;
    }

    /**
     * Whether this object's geometry may be mutated per-hit (bullet holes).
     *
     * Defaults to FALSE and must be opted into, because the dangerous case is
     * indistinguishable at the call site: a plain batched environment prop
     * reports the SHARED TEMPLATE from `fromRigidBody`, since every instance of
     * that type points its physics body at the same object. Carving that would
     * punch the same hole in every copy in the level. There is no flag on a
     * VoxelObject that says "I am a template", so the safe default is to carve
     * nothing and let the owners of genuinely per-instance objects say so.
     */
    private _carveable = false;

    /** Allow per-hit geometry mutation. Only for objects that own their geometry. */
    setCarveable(carveable: boolean): void {
        this._carveable = carveable;
    }

    isCarveable(): boolean {
        return this._carveable;
    }

    /**
     * Set whether this object uses texture atlas rendering.
     * When true, block types are rendered with textures from the atlas.
     * When false, vertex colors are used.
     * Must be called before finalize().
     */
    setUseAtlas(useAtlas: boolean): void {
        this.useAtlas = useAtlas;
    }

    /**
     * Load a `.vxl` asset — either format.
     *
     * VXL3 loads directly. The LEGACY JSON form is read and UPGRADED in place: decoded,
     * converted to the octree representation, and from there it behaves exactly as a
     * VXL3 asset does, including re-encoding through `toVXL()`.
     *
     * This used to throw. The reasoning was sound — the old form is ~130x larger and
     * carries no LOD trailer, so it had no business on a hot load path — but refusing it
     * made every pre-VXL3 asset in every EXISTING game unrenderable, and neither caller
     * surfaces that: `EnvironmentObjectSystem` catches and skips the objects,
     * `PlacedObjectSystem` catches and leaves a red placeholder. The symptom was scenery
     * that silently was not there, in games nobody had touched.
     *
     * The cost objection is answered by converting rather than by refusing: the legacy
     * decode happens once, here, and everything downstream sees an octree. What it does
     * NOT do is make the asset cheap at rest — that needs the file re-saved, which is
     * what the warning asks for and what `EditorManager.convertLegacyVxlAsset` performs.
     */
    async loadFromFile(buffer: ArrayBuffer, options?: { distinctFragmentOffsets?: boolean }): Promise<VoxelBounds | null> {
        if (isVxlV3(buffer)) return this.loadVxlBuffer(buffer, options);

        console.warn(
            `[VoxelObject] "${this.name || 'unnamed'}" is stored as legacy JSON .vxl — upgrading it`
            + ' in memory. Re-save the asset to store it as VXL3; until then this conversion is'
            + ' repeated on every load, and the file carries no LOD levels for mobile to drop.',
        );
        // Defer the chunk mesh: the octree conversion below rebuilds the geometry from
        // leaves immediately after, so building it here would be the most expensive part
        // of the load, discarded. `version: 2` files arrive as octree already and are
        // meshed by their own path, so this only affects the chunked form.
        const bounds = await this.loadVxlBuffer(buffer, options, true, true);
        if (!this._isOctreeV2 && !convertChunkObjectToOctree(this)) {
            // Nothing to convert (an asset with no solid voxels). Build the mesh we
            // skipped so the object is left in the same state the chunk path would.
            this.buildMesh();
        }
        return bounds;
    }

    /**
     * Load the LEGACY JSON form keeping the CHUNK representation — the re-save path.
     *
     * `loadFromFile` also reads the old form, but upgrades it to octree for rendering.
     * This one deliberately does not, because `toVXL()`'s chunk-grid branch SYNTHESISES
     * a LOD schedule while its octree branch can only carry levels the source file had —
     * and a legacy file has none. Re-saving through here is therefore what produces an
     * asset with LODs; going through the runtime upgrade would write a flat one.
     */
    async loadLegacyJsonForConversion(buffer: ArrayBuffer): Promise<VoxelBounds | null> {
        if (isVxlV3(buffer)) return this.loadVxlBuffer(buffer);
        return this.loadVxlBuffer(buffer, undefined, true);
    }

    private async loadVxlBuffer(
        buffer: ArrayBuffer,
        options?: { distinctFragmentOffsets?: boolean },
        allowLegacyJson = false,
        /** Skip the chunk mesh build — only for a caller that re-meshes from octree leaves straight after. */
        deferMesh = false,
    ): Promise<VoxelBounds | null> {
        this._cachedVoxelCount = -1; // Invalidate cache
        this._loadedFromFile = true;

        // v3 binary detection: first 4 bytes are "VXL3" magic.
        if (isVxlV3(buffer)) {
            return await this.loadVxlV3(buffer, options);
        }

        if (!allowLegacyJson) {
            throw new Error('[VoxelObject] legacy JSON .vxl reached the runtime loader');
        }
        const decoder = new TextDecoder();
        const json = decoder.decode(buffer);

        let data: any;
        try {
            data = JSON.parse(json);
        } catch (error) {
            console.error(`[VoxelObject] Failed to parse voxel file:`, error);
            throw error;
        }

        if (data.version === 2) {
            return this.loadOctreeV2(data);
        }
        
        const chunksData = data.chunks || data;
        const metadata = data.metadata || {};
        
        if (metadata.voxelSize) {
            this.voxelSize = metadata.voxelSize;
        }
        
        if (metadata.bounds) {
            this.bounds = metadata.bounds;
            this.boundsInWorldUnits = true; // Bounds from file are in world units
        }
        
        // Load pivot if present (otherwise will be calculated in buildMesh)
        if (metadata.pivot) {
            this.voxelPivot = metadata.pivot;
        }
        if (metadata.boundsOffset) {
            this.storedBoundsOffset = metadata.boundsOffset;
        }
        if (metadata.useAtlas !== undefined) {
            this.useAtlas = metadata.useAtlas;
        }

        this.chunks.clear();

        for (const [key, chunkData] of Object.entries(chunksData)) {
            const chunk = new VoxelChunk();
            const dataObj = chunkData as { 
                p: BlockID[], 
                d?: number[], 
                dl?: number,
                voxels?: Array<{x: number, y: number, z: number, blockId: number, color?: number}>,
                cd?: number[],
                cdl?: number
            };
            
            chunk.palette = dataObj.p;
            
            if (dataObj.cd) {
                chunk.colors.data = new Uint32Array(dataObj.cd);
                chunk.colors.length = dataObj.cd.length;
            }
            
            if (dataObj.d) {
                chunk.setRleData(dataObj.d);
            } else if (dataObj.voxels) {
                chunk.clearRleRuns();
                for (const voxel of dataObj.voxels) {
                    const paletteIndex = chunk.palette.indexOf(voxel.blockId);
                    if (paletteIndex === -1) continue;
                    chunk.set(voxel.x, voxel.y, voxel.z, voxel.blockId);
                    if (voxel.color !== undefined) {
                        chunk.colors.data[0] = voxel.color;
                    }
                }
            } else {
                continue;
            }
            
            this.chunks.set(key, chunk);
        }
        
        this.generateAllCollisionBoxes();
        if (!deferMesh) this.buildMesh();

        return this.bounds;
    }

    private loadOctreeV2(data: { version: 2; metadata: Record<string, unknown>; root: OctreeNodeV2 }): VoxelBounds | null {
        this._isOctreeV2 = true;
        this._octreeRawData = data;
        const meta = data.metadata;
        if (typeof meta.minVoxelSize === 'number') this.voxelSize = meta.minVoxelSize;
        if (typeof meta.physicsGridStep === 'number') this._physicsGridStep = meta.physicsGridStep;
        const b = meta.bounds as VoxelBounds | undefined;
        if (b) { this.bounds = b; this.boundsInWorldUnits = true; }
        if (typeof meta.useAtlas === 'boolean') this.useAtlas = meta.useAtlas;
        if (meta.pivot) this.voxelPivot = meta.pivot as { x: number; y: number; z: number };
        if (meta.boundsOffset) this.storedBoundsOffset = meta.boundsOffset as { x: number; y: number; z: number };

        this.octreeLeaves = [];
        flattenOctreeLeaves(data.root, this.octreeLeaves);
        this.rebuildOctreeMesh();
        return this.bounds;
    }

    /**
     * Load a v3 packed-binary VXL.
     */
    private async loadVxlV3(buffer: ArrayBuffer, options?: { distinctFragmentOffsets?: boolean }): Promise<VoxelBounds | null> {
        return this.applyVxlV3Data(await decodeVxlV3(buffer), options);
    }

    /**
     * Populate `this` from decoded v3 data.
     *
     * Single-fragment files: behave like v2 — all leaves live on `this` and
     * get rendered/colliders as one block.
     *
     * Multi-fragment files (the pre-fragmented case): build N child
     * VoxelObjects under `this`, one per fragment. `this` then has no own
     * mesh/body — it's a container. Explosions iterate children and detach
     * affected ones as dynamic bodies; the parent's mesh and collider
     * topology never gets rebuilt at runtime, which is the whole point.
     *
     * Separate from `loadVxlV3` so `cloneDataTo` can call it directly with
     * already-decoded data when copying multi-fragment templates into
     * per-instance clones (used by EnvironmentObjectSystem).
     */
    private applyVxlV3Data(data: DecodedVxlV3, options?: { distinctFragmentOffsets?: boolean }): VoxelBounds | null {
        this._isOctreeV2 = true;
        this._vxlV3Data = data;
        this._slots = data.slots ?? [];
        this._octreeRawData = null;
        this.voxelSize = data.minVoxelSize;
        this._physicsGridStep = data.physicsGridStep;
        this.bounds = { ...data.bounds };
        this.boundsInWorldUnits = true;
        this.useAtlas = data.useAtlas;
        // Force pivot recompute from new bounds.
        this.voxelPivot = null;
        this.storedBoundsOffset = null;

        // Drop any stale fragment children before re-populating.
        if (this._fragments) {
            for (const child of this._fragments) {
                this.remove(child);
                child.dispose();
            }
        }
        this._fragments = null;
        this._fragmentAabbs = null;

        if (data.fragments.length <= 1) {
            // Keep the compact buffer; octreeLeaves materialises lazily only if an
            // edit / physics / destruction path later needs object form.
            this._leafBuffer = data.fragments[0]?.leaves ?? null;
            this._octreeLeaves = null;
            // Promote a coarser baked level to primary when asked, clamped to what this
            // file actually carries. The finest leaves STAY in `_leafBuffer`: colliders,
            // edits and destruction keep reading true resolution, and any later
            // `rebuildOctreeMesh` (post-edit, post-shatter) rebuilds at full detail —
            // the coarse LOD's leaves know nothing about voxels removed since load.
            // Only the geometry built HERE, and only for an untouched object, coarsens.
            this._primaryLod = Math.min(this._requestedPrimaryLod, data.additionalLods?.length ?? 0);
            if (this._primaryLod > 0) this.buildPromotedPrimaryMesh();
            else this.rebuildOctreeMesh();
            return this.bounds;
        }

        // Multi-fragment path: this becomes a container, children carry the data.
        this.octreeLeaves = null;
        this._fragments = [];
        this._fragmentAabbs = [];
        // Base plane captured from the FULL set, before anything can detach.
        this._fragmentGroundY = groundPlaneY(data.fragments.map(
            f => ({ min: f.aabbMin, max: f.aabbMax }),
        ));
        for (const fragment of data.fragments) {
            const child = new VoxelObject({
                voxelSize: data.minVoxelSize,
                shadows: this.shadows,
                voxelRoundingRadiusVoxels: this.voxelRoundingRadiusVoxels,
                voxelRoundingSegments: this.voxelRoundingSegments,
            });
            child.name = `${this.name || 'fragment'}#${this._fragments.length}`;
            child._isOctreeV2 = true;
            child._isFragment = true;
            // Per-fragment polygon offset policy:
            // - Default (`distinctFragmentOffsets` false / unset) — fragments
            //   come from the SAME asset's pre-fragmentation (e.g. a building
            //   that explodes into chunks). They tile within one asset, so
            //   sharing offset prevents visible seams along fragment edges.
            // - VWLD chunked terrain (`distinctFragmentOffsets` true) — each
            //   fragment is a DIFFERENT source object packed into the same
            //   chunk (road / grass / mountain / etc.). They overlap rather
            //   than tile, so each needs its own offset slot to prevent
            //   z-fighting between same-cell voxels from different objects.
            child._zFightingId = options?.distinctFragmentOffsets
                ? `${this._zFightingId}_f${this._fragments.length}`
                : this._zFightingId;
            child._physicsGridStep = data.physicsGridStep;
            // Children share the parent's bounds so they all use the same
            // pivot — vertex positions in each child mesh line up exactly
            // with where they would be in a single unified mesh.
            child.bounds = { ...data.bounds };
            child.boundsInWorldUnits = true;
            child.useAtlas = data.useAtlas;
            child._slots = this._slots;
            child._leafBuffer = fragment.leaves;
            child.rebuildOctreeMesh();
            this.add(child);
            this._fragments.push(child);
            this._fragmentAabbs.push({ min: fragment.aabbMin, max: fragment.aabbMax });
        }
        return this.bounds;
    }

    /**
     * Export voxel data to VXL format (ArrayBuffer).
     * Includes pivot point so edited objects maintain their position.
     */
    async toVXL(): Promise<ArrayBuffer> {
        if (this._isOctreeV2) {
            // A leaf-edited object encodes from the LIVE leaves: bounds are
            // recomputed and coarser LODs are REGENERATED from the edited
            // LOD 0 — round-tripping `_vxlV3Data` here would persist the
            // pre-edit voxels and stale LOD levels. Everything else
            // round-trips the v3 binary as-is; we don't re-fragment on save,
            // so the current fragment layout (or its absence) is preserved.
            const editedLeaves = this._octreeLeafEdited && !this._fragments ? this.octreeLeaves : null;
            // `_smartParts` last: a BUILT smart object has no template to take its rig and parts from.
            const v3Data = editedLeaves
                ? { ...buildEditedVxlV3Data(editedLeaves, this._vxlV3Data, { voxelSize: this.voxelSize, physicsGridStep: this.getPhysicsGridStep(), useAtlas: this.useAtlas }, this._slots), ...(this._smartParts ?? {}) }
                : this._vxlV3Data
                    ? {
                        ...decodedToEncodable(this._vxlV3Data),
                        // The LIVE slot table, never the decode's. A session that only retuned a
                        // material's glow — or created one — edits no LEAF, so `_octreeLeafEdited`
                        // stays false and the save lands here. `_vxlV3Data.slots` is what the file
                        // held when it loaded, so using it silently undid the very change the save
                        // was reporting success for.
                        ...(this._slots.length > 0 ? { slots: this._slots } : {}),
                    }
                    : null;
            if (v3Data) {
                const bytes = await encodeVxlV3(v3Data);
                const out = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(out).set(bytes);
                return out;
            }
            if (this._octreeRawData) {
                const encoder = new TextEncoder();
                return encoder.encode(JSON.stringify(this._octreeRawData)).buffer;
            }
        }
        // Chunk-backed objects — built procedurally in code rather than loaded from a
        // file — ALSO save as VXL3. This branch used to write a JSON form, which is
        // where every legacy asset in the wild came from: the world forger builds its
        // placeholders procedurally, so every one of them was written as JSON. Measured
        // on a forged circuit, that cost 324 KB against 2.4 KB for the same prop baked
        // to VXL3, no LOD trailer at all (so the mobile LOD drop could not touch them),
        // and 5.6 seconds of a 15-second scenery load for a single instance.
        const v3FromGrid = this.chunkGridToVxlV3Data();
        const gridBytes = await encodeVxlV3(v3FromGrid);
        const gridOut = new ArrayBuffer(gridBytes.byteLength);
        new Uint8Array(gridOut).set(gridBytes);
        return gridOut;
    }

    /**
     * Convert this object's chunk grid into encodable VXL3 data, LODs included.
     *
     * The LOD schedule is synthesised rather than inherited: a procedurally built object
     * has no source file to copy levels from, and shipping it with LOD 0 alone would
     * leave it rendering at full density at every distance — the exact defect that made
     * these assets expensive. Levels follow the same doubling progression a real bake
     * uses, and how MANY comes from the shared size policy, so a converted prop and a
     * baked one of the same size end up with the same number of levels.
     */
    private chunkGridToVxlV3Data(): VxlV3Data {
        const { leaves, bounds } = chunksToOctreeLeaves(this.chunks, this.voxelSize, undefined, true);
        const largestDim = Math.max(
            bounds.maxX - bounds.minX,
            bounds.maxY - bounds.minY,
            bounds.maxZ - bounds.minZ,
        );
        // `buildEditedVxlV3Data` coarsens one level per entry it finds here, reading only
        // the two sizes; the empty fragment lists are what it REPLACES with the coarsened
        // leaves. It also owns the bounds-anchoring rule that keeps coarse cells from
        // encoding as negative coordinates, which is why the levels go through it rather
        // than being assembled here.
        const additionalLods: DecodedLodLevel[] = [];
        for (let k = 0; k < additionalLodsForSize(largestDim); k++) {
            const minVoxelSize = this.voxelSize * Math.pow(2, k + 1);
            additionalLods.push({ minVoxelSize, maxVoxelSize: minVoxelSize * 5, fragments: [] });
        }
        const lodTemplate: DecodedVxlV3 = {
            minVoxelSize: this.voxelSize,
            maxVoxelSize: this.voxelSize,
            physicsGridStep: this.getPhysicsGridStep(),
            bounds,
            useAtlas: this.useAtlas,
            fragments: [],
            additionalLods,
        };
        return buildEditedVxlV3Data(leaves, additionalLods.length > 0 ? lodTemplate : null, {
            voxelSize: this.voxelSize,
            physicsGridStep: this.getPhysicsGridStep(),
            useAtlas: this.useAtlas,
        }, this._slots);
    }

    /**
     * Clone voxel data from this object to another VoxelObject.
     * Used to update all instances of a prefab after editing one.
     *
     * `keepPhysicsBody` leaves the target's existing body alone. By default the
     * clone (re)builds a STATIC body for the copied geometry, which is right for
     * a prefab re-clone but destroys a DYNAMIC target: a pristine dynamic prop
     * promoting out of the render batch would come back fixed in place, unable
     * to roll, be pushed or be kicked ever again. That caller keeps its body and
     * swaps only the colliders (see attachPromotedDynamicColliders).
     */
    cloneDataTo(target: VoxelObject, options?: { keepPhysicsBody?: boolean }): void {
        const keepBody = options?.keepPhysicsBody === true;
        target.chunks.clear();
        target._cachedVoxelCount = -1;
        // Copy rounding config before any mesh rebuild below so clones render
        // with the same edge treatment as the template.
        target.voxelRoundingRadiusVoxels = this.voxelRoundingRadiusVoxels;
        target.voxelRoundingSegments = this.voxelRoundingSegments;

        // Multi-fragment v3 templates: rebuild the full child-fragment tree on
        // the target. The flat-leaves path below can't reproduce the
        // container shape — it would leave the target with no mesh and no
        // children, which is invisible at runtime.
        if (this._isOctreeV2 && this._vxlV3Data && this._vxlV3Data.fragments.length > 1) {
            target.applyVxlV3Data(this._vxlV3Data);
            if (target.physicsWorld && !keepBody) target.createPhysicsBody(target.physicsWorld);
            return;
        }

        if (this.bounds) target.bounds = { ...this.bounds };
        target.boundsInWorldUnits = this.boundsInWorldUnits;
        if (this.voxelPivot) target.voxelPivot = { ...this.voxelPivot };
        if (this.storedBoundsOffset) target.storedBoundsOffset = { ...this.storedBoundsOffset };

        if (this._isOctreeV2) {
            target._isOctreeV2 = true;
            target._physicsGridStep = this._physicsGridStep;
            // The mesh rebuild below renders atlas assets through atlas UVs only
            // when the flag matches the template's — copy it before rebuilding.
            target.useAtlas = this.useAtlas;
            if (this._leafBuffer) {
                // Untouched template (every mutation path materialises leaves and
                // clears the buffer first): hand the clone the compact buffer, so
                // its mesh is built by the SAME buffer path as the template and
                // the batched instances — atlas UVs and textured block types
                // included — instead of the object-leaves path. Sharing the
                // reference is safe: the buffer is never written after decode
                // (mutations materialise their own leaf objects), and clones of
                // multi-fragment templates already share these buffers via
                // `_vxlV3Data`. This also skips materialising millions of leaf
                // objects per clone — the allocation storm LeafBuffer exists to
                // avoid.
                target._leafBuffer = this._leafBuffer;
                target._octreeLeaves = null;
            } else {
                target.octreeLeaves = this.octreeLeaves ? [...this.octreeLeaves] : null;
            }
            target._octreeRawData = this._octreeRawData;
            target._vxlV3Data = this._vxlV3Data;
            target._slots = this._slots;
            // Clones of a leaf-edited template must also re-encode from live
            // leaves on save — their `_vxlV3Data` is the same stale decode.
            target._octreeLeafEdited = this._octreeLeafEdited;
            target.rebuildOctreeMesh();
        } else {
            for (const [key, chunk] of this.chunks) {
                const newChunk = new VoxelChunk();
                newChunk.palette = [...chunk.palette];
                newChunk.setRleData(chunk.getCompactedRle());
                newChunk.colors.data = new Uint32Array(chunk.colors.data);
                newChunk.colors.length = chunk.colors.length;
                target.chunks.set(key, newChunk);
            }
            target.generateAllCollisionBoxes();
            target.buildMesh();
        }
        
        if (target.physicsWorld && !keepBody) {
            target.createPhysicsBody(target.physicsWorld);
        }
    }

    // NOTE: the batched-pristine destructible machinery (template-cached
    // union colliders, pristine stand-in bodies, promoted-fragment
    // materialisation) lives in VoxelObjectPristineOps.ts — a friend module
    // kept out of this file because of the 2000-line ESLint cap.

    /**
     * Set a voxel at the given position.
     * @param x X position in voxel units
     * @param y Y position in voxel units  
     * @param z Z position in voxel units
     * @param blockType Block type ID (from BlockType enum, e.g., BlockType.TRUNK)
     * @param color Optional RGB24 color - with useAtlas=true, this uses the color palette (4-bit RGB, 4096 colors)
     */
    setVoxel(x: number, y: number, z: number, blockType: BlockTypeId, color?: number): void {
        // Guard: if using atlas mode and blockType is 0, substitute with type 1
        // This handles the case where a block type wasn't registered before use
        if (this.useAtlas && blockType === 0) {
            blockType = 1 as BlockTypeId; // Use first registered block type as fallback
        }
        
        this._cachedVoxelCount = -1; // Invalidate cache

        const { key, lx, ly, lz } = this.chunkCoords(x, y, z);

        let chunk = this.chunks.get(key);
        if (!chunk) {
            chunk = new VoxelChunk();
            this.chunks.set(key, chunk);
        }

        // VoxelChunk.set appends to the palette on first use of a new block id.
        chunk.set(lx, ly, lz, blockType);
        
        // Set color only if provided (for BlockType.COLOR custom colors)
        if (color !== undefined) {
            chunk.colors.set(lx, ly, lz, color);
        }
        
        // Update bounds in VOXEL units (will be converted to world units in finalize)
        // IMPORTANT: Skip bounds update when pivot is locked (during editing)
        // because the original bounds may be in world units (from file) and we'd be
        // mixing incompatible coordinate systems
        if (!this.voxelPivot) {
            this.boundsInWorldUnits = false; // setVoxel uses voxel units
            if (!this.bounds) {
                this.bounds = { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 };
            } else {
                this.bounds.minX = Math.min(this.bounds.minX, x);
                this.bounds.minY = Math.min(this.bounds.minY, y);
                this.bounds.minZ = Math.min(this.bounds.minZ, z);
                this.bounds.maxX = Math.max(this.bounds.maxX, x + 1);
                this.bounds.maxY = Math.max(this.bounds.maxY, y + 1);
                this.bounds.maxZ = Math.max(this.bounds.maxZ, z + 1);
            }
        }
    }

    /**
     * Finalize the object after setting voxels.
     * Call this after all setVoxel calls to generate the mesh.
     */
    finalize(): void {
        this.generateAllCollisionBoxes();
        this.rebuildMeshFromVoxels();
    }

    /**
     * Get the rigid body for this object.
     */
    getRigidBody(): RAPIER.RigidBody | null {
        return this.rigidBody;
    }

    /**
     * Enable gravity on a dynamic physics body.
     * Dynamic bodies start with gravity disabled to prevent falling through
     * unloaded terrain. Call this after terrain colliders are ready.
     */
    enableDynamicGravity(): void {
        const body = this.liveBody;
        // A prop that started asleep (see createDynamicPhysicsBody's `startAsleep`) stays
        // asleep: gravity on a sleeping body is inert until a contact wakes it, whereas
        // waking every load-time prop turns a city of knockables into hundreds of live
        // compound bodies grinding on the level colliders for the rest of the session.
        if (body?.isDynamic()) body.setGravityScale(1.0, !body.isSleeping());
    }

    // ═══════ ChunkManagedObject implementation (for dynamic objects) ═══════

    getPosition(): THREE.Vector3 {
        return this.position;
    }

    /**
     * Atomically move the VoxelObject to a world position, updating BOTH the
     * visual transform AND the physics rigid body in one call.
     *
     * Prefer this over `vo.position.set(...)` / mutating `vo.position.x` —
     * raw mutations only move the Three.js mesh; the rigid body stays at
     * its old location and stops matching the visible chair / crate / cart.
     * The visible symptom: NPCs sit on the original (invisible) collider,
     * weapons hit empty space, mining bores through nothing.
     *
     * Also updates the navmesh obstacle (if `setNavmeshObstacleEnabled`
     * was called) and refreshes the chunk index so the dynamic-object
     * manager keeps tracking the right chunk.
     */
    setPosition(x: number, y: number, z: number): void {
        this.position.set(x, y, z);
        this.liveBody?.setTranslation({ x, y, z }, true);
    }

    /**
     * Atomically set the VoxelObject's yaw (rotation around world-Y),
     * updating BOTH the visual transform AND the physics rigid body.
     * Same rationale as `setPosition()` — raw `vo.rotation.y = ...` leaves
     * the collider rotated to its old orientation.
     */
    setRotationY(yaw: number): void {
        this.rotation.y = yaw;
        const body = this.liveBody;
        if (body) {
            const quat = new THREE.Quaternion().setFromEuler(this.rotation);
            body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
        }
    }

    hibernate(): void {
        if (this._isHibernating) return;
        this._isHibernating = true;
        const body = this.liveBody;
        if (body) {
            // Dynamic props are NEVER removed from the world (setEnabled(false)).
            // A disabled body is a ghost: anything pushed into its space silently
            // overlaps it, and the later wake() re-inserts the body inside that
            // overlap, which the solver resolves as a violent ejection (props
            // rocketing skyward). Instead the body is put to sleep: ~free to
            // simulate but still SOLID, so its space can never be occupied.
            if (this._isDynamic) { body.sleep(); return; }
            body.setEnabled(false);
        }
        this.visible = false;
    }

    wake(): void {
        if (!this._isHibernating) return;
        this._isHibernating = false;
        const body = this.liveBody;
        if (body) {
            // Stayed in-world (asleep) during hibernation — just restore gravity
            // in case a hold was active; contact wakes it naturally.
            if (this._isDynamic) { body.setGravityScale(1.0, true); return; }
            body.setEnabled(true);
        }
        this.visible = true;
    }

    isHibernating(): boolean {
        return this._isHibernating;
    }

    /**
     * Veto hibernation while the physics body is awake and moving. Hibernating
     * a body mid-motion makes it visibly vanish (it crosses into a not-active
     * chunk while being pushed), and re-enabling it later wherever other bodies
     * have since drifted produces violent solver ejections. Once the body
     * settles (sleeps), hibernation proceeds normally on the next evaluation.
     */
    canHibernate(): boolean {
        const body = this.liveBody;
        if (!this._isDynamic || !body || body.isSleeping()) return true;
        const lv = body.linvel();
        return (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z) < 0.01;
    }

    holdPhysicsUntilReady(): void {
        const body = this.liveBody;
        if (!body) return;
        // Preserve sleep across the hold/release pair — see enableDynamicGravity.
        const wake = !body.isSleeping();
        body.setGravityScale(0, wake);
        body.setLinvel({ x: 0, y: 0, z: 0 }, wake);
    }

    releasePhysics(): void {
        const body = this.liveBody;
        if (!body) return;
        body.setGravityScale(1.0, !body.isSleeping());
    }

    /**
     * How far the first static surface below this prop's collider bottom sits ABOVE it:
     * positive = the prop is embedded that deep, ~0 = resting on it, negative = hovering.
     * The ray starts `maxLift` above the feet and skips this prop's own body. Null when
     * nothing static is within reach (void, or the level's colliders are not queryable yet).
     */
    surfaceOffsetBelow(physicsWorld: PhysicsWorld, maxLift: number = 4, maxDrop: number = 3): number | null {
        const body = this.liveBody;
        if (!body || !this._isDynamic) return null;
        const pos = body.translation();
        const feetY = pos.y + this._colliderBottomOffsetY;
        const hit = physicsWorld.raycastWithFilter(
            new THREE.Vector3(pos.x, feetY + maxLift, pos.z),
            new THREE.Vector3(0, -1, 0),
            maxLift + maxDrop,
            CollisionGroup.DYNAMIC_PROP,
            CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT,
            [body],
        );
        return hit.hasHit ? hit.hitPoint.y - feetY : null;
    }

    /**
     * Drop or lift a dynamic prop so its collider bottom rests on the first static surface
     * below it. Forge-placed knockables (car wrecks, cans, crates) are authored on the terrain
     * heightfield, but the baked level's surface is voxel-rounded, so a prop typically ends up
     * a few centimetres INSIDE it. A body in penetration never settles: the solver pushes it out
     * every step, gravity pushes it back, and it stays awake for the whole session — two
     * hundred of them cost ~180 ms per physics step. A prop already resting moves by nothing.
     *
     * @returns true when a surface was found (moved or already resting).
     */
    restOnSurfaceBelow(physicsWorld: PhysicsWorld, maxLift: number = 4, maxDrop: number = 3, sleepAfter: boolean = false): boolean {
        const body = this.liveBody;
        if (!body || !this._isDynamic) return false;
        const offset = this.surfaceOffsetBelow(physicsWorld, maxLift, maxDrop);
        if (offset === null) return false;
        const wasAsleep = body.isSleeping();
        const pos = body.translation();
        const newY = pos.y + offset + 0.02;
        if (Math.abs(newY - pos.y) >= 0.005) {
            this.setPosition(pos.x, newY, pos.z);
        }
        if (wasAsleep || sleepAfter) body.sleep();
        return true;
    }

    /**
     * Rapier woke this load-time prop: was that a push, or an artifact?
     *
     * A prop authored at rest wakes for reasons that are not gameplay: it sits a few
     * centimetres inside the voxel-rounded surface (the solver pushes it out at a steady
     * ~0.5 m/s, gravity pushes it back, forever); the static colliders it rests on are not
     * enabled yet on the first steps after Play, or get toggled later, because the engine
     * enables environment colliders lazily by camera frustum — so it starts to fall; or a
     * lazily-enabled collider appeared on top of it (a lot's ground plane over a wreck the
     * forge placed at terrain height). Every one of those leaves the prop where it was,
     * barely moving. The right answer is "put it back to sleep where it was authored": a
     * sleeping body is never solved and costs nothing, and the batched visual is still drawn
     * exactly there. A shallow embed is first lifted onto the surface (the visual is at most
     * `maxLift` off); a deep one, or one whose support is not queryable, is left in place.
     * A real support loss (an explosion, a vehicle) comes with an impulse and reads as moving.
     *
     * @param restPosition - where the prop last came to rest (authored position at load).
     * @returns 'moving' — faster than `speedThreshold` or displaced more than `maxDrift`
     *          from `restPosition`: a real event, leave it to physics;
     *          'settled' — an artifact; the prop is asleep again.
     */
    settleSpuriousWake(
        physicsWorld: PhysicsWorld,
        restPosition: { x: number; y: number; z: number },
        maxLift: number = 0.35,
        speedThreshold: number = 0.75,
        maxDrift: number = 0.2,
    ): 'moving' | 'settled' {
        const body = this.liveBody;
        if (!body || !this._isDynamic) return 'moving';
        const lv = body.linvel();
        if (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z > speedThreshold * speedThreshold) return 'moving';
        const pos = body.translation();
        const dx = pos.x - restPosition.x, dy = pos.y - restPosition.y, dz = pos.z - restPosition.z;
        if (dx * dx + dy * dy + dz * dz > maxDrift * maxDrift) return 'moving';
        const offset = this.surfaceOffsetBelow(physicsWorld, 4, 3);
        if (offset !== null && offset > 0.01 && offset <= maxLift) {
            this.setPosition(pos.x, pos.y + offset + 0.02, pos.z);
        }
        body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        body.sleep();
        return 'settled';
    }

    /**
     * Rest this prop on the surface below as soon as the level's colliders are queryable,
     * rather than now: at load the level's own physics bodies are added AFTER the environment
     * objects are built (the genre template adds `getWorldBodies()` once `generateWorld()`
     * returns) and the query pipeline only sees them after physics steps, which it does not
     * do until Play. `syncWithPhysics` retries every frame until a surface is found, for at
     * most `SURFACE_REST_MAX_FRAMES`. The prop is put to sleep afterwards — it was authored at rest.
     */
    requestSurfaceRest(): void {
        this._surfaceRestFramesLeft = VoxelObject.SURFACE_REST_MAX_FRAMES;
        this._restsOnWake = true;
        this._restPosition = { x: this.position.x, y: this.position.y, z: this.position.z };
    }

    /**
     * How many octree leaves a bullet hole would have to rebuild — what the carve
     * system's size gate reads BEFORE promoting a batched instance. A proxy that holds
     * no geometry of its own (a pristine dynamic prop) answers for its template.
     */
    carveLeafCount(): number {
        const leaves = this.getMaterializedOctreeLeaves() ?? this.getOctreeLeaves();
        return leaves ? leaves.length : 0;
    }

    /** Whether this is a dynamic (physics-simulated) voxel object */
    isDynamicObject(): boolean {
        return this._isDynamic;
    }

    /**
     * Set whether this object should always remain active (never hibernate).
     * When active, the object and the terrain chunks beneath it stay loaded
     * even when outside the camera view.
     */
    setAlwaysActive(active: boolean): void {
        this._alwaysActive = active;
    }

    isAlwaysActive(): boolean {
        return this._alwaysActive;
    }

    private generateAllCollisionBoxes(): void {
        for (const chunk of this.chunks.values()) {
            chunk.collisionBoxes = generateCollisionBoxes(chunk);
        }
    }

    /**
     * Which of a box's six faces are exposed, in FACE_TEMPLATES order
     * [-Z, +Z, -X, +X, -Y, +Y]. A face is hidden only when the one-voxel slab
     * just beyond it is entirely solid; a face on the chunk border has no
     * in-chunk slab to test and therefore stays exposed.
     */
    private getExposedFaces(chunk: VoxelChunk, box: CollisionBox): boolean[] {
        const solidSlab = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean => {
            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) {
                    for (let z = z0; z <= z1; z++) {
                        if (chunk.get(x, y, z) === 0) return false;
                    }
                }
            }
            return true;
        };
        const inChunk = (v: number): boolean => v >= 0 && v < CHUNK_SIZE;
        // Last voxel of the box on each axis, and the slab one step beyond it.
        const xHi = box.x + box.w - 1, yHi = box.y + box.h - 1, zHi = box.z + box.d - 1;
        const xLo = box.x - 1, yLo = box.y - 1, zLo = box.z - 1;
        return [
            !(inChunk(zLo) && solidSlab(box.x, xHi, box.y, yHi, zLo, zLo)),
            !(inChunk(zHi + 1) && solidSlab(box.x, xHi, box.y, yHi, zHi + 1, zHi + 1)),
            !(inChunk(xLo) && solidSlab(xLo, xLo, box.y, yHi, box.z, zHi)),
            !(inChunk(xHi + 1) && solidSlab(xHi + 1, xHi + 1, box.y, yHi, box.z, zHi)),
            !(inChunk(yLo) && solidSlab(box.x, xHi, yLo, yLo, box.z, zHi)),
            !(inChunk(yHi + 1) && solidSlab(box.x, xHi, yHi + 1, yHi + 1, box.z, zHi)),
        ];
    }

    /** Check if a voxel at global grid coords across all chunks is solid. */
    private isSolidAtVoxelGlobal(vx: number, vy: number, vz: number): boolean {
        const cx = Math.floor(vx / CHUNK_SIZE), cy = Math.floor(vy / CHUNK_SIZE), cz = Math.floor(vz / CHUNK_SIZE);
        const chunk = this.chunks.get(`${cx},${cy},${cz}`);
        if (!chunk) return false;
        return chunk.get(vx & (CHUNK_SIZE - 1), vy & (CHUNK_SIZE - 1), vz & (CHUNK_SIZE - 1)) !== 0;
    }

    /**
     * Compute 8 corner-rounding flags for a single voxel at global grid (gx, gy, gz).
     * See VoxelWorld.getCornerRoundedFlags for semantics.
     */
    private getVoxelCornerRoundedFlags(gx: number, gy: number, gz: number, exposedFaces: readonly boolean[]): boolean[] {
        const flags: boolean[] = [false, false, false, false, false, false, false, false];
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
            const dx = gx + (hX ? sx : 0);
            const dy = gy + (hY ? sy : 0);
            const dz = gz + (hZ ? sz : 0);
            if (!this.isSolidAtVoxelGlobal(dx, dy, dz)) {
                flags[i] = true;
            }
        }
        return flags;
    }

    /**
     * Give up this object's slot in the shared per-fragment InstancedMesh pool
     * (no-op when it never had one). Called whenever the slot stops being a
     * truthful visual: the object built its own mesh, was destroyed, or is
     * being disposed.
     */
    private releaseFragmentSlot(): void {
        this._fragmentSlot?.release();
        this._fragmentSlot = null;
    }

    /**
     * Build the primary mesh from baked LOD `_primaryLod` instead of the finest
     * leaves — the load-time half of `VoxelObjectOptions.primaryLod`. Anchored on the
     * same pivot as every other level, so a promoted object still lines up with the
     * per-LOD InstancedMeshes built around it. Falls back to the finest level if the
     * promoted one turns out to be absent, so a malformed trailer degrades to normal
     * behaviour rather than to an object with no mesh.
     */
    private buildPromotedPrimaryMesh(): void {
        const lod = this._vxlV3Data?.additionalLods?.[this._primaryLod - 1];
        if (!lod) {
            this._primaryLod = 0;
            this.rebuildOctreeMesh();
            return;
        }
        this.releaseFragmentSlot();
        this.disposeMesh();
        this.mesh = this.buildMeshFromFragments(lod.fragments, this._zFightingId);
        if (this.mesh) {
            applyVoxelFinishToMesh(this.mesh, this.finish, this.voxelSize);
            this.add(this.mesh);
        }
    }

    private rebuildOctreeMesh(): void {
        // An own mesh supersedes pooled-slot rendering (a promoted fragment
        // that gets partially shattered or leaf-edited materialises real
        // geometry; the shared slot must stop drawing the stale full shape).
        this.releaseFragmentSlot();
        this.disposeMesh();
        // Render straight from the compact buffer when present (no object materialisation);
        // otherwise from already-materialised leaves (octree-v2 / post-edit). Access the
        // private fields directly so a mere render doesn't force materialisation.
        const buffer = this._leafBuffer !== null && this._leafBuffer.count > 0 ? this._leafBuffer : null;
        const leaves = this._octreeLeaves !== null && this._octreeLeaves.length > 0 ? this._octreeLeaves : null;
        if (!buffer && !leaves) return;

        const { x: px, y: py, z: pz } = this.ensureVoxelPivot();
        const rounding = this.getOctreeRounding();
        this.mesh = buffer
            ? buildOctreeMeshFromBuffers([buffer], px, py, pz, this.shadows, this._zFightingId, this.useAtlas, rounding, this._slots)
            : buildOctreeMesh(leaves!, px, py, pz, this.shadows, this._zFightingId, rounding, this._slots, this.useAtlas);
        if (this.mesh) {
            // Baked .vxl assets assemble their mesh AND material down in
            // VoxelOctreeRenderer, so the finish is retro-fitted rather than passed in.
            applyVoxelFinishToMesh(this.mesh, this.finish, this.voxelSize);
            this.add(this.mesh);
        }
    }

    /**
     * Rebuild the mesh from whichever storage form actually holds this object's
     * voxels. Octree/VXL3 assets keep theirs in the leaf buffer, not in
     * `this.chunks`, and buildMesh() reads only chunks — so calling it for them
     * would dispose the octree mesh and rebuild nothing, leaving the object
     * invisible. Every rebuild site branches through here.
     */
    private rebuildMeshFromVoxels(): void {
        if (this._isOctreeV2) this.rebuildOctreeMesh();
        else this.buildMesh();
    }

    /**
     * Names of this object's material slots (empty when it has none). Slot names
     * come from the source GLB's `BM_slot_*` materials and are what
     * `setSlotEmissive` takes.
     */
    getSlotNames(): string[] {
        return this._slots.map((s) => s.name);
    }

    /** This object's material slots (indices 1..N). The voxel editor reads and extends this. */
    getSlots(): VoxelSlot[] {
        return this._slots;
    }

    /**
     * Replace the material-slot table after the editor added or retuned one.
     * The mesh is NOT rebuilt here — callers pair this with
     * `setOctreeLeavesForEdit`, which re-groups geometry by slot in one pass.
     */
    setSlotsForEdit(slots: VoxelSlot[]): void {
        this._slots = slots;
    }

    /** A smart object's rig + parts table (v12), for an object BUILT rather than loaded — see VxlV3Parts.ts. */
    setSmartPartsForEdit(smart: { rig: VxlV3RigInput; parts: VxlV3Part[] } | null): void { this._smartParts = smart; }

    /**
     * Set how strongly one material slot glows, RIGHT NOW — 0 is off, 1 is the
     * same full-strength glow a baked-emissive voxel has, and above 1 overdrives
     * past the bloom threshold for a strobe. This is the point of slots: an
     * ambulance flashes its beacons, a parked car's headlights go dark, and no
     * geometry, palette or asset byte changes.
     *
     * Applies to this object AND its fragment children, since a multi-fragment
     * asset spreads one logical light across several meshes. Returns false when
     * no such slot exists, so callers can tell a typo from a working light.
     */
    setSlotEmissive(name: string, intensity: number): boolean {
        let found = false;
        this.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const handles = child.userData[VOXEL_SLOT_HANDLES] as VoxelSlotMaterialHandle[] | undefined;
            if (!handles) return;
            for (const handle of handles) {
                if (handle.name !== name) continue;
                handle.setEmissive(intensity);
                found = true;
            }
        });
        return found;
    }

    /** Current glow level of a slot (0..1+), or null when the slot doesn't exist. */
    getSlotEmissive(name: string): number | null {
        let value: number | null = null;
        this.traverse((child) => {
            if (value !== null || !(child instanceof THREE.Mesh)) return;
            const handles = child.userData[VOXEL_SLOT_HANDLES] as VoxelSlotMaterialHandle[] | undefined;
            const handle = handles?.find((h) => h.name === name);
            if (handle) value = handle.getEmissive();
        });
        return value;
    }

    /** Rounded-edge config for the octree mesh paths (null = sharp voxels). */
    private getOctreeRounding(): OctreeMeshRounding | null {
        return this.voxelRoundingRadiusVoxels > 0
            ? { radiusVoxels: this.voxelRoundingRadiusVoxels, segments: this.voxelRoundingSegments }
            : null;
    }

    private buildMesh(): void {
        this.disposeMesh();

        this.ensureVoxelPivot();
        const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = this.getBoundsAndPivot();

        const positions: number[] = [];
        const colors: number[] = [];
        const uvs: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        let vertexOffset = 0;

        // Get atlas for UV lookup if using atlas mode
        const atlas = this.useAtlas ? getVoxelTextureAtlas() : null;
        // Atlas reference for rounding lookups (block properties are global, regardless of texture mode)
        const atlasForRounding = atlas ?? getVoxelTextureAtlas();
        const anyRoundingPossible = this.voxelRoundingRadiusVoxels > 0 || atlasForRounding.hasAnyBlockWithRounding();

        for (const [key, chunk] of this.chunks) {
            if (!chunk.collisionBoxes || chunk.collisionBoxes.length === 0) continue;

            const parsed = parseChunkKey(key);
            if (!parsed) continue;
            const { cx, cy, cz } = parsed;

            const chunkVoxelX = cx * CHUNK_SIZE;
            const chunkVoxelY = cy * CHUNK_SIZE;
            const chunkVoxelZ = cz * CHUNK_SIZE;

            // Iterate individual voxels (1x1x1) — atlas mode needs per-voxel UVs,
            // vertex-color mode needs per-voxel colors. Voxels are cubes, so one
            // edge length covers width/height/depth.
            const edge = this.voxelSize, halfEdge = edge / 2;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                const blockType = chunk.get(lx, ly, lz);
                if (blockType === 0) continue;
                const rgb24 = chunk.colors.get(lx, ly, lz);

                // Global voxel position (chunk offset + local position), then convert to world units
                const globalVoxelX = chunkVoxelX + lx;
                const globalVoxelY = chunkVoxelY + ly;
                const globalVoxelZ = chunkVoxelZ + lz;

                // Vertex positions relative to pivot point.
                // Use CENTER of voxel since FACE_TEMPLATES uses -0.5/+0.5 offsets.
                const localX = boundsOffsetX + globalVoxelX * edge + halfEdge - pivotX;
                const localY = boundsOffsetY + globalVoxelY * edge + halfEdge - pivotY;
                const localZ = boundsOffsetZ + globalVoxelZ * edge + halfEdge - pivotZ;

                const r = ((rgb24 >> 16) & 255) / 255;
                const g = ((rgb24 >> 8) & 255) / 255;
                const b = (rgb24 & 255) / 255;

                // Check if this voxel uses color palette (BlockType.COLOR = 255)
                const isColorPalette = this.useAtlas && blockType === BlockType.COLOR;

                // Get color palette UV if using custom color, otherwise use block type texture
                const colorPaletteUV = (atlas && isColorPalette)
                    ? atlas.getColorPaletteUV((rgb24 >> 16) & 255, (rgb24 >> 8) & 255, rgb24 & 255)
                    : null;

                // Only render exposed faces
                const exposedFaces = this.getExposedFaces(chunk, { x: lx, y: ly, z: lz, w: 1, h: 1, d: 1 });

                const rndVox = anyRoundingPossible ? mergeVoxelRoundingRadiusVoxels(this.voxelRoundingRadiusVoxels, atlasForRounding.getVoxelRoundingRadiusVoxels(blockType)) : 0;
                const rndWorld = rndVox * this.voxelSize;
                if (rndWorld > 1e-6) {
                    const cornerFlags = this.getVoxelCornerRoundedFlags(globalVoxelX, globalVoxelY, globalVoxelZ, exposedFaces);
                    const roundedAtlas: RoundedAtlasContext | null = this.useAtlas && atlas !== null ? {
                        isColorPalette,
                        rgb24,
                        getAtlasRegionForFace(fi: number) {
                            let ft: 'top' | 'side' | 'bottom' = 'side';
                            if (fi === 5) ft = 'top';
                            else if (fi === 4) ft = 'bottom';
                            return atlas.getBlockUV(blockType, ft);
                        },
                        getPaletteUV(r24: number) {
                            return atlas.getColorPaletteUV((r24 >>> 16) & 255, (r24 >>> 8) & 255, r24 & 255);
                        },
                    } : null;
                    appendRoundedVoxelMesh({
                        positions, colors, normals, uvs, indices,
                        centerX: localX, centerY: localY, centerZ: localZ,
                        width: edge, height: edge, depth: edge,
                        radius: rndWorld,
                        segments: this.voxelRoundingSegments,
                        exposedFaces,
                        cornerInnerFlags: cornerFlags,
                        rgb: [r, g, b],
                        atlas: roundedAtlas,
                        generateNormals: true,
                    });
                    vertexOffset = positions.length / 3;
                    continue;
                }

                const boxVertexOffset = vertexOffset;
                const vertexRemap: number[] = [];
                let localVertexIdx = 0;

                // First pass: add vertices only for exposed faces
                for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
                    if (!exposedFaces[faceIdx]) {
                        for (let v = 0; v < 4; v++) {
                            vertexRemap[faceIdx * 4 + v] = -1;
                        }
                        continue;
                    }

                    // Determine face type for atlas UV lookup
                    let faceType: 'top' | 'side' | 'bottom' = 'side';
                    if (faceIdx === 5) faceType = 'top';
                    else if (faceIdx === 4) faceType = 'bottom';
                    
                    // Use color palette UV if available, otherwise use block type UV
                    const atlasUV = colorPaletteUV ?? (atlas ? atlas.getBlockUV(blockType, faceType) : null);
                    const faceNormal = FACE_NORMALS[faceIdx];
                    const faceUVs = FACE_UV_MAPS[faceIdx];

                    const baseIdx = faceIdx * 4;
                    for (let v = 0; v < 4; v++) {
                        const template = FACE_TEMPLATES[baseIdx + v];
                        if (!template) continue;
                        const tx = template[0] ?? 0;
                        const ty = template[1] ?? 0;
                        const tz = template[2] ?? 0;
                        positions.push(
                            localX + tx * edge,
                            localY + ty * edge,
                            localZ + tz * edge
                        );
                        colors.push(r, g, b);

                        // Add UV coordinates for atlas mode
                        const vertexUV = faceUVs?.[v];
                        if (atlasUV && vertexUV) {
                            uvs.push(
                                atlasUV.u0 + vertexUV[0] * (atlasUV.u1 - atlasUV.u0),
                                atlasUV.v0 + vertexUV[1] * (atlasUV.v1 - atlasUV.v0),
                            );
                        }

                        // Add per-face normal
                        if (faceNormal) {
                            normals.push(faceNormal[0], faceNormal[1], faceNormal[2]);
                        }

                        vertexRemap[faceIdx * 4 + v] = boxVertexOffset + localVertexIdx;
                        localVertexIdx++;
                        vertexOffset++;
                    }
                }

                // Second pass: add indices only for exposed faces
                for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
                    if (!exposedFaces[faceIdx]) continue;
                    const idxBase = faceIdx * 6;
                    for (let i = 0; i < 6; i++) {
                        indices.push(vertexRemap[FACE_INDICES[idxBase + i]!]!);
                    }
                }
            }
        }

        if (positions.length === 0) {
            console.warn('[VoxelObject] No geometry generated');
            return;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        if (this.useAtlas && uvs.length > 0) {
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        }
        // Smooths `normals` in place when the finish asks for it, so this must
        // run before the normal attribute is handed to the geometry.
        const material = buildVoxelFinishMaterial({
            positions, normals, indices,
            voxelSize: this.voxelSize,
            settings: this.finish,
            map: atlas?.getTexture() ?? null,
        });

        if (normals.length > 0) {
            geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        }
        geometry.setIndex(indices);

        // Use unique polygonOffset from ZFightingRegistry to prevent z-fighting with terrain and other objects
        const zOffset = getZFightingRegistry().acquireObjectOffset(this._zFightingId);
        material.polygonOffset = true;
        material.polygonOffsetFactor = zOffset.factor;
        material.polygonOffsetUnits = zOffset.units;

        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.castShadow = this.shadows;
        this.mesh.receiveShadow = this.shadows;
        this.mesh.name = 'VoxelMesh';
        this.add(this.mesh);
    }

    getBounds(): VoxelBounds | null {
        return this.bounds;
    }

    /**
     * Get bounding box in world units (meters), regardless of how the object was created.
     * Converts grid-unit bounds (from setVoxel) by multiplying by voxelSize.
     * File-loaded bounds are already in world units and returned as-is.
     */
    getBoundsInWorldUnits(): VoxelBounds | null {
        if (!this.bounds) return null;
        if (this.boundsInWorldUnits) return this.bounds;
        const vs = this.voxelSize;
        return {
            minX: this.bounds.minX * vs,
            minY: this.bounds.minY * vs,
            minZ: this.bounds.minZ * vs,
            maxX: this.bounds.maxX * vs,
            maxY: this.bounds.maxY * vs,
            maxZ: this.bounds.maxZ * vs,
        };
    }

    getVoxelSize(): number {
        return this.voxelSize;
    }

    /**
     * Footprint of the object's BASE — the X/Z extent of its lowest occupied voxel
     * layer — in the mesh's own local space (pivot-relative, world units, before
     * this instance's rotation and scale).
     *
     * This is the part that actually rests on the ground, which is what a
     * `placeOnTerrain` caller needs to sample under. Sampling the terrain at the
     * instance origin instead reads a point that need not lie under the object at
     * all: the mesh sits wherever `boundsOffset`/`pivot` put it, so for the default
     * tree assets the origin is ~2.1 m diagonally away from the trunk, and any
     * terrain step in between left the tree floating a whole block. The full bounds
     * are no good either — a tree's canopy is metres wider than its trunk, so a
     * cliff under the leaves would lift the tree off the ground.
     *
     * Returns null for objects with no chunk data (octree/v3 assets) or no voxels,
     * leaving callers on their existing single-point behaviour.
     */
    getBaseFootprint(): BaseFootprint | null {
        if (this.chunks.size === 0) return null;
        const { boundsOffsetX, boundsOffsetZ, pivotX, pivotZ } = this.getBoundsAndPivot();
        return baseFootprint(this.chunks, this.voxelSize,
            { x: boundsOffsetX, z: boundsOffsetZ }, { x: pivotX, z: pivotZ });
    }

    /** Remove multiple voxels by local position and rebuild mesh + physics */
    removeVoxelsAndRebuild(voxels: Array<{ x: number; y: number; z: number }>): void {
        for (const v of voxels) {
            this.removeVoxelAt(v.x, v.y, v.z);
        }
        this.finalizeAfterRemoval(this.getVoxelCount() > 0, false);
    }

    /**
     * Remove a voxel at the given local position.
     * @param localX Local X position (as returned by getVoxelData)
     * @param localY Local Y position
     * @param localZ Local Z position
     * @returns true if a voxel was removed
     */
    removeVoxelAt(localX: number, localY: number, localZ: number): boolean {
        this._cachedVoxelCount = -1; // Invalidate cache

        const voxelCoords = this.localToVoxelCoords(localX, localY, localZ);
        if (!voxelCoords) return false;
        const { key, lx, ly, lz } = this.chunkCoords(voxelCoords.vx, voxelCoords.vy, voxelCoords.vz);

        const chunk = this.chunks.get(key);
        if (!chunk || chunk.get(lx, ly, lz) === 0) return false;

        chunk.set(lx, ly, lz, 0);
        return true;
    }

    /**
     * Set a voxel at the given local position (coordinates as returned by getVoxelData).
     * This converts local coordinates to voxel grid coordinates before setting.
     * @param localX Local X position (as returned by getVoxelData)
     * @param localY Local Y position
     * @param localZ Local Z position
     * @param blockType Block type ID
     * @param color Optional color
     * @returns true if the voxel was set
     */
    setVoxelAtLocal(localX: number, localY: number, localZ: number, blockType: BlockTypeId, color?: number): boolean {
        // Convert local position back to voxel coordinates
        const voxelCoords = this.localToVoxelCoords(localX, localY, localZ);
        if (!voxelCoords) return false;

        const { vx, vy, vz } = voxelCoords;
        
        // Use the regular setVoxel with grid coordinates
        this.setVoxel(vx, vy, vz, blockType, color);
        return true;
    }

    /**
     * Change the block type of a voxel at the given local position.
     * @param localX Local X position (as returned by getVoxelData)
     * @param localY Local Y position
     * @param localZ Local Z position
     * @param newBlockType New block type
     * @returns true if the block type was changed
     */
    changeVoxelType(localX: number, localY: number, localZ: number, newBlockType: BlockTypeId): boolean {
        const voxelCoords = this.localToVoxelCoords(localX, localY, localZ);
        if (!voxelCoords) return false;
        const { key, lx, ly, lz } = this.chunkCoords(voxelCoords.vx, voxelCoords.vy, voxelCoords.vz);

        const chunk = this.chunks.get(key);
        if (!chunk || chunk.get(lx, ly, lz) === 0) return false;

        // VoxelChunk.set appends to the palette on first use of a new block id.
        chunk.set(lx, ly, lz, newBlockType);

        if (this.useAtlas) {
            const encodedColor = (newBlockType * 24) << 16;
            chunk.colors.set(lx, ly, lz, encodedColor);
        }
        return true;
    }

    /**
     * Resolve a voxel-grid (vx, vy, vz) to its owning chunk's key and the
     * intra-chunk local coords. Used by every method that needs to find a
     * voxel inside the chunk grid.
     */
    private chunkCoords(vx: number, vy: number, vz: number): { key: ChunkKey; lx: number; ly: number; lz: number } {
        const cx = Math.floor(vx / CHUNK_SIZE);
        const cy = Math.floor(vy / CHUNK_SIZE);
        const cz = Math.floor(vz / CHUNK_SIZE);
        const lx = ((vx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const ly = ((vy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const lz = ((vz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        return { key: `${cx},${cy},${cz}`, lx, ly, lz };
    }

    /**
     * Shared "rebuild or destroy" tail used after any voxel removal. If any
     * voxels remain we rebuild the mesh (octree or chunk path) plus the
     * physics colliders; otherwise we tear everything down and mark the
     * object destroyed. Optionally invokes the post-explosion callback.
     */
    private finalizeAfterRemoval(stillHasVoxels: boolean, runPostExplosion: boolean): void {
        if (stillHasVoxels) {
            this.rebuildMeshFromVoxels();
            if (this.rigidBody && this.physicsWorld) {
                rebuildPhysicsColliders(this);
            }
        } else {
            this.removePhysicsBody();
            this.disposeMesh();
            this.releaseFragmentSlot();
            if (this._isOctreeV2) this.octreeLeaves = null;
            else this.chunks.clear();
            this._isDestroyed = true;
        }
        if (runPostExplosion && this._onPostExplosion && !this._isDestroyed) {
            this._onPostExplosion(this);
        }
    }

    /**
     * Convert local coordinates (as returned by getVoxelData) back to voxel grid coordinates
     */
    private localToVoxelCoords(localX: number, localY: number, localZ: number): { vx: number; vy: number; vz: number } | null {
        const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = this.getBoundsAndPivot();

        // Reverse the local position calculation
        // localX = worldX - pivotX
        // worldX = boundsOffsetX + globalVoxelX * voxelSize
        const worldX = localX + pivotX;
        const worldY = localY + pivotY;
        const worldZ = localZ + pivotZ;

        // Convert back to voxel coordinates
        const vx = Math.round((worldX - boundsOffsetX) / this.voxelSize);
        const vy = Math.round((worldY - boundsOffsetY) / this.voxelSize);
        const vz = Math.round((worldZ - boundsOffsetZ) / this.voxelSize);

        return { vx, vy, vz };
    }

    /**
     * Rebuild the mesh after voxel modifications.
     * Call this after removing/changing voxels.
     */
    rebuild(): void {
        if (!this._isOctreeV2) this.generateAllCollisionBoxes();
        this.rebuildMeshFromVoxels();
    }

    /**
     * Get the count of non-empty voxels efficiently without creating arrays.
     * Use this instead of getVoxelData().length for performance-sensitive code.
     * The count is cached and only recalculated when voxels change.
     */
    getVoxelCount(): number {
        if (this._cachedVoxelCount >= 0) return this._cachedVoxelCount;

        let count = 0;
        if (this._isOctreeV2) {
            count = leafSourceCount(this.octreeLeafSources);
        } else {
            for (const chunk of this.chunks.values()) {
                for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                            if (chunk.get(lx, ly, lz) !== 0) count++;
                        }
                    }
                }
            }
        }
        this._cachedVoxelCount = count;
        return count;
    }

    getVoxelData(): Array<{x: number, y: number, z: number, blockType: number, color: number}> {
        const voxels: Array<{x: number, y: number, z: number, blockType: number, color: number}> = [];
        const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = this.getBoundsAndPivot();

        for (const [key, chunk] of this.chunks) {
            const parsed = parseChunkKey(key);
            if (!parsed) continue;
            const { cx, cy, cz } = parsed;

            const chunkVoxelX = cx * CHUNK_SIZE;
            const chunkVoxelY = cy * CHUNK_SIZE;
            const chunkVoxelZ = cz * CHUNK_SIZE;

            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const blockType = chunk.get(lx, ly, lz);
                        if (blockType !== 0) {
                            // Global voxel position, then convert to world units
                            const globalVoxelX = chunkVoxelX + lx;
                            const globalVoxelY = chunkVoxelY + ly;
                            const globalVoxelZ = chunkVoxelZ + lz;
                            
                            const worldX = boundsOffsetX + globalVoxelX * this.voxelSize;
                            const worldY = boundsOffsetY + globalVoxelY * this.voxelSize;
                            const worldZ = boundsOffsetZ + globalVoxelZ * this.voxelSize;
                            
                            // Local position relative to pivot (same as buildMesh)
                            const localX = worldX - pivotX;
                            const localY = worldY - pivotY;
                            const localZ = worldZ - pivotZ;
                            
                            voxels.push({
                                x: localX,
                                y: localY,
                                z: localZ,
                                blockType,
                                // rgb24; only meaningful for BlockType.COLOR voxels,
                                // which is what the voxel editor needs to upgrade a
                                // colour-only chunk asset to octree leaves.
                                color: chunk.colors.get(lx, ly, lz),
                            });
                        }
                    }
                }
            }
        }
        
        return voxels;
    }

    /**
     * Get greedy-merged physics boxes in local space (center + half-extents).
     * Handles both chunk-based and Octree V2 VoxelObjects.
     * Used by 2D physics to build compound cuboid colliders.
     */
    getPhysicsBoxes(): PhysicsBox[] {
        const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = this.getBoundsAndPivot();

        if (this._isOctreeV2 && this._fragments) {
            // Multi-fragment: greedy-mesh each fragment's leaves at the parent pivot,
            // then concatenate. Same shape as if all leaves lived on the parent.
            return this.octreeLeafSources.flatMap(
                src => greedyMeshOctreeLeaves(src, pivotX, pivotY, pivotZ, this.getPhysicsGridStep()));
        }
        if (this._isOctreeV2 && this.octreeLeafSource) {
            return greedyMeshOctreeLeaves(this.octreeLeafSource, pivotX, pivotY, pivotZ, this.getPhysicsGridStep());
        }

        this.generateAllCollisionBoxes();
        return collectChunkPhysicsBoxes(this, boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ);
    }

    createPhysicsBody(physicsWorld: PhysicsWorld, options?: { asTerrain?: boolean }): void {
        // A baked level map registers as TERRAIN so spawn-detection can tell the
        // walkable ground apart from placed ENVIRONMENT objects (buildings, props).
        // Placed VXL props omit the flag and stay ENVIRONMENT. The two groups share
        // an identical collision mask, so this changes spawn queries only — never
        // the solver response (see CollisionLayers.ts).
        const group = options?.asTerrain ? CollisionGroup.TERRAIN : CollisionGroup.ENVIRONMENT;
        const mask = options?.asTerrain ? CollisionMask.TERRAIN : CollisionMask.ENVIRONMENT;

        if (this.rigidBody) this.removePhysicsBody();
        this.physicsWorld = physicsWorld;
        this.colliders = [];

        const collisionGroups = makeCollisionGroups(group, mask);

        // 2D-physics lane (VoxelObjectPlaneLocked.ts): the same boxes, sliced onto the
        // gameplay plane. Everything below is 3D Rapier, which a 2D-only bundle does not ship.
        if (isPlaneLockedPhysics(physicsWorld)) {
            const { pos, quat, scale } = this.decomposeWorld();
            const built = planeLockedStaticBody(physicsWorld, this.getPhysicsBoxes(), { translation: pos, rotation: quat, scale }, collisionGroups, { voxelObject: this }, options?.asTerrain === true);
            this.rigidBody = built.rigidBody; this.colliders = built.colliders;
            Object.assign(this.userData, { rigidBody: built.rigidBody, collisionGroup: group, collisionMask: mask });
            return;
        }

        const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = this.getBoundsAndPivot();

        if (this._fragments) {
            // Multi-fragment container: ONE static body for the whole asset.
            // While pristine (no fragment has detached yet), the body carries a
            // single union trimesh spanning every fragment — most buildings stay
            // in this state for their entire lifetime and pay 1 collider, not N.
            // On the first `detachAsDynamic()` we call `splitPristineColliders()`
            // which swaps the union for per-fragment trimeshes so detachment can
            // peel individual fragments off without touching the others.
            const { pos, quat, scale } = this.decomposeWorld();
            this.rigidBody = createStaticVoxelBody(this, physicsWorld, pos, quat);

            // Wire fragments to the physics world; their `.colliders` stay
            // empty until split — the union trimesh owns the shape.
            for (const child of this._fragments) { child.physicsWorld = physicsWorld; child.colliders = []; }
            // Every fragment's RESIDENT storage, handed over as a list — never
            // flatMap-materialised: the union of a large asset's LeafBuffers as
            // OctreeLeaf objects is ~10× the bytes, and reading `octreeLeaves`
            // would pin that expansion on every fragment for good.
            const unionSources = this.octreeLeafSources;
            if (leafSourceCount(unionSources) > 0) {
                this.colliders = createOctreeColliders(
                    unionSources, pivotX, pivotY, pivotZ, this.getPhysicsGridStep(),
                    physicsWorld, this.rigidBody, collisionGroups,
                    { sx: scale.x, sy: scale.y, sz: scale.z },
                );
                // Static branch of createOctreeColliders returns exactly one
                // voxels collider; track it so splitPristineColliders can
                // find and remove it later.
                this._pristineUnionCollider = this.colliders[0] ?? null;

                // Replace per-fragment shadow casting with one merged proxy.
                // Position-only geometry, invisible in main pass (colorWrite
                // + depthWrite off), still casts shadow because three.js
                // applies MeshDepthMaterial to every `castShadow` mesh.
                if (this.shadows) this.buildPristineShadowProxy(unionSources, pivotX, pivotY, pivotZ);
            }
        } else {
            // Single-body object: static body at this object's own transform,
            // collider shape from whichever storage form holds the voxels.
            const quat = new THREE.Quaternion().setFromEuler(this.rotation);
            this.rigidBody = createStaticVoxelBody(this, physicsWorld, this.position, quat);

            const sx = this.scale.x, sy = this.scale.y, sz = this.scale.z;
            if (this._isOctreeV2 && this.octreeLeafSource) {
                this.colliders = createOctreeColliders(this.octreeLeafSource, pivotX, pivotY, pivotZ, this.getPhysicsGridStep(), physicsWorld, this.rigidBody, collisionGroups,
                    { sx, sy, sz });
            } else {
                this.colliders = voxelCellCollidersFromChunks(
                    this, boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ,
                    physicsWorld, this.rigidBody, collisionGroups, sx, sy, sz,
                );
            }
        }

        this.userData.collisionGroup = group;
        this.userData.collisionMask = mask;
        this.userData.rigidBody = this.rigidBody;
    }

    /**
     * Create physics colliders at a specific world position (for InstancedMesh instances).
     * Unlike createPhysicsBody(), this doesn't use the VoxelObject's transform.
     * Returns the created rigid body.
     *
     * `rotationXYZ` is the instance's FULL orientation and wins over `rotationY`
     * when supplied. The two exist because the batch draws from whichever the
     * instance carries (`EnvironmentObjectSystem`): a prop the user tilted with
     * the editor gizmo has all three, and passing only the Y component made it
     * render tilted but collide upright — the player blocked by, and standing
     * on, a shape that is not the one on screen. Callers with nothing but a yaw
     * keep working unchanged; a pure-Y `rotationXYZ` is exactly equivalent.
     */
    createPhysicsBodyAtPosition(
        physicsWorld: PhysicsWorld,
        x: number,
        y: number,
        z: number,
        rotationY: number = 0,
        scale?: { width: number; height: number; depth: number },
        rotationXYZ?: { x: number; y: number; z: number },
        envInstance?: EnvInstanceRef,
    ): RAPIER.RigidBody | null {
        const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = this.getBoundsAndPivot();

        const collisionGroups = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);

        // Same Euler order the InstancedMesh matrix is composed with, or the
        // collider would be a DIFFERENT tilt rather than no tilt.
        const quat = new THREE.Quaternion().setFromEuler(rotationXYZ
            ? new THREE.Euler(rotationXYZ.x, rotationXYZ.y, rotationXYZ.z)
            : new THREE.Euler(0, rotationY, 0));

        // 2D-physics lane (see createPhysicsBody).
        if (isPlaneLockedPhysics(physicsWorld)) {
            const transform = { translation: { x, y, z }, rotation: quat, scale: { x: scale?.width || 1, y: scale?.height || 1, z: scale?.depth || 1 } };
            return planeLockedStaticBody(physicsWorld, this.getPhysicsBoxes(), transform, collisionGroups, envInstance ? { voxelObject: this, envInstance } : { voxelObject: this }).rigidBody;
        }

        const rigidBody = createStaticVoxelBody(this, physicsWorld, { x, y, z }, quat, envInstance);

        // Apply scale
        const scaleX = scale?.width || 1;
        const scaleY = scale?.height || 1;
        const scaleZ = scale?.depth || 1;

        if (this._isOctreeV2 && this._fragments) {
            // Multi-fragment template: ONE union collider per instance, built
            // from the per-TYPE cached cell set. (Previously this looped the
            // fragments — one collider per fragment, 60+ colliders per placed
            // instance, and a fresh greedy-mesh of every fragment for every
            // instance at load.) Same collision surface: the union spans
            // exactly the same leaves.
            const unionCells = getUnionVoxelCells(this);
            if (unionCells) {
                attachUnionVoxelCollider(unionCells, physicsWorld, rigidBody, collisionGroups, scaleX, scaleY, scaleZ);
            }
        } else if (this._isOctreeV2 && this.octreeLeafSource) {
            createOctreeColliders(this.octreeLeafSource, pivotX, pivotY, pivotZ, this.getPhysicsGridStep(), physicsWorld, rigidBody, collisionGroups,
                { sx: scaleX, sy: scaleY, sz: scaleZ });
        } else {
            voxelCellCollidersFromChunks(
                this, boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ,
                physicsWorld, rigidBody, collisionGroups, scaleX, scaleY, scaleZ,
            );
        }

        return rigidBody;
    }

    /**
     * Create a dynamic physics body for this object.
     * Dynamic objects can move and be pushed by players/other objects.
     * Automatically registers with DynamicObjectManager for chunk-based
     * hibernation if engine is provided.
     * 
     * @param physicsWorld - Rapier physics world wrapper
     * @param mass - Mass in kg (default: calculated from voxel count; ignored for sphere colliders)
     * @param engine - Optional engine reference for auto-registration with chunk system
     * @param options - Collider options, see DynamicPhysicsBodyOptions
     */
    createDynamicPhysicsBody(physicsWorld: PhysicsWorld, mass: number = 10, engine?: DynamicObjectManagerHost, options?: Partial<DynamicPhysicsBodyOptions>): void {
        if (this.rigidBody) {
            this.removePhysicsBody();
        }

        const { colliderShape, startAsleep } = { ...DEFAULT_DYNAMIC_PHYSICS_BODY_OPTIONS, ...options };
        const isSphere = colliderShape === 'sphere';

        this._isDynamic = true;
        this.userData.excludeFromSplatExport = true; // dynamic → excluded from static GS bake
        this.physicsWorld = physicsWorld;
        this.colliders = [];

        const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = this.getBoundsAndPivot();

        // Create dynamic rigid body at object position.
        // Gravity starts ENABLED. If the object is registered with DynamicObjectManager
        // before terrain colliders are ready, holdPhysicsUntilReady() will disable it
        // until colliders are active. This ensures objects created at runtime (e.g.,
        // trees knocked over by vehicles) have gravity immediately.
        if (isPlaneLockedPhysics(physicsWorld)) {
            // 2D-physics lane (VoxelObjectPlaneLocked.ts).
            const w = this.decomposeWorld();
            const built = planeLockedDynamicBody(physicsWorld, this.getPhysicsBoxes(), { translation: w.pos, rotation: w.quat, scale: w.scale }, mass, { voxelObject: this });
            this.rigidBody = built.rigidBody; this.colliders = built.colliders; this.userData.rigidBody = built.rigidBody;
            return finishDynamicVoxelBody(this, mass, isSphere, startAsleep, engine ?? _engineRef);
        }

        const quat = new THREE.Quaternion().setFromEuler(this.rotation);
        const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(this.position.x, this.position.y, this.position.z)
            .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
            .setLinearDamping(isSphere ? DEFAULT_BALL_PHYSICS.linearDamping : 0.1).setAngularDamping(isSphere ? DEFAULT_BALL_PHYSICS.angularDamping : 0.1)
            // Sphere-only CCD so fast rolling balls don't tunnel through thin walls/floors.
            .setCcdEnabled(isSphere);

        this.rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);

        const collisionGroups = makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP);

        if (isSphere) {
            // Single ball collider — the only collider shape that actually rolls.
            const colliderDesc = createBallColliderDesc(
                this.getBoundsInWorldUnits(), { x: pivotX, y: pivotY, z: pivotZ }, collisionGroups);
            this.colliders.push(physicsWorld.createCollider(colliderDesc, this.rigidBody));
        } else if (this._isOctreeV2 && this._fragments) {
            // Multi-fragment + dynamic: aggregate every fragment's leaves onto
            // the single dynamic body so the whole thing tumbles as one piece.
            // (Detach-on-explosion is for static multi-fragment objects; a
            // dynamic multi-fragment object is conceptually one rigid asset.)
            const sources = this.octreeLeafSources;
            const totalVol = octreeTotalVolume(sources);
            const density = totalVol > 0 ? mass / totalVol : 1.0;
            for (const src of sources) {
                this.colliders.push(...createOctreeColliders(
                    src, pivotX, pivotY, pivotZ, this.getPhysicsGridStep(), physicsWorld, this.rigidBody, collisionGroups,
                    { dynamic: true, density, restitution: 0.3 }));
            }
        } else if (this._isOctreeV2 && this.octreeLeafSource) {
            const vol = octreeTotalVolume(this.octreeLeafSource);
            const density = vol > 0 ? mass / vol : 1.0;
            this.colliders = createOctreeColliders(
                this.octreeLeafSource, pivotX, pivotY, pivotZ, this.getPhysicsGridStep(), physicsWorld, this.rigidBody, collisionGroups,
                { dynamic: true, density, restitution: 0.3 });
        } else {
            // One cuboid per greedy-meshed box (the same local-space boxes every
            // other chunk collider path uses); density comes from their combined
            // volume so the requested mass is honoured.
            const boxes = collectChunkPhysicsBoxes(this, boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ);
            let totalVolume = 0;
            for (const box of boxes) totalVolume += 8 * box.hx * box.hy * box.hz;
            const density = totalVolume > 0 ? mass / totalVolume : 1.0;

            for (const box of boxes) {
                const colliderDesc = RAPIER.ColliderDesc.cuboid(box.hx, box.hy, box.hz)
                    .setTranslation(box.cx, box.cy, box.cz)
                    .setCollisionGroups(collisionGroups)
                    .setFriction(0.5)
                    .setRestitution(0.3)
                    .setDensity(density);

                this.colliders.push(physicsWorld.createCollider(colliderDesc, this.rigidBody));
            }
        }
        
        // Honor the requested mass exactly (colliders are a coarser cover than
        // the source voxels, so density-derived mass drifts heavy — see
        // trueUpBodyMass). Sphere colliders stay density-driven on purpose.
        if (!isSphere) {
            trueUpBodyMass(this.rigidBody, this.colliders, mass);
        }
        finishDynamicVoxelBody(this, mass, isSphere, startAsleep, engine ?? _engineRef);
    }


    /**
     * Sync the visual mesh position/rotation with the physics body.
     * Call this in your update loop for dynamic objects.
     */
    syncWithPhysics(): void {
        if (!this.rigidBody || !this._isDynamic) return;

        if (this._surfaceRestFramesLeft > 0 && this.physicsWorld && this.physicsWorld.getStepsTaken() > 0) {
            this._surfaceRestFramesLeft--;
            if (this.restOnSurfaceBelow(this.physicsWorld, 4, 3, true)) {
                this._surfaceRestFramesLeft = 0;
                const p = this.rigidBody.translation();
                this._restPosition = { x: p.x, y: p.y, z: p.z };
            }
        } else if (this._restsOnWake && this.physicsWorld && !this.rigidBody.isSleeping()) {
            // A load-time prop that woke without being pushed goes back to sleep — see
            // settleSpuriousWake for the non-gameplay reasons it wakes.
            if (this.settleSpuriousWake(this.physicsWorld, this._restPosition) === 'moving') {
                this._restsOnWake = false;   // a real event: from here on it is ordinary physics
            }
        }

        const pos = this.rigidBody.translation();

        // Safety net: if the body has sunk into solid voxel terrain — typically
        // because it moved across a chunk whose physics colliders are currently
        // disabled and fell through the surface — lift it back so the solver
        // never sees a deep penetration (which would eject the light body at
        // extreme speed). The voxel GRID query works regardless of collider
        // state. The "feet" are origin + collider-bottom offset, NOT the origin
        // itself (the pivot is an arbitrary authoring point, often far below the
        // physical bottom). Sleeping bodies are skipped — they cannot be falling,
        // and waking them here would itself destabilise resting props.
        if (!this.rigidBody.isSleeping()) {
            const feetY = pos.y + this._colliderBottomOffsetY;
            const floorY = _engineRef?.getDynamicObjectManager?.()?.getVoxelFloorY(pos.x, feetY, pos.z) ?? null;
            if (floorY !== null) {
                const newY = pos.y + (floorY - feetY);
                this.rigidBody.setTranslation({ x: pos.x, y: newY, z: pos.z }, true);
                const lv = this.rigidBody.linvel();
                this.rigidBody.setLinvel({ x: lv.x, y: 0, z: lv.z }, true);
                pos.y = newY;
            }
        }

        this.position.set(pos.x, pos.y, pos.z);

        const rot = this.rigidBody.rotation();
        const quat = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
        this.rotation.setFromQuaternion(quat);

        // Slot-rendered fragment (promoted batched destructible): the shared
        // per-fragment InstancedMesh slot is this object's only visual —
        // mirror the body transform into it.
        if (this._fragmentSlot) {
            _slotMatrix.compose(this.position, quat, this.scale);
            this._fragmentSlot.setMatrix(_slotMatrix);
        }

        // Keep the chunk registration in sync with the physics position.
        // Hibernation visibility is driven by the chunks the object is REGISTERED
        // in, not where it currently is — without this, a prop that drifts out of
        // its home chunk gets hidden whenever that home chunk leaves the view.
        // Throttled to meaningful movement so resting props pay nothing.
        const dx = pos.x - this._lastChunkRegPos.x;
        const dz = pos.z - this._lastChunkRegPos.z;
        const mgr = dx * dx + dz * dz > 0.25 ? _engineRef?.getDynamicObjectManager?.() : null;
        if (mgr) {
            mgr.updatePosition(this);
            this._lastChunkRegPos.set(pos.x, this._lastChunkRegPos.y, pos.z);
        }
    }

    updatePhysicsTransform(): void {
        if (!this.rigidBody) return;

        // Set position
        this.rigidBody.setTranslation({ x: this.position.x, y: this.position.y, z: this.position.z }, true);

        // Set rotation from Euler
        const quat = new THREE.Quaternion().setFromEuler(this.rotation);
        this.rigidBody.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
    }

    removePhysicsBody(): void {
        if (!this.rigidBody || !this.physicsWorld) return;
        const body = this.liveBody;
        if (!body) console.warn('VoxelObject.removePhysicsBody: rigid body already removed');
        clearColliders(this);
        if (body) this.physicsWorld.removeRigidBody(body);
        this.rigidBody = null;
    }

    /**
     * Explode voxels within a radius of the given world position.
     * Creates dynamic debris with physics that scatter outward.
     * 
     * @param worldCenter - Explosion center in world coordinates
     * @param radius - Explosion radius in world units
     * @param impulseStrength - Outward impulse force (default 5)
     * @param impulseUp - Additional upward impulse (default 2)
     * @param parentGroup - THREE.Object3D to add debris meshes to (defaults to this object's parent)
     * @param voxelWorld - Optional terrain VoxelWorld; when provided, settled debris merges
     *   into terrain as real blocks with colliders that can be re-destroyed.
     * @param mergeBlockType - Block type for merged colored debris (default 1).
     * @returns Array of debris created, empty if no physics world or no voxels affected
     */
    explodeAt(
        worldCenter: THREE.Vector3,
        radius: number,
        impulseStrength: number = 5,
        impulseUp: number = 2,
        parentGroup?: THREE.Object3D,
        voxelWorld?: VoxelWorld,
        mergeBlockType?: number,
    ): VoxelObjectDebris[] {
        if (!this.physicsWorld) {
            console.warn('VoxelObject.explodeAt: No physics world - call createPhysicsBody first');
            return [];
        }

        // Trailer timeline: prop destruction (projectile blasts additionally
        // log 'explosion' in Projectile; per-object debounce absorbs mining taps).
        getGameEventLog().logEvent({
            type: 'destruction',
            position: worldCenter,
            actor: this.name ? `prop:${this.name}` : 'prop',
            intensity: Math.min(1, 0.3 + radius / 5),
        });

        // Multi-fragment pre-fragmented asset: detach affected fragments as
        // whole rigid bodies instead of re-meshing/re-collidering the parent.
        if (this._fragments && this._fragmentAabbs) {
            return this.detachAffectedFragments(worldCenter, radius, impulseStrength, impulseUp);
        }

        // Octree V2 objects use a separate explosion path (variable-sized leaves with RGB colors)
        if (this._isOctreeV2 && this.octreeLeaves) {
            return this.explodeAtOctreeV2(worldCenter, radius, impulseStrength, impulseUp, parentGroup, voxelWorld, mergeBlockType);
        }

        const { localPoint: localCenter, worldPos: objectWorldPos, worldQuat: objectWorldQuat } = this.toLocalFrame(worldCenter);

        // Collect voxels within radius
        const voxelsToDetach = this.collectVoxelsInSphere(localCenter, radius);

        if (voxelsToDetach.length === 0) {
            return [];
        }

        // Spawn debris before removing voxels
        const debris = this.spawnDebrisFromVoxels(
            voxelsToDetach,
            worldCenter,
            objectWorldPos,
            objectWorldQuat,
            impulseStrength,
            impulseUp,
            parentGroup ?? this.parent ?? undefined,
            voxelWorld,
        );

        // Remove voxels from internal data
        this.removeVoxelsFromData(voxelsToDetach);

        // Surviving voxels keep simulating as debris regardless of which branch
        // finalizeAfterRemoval takes — it never touches the debris registry.
        this.finalizeAfterRemoval(this.getVoxelCount() > 0, true);

        return debris;
    }

    /**
     * Multi-fragment explosion: AABB-sphere test each child fragment against
     * the explosion sphere (in object-local frame); detach each hit as a
     * dynamic rigid body. Replaces the per-voxel debris path entirely — no
     * mesh / collider rebuild on the surviving fragments.
     */
    private detachAffectedFragments(
        worldCenter: THREE.Vector3, radius: number, impulseStrength: number, impulseUp: number,
    ): VoxelObjectDebris[] {
        const fragments = this._fragments;
        const aabbs = this._fragmentAabbs;
        if (!fragments || !aabbs || !this.physicsWorld) return [];

        const { localPoint: localCenter } = this.toLocalFrame(worldCenter);
        const radiusSq = radius * radius;
        const struck = (aabb: FragmentAabb): boolean => sphereIntersectsAabb(localCenter, radiusSq, aabb.min, aabb.max);

        // Shatter mode (small props): ANY qualifying hit releases the whole
        // object, so nothing is left hovering where the struck part used to
        // be. A blast that touches nothing still does nothing.
        if (this._destructionMode === 'shatter') {
            if (!aabbs.some(struck)) return [];
            return shatterAllFragments(this, worldCenter, localCenter, radiusSq, impulseStrength, impulseUp);
        }

        const debris: VoxelObjectDebris[] = [];
        // Descending so each detach's splice leaves the indices still to come
        // intact; detachFragmentAt keeps `_fragments`/`_fragmentAabbs` in lock-step.
        for (let i = fragments.length - 1; i >= 0; i--) {
            if (!struck(aabbs[i]!)) continue;
            detachFragmentAt(fragments, aabbs, i, worldCenter, impulseStrength, impulseUp, debris);
        }

        // Fragment-level structural collapse (unsupported fragments fall) +
        // container finalisation when the last fragment leaves — see
        // VoxelObjectPristineOps.collapseUnsupportedAndFinalize.
        collapseUnsupportedAndFinalize(this, worldCenter, impulseStrength, debris);
        return debris;
    }

    /**
     * Convert this static fragment into a free-floating dynamic body.
     *
     * - Reparents from the multi-fragment container to scene root (preserves
     *   world transform via THREE.Object3D.attach).
     * - Switches the existing rigid body static → dynamic, applies a radially
     *   outward impulse.
     * - Registers with `voxelObjectDebris` so its visual follows the body
     *   and it participates in TTL / stuck-fragment checks / explosion push.
     *
     * Idempotent on a non-fragment / no-body VoxelObject (returns null).
     */
    detachAsDynamic(
        worldCenter: THREE.Vector3, impulseStrength: number, impulseUp: number,
    ): VoxelObjectDebris | null {
        if (!this._isFragment || !this.physicsWorld) return null;
        const parent = this.parent;
        if (!(parent instanceof VoxelObject)) return null;

        // Lazy-split: if the parent is still pristine (one union trimesh),
        // swap it for per-fragment trimeshes now so we have something to
        // peel. Subsequent detaches on the same parent find this.colliders
        // already populated and skip the split.
        if (parent._pristineUnionCollider) {
            parent.splitPristineColliders();
        }

        // Peel this fragment's colliders off the parent's shared static body.
        // The collider instances themselves are owned by the physics world,
        // not by the body — removing them disconnects them from the body but
        // doesn't disturb the other fragments' colliders.
        clearColliders(this);

        // Read the owning container's policy before we reparent away from it:
        // a shattered prop dumps its whole fragment set at once, so those
        // chunks age out instead of resting forever (see spawnChunk).
        const forceDebrisTtl = parent._destructionMode === 'shatter';

        // Reparent into scene root, preserving world transform via attach().
        const { pos: worldPos, quat: worldQuat, scale: worldScale } = parent.decomposeWorld();
        const sceneRoot = parent.parent;
        if (sceneRoot) sceneRoot.attach(this);
        this._isFragment = false;
        this._isDynamic = true;
        this.userData.excludeFromSplatExport = true; // dynamic → excluded from static GS bake

        // Radial impulse from the explosion center to the fragment center.
        const imp = radialBlastImpulse(
            worldPos.x - worldCenter.x,
            worldPos.z - worldCenter.z,
            impulseStrength, impulseUp,
        );

        // Brand-new dynamic body at the fragment's world transform. Colliders
        // are rebuilt from the fragment's leaves — same shape as before,
        // attached to the new body so the fragment can tumble independently.
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(worldPos.x, worldPos.y, worldPos.z)
            .setRotation({ x: worldQuat.x, y: worldQuat.y, z: worldQuat.z, w: worldQuat.w })
            .setLinvel(imp.x, imp.y, imp.z)
            .setAngvel({
                x: (Math.random() - 0.5) * 6,
                y: (Math.random() - 0.5) * 6,
                z: (Math.random() - 0.5) * 6,
            })
            .setLinearDamping(0.5)
            .setAngularDamping(0.8);
        this.rigidBody = this.physicsWorld.createRigidBody(bodyDesc);
        // Tag the new body so the perf classifier attributes it correctly,
        // and so `VoxelObject.fromRigidBody()` can resolve hits.
        this.physicsWorld.setUserData(this.rigidBody, { voxelObject: this });

        // Use the *parent's* pivot so the new colliders line up with the
        // fragment mesh's vertices (which were built in parent-pivot space).
        const { pivotX, pivotY, pivotZ } = parent.getBoundsAndPivot();
        this._detachPivot = new THREE.Vector3(pivotX, pivotY, pivotZ);
        this._detachScale.copy(worldScale);
        const collisionGroups = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);
        if (this.octreeLeaves) {
            this.colliders = createOctreeColliders(
                this.octreeLeaves, pivotX, pivotY, pivotZ, this.getPhysicsGridStep(),
                this.physicsWorld, this.rigidBody, collisionGroups,
                { dynamic: true, density: 2000, sx: worldScale.x, sy: worldScale.y, sz: worldScale.z },
            );
        }

        voxelObjectDebris.spawnChunk(this, { forceTtl: forceDebrisTtl });
        return { body: this.rigidBody, collider: this.colliders[0]! };
    }

    private buildPristineShadowProxy(sources: ReadonlyArray<LeafSource>, pivotX: number, pivotY: number, pivotZ: number): void {
        if (!this._fragments) return;
        // Use the same per-face vertex layout the octree mesh builders produce
        // for the fragment meshes. Identical geometry + normals means shadow
        // bias behaves the same here as it does for the fragments this proxy
        // replaces — no acne / grid patterns from geometry mismatch.
        //
        // At load every fragment still holds its compact LeafBuffer, so the
        // buffer-native builder does the whole job allocation-free. Only an
        // editor-touched (already-materialised) fragment forces the transient
        // array path — transient: nothing here is stored back on a fragment.
        const buffers = sources.filter((s): s is LeafBuffer => s instanceof LeafBuffer);
        const proxy = buffers.length === sources.length
            ? buildOctreeMeshFromBuffers(buffers, pivotX, pivotY, pivotZ, true, this._zFightingId)
            : buildOctreeMesh(sources.flatMap(s => s instanceof LeafBuffer ? s.toArray() : [...s]), pivotX, pivotY, pivotZ, true, this._zFightingId);
        if (!proxy) return;
        (proxy.material as THREE.Material).dispose();
        proxy.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
        proxy.receiveShadow = false;
        proxy.name = 'PristineShadowProxy';
        this.add(proxy);
        this._pristineShadowMesh = proxy;
        for (const child of this._fragments) { if (child.mesh) child.mesh.castShadow = false; }
    }

    /**
     * Multi-fragment parent: replace the single union trimesh with one
     * trimesh per surviving fragment. Called on the first `detachAsDynamic`
     * after `createPhysicsBody` set up the pristine union — gives the peel
     * path something to peel. Idempotent.
     */
    private splitPristineColliders(): void {
        if (!this._pristineUnionCollider || !this.rigidBody || !this.physicsWorld || !this._fragments) return;
        const physicsWorld = this.physicsWorld;
        if (this._pristineUnionCollider.isValid()) physicsWorld.removeCollider(this._pristineUnionCollider);
        this._pristineUnionCollider = null;
        this.colliders = [];

        if (this._pristineShadowMesh) {
            this.remove(this._pristineShadowMesh);
            this._pristineShadowMesh.geometry.dispose();
            (this._pristineShadowMesh.material as THREE.Material).dispose();
            this._pristineShadowMesh.customDepthMaterial?.dispose();
            this._pristineShadowMesh = null;
            for (const child of this._fragments) {
                if (child.mesh) child.mesh.castShadow = this.shadows;
            }
        }

        const { scale: worldScale } = this.decomposeWorld();
        const collisionGroups = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);
        const { pivotX, pivotY, pivotZ } = this.getBoundsAndPivot();

        for (const child of this._fragments) {
            // Resident storage only — splitting must not materialise every
            // SURVIVING fragment's buffer just because one fragment detached.
            const src = child.octreeLeafSource;
            if (!src) continue;
            child.physicsWorld = physicsWorld;
            child.colliders = createOctreeColliders(
                src, pivotX, pivotY, pivotZ, this.getPhysicsGridStep(),
                physicsWorld, this.rigidBody, collisionGroups,
                { sx: worldScale.x, sy: worldScale.y, sz: worldScale.z },
            );
            this.colliders.push(...child.colliders);
        }
    }

    /**
     * Replace this detached fragment's N cuboid colliders with a single
     * trimesh. Only valid after `detachAsDynamic()` has captured the parent
     * pivot/scale, and only meaningful once the body has been flipped to
     * Fixed (otherwise Rapier still wants cuboids for proper dynamic mass
     * properties and CCD behavior). Called from `VoxelObjectDebris.settleEntry`.
     *
     * Returns true if the swap happened, false if preconditions weren't met.
     */
    rebuildCollidersAsTrimesh(): boolean {
        if (!this.rigidBody || !this.physicsWorld || !this.octreeLeaves || this.octreeLeaves.length === 0 || !this._detachPivot) return false;
        clearColliders(this);
        const collisionGroups = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);
        this.colliders = createOctreeColliders(
            this.octreeLeaves,
            this._detachPivot.x, this._detachPivot.y, this._detachPivot.z,
            this.getPhysicsGridStep(),
            this.physicsWorld, this.rigidBody, collisionGroups,
            { sx: this._detachScale.x, sy: this._detachScale.y, sz: this._detachScale.z },
        );
        return true;
    }

    /**
     * Split this already-detached dynamic fragment into `k` smaller pieces
     * in place. Called by the fragment registry when a fragment is still
     * jittering 2 s after detachment — splitting it lets each piece settle
     * at a different orientation and gets it unstuck from whatever it's
     * grinding against. Caller is responsible for unregistering this
     * fragment from `voxelObjectDebris` and registering the returned pieces.
     *
     * The pieces inherit the original fragment's world transform, linear
     * and angular velocity, plus a small outward separation impulse so
     * they don't just lie back on top of each other.
     *
     * Returns an empty array on no-op (too few leaves, missing physics
     * world, etc.) — caller should keep the original entry alive.
     */
    splitInPlace(k: number): VoxelObject[] {
        if (!this._isDynamic || !this.physicsWorld || !this.rigidBody) return [];
        if (!this.octreeLeaves || this.octreeLeaves.length < 4) return [];
        const sceneRoot = this.parent;
        if (!sceneRoot) return [];

        const desired = Math.max(2, Math.min(8, k));
        const pieces = spatialMidpointPartition(this.octreeLeaves, desired);
        if (pieces.length < 2) return [];

        // Snapshot current dynamic state — we'll recreate identical bodies
        // for each piece below, then dispose this fragment.
        const oldBody = this.rigidBody;
        const pos = oldBody.translation();
        const rot = oldBody.rotation();
        const linvel = oldBody.linvel();
        const angvel = oldBody.angvel();
        const physWorld = this.physicsWorld;

        // Overall centroid in local (mesh) space — used to direct the
        // per-piece separation impulse outward from the fragment's middle.
        const centroid = leafListCentroid(this.octreeLeaves);

        const sharedBounds = this.bounds ? { ...this.bounds } : null;
        const sharedAtlas = this.useAtlas;
        const sharedShadows = this.shadows;
        const sharedZId = this._zFightingId;
        const sharedVoxelSize = this.voxelSize;
        const sharedPhysicsGridStep = this._physicsGridStep;
        const sharedRoundingRadius = this.voxelRoundingRadiusVoxels;
        const sharedRoundingSegments = this.voxelRoundingSegments;
        const collisionGroups = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);

        // Dismantle the original *before* spawning the pieces so the
        // physics world doesn't briefly contain stacked colliders.
        this.removePhysicsBody();
        sceneRoot.remove(this);
        this.dispose();

        const SEPARATION_IMPULSE = 1.5; // m/s outward kick per piece
        const worldQuat = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);

        const result: VoxelObject[] = [];
        for (const pieceLeaves of pieces) {
            // Piece centroid in local space → outward radial direction, rotated
            // into world space. A piece centred on the whole has no direction to
            // push along, so it gets a random sideways kick plus lift instead.
            const pieceCentroid = leafListCentroid(pieceLeaves);
            const odx = pieceCentroid.x - centroid.x;
            const ody = pieceCentroid.y - centroid.y;
            const odz = pieceCentroid.z - centroid.z;
            const oLen = Math.sqrt(odx * odx + ody * ody + odz * odz);
            const radialLocal = (oLen > 0.001
                ? new THREE.Vector3(odx / oLen, ody / oLen, odz / oLen)
                : new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5))
                .multiplyScalar(SEPARATION_IMPULSE)
                .applyQuaternion(worldQuat);

            const piece = new VoxelObject({
                voxelSize: sharedVoxelSize,
                shadows: sharedShadows,
                voxelRoundingRadiusVoxels: sharedRoundingRadius,
                voxelRoundingSegments: sharedRoundingSegments,
            });
            piece._isOctreeV2 = true;
            piece._isDynamic = true;
            piece.userData.excludeFromSplatExport = true; // dynamic fragment → excluded from static GS bake
            piece._zFightingId = sharedZId;
            piece.bounds = sharedBounds ? { ...sharedBounds } : null;
            piece.boundsInWorldUnits = true;
            piece.useAtlas = sharedAtlas;
            piece._physicsGridStep = sharedPhysicsGridStep;
            piece.octreeLeaves = pieceLeaves;
            piece.rebuildOctreeMesh();
            piece.position.set(pos.x, pos.y, pos.z);
            piece.quaternion.set(rot.x, rot.y, rot.z, rot.w);
            sceneRoot.add(piece);

            piece.physicsWorld = physWorld;
            const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(pos.x, pos.y, pos.z)
                .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
                .setLinvel(
                    linvel.x + radialLocal.x,
                    linvel.y + radialLocal.y,
                    linvel.z + radialLocal.z,
                )
                .setAngvel({
                    x: angvel.x + (Math.random() - 0.5) * 3,
                    y: angvel.y + (Math.random() - 0.5) * 3,
                    z: angvel.z + (Math.random() - 0.5) * 3,
                })
                .setLinearDamping(0.5)
                .setAngularDamping(0.8);
            piece.rigidBody = physWorld.createRigidBody(bodyDesc);

            const { pivotX, pivotY, pivotZ } = piece.getBoundsAndPivot();
            piece.colliders = createOctreeColliders(
                pieceLeaves, pivotX, pivotY, pivotZ, piece.getPhysicsGridStep(),
                physWorld, piece.rigidBody, collisionGroups,
                { dynamic: true, density: 2000, sx: 1, sy: 1, sz: 1 },
            );

            result.push(piece);
        }
        return result;
    }

    /**
     * Octree V2 explosion path — handles variable-sized leaves with per-voxel RGB colors.
     * Unlike chunk-based voxels, octree leaves don't use block types or the texture atlas.
     * Debris is spawned as individual colored physics cubes via voxelObjectDebris.
     */
    private explodeAtOctreeV2(
        worldCenter: THREE.Vector3,
        radius: number,
        impulseStrength: number,
        impulseUp: number,
        parentGroup?: THREE.Object3D,
        voxelWorld?: VoxelWorld,
        mergeBlockType?: number,
    ): VoxelObjectDebris[] {
        const leaves = this.octreeLeaves;
        if (!this.physicsWorld || !leaves) return [];

        const { localPoint: localCenter, worldPos: objectWorldPos, worldQuat: objectWorldQuat } = this.toLocalFrame(worldCenter);

        const pivotX = this.voxelPivot?.x ?? 0;
        const pivotY = this.voxelPivot?.y ?? 0;
        const pivotZ = this.voxelPivot?.z ?? 0;

        const radiusSq = radius * radius;
        const toRemove = new Set<number>();
        const collisionGroups = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);
        const resolvedParent = parentGroup ?? this.parent ?? undefined;
        const debris: VoxelObjectDebris[] = [];

        // Collect and spawn debris for leaves within radius
        for (let i = 0; i < leaves.length; i++) {
            const leaf = leaves[i]!;
            if (!octreeLeafIntersectsSpherePivotLocal(
                leaf, pivotX, pivotY, pivotZ, localCenter.x, localCenter.y, localCenter.z, radiusSq)) {
                continue;
            }

            // Leaf center in local space (relative to pivot, same as mesh rendering)
            const lcx = leaf.x + leaf.size * 0.5 - pivotX;
            const lcy = leaf.y + leaf.size * 0.5 - pivotY;
            const lcz = leaf.z + leaf.size * 0.5 - pivotZ;

            toRemove.add(i);

            // Compute world position for the debris
            const worldPos = new THREE.Vector3(lcx, lcy, lcz)
                .applyQuaternion(objectWorldQuat)
                .add(objectWorldPos);

            // Impulse direction: radially outward from explosion center
            const ddx = worldPos.x - worldCenter.x;
            const ddy = worldPos.y - worldCenter.y;
            const ddz = worldPos.z - worldCenter.z;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            const imp = radialBlastImpulse(ddx, ddz, impulseStrength, impulseUp);

            // Offset debris slightly outward to avoid clipping
            pushDebrisOutward(worldPos, ddx, ddy, ddz, dist, leaf.size);

            const body = this.physicsWorld.createRigidBody(
                debrisRigidBodyDesc(worldPos.x, worldPos.y, worldPos.z, imp));
            const halfSize = leaf.size / 2;
            const colDesc = RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize)
                .setCollisionGroups(collisionGroups).setFriction(0.5).setRestitution(0.6).setDensity(2000);
            const collider = this.physicsWorld.createCollider(colDesc, body);

            const debrisUserData: Record<string, unknown> = {
                createdAt: performance.now(),
                blockType: mergeBlockType ?? 1,
                isVoxelDebris: true,
                density: 2000,
                debrisSize: leaf.size,
                color: { r: leaf.r, g: leaf.g, b: leaf.b },
            };
            if (voxelWorld) debrisUserData.voxelWorld = voxelWorld;
            this.physicsWorld.setUserData(body, debrisUserData);

            if (resolvedParent) {
                voxelObjectDebris.spawnVoxel(body, collider, this.physicsWorld, leaf.r, leaf.g, leaf.b, leaf.size, resolvedParent);
            }

            debris.push({ body, collider });
        }

        if (toRemove.size === 0) return [];

        // Remove exploded leaves
        const survivors = leaves.filter((_, i) => !toRemove.has(i));
        this.octreeLeaves = survivors;
        this._cachedVoxelCount = -1;

        this.finalizeAfterRemoval(survivors.length > 0, true);

        return debris;
    }

    /**
     * Collect voxels within a sphere (local coordinates).
     */
    private collectVoxelsInSphere(
        localCenter: THREE.Vector3,
        radius: number
    ): Array<{ localX: number; localY: number; localZ: number; blockType: number }> {
        const collected: Array<{ localX: number; localY: number; localZ: number; blockType: number }> = [];
        const radiusSq = radius * radius;

        for (const voxel of this.getVoxelData()) {
            const dx = voxel.x - localCenter.x;
            const dy = voxel.y - localCenter.y;
            const dz = voxel.z - localCenter.z;
            if (dx * dx + dy * dy + dz * dz <= radiusSq) {
                collected.push({ localX: voxel.x, localY: voxel.y, localZ: voxel.z, blockType: voxel.blockType });
            }
        }

        return collected;
    }
    
    /**
     * Spawn debris from detached voxels.
     * Rendering is handled by VoxelDebrisManager via InstancedMesh pools.
     */
    private spawnDebrisFromVoxels(
        voxels: Array<{ localX: number; localY: number; localZ: number; blockType: number }>,
        worldCenter: THREE.Vector3,
        objectWorldPos: THREE.Vector3,
        objectWorldQuat: THREE.Quaternion,
        impulseStrength: number,
        impulseUp: number,
        parentGroup?: THREE.Object3D,
        voxelWorld?: VoxelWorld,
    ): VoxelObjectDebris[] {
        if (!this.physicsWorld) return [];
        
        const debris: VoxelObjectDebris[] = [];
        const halfSize = this.voxelSize / 2;
        const atlas = getVoxelTextureAtlas();
        const collisionGroups = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);
        const resolvedParent = parentGroup ?? this.parent ?? undefined;
        
        for (const voxel of voxels) {
            const worldPos = new THREE.Vector3(voxel.localX, voxel.localY, voxel.localZ)
                .applyQuaternion(objectWorldQuat)
                .add(objectWorldPos);
            
            const dx = worldPos.x - worldCenter.x;
            const dy = worldPos.y - worldCenter.y;
            const dz = worldPos.z - worldCenter.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            
            pushDebrisOutward(worldPos, dx, dy, dz, dist, this.voxelSize);

            const imp = radialBlastImpulse(dx, dz, impulseStrength, impulseUp);

            const body = this.physicsWorld.createRigidBody(
                debrisRigidBodyDesc(worldPos.x, worldPos.y, worldPos.z, imp));
            
            const materialId = atlas.getBlockMaterial(voxel.blockType);
            const density = materialId !== undefined ? getMaterialRegistry().getDensity(materialId) : 600;
            
            const colliderDesc = RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize)
                .setCollisionGroups(collisionGroups).setFriction(0.5).setRestitution(0.6).setDensity(density);
            const collider = this.physicsWorld.createCollider(colliderDesc, body);
            
            const chunkDebrisUserData: Record<string, unknown> = {
                createdAt: performance.now(),
                blockType: voxel.blockType,
                isVoxelDebris: true,
                density,
                debrisSize: this.voxelSize,
            };
            if (voxelWorld) chunkDebrisUserData.voxelWorld = voxelWorld;
            this.physicsWorld.setUserData(body, chunkDebrisUserData);
            
            if (resolvedParent) {
                VoxelDebrisManager.spawnDebris(body, collider, this.physicsWorld, voxel.blockType, this.voxelSize, resolvedParent);
            }
            
            debris.push({ body, collider });
        }
        
        return debris;
    }
    
    /**
     * Remove voxels from internal chunk data using local coordinates.
     */
    private removeVoxelsFromData(voxels: Array<{ localX: number; localY: number; localZ: number }>): void {
        for (const voxel of voxels) {
            this.removeVoxelAt(voxel.localX, voxel.localY, voxel.localZ);
        }
        // Invalidate cache
        this._cachedVoxelCount = -1;
    }

    /**
     * Remove a batch of voxels by local coordinates, then rebuild mesh and physics.
     * Used by DeterministicDestruction to separate voxel removal from debris spawning.
     */
    removeVoxelsBatch(voxels: Array<{ localX: number; localY: number; localZ: number }>): void {
        this.removeVoxelsFromData(voxels);
        this.finalizeAfterRemoval(this.getVoxelCount() > 0, true);
    }

    
    dispose(): void {
        this.removePhysicsBody();
        // A disposed object must stop blocking NPC pathing (and stop leaking
        // its tracked-obstacle provider).
        this.setNavmeshObstacleEnabled(false);
        this.releaseFragmentSlot();
        // Note: Debris continues to exist independently (managed by VoxelDebrisManager)

        // Release z-fighting registry entry
        getZFightingRegistry().releaseObjectOffset(this._zFightingId);

        this.disposeMesh();
        this.chunks.clear();
        this.octreeLeaves = null;
        this._octreeRawData = null;
        this._vxlV3Data = null;
    }
}

