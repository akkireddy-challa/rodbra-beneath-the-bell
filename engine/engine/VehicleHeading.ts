/**
 * Heading helpers for vehicle spawn rotation.
 *
 * `spawnRotation` in {@link VehicleSpawner} is a raw yaw in radians around +Y.
 * Vehicle local forward is +Z (see `RapierVehicle.getForwardDirection`), so:
 *
 *     yaw  0       → forward = +Z
 *     yaw  π/2     → forward = +X
 *     yaw  π       → forward = -Z
 *     yaw -π/2     → forward = -X
 *
 *              -Z (yaw = π)
 *               |
 *      -X ----- + ----- +X    (yaw = -π/2)        (yaw = π/2)
 *               |
 *              +Z (yaw = 0)
 *
 * Picking the wrong cardinal in your head is the most common spawn bug
 * (a 90° rotation puts every car sideways across the track). Prefer the
 * helpers below over hand-computed radians.
 */

/** Cardinal-direction yaw constants. Use these instead of writing `Math.PI` etc. */
export const FACE = {
    POS_X: Math.PI / 2,
    NEG_X: -Math.PI / 2,
    POS_Z: 0,
    NEG_Z: Math.PI,
} as const;

/**
 * Yaw needed for a vehicle at `from` to face `to`.
 *
 * Self-documenting alternative to `Math.atan2(...)` — the call site reads
 * "head toward the next waypoint" rather than committing to an axis convention.
 *
 * @example
 *     spawner.spawnAndEnter(
 *         spawnPos, config, body, pc,
 *         headingToward(spawnPos, firstWaypoint),
 *     );
 */
export function headingToward(
    from: { x: number; z: number },
    to: { x: number; z: number },
): number {
    return Math.atan2(to.x - from.x, to.z - from.z);
}

/**
 * Yaw tangent to a circle at point `p`, in the given travel direction.
 *
 * For circular and figure-8 tracks, every grid slot has a different heading —
 * the tangent at the south of the loop is not the same as the tangent at the
 * east. Use this instead of passing a single shared rotation to every spawn.
 *
 * @param center  Loop center in XZ.
 * @param p       Spawn point on (or near) the loop.
 * @param dir     'ccw' / 'cw' when viewed from above (looking down -Y).
 *
 * @example
 *     const heading = headingTangent({ x: 30, z: 0 }, spawnPos, 'ccw');
 *     spawner.spawnVehicle(spawnPos, config, undefined, heading);
 */
export function headingTangent(
    center: { x: number; z: number },
    p: { x: number; z: number },
    dir: 'cw' | 'ccw',
): number {
    // Radial yaw — the heading that points outward from center to p — in the
    // engine's `forward = +Z, yaw = atan2(x, z)` convention.
    const radial = Math.atan2(p.x - center.x, p.z - center.z);
    // CCW viewed from above (camera looking down -Y, +X right, +Z toward camera)
    // means tangent at +X is -Z, at +Z is +X, etc. — i.e. radial + π/2.
    return dir === 'ccw' ? radial + Math.PI / 2 : radial - Math.PI / 2;
}
