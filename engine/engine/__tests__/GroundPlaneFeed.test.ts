import { chunkFloorRects, vxlSceneFloorRects, vxlSceneFloorTriangles } from 'engine/vxlscene/GroundPlaneFeed.js';
import type { DecodedChunkQuads, DecodedVxlSceneWorld } from 'engine/vxlscene/VxlSceneFormat.js';

/** axisDir packing: axis bits [1:0], −dir bit 2, lodOffset bits [5:3], noCollider bit 6. */
function packed(axis: number, dir: 1 | -1, noCollider = false): number {
    return axis | (dir === -1 ? 4 : 0) | (noCollider ? 64 : 0);
}

function quads(rows: Array<{ axis: number; dir: 1 | -1; gx: number; gy: number; gz: number; w: number; h: number; noCollider?: boolean }>): DecodedChunkQuads {
    const n = rows.length;
    const q: DecodedChunkQuads = {
        count: n,
        gx: new Uint16Array(n), gy: new Uint16Array(n), gz: new Uint16Array(n),
        w: new Uint16Array(n), h: new Uint16Array(n),
        axisDir: new Uint8Array(n), colorIdx: new Uint16Array(n), disp: new Int8Array(n),
    };
    rows.forEach((r, i) => {
        q.gx[i] = r.gx; q.gy[i] = r.gy; q.gz[i] = r.gz; q.w[i] = r.w; q.h[i] = r.h;
        q.axisDir[i] = packed(r.axis, r.dir, r.noCollider);
    });
    return q;
}

describe('chunkFloorRects', () => {
    it('keeps only collidable +Y faces, on the far side of their cell, with w along Z and h along X', () => {
        const out = chunkFloorRects(quads([
            { axis: 1, dir: 1, gx: 2, gy: 3, gz: 4, w: 5, h: 6 },       // a floor
            { axis: 1, dir: -1, gx: 2, gy: 3, gz: 4, w: 5, h: 6 },      // its underside
            { axis: 0, dir: 1, gx: 2, gy: 3, gz: 4, w: 5, h: 6 },       // a wall
            { axis: 1, dir: 1, gx: 0, gy: 0, gz: 0, w: 1, h: 1, noCollider: true }, // painted road line
        ]), 0.5, 100, 200, 300);
        expect(out).toEqual([{ minX: 101, maxX: 104, minZ: 302, maxZ: 304.5, topY: 200 + 2 }]);
    });
});

describe('vxlSceneFloorRects', () => {
    it('places every chunk at cx·chunkSize and uses the selector for the finest kept quads', () => {
        const world = {
            chunkSize: 8, minVoxelSize: 0.5, chunks: [
                { cx: 1, cy: 0, cz: 2, lodHints: [quads([{ axis: 1, dir: 1, gx: 0, gy: 1, gz: 0, w: 2, h: 2 }])] },
                { cx: 0, cy: 0, cz: 0, lodHints: [] },
            ],
        } as unknown as DecodedVxlSceneWorld;
        const out = vxlSceneFloorRects(world, (c) => c.lodHints[0] ?? null);
        expect(out).toEqual([{ minX: 8, maxX: 9, minZ: 16, maxZ: 17, topY: 1 }]);
    });
});

describe('vxlSceneFloorTriangles', () => {
    it('concatenates every chunk\'s baked trimeshes into ONE world-space soup', () => {
        // A forged level keeps its terrain here, not in the voxel quads — reading
        // only the quads left most of the ground missing and the player fell through.
        const world = {
            chunkSize: 8, minVoxelSize: 0.25, chunks: [
                { cx: 0, cy: 0, cz: 0, lodHints: [], namedTrimeshes: [
                    { name: 'terrain', verts: new Float32Array([0, 1, 0, 2, 1, 0, 0, 1, 2]), indices: new Uint32Array([0, 1, 2]) },
                ] },
                { cx: 1, cy: 0, cz: 2, lodHints: [], namedTrimeshes: [
                    { name: 'road', verts: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) },
                ] },
            ],
        } as unknown as Parameters<typeof vxlSceneFloorTriangles>[0];

        const { verts, indices } = vxlSceneFloorTriangles(world);
        expect(indices).toEqual(new Uint32Array([0, 1, 2, 3, 4, 5])); // second chunk's indices rebased
        // The second chunk sits at (8, 0, 16), and its verts carry that origin.
        expect([...verts.slice(9, 18)]).toEqual([8, 0, 16, 9, 0, 16, 8, 0, 17]);
        expect([...verts.slice(0, 3)]).toEqual([0, 1, 0]);
    });

    it('is empty for a level with no baked surfaces, rather than undefined', () => {
        const world = { chunkSize: 8, minVoxelSize: 0.25, chunks: [{ cx: 0, cy: 0, cz: 0, lodHints: [], namedTrimeshes: [] }] } as unknown as Parameters<typeof vxlSceneFloorTriangles>[0];
        const { verts, indices } = vxlSceneFloorTriangles(world);
        expect(verts).toHaveLength(0);
        expect(indices).toHaveLength(0);
    });
});
