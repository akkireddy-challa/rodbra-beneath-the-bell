import { StreetLaneGraph, compassName } from 'engine/StreetLaneGraph.js';
import type { ForgedStreetGraph } from 'types/game.js';

/**
 * A 3×3-node grid: one crossroads in the middle (node 4), four T-junctions on
 * the edges' midpoints, four dead-end corners. Roads run along X ("streets") and
 * along Z ("avenues"), 100 m apart, avenues 16 m wide and streets 10 m wide.
 *
 *   0 ─ 1 ─ 2      z = -100
 *   │   │   │
 *   3 ─ 4 ─ 5      z = 0
 *   │   │   │
 *   6 ─ 7 ─ 8      z = 100
 */
const grid: ForgedStreetGraph = {
    nodes: [
        { id: 0, x: -100, z: -100 }, { id: 1, x: 0, z: -100 }, { id: 2, x: 100, z: -100 },
        { id: 3, x: -100, z: 0 }, { id: 4, x: 0, z: 0 }, { id: 5, x: 100, z: 0 },
        { id: 6, x: -100, z: 100 }, { id: 7, x: 0, z: 100 }, { id: 8, x: 100, z: 100 },
    ],
    segments: [
        { a: 0, b: 1, width: 10, kind: 'street' }, { a: 1, b: 2, width: 10, kind: 'street' },
        { a: 3, b: 4, width: 10, kind: 'street' }, { a: 4, b: 5, width: 10, kind: 'street' },
        { a: 6, b: 7, width: 10, kind: 'street' }, { a: 7, b: 8, width: 10, kind: 'street' },
        { a: 0, b: 3, width: 16, kind: 'avenue' }, { a: 3, b: 6, width: 16, kind: 'avenue' },
        { a: 1, b: 4, width: 16, kind: 'avenue' }, { a: 4, b: 7, width: 16, kind: 'avenue' },
        { a: 2, b: 5, width: 16, kind: 'avenue' }, { a: 5, b: 8, width: 16, kind: 'avenue' },
    ],
};

const laneFromTo = (g: StreetLaneGraph, from: number, to: number) => {
    const lane = g.lanes.find(l => l.from === from && l.to === to);
    if (!lane) throw new Error(`no lane ${from}→${to}`);
    return lane;
};

describe('StreetLaneGraph', () => {
    const g = StreetLaneGraph.fromStreetGraph(grid);

    it('makes two opposing lanes per segment, each on the right-hand side of its travel direction', () => {
        expect(g.lanes).toHaveLength(grid.segments.length * 2);
        // Northbound (+Z) on the central avenue: right-hand side is -X, a quarter of the 16 m road.
        const north = laneFromTo(g, 1, 4);
        expect(north.start.x).toBeCloseTo(-4);
        expect(north.end.x).toBeCloseTo(-4);
        // Southbound on the same road sits on the other side.
        const south = laneFromTo(g, 4, 1);
        expect(south.start.x).toBeCloseTo(4);
        // Eastbound (+X) on the middle street: right-hand side is +Z.
        const east = laneFromTo(g, 3, 4);
        expect(east.start.z).toBeCloseTo(2.5);
        expect(east.heading).toBeCloseTo(Math.PI / 2);
    });

    it('classifies junctions by how many roads meet', () => {
        expect(g.junctions.get(4)!.degree).toBe(4);
        expect(g.junctions.get(1)!.degree).toBe(3);
        expect(g.junctions.get(0)!.degree).toBe(2);
        expect(g.endsAtIntersection(laneFromTo(g, 3, 4).id)).toBe(true);
        expect(g.endsAtIntersection(laneFromTo(g, 1, 0).id)).toBe(false);
        // Holding radius follows the widest road through the junction.
        expect(g.junctions.get(4)!.radius).toBeCloseTo(16 / 2 + 2);
    });

    it('names turns relative to the arriving heading, never offering the road just driven', () => {
        // Arriving at the crossroads heading east (+X): +Z is right, -Z is left.
        const options = g.turnOptions(laneFromTo(g, 3, 4).id);
        const byDirection = new Map(options.map(o => [o.direction, g.lane(o.lane).to]));
        expect(byDirection.get('straight')).toBe(5);
        expect(byDirection.get('left')).toBe(1);
        expect(byDirection.get('right')).toBe(7);
        expect(options.some(o => g.lane(o.lane).to === 3)).toBe(false);
        expect(options).toHaveLength(3);
    });

    it('offers a u-turn only at a dead end', () => {
        // Node 0 is a corner: arriving from 1 (heading west) the only way on is the
        // avenue to 3 (heading north) — a left turn in the +X-is-left-of-+Z frame.
        const corner = g.turnOptions(laneFromTo(g, 1, 0).id);
        expect(corner.map(o => o.direction)).toEqual(['left']);

        const stub: ForgedStreetGraph = {
            nodes: [{ id: 0, x: 0, z: 0 }, { id: 1, x: 0, z: 50 }],
            segments: [{ a: 0, b: 1, width: 8, kind: 'street' }],
        };
        const s = StreetLaneGraph.fromStreetGraph(stub);
        expect(s.turnOptions(laneFromTo(s, 0, 1).id).map(o => o.direction)).toEqual(['uturn']);
    });

    it('measures progress along a lane and skips segments that name missing nodes', () => {
        const lane = laneFromTo(g, 3, 4);
        expect(g.progressAlong(lane.id, -60, 2.5)).toBeCloseTo(40);
        expect(g.progressAlong(lane.id, -500, 0)).toBe(0);
        expect(g.pointAlong(lane.id, 25)).toEqual({ x: -75, z: 2.5 });

        const broken: ForgedStreetGraph = {
            nodes: [{ id: 0, x: 0, z: 0 }],
            segments: [{ a: 0, b: 99, width: 8, kind: 'street' }],
        };
        expect(StreetLaneGraph.fromStreetGraph(broken).lanes).toHaveLength(0);
    });

    it('turns a yaw into a compass name in the +Z-is-north frame', () => {
        expect(compassName(0)).toBe('north');
        expect(compassName(Math.PI / 2)).toBe('east');
        expect(compassName(Math.PI)).toBe('south');
        expect(compassName(-Math.PI / 2)).toBe('west');
        expect(compassName(Math.PI / 4)).toBe('northeast');
    });
});
