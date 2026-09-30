/**
 * Ground-mask baker — rasterizes the GROUND-TYPED objects' (level-transformed)
 * triangles into one world-level 2D grid: a ground-type byte plus a quantized
 * top-surface Y per cell. Stored as the optional VxlScene v6 section and
 * consumed at runtime by the ground-detail system (cobble domes, grass cover).
 *
 * Typing is node-keyed (`objectGroundTypes`), so the mask derives from the
 * exact triangles the level bakes — no separate vector payload to drift from
 * the rendered geometry. Per cell the HIGHEST typed surface wins; untyped
 * geometry (buildings, props) never participates, and the runtime instead
 * rejects cells whose visible top surface sits away from the mask's topY
 * (roofs, bridge decks).
 */

import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { VxlWorldBounds } from 'engine/VxlWorldFormat.js';

/** Default mask cell size (m). Coarser than the voxel grid on purpose: stones and
 *  tufts are ~0.5 m features, and a byte+uint16 per 0.5 m cell keeps the section
 *  a few MB even on a 1 km city (it also gzips to almost nothing at rest). */
export const GROUND_MASK_CELL_M = 0.5;

/** topY quantization step (m): topY = heightQ * GROUND_MASK_HEIGHT_STEP. 0 = empty. */
export const GROUND_MASK_HEIGHT_STEP = 0.05;

/** Near-vertical triangles (kerb walls, fences) must not type ground cells. */
const MIN_UP_NORMAL_Y = 0.3;

export interface GroundMaskData {
    /** Cell size in meters. */
    cellSize: number;
    /** Grid extent in cells along X / Z, from bounds.minX / bounds.minZ. */
    width: number;
    height: number;
    /** Per-cell GROUND_TYPE byte (width*height, row-major: index = cz*width + cx). */
    types: Uint8Array;
    /** Per-cell quantized top-surface Y (topY / GROUND_MASK_HEIGHT_STEP, 0 = no data). */
    topY: Uint16Array;
}

/** World (x, z) → cell index into a mask, or -1 outside. Shared with the runtime. */
export function groundMaskCellIndex(mask: GroundMaskData, x: number, z: number, minX: number, minZ: number): number {
    const cx = Math.floor((x - minX) / mask.cellSize);
    const cz = Math.floor((z - minZ) / mask.cellSize);
    if (cx < 0 || cz < 0 || cx >= mask.width || cz >= mask.height) return -1;
    return cz * mask.width + cx;
}

/**
 * Ground-surface type byte at a world point, or 0 (untyped) when the point is
 * outside the mask, nothing typed that cell, or the point sits further than
 * `tolerance` metres from the cell's top surface. The mask stores ONE type per
 * column, so that height window is what stops a bridge deck — or a car mid-jump —
 * from inheriting the material below it. Pass `Infinity` to ignore height.
 *
 * Pure and mask-only (no THREE, no world object) so both the runtime terrain
 * system and its tests exercise this exact code.
 */
export function groundTypeAtPoint(
    mask: GroundMaskData,
    minX: number,
    minZ: number,
    x: number,
    y: number,
    z: number,
    tolerance: number,
): number {
    const idx = groundMaskCellIndex(mask, x, z, minX, minZ);
    if (idx < 0) return 0;
    const heightQ = mask.topY[idx] ?? 0;
    if (heightQ === 0) return 0; // no surface data for this cell
    // topY is absolute world Y, quantized (same convention GroundDetailSystem uses).
    if (Number.isFinite(tolerance) && Math.abs(y - heightQ * GROUND_MASK_HEIGHT_STEP) > tolerance) return 0;
    return mask.types[idx] ?? 0;
}

/** What a ground-type edit touched: cell count plus the world-space XZ box to refresh. */
export interface GroundPaintResult {
    /** Cells whose type actually changed (cells already at the target count 0). */
    changed: number;
    /** World-space bounds of the changed cells; degenerate when `changed` is 0. */
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
}

/**
 * Repaint mask cells inside a world-space XZ box (optionally narrowed by `inside`,
 * e.g. a circle) and report what changed.
 *
 * Two cells are deliberately skipped: one already at `type` (so re-mowing cut grass
 * scores nothing and triggers no repaint), and one with no surface data — `topY` 0
 * means no geometry was rasterized there, and painting it would invent ground.
 * `onlyReplacing` restricts the edit to a single existing material.
 *
 * Pure (mask + numbers only) so the mowing contract is unit-testable without a
 * renderer; `VxlSceneTerrainSystem` wraps it and refreshes the affected cover.
 */
export function paintGroundTypeInMask(
    mask: GroundMaskData,
    originX: number,
    originZ: number,
    box: { minX: number; minZ: number; maxX: number; maxZ: number },
    type: number,
    onlyReplacing: number | undefined,
    inside: ((cellCenterX: number, cellCenterZ: number) => boolean) | null,
): GroundPaintResult {
    const cell = mask.cellSize;
    const gx0 = Math.max(0, Math.floor((box.minX - originX) / cell));
    const gz0 = Math.max(0, Math.floor((box.minZ - originZ) / cell));
    const gx1 = Math.min(mask.width - 1, Math.floor((box.maxX - originX) / cell));
    const gz1 = Math.min(mask.height - 1, Math.floor((box.maxZ - originZ) / cell));

    const out: GroundPaintResult = { changed: 0, minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    for (let gz = gz0; gz <= gz1; gz++) {
        const cz = originZ + (gz + 0.5) * cell;
        for (let gx = gx0; gx <= gx1; gx++) {
            const cx = originX + (gx + 0.5) * cell;
            if (inside && !inside(cx, cz)) continue;
            const idx = gz * mask.width + gx;
            if ((mask.topY[idx] ?? 0) === 0) continue;
            const current = mask.types[idx] ?? 0;
            if (current === type) continue;
            if (onlyReplacing !== undefined && current !== onlyReplacing) continue;
            mask.types[idx] = type;
            out.changed++;
            if (cx - cell / 2 < out.minX) out.minX = cx - cell / 2;
            if (cx + cell / 2 > out.maxX) out.maxX = cx + cell / 2;
            if (cz - cell / 2 < out.minZ) out.minZ = cz - cell / 2;
            if (cz + cell / 2 > out.maxZ) out.maxZ = cz + cell / 2;
        }
    }
    return out;
}

/**
 * Rasterize the typed nodes' triangles into a fresh mask. Returns null when no
 * node is typed or nothing lands in bounds. Pure — unit-tested without GLB.
 */
export function bakeGroundMask(
    triangles: readonly RasterTriangle[],
    typeByNode: Record<string, number>,
    bounds: VxlWorldBounds,
    cellSize: number = GROUND_MASK_CELL_M,
): GroundMaskData | null {
    const typedNames = Object.keys(typeByNode).filter((n) => (typeByNode[n] ?? 0) !== 0);
    if (typedNames.length === 0) return null;

    const width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
    const height = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cellSize));
    const types = new Uint8Array(width * height);
    const topY = new Uint16Array(width * height);
    // Unquantized best-Y per cell, so ties resolve consistently before rounding.
    const bestY = new Float32Array(width * height).fill(-Infinity);

    let any = false;
    for (const t of triangles) {
        const type = typeByNode[t.nodeName] ?? 0;
        if (type === 0) continue;
        if (Math.abs(t.normal[1]) < MIN_UP_NORMAL_Y) continue; // wall, not ground

        const [ax, ay, az] = t.v0;
        const [bx, by, bz] = t.v1;
        const [cx2, cy2, cz2] = t.v2;
        const minX = Math.min(ax, bx, cx2), maxX = Math.max(ax, bx, cx2);
        const minZ = Math.min(az, bz, cz2), maxZ = Math.max(az, bz, cz2);
        const gx0 = Math.max(0, Math.floor((minX - bounds.minX) / cellSize));
        const gx1 = Math.min(width - 1, Math.floor((maxX - bounds.minX) / cellSize));
        const gz0 = Math.max(0, Math.floor((minZ - bounds.minZ) / cellSize));
        const gz1 = Math.min(height - 1, Math.floor((maxZ - bounds.minZ) / cellSize));
        if (gx1 < gx0 || gz1 < gz0) continue;

        // 2D barycentric setup on the XZ projection.
        const v0x = bx - ax, v0z = bz - az;
        const v1x = cx2 - ax, v1z = cz2 - az;
        const den = v0x * v1z - v1x * v0z;
        if (Math.abs(den) < 1e-12) continue; // degenerate in plan view

        for (let gz = gz0; gz <= gz1; gz++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const px = bounds.minX + (gx + 0.5) * cellSize;
                const pz = bounds.minZ + (gz + 0.5) * cellSize;
                const dx = px - ax, dz = pz - az;
                const u = (dx * v1z - v1x * dz) / den;
                const v = (v0x * dz - dx * v0z) / den;
                // Small negative tolerance so cells whose center kisses a shared
                // triangle edge aren't dropped by float noise.
                if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
                const y = ay + u * (by - ay) + v * (cy2 - ay);
                const idx = gz * width + gx;
                if (y > bestY[idx]!) {
                    bestY[idx] = y;
                    types[idx] = type;
                    // heightQ 0 means "no data", so floor at 1 (y ≤ 0 surfaces still count).
                    const q = Math.round(y / GROUND_MASK_HEIGHT_STEP);
                    topY[idx] = Math.max(1, Math.min(65535, q));
                    any = true;
                }
            }
        }
    }

    return any ? { cellSize, width, height, types, topY } : null;
}
