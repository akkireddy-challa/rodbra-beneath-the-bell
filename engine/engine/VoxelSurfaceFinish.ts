/**
 * Voxel surface finish — how a voxel mesh responds to light, independent of
 * its geometry.
 *
 * A voxel mesh has exactly six distinct face normals (±X, ±Y, ±Z). Reflection
 * is a function of the normal and the view vector, so an environment-lit voxel
 * car samples the env map in only six directions: the whole hood returns one
 * flat colour, the whole flank another. It reads as "shiny", never as paint —
 * paint reads as paint because the highlight *rolls* across a panel as the
 * surface normal turns.
 *
 * `smoothShadingNormals` fixes that without touching a single vertex position.
 * It replaces the per-face normal with one averaged over a small world-space
 * neighbourhood, so the shading normal follows the shape the voxels are
 * approximating while the silhouette, the stair-steps and the hard voxel edges
 * all survive exactly as authored. `strength` is the knob: 0 is the stock
 * faceted look, 1 is "curved surface wearing a blocky silhouette".
 *
 * `createVoxelFinishMaterial` then supplies the material that can actually show
 * it. `MeshLambertMaterial` (the historical voxel material) is pure diffuse —
 * no specular lobe, and three.js does not route `scene.environment` to it — so
 * it cannot render car paint no matter how good the normals are. The 'paint'
 * finish is a `MeshPhysicalMaterial` whose two lobes (a broad tinted metallic
 * lobe plus a tight white clearcoat lobe) are what the eye reads as automotive
 * paint rather than shiny plastic.
 *
 * Both are opt-in. Defaults reproduce the previous look byte for byte.
 */

import * as THREE from 'three';
import type { VehicleFinishMode } from 'types/game.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';

/** How a voxel surface responds to light. */
export type VoxelSurfaceFinish = 'matte' | 'paint';

/** Stock faceted voxel look — unchanged from before this module existed. */
export const DEFAULT_SURFACE_FINISH: VoxelSurfaceFinish = 'matte';

/** Shading-normal blend, 0 = stock per-face normals. */
export const DEFAULT_SHADING_SMOOTHNESS = 0;

/**
 * Neighbourhood radius for the smoothing pass, in voxel lengths.
 *
 * Roughly "how many voxels of stair-stepping count as one curve". Below ~1.5
 * the average barely leaves the originating face; above ~4 a car's roof and
 * floor start informing each other through the body and detail washes out.
 */
export const DEFAULT_SHADING_SMOOTH_RADIUS_VOXELS = 2.5;

/**
 * Normals whose dot product falls below this never contribute to each other.
 *
 * Perpendicular faces (dot 0) MUST average together — a 45° staircase of +Y
 * and +X faces is exactly the curvature the pass exists to recover. Opposing
 * faces (dot −1) must not: the top and underside of a thin car roof are within
 * a voxel or two of each other and would cancel to nothing. −0.5 keeps
 * everything out to a 120° crease and rejects the fold-back.
 */
const SMOOTHING_DOT_FLOOR = -0.5;

/** Above this vertex count the O(V·neighbours) pass is refused rather than run. */
const MAX_SMOOTHED_VERTICES = 400_000;

/** Cap on the acceleration grid; oversized objects get coarser cells instead. */
const MAX_GRID_CELLS = 1 << 20;

/** Tunables for the 'paint' finish. */
export interface VoxelPaintParams {
    /**
     * Metallic fraction. Real automotive paint is a dielectric base carrying
     * metallic flake, and sits between the two: 0 gives a solid non-metallic
     * colour, 1 a chrome-like tint with no diffuse term at all.
     */
    metalness: number;
    /** Base-coat roughness — the broad, colour-tinted lobe. */
    roughness: number;
    /** Clearcoat strength; 1 is a full lacquer layer. */
    clearcoat: number;
    /** Clearcoat roughness — the tight white lobe. Keep low; this is the gloss. */
    clearcoatRoughness: number;
    /** Multiplier on the reflected environment. */
    envMapIntensity: number;
    /**
     * Where the gloss comes from.
     *
     * 'environment' — `MeshPhysicalMaterial`: clearcoat plus real reflections of
     *   `scene.environment`. Physically the richer answer, but it also picks up
     *   DIFFUSE image-based light that the flat Lambert material never received,
     *   and that light is largely achromatic. Measured on a kart against an open
     *   sky it lifts luminance 1.26x and cuts saturation to 0.34x — the car stops
     *   matching the world around it. `envMapIntensity` cannot claw this back:
     *   it only scales a material's OWN envMap, never `scene.environment`.
     *
     * 'direct' — `MeshPhongMaterial`: a specular lobe driven by the scene's real
     *   lights only. three.js routes `scene.environment` exclusively to
     *   Standard/Physical, so choosing Phong IS the per-material opt-out from
     *   IBL. Same diffuse response as the flat look, so colours stay put, and
     *   the sun's highlight still rolls across a panel because the shading
     *   normals do that work — not the reflection.
     */
    glossModel: 'direct' | 'environment';
    /** Specular strength for the 'direct' gloss model (Phong `shininess`). */
    directShininess: number;
    /** Specular colour intensity for 'direct', 0…1. */
    directSpecular: number;
    /**
     * Multiplier on the base colour (texture or vertex colours), 0…1.
     *
     * The flat material is Lambert, which receives NO image-based light. Paint
     * is Physical, which does — so the same albedo comes out lighter and, under
     * a blue sky, cooler. Without compensation a car stops matching the world
     * it was authored against. This scales the albedo back down by roughly the
     * irradiance the flat material never got, so the paint sits in the same
     * tonal range as everything around it while keeping its highlight.
     *
     * Note this is NOT `exposure`: it touches the vehicle material only and
     * leaves the rest of the scene exactly as it was.
     */
    albedoScale: number;
}

/**
 * Deliberately a NON-metallic base under a strong clearcoat: gloss without
 * giving up the albedo.
 *
 * Metallic flake is what real paint does, but metalness replaces diffuse with
 * a tinted environment reflection — under an open daylight sky that means the body
 * takes the sky's colour and a yellow kart turns pale blue-grey. Games here
 * pick saturated primaries and expect to see them, so the default keeps
 * metalness at 0 and a modest envMapIntensity; the highlight comes almost
 * entirely from the clearcoat lobe. Raise `metalness` per-vehicle for a candy
 * finish when the scene's environment is dark enough to carry it.
 */
export const DEFAULT_PAINT_PARAMS: VoxelPaintParams = {
    glossModel: 'direct',
    directShininess: 45,
    directSpecular: 0.55,
    metalness: 0.0,
    roughness: 0.45,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    envMapIntensity: 0.45,
    albedoScale: 1.0,
};

/**
 * Shading-normal smoothing used by the 'paint' vehicle finish.
 *
 * High enough that the highlight travels across a body panel, short of 1 so a
 * kart's deliberate detail (grille slats, spoiler edges) doesn't melt.
 */
export const VEHICLE_PAINT_SMOOTHNESS = 0.75;

/**
 * Resolve the finish for a voxel vehicle chassis.
 *
 * `mode` is `renderConfig.vehicleFinish` from world.json — what the AI editor
 * sets via `configure_game(configType="render", vehicleFinish=…)`. Anything
 * other than 'paint' (including undefined) keeps the historical flat look.
 *
 * A `?carpaint=0…1` URL parameter overrides it, for comparing the two looks on
 * one scene without an agent round-trip. Dev affordance only: the game config
 * is the real source, and nothing ships reading the URL.
 *
 * THE LOWER RUNGS SKIP PAINT. The finish costs a shading-normal smoothing pass over
 * every vertex of the chassis, which is HALF the load time of a voxel car:
 * measured at 53.7ms of a 105.6ms load for a 5,537-leaf kart that meshes to
 * 38,168 vertices — and a phone runs that an order of magnitude slower again,
 * per chassis, for every kart on the grid. Cars read fine flat, so this buys
 * back seconds of a mobile level load for a finish nobody looks for at racing
 * speed. The URL override still wins, so paint remains testable on a device — and it is
 * a device FLOOR too, so a player pinning the top rung on a phone still does not pay it.
 */
export function resolveVehicleFinish(mode: VehicleFinishMode | undefined): VoxelFinishOptions | null {
    const url = vehicleFinishUrlOverride();
    if (url !== undefined) return url;
    if (!activeQualityPolicy().deferred.vehiclePaint) return null;
    return mode === 'paint' ? { surface: 'paint', smoothness: VEHICLE_PAINT_SMOOTHNESS } : null;
}

/** Numeric `paint` fields, i.e. everything a query param can carry as a number. */
type PaintNumberKey = Exclude<keyof VoxelPaintParams, 'glossModel'>;

/** `undefined` = no override present; `null` = explicitly forced back to flat. */
function vehicleFinishUrlOverride(): VoxelFinishOptions | null | undefined {
    if (typeof location === 'undefined') return undefined;
    const params = new URLSearchParams(location.search);
    const raw = params.get('carpaint');
    if (raw === null) return undefined;
    const parsed = raw === '' ? 1 : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;

    // `&albedo=` / `&env=` … ride along so the tone can be swept against a real
    // scene without a rebuild per value. An absent or out-of-range param must
    // leave the key OFF the object: `resolveVoxelFinishSettings` spreads it over
    // the defaults, and an explicit `undefined` would erase them.
    const paint: Partial<VoxelPaintParams> = {};
    const readNumber = (key: string, field: PaintNumberKey, accept: (v: number) => boolean): void => {
        const text = params.get(key);
        if (text === null) return;
        const value = Number(text);
        if (Number.isFinite(value) && accept(value)) paint[field] = value;
    };
    readNumber('albedo', 'albedoScale', (v) => v > 0);
    readNumber('env', 'envMapIntensity', (v) => v >= 0);
    readNumber('cc', 'clearcoat', (v) => v >= 0);
    readNumber('shine', 'directShininess', (v) => v > 0);
    readNumber('spec', 'directSpecular', (v) => v >= 0);
    const gloss = params.get('gloss');
    if (gloss === 'direct' || gloss === 'environment') paint.glossModel = gloss;
    return { surface: 'paint', smoothness: Math.min(1, parsed), paint };
}

export interface ShadingNormalOptions {
    /** Vertex positions, xyz triples, in the mesh's local frame. */
    positions: ArrayLike<number>;
    /** Per-face normals, xyz triples. **Mutated in place.** */
    normals: number[] | Float32Array;
    /** Triangle index buffer, used to area-weight each vertex's contribution. */
    indices: ArrayLike<number>;
    /** Neighbourhood radius in world units (voxelSize × radiusInVoxels). */
    radius: number;
    /** Blend toward the smoothed normal, 0…1. */
    strength: number;
    /**
     * One byte per vertex, non-zero where the smoothed normal may be WRITTEN, or
     * null (the default) to write every vertex.
     *
     * Reading is never restricted, and that asymmetry is the point. A gold trim
     * strip needs the wood beside it inside its neighbourhood average, or its
     * normals collapse back to the handful of faces the strip itself has and the
     * highlight steps instead of rolling — which is the artefact the whole pass
     * exists to remove. Only the vertices that are actually going to be shaded
     * smoothly get rewritten.
     *
     * That makes a per-material-class pass affordable: cost scales with the
     * fraction of the mesh that is shiny, not with the mesh. It is also
     * side-effect free, because a voxel mesh's material groups reference disjoint
     * vertex sets — slot is part of the greedy merge key, so a merged rectangle
     * never spans two slots.
     */
    writeMask?: Uint8Array | null;
}

/**
 * Replace per-face normals with neighbourhood-averaged shading normals.
 *
 * Operates on the finished buffers rather than on voxel occupancy, so it works
 * for greedy-merged boxes, the rounded-voxel mesher and anything else that
 * emits positions + normals. Positions and indices are read only; `normals` is
 * rewritten in place.
 *
 * Vertices are duplicated per face by the voxel meshers, so the coincident
 * copies of one corner sit at distance 0 from each other and contribute their
 * own differing face normals at full weight — the weld-and-average behaviour
 * comes out of the radius search for free.
 *
 * Returns false (leaving `normals` untouched) when the mesh is too large or the
 * inputs are degenerate.
 */
export function smoothShadingNormals(options: ShadingNormalOptions): boolean {
    const { positions, normals, indices, radius, strength } = options;
    const writeMask = options.writeMask ?? null;
    const vertexCount = Math.floor(normals.length / 3);

    if (strength <= 0 || radius <= 0 || vertexCount === 0) return false;
    if (positions.length < normals.length) return false;
    // The budget is checked against the WRITE count, which is what the per-vertex
    // neighbourhood scan actually runs for. A masked pass over a large mesh — a
    // gold trim strip on a cathedral — is affordable precisely because the strip
    // is small, and refusing it on the whole mesh's size would refuse the case
    // the mask exists to enable.
    const writeCount = writeMask === null ? vertexCount : countMaskedVertices(writeMask, vertexCount);
    if (writeCount === 0) return false;
    if (writeCount > MAX_SMOOTHED_VERTICES) {
        console.warn(
            `[VoxelSurfaceFinish] ${writeCount} vertices exceeds the ${MAX_SMOOTHED_VERTICES} smoothing budget — keeping per-face normals`,
        );
        return false;
    }

    // Area weights: greedy meshing emits one quad per merged run, so a large
    // flat panel contributes only 4 vertices while a stair-stepped region
    // contributes dozens. Weighting each vertex by the area it carries stops
    // the fine detail from dominating the average of the surface it sits on.
    const weights = accumulateVertexAreas(positions, indices, vertexCount);
    const grid = buildVertexGrid(positions, vertexCount, radius);
    const smoothed = new Float32Array(normals.length);
    const r2 = radius * radius;

    for (let i = 0; i < vertexCount; i++) {
        // Masked-out vertices are skipped as WRITE targets only — they are still
        // visited below as neighbours of the vertices that do get written, which
        // is the whole reason the mask restricts writing rather than reading.
        if (writeMask !== null && writeMask[i] === 0) continue;

        const px = positions[i * 3] ?? 0;
        const py = positions[i * 3 + 1] ?? 0;
        const pz = positions[i * 3 + 2] ?? 0;
        const nx = normals[i * 3] ?? 0;
        const ny = normals[i * 3 + 1] ?? 0;
        const nz = normals[i * 3 + 2] ?? 0;

        let ax = 0, ay = 0, az = 0;

        // The 3×3×3 block of cells around this vertex, clipped to the grid —
        // cell size is at least the radius, so it always covers the search ball.
        const cx = grid.cellX(px), cy = grid.cellY(py), cz = grid.cellZ(pz);
        const x0 = Math.max(0, cx - 1), x1 = Math.min(grid.nx - 1, cx + 1);
        const y0 = Math.max(0, cy - 1), y1 = Math.min(grid.ny - 1, cy + 1);
        const z0 = Math.max(0, cz - 1), z1 = Math.min(grid.nz - 1, cz + 1);

        for (let gx = x0; gx <= x1; gx++) {
            for (let gy = y0; gy <= y1; gy++) {
                for (let gz = z0; gz <= z1; gz++) {
                    const cell = (gz * grid.ny + gy) * grid.nx + gx;
                    const end = grid.cellStart[cell + 1] ?? 0;
                    for (let s = grid.cellStart[cell] ?? 0; s < end; s++) {
                        const j = grid.cellItems[s] ?? 0;
                        const dx = (positions[j * 3] ?? 0) - px;
                        const dy = (positions[j * 3 + 1] ?? 0) - py;
                        const dz = (positions[j * 3 + 2] ?? 0) - pz;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        if (d2 > r2) continue;

                        const jx = normals[j * 3] ?? 0;
                        const jy = normals[j * 3 + 1] ?? 0;
                        const jz = normals[j * 3 + 2] ?? 0;
                        if (nx * jx + ny * jy + nz * jz < SMOOTHING_DOT_FLOOR) continue;

                        // Smooth falloff reaching exactly 0 at the radius, so a
                        // vertex crossing the boundary can't pop the normal.
                        const t = 1 - d2 / r2;
                        const w = t * t * (weights[j] ?? 0);
                        ax += jx * w;
                        ay += jy * w;
                        az += jz * w;
                    }
                }
            }
        }

        // Blend face → smoothed, then renormalise. Either degenerate case — no
        // usable neighbourhood, or a blend that cancels itself out — keeps the
        // face normal.
        let sx = nx, sy = ny, sz = nz;
        const len = Math.hypot(ax, ay, az);
        if (len >= 1e-8) {
            const bx = nx + (ax / len - nx) * strength;
            const by = ny + (ay / len - ny) * strength;
            const bz = nz + (az / len - nz) * strength;
            const blen = Math.hypot(bx, by, bz);
            if (blen >= 1e-8) {
                sx = bx / blen;
                sy = by / blen;
                sz = bz / blen;
            }
        }
        smoothed[i * 3] = sx;
        smoothed[i * 3 + 1] = sy;
        smoothed[i * 3 + 2] = sz;
    }

    // Copied back per vertex rather than as one flat run: `smoothed` is only
    // populated where the mask allowed a write, so a flat copy would zero every
    // face normal the pass deliberately left alone.
    for (let i = 0; i < vertexCount; i++) {
        if (writeMask !== null && writeMask[i] === 0) continue;
        normals[i * 3] = smoothed[i * 3] ?? 0;
        normals[i * 3 + 1] = smoothed[i * 3 + 1] ?? 0;
        normals[i * 3 + 2] = smoothed[i * 3 + 2] ?? 0;
    }
    return true;
}

/**
 * `geometry.userData` key recording that a shading-normal pass has already run on
 * this geometry, and at what strength and radius.
 *
 * Smoothing is not idempotent: averaging already-averaged normals over the same
 * neighbourhood flattens the surface further, so the second pass costs the look
 * as well as the time. Two independent callers can want it on one mesh — a
 * material class during `assembleVoxelMesh`, and the vehicle paint finish
 * afterwards in `applyVoxelFinishToMesh` — and neither can see the other, so the
 * geometry has to say for itself.
 */
export const VOXEL_SHADING_SMOOTHED = 'voxelShadingSmoothed';

/** Record that this geometry's normals have been smoothed. */
export function stampShadingSmoothed(
    geometry: THREE.BufferGeometry,
    strength: number,
    radiusVoxels: number,
): void {
    geometry.userData[VOXEL_SHADING_SMOOTHED] = { strength, radiusVoxels };
}

/** The recorded pass, or null when this geometry's normals are still per-face. */
export function shadingSmoothedStamp(
    geometry: THREE.BufferGeometry,
): { strength: number; radiusVoxels: number } | null {
    const stamp = geometry.userData?.[VOXEL_SHADING_SMOOTHED];
    if (!stamp || typeof stamp !== 'object') return null;
    const { strength, radiusVoxels } = stamp as { strength?: unknown; radiusVoxels?: unknown };
    if (typeof strength !== 'number' || typeof radiusVoxels !== 'number') return null;
    return { strength, radiusVoxels };
}

/** How many vertices the mask allows writing — the pass's real cost driver. */
function countMaskedVertices(mask: Uint8Array, vertexCount: number): number {
    let n = 0;
    const end = Math.min(mask.length, vertexCount);
    for (let i = 0; i < end; i++) {
        if (mask[i] !== 0) n++;
    }
    return n;
}

/** Per-vertex area share, summed from the triangles that reference it. */
function accumulateVertexAreas(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    vertexCount: number,
): Float32Array {
    const weights = new Float32Array(vertexCount);
    for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = indices[t] ?? 0;
        const b = indices[t + 1] ?? 0;
        const c = indices[t + 2] ?? 0;
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;

        const abx = (positions[b * 3] ?? 0) - (positions[a * 3] ?? 0);
        const aby = (positions[b * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
        const abz = (positions[b * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);
        const acx = (positions[c * 3] ?? 0) - (positions[a * 3] ?? 0);
        const acy = (positions[c * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
        const acz = (positions[c * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);

        const area = 0.5 * Math.hypot(
            aby * acz - abz * acy,
            abz * acx - abx * acz,
            abx * acy - aby * acx,
        );
        const share = area / 3;
        weights[a] = (weights[a] ?? 0) + share;
        weights[b] = (weights[b] ?? 0) + share;
        weights[c] = (weights[c] ?? 0) + share;
    }
    // A vertex no triangle references still has to contribute its own normal.
    for (let i = 0; i < vertexCount; i++) if ((weights[i] ?? 0) <= 0) weights[i] = 1e-4;
    return weights;
}

interface VertexGrid {
    nx: number; ny: number; nz: number;
    cellStart: Int32Array;
    cellItems: Int32Array;
    /** Clamped cell coordinate of a world position, per axis. */
    cellX(x: number): number;
    cellY(y: number): number;
    cellZ(z: number): number;
}

/** Uniform-grid bucketing of the vertices, counting-sorted into flat arrays. */
function buildVertexGrid(positions: ArrayLike<number>, vertexCount: number, radius: number): VertexGrid {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
        const x = positions[i * 3] ?? 0;
        const y = positions[i * 3 + 1] ?? 0;
        const z = positions[i * 3 + 2] ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    // Cell size starts at the search radius (so 3×3×3 always covers it) and
    // grows if that would allocate an unreasonable grid for a large object.
    let cell = radius;
    let nx = 1, ny = 1, nz = 1;
    for (;;) {
        nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
        ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
        nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
        if (nx * ny * nz <= MAX_GRID_CELLS) break;
        cell *= 2;
    }

    const cellOf = (v: number, min: number, n: number): number => {
        const idx = Math.floor((v - min) / cell);
        return idx < 0 ? 0 : idx >= n ? n - 1 : idx;
    };
    const cellX = (x: number): number => cellOf(x, minX, nx);
    const cellY = (y: number): number => cellOf(y, minY, ny);
    const cellZ = (z: number): number => cellOf(z, minZ, nz);

    const cellCount = nx * ny * nz;
    const cellStart = new Int32Array(cellCount + 1);
    const bucket = new Int32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        const gx = cellX(positions[i * 3] ?? 0);
        const gy = cellY(positions[i * 3 + 1] ?? 0);
        const gz = cellZ(positions[i * 3 + 2] ?? 0);
        const c = (gz * ny + gy) * nx + gx;
        bucket[i] = c;
        cellStart[c + 1] = (cellStart[c + 1] ?? 0) + 1;
    }
    for (let c = 0; c < cellCount; c++) {
        cellStart[c + 1] = (cellStart[c + 1] ?? 0) + (cellStart[c] ?? 0);
    }

    const cursor = Int32Array.from(cellStart.subarray(0, cellCount));
    const cellItems = new Int32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        const c = bucket[i] ?? 0;
        cellItems[cursor[c] ?? 0] = i;
        cursor[c] = (cursor[c] ?? 0) + 1;
    }

    return { nx, ny, nz, cellStart, cellItems, cellX, cellY, cellZ };
}

/** Caller-facing finish settings; every field optional, defaults = stock look. */
export interface VoxelFinishOptions {
    /**
     * How the surface responds to light. 'matte' (default) is the historical
     * Lambert look; 'paint' is a clearcoated `MeshPhysicalMaterial` that
     * reflects `scene.environment`. Geometry is identical either way.
     */
    surface?: VoxelSurfaceFinish;
    /**
     * Blend from per-face normals toward neighbourhood-averaged shading
     * normals, 0…1 (default 0). Positions are untouched: the silhouette stays
     * blocky, only the light response curves.
     */
    smoothness?: number;
    /** Smoothing neighbourhood radius in voxel lengths (default 2.5). */
    smoothRadiusVoxels?: number;
    /** Overrides for the 'paint' parameters. */
    paint?: Partial<VoxelPaintParams>;
}

/** Fully resolved settings; what `VoxelObject` stores. */
export interface VoxelFinishSettings {
    surface: VoxelSurfaceFinish;
    smoothness: number;
    smoothRadiusVoxels: number;
    paint: VoxelPaintParams;
}

export function resolveVoxelFinishSettings(options: VoxelFinishOptions = {}): VoxelFinishSettings {
    return {
        surface: options.surface ?? DEFAULT_SURFACE_FINISH,
        smoothness: Math.min(1, Math.max(0, options.smoothness ?? DEFAULT_SHADING_SMOOTHNESS)),
        smoothRadiusVoxels: Math.max(0, options.smoothRadiusVoxels ?? DEFAULT_SHADING_SMOOTH_RADIUS_VOXELS),
        paint: { ...DEFAULT_PAINT_PARAMS, ...options.paint },
    };
}

export interface VoxelFinishBuildOptions {
    positions: ArrayLike<number>;
    /** Per-face normals — smoothed in place when settings ask for it. */
    normals: number[] | Float32Array;
    indices: ArrayLike<number>;
    voxelSize: number;
    settings: VoxelFinishSettings;
    /** Atlas texture, or null for the vertex-colour path. */
    map: THREE.Texture | null;
}

/**
 * Run the smoothing pass over `normals` and return the matching material.
 *
 * Call this **before** handing `normals` to the geometry — the pass rewrites
 * the array in place.
 */
export function buildVoxelFinishMaterial(options: VoxelFinishBuildOptions): THREE.Material {
    const { positions, normals, indices, voxelSize, settings, map } = options;
    const smoothed = normals.length > 0 && smoothShadingNormals({
        positions, normals, indices,
        radius: settings.smoothRadiusVoxels * voxelSize,
        strength: settings.smoothness,
    });
    // `flatShading` derives normals from screen-space position derivatives and
    // ignores the normal attribute entirely, so it has to come off wherever the
    // smoothing pass ran. Untextured voxel meshes have always been flat-shaded
    // and atlas ones never were — preserve both when smoothing is off.
    return createFinishMaterial(settings, {
        map,
        vertexColors: map === null,
        flatShading: map === null && !smoothed,
    });
}

/** How the mesh carries its colour — must be read from the mesh, never guessed. */
interface FinishSurface {
    /** Atlas texture, or null for the vertex-colour path. */
    map: THREE.Texture | null;
    /** True only when the geometry actually has a `color` attribute. */
    vertexColors: boolean;
    flatShading: boolean;
}

/**
 * Build the material for a finish.
 *
 * Both returned materials are stock three.js types, so `three/webgpu` converts
 * them to their node equivalents automatically and no separate WebGPU path is
 * needed (see game/docs/renderer-backends.md).
 */
function createFinishMaterial(settings: VoxelFinishSettings, surface: FinishSurface): THREE.Material {
    const common = {
        map: surface.map,
        vertexColors: surface.vertexColors,
        side: THREE.FrontSide,
        flatShading: surface.flatShading,
    };

    if (settings.surface === 'paint') {
        const paint = settings.paint;
        // `color` multiplies the map / vertex colours.
        const color = new THREE.Color().setScalar(paint.albedoScale);
        if (paint.glossModel === 'direct') {
            return new THREE.MeshPhongMaterial({
                ...common,
                color,
                specular: new THREE.Color().setScalar(paint.directSpecular),
                shininess: paint.directShininess,
            });
        }
        return new THREE.MeshPhysicalMaterial({
            ...common,
            color,
            metalness: paint.metalness,
            roughness: paint.roughness,
            clearcoat: paint.clearcoat,
            clearcoatRoughness: paint.clearcoatRoughness,
            envMapIntensity: paint.envMapIntensity,
        });
    }
    return new THREE.MeshLambertMaterial(common);
}

/**
 * Apply a finish to an ALREADY-assembled voxel mesh.
 *
 * Baked `.vxl` assets — which is every forged vehicle — never reach
 * `VoxelObject.buildMesh()`. They load as an octree and their geometry AND
 * material are built inside `VoxelOctreeRenderer`, several call layers down.
 * Rather than thread finish settings through that chain, retro-fit the
 * finished mesh here: smooth the normal attribute in place, then swap the
 * material, carrying over the polygon offset the octree path assigned for
 * z-fighting.
 *
 * Emissive meshes keep their own material (that path is a separate dual-path
 * node/shader material); they still get the smoothed normals.
 */
export function applyVoxelFinishToMesh(
    mesh: THREE.Mesh,
    settings: VoxelFinishSettings,
    voxelSize: number,
): void {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    if (!position || !normal || !index) return;

    // Skip the pass on a mesh whose normals a material class already smoothed
    // during assembly. Smoothing is not idempotent — a second neighbourhood
    // average over already-averaged normals flattens the surface further — and
    // this call site runs unconditionally on every vehicle chassis, so a chassis
    // carrying a shiny material slot would otherwise be smoothed twice.
    const already = shadingSmoothedStamp(geometry);
    const smoothed = already !== null
        ? false
        : smoothShadingNormals({
            positions: position.array,
            normals: normal.array as Float32Array,
            indices: index.array,
            radius: settings.smoothRadiusVoxels * voxelSize,
            strength: settings.smoothness,
        });
    if (smoothed) {
        normal.needsUpdate = true;
        stampShadingSmoothed(geometry, settings.smoothness, settings.smoothRadiusVoxels);
    }

    if (settings.surface !== 'paint') return;

    // Material slots (a vehicle's headlights, taillights, beacons) render as
    // extra geometry groups with their own materials, group 0 being the base
    // paint. Paint only that one and leave the light materials alone: their
    // whole job is to glow, and a car should not have to choose between a paint
    // finish and having lights. Slot-free meshes have a single material and
    // take the same path they always did.
    const previous = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!previous) return;
    // The BASE material's own per-vertex emissive (legacy colour-keyed glow,
    // e.g. World-Forger rune inlays) is not reproducible by the paint shader,
    // so those meshes keep their material. Slot geometry carries no such
    // attribute, so a plain vehicle with lights is not caught by this.
    if (geometry.getAttribute('emissive')) return;

    // Read the map STRUCTURALLY, never with `instanceof`. Under WebGPU the
    // octree path hands us a MeshLambertNodeMaterial, which is not an
    // `instanceof` any THREE.Mesh*Material — an instanceof check silently drops
    // the atlas texture and the car renders pure white.
    const prev = previous as Partial<{ map: THREE.Texture | null; flatShading: boolean }>;
    // Atlas (uv) and vertex-colour geometry are mutually exclusive by
    // construction in VoxelOctreeRenderer.assembleVoxelMesh — ask the GEOMETRY
    // which one this is rather than inferring it from the material.
    const next = createFinishMaterial(settings, {
        map: prev.map ?? null,
        vertexColors: geometry.getAttribute('color') !== undefined,
        flatShading: !smoothed && (prev.flatShading ?? false),
    });
    next.polygonOffset = previous.polygonOffset;
    next.polygonOffsetFactor = previous.polygonOffsetFactor;
    next.polygonOffsetUnits = previous.polygonOffsetUnits;
    if (Array.isArray(mesh.material)) {
        mesh.material[0] = next;
    } else {
        mesh.material = next;
    }
    previous.dispose();
}
