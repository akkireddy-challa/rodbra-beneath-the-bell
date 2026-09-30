/**
 * Shared helpers for the VxlScene Structure-of-Arrays decode tests.
 *
 * `decodeVxlScene` returns SoA columns whose `colorIdx` is a 12-bit RGB444 atlas cell
 * (no palette — format v2 stores the cell inline). These helpers reconstruct the
 * equivalent object-shaped `SceneVoxel`/`SceneQuad`/`VxlSceneChunk` values (decoding
 * each cell back to RGB) so existing object-based assertions can be compared against
 * the SoA decode. They are the ground truth for the equivalence tests: "the SoA decode
 * reconstructs the same voxels/quads/colors (at RGB444 precision)".
 *
 * No Node APIs — this file lives under __tests__ (excluded from every tsconfig)
 * and is consumed only by jest.
 */
import type {
    DecodedChunk, DecodedChunkVoxels, DecodedChunkQuads, DecodedVxlSceneWorld,
} from 'engine/vxlscene/VxlSceneFormat.js';
import type { VxlSceneChunk } from 'engine/vxlscene/VxlSceneFormat.js';
import type { SceneVoxel, SceneQuad, RGB } from 'engine/vxlscene/SceneVoxTypes.js';
import { atlasCellRepr } from 'engine/vxlscene/atlasColor.js';

/** Resolve a 12-bit RGB444 atlas cell (the decoded `colorIdx`) → RGB float in 0..1. */
export function cellColor(cell: number): RGB {
    const { r, g, b } = atlasCellRepr(cell);
    return { r: r / 255, g: g / 255, b: b / 255 };
}

/** Reconstruct the object-shaped voxel list from one chunk's SoA voxel columns. */
export function voxelsSoaToObjects(v: DecodedChunkVoxels): SceneVoxel[] {
    const out: SceneVoxel[] = [];
    for (let i = 0; i < v.count; i++) {
        const flags = v.flags[i]!;
        const hasDisp = (flags & 2) !== 0;
        let disp: { dx: number; dy: number; dz: number } | null = null;
        if (hasDisp && v.disp) {
            const o = i * 3;
            disp = { dx: v.disp[o]!, dy: v.disp[o + 1]!, dz: v.disp[o + 2]! };
        }
        out.push({
            gx: v.gx[i]!, gy: v.gy[i]!, gz: v.gz[i]!,
            sizeLevel: v.sizeLevel[i]!,
            color: cellColor(v.colorIdx[i]!),
            noCollider: (flags & 1) !== 0,
            disp,
        });
    }
    return out;
}

/** Reconstruct the object-shaped quad list from one LOD level's SoA columns. */
export function quadsSoaToObjects(q: DecodedChunkQuads): SceneQuad[] {
    const out: SceneQuad[] = [];
    for (let i = 0; i < q.count; i++) {
        const axisDir = q.axisDir[i]!;
        const axis = (axisDir & 0x3) as 0 | 1 | 2;
        const dir: 1 | -1 = ((axisDir >> 2) & 1) === 0 ? 1 : -1;
        out.push({
            gx: q.gx[i]!, gy: q.gy[i]!, gz: q.gz[i]!,
            w: q.w[i]!, h: q.h[i]!,
            axis, dir,
            color: cellColor(q.colorIdx[i]!),
            disp: q.disp[i]!,
        });
    }
    return out;
}

/** Reconstruct a whole chunk as object-shaped data for comparison. */
export function chunkSoaToObjects(chunk: DecodedChunk): VxlSceneChunk {
    return {
        cx: chunk.cx, cy: chunk.cy, cz: chunk.cz,
        voxels: voxelsSoaToObjects(chunk.voxels),
        lodHints: chunk.lodHints.map(l => quadsSoaToObjects(l)),
        namedTrimeshes: chunk.namedTrimeshes,
    };
}

/** Reconstruct every chunk of a decoded SoA world as object-shaped chunks. */
export function worldSoaToObjects(world: DecodedVxlSceneWorld): VxlSceneChunk[] {
    return world.chunks.map(c => chunkSoaToObjects(c));
}
