import { RacingSetup, DEFAULT_RACING_SETUP_OPTIONS } from 'engine/RacingSetup.js';
import type { Vehicle } from 'engine/Vehicle.js';
import type { IVehicleDrivingComponent } from 'engine/VehicleDrivingComponent.js';

/**
 * When the unstuck system splits a welded pair, RacingSetup must tell the car
 * that was driving INTO the other to lift — otherwise an AI with the throttle
 * pinned re-welds within a second and pairs tour the track glued together.
 */

const DT = 1 / 60;

interface FakeState {
    x: number; y: number; z: number;
    /** Gameplay forward, unit XZ. */
    fwd: { x: number; z: number };
    linvel: { x: number; y: number; z: number };
    yields: number[];
}

function fakeRacer(over: Partial<FakeState>, handle: number, withDriver = true): { vehicle: Vehicle; state: FakeState } {
    const state: FakeState = {
        x: 0, y: 0.5, z: 0,
        fwd: { x: 0, z: 1 },
        linvel: { x: 0, y: 0, z: 5 },
        yields: [],
        ...over,
    };
    const driver: IVehicleDrivingComponent | null = withDriver ? {
        update: () => {},
        setTarget: () => {},
        stop: () => {},
        isNear: () => false,
        yieldThrottle: (s: number) => { state.yields.push(s); },
    } : null;
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const body = {
        handle,
        isValid: () => true,
        rotation: () => identity,
        translation: () => ({ x: state.x, y: state.y, z: state.z }),
        setTranslation: (t: { x: number; y: number; z: number }) => { state.x = t.x; state.y = t.y; state.z = t.z; },
        setRotation: () => {},
        setLinvel: () => {},
        setAngvel: () => {},
    };
    const vehicle = {
        getChassisBody: () => body,
        getChassisCollider: () => ({
            halfExtents: () => ({ x: 0.9, y: 0.5, z: 2.1 }),
            translation: () => ({ x: state.x, y: state.y, z: state.z }),
            rotation: () => identity,
        }),
        // Bodywork encloses the wheels on this car, so the guards add nothing.
        getCollisionHalfExtents: () => ({ x: 0.9, y: 0.5, z: 2.1 }),
        getPosition: () => ({ x: state.x, y: state.y, z: state.z }),
        getForwardDirection: () => ({ x: state.fwd.x, y: 0, z: state.fwd.z }),
        getLinearVelocity: () => state.linvel,
        getSpeed: () => Math.hypot(state.linvel.x, state.linvel.y, state.linvel.z),
        getEngineForce: () => 800,
        getMaxEngineForce: () => 1000,
        getMass: () => 1000,
        applyImpulse: () => {},
        getWheelTerrainInfo: () => [{ inContact: true }, { inContact: true }],
        getDrivingComponent: () => driver,
    } as unknown as Vehicle;
    return { vehicle, state };
}

function run(racing: RacingSetup, seconds: number): void {
    for (let t = 0; t < seconds; t += DT) racing.update(DT);
}

describe('RacingSetup ramming yield', () => {
    it('tells the rammer to lift after a separation, and only the rammer', () => {
        // Nose-to-tail train in lockstep at 5 m/s: rammer behind, pointing at
        // the victim; the victim points away down the track.
        const rammer = fakeRacer({ z: 0 }, 1);
        const victim = fakeRacer({ z: 4.1 }, 2); // 0.1 m of chassis overlap

        const racing = new RacingSetup(DEFAULT_RACING_SETUP_OPTIONS);
        racing.register(rammer.vehicle);
        racing.register(victim.vehicle);

        run(racing, DEFAULT_RACING_SETUP_OPTIONS.unstuck.contactDuration * 1.2);

        expect(rammer.state.yields).toHaveLength(1);
        expect(rammer.state.yields[0]!).toBeGreaterThan(0);
        expect(victim.state.yields).toHaveLength(0);
    });

    it('handles driverless cars (the player) without throwing', () => {
        const rammer = fakeRacer({ z: 0 }, 1, false);
        const victim = fakeRacer({ z: 4.1 }, 2, false);

        const racing = new RacingSetup(DEFAULT_RACING_SETUP_OPTIONS);
        racing.register(rammer.vehicle);
        racing.register(victim.vehicle);

        expect(() => run(racing, 2)).not.toThrow();
    });

    it('still forwards separations to a game-supplied onSeparated', () => {
        let calls = 0;
        const rammer = fakeRacer({ z: 0 }, 1);
        const victim = fakeRacer({ z: 4.1 }, 2);

        const racing = new RacingSetup({
            ...DEFAULT_RACING_SETUP_OPTIONS,
            unstuck: {
                ...DEFAULT_RACING_SETUP_OPTIONS.unstuck,
                onSeparated: () => { calls++; },
            },
        });
        racing.register(rammer.vehicle);
        racing.register(victim.vehicle);

        run(racing, DEFAULT_RACING_SETUP_OPTIONS.unstuck.contactDuration * 1.2);
        expect(calls).toBe(1);
        expect(rammer.state.yields).toHaveLength(1); // wiring composes, not replaces
    });
});
