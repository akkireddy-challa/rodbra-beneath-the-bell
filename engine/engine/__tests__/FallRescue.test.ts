import { planFallRescue, DEFAULT_FALL_RESCUE_OPTIONS, DEFAULT_KILL_PLANE_Y } from 'engine/FallRescue.js';
import type { Vehicle } from 'engine/Vehicle.js';

/**
 * The kill plane used to eject the driver and destroy their car unconditionally,
 * leaving any game that held the vehicle polling a dead object — and overriding
 * `lockVehicleExit` while it was at it. These cover the four branches of the
 * decision; the teleport/respawn execution lives in PlayerController.
 */

const VEHICLE = { id: 'player-car' } as unknown as Vehicle;
const START = { x: 1, y: 2, z: 3 };

function plan(over: Partial<Parameters<typeof planFallRescue>[0]>) {
    return planFallRescue({
        vehicle: null,
        respawn: null,
        vehicleExitLocked: false,
        startPosition: START,
        options: DEFAULT_FALL_RESCUE_OPTIONS,
        ...over,
    });
}

describe('planFallRescue', () => {
    it('sends a player who fell on foot back to spawn', () => {
        expect(plan({})).toEqual({
            action: 'player-respawned',
            vehicle: null,
            position: START,
            heading: null,
        });
    });

    it('respawns the car at the provider point, player still in it', () => {
        const event = plan({
            vehicle: VEHICLE,
            respawn: { position: { x: 10, y: 20, z: 30 }, heading: 1.5 },
        });

        expect(event).toEqual({
            action: 'vehicle-respawned',
            vehicle: VEHICLE,
            position: { x: 10, y: 20, z: 30 },
            heading: 1.5,
        });
    });

    it('keeps the current heading when the provider gives none', () => {
        const event = plan({ vehicle: VEHICLE, respawn: { position: { x: 0, y: 0, z: 0 } } });

        expect(event.heading).toBeNull();
    });

    it('keeps the player in a locked car with no provider, lifted clear of the spawn ground', () => {
        const event = plan({ vehicle: VEHICLE, vehicleExitLocked: true });

        expect(event.action).toBe('vehicle-respawned');
        expect(event.position).toEqual({
            x: START.x,
            y: START.y + DEFAULT_FALL_RESCUE_OPTIONS.vehicleRespawnLift,
            z: START.z,
        });
    });

    it('prefers the provider point over the locked-in fallback', () => {
        const event = plan({
            vehicle: VEHICLE,
            vehicleExitLocked: true,
            respawn: { position: { x: 7, y: 8, z: 9 } },
        });

        expect(event.position).toEqual({ x: 7, y: 8, z: 9 });
    });

    it('destroys the car only when the game said nothing about it', () => {
        const event = plan({ vehicle: VEHICLE, vehicleExitLocked: false, respawn: null });

        expect(event).toEqual({
            action: 'vehicle-destroyed',
            vehicle: VEHICLE,
            position: START,
            heading: null,
        });
    });

    it('copies positions so callers cannot mutate the spawn point through the event', () => {
        const event = plan({});
        event.position.y = 999;

        expect(START.y).toBe(2);
    });

    it('defaults the kill plane to the historical -100', () => {
        expect(DEFAULT_FALL_RESCUE_OPTIONS.killPlaneY).toBe(DEFAULT_KILL_PLANE_Y);
        expect(DEFAULT_KILL_PLANE_Y).toBe(-100);
    });
});
