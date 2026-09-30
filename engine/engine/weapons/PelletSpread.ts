import * as THREE from 'three';

/**
 * Scatter one aim point into a cone of them — a shotgun's pellets.
 *
 * Pure and seedable so the spread is unit-testable and, given a seeded random
 * source, replayable. The first pellet is always dead on the aim point: the
 * pattern is "a centre hit plus scatter", which is how a shotgun reads, rather
 * than a random cloud that can miss entirely at point-blank range.
 *
 * Angles are distributed uniformly over the cone's DISK (sqrt on the radius),
 * so pellets do not bunch at the centre the way a naive uniform angle would.
 */

/** Default half-angle of the pellet cone, radians (~4.6 degrees). */
export const DEFAULT_PELLET_SPREAD_RAD = 0.08;

const _dir = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);

/**
 * @param muzzle world-space muzzle position
 * @param aimPoint world-space point the centre pellet converges on
 * @param count number of pellets, including the centre one
 * @param spreadRad half-angle of the cone, radians
 * @param random unit-random source, 0..1
 * @returns `count` aim points; the first is `aimPoint` itself
 */
export function scatterAimPoints(
    muzzle: THREE.Vector3,
    aimPoint: THREE.Vector3,
    count: number,
    spreadRad: number,
    random: () => number,
): THREE.Vector3[] {
    const n = Math.max(1, Math.floor(count));
    const points: THREE.Vector3[] = [aimPoint.clone()];
    if (n === 1) return points;

    _dir.copy(aimPoint).sub(muzzle);
    const distance = _dir.length();
    // Aim point on top of the muzzle: nothing to scatter around, so every
    // pellet converges on the same point rather than producing NaN directions.
    if (!(distance > 1e-6) || !(spreadRad > 0)) {
        for (let i = 1; i < n; i++) points.push(aimPoint.clone());
        return points;
    }
    _dir.divideScalar(distance);

    // A basis perpendicular to the line of fire.
    const reference = Math.abs(_dir.y) > 0.9 ? _right : _up;
    _tangent.crossVectors(_dir, reference).normalize();
    _bitangent.crossVectors(_dir, _tangent).normalize();

    for (let i = 1; i < n; i++) {
        const angle = Math.sqrt(random()) * spreadRad;
        const azimuth = random() * Math.PI * 2;
        // Offset at the aim distance so the cone angle is what the player sees.
        const offset = Math.tan(angle) * distance;
        points.push(
            aimPoint.clone()
                .addScaledVector(_tangent, Math.cos(azimuth) * offset)
                .addScaledVector(_bitangent, Math.sin(azimuth) * offset),
        );
    }
    return points;
}
