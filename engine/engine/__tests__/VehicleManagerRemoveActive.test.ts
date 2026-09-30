import { VehicleManager } from 'engine/VehicleManager.js';
import type { Vehicle } from 'engine/Vehicle.js';
import type { EngineLike, PlayerControllerLike } from 'types/game.js';

/**
 * Removing the vehicle the player is driving must run the FULL player-side exit
 * (walking movement + camera restored, capsule re-enabled), not just the
 * manager's own bookkeeping. Half-exiting strands the vehicle camera on the
 * chassis about to be disposed and makes the next enterVehicle() refuse with
 * "Already in a vehicle" — which is how a level switch left the player behind
 * on the old track while the karts spawned on the new one.
 */

interface Harness {
    manager: VehicleManager;
    vehicle: Vehicle;
    calls: string[];
    /** Mirrors PlayerVehicleController.isInVehicle — the state that used to go stale. */
    seated: () => boolean;
}

/** createVehicle() would build real Rapier bodies; seed the registry directly. */
function seedVehicle(manager: VehicleManager, vehicle: Vehicle): void {
    (manager as unknown as { vehicles: Vehicle[] }).vehicles.push(vehicle);
}

function harness(controllerOver: Partial<PlayerControllerLike> = {}): Harness {
    const calls: string[] = [];
    let seated = true;

    const vehicle = {
        exitVehicle: () => { calls.push('managerExit'); return { driver: true }; },
        dispose: () => { calls.push('dispose'); },
    } as unknown as Vehicle;

    const playerController = {
        isPlayerInVehicle: () => seated,
        // The real PlayerController.exitVehicle() ends up calling
        // exitCurrentVehicle() through PlayerVehicleController.
        exitVehicle: () => {
            calls.push('playerExit');
            seated = false;
            manager.exitCurrentVehicle();
            return true;
        },
        ...controllerOver,
    } as unknown as PlayerControllerLike;

    const engine = {
        physicsWorld: null,
        getPlayerController: () => playerController,
    } as unknown as EngineLike;

    const manager = new VehicleManager(engine);
    seedVehicle(manager, vehicle);
    manager.setActiveVehicle_INTERNAL(vehicle);

    return { manager, vehicle, calls, seated: () => seated };
}

describe('VehicleManager.removeVehicle — the player is in it', () => {
    test('runs the player-side exit before disposing, and clears both sides', () => {
        const { manager, vehicle, calls, seated } = harness();

        expect(manager.removeVehicle(vehicle)).toBe(true);

        expect(calls).toEqual(['playerExit', 'managerExit', 'dispose']);
        expect(seated()).toBe(false);
        expect(manager.getActiveVehicle()).toBeNull();
        expect(manager.getAllVehicles()).toHaveLength(0);
    });

    test('a controller without exitVehicle still leaves no active vehicle behind', () => {
        const { manager, vehicle, calls } = harness({ exitVehicle: undefined });

        expect(manager.removeVehicle(vehicle)).toBe(true);

        expect(calls).toEqual(['managerExit', 'dispose']);
        expect(manager.getActiveVehicle()).toBeNull();
    });

    test('removing an unmanned vehicle never touches the driving player', () => {
        const { manager, calls, seated } = harness();
        const parked = { exitVehicle: () => ({}), dispose: () => { calls.push('disposeParked'); } } as unknown as Vehicle;
        seedVehicle(manager, parked);

        expect(manager.removeVehicle(parked)).toBe(true);

        expect(calls).toEqual(['disposeParked']);
        expect(seated()).toBe(true);
        expect(manager.getActiveVehicle()).not.toBeNull();
    });
});
