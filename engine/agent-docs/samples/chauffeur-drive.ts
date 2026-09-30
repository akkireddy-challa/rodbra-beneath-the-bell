/**
 * An NPC driving a physics car along a route to a destination, then parking.
 *
 * Referenced from agent docs (read-docs name: `samples/chauffeur-drive`).
 * Compiled against the live engine by game's `pnpm run check`
 * (tsconfig.docs-samples.json) — an engine API change breaks this file loudly.
 *
 * The two things that make this work, and that hand-rolled drivers get wrong:
 * SMOOTH_DRIVING_OPTIONS turns on analog throttle, so the car HOLDS a town
 * speed and eases to a stop instead of surging between full power and coast;
 * and its recovery only arms when the car is genuinely wedged, so a deliberate
 * crawl is not mistaken for being stuck and answered with a reverse burst.
 */
import { BasicDrivingComponent, SMOOTH_DRIVING_OPTIONS } from 'engine/VehicleDrivingComponent.js';
import {
    installVehicleSafety,
    DEFAULT_VEHICLE_SAFETY_OPTIONS,
    type VehicleSafetySystems,
} from 'engine/VehicleSafetySystems.js';
import type { Vehicle } from 'engine/Vehicle.js';

export interface RoutePoint { x: number; z: number }

/** An intermediate waypoint counts as passed inside this many metres. */
const WAYPOINT_RADIUS = 8;

/**
 * `VehicleSafetySystems` is SHARED across the whole game, not owned per NPC.
 * `VehicleUnstuckSystem` only splits a welded pair when BOTH vehicles are
 * registered in the SAME bundle — if every `ChauffeurDrive` built its own via
 * `installVehicleSafety()` in its constructor, two chauffeurs that collide
 * with EACH OTHER would never have both cars in one bundle, so that pair is
 * never unwelded. Auto-right and wedged-on-scenery recovery still work per
 * vehicle either way; only cross-vehicle unwelding silently degrades. Create
 * one bundle for the whole game (see `createChauffeurFleet` below) and pass
 * it to every `ChauffeurDrive`.
 */
export class ChauffeurDrive {
    private readonly driving = new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS);
    private waypointIndex = 0;
    private arrived = false;

    constructor(
        private readonly vehicle: Vehicle,
        private readonly safety: VehicleSafetySystems,
        private readonly waypoints: ReadonlyArray<RoutePoint>,
        private readonly destination: RoutePoint,
    ) {
        vehicle.setDrivingComponent(this.driving);
        vehicle.setAlwaysActive(true);
        this.safety.register(vehicle);
    }

    /** True once the car has parked at the destination. */
    hasArrived(): boolean {
        return this.arrived;
    }

    /**
     * Call every frame from the game's update loop. Does NOT tick the shared
     * `safety` bundle — call `safety.update(deltaTime)` once per frame from
     * the game (see `createChauffeurFleet`'s usage note), not once per
     * chauffeur, or a fleet of N NPCs ticks every safety system N times a
     * frame.
     */
    update(deltaTime: number): void {
        const pos = this.vehicle.getPosition();

        // Walk the waypoint list, then aim at the final destination.
        while (this.waypointIndex < this.waypoints.length) {
            const wp = this.waypoints[this.waypointIndex]!;
            if (Math.hypot(wp.x - pos.x, wp.z - pos.z) < WAYPOINT_RADIUS) {
                this.waypointIndex++;
            } else {
                break;
            }
        }
        const target = this.waypoints[this.waypointIndex] ?? this.destination;
        // isFinal gates BasicDrivingComponent's arrival easing: an
        // intermediate waypoint (always inside WAYPOINT_RADIUS of the "next"
        // target by construction) must NOT ease down, or the car never
        // leaves the crawl band for the whole route — only the last leg,
        // heading at the real destination, ramps down to a smooth stop.
        const isFinal = target === this.destination;
        this.driving.setTarget(target.x, target.z, isFinal);

        // The engine eases to a crawl and brakes inside arriveRadius on its
        // own — game code only has to notice that it happened.
        if (!this.arrived
            && target === this.destination
            && this.driving.isNear(this.destination.x, this.destination.z, SMOOTH_DRIVING_OPTIONS.arriveRadius)) {
            this.arrived = true;
            this.vehicle.setParkingBrake(true);
        }

        this.vehicle.updateAI(deltaTime);
    }
}

export interface ChauffeurSpec {
    vehicle: Vehicle;
    waypoints: ReadonlyArray<RoutePoint>;
    destination: RoutePoint;
}

/**
 * Wire up a fleet of chauffeurs sharing ONE `VehicleSafetySystems` bundle —
 * the pattern any game with more than one NPC driver needs (see the class
 * doc above for why a bundle per instance silently breaks cross-vehicle
 * unwelding). Usage:
 *
 *   const fleet = createChauffeurFleet([
 *       { vehicle: taxi, waypoints: taxiRoute, destination: taxiStand },
 *       { vehicle: van, waypoints: vanRoute, destination: depot },
 *   ]);
 *
 *   // every frame:
 *   for (const c of fleet.chauffeurs) c.update(deltaTime);
 *   fleet.safety.update(deltaTime);   // ONCE per frame, shared by the fleet
 */
export function createChauffeurFleet(
    specs: ReadonlyArray<ChauffeurSpec>,
): { safety: VehicleSafetySystems; chauffeurs: ChauffeurDrive[] } {
    const safety = installVehicleSafety(DEFAULT_VEHICLE_SAFETY_OPTIONS);
    const chauffeurs = specs.map(
        (spec) => new ChauffeurDrive(spec.vehicle, safety, spec.waypoints, spec.destination),
    );
    return { safety, chauffeurs };
}
