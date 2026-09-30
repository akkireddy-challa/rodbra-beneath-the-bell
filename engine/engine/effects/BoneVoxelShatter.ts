/**
 * BoneVoxelShatter — two-stage limb destruction for voxelized skinned
 * characters (Asset Forger `output-variant-N.glb` rigs).
 *
 * Those GLBs are SkinnedMeshes whose surface is built from small cubes
 * (one per exposed voxel) with vertex colors, skinned to a Mixamo skeleton.
 * On death:
 *
 *  Stage 1 — LIMBS SEPARATE AND FALL. The body splits into rigid limb pieces
 *  (head, torso, arms, legs — grouped by bone name, torso fallback for
 *  unknowns). Each piece is built from the EXACT source-GLB triangles whose
 *  dominant skin bone is in that limb — real geometry and real vertex colors,
 *  sliced polygon by polygon and frozen at the death pose, so a chunk looks
 *  precisely like the body part it came from. They ease apart and FALL under
 *  gravity (no explosion fling by default), bouncing off the world AND off
 *  each other — limb pieces collide with one another but not with the loose
 *  voxels. A velocity clamp during the spawn grace keeps the overlap
 *  depenetration from flinging them apart.
 *
 *  Stage 2 — PIECES BURST ON A WORLD HIT. Each piece carries a collision
 *  callback (the same first-hit pattern VoxelStructuralCollapse uses for
 *  falling building chunks): on its first contact with the WORLD (ground,
 *  wall, prop) after a short grace period it bursts into its individual
 *  native voxels, inheriting the piece's momentum. Limb-vs-limb contacts only
 *  bounce — they never trigger the burst. Contacts that arrive DURING the
 *  grace are remembered, and when the grace expires the piece bursts if it is
 *  still touching the world (Rapier contact events are edge-triggered, so a
 *  consumed "started" event never re-fires while the pair stays in contact).
 *  The voxels land in the shared `voxelObjectDebris` registry (instanced
 *  rendering, TTL, settle-freeze, global cap).
 *
 * Voxel cells are reconstructed from the bind-pose geometry: each face's
 * centroid minus half a voxel along its normal lands on the cube's center,
 * so quantizing those estimates to the voxel grid recovers the cell set.
 * Each cell takes its color from the face's vertex colors and its bone from
 * the face's dominant skin weight. An exterior flood fill marks which open
 * faces are actually visible, so the hollow interior shell of the surface
 * reconstruction is never emitted. Extraction (and the per-bone CPU vertex
 * data) is cached per geometry UUID with a small LRU, so all NPCs cloned
 * from the same source GLB share one parse; `prewarmSkinnedVoxelShatter`
 * lets controllers pay that parse at spawn time instead of the first kill.
 * Meshes without vertex colors or skinning attributes are rejected (returns
 * false) so the caller can fall back to another death effect.
 *
 * Wiring: `boneVoxelLimbs.update(deltaTime)` is ticked from GameEngine's
 * main loop (next to `voxelObjectDebris.update`), and limb pieces are
 * cleared on level reset via `VoxelDebrisManager.clearForWorld`.
 *
 * Related files:
 * - engine/VoxelStructuralCollapse.ts — the chunk-falls-then-shatters-on-
 *   first-contact pattern stage 2 mirrors
 * - engine/VoxelObjectDebris.ts — debris registry the voxels spawn into
 * - engine/VoxelObject.ts detachAsDynamic / explodeAtOctreeV2 — the chunk
 *   and per-voxel debris body recipes mirrored here
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld, ContactInfo } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { voxelObjectDebris } from 'engine/VoxelObjectDebris.js';

export interface BoneVoxelShatterOptions {
    /**
     * Per-character voxel-debris budget, split across the GLB's voxelized
     * skinned meshes. Voxels keep their NATIVE size; when the surface has
     * more voxels than this, they are evenly thinned (not merged into
     * bigger cubes). Kept just under the global registry cap (512) so one
     * death doesn't evict all other live debris. Clamped to a minimum of 8.
     */
    maxDebris: number;
    /**
     * Outward (horizontal) separation speed for each limb piece (m/s). Small
     * by default so pieces just ease apart and fall; raise for an explosive
     * fling.
     */
    boneSpeedMin: number;
    boneSpeedMax: number;
    /**
     * Upward kick as a multiple of the horizontal speed. 0 = pieces simply
     * fall (default); >0 launches them up into an arc first (~1.2 = clear arc).
     */
    upwardBias: number;
    /** Extra random per-voxel speed on top of the inherited velocity (m/s). */
    voxelScatterSpeed: number;
    /** Max random tumble speed per axis for loose voxels (rad/s). */
    maxAngularSpeed: number;
    /**
     * Two-stage mode: limbs separate as rigid pieces first, then each
     * piece bursts into voxels on its first impact. When false the
     * character bursts directly into voxels (the old single-stage look).
     */
    limbs: boolean;
    /**
     * Whether limb pieces burst into voxels when they hit the world. When
     * false the pieces just separate, fall, bounce and REMAIN as solid limb
     * chunks (no stage-2 voxels) until the level resets or the active-piece
     * cap evicts the oldest. Only meaningful when `limbs` is true.
     */
    limbBurst: boolean;
    /**
     * Contacts within this many seconds of the limb spawning are deferred —
     * pieces start touching the ground/corpse, and the fling needs a moment
     * to carry them clear. A piece still touching when the grace expires
     * bursts then.
     */
    limbImpactGraceSec: number;
    /** Failsafe: a piece that never registers an impact bursts after this. */
    limbMaxLifetimeSec: number;
    /**
     * Number of small "splash" voxels (e.g. red gore) sprayed from the body
     * when the limbs separate. Cosmetic only — they fly out, arc, and despawn
     * via the debris registry's TTL; the limb chunks stay intact. 0 = none.
     */
    splashCount: number;
    /** Linear RGB of the splash voxels. */
    splashColor: { r: number; g: number; b: number };
}

export const DEFAULT_BONE_VOXEL_SHATTER: BoneVoxelShatterOptions = {
    maxDebris: 480,
    // Gentle outward separation only — the pieces FALL and bounce off each
    // other rather than being flung apart. Raise for a more explosive look.
    boneSpeedMin: 0.4,
    boneSpeedMax: 1.0,
    upwardBias: 0,
    voxelScatterSpeed: 1.5,
    maxAngularSpeed: 8,
    limbs: true,
    // TEMP: stage-2 voxel burst disabled — limbs separate, fall, bounce, and
    // stay as solid chunks. Set back to true to re-enable the voxel burst.
    limbBurst: false,
    limbImpactGraceSec: 0.4,
    limbMaxLifetimeSec: 5,
    splashCount: 84,
    splashColor: { r: 0.6, g: 0.0, b: 0.0 }, // blood red
};

// Same recipe as VoxelObject.explodeAtOctreeV2 colored-leaf debris.
const DEBRIS_DENSITY = 2000;
const DEBRIS_COLLISION_GROUPS = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);
// Limb pieces additionally collide with EACH OTHER (the DEBRIS bit added to
// the mask) so they tumble and bounce off one another. The loose voxel cubes
// keep the plain DEBRIS mask (no self bit), so a limb does NOT collide with
// the tiny voxels — only with the world and other limb pieces.
const LIMB_COLLISION_GROUPS = makeCollisionGroups(
    CollisionGroup.DEBRIS,
    CollisionMask.DEBRIS | CollisionGroup.DEBRIS,
);

// Sanity window for the estimated voxel edge length IN WORLD UNITS (bind-space
// estimate × the rig's skinning-chain scale, so rigs authored in non-meter
// units pass). Outside it the mesh is not a voxelized surface (e.g. the
// textured low-poly fallback variant) and extraction bails so the caller can
// use another death effect.
const MIN_VOXEL_SIZE = 0.001;
const MAX_VOXEL_SIZE = 0.3;

// Floor for the per-mesh cell budget, so a tiny maxDebris still yields a
// recognisable scatter rather than a handful of stray voxels.
const MIN_CELL_BUDGET = 8;

// Pieces reaped without a burst when they fall below this (mirrors the debris
// registry's fall-off reaper).
const FALL_OFF_Y = -100;

// Loose-voxel speed inherited from a bursting piece is capped so a fast piece
// doesn't launch its voxels into the debris velocity-cap regime.
const MAX_INHERITED_SPEED = 12;

// Limb pieces faster than this during the impact grace are clamped — pieces
// spawn overlapping each other (adjacent limbs share a joint) and the solver's
// penetration recovery would otherwise fling them apart like an explosion.
// Keeping it low makes them ease apart and drop rather than burst outward.
const GRACE_MAX_SPEED = 3;

// Global cap on simultaneously-live limb pieces (mass-death moments). The
// oldest piece is burst early when the cap is hit — mirrors the debris
// registry's oldest-eviction.
const MAX_ACTIVE_PIECES = 24;

// Extraction + limb-template cache LRU size: distinct character assets alive
// per session. Sized above a horde game's roster (Splatter City runs 16
// species): at 8, every prewarm past the eighth evicted an earlier species,
// whose next kill then re-extracted and re-baked at 94 ms — the exact cost
// the caches exist to pay once.
const EXTRACTION_CACHE_MAX = 32;


// ── Extraction ─────────────────────────────────────────────────────────

interface ShatterCell {
    /** Grid indices in the bind-space voxel lattice */
    ix: number; iy: number; iz: number;
    /** Bind-space voxel center */
    x: number; y: number; z: number;
    /** Linear RGB from the source vertex colors */
    r: number; g: number; b: number;
    boneIndex: number;
}

interface ExtractedVoxels {
    /** Native voxel edge length in bind space (drives stage-2 voxel cubes) */
    voxelSize: number;
    /** Every reconstructed surface voxel (stage-2 burst payload) */
    cells: ShatterCell[];
    /** Cells grouped by dominant bone index */
    boneCells: Map<number, ShatterCell[]>;
    /**
     * Source-GLB triangle indices grouped by the triangle's dominant skin
     * bone. The stage-1 limb chunks are built from these EXACT triangles
     * (real positions + vertex colors), sliced per bone — not reconstructed
     * voxel cubes — so the chunks match the body parts exactly.
     */
    boneTriangles: Map<number, number[]>;
}

interface CellAccumulator {
    ix: number; iy: number; iz: number;
    sx: number; sy: number; sz: number;
    sr: number; sg: number; sb: number;
    /** Sample count for the position/color averages */
    samples: number;
    boneWeights: Map<number, number>;
}

/**
 * Small LRU keyed by geometry UUID; null = parsed before and found unusable
 * (don't retry every death). Entries are CPU-only data, so eviction needs no
 * GPU disposal.
 */
const extractionCache = new Map<string, ExtractedVoxels | null>();

/** Pack a (possibly negative) grid coordinate triple into one exact double. */
function packCellKey(ix: number, iy: number, iz: number): number {
    return ((ix + 32768) * 65536 + (iy + 32768)) * 65536 + (iz + 32768);
}

/** Return the array stored at `key`, inserting a fresh empty one if absent. */
function getOrCreateList<K, V>(map: Map<K, V[]>, key: K): V[] {
    let list = map.get(key);
    if (!list) {
        list = [];
        map.set(key, list);
    }
    return list;
}

/** Add every vertex's four skin influences into `out`, keyed by bone index. */
function accumulateBoneWeights(
    skinIndex: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    skinWeight: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    verts: readonly number[],
    out: Map<number, number>,
): void {
    for (const vert of verts) {
        for (let influence = 0; influence < 4; influence++) {
            const w = skinWeight.getComponent(vert, influence);
            if (w <= 0) continue;
            const bone = skinIndex.getComponent(vert, influence);
            out.set(bone, (out.get(bone) ?? 0) + w);
        }
    }
}

/** Bone carrying the most summed weight; 0 for an empty map. */
function dominantBone(boneWeights: Map<number, number>): number {
    let best = 0;
    let bestWeight = -1;
    for (const [bone, w] of boneWeights) {
        if (w > bestWeight) { bestWeight = w; best = bone; }
    }
    return best;
}

function finalizeCells(accumulators: Map<number, CellAccumulator>): ShatterCell[] {
    const out: ShatterCell[] = [];
    for (const acc of accumulators.values()) {
        const inv = 1 / acc.samples;
        out.push({
            ix: acc.ix, iy: acc.iy, iz: acc.iz,
            x: acc.sx * inv, y: acc.sy * inv, z: acc.sz * inv,
            r: acc.sr * inv, g: acc.sg * inv, b: acc.sb * inv,
            boneIndex: dominantBone(acc.boneWeights),
        });
    }
    return out;
}

/**
 * Estimate the voxel edge length as the median of per-triangle minimum edge
 * lengths — each cube face is two right triangles whose legs are exactly one
 * voxel long, so the minimum edge is the voxel size for every face triangle.
 */
function estimateVoxelSize(
    readPosition: (vertIndex: number, target: THREE.Vector3) => void,
    triangleCount: number,
    vertexAt: (tri: number, corner: number) => number,
): number {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const samples: number[] = [];
    const step = Math.max(1, Math.floor(triangleCount / 2000));
    for (let tri = 0; tri < triangleCount; tri += step) {
        readPosition(vertexAt(tri, 0), a);
        readPosition(vertexAt(tri, 1), b);
        readPosition(vertexAt(tri, 2), c);
        const minEdgeSq = Math.min(a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a));
        if (minEdgeSq > 0) samples.push(minEdgeSq);
    }
    if (samples.length === 0) return 0;
    samples.sort((p, q) => p - q);
    return Math.sqrt(samples[Math.floor(samples.length / 2)]!);
}

/**
 * Parse a voxelized skinned mesh into bone-grouped native voxel cells (for
 * the stage-2 burst) and per-bone source-triangle lists (for the stage-1
 * limb-chunk geometry). Returns null (and caches the null) when the geometry
 * lacks skinning or vertex colors, or doesn't look voxelized.
 *
 * `worldScale` is only used to express the voxel-size sanity window in world
 * units; the cached cells stay in bind space. Per character type the scale is
 * deterministic (height normalization of a shared GLB), so it is safe to
 * leave out of the cache key.
 */
function getOrExtractCells(mesh: THREE.SkinnedMesh, worldScale: number): ExtractedVoxels | null {
    const geometry = mesh.geometry;
    const cached = extractionCache.get(geometry.uuid);
    if (cached !== undefined) {
        // Refresh LRU recency.
        extractionCache.delete(geometry.uuid);
        extractionCache.set(geometry.uuid, cached);
        return cached;
    }

    const result = extractCells(geometry, worldScale);
    if (extractionCache.size >= EXTRACTION_CACHE_MAX) {
        const oldest = extractionCache.keys().next().value;
        if (oldest !== undefined) extractionCache.delete(oldest);
    }
    extractionCache.set(geometry.uuid, result);
    return result;
}

function extractCells(geometry: THREE.BufferGeometry, worldScale: number): ExtractedVoxels | null {
    const position = geometry.getAttribute('position');
    const color = geometry.getAttribute('color');
    const skinIndex = geometry.getAttribute('skinIndex');
    const skinWeight = geometry.getAttribute('skinWeight');
    if (!position || !color || !skinIndex || !skinWeight) return null;

    const index = geometry.getIndex();
    const triangleCount = Math.floor((index ? index.count : position.count) / 3);
    if (triangleCount < 4) return null;
    const vertexAt = (tri: number, corner: number): number =>
        index ? index.getX(tri * 3 + corner) : tri * 3 + corner;
    const readPosition = (vertIndex: number, target: THREE.Vector3): void => {
        target.set(position.getX(vertIndex), position.getY(vertIndex), position.getZ(vertIndex));
    };

    const voxelSize = estimateVoxelSize(readPosition, triangleCount, vertexAt);
    const worldVoxelSize = voxelSize * worldScale;
    if (!Number.isFinite(worldVoxelSize) || worldVoxelSize < MIN_VOXEL_SIZE || worldVoxelSize > MAX_VOXEL_SIZE) return null;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const invSize = 1 / voxelSize;
    const halfSize = voxelSize * 0.5;
    const accumulators = new Map<number, CellAccumulator>();
    const boneTriangles = new Map<number, number[]>();
    const triBoneScratch = new Map<number, number>();
    // One reused tuple rather than a fresh literal per face — the loop below
    // runs once per source triangle and feeds it to two weight passes.
    const triVerts: [number, number, number] = [0, 0, 0];

    for (let tri = 0; tri < triangleCount; tri++) {
        const v0 = vertexAt(tri, 0);
        const v1 = vertexAt(tri, 1);
        const v2 = vertexAt(tri, 2);
        triVerts[0] = v0; triVerts[1] = v1; triVerts[2] = v2;
        readPosition(v0, a);
        readPosition(v1, b);
        readPosition(v2, c);

        edge1.subVectors(b, a);
        edge2.subVectors(c, a);
        normal.crossVectors(edge1, edge2);
        const normalLen = normal.length();
        if (normalLen < 1e-12) continue; // degenerate face
        normal.divideScalar(normalLen);

        // Slice the GLB per bone: file this triangle under the bone carrying the
        // most summed weight across its three vertices.
        triBoneScratch.clear();
        accumulateBoneWeights(skinIndex, skinWeight, triVerts, triBoneScratch);
        getOrCreateList(boneTriangles, dominantBone(triBoneScratch)).push(tri);

        // Face centroid pushed half a voxel inward = the cube's center.
        const cx = (a.x + b.x + c.x) / 3 - normal.x * halfSize;
        const cy = (a.y + b.y + c.y) / 3 - normal.y * halfSize;
        const cz = (a.z + b.z + c.z) / 3 - normal.z * halfSize;
        const ix = Math.floor(cx * invSize);
        const iy = Math.floor(cy * invSize);
        const iz = Math.floor(cz * invSize);
        const key = packCellKey(ix, iy, iz);

        let acc = accumulators.get(key);
        if (!acc) {
            acc = { ix, iy, iz, sx: 0, sy: 0, sz: 0, sr: 0, sg: 0, sb: 0, samples: 0, boneWeights: new Map() };
            accumulators.set(key, acc);
        }
        acc.sx += cx; acc.sy += cy; acc.sz += cz;
        acc.sr += (color.getX(v0) + color.getX(v1) + color.getX(v2)) / 3;
        acc.sg += (color.getY(v0) + color.getY(v1) + color.getY(v2)) / 3;
        acc.sb += (color.getZ(v0) + color.getZ(v1) + color.getZ(v2)) / 3;
        acc.samples++;
        accumulateBoneWeights(skinIndex, skinWeight, triVerts, acc.boneWeights);
    }

    const cells = finalizeCells(accumulators);
    if (cells.length === 0) return null;

    const boneCells = new Map<number, ShatterCell[]>();
    for (const cell of cells) {
        getOrCreateList(boneCells, cell.boneIndex).push(cell);
    }
    return { voxelSize, cells, boneCells, boneTriangles };
}

/**
 * Keep exactly `budget` cells, evenly strided. Cell order follows triangle
 * scan order (spatially local), so the kept voxels stay spread across the
 * whole body/limb rather than truncating one region. Voxels keep their
 * NATIVE size — thinning, never merging, preserves the character's own
 * voxel look and colors.
 */
function strideSample(cells: ShatterCell[], budget: number): ShatterCell[] {
    if (cells.length <= budget) return cells;
    const total = cells.length;
    return cells.filter((_, i) =>
        Math.floor(((i + 1) * budget) / total) > Math.floor((i * budget) / total));
}

// ── Limb geometry ──────────────────────────────────────────────────────

// House material for merged vertex-colored voxel geometry:
// FrontSide + dual-winding faces, because the WebGPU
// backend doesn't honour material.side and DoubleSide would z-fight with the
// back-winding copy. flatShading derives face normals on both backends, so
// the geometry carries no normal attribute.
let limbMaterial: THREE.MeshLambertMaterial | null = null;
function getLimbMaterial(): THREE.MeshLambertMaterial {
    if (!limbMaterial) {
        limbMaterial = new THREE.MeshLambertMaterial({
            vertexColors: true,
            side: THREE.FrontSide,
            flatShading: true,
        });
    }
    return limbMaterial;
}

/**
 * Skin every vertex of the mesh to the current (death) pose and return the
 * world positions as a flat [x,y,z,…] array indexed by vertex. Computed once
 * per death; the per-limb geometry just reads + frame-localizes these.
 */


// ── Limb grouping ──────────────────────────────────────────────────────

type LimbKey = 'head' | 'torso' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

const LIMB_NAME_PATTERNS: ReadonlyArray<readonly [LimbKey, ReadonlyArray<string>]> = [
    ['head', ['head', 'neck']],
    ['leftArm', ['leftarm', 'leftforearm', 'lefthand']],
    ['rightArm', ['rightarm', 'rightforearm', 'righthand']],
    ['leftLeg', ['leftupleg', 'leftleg', 'leftfoot', 'lefttoe']],
    ['rightLeg', ['rightupleg', 'rightleg', 'rightfoot', 'righttoe']],
];

/**
 * Classic six-piece dismemberment split, keyed off the canonical Mixamo
 * names (mixamorig / mixamorig2 prefixes both match via substring; finger
 * bones contain "Hand" so they ride with their arm). Hips, spine chain,
 * shoulders/clavicles and anything unrecognized fall to the torso.
 */
function limbKeyForBoneName(name: string): LimbKey {
    const lower = name.toLowerCase();
    for (const [key, patterns] of LIMB_NAME_PATTERNS) {
        if (patterns.some((pattern) => lower.includes(pattern))) return key;
    }
    return 'torso';
}

/**
 * Every SkinnedMesh with a skeleton under `root`, with world matrices brought
 * up to date first — both entry points need the current (death) pose.
 */
function collectSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
    root.updateMatrixWorld(true);
    const found: THREE.SkinnedMesh[] = [];
    root.traverse((obj) => {
        const mesh = obj as THREE.SkinnedMesh;
        if (mesh.isSkinnedMesh && mesh.skeleton) found.push(mesh);
    });
    return found;
}

// ── Shatter ────────────────────────────────────────────────────────────

const _boneMatrix = new THREE.Matrix4();
const _skinMatrix = new THREE.Matrix4();
const _pieceQuat = new THREE.Quaternion();
const _decomposedPos = new THREE.Vector3();
const _decomposedScale = new THREE.Vector3();
const _bonePos = new THREE.Vector3();
const _charCenter = new THREE.Vector3();
const _flingVel = new THREE.Vector3();
const _cellPos = new THREE.Vector3();
const _scatter = new THREE.Vector3();
const _bodyPos = new THREE.Vector3();
const _bodyQuat = new THREE.Quaternion();
const _linvel = new THREE.Vector3();
const _angvel = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _voxelVel = new THREE.Vector3();
const _lever = new THREE.Vector3();
const _splashQuat = new THREE.Quaternion();

/**
 * Build the bind-space → world skinning matrix for one bone (dominant-bone,
 * weight 1): meshWorld · bindMatrixInverse · boneWorld · boneInverse ·
 * bindMatrix. Writes into `_boneMatrix`.
 */
function buildBoneMatrix(mesh: THREE.SkinnedMesh, bone: THREE.Bone, boneInverse: THREE.Matrix4): void {
    _boneMatrix.copy(mesh.bindMatrix);
    _boneMatrix.premultiply(_skinMatrix.multiplyMatrices(bone.matrixWorld, boneInverse));
    _boneMatrix.premultiply(mesh.bindMatrixInverse);
    _boneMatrix.premultiply(mesh.matrixWorld);
}

/**
 * Recover the character's visible bind-space → world scale by decomposing the
 * root bone's full skinning matrix. The mesh node's own world scale is
 * unreliable on these rigs (a baked counter-scale the bind matrices cancel),
 * but the skinning chain reproduces the on-screen size, so its decomposed
 * scale is the real one. Rotation-invariant, so the death pose doesn't matter.
 */
function skinningWorldScale(mesh: THREE.SkinnedMesh): number {
    const bone = mesh.skeleton.bones[0]!;
    const boneInverse = mesh.skeleton.boneInverses[0];
    if (!bone || !boneInverse) {
        _decomposedScale.setFromMatrixScale(mesh.matrixWorld);
        return Math.max(_decomposedScale.x, _decomposedScale.y, _decomposedScale.z);
    }
    buildBoneMatrix(mesh, bone, boneInverse);
    _boneMatrix.decompose(_decomposedPos, _pieceQuat, _decomposedScale);
    return Math.max(_decomposedScale.x, _decomposedScale.y, _decomposedScale.z);
}

/**
 * Fling velocity for a piece anchored at `anchorWorldPos`. The HORIZONTAL
 * component points outward from the body's vertical axis; the VERTICAL
 * component is always a strong upward kick. Radiating in 3D from the body
 * center would fling low pieces (legs) straight DOWN into the ground — the
 * cause of the "ground explodes" look — so the up kick guarantees every
 * piece arcs up and off the ground before it falls and bursts. Writes into
 * `_flingVel`.
 */
function computeFlingVelocity(
    anchorWorldPos: THREE.Vector3,
    options: BoneVoxelShatterOptions,
    killerDirection?: THREE.Vector3,
): void {
    let dx = anchorWorldPos.x - _charCenter.x;
    let dz = anchorWorldPos.z - _charCenter.z;
    const horizSq = dx * dx + dz * dz;
    if (horizSq < 1e-4) {
        // Near the vertical axis (torso/head): pick a random horizontal dir.
        const ang = Math.random() * Math.PI * 2;
        dx = Math.cos(ang);
        dz = Math.sin(ang);
    } else {
        const invLen = 1 / Math.sqrt(horizSq);
        dx *= invLen;
        dz *= invLen;
    }
    const speed = options.boneSpeedMin + Math.random() * (options.boneSpeedMax - options.boneSpeedMin);
    _flingVel.set(dx * speed, 0, dz * speed);
    if (killerDirection && killerDirection.lengthSq() > 0) {
        _scatter.copy(killerDirection);
        _scatter.y = 0;
        if (_scatter.lengthSq() > 1e-6) {
            _flingVel.addScaledVector(_scatter.normalize(), speed * 0.6);
        }
    }
    // Upward kick (a multiple of the horizontal speed) so pieces arc up.
    _flingVel.y = speed * options.upwardBias;
}

/**
 * Spawn one loose voxel cube into the shared debris registry. Mirrors the
 * VoxelObject.explodeAtOctreeV2 recipe; `__type: 'debris'` opts into
 * PhysicsWorld's tight debris velocity cap (these cubes spawn embedded in
 * the corpse or burst against walls).
 */
function spawnVoxelDebris(
    physicsWorld: PhysicsWorld,
    debrisParent: THREE.Object3D,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
    velocity: THREE.Vector3,
    maxAngularSpeed: number,
    spawnSize: number,
    r: number, g: number, b: number,
): void {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setAngvel({
            x: (Math.random() - 0.5) * 2 * maxAngularSpeed,
            y: (Math.random() - 0.5) * 2 * maxAngularSpeed,
            z: (Math.random() - 0.5) * 2 * maxAngularSpeed,
        })
        .setLinearDamping(0.5)
        .setAngularDamping(0.8)
        .setCcdEnabled(true);
    const body = physicsWorld.createRigidBody(bodyDesc);
    const halfExtent = spawnSize * 0.5;
    const colliderDesc = RAPIER.ColliderDesc.cuboid(halfExtent, halfExtent, halfExtent)
        .setCollisionGroups(DEBRIS_COLLISION_GROUPS)
        .setFriction(0.5)
        .setRestitution(0.6)
        .setDensity(DEBRIS_DENSITY);
    const collider = physicsWorld.createCollider(colliderDesc, body);

    physicsWorld.setUserData(body, {
        __type: 'debris',
        createdAt: performance.now(),
        blockType: 1,
        isVoxelDebris: true,
        density: DEBRIS_DENSITY,
        debrisSize: spawnSize,
        color: { r, g, b },
    });

    voxelObjectDebris.spawnVoxel(body, collider, physicsWorld, r, g, b, spawnSize, debrisParent);
}

/**
 * One-time cosmetic "splash" of small coloured voxels (e.g. red gore) sprayed
 * from `center` as the body parts separate. These fly out and up, then arc,
 * fall and despawn on the debris registry's own TTL. They do not collide with
 * the limb chunks (plain DEBRIS groups), so they read as a spray over the
 * separating parts rather than affecting them.
 */
function spawnSplash(
    physicsWorld: PhysicsWorld,
    debrisParent: THREE.Object3D,
    center: THREE.Vector3,
    spawnSize: number,
    options: BoneVoxelShatterOptions,
): void {
    const c = options.splashColor;
    for (let i = 0; i < options.splashCount; i++) {
        _cellPos.copy(center);
        _cellPos.x += (Math.random() - 0.5) * 0.5;
        _cellPos.y += (Math.random() - 0.5) * 0.9;
        _cellPos.z += (Math.random() - 0.5) * 0.5;
        // Random direction with a strong upward bias, sprayed at 1.5–4 m/s.
        _voxelVel.set(Math.random() - 0.5, Math.random() * 0.7 + 0.3, Math.random() - 0.5)
            .normalize()
            .multiplyScalar(1.5 + Math.random() * 2.5);
        spawnVoxelDebris(
            physicsWorld, debrisParent,
            _cellPos, _splashQuat, _voxelVel,
            options.maxAngularSpeed, spawnSize,
            c.r, c.g, c.b,
        );
    }
}

/**
 * Burst a frame-local voxel payload ([x,y,z,r,g,b] per voxel) at a world
 * transform. Per-voxel velocity = linvel + ω×(p − pivot) + random scatter,
 * capped at MAX_INHERITED_SPEED.
 */
function burstVoxelPayload(
    physicsWorld: PhysicsWorld,
    debrisParent: THREE.Object3D,
    voxels: Float32Array,
    originPos: THREE.Vector3,
    originQuat: THREE.Quaternion,
    linvel: THREE.Vector3,
    angvel: THREE.Vector3,
    pivot: THREE.Vector3,
    voxelScatterSpeed: number,
    maxAngularSpeed: number,
    spawnSize: number,
): void {
    for (let i = 0; i < voxels.length; i += 6) {
        _cellPos.set(voxels[i]!, voxels[i + 1]!, voxels[i + 2]!)
            .applyQuaternion(originQuat)
            .add(originPos);
        // Momentum-following spray: velocity at the voxel's point = piece
        // velocity + ω×r about the piece's center of mass.
        _lever.copy(_cellPos).sub(pivot);
        _voxelVel.copy(_lever).cross(angvel).multiplyScalar(-1).add(linvel);
        _scatter.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
            .normalize()
            .multiplyScalar(voxelScatterSpeed * Math.random());
        _voxelVel.add(_scatter);
        if (_voxelVel.length() > MAX_INHERITED_SPEED) _voxelVel.setLength(MAX_INHERITED_SPEED);

        spawnVoxelDebris(
            physicsWorld, debrisParent,
            _cellPos, originQuat, _voxelVel,
            maxAngularSpeed, spawnSize,
            voxels[i + 3]!, voxels[i + 4]!, voxels[i + 5]!,
        );
    }
}

// ── Limb piece registry ────────────────────────────────────────────────

// ── Limb templates + pooled pieces ─────────────────────────────────────
//
// Jani, 2026-09-05: "In a game where the most important job of the enemies
// is dying, we shouldn't spend any time at all on it." A kill used to skin the
// death pose on the CPU and bake six limb geometries from it — ~15 ms after
// the flat-math rewrite, ~100 ms before. Now a limb piece is baked ONCE per
// character asset, in its anchor bone's frame, where it is pose-independent:
// for a vertex owned by the anchor bone, the death-pose position is exactly
// `frame(anchor) · (scale · v)`, so the template is the raw bind geometry at
// world scale and the death pose only decides the frame. A kill is then six
// bone-frame decompositions and six pooled bodies re-enabled at those frames.
// (Vertices weighted to a limb's OTHER bones ride the anchor rigidly — a bent
// forearm straightens at the instant it detaches, which nobody sees.)

/** One limb of one character asset, baked once, shared by every clone and every kill. */
interface LimbTemplate {
    key: LimbKey;
    anchorBoneIndex: number;
    /** Anchor-bone frame, world scale. Never disposed while a pooled piece references it. */
    geometry: THREE.BufferGeometry;
    center: THREE.Vector3;
    halfX: number;
    halfY: number;
    halfZ: number;
    /** Stage-2 payload: [x, y, z, r, g, b] per cell, same frame. */
    voxels: Float32Array;
}

/** Templates per `geometry.uuid @ spawnSize` — a clone family at one world scale. */
const limbTemplateCache = new Map<string, LimbTemplate[]>();
const LIMB_TEMPLATE_CACHE_MAX = EXTRACTION_CACHE_MAX;

function limbTemplateKey(mesh: THREE.SkinnedMesh, spawnSize: number): string {
    return `${mesh.geometry.uuid}@${spawnSize}`;
}

/** Templates for `mesh`, baked on first request. Null when the mesh has no vertex colours. */
function getOrBakeLimbTemplates(
    mesh: THREE.SkinnedMesh,
    extracted: ExtractedVoxels,
    spawnSize: number,
    cellBudget: number,
): LimbTemplate[] | null {
    const key = limbTemplateKey(mesh, spawnSize);
    const cached = limbTemplateCache.get(key);
    if (cached) {
        limbTemplateCache.delete(key);
        limbTemplateCache.set(key, cached);
        return cached;
    }
    const baked = bakeLimbTemplates(mesh, extracted, spawnSize, cellBudget);
    if (!baked) return null;
    if (limbTemplateCache.size >= LIMB_TEMPLATE_CACHE_MAX) {
        const oldest = limbTemplateCache.keys().next().value;
        if (oldest !== undefined) evictLimbTemplates(oldest);
    }
    limbTemplateCache.set(key, baked);
    return baked;
}

function evictLimbTemplates(key: string): void {
    const templates = limbTemplateCache.get(key);
    limbTemplateCache.delete(key);
    if (!templates) return;
    for (const template of templates) {
        limbPiecePool.purgeTemplate(template);
        template.geometry.dispose();
    }
}

/**
 * Bake every limb of `mesh` in bind pose: the limb's source triangles (real
 * positions × world scale, real vertex colours, both windings so the cut face
 * is not hollow) and its stage-2 cells, all in the anchor bone's frame.
 */
function bakeLimbTemplates(
    mesh: THREE.SkinnedMesh,
    extracted: ExtractedVoxels,
    spawnSize: number,
    cellBudget: number,
): LimbTemplate[] | null {
    const skeleton = mesh.skeleton;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const color = geometry.getAttribute('color');
    const index = geometry.getIndex();
    if (!color) return null;
    const scale = skinningWorldScale(mesh);

    const limbBones = new Map<LimbKey, number[]>();
    const allBones = new Set<number>([...extracted.boneTriangles.keys(), ...extracted.boneCells.keys()]);
    for (const boneIndex of allBones) {
        const bone = skeleton.bones[boneIndex];
        if (!bone || !skeleton.boneInverses[boneIndex]) continue;
        getOrCreateList(limbBones, limbKeyForBoneName(bone.name)).push(boneIndex);
    }
    if (limbBones.size === 0) return null;

    const templates: LimbTemplate[] = [];
    for (const [key, boneIndices] of limbBones) {
        let anchorIndex = boneIndices[0]!;
        let anchorTris = -1;
        const triangles: number[] = [];
        const limbCells: ShatterCell[] = [];
        for (const boneIndex of boneIndices) {
            const triList = extracted.boneTriangles.get(boneIndex);
            if (triList) {
                for (const tri of triList) triangles.push(tri);
                if (triList.length > anchorTris) { anchorTris = triList.length; anchorIndex = boneIndex; }
            }
            const cells = extracted.boneCells.get(boneIndex);
            if (cells) limbCells.push(...cells);
        }
        if (triangles.length === 0) continue;

        const triCount = triangles.length;
        const positions = new Float32Array(triCount * 9);
        const colors = new Float32Array(triCount * 9);
        const indices = new Uint32Array(triCount * 6);
        let vp = 0, ii = 0, base = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const tri of triangles) {
            for (let corner = 0; corner < 3; corner++) {
                const vi = index ? index.getX(tri * 3 + corner) : tri * 3 + corner;
                const x = position.getX(vi) * scale, y = position.getY(vi) * scale, z = position.getZ(vi) * scale;
                positions[vp] = x; positions[vp + 1] = y; positions[vp + 2] = z;
                colors[vp] = color.getX(vi); colors[vp + 1] = color.getY(vi); colors[vp + 2] = color.getZ(vi);
                vp += 3;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            indices[ii++] = base; indices[ii++] = base + 1; indices[ii++] = base + 2;
            indices[ii++] = base; indices[ii++] = base + 2; indices[ii++] = base + 1;
            base += 3;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geo.setIndex(new THREE.BufferAttribute(indices, 1));
        const center = new THREE.Vector3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
        const halfVoxel = spawnSize * 0.5;
        const halfX = Math.max(halfVoxel, (maxX - minX) * 0.5);
        const halfY = Math.max(halfVoxel, (maxY - minY) * 0.5);
        const halfZ = Math.max(halfVoxel, (maxZ - minZ) * 0.5);
        geo.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
        geo.boundingSphere = new THREE.Sphere(center.clone(), Math.hypot(halfX, halfY, halfZ));

        const limbBudget = Math.max(MIN_CELL_BUDGET, Math.round((cellBudget * limbCells.length) / Math.max(1, extracted.cells.length)));
        const payloadCells = strideSample(limbCells, limbBudget);
        const voxels = new Float32Array(payloadCells.length * 6);
        let w = 0;
        for (const cell of payloadCells) {
            voxels[w++] = cell.x * scale; voxels[w++] = cell.y * scale; voxels[w++] = cell.z * scale;
            voxels[w++] = cell.r; voxels[w++] = cell.g; voxels[w++] = cell.b;
        }
        templates.push({ key, anchorBoneIndex: anchorIndex, geometry: geo, center, halfX, halfY, halfZ, voxels });
    }
    return templates.length > 0 ? templates : null;
}

/** The scene + physics half of a limb piece, kept between kills. */
interface PooledPiece {
    template: LimbTemplate;
    physicsWorld: PhysicsWorld;
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    group: THREE.Group;
    mesh: THREE.Mesh;
}

/**
 * Free limb pieces by template. A released piece keeps its body (disabled),
 * collider, mesh and group; the next kill of the same species re-enables it
 * at the new frame. Creation only happens when the pool is empty.
 */
class LimbPiecePool {
    private readonly free = new Map<LimbTemplate, PooledPiece[]>();
    /** Pieces created because the pool was empty — how many ever had to be built. */
    created = 0;

    acquire(template: LimbTemplate, physicsWorld: PhysicsWorld, debrisParent: THREE.Object3D): PooledPiece {
        const list = this.free.get(template);
        let piece = list?.pop();
        while (piece && piece.physicsWorld !== physicsWorld) {
            // A piece from a previous level's world — its body went with it.
            if (piece.body.isValid()) piece.physicsWorld.removeRigidBody(piece.body);
            piece = list?.pop();
        }
        if (!piece) {
            piece = this.create(template, physicsWorld);
            this.created++;
        }
        piece.body.setEnabled(true);
        piece.group.visible = true;
        debrisParent.add(piece.group);
        return piece;
    }

    release(piece: PooledPiece): void {
        if (piece.body.isValid()) {
            piece.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
            piece.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
            piece.body.setEnabled(false);
        }
        if (piece.group.parent) piece.group.parent.remove(piece.group);
        getOrCreateList(this.free, piece.template).push(piece);
    }

    /** Level reset: bodies of that world are removed with it; forget them. */
    purgeWorld(physicsWorld: PhysicsWorld): void {
        for (const [template, list] of this.free) {
            for (const p of list) if (p.physicsWorld === physicsWorld && p.body.isValid()) physicsWorld.removeRigidBody(p.body);
            const kept = list.filter((p) => p.physicsWorld !== physicsWorld);
            if (kept.length > 0) this.free.set(template, kept); else this.free.delete(template);
        }
    }

    /** A template is being evicted: its pieces reference its geometry, so drop them. */
    purgeTemplate(template: LimbTemplate): void {
        const list = this.free.get(template);
        this.free.delete(template);
        if (!list) return;
        for (const p of list) if (p.body.isValid()) p.physicsWorld.removeRigidBody(p.body);
    }

    /** Free pieces waiting for a kill (tests). */
    get freeCount(): number {
        let n = 0;
        for (const list of this.free.values()) n += list.length;
        return n;
    }

    private create(template: LimbTemplate, physicsWorld: PhysicsWorld): PooledPiece {
        const mesh = new THREE.Mesh(template.geometry, getLimbMaterial());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const group = new THREE.Group();
        group.add(mesh);
        const body = physicsWorld.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic()
                .setLinearDamping(0.5)
                .setAngularDamping(0.8)
                .setCcdEnabled(true),
        );
        const collider = physicsWorld.createCollider(
            RAPIER.ColliderDesc.cuboid(template.halfX, template.halfY, template.halfZ)
                .setTranslation(template.center.x, template.center.y, template.center.z)
                .setCollisionGroups(LIMB_COLLISION_GROUPS)
                .setFriction(0.5)
                .setRestitution(0.4)
                .setDensity(DEBRIS_DENSITY)
                .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
            body,
        );
        return { template, physicsWorld, body, collider, group, mesh };
    }
}

export const limbPiecePool = new LimbPiecePool();

/** Two-stage: rigid limb pieces now (pooled, pre-baked), loose voxels on each piece's impact. */
function shatterMeshIntoLimbs(
    mesh: THREE.SkinnedMesh,
    extracted: ExtractedVoxels,
    spawnSize: number,
    cellBudget: number,
    physicsWorld: PhysicsWorld,
    debrisParent: THREE.Object3D,
    options: BoneVoxelShatterOptions,
    killerDirection?: THREE.Vector3,
): number {
    const templates = getOrBakeLimbTemplates(mesh, extracted, spawnSize, cellBudget);
    if (!templates) return 0;
    const skeleton = mesh.skeleton;

    // Cosmetic splash of red voxels sprayed from the body as the parts split.
    // `_charCenter` was set by computeCharCenter just before this call.
    if (options.splashCount > 0) {
        spawnSplash(physicsWorld, debrisParent, _charCenter, spawnSize, options);
    }

    let piecesSpawned = 0;
    for (const template of templates) {
        const anchorBone = skeleton.bones[template.anchorBoneIndex];
        const boneInverse = skeleton.boneInverses[template.anchorBoneIndex];
        if (!anchorBone || !boneInverse) continue;
        // The death pose decides only the frame: where the anchor bone is now.
        buildBoneMatrix(mesh, anchorBone, boneInverse);
        _boneMatrix.decompose(_decomposedPos, _pieceQuat, _decomposedScale);

        anchorBone.getWorldPosition(_bonePos);
        computeFlingVelocity(_bonePos, options, killerDirection);
        _scatter.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
            .normalize()
            .multiplyScalar(options.boneSpeedMin + Math.random() * (options.boneSpeedMax - options.boneSpeedMin));
        _flingVel.add(_scatter);

        const pooled = limbPiecePool.acquire(template, physicsWorld, debrisParent);
        pooled.group.position.copy(_decomposedPos);
        pooled.group.quaternion.copy(_pieceQuat);
        const body = pooled.body;
        body.setTranslation({ x: _decomposedPos.x, y: _decomposedPos.y, z: _decomposedPos.z }, true);
        body.setRotation({ x: _pieceQuat.x, y: _pieceQuat.y, z: _pieceQuat.z, w: _pieceQuat.w }, true);
        body.setLinvel({ x: _flingVel.x, y: _flingVel.y, z: _flingVel.z }, true);
        body.setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 }, true);
        body.wakeUp();
        physicsWorld.setUserData(body, {
            __type: 'debris',
            createdAt: performance.now(),
            isLimbPiece: true,
            debrisSize: spawnSize,
        });

        boneVoxelLimbs.register({
            pooled,
            body,
            collider: pooled.collider,
            physicsWorld,
            group: pooled.group,
            mesh: pooled.mesh,
            debrisParent,
            voxels: template.voxels,
            spawnSize,
            voxelScatterSpeed: options.voxelScatterSpeed,
            maxAngularSpeed: options.maxAngularSpeed,
            burstEnabled: options.limbBurst,
            impactGraceSec: options.limbImpactGraceSec,
            maxLifetimeSec: options.limbMaxLifetimeSec,
            ageSec: 0,
            pendingContact: false,
            graceChecked: false,
            burst: false,
            onCollision: () => undefined, // installed by register()
        });
        piecesSpawned++;
    }
    return piecesSpawned;
}

interface LimbPiece {
    pooled: PooledPiece;
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    physicsWorld: PhysicsWorld;
    group: THREE.Group;
    /** The piece's mesh — shares its template's geometry, never disposed here. */
    mesh: THREE.Mesh;
    debrisParent: THREE.Object3D;
    /** Frame-local [x,y,z, r,g,b] per stage-2 voxel */
    voxels: Float32Array;
    spawnSize: number;
    voxelScatterSpeed: number;
    maxAngularSpeed: number;
    /** When false the piece never bursts — it stays a solid chunk. */
    burstEnabled: boolean;
    impactGraceSec: number;
    maxLifetimeSec: number;
    ageSec: number;
    /** A contact arrived during the grace window (Rapier contact events are
     *  edge-triggered — remember it and re-check when the grace expires). */
    pendingContact: boolean;
    graceChecked: boolean;
    burst: boolean;
    onCollision: (contact: ContactInfo) => void;
}

/**
 * Self-managed registry for in-flight limb pieces. Deliberately NOT
 * `voxelObjectDebris.spawnChunk` — that path is VoxelObject-specific and its
 * stuck-chunk jitter-split would dismember pieces that grind against
 * geometry. Ticked from GameEngine next to `voxelObjectDebris.update`.
 */
class BoneVoxelLimbsImpl {
    private pieces = new Set<LimbPiece>();

    register(piece: LimbPiece): void {
        // Mass-death cap: retire the oldest live piece early rather than let
        // piece bodies accumulate without bound (burst it if bursting is on,
        // else just drop it).
        while (this.pieces.size >= MAX_ACTIVE_PIECES) {
            const oldest = this.pieces.values().next().value;
            if (!oldest) break;
            if (oldest.burstEnabled) this.burstPiece(oldest);
            else this.discard(oldest);
        }
        this.pieces.add(piece);
        if (!piece.burstEnabled) return; // chunk stays solid; no contact burst
        piece.onCollision = (contact: ContactInfo) => {
            if (piece.burst) return;
            // Limbs bounce off each other but only BURST on a world hit
            // (ground / wall / prop) — never from limb-vs-limb contact.
            if (this.isLimbContact(piece, contact)) return;
            if (piece.ageSec < piece.impactGraceSec) {
                piece.pendingContact = true;
                return;
            }
            this.burstPiece(piece);
        };
        piece.physicsWorld.registerCollisionCallback(piece.body, piece.onCollision);
    }

    /** True when the other body in the contact is another limb piece. */
    private isLimbContact(piece: LimbPiece, contact: ContactInfo): boolean {
        const other = contact.bodyA === piece.body ? contact.bodyB : contact.bodyA;
        const data = piece.physicsWorld.getUserData(other) as { isLimbPiece?: boolean } | null;
        return data?.isLimbPiece === true;
    }

    /** `deltaTime` is the simulated delta in seconds (same value as physics). */
    update(deltaTime: number): void {
        if (this.pieces.size === 0) return;
        for (const piece of this.pieces) {
            if (piece.burst) continue;
            if (!piece.body.isValid()) {
                this.discard(piece);
                continue;
            }
            piece.ageSec += deltaTime;

            const t = piece.body.translation();
            if (t.y < FALL_OFF_Y) {
                this.discard(piece);
                continue;
            }
            piece.group.position.set(t.x, t.y, t.z);
            const q = piece.body.rotation();
            piece.group.quaternion.set(q.x, q.y, q.z, q.w);

            if (piece.ageSec < piece.impactGraceSec) {
                // Penetration-recovery ejection brake: a piece that spawned
                // slightly overlapping geometry can be kicked far faster than
                // any fling speed. Clamp until the grace ends.
                const lv = piece.body.linvel();
                const speedSq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
                if (speedSq > GRACE_MAX_SPEED * GRACE_MAX_SPEED) {
                    const k = GRACE_MAX_SPEED / Math.sqrt(speedSq);
                    piece.body.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true);
                }
                continue;
            }

            // Bursting disabled: leave the chunk to fall, bounce and settle.
            if (!piece.burstEnabled) continue;

            // Grace just expired: a contact consumed during the grace never
            // re-fires (edge-triggered events), so if the piece is still
            // touching something, burst it now — this is its landing.
            if (!piece.graceChecked) {
                piece.graceChecked = true;
                if (piece.pendingContact && this.isTouchingWorld(piece)) {
                    this.burstPiece(piece);
                    continue;
                }
                piece.pendingContact = false;
            }

            if (piece.ageSec >= piece.maxLifetimeSec) {
                this.burstPiece(piece);
            }
        }
    }

    /** Drop every piece whose body lives in `physicsWorld` (level reset). */
    clearForWorld(physicsWorld: PhysicsWorld): void {
        for (const piece of this.pieces) {
            if (piece.physicsWorld === physicsWorld) this.discard(piece);
        }
        limbPiecePool.purgeWorld(physicsWorld);
    }

    /** Narrow-phase check: is the piece currently touching the WORLD (not just
     *  another limb piece)? Limb-vs-limb contacts are ignored so resting
     *  against a sibling limb doesn't count as a landing. */
    private isTouchingWorld(piece: LimbPiece): boolean {
        const world = piece.physicsWorld.getRapierWorld();
        let touching = false;
        world.contactPairsWith(piece.collider, (other) => {
            if (touching) return;
            const otherBody = other.parent();
            if (otherBody) {
                const data = piece.physicsWorld.getUserData(otherBody) as { isLimbPiece?: boolean } | null;
                if (data?.isLimbPiece) return; // ignore limb-vs-limb
            }
            world.contactPair(piece.collider, other, (manifold) => {
                if (manifold.numContacts() > 0) touching = true;
            });
        });
        return touching;
    }

    /** Stage 2: replace the rigid piece with its loose voxels. */
    private burstPiece(piece: LimbPiece): void {
        if (piece.burst) return;

        const t = piece.body.translation();
        const q = piece.body.rotation();
        const lv = piece.body.linvel();
        const av = piece.body.angvel();
        const com = piece.body.worldCom();
        _bodyPos.set(t.x, t.y, t.z);
        _bodyQuat.set(q.x, q.y, q.z, q.w);
        _linvel.set(lv.x, lv.y, lv.z);
        if (_linvel.length() > MAX_INHERITED_SPEED) _linvel.setLength(MAX_INHERITED_SPEED);
        _angvel.set(av.x, av.y, av.z);
        _pivot.set(com.x, com.y, com.z);

        // discard() first so the voxel spawns can't re-enter via callbacks.
        this.discard(piece);
        burstVoxelPayload(
            piece.physicsWorld, piece.debrisParent, piece.voxels,
            _bodyPos, _bodyQuat, _linvel, _angvel, _pivot,
            piece.voxelScatterSpeed, piece.maxAngularSpeed, piece.spawnSize,
        );
    }

    /** Retire a piece without spawning voxels: body, mesh and group go back to the pool. */
    private discard(piece: LimbPiece): void {
        this.pieces.delete(piece);
        piece.burst = true;
        piece.physicsWorld.unregisterCollisionCallback(piece.body, piece.onCollision);
        limbPiecePool.release(piece.pooled);
    }
}

/**
 * Module singleton, mirroring `voxelObjectDebris`: GameEngine ticks
 * `update(deltaTime)` each frame; `VoxelDebrisManager.clearForWorld` clears
 * it on level reset.
 */
export const boneVoxelLimbs = new BoneVoxelLimbsImpl();

// ── Entry point ────────────────────────────────────────────────────────

/** Geometries `prewarmSkinnedVoxelShatter` has already handled this session. */
const prewarmedGeometries = new WeakSet<THREE.BufferGeometry>();

/**
 * Warm the extraction cache (voxel cells + per-bone triangle lists) for a
 * character so the first death doesn't pay the parse (tens of ms on detailed
 * rigs). Call it when a body is about to matter — NpcController calls it on
 * the first hit, not at spawn, so a crowd that is never fought never parses.
 * The per-limb chunk geometry is pose-specific and cannot be pre-built.
 */
export function prewarmSkinnedVoxelShatter(root: THREE.Object3D): void {
    for (const mesh of collectSkinnedMeshes(root)) {
        // Once per GEOMETRY, not per character: a crowd of clones shares its
        // template's geometry, and with more body types than the extraction
        // LRU holds (14 looks vs EXTRACTION_CACHE_MAX), warming every spawn
        // re-parsed a body the cache had just evicted — ~16 ms per NPC, 8 s
        // across a 500-strong crowd. A type evicted before its first death
        // pays the parse then, exactly as an unwarmed one would.
        if (prewarmedGeometries.has(mesh.geometry)) continue;
        prewarmedGeometries.add(mesh.geometry);
        const worldScale = skinningWorldScale(mesh);
        const extracted = getOrExtractCells(mesh, worldScale);
        // The limb templates too — a kill then builds nothing (see LimbTemplate).
        if (extracted) {
            const spawnSize = Number((extracted.voxelSize * worldScale).toPrecision(4));
            getOrBakeLimbTemplates(mesh, extracted, spawnSize, Math.max(MIN_CELL_BUDGET, DEFAULT_BONE_VOXEL_SHATTER.maxDebris));
        }
    }
}

/**
 * Shatter every voxelized SkinnedMesh under `root` at its current pose.
 * Two-stage by default: rigid limb pieces fly off, each bursting into its
 * native voxels on first impact. Returns false when nothing could be
 * shattered (no skinned meshes, or none with voxel geometry) so the caller
 * can fall back to another death effect. Does not remove `root` from the
 * scene — that stays the caller's job.
 */
export function shatterSkinnedVoxelCharacter(
    root: THREE.Object3D,
    physicsWorld: PhysicsWorld,
    debrisParent: THREE.Object3D,
    options: BoneVoxelShatterOptions,
    killerDirection?: THREE.Vector3,
): boolean {
    const found = collectSkinnedMeshes(root);
    if (found.length === 0) return false;

    // De-duplicate identical skinned meshes. Some rigs ship (or the engine's
    // skinned clone produces) the same body geometry twice; shattering both
    // would make two of every limb. Meshes with the same vertex count and
    // bind-space bounding sphere are the same body — keep one. Genuinely
    // different meshes (a separate visor, eyes, accessory) differ in the
    // fingerprint and are all kept.
    const meshes: THREE.SkinnedMesh[] = [];
    const seen = new Set<string>();
    for (const mesh of found) {
        const geom = mesh.geometry;
        if (!geom.boundingSphere) geom.computeBoundingSphere();
        const bs = geom.boundingSphere;
        const vc = geom.getAttribute('position')?.count ?? 0;
        const fp = bs
            ? `${vc}|${bs.radius.toFixed(4)}|${bs.center.x.toFixed(3)},${bs.center.y.toFixed(3)},${bs.center.z.toFixed(3)}`
            : `${vc}|${meshes.length}`;
        if (seen.has(fp)) continue;
        seen.add(fp);
        meshes.push(mesh);
    }

    // Resolve extraction first so the per-character budget is split across
    // the meshes that actually have voxel geometry.
    interface ShatterTarget { mesh: THREE.SkinnedMesh; extracted: ExtractedVoxels; spawnSize: number; }
    const targets: ShatterTarget[] = [];
    for (const mesh of meshes) {
        const worldScale = skinningWorldScale(mesh);
        const extracted = getOrExtractCells(mesh, worldScale);
        if (!extracted) continue;
        // Quantize: the decomposed scale wobbles in its last bits per death
        // pose, and the debris registry keys its instanced pools by the
        // exact float size — ulp noise would mint a new pool per death.
        const spawnSize = Number((extracted.voxelSize * worldScale).toPrecision(4));
        targets.push({ mesh, extracted, spawnSize });
    }
    if (targets.length === 0) return false;

    const cellBudget = Math.max(
        MIN_CELL_BUDGET,
        Math.floor(Math.max(MIN_CELL_BUDGET, options.maxDebris) / targets.length),
    );

    let shattered = 0;
    for (const target of targets) {
        if (computeCharCenter(target.mesh.skeleton, target.extracted.boneCells) === 0) continue;
        if (options.limbs) {
            shattered += shatterMeshIntoLimbs(
                target.mesh, target.extracted, target.spawnSize, cellBudget,
                physicsWorld, debrisParent, options, killerDirection,
            );
        } else {
            shattered += shatterMeshIntoVoxels(
                target.mesh, target.extracted, target.spawnSize, cellBudget,
                physicsWorld, debrisParent, options, killerDirection,
            );
        }
    }
    return shattered > 0;
}

/** Mean world position of the bones that own cells → fling origin. */
function computeCharCenter(skeleton: THREE.Skeleton, boneCells: Map<number, ShatterCell[]>): number {
    _charCenter.set(0, 0, 0);
    let used = 0;
    for (const boneIndex of boneCells.keys()) {
        const bone = skeleton.bones[boneIndex]!;
        if (!bone) continue;
        bone.getWorldPosition(_bonePos);
        _charCenter.add(_bonePos);
        used++;
    }
    if (used > 0) _charCenter.divideScalar(used);
    return used;
}

/** Single-stage: every budgeted voxel becomes loose debris immediately. */
function shatterMeshIntoVoxels(
    mesh: THREE.SkinnedMesh,
    extracted: ExtractedVoxels,
    spawnSize: number,
    cellBudget: number,
    physicsWorld: PhysicsWorld,
    debrisParent: THREE.Object3D,
    options: BoneVoxelShatterOptions,
    killerDirection?: THREE.Vector3,
): number {
    const skeleton = mesh.skeleton;
    const cells = strideSample(extracted.cells, cellBudget);

    let spawned = 0;
    let currentBone = -1;
    for (const cell of cells) {
        const bone = skeleton.bones[cell.boneIndex]!;
        const boneInverse = skeleton.boneInverses[cell.boneIndex];
        if (!bone || !boneInverse) continue;
        // Cells arrive grouped by scan order, not bone — rebuild the bone
        // transform + fling velocity whenever the bone changes.
        if (cell.boneIndex !== currentBone) {
            currentBone = cell.boneIndex;
            buildBoneMatrix(mesh, bone, boneInverse);
            _boneMatrix.decompose(_decomposedPos, _pieceQuat, _decomposedScale);
            bone.getWorldPosition(_bonePos);
            computeFlingVelocity(_bonePos, options, killerDirection);
        }
        _cellPos.set(cell.x, cell.y, cell.z).applyMatrix4(_boneMatrix);
        _scatter.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
            .normalize()
            .multiplyScalar(options.voxelScatterSpeed * Math.random());
        _voxelVel.copy(_flingVel).add(_scatter);
        spawnVoxelDebris(
            physicsWorld, debrisParent,
            _cellPos, _pieceQuat, _voxelVel,
            options.maxAngularSpeed, spawnSize,
            cell.r, cell.g, cell.b,
        );
        spawned++;
    }
    return spawned;
}


