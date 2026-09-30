/**
 * Tip-over guard for raycast vehicles — pure math, unit-testable in isolation.
 *
 * Wheel drive force acts at the ground contact, BELOW the center of mass, so
 * total longitudinal force × COM height is a pitch moment about the loaded
 * axle. When it exceeds the gravity restoring moment (mass · g · COM-to-axle
 * distance) the opposite axle lifts and the vehicle flips — a light kart with
 * a strong engine wheelies over backward the instant W is pressed (and endos
 * forward on reverse). Games must play well out of the box regardless of the
 * mass / engineForce combination a game author picks, so the engine clamps the
 * TOTAL applied drive force to a safe fraction of the static tip threshold:
 *
 *     F_max = margin · mass · g · (b / h)
 *
 * where `b` is the horizontal COM→pivot-axle distance (rear axle when
 * accelerating forward, front axle in reverse) and `h` the COM height above
 * the wheel contacts. Verified empirically against the Rapier
 * DynamicRayCastVehicleController: the flip-prone 350 kg / 25 kN kart pitches
 * 88° and lands on its roof unclamped, and stays under 1° at margin 0.75
 * while still reaching 12 m/s in the first second.
 */

/** Fraction of the static tip threshold the drive force may use. Below 1
 *  because transients (suspension pitch rock, grip spikes) momentarily
 *  tighten the real limit; 0.75 held a full-speed W→S reversal upright in the
 *  harness sim with no measurable launch-feel cost on the stock sedan. */
export const TIP_FORCE_MARGIN = 0.75;

/** Static, per-vehicle tip geometry (chassis-local, from the wheel layout). */
export interface TipGeometry {
    /** Rearmost wheel connection z (gameplay forward = +Z, so this is the rear axle). */
    minWheelZ: number;
    /** Foremost wheel connection z. */
    maxWheelZ: number;
    /** Lowest possible contact y: connection y − suspension rest length − radius
     *  (suspension fully extended — the worst-case fallback when no wheel
     *  reports a live contact). */
    staticContactY: number;
}

/**
 * Maximum total longitudinal wheel force (N) that cannot tip the vehicle,
 * with `margin` headroom. Returns Infinity (no clamp) for degenerate
 * geometry — a COM at/below the contacts or a pivot axle at/behind the COM
 * means the model doesn't apply, and clamping on garbage would be worse.
 *
 * @param mass        Vehicle mass (kg).
 * @param gravity     Gravity magnitude (m/s², positive).
 * @param comHeight   COM height above the wheel contacts (m) — live when
 *                    contacts are available, else COM − staticContactY.
 * @param comZ        Chassis-local COM z.
 * @param geometry    Static wheel-layout geometry.
 * @param forward     True when driving forward (+Z): pivot = rear axle.
 * @param margin      Fraction of the static threshold to allow.
 */
export function maxTipSafeDriveForce(
    mass: number,
    gravity: number,
    comHeight: number,
    comZ: number,
    geometry: TipGeometry,
    forward: boolean,
    margin: number = TIP_FORCE_MARGIN,
): number {
    if (!(mass > 0) || !(gravity > 0) || !(comHeight > 0.05)) return Infinity;
    const pivotDistance = forward ? comZ - geometry.minWheelZ : geometry.maxWheelZ - comZ;
    if (!(pivotDistance > 0)) return Infinity;
    return margin * mass * gravity * (pivotDistance / comHeight);
}
