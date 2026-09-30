/**
 * Shared types for the GLB scene voxelizer (design §3, §4).
 * Every vxlscene module depends on these contracts.
 */

/** RGB in [0,1] linear space. */
export interface RGB { r: number; g: number; b: number; }

/** One displacement axis for smooth surfaces (design §6.3). */
export type DisplacementAxis = 'x' | 'y' | 'z';

/** Per-object bake controls, resolved from the public options maps (design §3.3, §6). */
export interface ObjectControls {
    /** Power-of-two voxel-size exponent (design §6.1). 0 = default. */
    lodOffset: number;
    /** Keep finest detail at every LOD (design §6.2). */
    pinned: boolean;
    /** Collide via original triangles, not voxels (design §6.4). */
    trimeshCollider: boolean;
    /**
     * Object is purely visual: its voxels/quads are excluded from ALL collision
     * (no voxel collider, no quad collider, no trimesh). For decorative geometry
     * like painted road lines that must not be a step the player/AI collides with.
     */
    noCollider: boolean;
    collisionOnly: boolean;
    /** Single-axis sub-cell displacement, or null for grid-aligned (design §6.3). */
    displacementAxis: DisplacementAxis | null;
}

export const DEFAULT_OBJECT_CONTROLS: ObjectControls = {
    lodOffset: 0,
    pinned: false,
    trimeshCollider: false,
    noCollider: false,
    collisionOnly: false,
    displacementAxis: null,
};

/**
 * Make a node's controls consistent, collision-only winning. A collision-only
 * node is collided as a trimesh and never rendered (bakeScene's collider bin
 * takes it beside `trimeshCollider`, its triangles leave the render set), so a
 * `trimeshCollider` beside it is redundant, a `noCollider` contradicts it, and
 * a `displacementAxis` shapes a surface nobody sees. Each is dropped with a
 * warning naming the node. This used to THROW, and the first forged spaceship
 * died on it: the world forger handed its invisible catch plate both flags,
 * and a whole paid design and geometry produced no level over a redundant
 * boolean. The intent is unambiguous, so the bake proceeds.
 */
export function validateObjectControls(
    nodeName: string,
    controls: ObjectControls,
): void {
    if (!controls.collisionOnly) return;
    const dropped: string[] = [];
    if (controls.noCollider) { controls.noCollider = false; dropped.push('noCollider'); }
    if (controls.trimeshCollider) { controls.trimeshCollider = false; dropped.push('trimeshCollider'); }
    if (controls.displacementAxis !== null) { controls.displacementAxis = null; dropped.push('displacementAxis'); }
    if (dropped.length === 0) return;
    console.warn(`ObjectControls for "${nodeName}": collisionOnly conflicts with ${dropped.join(', ')}; dropped ${dropped.join(', ')} (collision-only already collides as a trimesh and never renders)`);
}

/** A surface/interior min-cell in the per-chunk attribute grid (design §3.5). */
export interface CellAttr {
    /** Palette color (linear RGB). */
    color: RGB;
    /** Unit surface normal accumulated from the owning triangles (zero for interior). */
    nx: number; ny: number; nz: number;
    /** True for interior-fill cells (design §3.6); false for surface cells. */
    interior: boolean;
    /** Excluded from voxel-derived collider (owner is a trimesh object, design §6.4). */
    noCollider: boolean;
    /**
     * Owner object is LOD-pinned (design §6.2): this cell keeps its FINEST detail at
     * every LOD. Coarse-LOD baking meshes pinned cells at min-cell resolution rather
     * than downsampling them. Always false for interior-fill and downsampled cells.
     */
    pinned: boolean;
    /** Displacement axis carried from the owning object, or null. */
    displacementAxis: DisplacementAxis | null;
    /**
     * Signed fraction in [-1,1] of a min-cell, along `displacementAxis`, by which
     * this cell's surface-facing face is nudged toward the true surface (design §3.8).
     * 0 when not displaced (`displacementAxis` null).
     */
    dispOffset: number;
}

/** A compacted variable-size voxel (design §3.7). Grid coords are in min-cell units. */
export interface SceneVoxel {
    gx: number; gy: number; gz: number;
    /** Edge length = minVoxelSize * 2^sizeLevel. */
    sizeLevel: number;
    color: RGB;
    noCollider: boolean;
    /** Sub-cell displacement in min-cell units (design §3.8), or null. */
    disp: { dx: number; dy: number; dz: number } | null;
}

/** One greedy-meshed face rectangle (design §3.9). The static render hint is SceneQuad[]. */
export interface SceneQuad {
    /** Origin corner in min-cell grid coords. */
    gx: number; gy: number; gz: number;
    /** Extents (>=1) in min-cell units in the two axes of the face plane. */
    w: number; h: number;
    /** Face axis 0=X,1=Y,2=Z and direction (+1 / -1). */
    axis: 0 | 1 | 2;
    dir: 1 | -1;
    color: RGB;
    /** Per-corner displacement along `axis` in min-cell units (design §3.8), all 0 for grid faces. */
    disp: number;
    /**
     * Owner object is collision-excluded (decoration). Packed into bit 6 of the
     * axisDir byte at encode; the quad collider skips these, the renderer keeps
     * drawing them. Absent ⇒ collidable. Render hint is unaffected.
     */
    noCollider?: boolean;
    /**
     * Source object's lodOffset (0–7; absent ⇒ 0): how many power-of-two steps
     * COARSER than the world min voxel this quad was baked at (chunkScale = 2^offset).
     * Carried through encode (packed into the free high bits of the axisDir byte) so the
     * renderer can recess coarser surfaces inward and keep the finer surface winning the
     * depth test where overlapping objects of different sizes are near-coplanar. Render
     * hint only — the collider path ignores it.
     */
    offset?: number;
}
