/**
 * Pre-baked coarser variants of a `.vwld` level.
 *
 * A phone does not need the finest LOD level, and today it proves that the expensive way:
 * it downloads the whole container, inflates it, decodes every quad, and then sheds most
 * of them. On a forged circuit that was 2.9M quads decoded to keep 318k — the shed itself
 * is cheap, but the transfer, the inflate and the decode feeding it are not, and the
 * inflated container is ~35 MB resident while it happens.
 *
 * Baking the coarser levels as their own files moves that decision to bake time: the
 * device fetches the variant it wants and decodes only what it will draw. The variants are
 * composed from the SAME bake rather than re-voxelized, so they cannot disagree with the
 * full file about where the world is — two independent voxelizations of one world differ
 * at the edges, and that difference would surface as mobile and desktop having subtly
 * different collision.
 */
import type { VxlSceneChunk } from 'engine/vxlscene/VxlSceneFormat.js';

/**
 * How many of the finest quad LOD levels each published variant drops.
 *
 * `+1` is what mobile already applies at runtime, so a `+1` variant is the same picture
 * it renders now. `+2` exists for devices that cannot manage `+1` — visibly blockier, and
 * deliberately not the default for that reason.
 */
export const LOD_VARIANT_DROPS: readonly number[] = [1, 2];

/**
 * A chunk with its `drop` finest quad levels removed.
 *
 * ALWAYS leaves one level standing. A chunk whose levels are all dropped contributes no
 * quads, which is not "coarse" — it is a hole in the world, and holes fall through. Chunks
 * legitimately differ in how many levels they carry (a chunk holding a single small object
 * may have only one), so this clamp is the common case, not an edge case.
 *
 * Only `lodHints` is touched. `voxels` carry the displaced surface, which the runtime
 * decimates against its own separate budget, and `namedTrimeshes` are authored collider
 * surfaces — dropping either would change collision rather than detail.
 */
export function dropFinestQuadLods(chunk: VxlSceneChunk, drop: number): VxlSceneChunk {
    if (drop <= 0 || chunk.lodHints.length <= 1) return chunk;
    const from = Math.min(drop, chunk.lodHints.length - 1);
    return { ...chunk, lodHints: chunk.lodHints.slice(from) };
}

/** Column spacing a variant stores its surface at: 1, 2, 4 … for drop 0, 1, 2 … */
export function surfaceStepForDrop(drop: number): number {
    return drop <= 0 ? 1 : 2 ** drop;
}

/**
 * Keep every `step`-th surface column, measured on GLOBAL cell coordinates.
 *
 * Global, not chunk-local, is the whole point: the surface is welded ACROSS chunk
 * boundaries, so two neighbouring chunks must agree on which columns survive. Aligning
 * per chunk would keep different columns either side of a seam and tear the ribbon open
 * exactly where it is most visible — along the middle of the track.
 *
 * Only displaced voxels carry the surface; anything else in `voxels` is passed through.
 * The quad levels and collider meshes are untouched, so this changes how the surface
 * LOOKS and not where anything collides.
 */
export function decimateChunkSurface(chunk: VxlSceneChunk, step: number, cellsPerChunk: number): VxlSceneChunk {
    if (step <= 1 || chunk.voxels.length === 0) return chunk;
    const baseX = chunk.cx * cellsPerChunk;
    const baseZ = chunk.cz * cellsPerChunk;
    const kept = chunk.voxels.filter((v) => {
        if (v.disp === null || v.disp === undefined) return true;
        return (baseX + v.gx) % step === 0 && (baseZ + v.gz) % step === 0;
    });
    return kept.length === chunk.voxels.length ? chunk : { ...chunk, voxels: kept };
}

/** Both variant transforms in the order the bake applies them. */
export function coarsenChunkForVariant(chunk: VxlSceneChunk, drop: number, cellsPerChunk: number): VxlSceneChunk {
    return decimateChunkSurface(dropFinestQuadLods(chunk, drop), surfaceStepForDrop(drop), cellsPerChunk);
}

/** Quads across every level of a chunk — what a variant's size is really made of. */
export function countChunkQuads(chunk: VxlSceneChunk): number {
    let n = 0;
    for (const level of chunk.lodHints) n += level.length;
    return n;
}
