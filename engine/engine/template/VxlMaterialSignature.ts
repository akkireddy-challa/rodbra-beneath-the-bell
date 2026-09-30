/**
 * A voxel asset's MATERIAL SIGNATURE — a compact, readable description of what
 * the thing appears to be made of, derived from its baked `.vxl` alone.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Since 2026-08-20 props are generated voxel-native: `/ai/v1/forge-voxels` hands
 * back an HFVX master that is literally coordinates and RGB. There is no GLB and
 * no PBR material, so `VoxelSlotAssign`'s route to a material — the nearest
 * `BM_slot_*` triangle — does not exist for them. Nothing in the pipeline knows
 * that a generated sword's blade is steel.
 *
 * What IS available is the prompt that produced it ("a knight's longsword with a
 * steel blade and a leather-wrapped grip"), which names the materials outright,
 * and the baked palette, which says where each colour sits in the model. Matching
 * one to the other is a small classification over text — not a vision problem.
 * This module produces the half of that text which describes the asset.
 *
 * ── Why it clusters, and what the numbers are for ───────────────────────────
 *
 * A palette runs to thousands of entries (RGB444 caps at 4096 cells, times the
 * slot count), so it cannot be listed. Entries are grouped perceptually, and each
 * group is described by its colour AND its shape and position, because colour
 * alone cannot separate a blade from a plinth:
 *
 *   g0 #b8bcc4  55%  y 0.30-1.00  thin-long
 *   g1 #6b4a2f  22%  y 0.00-0.30  blob
 *
 * A reader — human or model — names the blade and the grip from that, with no
 * image. That is the hypothesis the whole feature rests on, and it is testable
 * before any model is involved.
 *
 * Lightness is deliberately DOWN-WEIGHTED in the clustering metric. A generated
 * asset's colour is shaded albedo: TRELLIS bakes lighting in, so one real
 * material spans a lightness ramp from lit to shadowed. A tight metric would
 * spend the whole group budget on the shading of a single steel blade, while
 * chroma is what actually separates leather from steel.
 *
 * ── Contract ────────────────────────────────────────────────────────────────
 *
 * Pure and deterministic: same bytes in, same signature out, byte for byte. No
 * `Math.random`, no seeded clustering, no iteration-order dependence. The `hash`
 * is what lets an assignment computed against one bake be REFUSED against
 * another, so the wire payload can be a tiny verdict list rather than the whole
 * palette.
 */

import { unpackRgb444 } from 'engine/VoxelOctreeRenderer.js';
import { atlasCellRepr } from 'engine/vxlscene/atlasColor.js';
import type { DecodedVxlV3 } from 'engine/VxlV3Format.js';

/** Bumped when the signature's SHAPE or derivation changes, invalidating stored ones. */
export const MATERIAL_SIGNATURE_VERSION = 1;

/** Groups beyond this are merged. ~16 keeps the whole table around 400 tokens. */
export const DEFAULT_MAX_GROUPS = 16;

/** Hard ceiling regardless of what a caller asks for. */
export const MAX_MATERIAL_GROUPS = 24;

/**
 * Groups holding less than this share of the volume are folded into their nearest
 * neighbour. Low, because an accent material is genuinely tiny — a gem in a hilt
 * is a fraction of a per cent and is the entire point of classifying it.
 */
export const DEFAULT_MIN_SHARE = 0.002;

/**
 * Merge threshold in the OKLab-derived metric below. Tuned so a shaded ramp of one
 * material collapses while two genuinely different materials do not.
 */
const MERGE_DISTANCE = 0.1;

/** How much a lightness difference counts, relative to a chroma difference. */
const LIGHTNESS_WEIGHT = 0.5;

/** Occupancy grid edge for the connected-component count. Bounded work, mixed-LOD safe. */
const BLOB_GRID = 32;

/** Components beyond this are not counted individually — "many" is the useful answer. */
const MAX_BLOBS = 9;

/**
 * The coarse shape of a group, as a WORD.
 *
 * A word, not the eigenvalue ratio it comes from, because that is what makes the
 * table readable: "thin-long" is what distinguishes a blade, and neither a person
 * nor a model reasons well about `λ1/λ2 = 7.3`.
 */
export type MaterialGroupShape = 'thin-long' | 'flat-shell' | 'blob' | 'scattered';

export interface MaterialGroupStats {
    /** `g0`…`gN`, ordered by descending share — the id an assignment refers to. */
    id: string;
    /** Representative sRGB hex, `#rrggbb`. */
    hex: string;
    /** The RGB444 palette cells merged into this group. */
    cells: number[];
    /** Share of total voxel VOLUME, 0..1, rounded to 3dp. */
    share: number;
    /** Vertical extent as [min, mean, max], normalised to the asset's bbox. */
    y: [number, number, number];
    /** Per-axis extent as a fraction of the asset's own bbox. */
    extent: [number, number, number];
    /** Mean distance from the asset's vertical centre axis, 0..1. */
    radial: number;
    /** The shape word above. */
    shape: MaterialGroupShape;
    /** Connected components on a coarse occupancy grid, capped at MAX_BLOBS. */
    blobs: number;
}

export interface MaterialSignature {
    version: number;
    /** FNV-1a over the normative fields — the identity an assignment is bound to. */
    hash: string;
    /** LOD0 voxel count (leaves, not volume). */
    voxelCount: number;
    /** Distinct palette entries before clustering. */
    paletteSize: number;
    /** Asset bbox in voxel units, for scale context. */
    bboxVoxels: [number, number, number];
    groups: MaterialGroupStats[];
    /** Named slots the asset ALREADY has. Never reassigned — see `planMaterialSlots`. */
    existingSlots: string[];
}

export interface MaterialSignatureOptions {
    maxGroups?: number;
    minShare?: number;
}

/** Per-cell accumulator, before clustering. */
interface CellStats {
    cell: number;
    lab: [number, number, number];
    weight: number;
    sum: [number, number, number];
    sumSq: [number, number, number];
    min: [number, number, number];
    max: [number, number, number];
}

/**
 * Build the signature of a decoded `.vxl`.
 *
 * Reads LOD0 only: it is the level the asset is authored at, and every coarser
 * level's palette is derived from it. Weighted by leaf VOLUME rather than leaf
 * count, because LOD0 is uniform on the voxel-native path but mixed on the GLB
 * path, and volume is the honest measure of "how much of this thing is that
 * colour" for both.
 */
export function buildMaterialSignature(
    dec: DecodedVxlV3,
    options: MaterialSignatureOptions = {},
): MaterialSignature {
    const maxGroups = Math.max(1, Math.min(options.maxGroups ?? DEFAULT_MAX_GROUPS, MAX_MATERIAL_GROUPS));
    const minShare = Math.max(0, options.minShare ?? DEFAULT_MIN_SHARE);

    const cells = collectCellStats(dec);
    const totalWeight = cells.reduce((sum, c) => sum + c.weight, 0);
    const bbox = assetBbox(dec);
    const voxelCount = dec.fragments.reduce((sum, f) => sum + f.leaves.count, 0);
    const existingSlots = (dec.slots ?? []).map((s) => s.name);

    if (cells.length === 0 || totalWeight === 0) {
        return {
            version: MATERIAL_SIGNATURE_VERSION,
            hash: fnv1a(`${MATERIAL_SIGNATURE_VERSION}|empty`),
            voxelCount, paletteSize: 0, bboxVoxels: bbox.sizeVoxels,
            groups: [], existingSlots,
        };
    }

    const merged = clusterCells(cells, maxGroups, minShare, totalWeight);
    const groups = merged
        .map((group) => describeGroup(group, totalWeight, bbox, dec))
        // Descending share, then by cell so ties are deterministic rather than
        // dependent on the merge order.
        .sort((a, b) => (b.share - a.share) || (a.cells[0]! - b.cells[0]!))
        .map((group, i) => ({ ...group, id: `g${i}` }));

    return {
        version: MATERIAL_SIGNATURE_VERSION,
        hash: signatureHash(groups),
        voxelCount,
        paletteSize: cells.length,
        bboxVoxels: bbox.sizeVoxels,
        groups,
        existingSlots,
    };
}

/**
 * The signature as the text a reader is actually given — the CLI prints this and
 * a model would be handed the same string.
 *
 * Kept beside the builder on purpose: if the table and the data were assembled in
 * two places they would drift, and a column that silently stopped matching its
 * header is the kind of bug that shows up as "the model got it wrong".
 */
export function formatMaterialSignatureTable(sig: MaterialSignature): string {
    if (sig.groups.length === 0) return '(no colours — the asset is empty)';
    const lines = [
        `${sig.voxelCount} voxels, ${sig.paletteSize} palette entries, `
        + `bbox ${sig.bboxVoxels.join('x')} voxels`,
        '',
        'id   colour   share  height(min-max)  extent(x,y,z)  radial  shape       parts',
    ];
    for (const g of sig.groups) {
        lines.push([
            g.id.padEnd(4),
            g.hex.padEnd(8),
            `${(g.share * 100).toFixed(1)}%`.padStart(6),
            `${g.y[0].toFixed(2)}-${g.y[2].toFixed(2)}`.padStart(16),
            `${g.extent.map((v) => v.toFixed(2)).join(',')}`.padStart(14),
            g.radial.toFixed(2).padStart(7),
            `  ${g.shape.padEnd(11)}`,
            String(g.blobs === MAX_BLOBS ? `${MAX_BLOBS}+` : g.blobs),
        ].join(' '));
    }
    if (sig.existingSlots.length > 0) {
        lines.push('', `Existing materials (left untouched): ${sig.existingSlots.join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * The group whose colour is nearest `cell`, or null when the signature is empty.
 *
 * Needed because a COARSER LOD's palette is not a subset of LOD0's: the GLB
 * voxelizer averages colours as it coarsens, so a coarse cell can be a shade that
 * appears nowhere in LOD0. Falling back to the nearest group means a material
 * never simply vanishes at a LOD switch — the artefact v8 of the format exists to
 * prevent, reappearing one level up if this were left to an exact lookup.
 */
export function nearestGroupId(
    sig: MaterialSignature,
    cell: number,
    useAtlas: boolean,
): string | null {
    if (sig.groups.length === 0) return null;
    const target = cellToOkLab(cell, useAtlas);
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const group of sig.groups) {
        // An exact member always wins, whatever the mean says.
        if (group.cells.includes(cell)) return group.id;
        const mean = meanLabOfCells(group.cells, useAtlas);
        const d = labDistance(target, mean);
        if (d < bestDistance) { bestDistance = d; best = group.id; }
    }
    return best;
}

/** Unweighted mean OKLab of a group's cells — recomputed rather than stored, since
 *  a signature has to survive JSON and a mean is cheap to derive from the cells. */
function meanLabOfCells(cells: readonly number[], useAtlas: boolean): [number, number, number] {
    const acc: [number, number, number] = [0, 0, 0];
    for (const cell of cells) {
        const lab = cellToOkLab(cell, useAtlas);
        for (let a = 0; a < 3; a++) acc[a] = acc[a]! + lab[a]!;
    }
    const n = Math.max(1, cells.length);
    return [acc[0]! / n, acc[1]! / n, acc[2]! / n];
}

/** Per-palette-cell geometry, accumulated over LOD0's leaves. */
function collectCellStats(dec: DecodedVxlV3): CellStats[] {
    const byCell = new Map<number, CellStats>();
    const min = dec.minVoxelSize > 0 ? dec.minVoxelSize : 1;
    for (const fragment of dec.fragments) {
        const buf = fragment.leaves;
        for (let i = 0; i < buf.count; i++) {
            const cell = buf.color[i]!;
            const size = buf.worldSize(i);
            // Volume in units of the smallest leaf, so a coarse leaf counts for the
            // many fine ones it stands in for.
            const ratio = size / min;
            const weight = ratio * ratio * ratio;
            // Leaf CENTRE, so a coarse leaf is not reported at its corner.
            const half = size / 2;
            const p: [number, number, number] = [
                buf.worldX(i) + half, buf.worldY(i) + half, buf.worldZ(i) + half,
            ];
            let stats = byCell.get(cell);
            if (!stats) {
                stats = {
                    cell,
                    lab: cellToOkLab(cell, dec.useAtlas),
                    weight: 0,
                    sum: [0, 0, 0],
                    sumSq: [0, 0, 0],
                    min: [Infinity, Infinity, Infinity],
                    max: [-Infinity, -Infinity, -Infinity],
                };
                byCell.set(cell, stats);
            }
            stats.weight += weight;
            for (let a = 0; a < 3; a++) {
                stats.sum[a] = stats.sum[a]! + p[a]! * weight;
                stats.sumSq[a] = stats.sumSq[a]! + p[a]! * p[a]! * weight;
                if (p[a]! < stats.min[a]!) stats.min[a] = p[a]!;
                if (p[a]! > stats.max[a]!) stats.max[a] = p[a]!;
            }
        }
    }
    // Sorted by cell so the clustering below starts from a stable order regardless
    // of Map insertion order — part of the determinism contract.
    return [...byCell.values()].sort((a, b) => a.cell - b.cell);
}

/** A merged group of cells, with the same accumulators summed. */
interface CellGroup {
    cells: CellStats[];
    weight: number;
    lab: [number, number, number];
}

function groupOf(cell: CellStats): CellGroup {
    return { cells: [cell], weight: cell.weight, lab: [...cell.lab] as [number, number, number] };
}

/**
 * Greedy agglomerative clustering, seeded by descending weight.
 *
 * Deliberately not k-means: this has to be DETERMINISTIC, and k-means needs a
 * seed. Greedy merging from the heaviest cell outward gives a stable answer and,
 * because the heaviest cells are the real materials, tends to build groups around
 * them rather than around noise.
 */
function clusterCells(
    cells: CellStats[], maxGroups: number, minShare: number, totalWeight: number,
): CellGroup[] {
    const order = [...cells].sort((a, b) => (b.weight - a.weight) || (a.cell - b.cell));
    const groups: CellGroup[] = [];
    for (const cell of order) {
        let best: CellGroup | null = null;
        let bestDistance = Infinity;
        for (const group of groups) {
            const d = labDistance(cell.lab, group.lab);
            if (d < bestDistance) { bestDistance = d; best = group; }
        }
        if (best && bestDistance <= MERGE_DISTANCE) {
            absorb(best, groupOf(cell));
        } else {
            groups.push(groupOf(cell));
        }
    }

    // Over budget: merge the closest remaining pair until it fits. Closest pair
    // rather than smallest group, so the merge that loses the least detail wins.
    while (groups.length > maxGroups) {
        let a = 0, b = 1, bestDistance = Infinity;
        for (let i = 0; i < groups.length; i++) {
            for (let j = i + 1; j < groups.length; j++) {
                const d = labDistance(groups[i]!.lab, groups[j]!.lab);
                if (d < bestDistance) { bestDistance = d; a = i; b = j; }
            }
        }
        absorb(groups[a]!, groups[b]!);
        groups.splice(b, 1);
    }

    // Fold away the specks LAST, so a tiny group has already had its chance to
    // merge into a perceptually close neighbour rather than an arbitrary one.
    for (let i = groups.length - 1; i >= 0 && groups.length > 1; i--) {
        if (groups[i]!.weight / totalWeight >= minShare) continue;
        let nearest = -1, bestDistance = Infinity;
        for (let j = 0; j < groups.length; j++) {
            if (j === i) continue;
            const d = labDistance(groups[i]!.lab, groups[j]!.lab);
            if (d < bestDistance) { bestDistance = d; nearest = j; }
        }
        if (nearest < 0) continue;
        absorb(groups[nearest]!, groups[i]!);
        groups.splice(i, 1);
    }
    return groups;
}

/** Merge `from` into `into`, keeping the weighted-mean colour. */
function absorb(into: CellGroup, from: CellGroup): void {
    const total = into.weight + from.weight;
    if (total > 0) {
        for (let a = 0; a < 3; a++) {
            into.lab[a] = (into.lab[a]! * into.weight + from.lab[a]! * from.weight) / total;
        }
    }
    into.weight = total;
    into.cells.push(...from.cells);
}

/** The asset's own bounding box, in world units and in voxel counts. */
function assetBbox(dec: DecodedVxlV3): {
    min: [number, number, number];
    size: [number, number, number];
    sizeVoxels: [number, number, number];
} {
    const b = dec.bounds;
    const size: [number, number, number] = [
        Math.max(b.maxX - b.minX, 1e-6),
        Math.max(b.maxY - b.minY, 1e-6),
        Math.max(b.maxZ - b.minZ, 1e-6),
    ];
    const v = dec.minVoxelSize > 0 ? dec.minVoxelSize : 1;
    return {
        min: [b.minX, b.minY, b.minZ],
        size,
        sizeVoxels: [
            Math.round(size[0] / v), Math.round(size[1] / v), Math.round(size[2] / v),
        ],
    };
}

function describeGroup(
    group: CellGroup,
    totalWeight: number,
    bbox: ReturnType<typeof assetBbox>,
    dec: DecodedVxlV3,
): Omit<MaterialGroupStats, 'id'> {
    let weight = 0;
    const sum: [number, number, number] = [0, 0, 0];
    const sumSq: [number, number, number] = [0, 0, 0];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const cell of group.cells) {
        weight += cell.weight;
        for (let a = 0; a < 3; a++) {
            sum[a] = sum[a]! + cell.sum[a]!;
            sumSq[a] = sumSq[a]! + cell.sumSq[a]!;
            if (cell.min[a]! < min[a]!) min[a] = cell.min[a]!;
            if (cell.max[a]! > max[a]!) max[a] = cell.max[a]!;
        }
    }
    const safeWeight = weight > 0 ? weight : 1;

    // Normalise into the asset's own box, so every number is comparable across
    // assets of wildly different scale.
    const norm = (value: number, axis: number): number =>
        clamp01((value - bbox.min[axis]!) / bbox.size[axis]!);
    const mean: [number, number, number] = [
        sum[0]! / safeWeight, sum[1]! / safeWeight, sum[2]! / safeWeight,
    ];
    const variance: [number, number, number] = [0, 1, 2].map((a) =>
        Math.max(0, sumSq[a]! / safeWeight - mean[a]! * mean[a]!)) as [number, number, number];

    // Weighted-mean colour back to a real cell, so the hex names a colour the
    // asset actually contains rather than an average that appears nowhere.
    const representative = nearestCellByLab(group);

    return {
        hex: cellToHex(representative, dec.useAtlas),
        cells: group.cells.map((c) => c.cell).sort((a, b) => a - b),
        share: round3(weight / totalWeight),
        y: [round2(norm(min[1]!, 1)), round2(norm(mean[1]!, 1)), round2(norm(max[1]!, 1))],
        extent: [
            round2(clamp01((max[0]! - min[0]!) / bbox.size[0]!)),
            round2(clamp01((max[1]! - min[1]!) / bbox.size[1]!)),
            round2(clamp01((max[2]! - min[2]!) / bbox.size[2]!)),
        ],
        radial: round2(radialMean(group, bbox)),
        shape: shapeOf(variance, bbox.size),
        blobs: countBlobs(group, bbox),
    };
}

/**
 * Mean horizontal distance from the asset's vertical centre axis, 0..1.
 *
 * Separates a core from a shell: a shaft down the middle of a lamp post reads near
 * 0, the rim of a wheel near 1, and that is a distinction colour cannot make.
 */
function radialMean(group: CellGroup, bbox: ReturnType<typeof assetBbox>): number {
    const cx = bbox.min[0]! + bbox.size[0]! / 2;
    const cz = bbox.min[2]! + bbox.size[2]! / 2;
    const halfX = bbox.size[0]! / 2;
    const halfZ = bbox.size[2]! / 2;
    let weight = 0;
    let sum = 0;
    for (const cell of group.cells) {
        if (cell.weight <= 0) continue;
        const mx = cell.sum[0]! / cell.weight;
        const mz = cell.sum[2]! / cell.weight;
        const dx = (mx - cx) / halfX;
        const dz = (mz - cz) / halfZ;
        sum += Math.min(1, Math.hypot(dx, dz)) * cell.weight;
        weight += cell.weight;
    }
    return weight > 0 ? sum / weight : 0;
}

/**
 * The shape word, from how the group's mass is spread along each axis.
 *
 * Standard deviations rather than the raw bbox, so a few stray voxels do not turn
 * a compact group into a sprawling one — which is the difference between "the
 * blade" and "dithering scattered over the whole model".
 */
function shapeOf(
    variance: [number, number, number],
    size: [number, number, number],
): MaterialGroupShape {
    // Relative to the asset's own extent, so the words mean the same thing on a
    // sword and on a cathedral.
    const spread = [0, 1, 2]
        .map((a) => Math.sqrt(variance[a]!) / size[a]!)
        .sort((a, b) => b - a) as [number, number, number];
    const [major, mid, minor] = spread;
    // A uniform distribution over a full axis has sd ≈ 0.29, so this is "spread
    // over most of the model in every direction".
    if (minor > 0.18) return 'scattered';
    if (major < 1e-6) return 'blob';
    if (mid / major < 0.35) return 'thin-long';
    if (minor / major < 0.25) return 'flat-shell';
    return 'blob';
}

/**
 * Connected components of the group's occupancy on a coarse grid.
 *
 * The speckle detector: a colour that is dithered across the whole model comes
 * back as many components and is almost never a material of its own, while a real
 * one — a blade, a band of trim — is one or two. Run on a fixed 32³ rasterisation
 * so the cost is bounded and mixed leaf sizes resolve the same way.
 */
function countBlobs(group: CellGroup, bbox: ReturnType<typeof assetBbox>): number {
    const cellsInGroup = new Set(group.cells.map((c) => c.cell));
    if (cellsInGroup.size === 0) return 0;
    // Rasterise from the per-cell bounding boxes: the exact leaf list is not kept
    // per cell (that would be a second pass over every leaf per group), and a
    // component count only needs occupancy at this resolution.
    const grid = new Uint8Array(BLOB_GRID * BLOB_GRID * BLOB_GRID);
    const idx = (x: number, y: number, z: number): number =>
        (z * BLOB_GRID + y) * BLOB_GRID + x;
    const cellIndex = (value: number, axis: number): number => Math.max(0, Math.min(
        BLOB_GRID - 1,
        Math.floor(((value - bbox.min[axis]!) / bbox.size[axis]!) * BLOB_GRID),
    ));
    for (const cell of group.cells) {
        if (cell.weight <= 0) continue;
        const x0 = cellIndex(cell.min[0]!, 0), x1 = cellIndex(cell.max[0]!, 0);
        const y0 = cellIndex(cell.min[1]!, 1), y1 = cellIndex(cell.max[1]!, 1);
        const z0 = cellIndex(cell.min[2]!, 2), z1 = cellIndex(cell.max[2]!, 2);
        for (let z = z0; z <= z1; z++) {
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) grid[idx(x, y, z)] = 1;
            }
        }
    }

    let components = 0;
    const stack: number[] = [];
    for (let z = 0; z < BLOB_GRID; z++) {
        for (let y = 0; y < BLOB_GRID; y++) {
            for (let x = 0; x < BLOB_GRID; x++) {
                const start = idx(x, y, z);
                if (grid[start] !== 1) continue;
                components++;
                if (components >= MAX_BLOBS) return MAX_BLOBS;
                grid[start] = 2;
                stack.push(x, y, z);
                while (stack.length > 0) {
                    const cz = stack.pop()!, cy = stack.pop()!, cx = stack.pop()!;
                    for (const [dx, dy, dz] of NEIGHBOURS) {
                        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
                        if (nx < 0 || ny < 0 || nz < 0) continue;
                        if (nx >= BLOB_GRID || ny >= BLOB_GRID || nz >= BLOB_GRID) continue;
                        const n = idx(nx, ny, nz);
                        if (grid[n] !== 1) continue;
                        grid[n] = 2;
                        stack.push(nx, ny, nz);
                    }
                }
            }
        }
    }
    return components;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** The group member closest to its mean colour — a cell the asset really has. */
function nearestCellByLab(group: CellGroup): number {
    let best = group.cells[0]!.cell;
    let bestDistance = Infinity;
    for (const cell of group.cells) {
        const d = labDistance(cell.lab, group.lab);
        if (d < bestDistance) { bestDistance = d; best = cell.cell; }
    }
    return best;
}

/** A stored cell's sRGB bytes — the same interpretation the renderer uses. */
function cellToSrgb(cell: number, useAtlas: boolean): [number, number, number] {
    if (useAtlas) {
        const repr = atlasCellRepr(cell);
        return [repr.r, repr.g, repr.b];
    }
    // A vertex-colour asset stores LINEAR RGB444, so encode for display.
    const { r, g, b } = unpackRgb444(cell);
    return [srgbByte(r), srgbByte(g), srgbByte(b)];
}

function cellToHex(cell: number, useAtlas: boolean): string {
    const [r, g, b] = cellToSrgb(cell, useAtlas);
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Linear 0..1 → sRGB byte, the standard OETF. */
function srgbByte(value: number): number {
    const v = clamp01(value);
    const encoded = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

/**
 * A stored cell in OKLab.
 *
 * OKLab because the clustering has to match how a person would group these
 * colours, and sRGB distance does not: it puts two dark browns further apart than
 * two bright greens that read as one colour. Implemented locally — the engine has
 * no colour-appearance helper, and this is the only caller.
 */
function cellToOkLab(cell: number, useAtlas: boolean): [number, number, number] {
    const [r8, g8, b8] = cellToSrgb(cell, useAtlas);
    const r = srgbToLinear(r8 / 255);
    const g = srgbToLinear(g8 / 255);
    const b = srgbToLinear(b8 / 255);

    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function srgbToLinear(value: number): number {
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/**
 * Perceptual distance with lightness DOWN-WEIGHTED — the file header explains
 * why: a generated asset's albedo already has lighting baked into it, so one
 * material spans a lightness ramp and chroma is the signal that separates
 * materials.
 */
function labDistance(a: readonly number[], b: readonly number[]): number {
    const dl = (a[0]! - b[0]!) * LIGHTNESS_WEIGHT;
    const da = a[1]! - b[1]!;
    const db = a[2]! - b[2]!;
    return Math.hypot(dl, da, db);
}

/**
 * FNV-1a over the fields an assignment's validity depends on.
 *
 * Deliberately NOT over everything: the ids, representative cells and shares are
 * what a verdict list refers to, so a change in any of them means an assignment
 * no longer describes this asset. Purely descriptive fields are left out so a
 * tweak to, say, the shape heuristic does not invalidate stored assignments.
 */
function signatureHash(groups: ReadonlyArray<Omit<MaterialGroupStats, 'id'> & { id: string }>): string {
    const parts = [String(MATERIAL_SIGNATURE_VERSION)];
    for (const g of groups) {
        parts.push(`${g.id}:${g.cells.join('.')}:${g.share.toFixed(3)}`);
    }
    return fnv1a(parts.join('|'));
}

function fnv1a(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        // 32-bit FNV prime multiply, kept in range without BigInt.
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
