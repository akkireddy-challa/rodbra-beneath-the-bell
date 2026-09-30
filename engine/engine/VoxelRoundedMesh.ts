/**
 * Rounded voxel mesh emission.
 *
 * Builds rounded voxel geometry from primitives — completely independent from
 * the sharp-edge voxel path. No `RoundedBoxGeometry`, no vertex snapping, no
 * shared triangulation with the sharp path.
 *
 * For each voxel emits:
 *   - Flat face polygons for each exposed face (with corner insets where this
 *     voxel's adjacent edges are rounded).
 *   - Quarter-cylinder edge strips for outer convex edges (both adjacent faces
 *     exposed).
 *   - Sphere octants for outer convex corners (all 3 adjacent faces exposed).
 *   - Inner corner patches for L-shape concave corners (two perpendicular
 *     quarter-arcs connected by polygons).
 *   - A single floor quad at the box's -Y plane when the box has two
 *     perpendicular horizontal sides empty and at least one of those empty
 *     neighbors has a solid voxel directly below it.
 *
 * UV mapping: position-based projection — each surface vertex's local position
 * is mapped to the dominant face's atlas region using the same 0..1-per-face
 * convention as the sharp voxel path. This keeps textures continuous between
 * rounded and sharp blocks.
 */

import type { AtlasUV } from 'engine/VoxelTextureAtlas.js';

/**
 * Radius (in voxel units) applied when a GLB-voxelized asset opts into rounded
 * edges via `voxelizeSettings.roundedEdges`. Chosen for a pronounced soft look
 * while keeping flat face regions on 1-voxel features.
 */
export const ROUNDED_EDGES_RADIUS_VOXELS = 0.4;

/**
 * Effective per-block voxel radius: block override (if defined) wins; else world default.
 */
export function mergeVoxelRoundingRadiusVoxels(
    worldRadiusVoxels: number,
    blockRadiusVoxels: number | undefined,
): number {
    return Math.max(0, blockRadiusVoxels ?? worldRadiusVoxels);
}

export interface DiagonalVoxelInfo {
    blockType: number;
    r: number;
    g: number;
    b: number;
}

/**
 * Emit horizontal "bridge" quads at outer corner gaps where the diagonally
 * adjacent voxel exists. Closes the visible gap at the floor (or ceiling)
 * level between this voxel's rounded edge cylinder and the diagonal voxel's
 * matching cylinder. Uses the diagonal voxel's atlas region.
 *
 * Lex-deduplication: only emits from edges with signX > 0 (Z-edges) or
 * signY > 0 (X-edges); the other voxel emits the corresponding bridge.
 */
export interface FloorBridgeQuadParams {
    positions: number[];
    colors: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
    centerX: number;
    centerY: number;
    centerZ: number;
    halfA: number;
    halfB: number;
    halfC: number;
    radius: number;
    /** [-Z, +Z, -X, +X, -Y, +Y] */
    exposedFaces: readonly boolean[];
    /** Box's negative-corner-most voxel (global voxel coords). */
    boxMinVoxX: number;
    boxMinVoxY: number;
    boxMinVoxZ: number;
    /** Box dimensions in voxel units. */
    boxW: number;
    boxH: number;
    boxD: number;
    /** Cross-chunk lookup for diagonal voxel info (returns null if empty/fluid). */
    sampleVoxel: (vx: number, vy: number, vz: number) => DiagonalVoxelInfo | null;
    useAtlas: boolean;
    getAtlasRegion: ((diag: DiagonalVoxelInfo, faceType: 'top' | 'bottom') => AtlasUV | null) | null;
    generateNormals: boolean;
}

export function appendFloorBridgeQuads(p: FloorBridgeQuadParams): void {
    const { positions, colors, normals, uvs, indices,
        centerX, centerY, centerZ, halfA, halfB, halfC,
        exposedFaces, boxMinVoxX, boxMinVoxY, boxMinVoxZ, boxW, boxD,
        sampleVoxel, useAtlas, getAtlasRegion, generateNormals } = p;

    const xP = boxMinVoxX + boxW - 1, xN = boxMinVoxX;
    const yN = boxMinVoxY;
    const zP = boxMinVoxZ + boxD - 1, zN = boxMinVoxZ;
    const sx = boxMinVoxX + Math.floor(boxW / 2);
    const sz = boxMinVoxZ + Math.floor(boxD / 2);

    const dXP = exposedFaces[3] ? sampleVoxel(xP + 1, yN - 1, sz) : null;
    const dXN = exposedFaces[2] ? sampleVoxel(xN - 1, yN - 1, sz) : null;
    const dZP = exposedFaces[1] ? sampleVoxel(sx, yN - 1, zP + 1) : null;
    const dZN = exposedFaces[0] ? sampleVoxel(sx, yN - 1, zN - 1) : null;
    const hasX = !!exposedFaces[3] || !!exposedFaces[2];
    const hasZ = !!exposedFaces[1] || !!exposedFaces[0];
    const diag = dXP || dXN || dZP || dZN;
    if (!hasX || !hasZ || !diag) return;

    const x0 = centerX - halfA, x1 = centerX + halfA;
    const y = centerY - halfB;
    const z0 = centerZ - halfC, z1 = centerZ + halfC;
    const corners: [number, number, number][] = [
        [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0],
    ];
    const cornerUVs: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];
    const region: AtlasUV | null = useAtlas && getAtlasRegion ? getAtlasRegion(diag, 'top') : null;
    const baseV = positions.length / 3;
    for (let i = 0; i < 4; i++) {
        const [px, py, pz] = corners[i]!;
        positions.push(px, py, pz);
        colors.push(diag.r, diag.g, diag.b);
        if (generateNormals) normals.push(0, +1, 0);
        if (region) {
            const [u01, v01] = cornerUVs[i]!;
            uvs.push(region.u0 + u01 * (region.u1 - region.u0), region.v0 + v01 * (region.v1 - region.v0));
        }
    }
    indices.push(baseV, baseV + 1, baseV + 2);
    indices.push(baseV, baseV + 2, baseV + 3);
}

export interface RoundedAtlasContext {
    /** BlockType.COLOR (255): use palette UV from rgb24. */
    isColorPalette: boolean;
    rgb24: number;
    getAtlasRegionForFace(faceIndex: number): AtlasUV | null;
    getPaletteUV(rgb24: number): AtlasUV | null;
}

export interface AppendRoundedVoxelMeshParams {
    positions: number[];
    colors: number[];
    normals: number[];
    uvs: number[];
    indices: number[];

    /** World-space center of the voxel/box. */
    centerX: number;
    centerY: number;
    centerZ: number;
    /** Full extents (not half) in world units. */
    width: number;
    height: number;
    depth: number;
    /** Corner radius, world units. Caller skips the rounded path if 0. */
    radius: number;
    /** Tessellation segments per quarter-arc (1 = a single chord, 2 = 2 chords, ...). */
    segments: number;

    /** [-Z(0), +Z(1), -X(2), +X(3), -Y(4), +Y(5)] */
    exposedFaces: readonly boolean[];
    /**
     * 8 flags for L-shape inner concave corners. Octant index =
     * ((sx>0?1:0)<<2) | ((sy>0?1:0)<<1) | (sz>0?1:0).
     * Phase 2 will use these; currently ignored.
     */
    cornerInnerFlags?: readonly boolean[];

    rgb: readonly [number, number, number];
    atlas: RoundedAtlasContext | null;
    generateNormals: boolean;
}

// Face indices
const F_NEG_Z = 0, F_POS_Z = 1, F_NEG_X = 2, F_POS_X = 3, F_NEG_Y = 4, F_POS_Y = 5;

const FACE_NORMALS: readonly [number, number, number][] = [
    [0, 0, -1],
    [0, 0, +1],
    [-1, 0, 0],
    [+1, 0, 0],
    [0, -1, 0],
    [0, +1, 0],
];

/**
 * Position-based UV: maps a vertex local position (relative to voxel center)
 * onto the atlas region for `face`. The 0..1-per-face convention matches the
 * sharp voxel path so textures tile seamlessly.
 */
function positionUV(
    lx: number, ly: number, lz: number,
    hw: number, hh: number, hd: number,
    w: number, h: number, d: number,
    face: number,
): [number, number] {
    switch (face) {
        case F_NEG_Z: return [(lx + hw) / w, (ly + hh) / h];
        case F_POS_Z: return [1 - (lx + hw) / w, (ly + hh) / h];
        case F_NEG_X: return [1 - (lz + hd) / d, (ly + hh) / h];
        case F_POS_X: return [(lz + hd) / d, (ly + hh) / h];
        case F_NEG_Y: return [(lx + hw) / w, 1 - (lz + hd) / d];
        case F_POS_Y: return [(lx + hw) / w, (lz + hd) / d];
        default: return [0, 0];
    }
}

function clamp01(v: number): number { return Math.min(1, Math.max(0, v)); }

interface EmitContext {
    positions: number[];
    colors: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
    centerX: number;
    centerY: number;
    centerZ: number;
    hw: number;
    hh: number;
    hd: number;
    w: number;
    h: number;
    d: number;
    rgb: readonly [number, number, number];
    atlas: RoundedAtlasContext | null;
    generateNormals: boolean;
    /** Per-block color palette UV (computed once per call when isColorPalette). */
    paletteUV: AtlasUV | null;
}

/**
 * Push a single vertex with given local-space position, normal, and dominant face for UV.
 * Returns the absolute vertex index.
 */
function pushVertex(
    ctx: EmitContext,
    lx: number, ly: number, lz: number,
    nx: number, ny: number, nz: number,
    uvFace: number,
): number {
    const idx = ctx.positions.length / 3;
    ctx.positions.push(ctx.centerX + lx, ctx.centerY + ly, ctx.centerZ + lz);
    ctx.colors.push(ctx.rgb[0]!, ctx.rgb[1]!, ctx.rgb[2]!);
    if (ctx.generateNormals) ctx.normals.push(nx, ny, nz);
    if (ctx.atlas) {
        const region = ctx.paletteUV ?? ctx.atlas.getAtlasRegionForFace(uvFace);
        if (region) {
            const [u01, v01] = positionUV(lx, ly, lz, ctx.hw, ctx.hh, ctx.hd, ctx.w, ctx.h, ctx.d, uvFace);
            ctx.uvs.push(
                region.u0 + clamp01(u01) * (region.u1 - region.u0),
                region.v0 + clamp01(v01) * (region.v1 - region.v0),
            );
        }
    }
    return idx;
}

function pushTriangle(ctx: EmitContext, i0: number, i1: number, i2: number): void {
    ctx.indices.push(i0, i1, i2);
}


/**
 * Emit a quarter-cylinder edge strip between two perpendicular face planes.
 *
 * Edge runs along `axisAlong` (0=X, 1=Y, 2=Z). Cross-section is a quarter-arc
 * in the plane spanned by `axisA` and `axisB`. The cylinder's axis is at the
 * "inset point" (at `halfA - r` and `halfB - r` from voxel center along the
 * 2 perpendicular axes), and the arc has radius r.
 *
 * The cylinder endpoints along `axisAlong` are at `±halfL` (full voxel extent).
 *
 * `signA` and `signB` are +1 or -1 per axis, indicating which corner of the
 * voxel the cylinder occupies.
 */
function emitEdgeCylinder(
    ctx: EmitContext,
    axisAlong: 0 | 1 | 2,
    signA: number, signB: number,
    /** Atlas face index used for UV mapping (the more "primary" face). */
    uvFace: number,
    segments: number,
    radius: number,
    /** When true, the (-axisAlong) end of the cylinder is shortened by r so the
     *  corner sphere octant at that end can take over without overlap. */
    shrinkStart: boolean,
    /** Same for the (+axisAlong) end. */
    shrinkEnd: boolean,
): void {
    // Right-handed local frame: axisA × axisB = axisAlong (cyclic).
    //  axisAlong=0(X): axisA=Y(1), axisB=Z(2). Y × Z = X. ✓
    //  axisAlong=1(Y): axisA=Z(2), axisB=X(0). Z × X = Y. ✓
    //  axisAlong=2(Z): axisA=X(0), axisB=Y(1). X × Y = Z. ✓
    const axisA: number = (axisAlong === 0) ? 1 : (axisAlong === 1) ? 2 : 0;
    const axisB: number = (axisAlong === 0) ? 2 : (axisAlong === 1) ? 0 : 1;

    const halves = [ctx.hw, ctx.hh, ctx.hd];
    const halfA = halves[axisA]!;
    const halfB = halves[axisB]!;
    const halfL = halves[axisAlong]!;

    // Cylinder axis position
    const ax = signA * (halfA - radius);
    const ay = signB * (halfB - radius);

    // Generate (segments+1) arc samples × 2 length samples
    // Arc goes from face_a (theta=0) to face_b (theta=pi/2)
    // At theta=0: point on face A plane (axisA = signA*halfA)
    // At theta=pi/2: point on face B plane (axisB = signB*halfB)

    const arcPositions: { aVal: number; bVal: number; nA: number; nB: number }[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const theta = t * (Math.PI / 2);
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        // At theta=0: aVal = signA*halfA, bVal = signB*(halfB - radius). Normal = (signA, 0).
        // At theta=pi/2: aVal = signA*(halfA - radius), bVal = signB*halfB. Normal = (0, signB).
        const aVal = ax + signA * radius * cosT;
        const bVal = ay + signB * radius * sinT;
        arcPositions.push({ aVal, bVal, nA: signA * cosT, nB: signB * sinT });
    }

    // Two endpoints along the edge axis. Shrink each end by r if a corner sphere
    // octant is taking over the corner volume there.
    const lStart = -halfL + (shrinkStart ? radius : 0);
    const lEnd = +halfL - (shrinkEnd ? radius : 0);
    const ringIndices: number[][] = [[], []];
    for (let endIdx = 0; endIdx < 2; endIdx++) {
        const lAlong = (endIdx === 0) ? lStart : lEnd;
        for (const arc of arcPositions) {
            const pos: [number, number, number] = [0, 0, 0];
            pos[axisAlong] = lAlong;
            pos[axisA] = arc.aVal;
            pos[axisB] = arc.bVal;
            const nrm: [number, number, number] = [0, 0, 0];
            nrm[axisA] = arc.nA;
            nrm[axisB] = arc.nB;
            ringIndices[endIdx]!.push(
                pushVertex(ctx, pos[0]!, pos[1]!, pos[2]!, nrm[0]!, nrm[1]!, nrm[2]!, uvFace),
            );
        }
    }

    // Triangulate quads between the two rings (CCW from outside).
    // With right-handed local frame, the rule is: flip winding when signA*signB < 0.
    const r0 = ringIndices[0]!;
    const r1 = ringIndices[1]!;
    const flipWinding = (signA * signB) < 0;
    for (let i = 0; i < segments; i++) {
        const a = r0[i]!;
        const b = r0[i + 1]!;
        const c = r1[i + 1]!;
        const d = r1[i]!;
        if (flipWinding) {
            pushTriangle(ctx, a, c, b);
            pushTriangle(ctx, a, d, c);
        } else {
            pushTriangle(ctx, a, b, c);
            pushTriangle(ctx, a, c, d);
        }
    }
}

/**
 * Emit a sphere octant for an outer convex corner (3 faces exposed).
 *
 * Sphere center at (signX*(halfX-r), signY*(halfY-r), signZ*(halfZ-r)) (local).
 * The octant occupies local space from sphere center outward in (signX, signY, signZ)
 * direction up to (signX*halfX, signY*halfY, signZ*halfZ).
 *
 * Tessellation: (segments+1) × (segments+1) grid of vertices using spherical
 * parametrization. UV mapping uses `uvFace` (the "top" face for each corner).
 */
function emitOuterCornerSphere(
    ctx: EmitContext,
    signX: number, signY: number, signZ: number,
    uvFace: number,
    segments: number,
    radius: number,
): void {
    const cx = signX * (ctx.hw - radius);
    const cy = signY * (ctx.hh - radius);
    const cz = signZ * (ctx.hd - radius);

    // Sphere octant parametrization:
    // u in [0, 1], v in [0, 1].
    // theta = u * pi/2 (in axisA-axisB plane)
    // phi = v * pi/2 (away from "main" axis)
    // Use Y as the main axis: phi = 0 → top of octant (highest Y in this octant direction);
    //                          phi = pi/2 → equator
    // theta varies in XZ plane: 0 → +X side of octant, pi/2 → +Z side (or signed).

    const grid: number[][] = [];
    for (let vi = 0; vi <= segments; vi++) {
        const phi = (vi / segments) * (Math.PI / 2);
        const sinP = Math.sin(phi), cosP = Math.cos(phi);
        const row: number[] = [];
        for (let ui = 0; ui <= segments; ui++) {
            const theta = (ui / segments) * (Math.PI / 2);
            const sinT = Math.sin(theta), cosT = Math.cos(theta);
            // Direction from sphere center, scaled to (signX, signY, signZ) octant.
            const dx = signX * sinP * cosT;
            const dy = signY * cosP;
            const dz = signZ * sinP * sinT;
            const px = cx + radius * dx;
            const py = cy + radius * dy;
            const pz = cz + radius * dz;
            row.push(pushVertex(ctx, px, py, pz, dx, dy, dz, uvFace));
        }
        grid.push(row);
    }

    for (let vi = 0; vi < segments; vi++) {
        for (let ui = 0; ui < segments; ui++) {
            const a = grid[vi]![ui]!;
            const b = grid[vi]![ui + 1]!;
            const c = grid[vi + 1]![ui + 1]!;
            const d = grid[vi + 1]![ui]!;
            // Determine winding: outward face if the normal we chose is outward.
            // Our normal direction is (dx, dy, dz) — outward from sphere center.
            // CCW winding from outside view depends on octant. Emit both possible orderings
            // is bad (back-faces). Pick a consistent one:
            const flip = (signX * signY * signZ) < 0;
            if (flip) {
                pushTriangle(ctx, a, d, c);
                pushTriangle(ctx, a, c, b);
            } else {
                pushTriangle(ctx, a, b, c);
                pushTriangle(ctx, a, c, d);
            }
        }
    }
}

/**
 * Emit an inner concave corner patch for an L-shape corner (1 face exposed of this
 * voxel, 2 hidden, diagonal voxel between the 2 hidden axes is empty).
 *
 * Two quarter-arcs match the cross-sections of the neighboring voxels' edge cylinders
 * meeting at this corner. A ruled surface of triangles bridges the arcs.
 *
 * Arc A lies on the H1 face plane (one of the hidden faces); it's the cross-section
 * of the neighbor at +H1 that has its (E, H2) edge cylinder.
 * Arc B lies on the H2 face plane (the other hidden face); it's the cross-section
 * of the neighbor at +H2 that has its (E, H1) edge cylinder.
 * Both arcs share their endpoint at (sH1*halfH1, sE*(halfE-r), sH2*halfH2). The other
 * ends of the arcs (at the chord on the exposed E face) are the chord endpoints of
 * the L-shape cut on this voxel's E face quad.
 */
function emitInnerCornerPatch(
    ctx: EmitContext,
    octant: number,
    exposedFaces: readonly boolean[],
    segments: number,
    radius: number,
): void {
    const sxPos = (octant & 4) !== 0;
    const syPos = (octant & 2) !== 0;
    const szPos = (octant & 1) !== 0;
    const sX = sxPos ? +1 : -1;
    const sY = syPos ? +1 : -1;
    const sZ = szPos ? +1 : -1;
    const fx = sxPos ? F_POS_X : F_NEG_X;
    const fy = syPos ? F_POS_Y : F_NEG_Y;
    const fz = szPos ? F_POS_Z : F_NEG_Z;
    const xExp = exposedFaces[fx]!;
    const yExp = exposedFaces[fy]!;
    const zExp = exposedFaces[fz]!;

    let E: number, H1: number, H2: number;
    let sE: number, sH1: number, sH2: number;
    let uvFace: number;
    if (xExp) {
        E = 0; sE = sX;
        H1 = 1; sH1 = sY;
        H2 = 2; sH2 = sZ;
        uvFace = sxPos ? F_POS_X : F_NEG_X;
    } else if (yExp) {
        E = 1; sE = sY;
        H1 = 0; sH1 = sX;
        H2 = 2; sH2 = sZ;
        uvFace = syPos ? F_POS_Y : F_NEG_Y;
    } else if (zExp) {
        E = 2; sE = sZ;
        H1 = 0; sH1 = sX;
        H2 = 1; sH2 = sY;
        uvFace = szPos ? F_POS_Z : F_NEG_Z;
    } else {
        return;
    }

    const halves = [ctx.hw, ctx.hh, ctx.hd];
    const halfE = halves[E]!;
    const halfH1 = halves[H1]!;
    const halfH2 = halves[H2]!;

    // Outward normal direction (toward the empty diagonal).
    const outLen = Math.sqrt(3);
    const nX = sX / outLen;
    const nY = sY / outLen;
    const nZ = sZ / outLen;

    const N = segments;
    const idxA: number[] = [];
    const idxB: number[] = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const angle = t * Math.PI / 2;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        const posA: [number, number, number] = [0, 0, 0];
        posA[H1] = sH1 * halfH1;
        posA[E] = sE * (halfE - radius + radius * cosA);
        posA[H2] = sH2 * (halfH2 - radius + radius * sinA);
        idxA.push(pushVertex(ctx, posA[0]!, posA[1]!, posA[2]!, nX, nY, nZ, uvFace));

        const posB: [number, number, number] = [0, 0, 0];
        posB[H2] = sH2 * halfH2;
        posB[E] = sE * (halfE - radius + radius * cosA);
        posB[H1] = sH1 * (halfH1 - radius + radius * sinA);
        idxB.push(pushVertex(ctx, posB[0]!, posB[1]!, posB[2]!, nX, nY, nZ, uvFace));
    }

    /*
     * Winding rule: in (H1, E, H2) frame, cross product (B-A) × (M-A) gives a vector
     * with all components positive in (H1, E, H2). The mapping from this frame to
     * (X, Y, Z) is right-handed when E=Y (yExp), left-handed when E=X or E=Z (xExp/zExp).
     * The outward direction is (sX, sY, sZ) in (X, Y, Z). Combining: flip when
     * sX*sY*sZ < 0 for yExp, or when sX*sY*sZ > 0 for xExp/zExp.
     */
    let flipWinding = (sX * sY * sZ) < 0;
    if (xExp || zExp) flipWinding = !flipWinding;

    for (let i = 0; i < N; i++) {
        const a = idxA[i]!;
        const b = idxA[i + 1]!;
        const c = idxB[i + 1]!;
        const d = idxB[i]!;
        if (flipWinding) {
            pushTriangle(ctx, a, b, d);
            if (i < N - 1) pushTriangle(ctx, b, c, d);
        } else {
            pushTriangle(ctx, a, d, b);
            if (i < N - 1) pushTriangle(ctx, b, d, c);
        }
    }
}

/**
 * For each of 12 edges, return whether it's a "rounded" outer convex edge
 * (i.e., both adjacent faces of THIS voxel are exposed).
 */
interface EdgeFlags {
    /** Z-edges (along Z): index = (signX>0?2:0) | (signY>0?1:0) */
    z: [boolean, boolean, boolean, boolean];
    /** Y-edges (along Y): index = (signX>0?2:0) | (signZ>0?1:0) */
    y: [boolean, boolean, boolean, boolean];
    /** X-edges (along X): index = (signY>0?2:0) | (signZ>0?1:0) */
    x: [boolean, boolean, boolean, boolean];
}

function computeEdgeFlags(exposed: readonly boolean[]): EdgeFlags {
    return {
        // Z-edges: between X-face and Y-face
        z: [
            exposed[F_NEG_X]! && exposed[F_NEG_Y]!,  // (-X, -Y)
            exposed[F_NEG_X]! && exposed[F_POS_Y]!,  // (-X, +Y)
            exposed[F_POS_X]! && exposed[F_NEG_Y]!,  // (+X, -Y)
            exposed[F_POS_X]! && exposed[F_POS_Y]!,  // (+X, +Y)
        ],
        // Y-edges: between X-face and Z-face
        y: [
            exposed[F_NEG_X]! && exposed[F_NEG_Z]!,
            exposed[F_NEG_X]! && exposed[F_POS_Z]!,
            exposed[F_POS_X]! && exposed[F_NEG_Z]!,
            exposed[F_POS_X]! && exposed[F_POS_Z]!,
        ],
        // X-edges: between Y-face and Z-face
        x: [
            exposed[F_NEG_Y]! && exposed[F_NEG_Z]!,
            exposed[F_NEG_Y]! && exposed[F_POS_Z]!,
            exposed[F_POS_Y]! && exposed[F_NEG_Z]!,
            exposed[F_POS_Y]! && exposed[F_POS_Z]!,
        ],
    };
}

/**
 * For each face's 4 corners, returns the 3D corner octant index.
 * Octant index: ((sx>0?1:0)<<2) | ((sy>0?1:0)<<1) | (sz>0?1:0).
 * Corners are listed in the same CCW order as emitFaceQuadWithRadius.
 */
function getFaceCornerOctants(face: number): readonly [number, number, number, number] {
    switch (face) {
        case F_POS_Y: return [2, 6, 7, 3];   // (-,+,-), (+,+,-), (+,+,+), (-,+,+)
        case F_NEG_Y: return [1, 5, 4, 0];   // (-,-,+), (+,-,+), (+,-,-), (-,-,-)
        case F_POS_X: return [4, 5, 7, 6];   // (+,-,-), (+,-,+), (+,+,+), (+,+,-)
        case F_NEG_X: return [1, 0, 2, 3];   // (-,-,+), (-,-,-), (-,+,-), (-,+,+)
        case F_POS_Z: return [5, 1, 3, 7];   // (+,-,+), (-,-,+), (-,+,+), (+,+,+)
        case F_NEG_Z: return [0, 4, 6, 2];   // (-,-,-), (+,-,-), (+,+,-), (-,+,-)
        default: return [0, 0, 0, 0];
    }
}

/**
 * For each face's 4 corners, returns inset flags along the face's two in-plane
 * axes. A corner is inset along axis A (in-plane) iff:
 *   - The edge of THIS voxel adjacent along perpendicular axis is rounded, OR
 *   - The 3D corner is flagged as L-shape inner concave (cornerInnerFlags).
 *
 * Returns insetA[4] and insetB[4], one per corner, in CCW order matching
 * emitFaceQuadWithRadius.
 */
function computeFaceCornerInsets(
    face: number,
    edges: EdgeFlags,
    cornerInnerFlags: readonly boolean[] | undefined,
): { insetA: boolean[]; insetB: boolean[]; lshape: boolean[] } {
    const cornerOctants = getFaceCornerOctants(face);
    const lshape: boolean[] = [false, false, false, false];
    if (cornerInnerFlags) {
        for (let c = 0; c < 4; c++) {
            lshape[c] = cornerInnerFlags[cornerOctants[c]!] ?? false;
        }
    }
    /*
     * L-shape inner concave corners need a chord across the corner (2 vertices in
     * the face polygon) — they're returned via `lshape` and handled separately.
     * Edge-based inset (single vertex moved inward by r) is returned via insetA/insetB.
     */
    const merge = (insetA: boolean[], insetB: boolean[]) => ({ insetA, insetB, lshape });
    /*
     * CCW corner ordering matches emitFaceQuad's signsA, signsB definitions.
     * For each face we determine which edges the corners are part of.
     */
    switch (face) {
        case F_POS_Y: {
            // axisA = X, axisB = Z. signsA = [-1, +1, +1, -1], signsB = [-1, -1, +1, +1].
            // Edges of +Y face: (+Y, -X), (+Y, +X), (+Y, -Z), (+Y, +Z) — these are Z and X edges.
            // (+Y, -X) is a Z-edge with sign(-1, +1) = z[1]
            // (+Y, +X) is a Z-edge with sign(+1, +1) = z[3]
            // (+Y, -Z) is an X-edge with sign(+1, -1) = x[2]
            // (+Y, +Z) is an X-edge with sign(+1, +1) = x[3]
            // For corner c, insetA (X axis): rounded iff Z-edge along sa direction is rounded.
            //   sa<0: z[1] (+Y, -X). sa>0: z[3] (+Y, +X).
            // insetB (Z axis): rounded iff X-edge along sb direction is rounded.
            //   sb<0: x[2] (+Y, -Z). sb>0: x[3] (+Y, +Z).
            const negX_posY = edges.z[1]!;
            const posX_posY = edges.z[3]!;
            const negZ_posY = edges.x[2]!;
            const posZ_posY = edges.x[3]!;
            // Corners: [(-X,-Z), (+X,-Z), (+X,+Z), (-X,+Z)]
            return merge(
                [negX_posY, posX_posY, posX_posY, negX_posY],
                [negZ_posY, negZ_posY, posZ_posY, posZ_posY],
            );
        }
        case F_NEG_Y: {
            // axisA = X, axisB = Z. signsA = [-1, +1, +1, -1], signsB = [+1, +1, -1, -1].
            // Edges of -Y face: (-Y, -X)=z[0], (-Y, +X)=z[2], (-Y, -Z)=x[0], (-Y, +Z)=x[1]
            const negX_negY = edges.z[0]!;
            const posX_negY = edges.z[2]!;
            const negZ_negY = edges.x[0]!;
            const posZ_negY = edges.x[1]!;
            // Corners: [(-X,+Z), (+X,+Z), (+X,-Z), (-X,-Z)]
            return merge(
                [negX_negY, posX_negY, posX_negY, negX_negY],
                [posZ_negY, posZ_negY, negZ_negY, negZ_negY],
            );
        }
        case F_POS_X: {
            // axisA = Z, axisB = Y. signsA=[-1,+1,+1,-1], signsB=[-1,-1,+1,+1]
            // Edges of +X face: (+X, -Y)=z[2], (+X, +Y)=z[3], (+X, -Z)=y[2], (+X, +Z)=y[3]
            // insetA (Z axis): rounded iff Y-edge along sa direction. sa<0: y[2], sa>0: y[3]
            // insetB (Y axis): rounded iff Z-edge along sb. sb<0: z[2], sb>0: z[3]
            const posX_negZ = edges.y[2]!;
            const posX_posZ = edges.y[3]!;
            const posX_negY = edges.z[2]!;
            const posX_posY = edges.z[3]!;
            return merge(
                [posX_negZ, posX_posZ, posX_posZ, posX_negZ],
                [posX_negY, posX_negY, posX_posY, posX_posY],
            );
        }
        case F_NEG_X: {
            // axisA = Z, axisB = Y. signsA=[+1,-1,-1,+1], signsB=[-1,-1,+1,+1]
            // Edges of -X face: (-X, -Y)=z[0], (-X, +Y)=z[1], (-X, -Z)=y[0], (-X, +Z)=y[1]
            const negX_negZ = edges.y[0]!;
            const negX_posZ = edges.y[1]!;
            const negX_negY = edges.z[0]!;
            const negX_posY = edges.z[1]!;
            return merge(
                [negX_posZ, negX_negZ, negX_negZ, negX_posZ],
                [negX_negY, negX_negY, negX_posY, negX_posY],
            );
        }
        case F_POS_Z: {
            // axisA = X, axisB = Y. signsA=[+1,-1,-1,+1], signsB=[-1,-1,+1,+1]
            // Edges of +Z face: (+Z, -Y)=x[1], (+Z, +Y)=x[3], (+Z, -X)=y[1], (+Z, +X)=y[3]
            // Wait actually y[1] = (-X, +Z). y[3] = (+X, +Z). So edges along Y axis at +Z: y[1] and y[3].
            const posZ_negX = edges.y[1]!;
            const posZ_posX = edges.y[3]!;
            const posZ_negY = edges.x[1]!;
            const posZ_posY = edges.x[3]!;
            return merge(
                [posZ_posX, posZ_negX, posZ_negX, posZ_posX],
                [posZ_negY, posZ_negY, posZ_posY, posZ_posY],
            );
        }
        case F_NEG_Z: {
            // axisA = X, axisB = Y. signsA=[-1,+1,+1,-1], signsB=[-1,-1,+1,+1]
            // Edges of -Z face: (-Z, -Y)=x[0], (-Z, +Y)=x[2], (-Z, -X)=y[0], (-Z, +X)=y[2]
            const negZ_negX = edges.y[0]!;
            const negZ_posX = edges.y[2]!;
            const negZ_negY = edges.x[0]!;
            const negZ_posY = edges.x[2]!;
            return merge(
                [negZ_negX, negZ_posX, negZ_posX, negZ_negX],
                [negZ_negY, negZ_negY, negZ_posY, negZ_posY],
            );
        }
        default: return merge([false, false, false, false], [false, false, false, false]);
    }
}

/**
 * Main entry point. Emits all rounded voxel mesh primitives for one voxel/box.
 */
export function appendRoundedVoxelMesh(params: AppendRoundedVoxelMeshParams): void {
    const {
        positions, colors, normals, uvs, indices,
        centerX, centerY, centerZ,
        width: w, height: h, depth: d,
        radius, segments,
        exposedFaces,
        rgb, atlas, generateNormals,
    } = params;

    if (radius <= 1e-9 || segments < 1) return;
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const r = Math.min(radius, hw, hh, hd) * (1 - 1e-4);
    if (r <= 1e-9) return;

    const paletteUV = atlas?.isColorPalette ? atlas.getPaletteUV(atlas.rgb24) : null;

    const ctx: EmitContext = {
        positions, colors, normals, uvs, indices,
        centerX, centerY, centerZ,
        hw, hh, hd, w, h, d,
        rgb, atlas, generateNormals, paletteUV,
    };

    const edges = computeEdgeFlags(exposedFaces);

    // 1. Emit flat face polygons for each exposed face.
    // computeRadius(ctx) called inside emitFaceQuad uses min half — but we want r.
    // Override by constructing local-only radius. Use overrideRadius via local var: we'll
    // call emitFaceQuad with a wrapper-friendly approach below.
    for (let face = 0; face < 6; face++) {
        if (!exposedFaces[face]) continue;
        const insets = computeFaceCornerInsets(face, edges, params.cornerInnerFlags);
        emitFaceQuadWithRadius(ctx, face, insets.insetA, insets.insetB, insets.lshape, r);
    }

    // 2. Emit edge cylinders for each rounded edge.
    // Cylinder ends are shortened by r at outer convex corners (all 3 adjacent
    // faces exposed) so the sphere octant takes over without overlap.
    for (let i = 0; i < 4; i++) {
        if (!edges.z[i]) continue;
        const sxPos = (i & 2) !== 0;
        const syPos = (i & 1) !== 0;
        const fx = sxPos ? F_POS_X : F_NEG_X;
        const fy = syPos ? F_POS_Y : F_NEG_Y;
        const shrinkStart = exposedFaces[fx]! && exposedFaces[fy]! && exposedFaces[F_NEG_Z]!;
        const shrinkEnd = exposedFaces[fx]! && exposedFaces[fy]! && exposedFaces[F_POS_Z]!;
        const uvFace = syPos ? F_POS_Y : F_NEG_Y;
        emitEdgeCylinder(ctx, 2, sxPos ? +1 : -1, syPos ? +1 : -1, uvFace, segments, r, shrinkStart, shrinkEnd);
    }
    for (let i = 0; i < 4; i++) {
        if (!edges.y[i]) continue;
        const sxPos = (i & 2) !== 0;
        const szPos = (i & 1) !== 0;
        const fx = sxPos ? F_POS_X : F_NEG_X;
        const fz = szPos ? F_POS_Z : F_NEG_Z;
        const uvFace = sxPos ? F_POS_X : F_NEG_X;
        const shrinkStart = exposedFaces[fx]! && exposedFaces[F_NEG_Y]! && exposedFaces[fz]!;
        const shrinkEnd = exposedFaces[fx]! && exposedFaces[F_POS_Y]! && exposedFaces[fz]!;
        // Y-edge with right-handed frame: axisA=Z, axisB=X. Pass signs in that order.
        emitEdgeCylinder(ctx, 1, szPos ? +1 : -1, sxPos ? +1 : -1, uvFace, segments, r, shrinkStart, shrinkEnd);
    }
    for (let i = 0; i < 4; i++) {
        if (!edges.x[i]) continue;
        const syPos = (i & 2) !== 0;
        const szPos = (i & 1) !== 0;
        const fy = syPos ? F_POS_Y : F_NEG_Y;
        const fz = szPos ? F_POS_Z : F_NEG_Z;
        const uvFace = syPos ? F_POS_Y : F_NEG_Y;
        const shrinkStart = exposedFaces[F_NEG_X]! && exposedFaces[fy]! && exposedFaces[fz]!;
        const shrinkEnd = exposedFaces[F_POS_X]! && exposedFaces[fy]! && exposedFaces[fz]!;
        emitEdgeCylinder(ctx, 0, syPos ? +1 : -1, szPos ? +1 : -1, uvFace, segments, r, shrinkStart, shrinkEnd);
    }

    // 3. Emit outer convex corner spheres (all 3 adjacent faces exposed).
    for (let oct = 0; oct < 8; oct++) {
        const sxPos = (oct & 4) !== 0;
        const syPos = (oct & 2) !== 0;
        const szPos = (oct & 1) !== 0;
        const fx = sxPos ? F_POS_X : F_NEG_X;
        const fy = syPos ? F_POS_Y : F_NEG_Y;
        const fz = szPos ? F_POS_Z : F_NEG_Z;
        if (!exposedFaces[fx]! || !exposedFaces[fy]! || !exposedFaces[fz]!) continue;
        // Outer convex corner.
        const uvFace = syPos ? F_POS_Y : F_NEG_Y;
        emitOuterCornerSphere(ctx, sxPos ? +1 : -1, syPos ? +1 : -1, szPos ? +1 : -1, uvFace, segments, r);
    }

    // 4. Emit inner concave corner patches for L-shape corners.
    if (params.cornerInnerFlags) {
        for (let oct = 0; oct < 8; oct++) {
            if (params.cornerInnerFlags[oct]) {
                emitInnerCornerPatch(ctx, oct, exposedFaces, segments, r);
            }
        }
    }
}

/**
 * Variant of emitFaceQuad that accepts an explicit radius (the caller-derived
 * effective radius after clamping). Used internally because emitFaceQuad's
 * computeRadius default is the min half-extent.
 */
function emitFaceQuadWithRadius(
    ctx: EmitContext,
    face: number,
    insetA: readonly boolean[],
    insetB: readonly boolean[],
    /** Per corner, true iff the corner needs an L-shape diagonal chord cut. */
    lshape: readonly boolean[],
    radius: number,
): void {
    const fn = FACE_NORMALS[face]!;

    let axisA: number;
    let axisB: number;
    let perpAxis: number;
    let perpSign: number;
    let signsA: readonly [number, number, number, number];
    let signsB: readonly [number, number, number, number];
    switch (face) {
        case F_POS_Y:
            axisA = 0; axisB = 2; perpAxis = 1; perpSign = +1;
            signsA = [-1, +1, +1, -1];
            signsB = [-1, -1, +1, +1];
            break;
        case F_NEG_Y:
            axisA = 0; axisB = 2; perpAxis = 1; perpSign = -1;
            signsA = [-1, +1, +1, -1];
            signsB = [+1, +1, -1, -1];
            break;
        case F_POS_X:
            axisA = 2; axisB = 1; perpAxis = 0; perpSign = +1;
            signsA = [-1, +1, +1, -1];
            signsB = [-1, -1, +1, +1];
            break;
        case F_NEG_X:
            axisA = 2; axisB = 1; perpAxis = 0; perpSign = -1;
            signsA = [+1, -1, -1, +1];
            signsB = [-1, -1, +1, +1];
            break;
        case F_POS_Z:
            axisA = 0; axisB = 1; perpAxis = 2; perpSign = +1;
            signsA = [+1, -1, -1, +1];
            signsB = [-1, -1, +1, +1];
            break;
        case F_NEG_Z:
            axisA = 0; axisB = 1; perpAxis = 2; perpSign = -1;
            signsA = [-1, +1, +1, -1];
            signsB = [-1, -1, +1, +1];
            break;
        default:
            return;
    }

    const halves = [ctx.hw, ctx.hh, ctx.hd];
    const halfA = halves[axisA]!;
    const halfB = halves[axisB]!;
    const halfP = halves[perpAxis]!;
    const valP = perpSign * halfP;

    /*
     * Build polygon vertices in CW order from outside (matching corner walk 0,1,2,3).
     * For each corner with both axes inset (rounded outer corner OR L-shape inner cut),
     * emit TWO vertices forming a chord across the corner. Otherwise emit one vertex.
     *
     * Chord-vertex order pattern (verified for all 6 faces):
     *   Even corners (0, 2): vertex_a has axisA at +half, axisB at +(half-r);
     *                        vertex_b has axisA at +(half-r), axisB at +half.
     *   Odd corners  (1, 3): vertex_a has axisA at +(half-r), axisB at +half;
     *                        vertex_b has axisA at +half, axisB at +(half-r).
     * (The outer "+" sign is multiplied by signsA[c]/signsB[c] for the actual sign.)
     */
    const pushPolyVertex = (aVal: number, bVal: number): number => {
        const pos: [number, number, number] = [0, 0, 0];
        pos[axisA] = aVal;
        pos[axisB] = bVal;
        pos[perpAxis] = valP;
        return pushVertex(ctx, pos[0]!, pos[1]!, pos[2]!, fn[0]!, fn[1]!, fn[2]!, face);
    };

    const idx: number[] = [];
    for (let c = 0; c < 4; c++) {
        const sa = signsA[c]!;
        const sb = signsB[c]!;
        const aOff = insetA[c]!;
        const bOff = insetB[c]!;
        const isLShape = lshape[c]!;

        if (isLShape) {
            /*
             * L-shape inner concave corner: two vertices forming a chord across
             * the corner. The face's adjacent edges are not rounded (since L-shape
             * requires the perpendicular faces to be hidden), so the chord goes
             * from (sa*halfA, sb*(halfB-r)) to (sa*(halfA-r), sb*halfB) for even
             * corners, and the inverse for odd corners (CW polygon walk order).
             */
            const isEven = (c % 2) === 0;
            let va_a: number, va_b: number, vb_a: number, vb_b: number;
            if (isEven) {
                va_a = sa * halfA;
                va_b = sb * (halfB - radius);
                vb_a = sa * (halfA - radius);
                vb_b = sb * halfB;
            } else {
                va_a = sa * (halfA - radius);
                va_b = sb * halfB;
                vb_a = sa * halfA;
                vb_b = sb * (halfB - radius);
            }
            idx.push(pushPolyVertex(va_a, va_b));
            idx.push(pushPolyVertex(vb_a, vb_b));
        } else {
            /*
             * Single vertex per corner. If both axes inset (outer convex corner with
             * sphere octant filling the rounded area), corner pulled in along both;
             * if only one inset, pulled in along that one only; if neither, sharp.
             */
            const valA = sa * (aOff ? halfA - radius : halfA);
            const valB = sb * (bOff ? halfB - radius : halfB);
            idx.push(pushPolyVertex(valA, valB));
        }
    }

    /*
     * Triangulate as fan from idx[0]. Polygon walk is CW from outside, so the
     * front-facing fan is (idx[0], idx[i+1], idx[i]) for i in [1..n-2].
     */
    for (let i = 1; i < idx.length - 1; i++) {
        pushTriangle(ctx, idx[0]!, idx[i + 1]!, idx[i]!);
    }
}
