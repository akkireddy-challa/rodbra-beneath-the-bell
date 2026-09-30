import { VehicleUnstuckSystem, DEFAULT_VEHICLE_UNSTUCK_OPTIONS } from 'engine/VehicleUnstuckSystem.js';
import type { Vehicle } from 'engine/Vehicle.js';

/**
 * The bar for intervening is high: a false positive throws two cars apart in
 * the middle of a race, which is far worse than leaving a jam for another
 * second. These tests pin the cases that must NOT fire (cars near each other,
 * a car passing another with real relative motion, parked cars) alongside the
 * two that must: a jam at a standstill and a welded TRAIN at racing speed —
 * lockstep relative motion is the stuck signal, never absolute speed.
 */

const DT = 1 / 60;

interface FakeState {
    x: number; y: number; z: number;
    yaw: number;
    linvel: { x: number; y: number; z: number };
    engineForce: number;
    impulses: Array<{ x: number; y: number; z: number }>;
    translations: number;
    /** Half-width of the car INCLUDING its wheel guards (the bodywork is 0.9). */
    guardHalfX: number;
}

/** A 1.8 m × 4.2 m, 1000 kg car. */
function fakeVehicle(over: Partial<FakeState> = {}, handle = 1): { vehicle: Vehicle; state: FakeState } {
    const state: FakeState = {
        x: 0, y: 0.5, z: 0, yaw: 0,
        linvel: { x: 0, y: 0, z: 0 },
        engineForce: 800,
        impulses: [], translations: 0,
        guardHalfX: 0.9,
        ...over,
    };
    const body = {
        handle,
        isValid: () => true,
        translation: () => ({ x: state.x, y: state.y, z: state.z }),
        setTranslation: (t: { x: number; y: number; z: number }) => {
            state.x = t.x; state.y = t.y; state.z = t.z; state.translations++;
        },
    };
    const vehicle = {
        getChassisBody: () => body,
        getChassisCollider: () => ({
            halfExtents: () => ({ x: 0.9, y: 0.5, z: 2.1 }),
            translation: () => ({ x: state.x, y: state.y, z: state.z }),
            rotation: () => ({ x: 0, y: Math.sin(state.yaw / 2), z: 0, w: Math.cos(state.yaw / 2) }),
        }),
        getCollisionHalfExtents: () => ({ x: state.guardHalfX, y: 0.5, z: 2.1 }),
        getLinearVelocity: () => state.linvel,
        getSpeed: () => Math.hypot(state.linvel.x, state.linvel.y, state.linvel.z),
        getEngineForce: () => state.engineForce,
        getMass: () => 1000,
        applyImpulse: (x: number, y: number, z: number) => { state.impulses.push({ x, y, z }); },
    } as unknown as Vehicle;
    return { vehicle, state };
}

function run(system: VehicleUnstuckSystem, seconds: number): void {
    for (let t = 0; t < seconds; t += DT) system.update(DT);
}

const opts = { ...DEFAULT_VEHICLE_UNSTUCK_OPTIONS, debugLog: false };

/** Two cars, `centreGap` metres between centres along X, both crawling on the throttle. */
function pair(centreGap: number, speed = 0.2) {
    const a = fakeVehicle({ x: centreGap, linvel: { x: 0, y: 0, z: speed } }, 1);
    const b = fakeVehicle({ x: 0, linvel: { x: 0, y: 0, z: speed } }, 2);
    const system = new VehicleUnstuckSystem(opts);
    system.register(a.vehicle);
    system.register(b.vehicle);
    return { system, a, b };
}

describe('VehicleUnstuckSystem', () => {
    it('leaves cars alone when they are close but not touching', () => {
        // 0.3 m of clear air between the flanks — the old centre-distance test
        // fired here and threw both cars a metre sideways.
        const { system, a, b } = pair(2.1);
        run(system, opts.contactDuration * 4);
        expect(a.state.impulses).toHaveLength(0);
        expect(b.state.impulses).toHaveLength(0);
        expect(a.state.translations).toBe(0);
    });

    it('leaves a car alone while it is passing another (relative motion)', () => {
        // Touching, both fast, but 4 m/s of relative speed — a pass in
        // progress, not a weld. (In reality the pass would also open the gap;
        // holding the geometry still isolates the lockstep gate.)
        const { system, a, b } = pair(1.7, 25);
        b.state.linvel = { x: 0, y: 0, z: 21 };
        run(system, opts.contactDuration * 4);
        expect(a.state.impulses).toHaveLength(0);
        expect(b.state.impulses).toHaveLength(0);
    });

    it('frees a welded train doing racing speed — the AI-pairs bug', () => {
        // Rear-ended into lockstep: both cars at 15 m/s, boxes touching, gap
        // frozen. The old ABSOLUTE speed gate (both below 3 m/s) blinded the
        // system to every at-speed weld, so AI pairs toured the track glued.
        const { system, a, b } = pair(1.7, 15);
        run(system, opts.contactDuration * 1.5);
        expect(a.state.impulses).toHaveLength(1);
        expect(b.state.impulses).toHaveLength(1);
        expect(a.state.impulses[0]!.x).toBeGreaterThan(0);
        expect(b.state.impulses[0]!.x).toBeLessThan(0);
    });

    it('frees buggies locked TYRE-to-tyre, whose bodies never touch', () => {
        // Exposed axles put the whole wheel outboard of the bodywork, so the
        // wheel guards are what meet — 1.4 m of guard against 0.9 m of body.
        // Measured on the chassis collider alone this pair reads as a metre
        // apart and the one system that could free them never looks.
        const { system, a, b } = pair(2.7, 15);
        a.state.guardHalfX = 1.4;
        b.state.guardHalfX = 1.4;
        run(system, opts.contactDuration * 1.5);
        expect(a.state.impulses).toHaveLength(1);
        expect(b.state.impulses).toHaveLength(1);
    });

    it('still leaves body-width cars alone at that same distance', () => {
        // Same geometry, wheels tucked under the bodywork: 0.9 m of clear air.
        const { system, a, b } = pair(2.7, 15);
        run(system, opts.contactDuration * 4);
        expect(a.state.impulses).toHaveLength(0);
        expect(b.state.impulses).toHaveLength(0);
    });

    it('leaves parked cars alone even when they are touching', () => {
        const { system, a, b } = pair(1.7, 0);
        a.state.engineForce = 0;
        b.state.engineForce = 0;
        run(system, opts.contactDuration * 4);
        expect(a.state.impulses).toHaveLength(0);
        expect(b.state.translations).toBe(0);
    });

    it('frees two crawling cars that stay locked together', () => {
        const { system, a, b } = pair(1.7);

        run(system, opts.contactDuration * 0.5);
        expect(a.state.impulses).toHaveLength(0); // must persist first

        run(system, opts.contactDuration);
        expect(a.state.impulses).toHaveLength(1);
        expect(b.state.impulses).toHaveLength(1);
        // Pushed apart along the contact normal (+X for a, -X for b).
        expect(a.state.impulses[0]!.x).toBeGreaterThan(0);
        expect(b.state.impulses[0]!.x).toBeLessThan(0);
        expect(a.state.impulses[0]!.y).toBe(0); // never a vertical kick
    });

    it('corrects by the overlap depth, not a fixed distance', () => {
        const { system, a, b } = pair(1.7); // 0.1 m of overlap
        run(system, opts.contactDuration * 1.5);
        // Half the overlap each, plus epsilon — centimetres, not metres.
        expect(a.state.x - 1.7).toBeGreaterThan(0);
        expect(a.state.x - 1.7).toBeLessThan(0.06);
        expect(b.state.x).toBeGreaterThan(-0.06);
        expect(b.state.x).toBeLessThan(0);
    });

    it('never adds energy to cars already parting (manual bumpPair)', () => {
        // Detection can't reach a fast-parting pair (relative motion clears the
        // lockstep gate), but bumpPair — the manual reset path — can. Even
        // there the impulse only tops UP to the target: a pair already flying
        // apart gets the de-penetration and nothing else.
        const { system, a, b } = pair(1.7);
        a.state.linvel = { x: 5, y: 0, z: 0 };
        b.state.linvel = { x: -5, y: 0, z: 0 };
        system.bumpPair(a.vehicle, b.vehicle);
        expect(a.state.impulses).toHaveLength(0);
        expect(b.state.impulses).toHaveLength(0);
    });

    it('caps the detected separation at a walking pace, mass-scaled', () => {
        // Stationary pair: each car takes half the shortfall, mass-scaled, and
        // the target itself scales with car size (4.2 m car / 3.4 m reference).
        const still = pair(1.7, 0);
        run(still.system, opts.contactDuration * 1.5);
        const dv = still.a.state.impulses[0]!.x / 1000;
        expect(dv).toBeCloseTo((opts.bumpSpeed * (4.2 / 3.4)) / 2, 5);
        expect(dv).toBeLessThan(1); // a walking pace, not a launch
    });

    it('reports every separation through onSeparated', () => {
        const events: Array<{ nx: number; nz: number }> = [];
        const a = fakeVehicle({ x: 1.7, engineForce: 800 }, 1);
        const b = fakeVehicle({ x: 0, engineForce: 800 }, 2);
        const system = new VehicleUnstuckSystem({
            ...opts,
            onSeparated: (e) => {
                expect([a.vehicle, b.vehicle]).toContain(e.vehicleA);
                expect([a.vehicle, b.vehicle]).toContain(e.vehicleB);
                events.push({ nx: e.nx, nz: e.nz });
            },
        });
        system.register(a.vehicle);
        system.register(b.vehicle);
        run(system, opts.contactDuration * 1.5);
        expect(events).toHaveLength(1);
        expect(Math.abs(events[0]!.nx)).toBeCloseTo(1, 6); // separated sideways
    });

    it('does nothing while disabled — the start-line grid case', () => {
        const { system, a } = pair(1.7);
        system.setEnabled(false);
        run(system, opts.contactDuration * 4);
        expect(a.state.impulses).toHaveLength(0);

        system.setEnabled(true);
        run(system, opts.contactDuration * 1.5);
        expect(a.state.impulses).toHaveLength(1);
    });

    it('forgets the contact window as soon as the cars come apart', () => {
        const { system, a, b } = pair(1.7);
        run(system, opts.contactDuration * 0.9);
        a.state.x = 4; // broke free on its own
        run(system, DT * 4);
        a.state.x = 1.7; // back in contact — the clock starts over
        run(system, opts.contactDuration * 0.9);
        expect(a.state.impulses).toHaveLength(0);
    });

    it('honours the per-pair cooldown', () => {
        const { system, a } = pair(1.7);
        run(system, opts.contactDuration * 1.5);
        expect(a.state.impulses).toHaveLength(1);
        // Still locked, but inside the cooldown window.
        a.state.x = 1.7;
        run(system, opts.cooldownMs / 1000 * 0.5);
        expect(a.state.impulses).toHaveLength(1);
    });

    it('ignores a car passing overhead on a bridge', () => {
        const a = fakeVehicle({ x: 0, y: 6, linvel: { x: 0, y: 0, z: 0.2 } }, 1);
        const b = fakeVehicle({ x: 0, y: 0.5, linvel: { x: 0, y: 0, z: 0.2 } }, 2);
        const system = new VehicleUnstuckSystem(opts);
        system.register(a.vehicle);
        system.register(b.vehicle);
        run(system, opts.contactDuration * 4);
        expect(a.state.impulses).toHaveLength(0);
    });
});
