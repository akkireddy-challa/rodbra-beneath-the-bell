import {
    VehicleRouteRecoverySystem,
    DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS,
    type VehicleRouteState,
} from 'engine/VehicleRouteRecovery.js';
import { installVehicleSafety, DEFAULT_VEHICLE_SAFETY_OPTIONS } from 'engine/VehicleSafetySystems.js';
import type { Vehicle } from 'engine/Vehicle.js';
import type { IVehicleDrivingComponent } from 'engine/VehicleDrivingComponent.js';

/**
 * Local recovery puts a shunted AI back on its wheels where it landed; nothing
 * puts it back on the ROUTE, so it drives off chasing a waypoint it can no
 * longer reach. These pin the engine fallback: forward-only rejoin, corridor
 * grace, driver resynchronisation, and no effect at all without a provider.
 */

const DT = 1 / 60;

/** 40 waypoints 10 m apart along +Z, at y = 2. Heading between any two is 0 (+Z forward). */
const LANE = Array.from({ length: 40 }, (_, i) => ({ x: 0, y: 2, z: i * 10 }));

interface FakeState {
    x: number; y: number; z: number;
    speed: number;
    teleports: Array<{ position: { x: number; y: number; z: number }; heading: number | undefined }>;
    targets: Array<{ x: number; z: number; isFinal: boolean | undefined }>;
}

function fakeAi(
    over: Partial<Pick<FakeState, 'x' | 'y' | 'z' | 'speed'>> = {},
    withDriver = true,
): { vehicle: Vehicle; state: FakeState } {
    const state: FakeState = {
        x: 0, y: 2, z: 0, speed: 20, teleports: [], targets: [], ...over,
    };
    const driver: IVehicleDrivingComponent | null = withDriver ? {
        update: () => {},
        setTarget: (x: number, z: number, isFinal?: boolean) => { state.targets.push({ x, z, isFinal }); },
        stop: () => {},
        isNear: () => false,
    } : null;
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const body = {
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
        getCollisionHalfExtents: () => ({ x: 0.9, y: 0.5, z: 2.1 }),
        getPosition: () => ({ x: state.x, y: state.y, z: state.z }),
        getForwardDirection: () => ({ x: 0, y: 0, z: 1 }),
        getLinearVelocity: () => ({ x: 0, y: 0, z: state.speed }),
        getSpeed: () => state.speed,
        getEngineForce: () => 800,
        getMaxEngineForce: () => 1000,
        getMass: () => 1000,
        applyImpulse: () => {},
        getWheelTerrainInfo: () => [{ inContact: true }, { inContact: true }],
        getDrivingComponent: () => driver,
        teleportTo: (position: { x: number; y: number; z: number }, heading?: number) => {
            state.teleports.push({ position, heading });
            state.x = position.x; state.y = position.y; state.z = position.z;
        },
    } as unknown as Vehicle;
    return { vehicle, state };
}

function laneRoute(targetIndex: number, corridorHalfWidth = 6): VehicleRouteState {
    return { points: LANE, targetIndex, loop: true, corridorHalfWidth };
}

describe('VehicleRouteRecoverySystem', () => {
    it('rejoins the nearest FORWARD waypoint, facing the next one', () => {
        // Shunted 25 m off the lane, level with waypoint 8, progress at 3.
        const car = fakeAi({ x: 25, z: 82 });
        const rejoined: number[] = [];
        const route = new VehicleRouteRecoverySystem(DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        route.register(car.vehicle, {
            route: () => laneRoute(3),
            onRejoined: (_v, index) => { rejoined.push(index); },
        });

        expect(route.recover(car.vehicle)).toBe(true);

        expect(car.state.teleports).toHaveLength(1);
        // Waypoint 8 (z = 80), lifted by dropHeight so it isn't dropped inside the road.
        expect(car.state.teleports[0]!.position).toEqual({ x: 0, y: 3, z: 80 });
        // Facing waypoint 9 — straight down the lane (+Z is yaw 0).
        expect(car.state.teleports[0]!.heading).toBeCloseTo(0, 6);
        // Driver re-aimed at the NEXT waypoint, as an intermediate one.
        expect(car.state.targets).toEqual([{ x: 0, z: 90, isFinal: false }]);
        expect(rejoined).toEqual([8]);
    });

    it('never rejoins BEHIND the car\'s own recorded progress', () => {
        // Physically nearest waypoint is 1 (z = 10), but progress says 10 —
        // going back there would replay the lap and unwind the lap counter.
        const car = fakeAi({ x: 25, z: 12 });
        const route = new VehicleRouteRecoverySystem(DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        route.register(car.vehicle, { route: () => laneRoute(10) });

        expect(route.recover(car.vehicle)).toBe(true);
        expect(car.state.teleports[0]!.position.z).toBe(100);
    });

    it('waits out the grace period before rescuing an off-route car', () => {
        const car = fakeAi({ x: 25, z: 82 });
        const route = new VehicleRouteRecoverySystem(DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        route.register(car.vehicle, { route: () => laneRoute(3) });

        const grace = DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS.offRouteGraceSeconds;
        for (let t = 0; t < grace - 0.2; t += DT) route.update(DT);
        expect(car.state.teleports).toHaveLength(0);

        for (let t = 0; t < 0.5; t += DT) route.update(DT);
        expect(car.state.teleports).toHaveLength(1);
        expect(car.state.teleports[0]!.position).toEqual({ x: 0, y: 3, z: 80 });
    });

    it('leaves a car inside the corridor alone, however wide its line', () => {
        const car = fakeAi({ x: 5, z: 82 }); // 5 m off centre, corridor is 6
        const route = new VehicleRouteRecoverySystem(DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        route.register(car.vehicle, { route: () => laneRoute(3) });

        for (let t = 0; t < 10; t += DT) route.update(DT);
        expect(car.state.teleports).toHaveLength(0);
    });

    it('never touches a car with no driving component — the player', () => {
        const car = fakeAi({ x: 25, z: 82 }, false);
        const route = new VehicleRouteRecoverySystem(DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        route.register(car.vehicle, { route: () => laneRoute(3) });

        for (let t = 0; t < 10; t += DT) route.update(DT);
        expect(car.state.teleports).toHaveLength(0);
    });

    it('stands down while the countdown holds the grid off the centerline', () => {
        const car = fakeAi({ x: 25, z: 82 });
        const route = new VehicleRouteRecoverySystem(DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        route.register(car.vehicle, { route: () => laneRoute(3) });
        route.setEnabled(false);

        for (let t = 0; t < 10; t += DT) route.update(DT);
        expect(car.state.teleports).toHaveLength(0);

        route.setEnabled(true);
        for (let t = 0; t < 10; t += DT) route.update(DT);
        expect(car.state.teleports).toHaveLength(1);
    });

    it('does nothing for a vehicle whose provider has no usable route', () => {
        const car = fakeAi({ x: 25, z: 82 });
        const route = new VehicleRouteRecoverySystem(DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        route.register(car.vehicle, { route: () => null });

        expect(route.recover(car.vehicle)).toBe(false);
        for (let t = 0; t < 10; t += DT) route.update(DT);
        expect(car.state.teleports).toHaveLength(0);
    });

    it('forgets a vehicle on unregister', () => {
        const car = fakeAi({ x: 25, z: 82 });
        const route = new VehicleRouteRecoverySystem(DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        route.register(car.vehicle, { route: () => laneRoute(3) });
        expect(route.has(car.vehicle)).toBe(true);

        route.unregister(car.vehicle);
        expect(route.has(car.vehicle)).toBe(false);
        expect(route.recover(car.vehicle)).toBe(false);
    });
});

describe('VehicleSafetySystems route fallback', () => {
    /** Long enough for maxNudgeAttempts nudges plus the respawn cycle after them. */
    const NUDGES_EXHAUSTED_SECONDS =
        (DEFAULT_VEHICLE_SAFETY_OPTIONS.stuck.maxNudgeAttempts + 1)
        * DEFAULT_VEHICLE_SAFETY_OPTIONS.stuck.stuckDurationMs / 1000 + 0.2;

    it('rejoins the route once the bounded nudges are exhausted', () => {
        // Wedged ON the lane, so the corridor watch stays quiet and the only
        // path to a rejoin is the stuck system running out of nudges.
        const car = fakeAi({ x: 0, z: 82, speed: 0 });
        const safety = installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS);
        safety.register(car.vehicle, { route: () => laneRoute(3) });

        for (let t = 0; t < NUDGES_EXHAUSTED_SECONDS; t += DT) safety.update(DT);

        expect(car.state.teleports).toHaveLength(1);
        expect(car.state.teleports[0]!.position).toEqual({ x: 0, y: 3, z: 80 });
        expect(car.state.targets).toEqual([{ x: 0, z: 90, isFinal: false }]);
    });

    it('falls back to the game respawn provider for a car with no route', () => {
        const car = fakeAi({ x: 0, z: 82, speed: 0 });
        const safety = installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS);
        safety.register(car.vehicle);
        safety.setRespawnProvider(() => ({ position: { x: 7, y: 8, z: 9 }, heading: 1.5 }));

        for (let t = 0; t < NUDGES_EXHAUSTED_SECONDS; t += DT) safety.update(DT);

        expect(car.state.teleports).toHaveLength(1);
        expect(car.state.teleports[0]!.position).toEqual({ x: 7, y: 8, z: 9 });
        expect(car.state.teleports[0]!.heading).toBe(1.5);
    });

    it('prefers the route over the game respawn provider for a route-driven AI', () => {
        const car = fakeAi({ x: 0, z: 82, speed: 0 });
        const safety = installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS);
        safety.register(car.vehicle, { route: () => laneRoute(3) });
        safety.setRespawnProvider(() => ({ position: { x: 7, y: 8, z: 9 } }));

        for (let t = 0; t < NUDGES_EXHAUSTED_SECONDS; t += DT) safety.update(DT);

        expect(car.state.teleports[0]!.position).toEqual({ x: 0, y: 3, z: 80 });
    });
});
