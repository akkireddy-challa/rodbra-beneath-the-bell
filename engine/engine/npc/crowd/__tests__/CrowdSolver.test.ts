/**
 * The registry + solver wiring: gather live state, separate, hand back deltas.
 *
 * Uses plain fake members rather than NpcControllers — the solver's whole design
 * point is that it touches no physics, no navmesh and no Object3D, so its tests
 * must not need them either (and the repo's testing rule forbids tests that
 * build levels).
 */
import { CrowdRegistry } from 'engine/npc/crowd/CrowdAgents.js';
import type { CrowdMember } from 'engine/npc/crowd/CrowdAgents.js';
import { CrowdSolver } from 'engine/npc/crowd/CrowdSolver.js';

class FakeMember implements CrowdMember {
    dx = 0;
    dz = 0;
    applied = 0;
    constructor(
        public x: number,
        public z: number,
        public radius = 0.5,
        public mobility = 1,
        public active = true,
    ) { }
    getCrowdX(): number { return this.x; }
    getCrowdZ(): number { return this.z; }
    getCrowdRadius(): number { return this.radius; }
    getCrowdMobility(): number { return this.mobility; }
    isCrowdActive(): boolean { return this.active; }
    applyCrowdSeparation(dx: number, dz: number): void {
        this.dx += dx; this.dz += dz; this.x += dx; this.z += dz; this.applied++;
    }
}

describe('CrowdRegistry', () => {
    test('add is idempotent and remove is O(1) swap without leaving holes', () => {
        const r = new CrowdRegistry();
        const a = new FakeMember(0, 0), b = new FakeMember(10, 0), c = new FakeMember(20, 0);
        r.add(a); r.add(b); r.add(c); r.add(a);
        expect(r.size()).toBe(3);
        r.remove(b);
        expect(r.size()).toBe(2);
        expect(r.gather()).toBe(2);
        r.remove(b); // second removal is a no-op, not a corruption
        expect(r.size()).toBe(2);
    });

    test('gather skips inactive members entirely', () => {
        // A hibernating horde must cost nothing here — that is the payoff of
        // hibernating it in the first place.
        const r = new CrowdRegistry();
        r.add(new FakeMember(0, 0, 0.5, 1, false));
        r.add(new FakeMember(0.2, 0, 0.5, 1, false));
        r.add(new FakeMember(50, 0));
        expect(r.gather()).toBe(1);
    });

    test('scatter reports a delta, not an absolute position', () => {
        const r = new CrowdRegistry();
        const a = new FakeMember(0, 0);
        r.add(a);
        r.gather();
        r.xs[0] = 2.5; // pretend the solver pushed it
        expect(r.scatter()).toBe(1);
        expect(a.dx).toBeCloseTo(2.5, 5);
    });

    test('scatter skips members the solver did not move', () => {
        const r = new CrowdRegistry();
        const a = new FakeMember(0, 0);
        r.add(a);
        r.gather();
        expect(r.scatter()).toBe(0);
        expect(a.applied).toBe(0);
    });
});

describe('CrowdSolver', () => {
    test('separates two overlapping members over successive frames', () => {
        const r = new CrowdRegistry();
        const a = new FakeMember(0, 0), b = new FakeMember(0.4, 0);
        r.add(a); r.add(b);
        const solver = new CrowdSolver();
        for (let i = 0; i < 30; i++) solver.solve(r);
        expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0.95);
    });

    test('a single agent short-circuits without building a grid', () => {
        const r = new CrowdRegistry();
        r.add(new FakeMember(0, 0));
        const res = new CrowdSolver().solve(r);
        expect(res).toEqual({ agents: 1, corrections: 0, moved: 0 });
    });

    test('an empty crowd is a no-op', () => {
        expect(new CrowdSolver().solve(new CrowdRegistry())).toEqual({ agents: 0, corrections: 0, moved: 0 });
    });

    test('an immovable member holds its ground while the crowd yields', () => {
        const r = new CrowdRegistry();
        const player = new FakeMember(0, 0, 0.5, 0);
        r.add(player);
        for (let i = 0; i < 12; i++) r.add(new FakeMember(Math.cos(i) * 0.3, Math.sin(i) * 0.3));
        const solver = new CrowdSolver();
        for (let i = 0; i < 30; i++) solver.solve(r);
        expect(player.x).toBe(0);
        expect(player.z).toBe(0);
        expect(player.applied).toBe(0);
    });

    test('mixed radii still separate — the grid is sized from the largest', () => {
        // A cell smaller than the widest interaction distance silently misses
        // pairs, so this is the regression guard for per-agent cell sizing.
        const r = new CrowdRegistry();
        const big = new FakeMember(0, 0, 3);
        const small = new FakeMember(1, 0, 0.3);
        r.add(big); r.add(small);
        const solver = new CrowdSolver();
        for (let i = 0; i < 60; i++) solver.solve(r);
        expect(Math.hypot(small.x - big.x, small.z - big.z)).toBeGreaterThan(3.0);
    });

    test('reports convergence once the crowd is settled', () => {
        const r = new CrowdRegistry();
        r.add(new FakeMember(0, 0)); r.add(new FakeMember(0.4, 0));
        const solver = new CrowdSolver();
        for (let i = 0; i < 40; i++) solver.solve(r);
        expect(solver.solve(r).corrections).toBe(0);
        expect(solver.getStatsLine()).toContain('2 agents');
    });
});
