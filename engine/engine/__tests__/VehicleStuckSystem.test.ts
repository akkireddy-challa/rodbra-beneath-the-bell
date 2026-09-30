import { VehicleStuckSystem, DEFAULT_VEHICLE_STUCK_OPTIONS } from 'engine/VehicleStuckSystem.js';
import type { Vehicle } from 'engine/Vehicle.js';

/**
 * Detection must be passive and specific: a car wedged on scenery with the
 * throttle open gets freed, but a car that is merely parked — or deliberately
 * held at a start line — is left alone.
 */

const DT = 1 / 60;

interface FakeState {
    speed: number;
    engineForce: number;
    wheelsDown: boolean;
    x: number; y: number; z: number;
    linvel: { x: number; y: number; z: number };
    translations: number;
}

function fakeVehicle(over: Partial<FakeState> = {}): { vehicle: Vehicle; state: FakeState } {
    const state: FakeState = {
        speed: 0, engineForce: 800, wheelsDown: true,
        x: 0, y: 0, z: 0,
        linvel: { x: 0, y: 0, z: 0 }, translations: 0,
        ...over,
    };
    const body = {
        isValid: () => true,
        rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
        translation: () => ({ x: state.x, y: state.y, z: state.z }),
        setTranslation: (t: { x: number; y: number; z: number }) => {
            state.x = t.x; state.y = t.y; state.z = t.z; state.translations++;
        },
        setRotation: () => {},
        setLinvel: (v: { x: number; y: number; z: number }) => { state.linvel = v; },
        setAngvel: () => {},
    };
    const vehicle = {
        getChassisBody: () => body,
        getChassisCollider: () => ({ halfExtents: () => ({ x: 0.9, y: 0.5, z: 1.7 }) }),
        getSpeed: () => state.speed,
        getEngineForce: () => state.engineForce,
        getMaxEngineForce: () => 1000,
        getWheelTerrainInfo: () => [{ inContact: state.wheelsDown }, { inContact: state.wheelsDown }],
        // Mirrors RapierVehicle.teleportTo against the fake state: place the
        // chassis and kill momentum (what the respawn assertions observe).
        teleportTo: (position: { x: number; y: number; z: number }) => {
            state.x = position.x; state.y = position.y; state.z = position.z;
            state.translations++;
            state.linvel = { x: 0, y: 0, z: 0 };
        },
    } as unknown as Vehicle;
    return { vehicle, state };
}

/** Run the system for `ms` of simulated time. */
function run(system: VehicleStuckSystem, ms: number): void {
    for (let t = 0; t < ms; t += DT * 1000) system.update(DT);
}

const opts = { ...DEFAULT_VEHICLE_STUCK_OPTIONS, debugLog: false };

describe('VehicleStuckSystem', () => {
    it('frees a car that is throttling but not moving', () => {
        const system = new VehicleStuckSystem(opts);
        const { vehicle, state } = fakeVehicle({ speed: 0.1, engineForce: 900 });
        system.register(vehicle);

        run(system, opts.stuckDurationMs * 0.5);
        expect(state.translations).toBe(0); // not yet — must persist

        run(system, opts.stuckDurationMs);
        expect(state.translations).toBeGreaterThan(0);
        // Backed out along -forward with real separation speed, and lifted.
        expect(state.linvel.z).toBeLessThan(0);
        expect(state.y).toBeGreaterThan(0);
    });

    it('leaves a parked car alone (no throttle, wheels down)', () => {
        const system = new VehicleStuckSystem(opts);
        const { vehicle, state } = fakeVehicle({ speed: 0, engineForce: 0 });
        system.register(vehicle);
        run(system, opts.stuckDurationMs * 4);
        expect(state.translations).toBe(0);
    });

    it('frees a beached car even with the throttle shut (no wheel on the ground)', () => {
        const system = new VehicleStuckSystem(opts);
        const { vehicle, state } = fakeVehicle({ speed: 0, engineForce: 0, wheelsDown: false });
        system.register(vehicle);
        run(system, opts.stuckDurationMs * 2);
        expect(state.translations).toBeGreaterThan(0);
    });

    it('does nothing while disabled — the start-line countdown case', () => {
        const system = new VehicleStuckSystem(opts);
        // Exactly the countdown signature: throttle pinned, car held still.
        const { vehicle, state } = fakeVehicle({ speed: 0, engineForce: 1000 });
        system.register(vehicle);
        system.setEnabled(false);
        run(system, opts.stuckDurationMs * 4);
        expect(state.translations).toBe(0);

        // Re-enabling starts the clock over, then recovers as normal.
        system.setEnabled(true);
        run(system, opts.stuckDurationMs * 2);
        expect(state.translations).toBeGreaterThan(0);
    });

    it('stops nudging and respawns once attempts are exhausted', () => {
        const system = new VehicleStuckSystem(opts);
        const { vehicle, state } = fakeVehicle({ speed: 0, engineForce: 900 });
        system.register(vehicle);
        system.setRespawnProvider(() => ({ position: { x: 50, y: 2, z: -10 }, heading: 1 }));

        // Stays stuck throughout, so every nudge "fails".
        run(system, opts.stuckDurationMs * (opts.maxNudgeAttempts + 2));

        expect(state.x).toBeCloseTo(50, 5);
        expect(state.z).toBeCloseTo(-10, 5);
        expect(state.linvel).toEqual({ x: 0, y: 0, z: 0 }); // respawn kills momentum
    });

    it('forgets accumulated stuck time as soon as the car moves again', () => {
        const system = new VehicleStuckSystem(opts);
        const { vehicle, state } = fakeVehicle({ speed: 0, engineForce: 900 });
        system.register(vehicle);

        run(system, opts.stuckDurationMs * 0.9);
        state.speed = 12; // broke free on its own
        run(system, DT * 2000);
        state.speed = 0;
        run(system, opts.stuckDurationMs * 0.9); // fresh count, still under the bar
        expect(state.translations).toBe(0);
    });
});
