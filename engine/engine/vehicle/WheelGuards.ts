/**
 * Wheel guard boxes — the sideways collision a ray-cast wheel doesn't have.
 *
 * Rapier's `DynamicRayCastVehicleController` models each wheel as a single
 * DOWNWARD ray. That ray is the whole wheel: it finds the ground, loads the
 * suspension spring and applies tyre forces. The wheel has no collider, so it
 * has no sideways presence at all — the only shapes the solver knows about are
 * the chassis slab and the body boxes, and both are sized to the WHEEL-EXCLUDED
 * body bounds. Every tyre that sits proud of the bodywork (any flared fender,
 * every `exposed` axle, and — because the body boxes are shrunk to 92–96 % of
 * the body — even a flush one) is therefore pure decoration: it passes through
 * walls, and two cars overlap wheel-deep before their bodies touch.
 *
 * A guard is a thin box parked in the tyre's own volume on the chassis body, so
 * the tyre pushes on walls, props and other cars like the solid object it looks
 * like. Two constraints shape it:
 *
 *  - It must NEVER reach the ground. It's rigid in chassis space while the
 *    wheel travels on its spring, so a guard that dipped to the contact patch
 *    would carry the car's weight on a box instead of the suspension. The
 *    bottom is therefore placed relative to the highest the ground can ever be
 *    in chassis space — the wheel ray's contact at FULL COMPRESSION — which is
 *    a per-wheel bound and so survives roll, pitch, kerbs and landings.
 *  - Covering the tyre's top half is enough. Walls and other cars are tall, so
 *    they meet the guard; low kerbs and small rocks pass under it, and the
 *    ray-cast wheel keeps climbing them the way it always did.
 *
 * Pure geometry (no THREE, no engine state) so it unit-tests headlessly.
 */

/**
 * Suspension travel allowed either side of the rest length, as a fraction of
 * that rest length (Rapier's `setWheelMaxSuspensionTravel`). The guard geometry
 * reads this to know how far the chassis can drop onto the wheel, so the two
 * must stay in step — RapierVehicle configures the wheels from this same const.
 */
export const SUSPENSION_MAX_TRAVEL_FRACTION = 0.8;

/**
 * Gap kept between the guard's underside and the wheel's contact patch at full
 * suspension compression, as a fraction of wheel radius. This is the guard's
 * whole safety margin against becoming a load-bearing skid, so it stays
 * generous: at 0.55 the guard covers a little under the tyre's top half.
 */
export const WHEEL_GUARD_GROUND_CLEARANCE_FRACTION = 0.55;

/**
 * Guard length along the chassis Z axis, as a fraction of tyre diameter. Held
 * under 1 so the guard's leading and trailing edges sit inside the tyre's
 * silhouette and can't catch on a step the round tyre would have ridden over.
 */
export const WHEEL_GUARD_LENGTH_FRACTION = 0.85;

/** The wheel geometry a guard is derived from (chassis-local, meters). */
export interface WheelGuardInput {
    /** Suspension mount point — the wheel hangs BELOW this, never above it. */
    position: { x: number; y: number; z: number };
    radius: number;
    /** Tyre width, along the axle (chassis X). */
    width: number;
    suspensionRestLength: number;
}

/** A guard cuboid, chassis-local, in the same shape as a vehicle body part. */
export interface WheelGuardBox {
    position: { x: number; y: number; z: number };
    size: { width: number; height: number; length: number };
}

/**
 * The guard box for one wheel, or null when the wheel is too degenerate to
 * bound (zero radius/width — a malformed fitment, not something to crash on).
 */
export function wheelGuardBox(wheel: WheelGuardInput): WheelGuardBox | null {
    const { radius, width } = wheel;
    if (!(radius > 0) || !(width > 0)) return null;

    const rest = Math.max(wheel.suspensionRestLength, 0);
    // Shortest the spring can get, i.e. the chassis at its lowest over the wheel.
    const shortestSuspension = rest * (1 - SUSPENSION_MAX_TRAVEL_FRACTION);
    const wheelCenterY = wheel.position.y - shortestSuspension;

    // Highest the ground can sit in chassis space; the guard clears it by
    // WHEEL_GUARD_GROUND_CLEARANCE_FRACTION of a radius.
    const bottom = wheelCenterY - radius * (1 - WHEEL_GUARD_GROUND_CLEARANCE_FRACTION);
    const top = wheelCenterY + radius;

    return {
        position: { x: wheel.position.x, y: (top + bottom) / 2, z: wheel.position.z },
        size: {
            width,
            height: top - bottom,
            length: radius * 2 * WHEEL_GUARD_LENGTH_FRACTION,
        },
    };
}
