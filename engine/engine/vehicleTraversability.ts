// Vehicle traversability decisions. Pure (no runtime imports), unit-testable in isolation.
// The casting that produces these inputs lives in PhysicsWorld.probeVehiclePath();
// everything that DECIDES lives here, because PhysicsWorld needs Rapier WASM and no
// engine test loads it.

/** Chassis box dimensions in metres. */
export interface VehicleFootprint {
    width: number;
    height: number;
    length: number;
}

/** Why a segment is not drivable. `clear` means it is. */
export type PassFailure = 'clear' | 'step' | 'obstacle' | 'gap';

export interface VehiclePassResult {
    passable: boolean;
    /**
     * How far along the segment (m) the car can actually GET, so a caller may
     * trim a leg to this distance; the full span when clear. Never the position
     * of the thing in the way: a `step` reports the last GOOD sample before the
     * rise (trimming to it leaves the waypoint in front of the kerb, not on top
     * of it), an `obstacle` reports the car-centre travel at contact. A `gap`
     * reports the first sample with no ground under it — the ground ends
     * somewhere in the metre before it, so treat that last metre as unsurveyed.
     */
    blockedAt: number;
    reason: PassFailure;
    /** Steepest grade encountered as an absolute rise/run, across the WHOLE profile. */
    peakGrade: number;
}

/** One ground sample along the segment. `height: null` = the down-ray hit nothing. */
export interface PathSample {
    distance: number;
    height: number | null;
}

/** Derating for rolling resistance and tyre scrub. */
const CLIMB_DERATE = 0.8;
/** Floor, so an asset with unusable fitment stays routable on flat ground. */
const MIN_CLIMB_GRADE = 0.05;
/**
 * Ceiling: above this the limit is tyre friction, not engine force.
 *
 * Was 0.45, which a 4WD asset car reached — and 0.45 is ABOVE the 0.34 m-per-
 * metre a typical kerb reads as, so the grade rule alone waved kerbs through and
 * cars ended up on the pavement. Kerbs are now the step rule's job
 * (`derivedStepHeight`); this is only about slopes, so it can sit where real
 * roads do. 0.30 is steeper than any street and below the point where a
 * raycast-vehicle model stops resembling a car.
 */
const MAX_CLIMB_GRADE = 0.30;
/** Standard gravity (m/s²). */
const GRAVITY = 9.81;

/**
 * A rise over a run this short (m) is a STEP — a discontinuity the wheel has to
 * mount — not a slope it can drive up.
 *
 * This only discriminates if the profile is sampled finer than the limit near a
 * suspected step; `probeVehiclePath` refines around one before asking. Sampled
 * at 1 m, a kerb and a steep ramp are the same number.
 */
const STEP_RUN_LIMIT = 0.5;
/** Fraction of wheel radius a driven wheel can realistically mount. */
const STEP_FRACTION_OF_WHEEL_RADIUS = 0.35;
/** Floor, so surface noise does not block a small-wheeled asset. */
const MIN_STEP_HEIGHT = 0.05;

/**
 * Tallest abrupt step (m) this vehicle can mount, from wheel radius.
 *
 * Deliberately NOT derived from engine force. Force-to-weight tells you about
 * slopes; a kerb is a discontinuity, and a 0.4 m wheel cannot climb a 0.34 m
 * vertical face however much power is behind it — the limits are wheel radius
 * and suspension travel. Conflating the two is what let a route search send a
 * car over a kerb it then wedged against.
 */
export function derivedStepHeight(wheelRadius: number): number {
    if (!Number.isFinite(wheelRadius) || wheelRadius <= 0) return MIN_STEP_HEIGHT;
    return Math.max(MIN_STEP_HEIGHT, wheelRadius * STEP_FRACTION_OF_WHEEL_RADIUS);
}

/**
 * Widest gap (m) a wheel of the size implied by `maxStepHeight` rolls across
 * without dropping further than the step it could have climbed.
 *
 * A wheel of radius `r` crossing a gap of width `w` dips by
 * `r - sqrt(r^2 - (w/2)^2)`. Setting that equal to `maxStepHeight` and using
 * this module's own `derivedStepHeight` relation (`h = r * STEP_FRACTION`,
 * i.e. `r = h / STEP_FRACTION`) makes the whole thing collapse to a constant
 * multiple of `h` — the radius cancels:
 *
 *     w = 2 * sqrt(2*r*h - h^2) = 2 * h * sqrt(2 / STEP_FRACTION - 1)
 *
 * ~4.34 * h, so 0.46 m for a default-ish 0.105 m step and 0.61 m for 0.14 m.
 * That is the point of the derivation: a bigger wheel gets a bigger step
 * allowance AND bridges a wider gap, and one number expresses both.
 *
 * Exists because a probe that samples ground at intervals cannot otherwise
 * tell a hairline seam between two collider meshes from a hole in the road.
 * Measured on the Maple Hollow level: three seams of 0.02 m, 0.11 m and
 * 0.22 m, each of which refused an entire route leg as a `gap`.
 */
export function bridgeableGapWidth(maxStepHeight: number): number {
    if (!Number.isFinite(maxStepHeight) || maxStepHeight <= 0) return 0;
    return 2 * maxStepHeight * Math.sqrt(2 / STEP_FRACTION_OF_WHEEL_RADIUS - 1);
}

/**
 * Steepest grade a vehicle can climb, from `tanθ ≈ engineForce / (mass · g)`.
 *
 * Calibration: the 980 kg / 1470 N car in game 8I2U5V99O8EO derives 0.122.
 * Asking the unrelated question "what threshold separates a steep street from a
 * kerb?" produced 0.125 independently, which is the evidence this is scaled right.
 */
export function derivedClimbGrade(engineForce: number, mass: number): number {
    if (!Number.isFinite(engineForce) || !Number.isFinite(mass) || mass <= 0 || engineForce <= 0) {
        return MIN_CLIMB_GRADE;
    }
    const ratio = (engineForce / (mass * GRAVITY)) * CLIMB_DERATE;
    return Math.min(MAX_CLIMB_GRADE, Math.max(MIN_CLIMB_GRADE, ratio));
}

/**
 * Decide whether a vehicle can drive a sampled segment.
 *
 * `sweepHitAt` is the distance at which a swept chassis box first hit something,
 * or null for a clean sweep. When both the profile and the sweep fail, the
 * EARLIEST failure wins — that is where the car actually stops.
 */
export function evaluateVehiclePath(
    samples: PathSample[],
    maxClimbGrade: number,
    maxStepHeight: number,
    sweepHitAt: number | null,
): VehiclePassResult {
    if (samples.length === 0) {
        // Fail closed, like every other "cannot answer" path in this feature: an
        // unsampled segment says nothing about the ground, and a planner that
        // reads that as clear road drives cars through walls.
        return { passable: false, blockedAt: 0, reason: 'gap', peakGrade: 0 };
    }
    const span = samples[samples.length - 1]!.distance;

    let peakGrade = 0;
    let failureAt: number | null = null;
    let failureReason: PassFailure = 'clear';
    // The last sample with KNOWN ground — typed non-null so the grade
    // arithmetic below needs no second null check. A hole resets it.
    let previous: { distance: number; height: number } | null = null;

    // Keep scanning past the first failure: peakGrade describes the whole
    // profile, so a caller can tell "barely too steep" from "a wall".
    for (const { distance, height } of samples) {
        if (height === null) {
            if (failureAt === null) {
                failureAt = distance;
                failureReason = 'gap';
            }
            // A hole breaks the profile — do not grade across it.
            previous = null;
            continue;
        }
        const prev = previous;
        previous = { distance, height };
        if (prev === null) continue;
        const run = Math.abs(distance - prev.distance);
        if (run <= 1e-6) continue;

        // DELIBERATELY SYMMETRIC (Math.abs): a drop as steep as the limit
        // blocks too, so a kerb is a two-way wall. An asymmetric rule that let
        // cars descend what they cannot climb creates one-way paths — the car
        // drops off a ledge and strands itself somewhere the route search
        // believed was fine. Do not "fix".
        const rise = Math.abs(height - prev.height);
        const grade = rise / run;
        if (grade > peakGrade) peakGrade = grade;
        // Two independent limits. The grade rule is about SLOPES and scales
        // with the run. The step rule is about DISCONTINUITIES and does not: a
        // kerb taller than the wheel can mount blocks the car no matter how
        // gently the surrounding metre averages out, which is exactly what a
        // grade-only rule misses.
        const tooSteep = grade > maxClimbGrade;
        const tooTall = run <= STEP_RUN_LIMIT && rise > maxStepHeight;
        if ((tooSteep || tooTall) && failureAt === null) {
            // The NEAR sample: `blockedAt` is how far the car gets, and the far
            // sample is already up on the kerb (see the VehiclePassResult doc).
            failureAt = prev.distance;
            failureReason = 'step';
        }
    }

    if (sweepHitAt !== null && (failureAt === null || sweepHitAt < failureAt)) {
        return { passable: false, blockedAt: sweepHitAt, reason: 'obstacle', peakGrade };
    }
    if (failureAt !== null) {
        return { passable: false, blockedAt: failureAt, reason: failureReason, peakGrade };
    }
    return { passable: true, blockedAt: span, reason: 'clear', peakGrade };
}
