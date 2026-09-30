/**
 * A baked level (`VxlSceneTerrainSystem`) on the ground-plane 2D lane.
 *
 * The 3D lane collides a baked level through one trimesh per chunk, built from
 * the chunk's finest collidable LOD quads. The ground plane has no 3D
 * colliders; its terrain is a column heightmap (`engine/physics/TopDownGround.ts`)
 * and every walkable surface is a rectangle of that heightmap. This module
 * turns the SAME quads into those rectangles: each up-facing (+Y) collidable
 * quad is a patch of floor at the height of its face, so the character stands
 * on rooftops, kerbs and streets exactly where the 3D trimesh would have put
 * it, and every unclimbable drop between them becomes a cliff wall.
 *
 * Only +Y faces matter among the QUADS: a building's walls are the X/Z faces of
 * the same voxels whose top faces already raise the column, and the cliff walls
 * the heightmap derives from that rise are what blocks the character.
 *
 * The quads are not the whole floor, though. A forged level keeps its terrain
 * and other smooth surfaces as baked TRIMESHES (`namedTrimeshes`, what the 3D
 * lane gives trimesh colliders), and on a real forged level those carry most of
 * the walkable ground — reading the quads alone left ~82% of the footprint with
 * no floor at all, which is a player falling through the world. Both are fed.
 *
 * Pure: no Rapier, no THREE.
 */
import type { DecodedChunkQuads, DecodedVxlSceneWorld } from 'engine/vxlscene/VxlSceneFormat.js';
import type { GroundRect } from 'engine/physics/TopDownGround.js';

/** The finest collidable quads of a chunk, as `VxlSceneTerrainSystem.finestKeptQuads` chooses them. */
export type ChunkQuadsSelector = (chunk: DecodedVxlSceneWorld['chunks'][number]) => DecodedChunkQuads | null;

/**
 * Up-facing collidable quads of one chunk → world-space floor rectangles.
 * Mirrors `emitQuadTrimesh`'s conventions: a +dir face lies on the far side
 * of its cell (`gy + 1`), and for a Y-axis quad `w` runs along Z, `h` along X.
 */
export function chunkFloorRects(quads: DecodedChunkQuads, minVoxelSize: number, originX: number, originY: number, originZ: number, out: GroundRect[] = []): GroundRect[] {
    const s = minVoxelSize;
    for (let i = 0; i < quads.count; i++) {
        const axisDir = quads.axisDir[i]!;
        if (((axisDir >> 6) & 1) !== 0) continue;   // decoration (painted lines): never collides
        if ((axisDir & 0x3) !== 1) continue;         // not a Y face
        if (((axisDir >> 2) & 1) !== 0) continue;    // −Y: an underside, never a floor
        const minX = originX + quads.gx[i]! * s;
        const minZ = originZ + quads.gz[i]! * s;
        out.push({
            minX,
            maxX: minX + quads.h[i]! * s,
            minZ,
            maxZ: minZ + quads.w[i]! * s,
            topY: originY + (quads.gy[i]! + 1) * s,
        });
    }
    return out;
}

/** Every chunk's floor rectangles, for `TopDownGround.setSourceRects`. */
export function vxlSceneFloorRects(world: DecodedVxlSceneWorld, selectQuads: ChunkQuadsSelector): GroundRect[] {
    const out: GroundRect[] = [];
    for (const chunk of world.chunks) {
        const quads = selectQuads(chunk);
        if (!quads || quads.count === 0) continue;
        chunkFloorRects(quads, world.minVoxelSize, chunk.cx * world.chunkSize, chunk.cy * world.chunkSize, chunk.cz * world.chunkSize, out);
    }
    return out;
}

/** A world-space triangle soup, as `TopDownGround.setSourceTriangles` takes it. */
export interface FloorTriangles {
    verts: Float32Array;
    indices: Uint32Array;
}

/**
 * Every chunk's baked trimesh surfaces, concatenated in WORLD space — the same
 * geometry `VxlSceneTerrainSystem.bakeBakedTrimesh` gives 3D trimesh colliders,
 * translated by the chunk origin exactly as that path translates it.
 */
export function vxlSceneFloorTriangles(world: DecodedVxlSceneWorld): FloorTriangles {
    let vertCount = 0;
    let indexCount = 0;
    for (const chunk of world.chunks) {
        for (const tm of chunk.namedTrimeshes) {
            vertCount += tm.verts.length;
            indexCount += tm.indices.length;
        }
    }
    const verts = new Float32Array(vertCount);
    const indices = new Uint32Array(indexCount);
    let v = 0;
    let i = 0;
    for (const chunk of world.chunks) {
        const originX = chunk.cx * world.chunkSize;
        const originY = chunk.cy * world.chunkSize;
        const originZ = chunk.cz * world.chunkSize;
        for (const tm of chunk.namedTrimeshes) {
            const base = v / 3;
            for (let k = 0; k < tm.verts.length; k += 3) {
                verts[v] = tm.verts[k]! + originX;
                verts[v + 1] = tm.verts[k + 1]! + originY;
                verts[v + 2] = tm.verts[k + 2]! + originZ;
                v += 3;
            }
            for (let k = 0; k < tm.indices.length; k++) indices[i++] = tm.indices[k]! + base;
        }
    }
    return { verts, indices };
}
