import * as THREE from 'three';
import { FACE_TEMPLATES } from 'engine/VoxelGeometry.js';
import type { AnimalBlockConfig } from 'engine/animal/BlockAnimalBodyBuilder.js';

/**
 * Block Animal Voxel Detailer
 *
 * Turns a part's coarse block config (the proven AI authoring surface) into a
 * voxel-art mesh: many small voxels with seeded per-voxel color jitter,
 * rounded silhouettes and parameterized surface patterns — all generated
 * deterministically by the ENGINE. The AI never authors voxel data; it only
 * sets the style knobs in `AnimalDetailConfig`.
 *
 * Lessons inherited from the deleted voxelized-character system (aba69ee8):
 * - AI-authored voxel-level shape data was unpredictable → engine-derived only.
 * - Unbounded voxel counts exploded vertex budgets → hard face budgets with
 *   automatic voxel-size clamping (see resolveAnimalVoxelSize).
 * - WebGPU back-face-culled flat parts → both-windings index emission
 *   (12 indices per face) so faces render from both sides at the GEOMETRY
 *   level, independent of material.side.
 *
 * One merged BufferGeometry per animal PART (parts rotate independently in the
 * animation rig), shared across animals via a refcounted cache — a herd from
 * spawnMany or a tentacle ring reuses the same geometry.
 */

// ─── Agent-facing config ────────────────────────────────────────────

/** Body-part categories a pattern can target. */
export type AnimalDetailPartKind = 'body' | 'head' | 'tail' | 'leg' | 'wing' | 'fin' | 'tentacle';

/** Surface pattern presets, computed in part-local space so they wrap blocks seamlessly. */
export interface AnimalPatternConfig {
    /**
     * 'spots'   — jittered lattice of round spots (dalmatian, deer fawn)
     * 'stripes' — vertical bands across the body length with phase wobble (zebra, tiger)
     * 'patches' — chunky two-tone noise patches (cow, calico)
     * 'belly'   — lower-body gradient to a second color with a dithered edge
     * 'scales'  — brick-banded shading, alternate bricks tinted (fish, reptiles)
     */
    type: 'spots' | 'stripes' | 'patches' | 'belly' | 'scales';
    /** Pattern color (hex). */
    color: number;
    /** Feature size in meters (spot diameter, stripe width, brick size). Default per type. */
    scale?: number;
    /** Which parts get the pattern. Defaults: 'belly' → body/head/tail; others → all parts. */
    parts?: AnimalDetailPartKind[];
}

/**
 * Optional voxel-detail style for a block animal. Set on
 * `BlockAnimalBodyConfig.detail`. All knobs optional — defaults give a subtle
 * fur-noise + slightly rounded look.
 */
export interface AnimalDetailConfig {
    /** Voxel edge length in meters, or 'auto' (default) to derive from body size. Clamped to budgets either way. */
    voxelSize?: 'auto' | number;
    /** Per-voxel color variation 0–1 (default 0.08). 0 = flat colors. */
    colorJitter?: number;
    /** Silhouette rounding 0–1 (default 0.4). 0 = hard boxes, 1 = strongly rounded corners. */
    roundness?: number;
    /** Optional surface pattern preset. */
    pattern?: AnimalPatternConfig;
    /** Seed for all deterministic noise (default 1). Same config + seed = identical animal. */
    seed?: number;
}

/** Fully-resolved detail settings (required fields per engine options convention). */
export interface ResolvedAnimalDetail {
    voxelSize: 'auto' | number;
    colorJitter: number;
    roundness: number;
    pattern: AnimalPatternConfig | null;
    seed: number;
}

export const DEFAULT_ANIMAL_DETAIL: ResolvedAnimalDetail = {
    voxelSize: 'auto',
    colorJitter: 0.08,
    roundness: 0.4,
    pattern: null,
    seed: 1,
};

export function resolveAnimalDetail(config: AnimalDetailConfig): ResolvedAnimalDetail {
    return {
        voxelSize: config.voxelSize ?? DEFAULT_ANIMAL_DETAIL.voxelSize,
        colorJitter: THREE.MathUtils.clamp(config.colorJitter ?? DEFAULT_ANIMAL_DETAIL.colorJitter, 0, 1),
        roundness: THREE.MathUtils.clamp(config.roundness ?? DEFAULT_ANIMAL_DETAIL.roundness, 0, 1),
        pattern: config.pattern ?? DEFAULT_ANIMAL_DETAIL.pattern,
        seed: config.seed ?? DEFAULT_ANIMAL_DETAIL.seed,
    };
}

// ─── Budgets ────────────────────────────────────────────────────────

/** Max exposed faces per part before the voxel size is coarsened. */
const PART_FACE_BUDGET = 4000;
/** Max predicted faces per animal before the voxel size is coarsened. */
const ANIMAL_FACE_BUDGET = 12000;
/** Hard cap on grid cells per axis (memory guard for degenerate configs). */
const MAX_GRID_AXIS = 64;
/** Smallest voxel the system will ever emit (meters). */
const MIN_VOXEL_SIZE = 0.02;

/** Total exterior surface area of a block list (m²) — the face-count predictor. */
function totalBlockSurfaceArea(blocks: ReadonlyArray<AnimalBlockConfig>): number {
    let area = 0;
    for (const block of blocks) {
        const { width: w, height: h, depth: d } = block.size;
        area += 2 * (w * h + w * d + h * d);
    }
    return area;
}

/**
 * Resolve the animal-wide voxel size from the body dimensions, the authored
 * preference, and the total face budget. Deterministic single-pass clamp —
 * no iteration.
 *
 * @param bodyLargestDim - largest body bounds dimension (meters)
 * @param allBlocks      - every block that will be voxelized (all parts), for the face predictor
 */
export function resolveAnimalVoxelSize(
    detail: ResolvedAnimalDetail,
    bodyLargestDim: number,
    allBlocks: ReadonlyArray<AnimalBlockConfig>
): number {
    const dim = Math.max(bodyLargestDim, 0.1);
    let vs = detail.voxelSize === 'auto'
        ? Math.max(dim / 24, MIN_VOXEL_SIZE)
        : THREE.MathUtils.clamp(detail.voxelSize, dim / 40, dim / 8);
    vs = Math.max(vs, MIN_VOXEL_SIZE);

    // Predicted exposed faces ≈ total surface area / voxel-face area
    const predicted = totalBlockSurfaceArea(allBlocks) / (vs * vs);
    if (predicted > ANIMAL_FACE_BUDGET) {
        vs *= Math.sqrt(predicted / ANIMAL_FACE_BUDGET);
    }
    return vs;
}

// ─── Deterministic hash noise ───────────────────────────────────────

/** Integer hash → [0, 1). Deterministic across platforms (Math.imul, no float trig). */
function hash3(x: number, y: number, z: number, seed: number): number {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 974711);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// ─── Voxelization ───────────────────────────────────────────────────

interface VoxelGrid {
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    voxelSize: number;
    /** Part-local position of the grid's (0,0,0) cell corner. */
    originX: number;
    originY: number;
    originZ: number;
    /** 24-bit color per cell, -1 = empty. */
    cells: Int32Array;
}

const DEG2RAD = Math.PI / 180;

/** Per-block sampling data precomputed once. */
interface BlockSampler {
    block: AnimalBlockConfig;
    /** Inverse rotation (world→block local), null when unrotated. */
    inverse: THREE.Matrix4 | null;
    px: number;
    py: number;
    pz: number;
}

function createBlockSampler(block: AnimalBlockConfig): BlockSampler {
    let inverse: THREE.Matrix4 | null = null;
    if (block.rotation && ((block.rotation.x ?? 0) !== 0 || (block.rotation.y ?? 0) !== 0 || (block.rotation.z ?? 0) !== 0)) {
        const euler = new THREE.Euler(
            (block.rotation.x ?? 0) * DEG2RAD,
            (block.rotation.y ?? 0) * DEG2RAD,
            (block.rotation.z ?? 0) * DEG2RAD
        );
        inverse = new THREE.Matrix4().makeRotationFromEuler(euler).invert();
    }
    return {
        block,
        inverse,
        px: block.position.x ?? 0,
        py: block.position.y,
        pz: block.position.z ?? 0,
    };
}

/**
 * Is the part-local point inside the block? Applies the superellipsoid
 * rounding carve for boxes when enabled (silhouette-only by construction —
 * overlapping block unions keep interiors filled).
 */
function pointInBlock(sampler: BlockSampler, x: number, y: number, z: number, roundExponent: number | null, voxelSize: number): boolean {
    const local = new THREE.Vector3(x - sampler.px, y - sampler.py, z - sampler.pz);
    if (sampler.inverse) local.applyMatrix4(sampler.inverse);

    const { width: w, height: h, depth: d } = sampler.block.size;
    const hw = w / 2, hh = h / 2, hd = d / 2;
    if (Math.abs(local.x) > hw || Math.abs(local.y) > hh || Math.abs(local.z) > hd) return false;

    if (sampler.block.shape === 'wedge') {
        // Full height at −Z tapering to zero at +Z (matches createWedgeGeometry)
        return local.y <= hh - h * ((local.z + hd) / d);
    }

    // Rounding: superellipsoid carve, skipped for blocks under 3 voxels across
    // (tiny detail blocks would vanish entirely)
    if (roundExponent !== null && w >= voxelSize * 3 && h >= voxelSize * 3 && d >= voxelSize * 3) {
        const nx = Math.abs(local.x) / hw;
        const ny = Math.abs(local.y) / hh;
        const nz = Math.abs(local.z) / hd;
        return Math.pow(nx, roundExponent) + Math.pow(ny, roundExponent) + Math.pow(nz, roundExponent) <= 1;
    }
    return true;
}

/** Part-local AABB of a block including rotation (rotated corner sweep). */
function expandBlockBounds(block: AnimalBlockConfig, min: THREE.Vector3, max: THREE.Vector3): void {
    const sampler = createBlockSampler(block);
    const hw = block.size.width / 2, hh = block.size.height / 2, hd = block.size.depth / 2;
    const rotation = sampler.inverse ? sampler.inverse.clone().invert() : null;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
        corner.set((i & 1) ? hw : -hw, (i & 2) ? hh : -hh, (i & 4) ? hd : -hd);
        if (rotation) corner.applyMatrix4(rotation);
        corner.x += sampler.px;
        corner.y += sampler.py;
        corner.z += sampler.pz;
        min.min(corner);
        max.max(corner);
    }
}

/**
 * Voxelize a part's blocks into a color grid. Blocks fill IN CONFIG ORDER with
 * later blocks overwriting — the same layering semantics the box renderer's
 * z-fight offsets give today, so thin AI-authored marking slabs become
 * one-voxel surface recolors.
 */
function voxelizePart(blocks: ReadonlyArray<AnimalBlockConfig>, voxelSize: number, roundness: number): VoxelGrid {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const block of blocks) expandBlockBounds(block, min, max);

    // Grid extents, capped per axis (coarsen instead of overflow)
    let vs = voxelSize;
    const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
    if (extent / vs > MAX_GRID_AXIS) vs = extent / MAX_GRID_AXIS;

    const sizeX = Math.max(1, Math.ceil((max.x - min.x) / vs));
    const sizeY = Math.max(1, Math.ceil((max.y - min.y) / vs));
    const sizeZ = Math.max(1, Math.ceil((max.z - min.z) / vs));
    const grid: VoxelGrid = {
        sizeX, sizeY, sizeZ,
        voxelSize: vs,
        originX: min.x,
        originY: min.y,
        originZ: min.z,
        cells: new Int32Array(sizeX * sizeY * sizeZ).fill(-1),
    };

    const roundExponent = roundness > 0 ? 2 + (1 - roundness) * 10 : null;

    for (const block of blocks) {
        const sampler = createBlockSampler(block);
        const blockMin = new THREE.Vector3(Infinity, Infinity, Infinity);
        const blockMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        expandBlockBounds(block, blockMin, blockMax);

        const x0 = Math.max(0, Math.floor((blockMin.x - min.x) / vs));
        const y0 = Math.max(0, Math.floor((blockMin.y - min.y) / vs));
        const z0 = Math.max(0, Math.floor((blockMin.z - min.z) / vs));
        const x1 = Math.min(sizeX - 1, Math.ceil((blockMax.x - min.x) / vs));
        const y1 = Math.min(sizeY - 1, Math.ceil((blockMax.y - min.y) / vs));
        const z1 = Math.min(sizeZ - 1, Math.ceil((blockMax.z - min.z) / vs));

        let filledAny = false;
        for (let z = z0; z <= z1; z++) {
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const cx = min.x + (x + 0.5) * vs;
                    const cy = min.y + (y + 0.5) * vs;
                    const cz = min.z + (z + 0.5) * vs;
                    if (pointInBlock(sampler, cx, cy, cz, roundExponent, vs)) {
                        grid.cells[x + y * sizeX + z * sizeX * sizeY] = block.color;
                        filledAny = true;
                    }
                }
            }
        }

        // A block thinner than the voxel grid can miss every cell center —
        // force-fill its center voxel so authored details never vanish.
        if (!filledAny) {
            const x = THREE.MathUtils.clamp(Math.floor((sampler.px - min.x) / vs), 0, sizeX - 1);
            const y = THREE.MathUtils.clamp(Math.floor((sampler.py - min.y) / vs), 0, sizeY - 1);
            const z = THREE.MathUtils.clamp(Math.floor((sampler.pz - min.z) / vs), 0, sizeZ - 1);
            grid.cells[x + y * sizeX + z * sizeX * sizeY] = block.color;
        }
    }

    return grid;
}

// ─── Patterns & jitter ──────────────────────────────────────────────

const DEFAULT_PATTERN_SCALE: Record<AnimalPatternConfig['type'], number> = {
    spots: 0.12,
    stripes: 0.1,
    patches: 0.18,
    belly: 0.0, // unused — belly works on the part-height gradient
    scales: 0.06,
};

const DEFAULT_BELLY_PARTS: ReadonlyArray<AnimalDetailPartKind> = ['body', 'head', 'tail'];

function patternAppliesTo(pattern: AnimalPatternConfig, partKind: AnimalDetailPartKind): boolean {
    if (pattern.parts) return pattern.parts.includes(partKind);
    if (pattern.type === 'belly') return DEFAULT_BELLY_PARTS.includes(partKind);
    return true;
}

/** Chunky 2-octave lattice noise (no interpolation — blocky patches suit voxel art). */
function chunkyNoise(x: number, y: number, z: number, scale: number, seed: number): number {
    const c = 1 / scale;
    const n1 = hash3(Math.floor(x * c), Math.floor(y * c), Math.floor(z * c), seed);
    const n2 = hash3(Math.floor(x * c * 2), Math.floor(y * c * 2), Math.floor(z * c * 2), seed + 7);
    return n1 * 0.65 + n2 * 0.35;
}

/**
 * Resolve the final color of one voxel: base block color → pattern recolor →
 * quantized jitter. Pure function of part-local position + config + seed.
 */
function resolveVoxelColor(
    baseColor: number,
    px: number, py: number, pz: number,
    partKind: AnimalDetailPartKind,
    partMinY: number, partHeight: number,
    detail: ResolvedAnimalDetail
): number {
    let r = (baseColor >> 16) & 0xFF;
    let g = (baseColor >> 8) & 0xFF;
    let b = baseColor & 0xFF;

    const pattern = detail.pattern;
    if (pattern && patternAppliesTo(pattern, partKind)) {
        const scale = pattern.scale ?? DEFAULT_PATTERN_SCALE[pattern.type];
        const pr = (pattern.color >> 16) & 0xFF;
        const pg = (pattern.color >> 8) & 0xFF;
        const pb = pattern.color & 0xFF;
        const seed = detail.seed;

        switch (pattern.type) {
            case 'spots': {
                // Jittered lattice: ~45% of cells carry a spot at a hashed offset
                const cx = Math.floor(px / scale), cy = Math.floor(py / scale), cz = Math.floor(pz / scale);
                if (hash3(cx, cy, cz, seed) < 0.45) {
                    const ox = (hash3(cx, cy, cz, seed + 1) - 0.5) * scale * 0.4;
                    const oy = (hash3(cx, cy, cz, seed + 2) - 0.5) * scale * 0.4;
                    const oz = (hash3(cx, cy, cz, seed + 3) - 0.5) * scale * 0.4;
                    const dx = px - (cx + 0.5) * scale - ox;
                    const dy = py - (cy + 0.5) * scale - oy;
                    const dz = pz - (cz + 0.5) * scale - oz;
                    if (dx * dx + dy * dy + dz * dz < (scale * 0.38) ** 2) {
                        r = pr; g = pg; b = pb;
                    }
                }
                break;
            }
            case 'stripes': {
                // Bands along the body length (Z) with a per-height phase wobble
                const wobble = (hash3(Math.floor(py / scale), 0, 0, seed) - 0.5) * scale * 0.6;
                if (Math.floor((pz + wobble) / scale) % 2 === 0) {
                    r = pr; g = pg; b = pb;
                }
                break;
            }
            case 'patches': {
                if (chunkyNoise(px, py, pz, scale, seed) > 0.55) {
                    r = pr; g = pg; b = pb;
                }
                break;
            }
            case 'belly': {
                // Lower-body gradient with a dithered edge band
                const t = partHeight > 0 ? (py - partMinY) / partHeight : 0;
                const dither = (hash3(Math.round(px * 97), Math.round(py * 97), Math.round(pz * 97), seed) - 0.5) * 0.1;
                if (t < 0.35 + dither) {
                    r = pr; g = pg; b = pb;
                }
                break;
            }
            case 'scales': {
                // Brick rows offset by half a cell; alternate bricks tint toward the pattern color
                const row = Math.floor(py / scale);
                const col = Math.floor((pz + (row % 2 === 0 ? 0 : scale * 0.5)) / scale);
                if ((row + col) % 2 === 0) {
                    r = r * 0.65 + pr * 0.35;
                    g = g * 0.65 + pg * 0.35;
                    b = b * 0.65 + pb * 0.35;
                }
                break;
            }
        }
    }

    // Per-voxel jitter, quantized to 4 levels for the chunky voxel-art look
    if (detail.colorJitter > 0) {
        const q = Math.floor(hash3(Math.round(px * 211), Math.round(py * 211), Math.round(pz * 211), detail.seed + 13) * 4) / 3;
        const factor = 1 + (q - 0.5) * 2 * detail.colorJitter;
        r *= factor; g *= factor; b *= factor;
    }

    return (THREE.MathUtils.clamp(Math.round(r), 0, 255) << 16)
        | (THREE.MathUtils.clamp(Math.round(g), 0, 255) << 8)
        | THREE.MathUtils.clamp(Math.round(b), 0, 255);
}

// ─── Mesher ─────────────────────────────────────────────────────────

// Face normals & neighbor offsets, order: -Z, +Z, -X, +X, -Y, +Y
// (matches FACE_TEMPLATES groups in VoxelGeometry.ts)
const FACE_NORMALS = [0, 0, -1, 0, 0, 1, -1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1, 0];
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0],
];

function cellAt(grid: VoxelGrid, x: number, y: number, z: number): number {
    if (x < 0 || x >= grid.sizeX || y < 0 || y >= grid.sizeY || z < 0 || z >= grid.sizeZ) return -1;
    return grid.cells[x + y * grid.sizeX + z * grid.sizeX * grid.sizeY] ?? -1;
}

/**
 * Build the merged part geometry: exposed faces only, vertex colors, and BOTH
 * triangle windings per face (12 indices) so flat parts can never be
 * back-face culled on any renderer backend (the WebGPU lesson from the
 * deleted character builder). Positions are in part-local space — the mesh
 * drops straight into the named part group.
 */
function buildPartGeometry(
    grid: VoxelGrid,
    partKind: AnimalDetailPartKind,
    detail: ResolvedAnimalDetail
): THREE.BufferGeometry {
    // Pass 1: count exposed faces
    let faceCount = 0;
    for (let z = 0; z < grid.sizeZ; z++) {
        for (let y = 0; y < grid.sizeY; y++) {
            for (let x = 0; x < grid.sizeX; x++) {
                if (cellAt(grid, x, y, z) < 0) continue;
                for (let f = 0; f < 6; f++) {
                    const off = NEIGHBOR_OFFSETS[f]!;
                    if (cellAt(grid, x + off[0], y + off[1], z + off[2]) < 0) faceCount++;
                }
            }
        }
    }

    const positions = new Float32Array(faceCount * 12);
    const colors = new Float32Array(faceCount * 12);
    const normals = new Float32Array(faceCount * 12);
    const indices = faceCount * 4 > 65535 ? new Uint32Array(faceCount * 12) : new Uint16Array(faceCount * 12);

    const vs = grid.voxelSize;
    const partMinY = grid.originY;
    const partHeight = grid.sizeY * vs;

    let fi = 0;
    for (let z = 0; z < grid.sizeZ; z++) {
        for (let y = 0; y < grid.sizeY; y++) {
            for (let x = 0; x < grid.sizeX; x++) {
                const baseColor = cellAt(grid, x, y, z);
                if (baseColor < 0) continue;

                const cx = grid.originX + (x + 0.5) * vs;
                const cy = grid.originY + (y + 0.5) * vs;
                const cz = grid.originZ + (z + 0.5) * vs;
                let resolvedColor = -1; // lazily resolved once per voxel

                for (let f = 0; f < 6; f++) {
                    const off = NEIGHBOR_OFFSETS[f]!;
                    if (cellAt(grid, x + off[0], y + off[1], z + off[2]) >= 0) continue;

                    if (resolvedColor < 0) {
                        resolvedColor = resolveVoxelColor(baseColor, cx, cy, cz, partKind, partMinY, partHeight, detail);
                    }
                    const r = ((resolvedColor >> 16) & 0xFF) / 255;
                    const g = ((resolvedColor >> 8) & 0xFF) / 255;
                    const b = (resolvedColor & 0xFF) / 255;

                    const bp = fi * 12;
                    for (let v = 0; v < 4; v++) {
                        const tmpl = FACE_TEMPLATES[f * 4 + v]!;
                        const pi = bp + v * 3;
                        positions[pi] = cx + (tmpl[0] ?? 0) * vs;
                        positions[pi + 1] = cy + (tmpl[1] ?? 0) * vs;
                        positions[pi + 2] = cz + (tmpl[2] ?? 0) * vs;
                        colors[pi] = r;
                        colors[pi + 1] = g;
                        colors[pi + 2] = b;
                        normals[pi] = FACE_NORMALS[f * 3]!;
                        normals[pi + 1] = FACE_NORMALS[f * 3 + 1]!;
                        normals[pi + 2] = FACE_NORMALS[f * 3 + 2]!;
                    }

                    // Both windings: front + back triangles per quad
                    const fv = fi * 4;
                    const bi = fi * 12;
                    indices[bi] = fv; indices[bi + 1] = fv + 2; indices[bi + 2] = fv + 1;
                    indices[bi + 3] = fv; indices[bi + 4] = fv + 3; indices[bi + 5] = fv + 2;
                    indices[bi + 6] = fv; indices[bi + 7] = fv + 1; indices[bi + 8] = fv + 2;
                    indices[bi + 9] = fv; indices[bi + 10] = fv + 2; indices[bi + 11] = fv + 3;
                    fi++;
                }
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return geometry;
}

// ─── Geometry cache ─────────────────────────────────────────────────

interface CacheEntry {
    geometry: THREE.BufferGeometry;
    refs: number;
}

const geometryCache = new Map<string, CacheEntry>();
const CACHE_CAP = 256;

/** FNV-1a over a stable string description of the part + style. */
function cacheKey(
    partKind: AnimalDetailPartKind,
    blocks: ReadonlyArray<AnimalBlockConfig>,
    detail: ResolvedAnimalDetail,
    voxelSize: number
): string {
    const parts: (string | number)[] = [partKind, voxelSize.toFixed(5), detail.colorJitter, detail.roundness, detail.seed];
    if (detail.pattern) {
        parts.push(detail.pattern.type, detail.pattern.color, detail.pattern.scale ?? -1, (detail.pattern.parts ?? []).join('|'));
    }
    for (const block of blocks) {
        parts.push(
            Math.round((block.position.x ?? 0) * 1e4), Math.round(block.position.y * 1e4), Math.round((block.position.z ?? 0) * 1e4),
            Math.round(block.size.width * 1e4), Math.round(block.size.height * 1e4), Math.round(block.size.depth * 1e4),
            block.color, block.shape ?? 'box',
            Math.round((block.rotation?.x ?? 0) * 100), Math.round((block.rotation?.y ?? 0) * 100), Math.round((block.rotation?.z ?? 0) * 100),
        );
    }
    const s = parts.join(',');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + ':' + s.length;
}

function evictIfNeeded(): void {
    if (geometryCache.size <= CACHE_CAP) return;
    for (const [key, entry] of geometryCache) {
        if (entry.refs <= 0) {
            entry.geometry.dispose();
            geometryCache.delete(key);
            if (geometryCache.size <= CACHE_CAP) return;
        }
    }
}

/** Test hook: drop every cached geometry (does not dispose live refs). */
export function clearAnimalDetailGeometryCache(): void {
    for (const entry of geometryCache.values()) {
        if (entry.refs <= 0) entry.geometry.dispose();
    }
    geometryCache.clear();
}

/** Current number of cached geometries (test/diagnostic hook). */
export function getAnimalDetailGeometryCacheSize(): number {
    return geometryCache.size;
}

// ─── Public mesh builder ────────────────────────────────────────────

/**
 * Marker + release hook stored on detailed meshes. Dispose paths must NOT
 * dispose these geometries directly — call `releaseSharedGeometry()` instead
 * (refcounted; the cache disposes at zero refs on eviction).
 */
export const SHARED_DETAIL_GEOMETRY_FLAG = 'sharedDetailGeometry';

/**
 * Build (or fetch from cache) the voxel-detail mesh for one animal part.
 * Returns a mesh positioned in part-local space; add it to the named part
 * group exactly where the per-block box meshes used to go.
 */
export function buildDetailedPartMesh(
    partKind: AnimalDetailPartKind,
    blocks: ReadonlyArray<AnimalBlockConfig>,
    detail: ResolvedAnimalDetail,
    animalVoxelSize: number
): THREE.Mesh {
    // Per-part budget: coarsen the voxel size when this part alone would
    // exceed its face budget (e.g. one giant body among small legs).
    let vs = animalVoxelSize;
    const predicted = totalBlockSurfaceArea(blocks) / (vs * vs);
    if (predicted > PART_FACE_BUDGET) {
        vs *= Math.sqrt(predicted / PART_FACE_BUDGET);
    }

    const key = cacheKey(partKind, blocks, detail, vs);
    let entry = geometryCache.get(key);
    if (!entry) {
        const grid = voxelizePart(blocks, vs, detail.roundness);
        entry = { geometry: buildPartGeometry(grid, partKind, detail), refs: 0 };
        geometryCache.set(key, entry);
        evictIfNeeded();
    }
    entry.refs++;

    // FrontSide is correct: the geometry carries BOTH windings (see mesher),
    // so faces render from both sides at the geometry level on every backend.
    const material = new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.FrontSide,
        flatShading: true,
    });
    const mesh = new THREE.Mesh(entry.geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `DetailedPart_${partKind}`;
    mesh.userData[SHARED_DETAIL_GEOMETRY_FLAG] = true;
    let released = false;
    mesh.userData.releaseSharedGeometry = () => {
        if (released) return;
        released = true;
        const live = geometryCache.get(key);
        if (live && live.geometry === mesh.geometry) {
            live.refs = Math.max(0, live.refs - 1);
        }
    };
    return mesh;
}
