/**
 * The crowd solver's job is to keep agents apart without physics. These tests
 * pin the properties that make it safe to run for a thousand agents every
 * frame: it resolves overlap, it is stable under pathological packing (rather
 * than exploding the way a spring would), it respects mobility so an immovable
 * agent never moves, and it costs what a grid costs rather than all-pairs.
 */
import { SpatialHash, CELL_SIZE_RADIUS_MULTIPLE } from 'engine/npc/crowd/SpatialHash.js';
import { separateCrowd, DEFAULT_SEPARATION_OPTIONS } from 'engine/npc/crowd/CrowdSeparation.js';
import type { CrowdAgentArrays } from 'engine/npc/crowd/CrowdSeparation.js';

const R = 0.5;

function makeAgents(points: Array<{ x: number; z: number; m?: number; r?: number }>): CrowdAgentArrays {
    const n = points.length;
    const a: CrowdAgentArrays = {
        xs: new Float32Array(n), zs: new Float32Array(n),
        radii: new Float32Array(n), mobilities: new Float32Array(n), count: n,
    };
    points.forEach((p, i) => {
        a.xs[i] = p.x; a.zs[i] = p.z; a.radii[i] = p.r ?? R; a.mobilities[i] = p.m ?? 1;
    });
    return a;
}

function buildHash(a: CrowdAgentArrays): SpatialHash {
    let maxR = 0;
    for (let i = 0; i < a.count; i++) maxR = Math.max(maxR, a.radii[i]!);
    const hash = new SpatialHash(maxR * CELL_SIZE_RADIUS_MULTIPLE * 2);
    hash.build(a.xs, a.zs, a.count);
    return hash;
}

/** Smallest gap between any pair, negative when overlapping. */
function worstOverlap(a: CrowdAgentArrays): number {
    let worst = Infinity;
    for (let i = 0; i < a.count; i++) {
        for (let j = i + 1; j < a.count; j++) {
            const d = Math.hypot(a.xs[j]! - a.xs[i]!, a.zs[j]! - a.zs[i]!);
            worst = Math.min(worst, d - (a.radii[i]! + a.radii[j]!));
        }
    }
    return worst;
}

/** Run the pass repeatedly, rebuilding the hash as positions change. */
function relax(a: CrowdAgentArrays, frames: number): void {
    for (let f = 0; f < frames; f++) separateCrowd(a, buildHash(a));
}

describe('separateCrowd', () => {
    test('pushes two overlapping agents apart', () => {
        const a = makeAgents([{ x: 0, z: 0 }, { x: 0.4, z: 0 }]);
        expect(worstOverlap(a)).toBeLessThan(0);
        relax(a, 20);
        expect(worstOverlap(a)).toBeGreaterThan(-DEFAULT_SEPARATION_OPTIONS.slack - 1e-3);
    });

    test('leaves already-separated agents alone', () => {
        const a = makeAgents([{ x: 0, z: 0 }, { x: 5, z: 0 }]);
        const before = [a.xs[0], a.xs[1], a.zs[0], a.zs[1]];
        separateCrowd(a, buildHash(a));
        expect([a.xs[0], a.xs[1], a.zs[0], a.zs[1]]).toEqual(before);
    });

    test('resolves a fully coincident stack instead of dividing by zero', () => {
        // No separating axis exists here; a naive normalize yields NaN and the
        // whole crowd becomes non-finite for the rest of the session.
        const a = makeAgents(Array.from({ length: 8 }, () => ({ x: 3, z: 3 })));
        relax(a, 60);
        for (let i = 0; i < a.count; i++) {
            expect(Number.isFinite(a.xs[i]!)).toBe(true);
            expect(Number.isFinite(a.zs[i]!)).toBe(true);
        }
        expect(worstOverlap(a)).toBeGreaterThan(-2 * R);
    });

    test('is stable under dense packing — no explosion', () => {
        // 100 agents inside a 3 m square is far denser than they can sit. A
        // force-based solver would gain energy here and fling them; projection
        // must simply relax them outward and stop.
        const pts = Array.from({ length: 100 }, (_, i) => ({ x: (i % 10) * 0.3, z: Math.floor(i / 10) * 0.3 }));
        const a = makeAgents(pts);
        relax(a, 60);
        for (let i = 0; i < a.count; i++) {
            expect(Math.abs(a.xs[i]!)).toBeLessThan(100);
            expect(Math.abs(a.zs[i]!)).toBeLessThan(100);
        }
    });

    test('a zero-mobility agent never moves — the player is not shoved by the horde', () => {
        const a = makeAgents([{ x: 0, z: 0, m: 0 }, { x: 0.3, z: 0 }, { x: -0.3, z: 0 }]);
        relax(a, 30);
        expect(a.xs[0]).toBe(0);
        expect(a.zs[0]).toBe(0);
    });

    test('a less mobile agent yields less of the correction than a free one', () => {
        // The near-player FULL tier gets low mobility so it holds its ground
        // while the crowd behind it absorbs the overlap.
        const a = makeAgents([{ x: 0, z: 0, m: 0.1 }, { x: 0.5, z: 0, m: 1 }]);
        const stubbornStart = a.xs[0]!;
        const freeStart = a.xs[1]!;
        separateCrowd(a, buildHash(a));
        const stubbornMoved = Math.abs(a.xs[0]! - stubbornStart);
        const freeMoved = Math.abs(a.xs[1]! - freeStart);
        expect(freeMoved).toBeGreaterThan(stubbornMoved);
    });

    test('reports zero corrections once the crowd is separated', () => {
        const a = makeAgents([{ x: 0, z: 0 }, { x: 0.4, z: 0 }]);
        relax(a, 40);
        expect(separateCrowd(a, buildHash(a))).toBe(0);
    });

    test('scales to 1000 agents without all-pairs cost', () => {
        // 1000 agents is 499,500 unordered pairs; a grid must touch far fewer.
        // Asserting completion under a generous bound catches an accidental
        // O(n^2) regression without being a flaky wall-clock benchmark.
        const pts = Array.from({ length: 1000 }, (_, i) => ({ x: (i % 40) * 1.5, z: Math.floor(i / 40) * 1.5 }));
        const a = makeAgents(pts);
        const t0 = Date.now();
        separateCrowd(a, buildHash(a));
        expect(Date.now() - t0).toBeLessThan(250);
    });
});

describe('SpatialHash', () => {
    test('finds neighbours within the radius and excludes the agent itself', () => {
        const a = makeAgents([{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 50, z: 50 }]);
        const hash = buildHash(a);
        const seen: number[] = [];
        hash.forEachNeighbor(0, 2, (j) => seen.push(j));
        expect(seen).toEqual([1]);
    });

    test('handles negative coordinates', () => {
        const a = makeAgents([{ x: -20.5, z: -33.25 }, { x: -20.1, z: -33.25 }]);
        const hash = buildHash(a);
        const seen: number[] = [];
        hash.forEachNeighbor(0, 2, (j) => seen.push(j));
        expect(seen).toEqual([1]);
    });

    test('occupied cell count reflects clustering, not world size', () => {
        const a = makeAgents(Array.from({ length: 16 }, () => ({ x: 1000, z: -1000 })));
        expect(buildHash(a).getOccupiedCellCount()).toBe(1);
    });

    test('rebuild clears the previous frame', () => {
        const a = makeAgents([{ x: 0, z: 0 }, { x: 0.5, z: 0 }]);
        const hash = buildHash(a);
        a.xs[1] = 500; a.zs[1] = 500;
        hash.build(a.xs, a.zs, a.count);
        const seen: number[] = [];
        hash.forEachNeighbor(0, 2, (j) => seen.push(j));
        expect(seen).toEqual([]);
    });
});
