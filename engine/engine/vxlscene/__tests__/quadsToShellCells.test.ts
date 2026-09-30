/**
 * quadsToShellCells must place cells exactly where emitQuadTrimesh places
 * faces: the quad's grid origin IS the owning cell, `dir` only picks the face
 * plane, and quad.w/h extend along axes (d+1)%3 / (d+2)%3. If either side of
 * that convention drifts, the voxels terrain surface shifts off the rendered
 * one by a cell.
 */
import { quadsToShellCells } from 'engine/vxlscene/ColliderBaker.js';
import type { DecodedChunkQuads } from 'engine/vxlscene/VxlSceneFormat.js';

interface TestQuad { gx: number; gy: number; gz: number; w: number; h: number; axisDir: number }

function quadsOf(list: TestQuad[]): DecodedChunkQuads {
    return {
        count: list.length,
        gx: Uint16Array.from(list.map(q => q.gx)),
        gy: Uint16Array.from(list.map(q => q.gy)),
        gz: Uint16Array.from(list.map(q => q.gz)),
        w: Uint16Array.from(list.map(q => q.w)),
        h: Uint16Array.from(list.map(q => q.h)),
        axisDir: Uint8Array.from(list.map(q => q.axisDir)),
        colorIdx: new Uint16Array(list.length),
        disp: new Int8Array(list.length),
    };
}

function sortedTriples(cells: Int32Array): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < cells.length; i += 3) out.push([cells[i]!, cells[i + 1]!, cells[i + 2]!]);
    return out.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
}

describe('quadsToShellCells', () => {
    it('expands a +Y quad along z (u) and x (v) from its owning cell', () => {
        // d=1, dir=+1 → axisDir 0b001. w extends u=(1+1)%3=2 (z), h extends v=0 (x).
        const cells = quadsToShellCells(quadsOf([{ gx: 2, gy: 3, gz: 1, w: 2, h: 1, axisDir: 0b001 }]));
        expect(sortedTriples(cells)).toEqual([[2, 3, 1], [2, 3, 2]]);
    });

    it('a -X face owns the same cell as a +X face at the same origin', () => {
        // d=0: u=1 (y) carries w, v=2 (z) carries h. dir bit changes only the plane.
        const minus = quadsToShellCells(quadsOf([{ gx: 5, gy: 0, gz: 0, w: 1, h: 2, axisDir: 0b100 }]));
        const plus = quadsToShellCells(quadsOf([{ gx: 5, gy: 0, gz: 0, w: 1, h: 2, axisDir: 0b000 }]));
        expect(sortedTriples(minus)).toEqual([[5, 0, 0], [5, 0, 1]]);
        expect(sortedTriples(plus)).toEqual(sortedTriples(minus));
    });

    it('dedups cells shared by faces and skips noCollider quads', () => {
        const cells = quadsToShellCells(quadsOf([
            { gx: 0, gy: 0, gz: 0, w: 1, h: 1, axisDir: 0b001 },        // +Y of (0,0,0)
            { gx: 0, gy: 0, gz: 0, w: 1, h: 1, axisDir: 0b000 },        // +X of the same cell
            { gx: 9, gy: 9, gz: 9, w: 4, h: 4, axisDir: 0b001 | 0x40 }, // noCollider — dropped
        ]));
        expect(sortedTriples(cells)).toEqual([[0, 0, 0]]);
    });
});
