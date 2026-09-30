/**
 * Per-vertex `emissive` attribute derivation for baked VxlScene worlds (v7 emissive palette).
 *
 * A `.vwld` stores emission as a WORLD-LEVEL `emissiveByCell` LUT: 4096 bytes of 0..255
 * strength indexed by the 12-bit RGB444 atlas CELL, which is exactly the value every quad /
 * surface column carries inline as its colour. So a vertex's glow is one array lookup — no
 * palette bookkeeping, no per-chunk state. These helpers turn that LUT into the 0..1 float
 * attribute the emissive Lambert materials read (`VoxelEmissiveMaterial.ts`, both backends).
 *
 * Pure leaf module: no THREE, no engine state, so the mapping is testable on its own.
 *
 * Two entry points because the renderer's two geometry sources expose colour differently:
 *  - `deriveEmissiveAttribute` — greedy quads, whose `colorIdx` column IS the atlas cell.
 *  - `deriveEmissiveFromUv` — the welded smooth surface, whose builder consumes the cell
 *    internally and only emits atlas UVs; `buildCellByPaletteUv` inverts the renderer's
 *    fixed cell→UV table so the cell is recovered exactly (the UVs are verbatim copies of
 *    that table's entries, so the float compare is bit-exact, never approximate).
 *
 * NEAR-REPRESENTATION-ONLY: a bias-step batch mixes fine and coarse sub-geometry under ONE
 * material, so "only the near representation glows" cannot be a material decision — it is
 * enforced here by emitting an all-zero (but correctly sized) attribute for `lod > 0`. The
 * size still matters: BatchedMesh requires every added geometry to carry the same attributes.
 * `lod` is the level RELATIVE to what the camera sees up close, not the raw hint index: the
 * renderer passes 0 for an offset group's finest KEPT level, which is the one backfilled into
 * the finer levels and is not always hint 0 (a mobile quad-cell budget sheds whole LOD0
 * groups, and those chunks must still glow).
 */

/** 0..255 stored strength → the 0..1 vertex attribute the emissive materials multiply by. */
const STRENGTH_SCALE = 1 / 255;

/** Full-scale unorm16 value — the packing the surface builder's `uv` attribute uses. */
const UNORM16_MAX = 65535;

/**
 * Per-vertex emissive floats for one greedy-quad sub-geometry: `quadCells.length ×
 * vertsPerQuad` entries, each quad's strength replicated across its vertices (the mesh
 * builder emits `vertsPerQuad` consecutive vertices per quad, in quad order).
 *
 * `quadCells` is the quad column's `colorIdx` — the atlas cell — and its LENGTH is the quad
 * count (the renderer passes `colorIdx.subarray(0, count)`). Cells outside `emissiveByCell`
 * and cells with strength 0 contribute 0. Returns all zeros when `lod > 0` (see the module
 * doc: 0 means "the level the camera sees up close", not necessarily hint 0).
 */
export function deriveEmissiveAttribute(
    quadCells: ArrayLike<number>,
    vertsPerQuad: number,
    emissiveByCell: Uint8Array,
    lod: number,
): Float32Array {
    const n = quadCells.length;
    const out = new Float32Array(n * vertsPerQuad);
    if (lod > 0) return out; // coarse levels never glow — layout kept, values zeroed
    for (let i = 0; i < n; i++) {
        const strength = emissiveByCell[quadCells[i]!];
        if (strength === undefined || strength === 0) continue;
        const value = strength * STRENGTH_SCALE;
        const base = i * vertsPerQuad;
        for (let k = 0; k < vertsPerQuad; k++) out[base + k] = value;
    }
    return out;
}

/**
 * Invert a `[u0,v0, u1,v1, …]` cell→UV table into `u → (v → cell)`. Two levels rather than a
 * combined key so lookups need no string building: the palette is a 64×64 pixel grid, so
 * each level holds at most 64 entries.
 *
 * Keys are the UNORM16-QUANTIZED coordinates, not the raw floats — that is the form the
 * surface builder actually writes into its `uv` attribute (see `SurfaceGeometryData.uvs`),
 * and integer keys make the lookup an exact match instead of a float-equality compare that
 * has to survive a round-trip through packing.
 */
export function buildCellByPaletteUv(paletteUV: Float32Array): Map<number, Map<number, number>> {
    const byU = new Map<number, Map<number, number>>();
    for (let cell = 0; cell < paletteUV.length / 2; cell++) {
        const u = Math.round(paletteUV[cell * 2]! * UNORM16_MAX);
        const v = Math.round(paletteUV[cell * 2 + 1]! * UNORM16_MAX);
        let byV = byU.get(u);
        if (!byV) { byV = new Map<number, number>(); byU.set(u, byV); }
        byV.set(v, cell);
    }
    return byU;
}

/**
 * Per-vertex emissive floats for welded surface geometry, resolved through its atlas UVs.
 * `uvs` is the interleaved unorm16 `[u,v, …]` attribute array (as the surface builder
 * writes it) and `vertCount` its vertex count; `cellByUv` must be keyed in the same
 * quantized units, which `buildCellByPaletteUv` guarantees. A UV that is not a palette
 * entry yields 0 (nothing in the atlas' colour region maps to it, so no cell — and
 * therefore no strength — exists for that vertex).
 */
export function deriveEmissiveFromUv(
    uvs: Uint16Array,
    vertCount: number,
    cellByUv: Map<number, Map<number, number>>,
    emissiveByCell: Uint8Array,
): Float32Array {
    const out = new Float32Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
        const cell = cellByUv.get(uvs[i * 2]!)?.get(uvs[i * 2 + 1]!);
        if (cell === undefined) continue;
        const strength = emissiveByCell[cell];
        if (strength === undefined || strength === 0) continue;
        out[i] = strength * STRENGTH_SCALE;
    }
    return out;
}
