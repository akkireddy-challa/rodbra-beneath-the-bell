/**
 * Directed driving lanes over a forged city's street graph.
 *
 * `ForgedStreetGraph` (world.json, written by the World-Forger for city levels)
 * is undirected: junction nodes and the road segments between them, each with a
 * width. Traffic needs the other half — which side of the road a car drives on,
 * where one lane hands over to the next, and which of the roads leaving a
 * junction count as a left, a straight-on or a right for a car arriving from a
 * given direction. This module derives all of that once, in pure XZ math (no
 * THREE, no engine state), so it can be unit-tested against a synthetic graph
 * and reused by any street-driving system.
 *
 * Conventions match the engine's gameplay frame (`coordinate-system.md`):
 * yaw = atan2(dx, dz), +X is to the LEFT of +Z, so a positive yaw change is a
 * left turn and the right-hand side of a heading (fx, fz) is (-fz, fx).
 */

import type { ForgedStreetGraph } from 'types/game.js';

export interface LanePoint { x: number; z: number }

/** One direction of travel along one street segment. */
export interface Lane {
    /** Index into `StreetLaneGraph.lanes`. */
    id: number;
    /** Index into the source graph's `segments`. */
    segment: number;
    /** Node the lane starts at / ends at. */
    from: number;
    to: number;
    /** Two-point centreline of the lane, offset to the driving side of the road. */
    start: LanePoint;
    end: LanePoint;
    length: number;
    /** Yaw of travel, radians (`atan2(dx, dz)`). */
    heading: number;
    /** Width of the whole road this lane belongs to, metres. */
    roadWidth: number;
    /** The road's kind; a `bridge` carries no asphalt of its own (the deck mesh is the surface). */
    kind: ForgedStreetGraph['segments'][number]['kind'];
}

export type TurnDirection = 'left' | 'straight' | 'right' | 'uturn';

export interface TurnOption {
    direction: TurnDirection;
    /** The lane this turn continues onto. */
    lane: number;
}

export interface Junction {
    node: number;
    x: number;
    z: number;
    /** Lanes ending here / starting here. */
    incoming: number[];
    outgoing: number[];
    /** Number of road segments meeting here; 3+ is an intersection, 2 a bend, 1 a dead end. */
    degree: number;
    /** Half the widest road meeting here plus a margin — cars should hold outside this. */
    radius: number;
}

export interface StreetLaneGraphOptions {
    /**
     * Lane centreline offset from the road centreline as a fraction of the
     * road width. 0.25 puts the lane in the middle of its half of the road.
     */
    laneOffsetFraction: number;
    /** Lower bound on that offset in metres, so a narrow street still separates the two directions. */
    minLaneOffsetM: number;
    /** Turns with |angle| under this are "straight"; over (180° − this) are u-turns. Radians. */
    straightToleranceRad: number;
    /** Added to half the widest road width to form a junction's holding radius. */
    junctionMarginM: number;
}

export const DEFAULT_STREET_LANE_GRAPH_OPTIONS: StreetLaneGraphOptions = {
    laneOffsetFraction: 0.25,
    minLaneOffsetM: 1.5,
    straightToleranceRad: 35 * Math.PI / 180,
    junctionMarginM: 2,
};

/** Wrap an angle into (-π, π]. */
function wrapAngle(a: number): number {
    let r = a % (2 * Math.PI);
    if (r > Math.PI) r -= 2 * Math.PI;
    if (r <= -Math.PI) r += 2 * Math.PI;
    return r;
}

export class StreetLaneGraph {
    readonly lanes: readonly Lane[];
    readonly junctions: ReadonlyMap<number, Junction>;
    private readonly options: StreetLaneGraphOptions;

    private constructor(lanes: Lane[], junctions: Map<number, Junction>, options: StreetLaneGraphOptions) {
        this.lanes = lanes;
        this.junctions = junctions;
        this.options = options;
    }

    static fromStreetGraph(
        graph: ForgedStreetGraph,
        options: StreetLaneGraphOptions = DEFAULT_STREET_LANE_GRAPH_OPTIONS,
    ): StreetLaneGraph {
        const nodeById = new Map<number, { x: number; z: number }>();
        for (const n of graph.nodes) nodeById.set(n.id, { x: n.x, z: n.z });

        const lanes: Lane[] = [];
        const junctions = new Map<number, Junction>();
        const junctionOf = (id: number): Junction => {
            let j = junctions.get(id);
            if (!j) {
                const p = nodeById.get(id)!;
                j = { node: id, x: p.x, z: p.z, incoming: [], outgoing: [], degree: 0, radius: options.junctionMarginM };
                junctions.set(id, j);
            }
            return j;
        };

        graph.segments.forEach((seg, segmentIndex) => {
            const a = nodeById.get(seg.a);
            const b = nodeById.get(seg.b);
            // A segment naming a node the graph does not carry is a broken forge,
            // not a road: skip it rather than drive cars to (undefined, undefined).
            if (!a || !b) return;
            const length = Math.hypot(b.x - a.x, b.z - a.z);
            if (length < 1e-3) return;

            for (const [from, to, p, q] of [[seg.a, seg.b, a, b], [seg.b, seg.a, b, a]] as const) {
                const fx = (q.x - p.x) / length;
                const fz = (q.z - p.z) / length;
                const offset = Math.max(options.minLaneOffsetM, seg.width * options.laneOffsetFraction);
                // Right-hand side of the travel direction — see the module comment.
                const rx = -fz * offset;
                const rz = fx * offset;
                const lane: Lane = {
                    id: lanes.length,
                    segment: segmentIndex,
                    from,
                    to,
                    start: { x: p.x + rx, z: p.z + rz },
                    end: { x: q.x + rx, z: q.z + rz },
                    length,
                    heading: Math.atan2(fx, fz),
                    roadWidth: seg.width,
                    kind: seg.kind,
                };
                lanes.push(lane);
                junctionOf(from).outgoing.push(lane.id);
                junctionOf(to).incoming.push(lane.id);
            }
            for (const id of [seg.a, seg.b]) {
                const j = junctionOf(id);
                j.degree += 1;
                j.radius = Math.max(j.radius, seg.width / 2 + options.junctionMarginM);
            }
        });

        return new StreetLaneGraph(lanes, junctions, options);
    }

    lane(id: number): Lane {
        const lane = this.lanes[id];
        if (!lane) throw new Error(`StreetLaneGraph: no lane ${id}`);
        return lane;
    }

    /** The junction a lane ends at. */
    junctionAtEnd(laneId: number): Junction {
        return this.junctions.get(this.lane(laneId).to)!;
    }

    /** True when three or more roads meet where this lane ends. */
    endsAtIntersection(laneId: number): boolean {
        return this.junctionAtEnd(laneId).degree >= 3;
    }

    /** Signed turn angle from `fromLane` onto `toLane`: positive = left. */
    turnAngle(fromLane: number, toLane: number): number {
        return wrapAngle(this.lane(toLane).heading - this.lane(fromLane).heading);
    }

    classifyTurn(fromLane: number, toLane: number): TurnDirection {
        const angle = this.turnAngle(fromLane, toLane);
        const tol = this.options.straightToleranceRad;
        if (Math.abs(angle) <= tol) return 'straight';
        if (Math.abs(angle) >= Math.PI - tol) return 'uturn';
        return angle > 0 ? 'left' : 'right';
    }

    /**
     * Where a car on `laneId` can go when it reaches the lane's end. U-turns
     * are offered only at a dead end (nowhere else to go); everywhere else the
     * options are the other roads leaving the junction.
     */
    turnOptions(laneId: number): TurnOption[] {
        const lane = this.lane(laneId);
        const junction = this.junctionAtEnd(laneId);
        const options: TurnOption[] = [];
        for (const next of junction.outgoing) {
            if (this.lanes[next]!.to === lane.from) continue; // back the way we came
            options.push({ direction: this.classifyTurn(laneId, next), lane: next });
        }
        if (options.length === 0) {
            for (const next of junction.outgoing) options.push({ direction: 'uturn', lane: next });
        }
        return options;
    }

    /** Distance along a lane of the closest point to (x, z), clamped to [0, length]. */
    progressAlong(laneId: number, x: number, z: number): number {
        const lane = this.lane(laneId);
        const dx = lane.end.x - lane.start.x;
        const dz = lane.end.z - lane.start.z;
        const t = ((x - lane.start.x) * dx + (z - lane.start.z) * dz) / (lane.length * lane.length);
        return Math.max(0, Math.min(1, t)) * lane.length;
    }

    /** Point on a lane at `distance` metres from its start (clamped). */
    pointAlong(laneId: number, distance: number): LanePoint {
        const lane = this.lane(laneId);
        const t = Math.max(0, Math.min(1, distance / lane.length));
        return { x: lane.start.x + (lane.end.x - lane.start.x) * t, z: lane.start.z + (lane.end.z - lane.start.z) * t };
    }
}

/** Compass name for a yaw, for a state a model reads: 'north' is +Z, 'east' is +X. */
export function compassName(heading: number): 'north' | 'northeast' | 'east' | 'southeast' | 'south' | 'southwest' | 'west' | 'northwest' {
    const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;
    const sector = Math.round(wrapAngle(heading) / (Math.PI / 4));
    return names[((sector % 8) + 8) % 8]!;
}

export { wrapAngle };
