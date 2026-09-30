import { installVehicleSafety, DEFAULT_VEHICLE_SAFETY_OPTIONS } from 'engine/VehicleSafetySystems.js';
import { RacingSetup, DEFAULT_RACING_SETUP_OPTIONS } from 'engine/RacingSetup.js';
import type { Vehicle } from 'engine/Vehicle.js';
import type { IVehicleDrivingComponent } from 'engine/VehicleDrivingComponent.js';
import type { PlayerController } from 'engine/PlayerController.js';

/**
 * A chauffeur or delivery game needs the wedge/auto-right recovery that used to
 * be reachable only through installRacingDefaults() — which also locks vehicle
 * exit and forces free-mouse. This is the genre-neutral door.
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

describe('installVehicleSafety', () => {
    it('needs no PlayerController and no GameEngine', () => {
        // The whole point: constructing it touches no input or UI state.
        const safety = installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS);
        expect(safety).toBeDefined();
        expect(() => safety.update(1 / 60)).not.toThrow();
    });

    it('accepts register/unregister and the stuck-detection gate', () => {
        const safety = installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS);
        expect(() => safety.setStuckDetectionEnabled(false)).not.toThrow();
        expect(() => safety.setRespawnProvider(null)).not.toThrow();
    });

    it('delivers the ramming yield on the genre-neutral path, same as racing', () => {
        // Nose-to-tail train in lockstep at 5 m/s: rammer behind, pointing at
        // the victim; the victim points away down the track. Same fixture as
        // RacingSetupYield.test.ts — the composition must survive the split.
        const rammer = fakeRacer({ z: 0 }, 1);
        const victim = fakeRacer({ z: 4.1 }, 2); // 0.1 m of chassis overlap

        const safety = installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS);
        safety.register(rammer.vehicle);
        safety.register(victim.vehicle);

        const seconds = DEFAULT_VEHICLE_SAFETY_OPTIONS.unstuck.contactDuration * 1.2;
        for (let t = 0; t < seconds; t += DT) safety.update(DT);

        expect(rammer.state.yields).toHaveLength(1);
        expect(rammer.state.yields[0]!).toBeGreaterThan(0);
        expect(victim.state.yields).toHaveLength(0);
    });
});

describe('RacingSetup', () => {
    it('still constructs from its own options object unchanged', () => {
        // Shipped racing games do exactly this; the signature must not move.
        const racing = new RacingSetup(DEFAULT_RACING_SETUP_OPTIONS);
        expect(() => racing.update(1 / 60)).not.toThrow();
    });

    it('feeds the respawn provider to the kill plane as well as the stuck system', () => {
        // The one call a racing game already makes has to cover falling off the
        // map too — otherwise the kill plane destroys the car it was told where
        // to put.
        const received: unknown[] = [];
        const playerController = {
            setVehicleExitLocked: () => {},
            setVehicleRespawnProvider: (p: unknown) => { received.push(p); },
        } as unknown as PlayerController;

        const racing = new RacingSetup(DEFAULT_RACING_SETUP_OPTIONS, playerController);
        const provider = () => ({ position: { x: 1, y: 2, z: 3 } });
        racing.setRespawnProvider(provider);

        expect(received).toEqual([provider]);
    });
});
