import { buildPathCullMask, type PathCullPoint } from 'engine/vxlscene/PathCull.js';

const bounds = { minX: 0, minZ: 0, maxX: 200, maxZ: 200 };

/** A straight run along +X at z = 100, from x = 20 to x = 180. */
const STRAIGHT: PathCullPoint[] = [
    { x: 20, z: 100 },
    { x: 100, z: 100 },
    { x: 180, z: 100 },
];

/** A square circuit, corners (50,50)–(150,150). Points are dense enough to be a course. */
function squareCircuit(): PathCullPoint[] {
    const pts: PathCullPoint[] = [];
    const corners = [[50, 50], [150, 50], [150, 150], [50, 150]] as const;
    for (let c = 0; c < 4; c++) {
        const [x0, z0] = corners[c]!;
        const [x1, z1] = corners[(c + 1) % 4]!;
        // Three points per edge so the polyline reads as a real circuit.
        for (let t = 0; t < 3; t++) {
            pts.push({ x: x0 + ((x1 - x0) * t) / 3, z: z0 + ((z1 - z0) * t) / 3 });
        }
    }
    return pts;
}

describe('buildPathCullMask — corridor (mode "both")', () => {
    const mask = buildPathCullMask(
        { points: STRAIGHT, closed: false, distanceM: 10, mode: 'both' },
        bounds,
    );

    it('keeps points on the centerline and inside the corridor', () => {
        expect(mask.keeps(100, 100)).toBe(true);
        expect(mask.keeps(100, 109)).toBe(true);
        expect(mask.keeps(100, 91)).toBe(true);
    });

    it('culls points beyond the distance on BOTH sides', () => {
        expect(mask.keeps(100, 111)).toBe(false);
        expect(mask.keeps(100, 89)).toBe(false);
    });

    it('rounds the corridor off past the ends rather than extending it', () => {
        // 5 m past the last point, on the centerline → inside the end cap.
        expect(mask.keeps(185, 100)).toBe(true);
        // 15 m past it → outside.
        expect(mask.keeps(195, 100)).toBe(false);
        // Diagonally past the end: distance from the endpoint, not from the line.
        expect(mask.keeps(188, 108)).toBe(false);
    });

    it('reports the segment count and the effective mode', () => {
        expect(mask.segmentCount).toBe(2);
        expect(mask.mode).toBe('both');
    });
});

describe('buildPathCullMask — closed circuit (mode "outside")', () => {
    const points = squareCircuit();
    const outside = buildPathCullMask({ points, closed: true, distanceM: 10, mode: 'outside' }, bounds);
    const both = buildPathCullMask({ points, closed: true, distanceM: 10, mode: 'both' }, bounds);

    it('keeps the whole infield however far it is from the track', () => {
        // Dead centre of the square: 50 m from every edge, so the corridor
        // rule alone would drop it.
        expect(both.keeps(100, 100)).toBe(false);
        expect(outside.keeps(100, 100)).toBe(true);
    });

    it('still culls outside the loop beyond the distance', () => {
        expect(outside.keeps(100, 30)).toBe(false);
        expect(outside.keeps(20, 100)).toBe(false);
        expect(outside.keeps(190, 190)).toBe(false);
    });

    it('keeps the corridor on the outer side of the track', () => {
        // 5 m outside the top edge — outside the polygon, inside the corridor.
        expect(outside.keeps(100, 45)).toBe(true);
        expect(both.keeps(100, 45)).toBe(true);
    });

    it('closes the loop: the segment from the last point back to the first exists', () => {
        expect(outside.segmentCount).toBe(points.length);
    });
});

describe('buildPathCullMask — open path asked to trim only the outside', () => {
    it('falls back to "both" rather than failing the bake', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const mask = buildPathCullMask(
            { points: STRAIGHT, closed: false, distanceM: 10, mode: 'outside' },
            bounds,
        );
        expect(mask.mode).toBe('both');
        expect(mask.keeps(100, 130)).toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('classifyBox', () => {
    const mask = buildPathCullMask(
        { points: STRAIGHT, closed: false, distanceM: 20, mode: 'both' },
        bounds,
    );

    it('answers "all" for a box wholly inside one segment stadium', () => {
        expect(mask.classifyBox(90, 95, 100, 105)).toBe('all');
    });

    it('answers "none" for a box the corridor cannot reach', () => {
        expect(mask.classifyBox(0, 0, 16, 16)).toBe('none');
        expect(mask.classifyBox(96, 160, 112, 176)).toBe('none');
    });

    it('answers "partial" for a box the corridor edge crosses', () => {
        expect(mask.classifyBox(96, 112, 112, 128)).toBe('partial');
    });

    it('never claims "none" for a box holding a kept point', () => {
        // The conservative box test may over-report "partial", but a box it
        // calls "none" must contain nothing the per-cell test would keep.
        for (let x = 0; x < 200; x += 16) {
            for (let z = 0; z < 200; z += 16) {
                if (mask.classifyBox(x, z, x + 16, z + 16) !== 'none') continue;
                for (let sx = x + 1; sx < x + 16; sx += 3) {
                    for (let sz = z + 1; sz < z + 16; sz += 3) {
                        expect(mask.keeps(sx, sz)).toBe(false);
                    }
                }
            }
        }
    });

    it('never claims "all" for a box holding a culled point', () => {
        for (let x = 0; x < 200; x += 16) {
            for (let z = 0; z < 200; z += 16) {
                if (mask.classifyBox(x, z, x + 16, z + 16) !== 'all') continue;
                for (let sx = x + 1; sx < x + 16; sx += 3) {
                    for (let sz = z + 1; sz < z + 16; sz += 3) {
                        expect(mask.keeps(sx, sz)).toBe(true);
                    }
                }
            }
        }
    });

    it('classifies infield boxes as "all" in outside mode', () => {
        const circuit = buildPathCullMask(
            { points: squareCircuit(), closed: true, distanceM: 10, mode: 'outside' },
            bounds,
        );
        expect(circuit.classifyBox(96, 96, 112, 112)).toBe('all');
        expect(circuit.classifyBox(0, 0, 16, 16)).toBe('none');
    });
});

describe('buildPathCullMask — input validation', () => {
    it('rejects a polyline that cannot describe a region', () => {
        expect(() => buildPathCullMask(
            { points: [{ x: 0, z: 0 }], closed: false, distanceM: 10, mode: 'both' }, bounds,
        )).toThrow(/at least 2 path points/);
    });

    it('rejects a non-positive keep distance', () => {
        expect(() => buildPathCullMask(
            { points: STRAIGHT, closed: false, distanceM: 0, mode: 'both' }, bounds,
        )).toThrow(/positive number/);
    });
});
