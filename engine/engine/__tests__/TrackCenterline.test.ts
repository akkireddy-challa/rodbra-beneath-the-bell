import { buildTrackCenterline, DEFAULT_TRACK_CENTERLINE_OPTIONS } from 'engine/TrackCenterline.js';

/**
 * Build a triangulated annulus ("ring road") surface: an inner and outer ring
 * of `segments` vertices each, the gap between them filled with two triangles
 * per segment. Optional x-scale turns the ring into an oval.
 */
function buildRing(
    cx: number, cz: number, rInner: number, rOuter: number, y: number, segments: number, xScale = 1,
): { vertices: Float32Array; indices: Uint32Array } {
    const verts: number[] = [];
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        verts.push(cx + rInner * ca * xScale, y, cz + rInner * sa); // inner = vertex 2i
        verts.push(cx + rOuter * ca * xScale, y, cz + rOuter * sa); // outer = vertex 2i+1
    }
    const indices: number[] = [];
    for (let i = 0; i < segments; i++) {
        const ni = (i + 1) % segments;
        indices.push(2 * i, 2 * i + 1, 2 * ni + 1);
        indices.push(2 * i, 2 * ni + 1, 2 * ni);
    }
    return { vertices: new Float32Array(verts), indices: new Uint32Array(indices) };
}

const radius = (p: { x: number; z: number }, cx: number, cz: number): number => Math.hypot(p.x - cx, p.z - cz);

describe('buildTrackCenterline', () => {
    const CX = 10, CZ = -5, RI = 24, RO = 28, Y = 3, SEG = 180;
    const MID = (RI + RO) / 2; // 26
    const ring = buildRing(CX, CZ, RI, RO, Y, SEG);

    it('returns a centered, evenly-spaced closed loop for a ring road', () => {
        const wps = buildTrackCenterline(ring);
        expect(wps.length).toBe(DEFAULT_TRACK_CENTERLINE_OPTIONS.waypointCount); // 96

        // Every waypoint sits on the road band, at the ring's height.
        for (const w of wps) {
            const r = radius(w, CX, CZ);
            expect(r).toBeGreaterThanOrEqual(RI - 1);
            expect(r).toBeLessThanOrEqual(RO + 1);
            expect(w.y).toBeCloseTo(Y, 1);
        }

        // Centered on average — not hugging the inside or outside curb.
        const meanR = wps.reduce((s, w) => s + radius(w, CX, CZ), 0) / wps.length;
        expect(Math.abs(meanR - MID)).toBeLessThan(1.0);

        // Closed + evenly spaced: the largest step (incl. the closing edge from
        // last->first) isn't wildly bigger than the mean — i.e. no chord jumps
        // across the infield.
        const gaps: number[] = [];
        for (let i = 0; i < wps.length; i++) {
            const a = wps[i]!, b = wps[(i + 1) % wps.length]!;
            gaps.push(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
        }
        const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        expect(Math.min(...gaps)).toBeGreaterThan(0);
        expect(Math.max(...gaps)).toBeLessThan(meanGap * 2.5);
        // A ring of mid-radius 26 has circumference ~163m; the loop should be in that ballpark.
        const total = gaps.reduce((s, g) => s + g, 0);
        expect(total).toBeGreaterThan(2 * Math.PI * MID * 0.8);
        expect(total).toBeLessThan(2 * Math.PI * MID * 1.2);
    });

    it('also centers an oval track', () => {
        const oval = buildRing(0, 0, RI, RO, 0, SEG, 1.6);
        const wps = buildTrackCenterline(oval);
        expect(wps.length).toBe(96);
        // Each waypoint should lie on the oval band: its elliptical radius ~1.
        for (const w of wps) {
            const er = Math.hypot(w.x / (MID * 1.6), w.z / MID);
            expect(er).toBeGreaterThan(0.9);
            expect(er).toBeLessThan(1.1);
        }
    });

    it('reverse option flips the loop order', () => {
        const fwd = buildTrackCenterline(ring, { reverse: false });
        const rev = buildTrackCenterline(ring, { reverse: true });
        const N = fwd.length;
        expect(rev.length).toBe(N);
        for (let i = 0; i < N; i++) {
            expect(rev[i]!.x).toBeCloseTo(fwd[N - 1 - i]!.x, 5);
            expect(rev[i]!.z).toBeCloseTo(fwd[N - 1 - i]!.z, 5);
        }
    });

    it('orients the lap to the intended racing direction from either starting order', () => {
        // The same track, asked to run each way round. Loop extraction picks a
        // direction arbitrarily, so without orientTo the lap can come out
        // backwards and every AI car races against the grid it started on
        // (observed 2026-07-26: dot -0.94 vs the lap-gate sequence).
        const at = { x: CX + MID, z: CZ }; // a point on the ring, +X side
        const tangentAt = (wps: typeof ring extends never ? never : ReturnType<typeof buildTrackCenterline>) => {
            let k = 0, best = Infinity;
            for (let i = 0; i < wps.length; i++) {
                const d = Math.hypot(wps[i]!.x - at.x, wps[i]!.z - at.z);
                if (d < best) { best = d; k = i; }
            }
            const a = wps[k]!, b = wps[(k + 1) % wps.length]!;
            return { x: b.x - a.x, z: b.z - a.z };
        };
        for (const heading of [{ x: 0, z: 1 }, { x: 0, z: -1 }]) {
            const wps = buildTrackCenterline(ring, { orientTo: { position: at, heading } });
            expect(wps.length).toBe(96);
            const t = tangentAt(wps);
            expect(t.x * heading.x + t.z * heading.z).toBeGreaterThan(0);
        }
    });

    it('applies reverse on top of the oriented direction', () => {
        const at = { x: CX + MID, z: CZ };
        const heading = { x: 0, z: 1 };
        const fwd = buildTrackCenterline(ring, { orientTo: { position: at, heading } });
        const rev = buildTrackCenterline(ring, { orientTo: { position: at, heading }, reverse: true });
        const N = fwd.length;
        for (let i = 0; i < N; i++) {
            expect(rev[i]!.x).toBeCloseTo(fwd[N - 1 - i]!.x, 5);
        }
    });

    it('honors waypointCount', () => {
        expect(buildTrackCenterline(ring, { waypointCount: 48 }).length).toBe(48);
        expect(buildTrackCenterline(ring, { waypointCount: 200 }).length).toBe(200);
    });

    it('recenter:false still returns a loop on the road', () => {
        const wps = buildTrackCenterline(ring, { recenter: false });
        expect(wps.length).toBe(96);
        for (const w of wps) {
            const r = radius(w, CX, CZ);
            expect(r).toBeGreaterThanOrEqual(RI - 2);
            expect(r).toBeLessThanOrEqual(RO + 2);
        }
    });

    it('covers the full lap when the seed lands between tessellation gaps (bidirectional walk)', () => {
        // Remove two short arcs of triangles. A single-direction greedy walk from
        // an arbitrary seed stops at the first gap it meets and silently returns
        // a fraction of the lap — the 2026-07-26 bug where the AI karts got a
        // 275m tangle of a 1294m circuit. Gap arcs ~4m each (< maxStepDistance,
        // so the walk can still cross them) placed either side of the seed region.
        const gapped = buildRing(CX, CZ, RI, RO, Y, SEG);
        const inGap = (i: number) => {
            const a = (i / SEG) * Math.PI * 2;
            return (a > 0.5 && a < 0.65) || (a > 3.5 && a < 3.65);
        };
        const keptIdx: number[] = [];
        for (let i = 0; i < SEG; i++) {
            if (inGap(i) || inGap((i + 1) % SEG)) continue;
            keptIdx.push(6 * i, 6 * i + 1, 6 * i + 2, 6 * i + 3, 6 * i + 4, 6 * i + 5);
        }
        const kept = new Uint32Array(keptIdx.map((k) => gapped.indices[k]!));
        const wps = buildTrackCenterline({ vertices: gapped.vertices, indices: kept });
        expect(wps.length).toBeGreaterThan(0);
        let total = 0;
        for (let i = 0; i < wps.length; i++) {
            const a = wps[i]!, b = wps[(i + 1) % wps.length]!;
            total += Math.hypot(b.x - a.x, b.z - a.z);
        }
        expect(total).toBeGreaterThan(2 * Math.PI * MID * 0.7);
    });

    it('refuses a track broken by a gap wider than maxStepDistance (no false racing line)', () => {
        // One missing arc of ~17m (> the 12m bridge cap). The surviving surface
        // is an open arc, not a loop — a "racing line" over it would send AI
        // cars into the hole lap after lap, so the honest answer is [].
        const gapped = buildRing(CX, CZ, RI, RO, Y, SEG);
        const gapArc = 17 / MID; // radians of arc ≈ 17m at mid radius
        const keptIdx: number[] = [];
        for (let i = 0; i < SEG; i++) {
            const a = (i / SEG) * Math.PI * 2;
            const a1 = (((i + 1) % SEG) / SEG) * Math.PI * 2;
            if ((a > 1.0 && a < 1.0 + gapArc) || (a1 > 1.0 && a1 < 1.0 + gapArc)) continue;
            keptIdx.push(6 * i, 6 * i + 1, 6 * i + 2, 6 * i + 3, 6 * i + 4, 6 * i + 5);
        }
        const kept = new Uint32Array(keptIdx.map((k) => gapped.indices[k]!));
        expect(buildTrackCenterline({ vertices: gapped.vertices, indices: kept })).toEqual([]);
    });

    it('never cross-links two road legs that pass closer than the step cap (topology walk)', () => {
        // Stadium track: two 80m straights whose centerlines sit 10m apart —
        // WITHIN a distance-walk's reach — joined by semicircle ends. The mesh
        // is one connected ribbon, so the topological walk must trace it in
        // order; a proximity walk zigzags between the straights and produces
        // the index-far/space-near tangle that sent AI karts across the infield
        // (2026-07-26, GrandPrixCircuit: waypoints up to 60m off the road).
        const L = 80, R = 5, W = 6; // straight length, end radius, road width
        const path: Array<{ x: number; z: number; nx: number; nz: number }> = [];
        const seg = 24;
        for (let i = 0; i <= seg; i++) path.push({ x: -L / 2 + (L * i) / seg, z: -R, nx: 0, nz: -1 });
        for (let i = 1; i < seg; i++) {
            const a = -Math.PI / 2 + (Math.PI * i) / seg;
            path.push({ x: L / 2 + Math.cos(a) * R, z: Math.sin(a) * R, nx: Math.cos(a), nz: Math.sin(a) });
        }
        for (let i = 0; i <= seg; i++) path.push({ x: L / 2 - (L * i) / seg, z: R, nx: 0, nz: 1 });
        for (let i = 1; i < seg; i++) {
            const a = Math.PI / 2 + (Math.PI * i) / seg;
            path.push({ x: -L / 2 + Math.cos(a) * R, z: Math.sin(a) * R, nx: Math.cos(a), nz: Math.sin(a) });
        }
        const verts: number[] = [];
        for (const p of path) {
            verts.push(p.x - p.nx * (W / 2), 0, p.z - p.nz * (W / 2)); // inner
            verts.push(p.x + p.nx * (W / 2), 0, p.z + p.nz * (W / 2)); // outer
        }
        const idx: number[] = [];
        const n = path.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            idx.push(2 * i, 2 * i + 1, 2 * j + 1, 2 * i, 2 * j + 1, 2 * j);
        }
        const wps = buildTrackCenterline({ vertices: new Float32Array(verts), indices: new Uint32Array(idx) });
        expect(wps.length).toBeGreaterThan(0);
        // Tangle metric: points far apart in loop order must not sit on top of
        // each other in space (the two straights are 10m apart; anything under
        // 6m means the walk jumped between them).
        const N = wps.length;
        let tangles = 0;
        for (let i = 0; i < N; i++) {
            for (let j = i + 3; j < N; j++) {
                if (Math.min(j - i, N - (j - i)) < 8) continue;
                const a = wps[i]!, b = wps[j]!;
                if (Math.hypot(a.x - b.x, a.z - b.z) < 6) tangles++;
            }
        }
        expect(tangles).toBe(0);
    });

    it('returns [] for degenerate input', () => {
        expect(buildTrackCenterline({ vertices: new Float32Array([]), indices: new Uint32Array([]) })).toEqual([]);
        expect(buildTrackCenterline({
            vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
            indices: new Uint32Array([0, 1, 2]),
        })).toEqual([]); // one tiny triangle → too few samples
    });
});
