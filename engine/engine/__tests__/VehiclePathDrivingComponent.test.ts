import {
    VehiclePathDrivingComponent, DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS,
    projectOntoPath, pointAtArc, curvatureAt, advanceToClearArc, PURSUIT_ARRIVE_CLEARANCE_M,
    INTERMEDIATE_ARRIVE_RADIUS_M, MIN_CORNER_SPEED_MPS, planRouteWithVias,
    STALL_DEFER_LIMIT, STALL_BLOCKED_LIMIT, UNREACHABLE_RETRIGGER_S,
    type VehiclePathFollowOptions,
} from 'engine/VehiclePathDrivingComponent.js';
import { BasicDrivingComponent } from 'engine/VehicleDrivingComponent.js';
import {
    DEFAULT_VEHICLE_NAV_QUERY_OPTIONS,
    type NavPoint, type VehicleNav, type VehicleNavPath, type VehicleNavQueryOptions,
} from 'engine/nav/VehicleNavGrid.js';
import type { Vehicle, VehiclePassResult } from 'engine/Vehicle.js';

const DT = 1 / 60;

/**
 * The only field of a `VehiclePassResult` the component reads is `passable`;
 * `blockedAt`/`reason`/`peakGrade` are filler no assertion here looks at, so
 * every probing test scripts one of these two rather than respelling the
 * whole shape.
 */
const PROBE_CLEAR: VehiclePassResult = { passable: true, blockedAt: 0, reason: 'clear', peakGrade: 0 };
const PROBE_BLOCKED: VehiclePassResult = { passable: false, blockedAt: 0, reason: 'obstacle', peakGrade: 0 };

// Every spy below is a jest.spyOn against BasicDrivingComponent.prototype, so
// one blanket restore keeps them from leaking between tests — no per-test
// try/finally around each one.
afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeCarState {
    x: number;
    z: number;
    speed: number;
    parkingBrakeCalls: boolean[];
    probeCalls: Array<{ fromX: number; fromZ: number; toX: number; toZ: number }>;
    probeResult: VehiclePassResult;
}

/**
 * `withCapabilities` adds getFootprint/getMaxClimbGrade/getMaxStepHeight
 * (the VehicleCapabilitySource trio); `withProbe` adds probePath. Both
 * default off so a bare fake exercises the "vehicle exposes none of this"
 * path — exactly what the pinned VehicleDrivingComponent.test.ts fakes are.
 */
function makeFakeVehicle(
    over: Partial<FakeCarState> = {},
    caps: { withCapabilities?: boolean; withProbe?: boolean } = {},
): { vehicle: Vehicle; state: FakeCarState } {
    const state: FakeCarState = {
        x: 0, z: 0, speed: 0,
        parkingBrakeCalls: [],
        probeCalls: [],
        probeResult: PROBE_CLEAR,
        ...over,
    };
    const base = {
        getPosition: () => ({ x: state.x, y: 0.5, z: state.z }),
        getForwardDirection: () => ({ x: 0, y: 0, z: 1 }),
        getSpeed: () => state.speed,
        setAIControls: () => { /* not exercised by these tests — the inner component's own suite covers steering */ },
        setParkingBrake: (engaged: boolean) => { state.parkingBrakeCalls.push(engaged); },
    };
    const withCapabilities = caps.withCapabilities ? {
        getFootprint: () => ({ width: 2, height: 1.6, length: 4.2 }),
        getMaxClimbGrade: () => 0.33,
        getMaxStepHeight: () => 0.2,
    } : {};
    const withProbe = caps.withProbe ? {
        probePath: (fromX: number, fromZ: number, toX: number, toZ: number): VehiclePassResult => {
            state.probeCalls.push({ fromX, fromZ, toX, toZ });
            return state.probeResult;
        },
    } : {};
    const vehicle = { ...base, ...withCapabilities, ...withProbe } as unknown as Vehicle;
    return { vehicle, state };
}

/** Cumulative arc-length table for a polyline, the shape every path helper takes alongside its points. */
function arcTable(points: NavPoint[]): number[] {
    const table = [0];
    for (let i = 1; i < points.length; i++) {
        table.push(table[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
    }
    return table;
}

function navPath(points: NavPoint[], overrides: Partial<VehicleNavPath> = {}): VehicleNavPath {
    return { points, reachedDestination: true, shortfall: 0, provisional: false, method: 'fake', ...overrides };
}

/** Scriptable VehicleNav: `resultFn` decides what each findVehiclePath call returns; `calls` records every query. */
class FakeNav implements VehicleNav {
    calls: Array<{ from: NavPoint; to: NavPoint; opts?: VehicleNavQueryOptions }> = [];
    fullyBaked = true;
    revision = 1;
    resultFn: (from: NavPoint, to: NavPoint, opts?: VehicleNavQueryOptions) => VehicleNavPath;

    constructor(result: VehicleNavPath) {
        this.resultFn = () => result;
    }

    findVehiclePath(from: NavPoint, to: NavPoint, opts?: VehicleNavQueryOptions): VehicleNavPath {
        this.calls.push({ from, to, opts });
        return this.resultFn(from, to, opts);
    }

    isFullyBaked(): boolean {
        return this.fullyBaked;
    }

    getRevision(): number {
        return this.revision;
    }
}

/**
 * A `FakeNav` for via-point tests: keys each leg's result off its exact `to`
 * point, so one nav can answer differently for car->via1, via1'->via2,
 * via2'->dest, etc. — the multi-leg chain `planRouteWithVias` issues. Throws
 * on an unscripted `to` so a wrong or unexpected query fails loudly instead
 * of silently reusing some other leg's result.
 */
function navByDestination(entries: Array<{ to: NavPoint; result: VehicleNavPath }>): FakeNav {
    const nav = new FakeNav(navPath([]));
    nav.resultFn = (_from, to) => {
        const match = entries.find((e) => e.to.x === to.x && e.to.z === to.z);
        if (!match) throw new Error(`navByDestination: no scripted result for to=${JSON.stringify(to)}`);
        return match.result;
    };
    return nav;
}

/**
 * Frames covering one full stall window plus a margin past the threshold. The
 * fake vehicle only ever moves when a test moves it, so simply running frames
 * without touching its position IS the frozen-car case the watchdog watches for.
 */
const STALL_WINDOW_FRAMES = Math.ceil(DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.stallWindowS / DT) + 5;

/** Runs up to `frames` updates, stopping early once `stopWhen` (checked before each frame) holds. */
function runFrames(
    comp: VehiclePathDrivingComponent, vehicle: Vehicle, frames: number, stopWhen: () => boolean = () => false,
): void {
    for (let i = 0; i < frames && !stopWhen(); i++) {
        comp.update(DT, vehicle);
    }
}

/** Drives `comp` until the inner's failedRecoveries counter first increments — see test 10's doc for why this takes ~6s of simulated time. */
function runUntilRecoveryEscalates(comp: VehiclePathDrivingComponent, vehicle: Vehicle): void {
    for (let i = 0; i < 1000; i++) {
        comp.update(DT, vehicle);
        if (comp.getStatus().inner.failedRecoveries > 0) return;
    }
    throw new Error('test setup assumption broken: failedRecoveries never incremented in 1000 frames');
}

// ---------------------------------------------------------------------------

describe('VehiclePathDrivingComponent', () => {
    it('is a class', () => {
        expect(typeof VehiclePathDrivingComponent).toBe('function');
    });
});

describe('pure helpers', () => {
    describe('projectOntoPath', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 0, z: 20 }];
        const cumulative = [0, 10, 20];

        it('finds the correct arc position and perpendicular distance off-path', () => {
            const p = projectOntoPath(points, cumulative, 0, 3, 5, 20);
            expect(p.s).toBeCloseTo(5, 5);
            expect(p.distance).toBeCloseTo(3, 5);
        });

        it('is monotonic: moving the car backwards along the path does not move s backwards', () => {
            const ahead = projectOntoPath(points, cumulative, 0, 0, 15, 20);
            expect(ahead.s).toBeCloseTo(15, 1);

            // Car actually moved BACKWARDS in world space (z: 15 -> 5), reusing
            // the previous call's s as lastS, as a real per-frame caller would.
            const behind = projectOntoPath(points, cumulative, ahead.s, 0, 5, 20);
            expect(behind.s).toBeGreaterThanOrEqual(ahead.s);
        });

        it('does not jump onto a segment beyond the window', () => {
            // Car sitting right at the start; a point far down the path (s=20)
            // happens to be laterally close too, but the window is small.
            const p = projectOntoPath(points, cumulative, 0, 0.1, 0, 5);
            expect(p.s).toBeLessThan(10);
        });
    });

    describe('pointAtArc', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
        const cumulative = [0, 10, 20];

        it('interpolates linearly within a segment', () => {
            expect(pointAtArc(points, cumulative, 4)).toEqual({ x: 4, z: 0 });
            expect(pointAtArc(points, cumulative, 15)).toEqual({ x: 10, z: 5 });
        });

        it('clamps beyond both ends', () => {
            expect(pointAtArc(points, cumulative, -5)).toEqual({ x: 0, z: 0 });
            expect(pointAtArc(points, cumulative, 500)).toEqual({ x: 10, z: 10 });
        });
    });

    describe('advanceToClearArc', () => {
        // The live switchback, translated to the origin: the car sits just off
        // the start of a 1.4m leg heading north-west, which immediately turns
        // back east — so a point 6m ahead ALONG THE PATH is only ~4.5m away in
        // a straight line.
        const switchback: NavPoint[] = [{ x: 0, z: 0 }, { x: -1, z: 1 }, { x: 17, z: 12 }];
        const switchbackCum = [0, Math.SQRT2, Math.SQRT2 + Math.hypot(18, 11)];
        const car = { x: 0.4, z: 0.17 };

        it('returns the start arc unchanged when that point is already clear', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
            const cumulative = [0, 100];
            expect(advanceToClearArc(points, cumulative, 6, 0, 0, 6)).toBeCloseTo(6, 6);
        });

        it('advances past a switchback until the point is far enough in a straight line', () => {
            const startS = 6;
            const naive = pointAtArc(switchback, switchbackCum, startS);
            expect(Math.hypot(naive.x - car.x, naive.z - car.z)).toBeLessThan(4.5); // the bug's input

            const s = advanceToClearArc(switchback, switchbackCum, startS, car.x, car.z, 6);
            expect(s).not.toBeNull();
            expect(s!).toBeGreaterThan(startS);
            const chosen = pointAtArc(switchback, switchbackCum, s!);
            expect(Math.hypot(chosen.x - car.x, chosen.z - car.z)).toBeGreaterThanOrEqual(6 - 1e-6);
        });

        it('returns null when the whole remaining path stays inside the radius', () => {
            // A path that loops twice around the car at radius 3: 37m of arc,
            // never further than 3m away.
            const loop: NavPoint[] = [];
            for (let i = 0; i <= 64; i++) {
                const a = (i / 16) * Math.PI;
                loop.push({ x: 3 * Math.cos(a), z: 3 * Math.sin(a) });
            }
            const cum = arcTable(loop);
            expect(cum[cum.length - 1]!).toBeGreaterThan(30);
            expect(advanceToClearArc(loop, cum, 6, 0, 0, 6)).toBeNull();
        });
    });

    describe('curvatureAt', () => {
        it('is ~0 on a straight line', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 0, z: 20 }, { x: 0, z: 30 }];
            const cumulative = [0, 10, 20, 30];
            expect(curvatureAt(points, cumulative, 0, 25)).toBeLessThan(0.01);
        });

        it('is positive across an L-corner', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }, { x: 20, z: 10 }];
            const cumulative = [0, 10, 20, 30];
            expect(curvatureAt(points, cumulative, 0, 25)).toBeGreaterThan(0.05);
        });

        it('reads a circular arc as 1 / radius, whatever spacing it was sampled at', () => {
            // The whole point of the CURVATURE_CHORD_M baseline: the estimate
            // describes the route's shape, not where its vertices fell.
            for (const spacing of [0.25, 1, 2]) {
                const radius = 8;
                const points: NavPoint[] = [];
                const steps = Math.ceil((radius * Math.PI / 2) / spacing);
                for (let i = 0; i <= steps; i++) {
                    const a = (i / steps) * (Math.PI / 2);
                    points.push({ x: radius - radius * Math.cos(a), z: radius * Math.sin(a) });
                }
                const cumulative = arcTable(points);
                // Sampled from a little way in, so the end-clamped chords at
                // the arc's extremes are not what the max lands on.
                expect(curvatureAt(points, cumulative, 2, 6)).toBeCloseTo(1 / radius, 1);
            }
        });

        it('does not read a 1 m grid staircase as the near-hairpin per-vertex differencing sees (issue #831)', () => {
            // A 90 degree bend of radius 20 m, walked in 1 m steps snapped to
            // the 8 directions a grid cell allows — the staircase a route
            // degenerates to wherever string-pulling cannot collapse it.
            // Every vertex is a 45 degree kink, so differencing consecutive
            // 1 m legs reads ~1.57 rad/m: a 1.6 m/s cap, which is what used
            // to pin the car at MIN_CORNER_SPEED_MPS through gentle bends.
            //
            // The CURVATURE_CHORD_M baseline does not erase the staircase —
            // its ~0.35 m lateral wobble has a wavelength close to the chord,
            // and no local estimator can tell that from a real wiggle — but
            // it more than doubles the speed such a section allows.
            const radius = 20;
            const dirs: [number, number][] = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
            const points: NavPoint[] = [{ x: 0, z: 0 }];
            const steps = Math.round(radius * Math.PI / 2);
            for (let i = 1; i <= steps; i++) {
                const a = (i / steps) * (Math.PI / 2);
                const ideal = { x: radius - radius * Math.cos(a), z: radius * Math.sin(a) };
                const prev = points[points.length - 1]!;
                let best = prev;
                let bestDist = Infinity;
                for (const [dx, dz] of dirs) {
                    const candidate = { x: prev.x + dx, z: prev.z + dz };
                    const d = Math.hypot(candidate.x - ideal.x, candidate.z - ideal.z);
                    if (d < bestDist) { bestDist = d; best = candidate; }
                }
                points.push(best);
            }
            const cumulative = arcTable(points);
            let worst = 0;
            for (let s = 3; s < cumulative[cumulative.length - 1]! - 8; s += 0.5) {
                worst = Math.max(worst, curvatureAt(points, cumulative, s, 6));
            }
            const cornerSpeed = Math.sqrt(4 / Math.max(worst, 1e-4));

            expect(worst).toBeLessThan(0.5);
            expect(cornerSpeed).toBeGreaterThan(3);
            expect(cornerSpeed).toBeGreaterThan(2 * MIN_CORNER_SPEED_MPS);
        });

        it('still reads an unroundable 90 degree vertex as a corner worth slowing for', () => {
            // The other side of the trade: widening the baseline must not
            // wave a genuine right-angle kink through at cruise speed.
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 20 }, { x: 20, z: 20 }];
            const cumulative = arcTable(points);
            const curvature = curvatureAt(points, cumulative, 16, 6);
            const cornerSpeed = Math.sqrt(4 / Math.max(curvature, 1e-4));

            expect(cornerSpeed).toBeLessThan(3);
            expect(cornerSpeed).toBeGreaterThan(MIN_CORNER_SPEED_MPS);
        });
    });

    describe('planRouteWithVias (via-point support)', () => {
        const opts = DEFAULT_VEHICLE_NAV_QUERY_OPTIONS;

        it('is a pure passthrough to a single findVehiclePath call when there are no vias', () => {
            const nav = new FakeNav(navPath([{ x: 0, z: 0 }, { x: 10, z: 0 }]));
            const { result, viaArcs } = planRouteWithVias(nav, { x: 0, z: 0 }, [], { x: 10, z: 0 }, opts);

            expect(nav.calls.length).toBe(1);
            expect(nav.calls[0]).toEqual({ from: { x: 0, z: 0 }, to: { x: 10, z: 0 }, opts });
            expect(result.points).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
            expect(viaArcs).toEqual([]);
        });

        it('chains one via as two legs, concatenates points dropping the duplicated joint, and records its arc position', () => {
            const via: NavPoint = { x: 10, z: 0 };
            const destination: NavPoint = { x: 30, z: 0 };
            const nav = navByDestination([
                { to: via, result: navPath([{ x: 0, z: 0 }, { x: 10, z: 0 }]) },
                { to: destination, result: navPath([{ x: 10, z: 0 }, { x: 30, z: 0 }]) },
            ]);

            const { result, viaArcs } = planRouteWithVias(nav, { x: 0, z: 0 }, [via], destination, opts);

            expect(nav.calls.length).toBe(2);
            expect(nav.calls[0]).toMatchObject({ from: { x: 0, z: 0 }, to: via });
            expect(nav.calls[1]).toMatchObject({ from: { x: 10, z: 0 }, to: destination });
            // The joint (10,0) appears exactly once in the concatenated path.
            expect(result.points).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 30, z: 0 }]);
            expect(viaArcs).toEqual([10]); // the via's joint is 10m into the combined path
        });

        it('chains two vias in order as three legs', () => {
            const via1: NavPoint = { x: 10, z: 0 };
            const via2: NavPoint = { x: 25, z: 0 };
            const destination: NavPoint = { x: 40, z: 0 };
            const nav = navByDestination([
                { to: via1, result: navPath([{ x: 0, z: 0 }, { x: 10, z: 0 }]) },
                { to: via2, result: navPath([{ x: 10, z: 0 }, { x: 25, z: 0 }]) },
                { to: destination, result: navPath([{ x: 25, z: 0 }, { x: 40, z: 0 }]) },
            ]);

            const { result, viaArcs } = planRouteWithVias(nav, { x: 0, z: 0 }, [via1, via2], destination, opts);

            expect(nav.calls.map((c) => c.to)).toEqual([via1, via2, destination]);
            expect(nav.calls.map((c) => c.from)).toEqual([{ x: 0, z: 0 }, via1, via2]);
            expect(result.points).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 25, z: 0 }, { x: 40, z: 0 }]);
            expect(viaArcs).toEqual([10, 25]);
        });

        it('chains a best-effort first leg from its ACTUAL end (not the requested via), and composes provisional (OR) / reachedDestination+shortfall (final leg)', () => {
            const via: NavPoint = { x: 15, z: 0 }; // requested
            const destination: NavPoint = { x: 38, z: 0 };
            const nav = navByDestination([
                // Best-effort: the plan's own end (10,0) is 5m short of the requested via (15,0).
                {
                    to: via,
                    result: navPath([{ x: 0, z: 0 }, { x: 10, z: 0 }], { reachedDestination: false, shortfall: 5, provisional: true }),
                },
                // The second leg's own end (30,0) is 8m short of the true destination (38,0).
                {
                    to: destination,
                    result: navPath([{ x: 10, z: 0 }, { x: 30, z: 0 }], { reachedDestination: false, shortfall: 8, provisional: false }),
                },
            ]);

            const { result, viaArcs } = planRouteWithVias(nav, { x: 0, z: 0 }, [via], destination, opts);

            expect(nav.calls[1]!.from).toEqual({ x: 10, z: 0 }); // chained from reality, not the requested via
            expect(result.points).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 30, z: 0 }]);
            expect(viaArcs).toEqual([10]);
            expect(result.provisional).toBe(true); // OR of legs: leg 1 provisional, leg 2 not
            expect(result.reachedDestination).toBe(false); // the FINAL leg's verdict
            expect(result.shortfall).toBe(8); // the FINAL leg's shortfall
        });

        it('an empty middle leg aborts the whole via chain and falls back to a direct from->destination plan, dropping every via', () => {
            const via1: NavPoint = { x: 10, z: 0 };
            const via2: NavPoint = { x: 500, z: 500 }; // unreachable -> empty leg
            const destination: NavPoint = { x: 30, z: 0 };
            const nav = navByDestination([
                { to: via1, result: navPath([{ x: 0, z: 0 }, { x: 10, z: 0 }]) },
                { to: via2, result: navPath([]) }, // empty: no drivable cells near its start
                { to: destination, result: navPath([{ x: 0, z: 0 }, { x: 30, z: 0 }], { method: 'direct fallback plan' }) },
            ]);

            const { result, viaArcs } = planRouteWithVias(nav, { x: 0, z: 0 }, [via1, via2], destination, opts);

            // The direct fallback query is re-issued from the ORIGINAL start (0,0), not via1's actual end.
            const directCall = nav.calls.find((c) => c.to.x === destination.x && c.to.z === destination.z);
            expect(directCall).toMatchObject({ from: { x: 0, z: 0 } });
            expect(result.points).toEqual([{ x: 0, z: 0 }, { x: 30, z: 0 }]);
            expect(viaArcs).toEqual([]); // no via joints made it into the fallback plan
            expect(result.method).toContain('dropped'); // logged via the method string
        });

        it('reports blocked (empty points) when even the direct fallback finds nothing', () => {
            const via: NavPoint = { x: 500, z: 500 };
            const destination: NavPoint = { x: 30, z: 0 };
            const nav = new FakeNav(navPath([]));
            nav.resultFn = () => navPath([]); // every query, including the direct fallback, comes back empty

            const { result, viaArcs } = planRouteWithVias(nav, { x: 0, z: 0 }, [via], destination, opts);

            expect(result.points).toEqual([]);
            expect(viaArcs).toEqual([]);
        });
    });
});

describe('VehiclePathDrivingComponent driving', () => {
    it('plans via nav from the vehicle position on the first update; activity planning -> driving', () => {
        const nav = new FakeNav(navPath([{ x: 0, z: 0 }, { x: 0, z: 50 }]));
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 50 });
        expect(comp.getStatus().activity).toBe('planning');

        comp.update(DT, vehicle);

        expect(comp.getStatus().activity).toBe('driving');
        expect(nav.calls.length).toBe(1);
        expect(nav.calls[0]!.from).toEqual({ x: 0, z: 0 });
        expect(nav.calls[0]!.to).toEqual({ x: 0, z: 50 });
    });

    it('uses queryOptionsForVehicle when the vehicle exposes nav capabilities', () => {
        const nav = new FakeNav(navPath([{ x: 0, z: 0 }, { x: 0, z: 50 }]));
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0 }, { withCapabilities: true });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 50 });
        comp.update(DT, vehicle);

        expect(nav.calls[0]!.opts).toEqual({
            footprint: { width: 2, height: 1.6, length: 4.2 },
            maxClimbGrade: 0.33,
            maxStepHeight: 0.2,
        });
    });

    it('falls back to DEFAULT_VEHICLE_NAV_QUERY_OPTIONS when the vehicle exposes no capabilities', () => {
        const nav = new FakeNav(navPath([{ x: 0, z: 0 }, { x: 0, z: 50 }]));
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0 }); // no withCapabilities
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 50 });
        comp.update(DT, vehicle);

        expect(nav.calls[0]!.opts).toEqual(DEFAULT_VEHICLE_NAV_QUERY_OPTIONS);
    });

    it('aims the inner at a point ~lookAhead ahead of the projection on a straight path', () => {
        const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setTarget');
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 200 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 200 });
        comp.update(DT, vehicle); // plans + first pursuit frame
        spy.mockClear();
        comp.update(DT, vehicle); // steady-state pursuit frame

        const [tx, tz, isFinal] = spy.mock.calls.at(-1)!;
        // speed 0 -> lookAheadBaseM (3) < lookAheadMinM (3.5), so lookAhead clamps up to lookAheadMinM.
        expect(isFinal).toBe(false);
        expect(tx).toBeCloseTo(0, 5);
        expect(tz).toBeCloseTo(DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.lookAheadMinM, 0);
    });

    it('keeps the pursuit target outside the INNER (clamped) arrive radius at a switchback', () => {
        const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setTarget');
        // The live geometry that deadlocked the car: the route out doubles
        // straight back, so a point look-ahead along the path can land inside
        // the inner's arrive radius — and the inner's arrival branch (brake +
        // reset its progress watchdog) fires for intermediate targets too, so
        // it would park there forever. The inner is built with the CLAMPED
        // radius (INTERMEDIATE_ARRIVE_RADIUS_M, 1.2 m — see that constant's
        // doc), not the configured options.driving.arriveRadius (4.5 m), so
        // the floor this test checks against is 1.2 + 1.5 = 2.7 m, not 6 m.
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: -1, z: 1 }, { x: 17, z: 12 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle } = makeFakeVehicle({ x: 0.4, z: 0.17, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 17, z: 12 });
        comp.update(DT, vehicle);
        spy.mockClear();
        comp.update(DT, vehicle);

        const [tx, tz, isFinal] = spy.mock.calls.at(-1)!;
        expect(isFinal).toBe(false); // still an intermediate target, not a premature handoff
        expect(Math.hypot(tx - 0.4, tz - 0.17))
            .toBeGreaterThanOrEqual(INTERMEDIATE_ARRIVE_RADIUS_M + PURSUIT_ARRIVE_CLEARANCE_M - 1e-6);
    });

    it('hands off to the true destination when no point on the rest of the path clears the radius', () => {
        const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setTarget');
        // 25m of path that never leaves a 2m circle around the car (well
        // under the 2.7m pursuit-clearance floor -- see
        // INTERMEDIATE_ARRIVE_RADIUS_M's doc), so there is no arc position
        // far enough to aim at. The path is NOT short (maxArc >> lookAhead),
        // so the pre-existing "reached the end of the arc" trigger cannot be
        // what fires here.
        const loop: NavPoint[] = [];
        for (let i = 0; i <= 64; i++) {
            const a = (i / 16) * Math.PI;
            loop.push({ x: 2 * Math.cos(a), z: 2 * Math.sin(a) });
        }
        const nav = new FakeNav(navPath(loop));
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 40, z: 40 });
        comp.update(DT, vehicle);
        spy.mockClear();
        comp.update(DT, vehicle);

        const [tx, tz, isFinal] = spy.mock.calls.at(-1)!;
        expect(isFinal).toBe(true); // the real arrival easing takes over
        expect(tx).toBeCloseTo(40, 5);
        expect(tz).toBeCloseTo(40, 5);
    });

    it('leaves the straight-road pursuit target exactly at the arc look-ahead (no clearance drift)', () => {
        const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setTarget');
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 200 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle } = makeFakeVehicle({ x: 0, z: 20, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 200 });
        comp.update(DT, vehicle);
        spy.mockClear();
        comp.update(DT, vehicle);

        const [tx, tz, isFinal] = spy.mock.calls.at(-1)!;
        expect(isFinal).toBe(false);
        expect(tx).toBeCloseTo(0, 6);
        // Exactly projection + lookAhead: on a straight road the first
        // candidate already clears the radius, so nothing is advanced.
        // Speed 0 -> lookAhead clamps up to lookAheadMinM (3.5), not lookAheadBaseM (3).
        expect(tz).toBeCloseTo(20 + DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.lookAheadMinM, 6);
    });

    it('drops the cruise override near a corner and leaves it effectively unbounded on the straight', () => {
        const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setCruiseOverride');
        // Straight north for 90m, then a sharp corner turning east.
        const points: NavPoint[] = [
            { x: 0, z: 0 }, { x: 0, z: 20 }, { x: 0, z: 40 }, { x: 0, z: 60 }, { x: 0, z: 80 },
            { x: 0, z: 90 }, { x: 10, z: 90 }, { x: 30, z: 90 },
        ];
        const nav = new FakeNav(navPath(points));
        const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 9 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 30, z: 90 });
        comp.update(DT, vehicle); // plan + pursuit, far from the corner
        const straightOverride = spy.mock.calls.at(-1)![0];
        expect(straightOverride).not.toBeNull();
        expect(straightOverride!).toBeGreaterThan(100); // curvature ~0 -> huge cap, effectively unbounded

        // Advance the car toward the corner in steps small enough for
        // projectOntoPath's forward search window to keep tracking it
        // (a single one-frame teleport past the window would read as
        // off-path and replan instead of exercising corner slowdown).
        for (const z of [20, 40, 60, 80, 85]) {
            state.z = z;
            comp.update(DT, vehicle);
        }
        expect(comp.getStatus().activity).toBe('driving'); // no replan derailed the approach
        const cornerOverride = spy.mock.calls.at(-1)![0];

        expect(cornerOverride).not.toBeNull();
        expect(cornerOverride!).toBeLessThan(straightOverride!);
    });

    it('hands off to the true destination near the path end and reports arrived exactly once', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 10 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle, state } = makeFakeVehicle({ x: 0, z: 9, speed: 0 }); // already near the path end
        const comp = new VehiclePathDrivingComponent();
        let arrivedCount = 0;
        comp.setOnArrived(() => { arrivedCount += 1; });

        comp.driveTo(nav, { x: 0, z: 10 });
        comp.update(DT, vehicle);

        expect(comp.getStatus().activity).toBe('arrived');
        expect(comp.getStatus().arrived).toBe(true);
        expect(state.parkingBrakeCalls).toEqual([true]);
        expect(arrivedCount).toBe(1);

        comp.update(DT, vehicle);
        comp.update(DT, vehicle);

        expect(state.parkingBrakeCalls).toEqual([true]); // not re-armed
        expect(arrivedCount).toBe(1); // not re-fired
    });

    describe('final handoff on a best-effort plan (corner-cut-diagnosis.md follow-up)', () => {
        // Shared geometry: a 10m path whose own last point is NOT the true
        // destination — the destination sits 5m further out, past whatever
        // stopped the planner from reaching it. Car starts exactly at the
        // path's own end, so driveAlongPath's reachedEnd branch fires on the
        // very first update (same trick the pre-existing "hands off" tests
        // above use).
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 10 }];
        const destination: NavPoint = { x: 0, z: 15 };
        const shortfall = 5;

        it('parks at the reachable path end (not a beeline) when the plan is best-effort and no probe clears it', () => {
            const nav = new FakeNav(navPath(points, { reachedDestination: false, shortfall }));
            const { vehicle, state } = makeFakeVehicle({ x: 0, z: 10, speed: 0 }); // no withProbe: probing is unavailable
            const comp = new VehiclePathDrivingComponent();
            let arrivedCount = 0;
            comp.setOnArrived(() => { arrivedCount += 1; });

            const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setTarget');
            comp.driveTo(nav, destination);
            comp.update(DT, vehicle);

            // Final target is the PATH END (0,10), not a beeline at the true
            // destination (0,15) — a plain straight line with no path
            // guidance into whatever blocked the rest of the route.
            const [tx, tz, isFinal] = spy.mock.calls.at(-1)!;
            expect([tx, tz, isFinal]).toEqual([0, 10, true]);

            expect(comp.getStatus().activity).toBe('arrived'); // parked at the reachable path end
            expect(state.parkingBrakeCalls).toEqual([true]);
            expect(arrivedCount).toBe(1);

            // distanceRemaining is the Euclidean distance to the TRUE
            // destination, not 0 -- games read this to know "how far short".
            // Car sits exactly at the path end here, so it equals the
            // plan's own shortfall exactly.
            expect(comp.getStatus().distanceRemaining).toBeCloseTo(shortfall, 5);
        });

        it('beelines at the true destination when the plan is best-effort but a one-time probe finds it clear', () => {
            const nav = new FakeNav(navPath(points, { reachedDestination: false, shortfall }));
            const { vehicle, state } = makeFakeVehicle(
                { x: 0, z: 10, speed: 0, probeResult: PROBE_CLEAR },
                { withProbe: true },
            );
            const comp = new VehiclePathDrivingComponent();

            const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setTarget');
            comp.driveTo(nav, destination);
            comp.update(DT, vehicle);

            const [tx, tz, isFinal] = spy.mock.calls.at(-1)!;
            expect([tx, tz, isFinal]).toEqual([destination.x, destination.z, true]); // beeline allowed
            expect(state.probeCalls).toEqual([{ fromX: 0, fromZ: 10, toX: destination.x, toZ: destination.z }]);

            // One-time: a second frame at the same handoff state must not probe again.
            spy.mockClear();
            comp.update(DT, vehicle);
            expect(state.probeCalls.length).toBe(1);
            const [tx2, tz2] = spy.mock.calls.at(-1)!;
            expect([tx2, tz2]).toEqual([destination.x, destination.z]); // still beelining, decision cached
        });
    });

    it('replans when the car drifts far off the path', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 100 });
        comp.update(DT, vehicle);
        expect(nav.calls.length).toBe(1);

        const lookAhead = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.lookAheadMinM; // speed 0 -> clamps up to the floor
        state.x = 3 * lookAhead; // 3x lookAhead off to the side
        comp.update(DT, vehicle);

        expect(nav.calls.length).toBe(2);
        expect(comp.getStatus().replans).toBe(1);
    });

    it('upgrades a provisional path exactly once when the bake finishes, ignoring revision churn while baking', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
        const nav = new FakeNav(navPath(points, { provisional: true }));
        nav.fullyBaked = false;
        nav.revision = 1;
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 100 });
        comp.update(DT, vehicle);
        expect(comp.getStatus().replans).toBe(0);

        // The bake churns the revision on nearly every frame it progresses —
        // a live run reached revision 157. None of this may trigger a replan.
        for (let i = 0; i < 50; i++) {
            nav.revision += 1;
            comp.update(DT, vehicle);
        }
        expect(comp.getStatus().replans).toBe(0);

        // The bake finishes: fully baked, revision bumps one more time, and
        // a fresh (non-provisional) plan is now available.
        nav.fullyBaked = true;
        nav.revision += 1;
        nav.resultFn = () => navPath(points, { provisional: false });
        comp.update(DT, vehicle);
        expect(comp.getStatus().replans).toBe(1);

        comp.update(DT, vehicle);
        expect(comp.getStatus().replans).toBe(1); // no repeat
    });

    it('replans once when the revision changes after the nav is already fully baked', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
        const nav = new FakeNav(navPath(points));
        nav.fullyBaked = true;
        nav.revision = 5;
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 100 });
        comp.update(DT, vehicle);
        expect(comp.getStatus().replans).toBe(0);

        nav.revision = 6; // e.g. a ground-type edit
        comp.update(DT, vehicle);
        expect(comp.getStatus().replans).toBe(1);

        comp.update(DT, vehicle);
        expect(comp.getStatus().replans).toBe(1);
    });

    it('latches to blocked after replanFailureLimit consecutive failing replans', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 100 });
        comp.update(DT, vehicle);
        expect(comp.getStatus().activity).toBe('driving');

        nav.resultFn = () => navPath([]); // every future replan finds nothing
        const limit = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.replanFailureLimit;
        for (let i = 0; i < limit; i++) {
            state.x = 100; // stays hugely off-path every frame -> forces a replan attempt each frame
            comp.update(DT, vehicle);
        }

        expect(comp.getStatus().activity).toBe('blocked');
        expect(comp.getStatus().replans).toBe(limit);
    });

    it('latches to blocked when the car oscillates between two spots >10m apart and every replan is a non-empty but useless path', () => {
        // Pins the rolling-anchor fix. A SINGLE remembered anchor (the bug)
        // only ever compares a new replan against the IMMEDIATELY PRECEDING
        // failing replan's start — so an oscillating car whose consecutive
        // query origins are always >10m apart (by construction, since it
        // alternates between exactly two spots) never matches, the streak
        // keeps resetting to "success", and the car never latches 'blocked'.
        // A rolling WINDOW of the last replanFailureLimit anchors catches it:
        // by the 3rd call (revisiting SPOT_A), the window still holds the
        // 1st call's SPOT_A anchor even though the 2nd call's SPOT_B anchor
        // is also in it and is >10m away.
        const SPOT_A: NavPoint = { x: 1000, z: 0 };
        const SPOT_B: NavPoint = { x: 1020, z: 0 }; // 20m from SPOT_A — comfortably over the ~10m match radius
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 100 });
        comp.update(DT, vehicle); // initial plan succeeds
        expect(comp.getStatus().activity).toBe('driving');

        const limit = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.replanFailureLimit;
        expect(limit).toBe(3); // this test's trace is written for exactly 3 calls

        // Replan #1 (from SPOT_A) finds nothing — a real "no path" failure,
        // seeding the window with SPOT_A. Every replan after that finds a
        // NON-EMPTY but useless path: a persistent-bottleneck nav bug (every
        // route it finds routes back through SPOT_A), independent of which
        // spot it was actually queried from.
        let replanCall = 0;
        nav.resultFn = () => {
            replanCall += 1;
            if (replanCall === 1) return navPath([]);
            return navPath([{ x: SPOT_A.x, z: SPOT_A.z }, { x: SPOT_A.x, z: SPOT_A.z + 1 }]);
        };

        state.x = SPOT_A.x; state.z = SPOT_A.z;
        comp.update(DT, vehicle); // replan #1: empty -> failed, window = [SPOT_A]
        expect(comp.getStatus().activity).toBe('driving');

        state.x = SPOT_B.x; state.z = SPOT_B.z;
        comp.update(DT, vehicle); // replan #2: useless stub at SPOT_A -> matches window -> failed, window = [SPOT_A, SPOT_B]
        expect(comp.getStatus().activity).toBe('driving');

        state.x = SPOT_A.x; state.z = SPOT_A.z;
        comp.update(DT, vehicle); // replan #3 (car back at SPOT_A): still matches SPOT_A in the window -> failed -> limit reached
        expect(comp.getStatus().activity).toBe('blocked');
        expect(comp.getStatus().replans).toBe(limit);
    });

    // Recovery-gated probe (see the class's `driveAlongPath` doc). The inner
    // component's `failedRecoveries` only increments on a SECOND stuck cycle
    // within `escalationWindow` of the first ending (see
    // VehicleDrivingComponent's own escalation tests) — so triggering it
    // through the public API means pinning the vehicle's speed at 0 (a
    // "wall-like" fake, same trick the pinned suite uses) and running real
    // simulated time: ~2.5s to the first stuck burst, ~1s burst, ~2.5s to
    // the second — about 6s, well inside the 1000-frame/~16.7s cap in
    // `runUntilRecoveryEscalates`.
    it('replans when the recovery-gated probe reports the pursuit target as not passable', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 1000 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle, state } = makeFakeVehicle(
            { x: 0, z: 0, speed: 0, probeResult: PROBE_BLOCKED },
            { withProbe: true },
        );
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 1000 });
        comp.update(DT, vehicle);
        const replansBefore = comp.getStatus().replans;

        runUntilRecoveryEscalates(comp, vehicle);

        expect(state.probeCalls.length).toBeGreaterThan(0);
        expect(comp.getStatus().replans).toBeGreaterThan(replansBefore);
    });

    it('does not replan when the recovery-gated probe reports the pursuit target as passable', () => {
        const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 1000 }];
        const nav = new FakeNav(navPath(points));
        const { vehicle, state } = makeFakeVehicle(
            { x: 0, z: 0, speed: 0, probeResult: PROBE_CLEAR },
            { withProbe: true },
        );
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 1000 });
        comp.update(DT, vehicle);
        const replansBefore = comp.getStatus().replans;

        runUntilRecoveryEscalates(comp, vehicle);

        expect(state.probeCalls.length).toBeGreaterThan(0);
        // A passable probe means a transient wedge, not a blocked road — the
        // inner's own reverse-burst recovery is trusted, no replan issued.
        expect(comp.getStatus().replans).toBe(replansBefore);
    });

    it('stop() returns to idle with the inner stopped', () => {
        const nav = new FakeNav(navPath([{ x: 0, z: 0 }, { x: 0, z: 50 }]));
        const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 5 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 50 });
        comp.update(DT, vehicle);
        expect(comp.getStatus().activity).toBe('driving');

        comp.stop();

        expect(comp.getStatus().activity).toBe('idle');
        // A stopped inner brakes on its next update — no target left to steer toward.
        comp.update(DT, vehicle);
        expect(state.parkingBrakeCalls).toEqual([]); // stop() is not an arrival; no park-brake call
    });

    it('setTarget() abandons any path and drives straight at the given point instead', () => {
        const nav = new FakeNav(navPath([{ x: 0, z: 0 }, { x: 0, z: 50 }]));
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0 });
        const comp = new VehiclePathDrivingComponent();

        comp.driveTo(nav, { x: 0, z: 50 });
        comp.update(DT, vehicle);
        expect(comp.getStatus().activity).toBe('driving');
        const callsAfterPathPlan = nav.calls.length;

        const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setTarget');
        comp.setTarget(1, 2, false);
        expect(comp.getStatus().activity).toBe('driving');

        comp.update(DT, vehicle);
        const [tx, tz, isFinal] = spy.mock.calls.at(-1)!;
        expect([tx, tz, isFinal]).toEqual([1, 2, false]);

        // No further nav queries: the path was abandoned, not replanned.
        expect(nav.calls.length).toBe(callsAfterPathPlan);
    });

    it('isNear delegates to the inner component', () => {
        const { vehicle } = makeFakeVehicle({ x: 0, z: 0 });
        const comp = new VehiclePathDrivingComponent();
        comp.setTarget(0, 0);
        comp.update(DT, vehicle);
        expect(comp.isNear(0, 0, 1)).toBe(true);
        expect(comp.isNear(1000, 1000, 1)).toBe(false);
    });

    it('DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS pins the stall-watchdog constants (Fix B)', () => {
        expect(DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.stallProgressEpsilonM).toBe(2);
        expect(DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.stallWindowS).toBe(10);
    });

    it('DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS pins the corner-cut re-tune constants (corner-cut-diagnosis.md)', () => {
        // Old values (6, 0.7, 6) let the look-ahead floor at 6m through every
        // corner, and the inner's uncapped 4.5m arrive radius pushed the
        // pursuit-clearance floor to 6m too — together they meant the
        // look-ahead could never shrink for a tight corner, so the pure-
        // pursuit chord cut inside the planned path.
        expect(DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.lookAheadBaseM).toBe(3);
        expect(DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.lookAheadPerSpeed).toBe(0.6);
        expect(DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.lookAheadMinM).toBe(3.5);
        expect(DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.lookAheadMaxM).toBe(20);
        expect(INTERMEDIATE_ARRIVE_RADIUS_M).toBe(1.2);
        expect(MIN_CORNER_SPEED_MPS).toBe(1.5);
    });

    // Fix B: arc-progress stall watchdog. Isolated from the INNER
    // BasicDrivingComponent's own (unrelated, pre-existing,
    // correctly-functioning) failedRecoveries/unreachable latch by disabling
    // its recovery outright (`recovery.enabled: false`) — a frozen fake
    // position/speed trivially trips THAT mechanism too (it is, after all,
    // also a "the car sat still with a target set" detector), which would
    // leave these tests unable to tell which watchdog actually fired.
    // Disabling it pins the assertions to the NEW outer mechanism only.
    function makeCompWithStallWatchdogOnly(
        overrides: Partial<VehiclePathFollowOptions> = {},
    ): VehiclePathDrivingComponent {
        return new VehiclePathDrivingComponent({
            ...DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS,
            driving: {
                ...DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.driving,
                recovery: { ...DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.driving.recovery, enabled: false },
            },
            ...overrides,
        });
    }

    describe('arc-progress stall watchdog (Fix B)', () => {
        it('replans once the car has made no path progress for stallWindowS, even though the inner reports nothing wrong', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
            const nav = new FakeNav(navPath(points));
            // Frozen at the path's own start — projectOntoPath returns the
            // same s ~0 every frame, so lastS never advances. No `withProbe`:
            // exercises the "no probe support -> replan" branch of
            // probeTowardPursuitOrReplan.
            const { vehicle } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
            const comp = makeCompWithStallWatchdogOnly();

            comp.driveTo(nav, { x: 0, z: 100 });
            comp.update(DT, vehicle); // plans; car sits at the path start
            expect(comp.getStatus().replans).toBe(0);
            expect(comp.getStatus().activity).toBe('driving');
            expect(comp.getStatus().inner.failedRecoveries).toBe(0); // confirms the inner is neutralized

            // The replan should find a genuinely different (improving) path
            // once triggered, so the follower does not immediately re-latch
            // as a failure — the scripted nav returns a path starting
            // further along, simulating "the grid fix now routes around it."
            nav.resultFn = () => navPath([{ x: 0, z: 0 }, { x: 0, z: 90 }]);

            runFrames(comp, vehicle, STALL_WINDOW_FRAMES, () => comp.getStatus().replans > 0);

            expect(comp.getStatus().replans).toBeGreaterThan(0);
            expect(comp.getStatus().inner.failedRecoveries).toBe(0); // still the OUTER watchdog, not the inner
            expect(comp.getStatus().activity).toBe('driving'); // the replan improved -> not blocked
        });

        it('does not replan before stallWindowS has elapsed with no progress', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
            const nav = new FakeNav(navPath(points));
            const { vehicle } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
            const comp = makeCompWithStallWatchdogOnly();

            comp.driveTo(nav, { x: 0, z: 100 });
            comp.update(DT, vehicle);
            expect(comp.getStatus().replans).toBe(0);

            const stallWindowS = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.stallWindowS;
            runFrames(comp, vehicle, Math.floor((stallWindowS * 0.5) / DT)); // well under the window

            expect(comp.getStatus().replans).toBe(0);
        });

        it('resets the stall window on genuine forward progress, so a car that is merely slow never latches', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 1000 }];
            const nav = new FakeNav(navPath(points));
            const creepSpeedMps = 0.5;
            const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: creepSpeedMps });
            const comp = makeCompWithStallWatchdogOnly();

            comp.driveTo(nav, { x: 0, z: 1000 });
            comp.update(DT, vehicle);

            // Continuous slow creep — 0.5 m/s, well under any real driving
            // speed but comfortably over stallProgressEpsilonM(2m)/stallWindowS(10s)
            // = 0.2 m/s, so the outer watchdog's progress check always finds
            // enough movement and keeps resetting.
            const totalSeconds = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.stallWindowS * 3;
            const frames = Math.ceil(totalSeconds / DT);
            for (let i = 0; i < frames; i++) {
                state.z += creepSpeedMps * DT;
                comp.update(DT, vehicle);
            }

            expect(comp.getStatus().replans).toBe(0);
            expect(comp.getStatus().activity).toBe('driving');
        });

        it('latches to blocked when stall-triggered replans repeatedly fail to improve', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
            const nav = new FakeNav(navPath(points));
            const { vehicle } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
            const comp = makeCompWithStallWatchdogOnly();

            comp.driveTo(nav, { x: 0, z: 100 });
            comp.update(DT, vehicle);
            expect(comp.getStatus().activity).toBe('driving');

            // Every replan attempt finds nothing at all — a genuine dead end,
            // exactly the "propBlocked lateral cell with no detour" case.
            nav.resultFn = () => navPath([]);

            const limit = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.replanFailureLimit;
            // Each stalled replan resets the window (see replan()'s failure
            // branch), so reaching the failure limit through the stall path
            // alone takes ~limit full windows.
            runFrames(comp, vehicle, STALL_WINDOW_FRAMES * (limit + 1), () => comp.getStatus().activity !== 'driving');

            expect(comp.getStatus().activity).toBe('blocked');
            expect(comp.getStatus().replans).toBeGreaterThanOrEqual(limit);
            expect(comp.getStatus().inner.failedRecoveries).toBe(0); // blocked via the OUTER watchdog, not the inner
        });

        it('does not replan when the stall probe reports the pursuit point as passable — a transient wedge, trusted to the inner', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
            const nav = new FakeNav(navPath(points));
            const { vehicle, state } = makeFakeVehicle(
                { x: 0, z: 0, speed: 0, probeResult: PROBE_CLEAR },
                { withProbe: true },
            );
            const comp = makeCompWithStallWatchdogOnly();

            comp.driveTo(nav, { x: 0, z: 100 });
            comp.update(DT, vehicle);

            runFrames(comp, vehicle, STALL_WINDOW_FRAMES);

            expect(state.probeCalls.length).toBeGreaterThan(0);
            expect(comp.getStatus().replans).toBe(0); // trusted the passable probe, no replan
            expect(comp.getStatus().activity).toBe('driving');
        });

        // The hillside wedge measured on game XRTDE8YIJ4GI: a car pinned
        // against terrain 2 m off its path still has a clear 4 m line to its
        // pursuit point, so the probe gate above said `passable` on all nine
        // of its firings and the follower deferred to the inner every time —
        // 90 s in `activity: 'driving'`, `replans` stuck at 1, no terminal
        // state. See docs/superpowers/plans/2026-08-19-vehicle-hillside-wedge.md.
        it('stops deferring to a passable probe once a wedge outlives STALL_DEFER_LIMIT windows, and latches blocked', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
            const nav = new FakeNav(navPath(points));
            const { vehicle, state } = makeFakeVehicle(
                { x: 0, z: 0, speed: 0, probeResult: PROBE_CLEAR },
                { withProbe: true },
            );
            const comp = makeCompWithStallWatchdogOnly();

            comp.driveTo(nav, { x: 0, z: 100 });
            comp.update(DT, vehicle);

            // Every replan FINDS a route — the grid still believes in this
            // road, which is the whole reason `replan()`'s own failure latch
            // never fires here. Only the count of windows without arc
            // progress can tell that nothing is working.
            nav.resultFn = () => navPath([{ x: 0, z: 0 }, { x: 0, z: 100 }]);

            // Nothing below ever moves the fake, so simply running frames IS
            // the genuine physical wedge this test needs.
            const runWindows = (count: number): void => {
                runFrames(comp, vehicle, STALL_WINDOW_FRAMES * count);
            };

            // Within the deferral budget the old behaviour must survive
            // intact: the probe is consulted and believed.
            runWindows(STALL_DEFER_LIMIT);
            expect(state.probeCalls.length).toBeGreaterThan(0);
            expect(comp.getStatus().replans).toBe(0);
            expect(comp.getStatus().activity).toBe('driving');

            // Past it, the follower stops asking permission and replans.
            runWindows(1);
            expect(comp.getStatus().replans).toBeGreaterThan(0);

            // And past STALL_BLOCKED_LIMIT it gives up rather than pretending
            // to drive forever.
            runWindows(STALL_BLOCKED_LIMIT);
            expect(comp.getStatus().activity).toBe('blocked');
            expect(comp.getStatus().inner.failedRecoveries).toBe(0); // the OUTER watchdog, not the inner
        });

        it('re-arms the unreachable trigger instead of firing once per drive', () => {
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }];
            const nav = new FakeNav(navPath(points));
            const { vehicle, state } = makeFakeVehicle(
                { x: 0, z: 0, speed: 0, probeResult: PROBE_CLEAR },
                { withProbe: true },
            );
            // A stall window long enough that the arc-progress watchdog
            // cannot fire within this test — every probe call below therefore
            // comes from the inner's `unreachable` trigger alone.
            const comp = makeCompWithStallWatchdogOnly({ stallWindowS: 10_000 });

            comp.driveTo(nav, { x: 0, z: 100 });
            comp.update(DT, vehicle);

            // Long enough for `unreachable` to latch (noProgressTimeout) and
            // then for several re-arm cooldowns to elapse. The fake never
            // moves on its own, so these frames are a stationary car.
            runFrames(comp, vehicle, Math.ceil((UNREACHABLE_RETRIGGER_S * 4) / DT));

            expect(comp.getStatus().inner.unreachable).toBe(true);
            // Before the re-arm this was exactly 1 for the whole run, however
            // long the car sat there.
            expect(state.probeCalls.length).toBeGreaterThan(1);
        });
    });

    // Regression coverage for corner-cut-diagnosis.md: a live run measured
    // the car cutting 1.37-1.54 m inside its planned path at corners
    // (structural cause: the pursuit-clearance floor forced the look-ahead
    // to never shrink for tight corners) and, separately, sitting wedged for
    // 57+ s at one corner because a near-zero commanded cruise speed reads
    // as "achieved" rather than "failing," so neither the inner's recovery
    // nor the outer stall watchdog ever armed.
    describe('corner-cutting fix (corner-cut-diagnosis.md)', () => {
        /** Perpendicular distance from (x, z) to the closest point on the (unwindowed) polyline — a plain geometric helper, not the production windowed `projectOntoPath`. */
        function distanceToPolyline(points: NavPoint[], x: number, z: number): number {
            let best = Infinity;
            for (let i = 0; i < points.length - 1; i++) {
                const ax = points[i]!.x, az = points[i]!.z;
                const bx = points[i + 1]!.x, bz = points[i + 1]!.z;
                const dx = bx - ax, dz = bz - az;
                const len2 = dx * dx + dz * dz;
                let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
                t = Math.max(0, Math.min(1, t));
                const px = ax + t * dx, pz = az + t * dz;
                const d = Math.hypot(x - px, z - pz);
                if (d < best) best = d;
            }
            return best;
        }

        it('keeps the pursuit-target chord within 0.7 m cross-track of a synthetic 90 degree corner at min look-ahead', () => {
            // A realistic road corner: straight for 30 m, a smooth 90 degree
            // quarter-circle bend (radius ~3.82 m, ~6 m of arc -- matching
            // the diagnosis's measured turns, which bent over about 6 m of
            // arc, not an instantaneous vertex), then straight again. The
            // car approaches ON the path at a steady crawl (speed pinned at
            // 0 the whole way, so lookAhead stays at its floor -- "at min
            // look-ahead" -- reproducing the exact regime the diagnosis
            // measured cutting 1.37-1.54 m inside the plan).
            const radius = 3.8197; // r * (pi/2) ~= 6 m of arc
            const z0 = 30;
            const points: NavPoint[] = [{ x: 0, z: 0 }, { x: 0, z: z0 }];
            const arcSubdivisions = 24;
            for (let i = 1; i <= arcSubdivisions; i++) {
                const a = (i / arcSubdivisions) * (Math.PI / 2);
                points.push({ x: radius - radius * Math.cos(a), z: z0 + radius * Math.sin(a) });
            }
            points.push({ x: radius + 40, z: z0 + radius });

            const nav = new FakeNav(navPath(points));
            const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
            const comp = new VehiclePathDrivingComponent();
            comp.driveTo(nav, { x: radius + 40, z: z0 + radius });

            const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setTarget');
            let maxDeviation = 0;
            // Walk the car up the straight approach, exactly on the path, in
            // small steps -- so projectOntoPath's forward window tracks it
            // naturally (no off-path replan) -- and at every step measure the
            // CHORD from the car's current position to that frame's chosen
            // pursuit target against the true polyline, recording the worst
            // (max) deviation.
            for (let z = 0; z <= z0; z += 0.25) {
                state.z = z;
                spy.mockClear();
                comp.update(DT, vehicle);
                expect(comp.getStatus().activity).toBe('driving'); // no replan derailed the approach

                const [tx, tz] = spy.mock.calls.at(-1)!;
                for (let t = 0; t <= 1; t += 0.02) {
                    const cx = state.x + (tx - state.x) * t;
                    const cz = state.z + (tz - state.z) * t;
                    maxDeviation = Math.max(maxDeviation, distanceToPolyline(points, cx, cz));
                }
            }

            expect(maxDeviation).toBeLessThanOrEqual(0.7);
        });

        it('floors the cruise override at MIN_CORNER_SPEED_MPS on a curl tighter than the floor (never commands a near-arrival speed)', () => {
            const spy = jest.spyOn(BasicDrivingComponent.prototype, 'setCruiseOverride');
            // A sustained curl far tighter than any street: curvature is high
            // enough that the raw sqrt(maxLateralAccel / curvature) term alone
            // comes out under MIN_CORNER_SPEED_MPS -- the near-zero commanded
            // speed measured live (~0.09 m/s).
            //
            // Radius, not vertex angle, is what sets that: `curvatureAt`
            // measures each heading over a CURVATURE_CHORD_M baseline, so a
            // sustained radius R reads as exactly 1/R and the raw term is
            // sqrt(maxLateralAccel * R) -- under the 1.5 m/s floor for any R
            // below ~0.56 m. Two full turns at 0.5 m keeps the reading up for
            // the whole sampled span.
            const radius = 0.5;
            const hairpin: NavPoint[] = [];
            for (let i = 0; i <= 128; i++) {
                const a = (i / 128) * Math.PI * 4;
                hairpin.push({ x: radius - radius * Math.cos(a), z: radius * Math.sin(a) });
            }
            hairpin.push({ x: radius * 2, z: 50 }); // tail, so the path doesn't immediately hand off to the destination
            const nav = new FakeNav(navPath(hairpin));
            const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
            const comp = new VehiclePathDrivingComponent();

            comp.driveTo(nav, { x: radius * 2, z: 50 });
            for (let i = 0; i < 20; i++) {
                comp.update(DT, vehicle);
                state.z += 0.02; // small creep, keeps the projection tracking forward through the curve
            }

            const speedCalls = spy.mock.calls.map((c) => c[0]).filter((v): v is number => v !== null);
            expect(speedCalls.length).toBeGreaterThan(0);
            for (const v of speedCalls) {
                expect(v).toBeGreaterThanOrEqual(MIN_CORNER_SPEED_MPS - 1e-9);
            }
            // The floor must actually be the active constraint here, not
            // vacuously satisfied because the raw term already cleared it.
            expect(Math.min(...speedCalls)).toBeCloseTo(MIN_CORNER_SPEED_MPS, 5);
        });

        it('wedged-at-a-corner: commanded cruise stays >= MIN_CORNER_SPEED_MPS, and the outer stall watchdog still fires and escalates when the car never actually moves (the observed 57 s live freeze cannot recur)', () => {
            const cruiseSpy = jest.spyOn(BasicDrivingComponent.prototype, 'setCruiseOverride');
            // Same tight hairpin as above, but this time the car's world
            // position is frozen after the first update -- "achieves" a
            // near-zero raw command by sitting still, matching the live
            // measurement of a car pinned at <=0.09 m/s for 57+ s at a sharp
            // corner. Inner recovery is disabled (as in the other Fix B
            // tests) to isolate the OUTER arc-progress watchdog.
            const radius = 0.2;
            const hairpin: NavPoint[] = [];
            for (let i = 0; i <= 32; i++) {
                const a = (i / 32) * Math.PI;
                hairpin.push({ x: radius - radius * Math.cos(a), z: radius * Math.sin(a) });
            }
            hairpin.push({ x: radius * 2, z: 50 });
            const nav = new FakeNav(navPath(hairpin));
            const { vehicle } = makeFakeVehicle({ x: radius, z: 0, speed: 0.05 });
            const comp = makeCompWithStallWatchdogOnly();

            comp.driveTo(nav, { x: radius * 2, z: 50 });
            comp.update(DT, vehicle);
            expect(comp.getStatus().replans).toBe(0);

            const speedCalls = cruiseSpy.mock.calls.map((c) => c[0]).filter((v): v is number => v !== null);
            expect(speedCalls.length).toBeGreaterThan(0);
            for (const v of speedCalls) {
                expect(v).toBeGreaterThanOrEqual(MIN_CORNER_SPEED_MPS - 1e-9);
            }

            // Position never advances from here on: a genuine physical wedge,
            // not merely a slow crawl. Every replan attempt finds nothing (a
            // real dead end), so the follower must eventually escalate to
            // 'blocked' rather than sit frozen indefinitely.
            nav.resultFn = () => navPath([]);
            const limit = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.replanFailureLimit;
            runFrames(comp, vehicle, STALL_WINDOW_FRAMES * (limit + 1), () => comp.getStatus().activity !== 'driving');

            expect(comp.getStatus().replans).toBeGreaterThan(0);
            expect(comp.getStatus().activity).toBe('blocked');
        });
    });

    describe('via-point support (DriveToOptions.via)', () => {
        it('drives through one via as ONE continuous path: no arrival, no park brake, no onArrived, and distanceRemaining (arc-length) advances monotonically across the joint', () => {
            const via: NavPoint = { x: 10, z: 0 };
            const destination: NavPoint = { x: 20, z: 0 };
            const nav = navByDestination([
                { to: via, result: navPath([{ x: 0, z: 0 }, { x: 10, z: 0 }]) },
                { to: destination, result: navPath([{ x: 10, z: 0 }, { x: 20, z: 0 }]) },
            ]);
            const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
            const comp = new VehiclePathDrivingComponent();
            let arrivedCount = 0;
            comp.setOnArrived(() => { arrivedCount += 1; });

            comp.driveTo(nav, destination, { via: [via] });
            comp.update(DT, vehicle); // plans BOTH legs on the first update

            expect(nav.calls.length).toBe(2);
            expect(nav.calls[0]!.to).toEqual(via);
            expect(nav.calls[1]!.to).toEqual(destination);

            let prevRemaining = comp.getStatus().distanceRemaining;
            expect(prevRemaining).toBeCloseTo(20, 5); // one unified arc-length table over both legs

            // Walk well past the via joint (x=10) but stop short of the
            // destination's arrive radius (SMOOTH_DRIVING_OPTIONS default
            // 4.5m -- see the "hands off" tests above), so this loop isolates
            // the joint itself rather than the (separately covered, pinned)
            // final-arrival easing.
            for (let x = 0; x <= 14; x += 1) {
                state.x = x;
                comp.update(DT, vehicle);
                // Driving straight through the via joint (x=10): no arrival
                // behaviour of any kind fires at it.
                expect(comp.getStatus().activity).toBe('driving');
                expect(state.parkingBrakeCalls).toEqual([]);
                expect(arrivedCount).toBe(0);
                const remaining = comp.getStatus().distanceRemaining;
                expect(remaining).toBeLessThanOrEqual(prevRemaining + 1e-6); // s is monotonic across the joint
                prevRemaining = remaining;
            }

            state.x = 20;
            comp.update(DT, vehicle);
            expect(comp.getStatus().activity).toBe('arrived'); // only the TRUE destination arrives
            expect(arrivedCount).toBe(1);
            expect(state.parkingBrakeCalls).toEqual([true]);
        });

        it('chains two vias correctly end to end (three legs, ordered)', () => {
            const via1: NavPoint = { x: 10, z: 0 };
            const via2: NavPoint = { x: 20, z: 0 };
            const destination: NavPoint = { x: 30, z: 0 };
            const nav = navByDestination([
                { to: via1, result: navPath([{ x: 0, z: 0 }, { x: 10, z: 0 }]) },
                { to: via2, result: navPath([{ x: 10, z: 0 }, { x: 20, z: 0 }]) },
                { to: destination, result: navPath([{ x: 20, z: 0 }, { x: 30, z: 0 }]) },
            ]);
            const { vehicle } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
            const comp = new VehiclePathDrivingComponent();

            comp.driveTo(nav, destination, { via: [via1, via2] });
            comp.update(DT, vehicle);

            expect(nav.calls.map((c) => c.to)).toEqual([via1, via2, destination]);
            expect(nav.calls.map((c) => c.from)).toEqual([{ x: 0, z: 0 }, via1, via2]);
            expect(comp.getStatus().distanceRemaining).toBeCloseTo(30, 5);
        });

        it('via consumption: once the car has driven past via1, a forced replan queries current -> via2 -> dest, NOT via1', () => {
            const via1: NavPoint = { x: 10, z: 0 };
            const via2: NavPoint = { x: 30, z: 0 };
            const destination: NavPoint = { x: 50, z: 0 };
            const nav = navByDestination([
                { to: via1, result: navPath([{ x: 0, z: 0 }, { x: 10, z: 0 }]) },
                { to: via2, result: navPath([{ x: 10, z: 0 }, { x: 30, z: 0 }]) },
                { to: destination, result: navPath([{ x: 30, z: 0 }, { x: 50, z: 0 }]) },
            ]);
            const { vehicle, state } = makeFakeVehicle({ x: 0, z: 0, speed: 0 });
            const comp = new VehiclePathDrivingComponent();

            comp.driveTo(nav, destination, { via: [via1, via2] });
            comp.update(DT, vehicle); // initial 3-leg plan
            expect(nav.calls.length).toBe(3);

            // Drive past via1's recorded arc position (10m) but stay well
            // short of via2 (30m) -- small steps so projectOntoPath's
            // forward window keeps tracking the car (no off-path replan
            // triggered by these moves alone).
            for (let x = 1; x <= 15; x += 1) {
                state.x = x;
                comp.update(DT, vehicle);
            }
            expect(nav.calls.length).toBe(3); // no replan yet -- still on path, via1 just consumed

            // Force a replan via an off-path teleport.
            const lookAhead = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS.lookAheadMinM; // speed 0 -> clamps to the floor
            state.x = 15;
            state.z = 3 * lookAhead; // 3x lookAhead off to the side
            comp.update(DT, vehicle);

            expect(comp.getStatus().replans).toBe(1);
            expect(nav.calls.length).toBe(5); // exactly one replan: 2 legs (via2 -> dest), via1 dropped
            expect(nav.calls[3]).toMatchObject({ from: { x: 15, z: 3 * lookAhead }, to: via2 });
            expect(nav.calls[4]).toMatchObject({ to: destination });
            expect(nav.calls.slice(3).some((c) => c.to.x === via1.x && c.to.z === via1.z)).toBe(false);
        });
    });
});
