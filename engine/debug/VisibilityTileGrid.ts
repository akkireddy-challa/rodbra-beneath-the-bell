/**
 * Uniform 3D tile grid used as the shared visibility unit for PVS bakes.
 *
 * Both the voxel-chunk culler and the splat culler key off the same tiles:
 * "from this walkable cell, which tile IDs are potentially visible?" A
 * voxel chunk or splat octree node maps to one-or-more overlapping tiles
 * at runtime, and is hidden iff none of those tiles are in the cell's
 * PVS set.
 *
 * **Default size is 2 m.** Rationale: UE Precomputed Visibility recommends
 * 0.5–2 m, Source's auto-split caps at ≈19.5 m, Quake's leaves vary but
 * settle around player-scale. 2 m gives sub-room parallax granularity
 * without exploding the bitset size — a 100 m scene at 2 m tiles has
 * ≤125k potential tiles but only a few thousand populated.
 *
 * **Tile-ID packing is 8 bits per axis** (24 bits total, +128 offset),
 * which fits cleanly in an RGB8 framebuffer for the GPU-rasterizer bake.
 * Max range is ±128 tiles → ±256 m at 2 m tiles. That covers any
 * scene we plausibly handle in the editor; if you ever need bigger,
 * switch the render target to R32UI and widen the pack.
 */
export interface TileGridBounds {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

/** Signed tile coordinate (one axis). Range is the same on each axis. */
export type TileAxis = number;

export const TILE_ID_OFFSET = 128;
export const TILE_ID_MAX = 255;
export const DEFAULT_TILE_SIZE = 2.0;

/**
 * Pack signed tile coords (each in [-128, 127]) into a single uint32 that
 * round-trips through an RGB8 framebuffer pixel. R = tx+OFF, G = ty+OFF,
 * B = tz+OFF. Alpha is reserved for the "is this a real tile?" flag (the
 * cleared background pixel reads back as A=0).
 */
export function packTileKey(tx: TileAxis, ty: TileAxis, tz: TileAxis): number {
    return ((tz + TILE_ID_OFFSET) << 16) | ((ty + TILE_ID_OFFSET) << 8) | (tx + TILE_ID_OFFSET);
}

/** Inverse of {@link packTileKey}. */
export function unpackTileKey(packed: number): { tx: TileAxis; ty: TileAxis; tz: TileAxis } {
    return {
        tx: (packed & 0xFF) - TILE_ID_OFFSET,
        ty: ((packed >>> 8) & 0xFF) - TILE_ID_OFFSET,
        tz: ((packed >>> 16) & 0xFF) - TILE_ID_OFFSET,
    };
}

/**
 * Decode an RGBA8 pixel from the bake framebuffer back to a tile key.
 * Returns null when the pixel was a background clear (alpha < 128).
 */
export function decodePixelToTileKey(r: number, g: number, b: number, a: number): number | null {
    if (a < 128) return null;
    return ((b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Tile grid spanning a world AABB. Stateless math wrapper — the actual
 * PVS data lives in WalkableMapVisualizer; this just answers "which tile
 * does this world point belong to" and "which tiles does this AABB
 * overlap".
 */
export class VisibilityTileGrid {
    readonly tileSize: number;
    readonly originX: number;
    readonly originY: number;
    readonly originZ: number;

    constructor(bounds: TileGridBounds, tileSize: number = DEFAULT_TILE_SIZE) {
        if (tileSize <= 0) throw new Error('[TileGrid] tileSize must be > 0');
        this.tileSize = tileSize;
        // Anchor the grid at world bounds so tile (0,0,0) sits at the
        // bounds minimum corner. Keeps tile coords small for typical
        // scenes whose bounds.min is near the origin.
        this.originX = bounds.minX;
        this.originY = bounds.minY;
        this.originZ = bounds.minZ;
    }

    /** World point → tile coords. Floor division. */
    worldToTile(x: number, y: number, z: number): { tx: TileAxis; ty: TileAxis; tz: TileAxis } {
        return {
            tx: Math.floor((x - this.originX) / this.tileSize),
            ty: Math.floor((y - this.originY) / this.tileSize),
            tz: Math.floor((z - this.originZ) / this.tileSize),
        };
    }

    /** Same as worldToTile but returns the packed key directly. */
    worldToTileKey(x: number, y: number, z: number): number {
        const t = this.worldToTile(x, y, z);
        return packTileKey(t.tx, t.ty, t.tz);
    }

    /** Tile coords → world AABB (min corner, max corner). */
    tileAabb(tx: TileAxis, ty: TileAxis, tz: TileAxis): { min: [number, number, number]; max: [number, number, number] } {
        const x0 = this.originX + tx * this.tileSize;
        const y0 = this.originY + ty * this.tileSize;
        const z0 = this.originZ + tz * this.tileSize;
        return {
            min: [x0, y0, z0],
            max: [x0 + this.tileSize, y0 + this.tileSize, z0 + this.tileSize],
        };
    }

    /**
     * Enumerate every tile that overlaps a world-space AABB. Used by the
     * voxel-chunk culler to decide whether any of a chunk's tiles are in
     * the current PVS set — chunk is hidden iff none are.
     */
    tilesOverlappingAabb(
        minX: number, minY: number, minZ: number,
        maxX: number, maxY: number, maxZ: number,
        out: number[] = [],
    ): number[] {
        const tx0 = Math.floor((minX - this.originX) / this.tileSize);
        const ty0 = Math.floor((minY - this.originY) / this.tileSize);
        const tz0 = Math.floor((minZ - this.originZ) / this.tileSize);
        // Subtract a tiny epsilon so an AABB whose max sits exactly on a
        // tile boundary doesn't pick up an empty neighbour. The voxel
        // chunk's maxXYZ are open intervals in our internal convention.
        const eps = this.tileSize * 1e-6;
        const tx1 = Math.floor((maxX - eps - this.originX) / this.tileSize);
        const ty1 = Math.floor((maxY - eps - this.originY) / this.tileSize);
        const tz1 = Math.floor((maxZ - eps - this.originZ) / this.tileSize);
        // Tile coords outside ±128 don't round-trip through the 8-bit-
        // per-axis packed key (byte wraparound would collide with a
        // legitimate in-range tile). Skip them entirely — the shader
        // discards their fragments anyway, so they couldn't appear in
        // the PVS set; recording a wrong key would just produce false
        // matches.
        for (let tz = tz0; tz <= tz1; tz++) {
            if (tz < -TILE_ID_OFFSET || tz > TILE_ID_MAX - TILE_ID_OFFSET) continue;
            for (let ty = ty0; ty <= ty1; ty++) {
                if (ty < -TILE_ID_OFFSET || ty > TILE_ID_MAX - TILE_ID_OFFSET) continue;
                for (let tx = tx0; tx <= tx1; tx++) {
                    if (tx < -TILE_ID_OFFSET || tx > TILE_ID_MAX - TILE_ID_OFFSET) continue;
                    out.push(packTileKey(tx, ty, tz));
                }
            }
        }
        return out;
    }
}
