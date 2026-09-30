import { mergeFlatFaceSquares, type FlatFaceRect, type FlatFaceSquare } from 'engine/VoxelFlatFaceMerge.js';

const sq = (u0: number, v0: number, size: number, color = 0xFFFFFF): FlatFaceSquare =>
    ({ u0, v0, size, color });

/** Explode squares/rects into "u,v,color" cell strings for coverage comparison. */
function cellsOfSquares(squares: readonly FlatFaceSquare[]): Set<string> {
    const out = new Set<string>();
    for (const s of squares) {
        for (let u = s.u0; u < s.u0 + s.size; u++) {
            for (let v = s.v0; v < s.v0 + s.size; v++) out.add(`${u},${v},${s.color}`);
        }
    }
    return out;
}

function cellsOfRects(rects: readonly FlatFaceRect[]): { cells: Set<string>; overlap: boolean } {
    const cells = new Set<string>();
    let overlap = false;
    for (const r of rects) {
        for (let u = r.u0; u < r.u1; u++) {
            for (let v = r.v0; v < r.v1; v++) {
                const posKey = `${u},${v}`;
                for (const other of cells) {
                    if (other.startsWith(posKey + ',')) { overlap = true; }
                }
                cells.add(`${u},${v},${r.color}`);
            }
        }
    }
    return { cells, overlap };
}

describe('mergeFlatFaceSquares', () => {
    it('returns nothing for an empty input', () => {
        expect(mergeFlatFaceSquares([])).toEqual([]);
    });

    it('passes a single square through as one rect', () => {
        const rects = mergeFlatFaceSquares([sq(3, 5, 2, 42)]);
        expect(rects).toEqual([{ u0: 3, v0: 5, u1: 5, v1: 7, color: 42 }]);
    });

    it('merges a 2x2 block of unit squares into one rect', () => {
        const rects = mergeFlatFaceSquares([sq(0, 0, 1), sq(1, 0, 1), sq(0, 1, 1), sq(1, 1, 1)]);
        expect(rects).toEqual([{ u0: 0, v0: 0, u1: 2, v1: 2, color: 0xFFFFFF }]);
    });

    it('merges mixed-size squares into one rect (kills the T-junction case)', () => {
        // A size-2 square plus a 1x2 column of unit squares beside it: one 3x2 rect.
        const rects = mergeFlatFaceSquares([sq(0, 0, 2), sq(2, 0, 1), sq(2, 1, 1)]);
        expect(rects).toEqual([{ u0: 0, v0: 0, u1: 3, v1: 2, color: 0xFFFFFF }]);
    });

    it('does not merge across different colors', () => {
        const rects = mergeFlatFaceSquares([sq(0, 0, 1, 1), sq(1, 0, 1, 2)]);
        expect(rects).toHaveLength(2);
        const { cells } = cellsOfRects(rects);
        expect(cells).toEqual(cellsOfSquares([sq(0, 0, 1, 1), sq(1, 0, 1, 2)]));
    });

    it('keeps disjoint islands separate', () => {
        const rects = mergeFlatFaceSquares([sq(0, 0, 1), sq(5, 5, 1)]);
        expect(rects).toHaveLength(2);
    });

    it('is lossless and non-overlapping on random layouts', () => {
        // Deterministic LCG so the layout is stable across runs.
        let seed = 12345;
        const rand = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
            return seed / 0x7FFFFFFF;
        };
        for (let trial = 0; trial < 50; trial++) {
            const occupied = new Set<string>();
            const squares: FlatFaceSquare[] = [];
            for (let attempt = 0; attempt < 60; attempt++) {
                const size = [1, 1, 1, 2, 2, 4][Math.floor(rand() * 6)]!;
                const u0 = Math.floor(rand() * 24);
                const v0 = Math.floor(rand() * 24);
                const color = [7, 7, 7, 99][Math.floor(rand() * 4)]!;
                let free = true;
                for (let u = u0; u < u0 + size && free; u++) {
                    for (let v = v0; v < v0 + size; v++) {
                        if (occupied.has(`${u},${v}`)) { free = false; break; }
                    }
                }
                if (!free) continue;
                for (let u = u0; u < u0 + size; u++) {
                    for (let v = v0; v < v0 + size; v++) occupied.add(`${u},${v}`);
                }
                squares.push(sq(u0, v0, size, color));
            }
            const rects = mergeFlatFaceSquares(squares);
            const { cells, overlap } = cellsOfRects(rects);
            expect(overlap).toBe(false);
            expect(cells).toEqual(cellsOfSquares(squares));
        }
    });
});
