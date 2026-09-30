// Per-vehicle handling configuration with size-scaled defaults. Pure (no runtime imports), unit-testable in isolation.
// Unit conventions: VehicleHandlingConfig (agent-facing, getHandling()) uses DEGREES and m/s.
//                   ResolvedVehicleHandling (engine-internal) uses RADIANS.
// Omitted fields fall back to size-scaled defaults (sizeFactor = chassis footprint ÷ reference); provided fields are used verbatim.

const DEG2RAD = Math.PI / 180;

/**
 * Optional per-vehicle handling overrides. Set at spawn via `config.handling`, or at runtime via `vehicle.setHandling(...)`.
 * Any field left undefined uses a size-scaled default.
 */
export interface VehicleHandlingConfig {
    /** Hard top-speed cap (m/s). Default: size-scaled (~28 · sizeFactor^0.6). */
    topSpeed?: number;
    /** Hard cap on REVERSE speed (m/s, positive). Default: 45% of `topSpeed`. */
    reverseTopSpeed?: number;
    /** Drive-force multiplier (1 = full). Default: size taper (sizeFactor^0.5, capped ≤1). */
    accelerationScale?: number;
    /** Steering angle at full lock (degrees). Default: ~34°. */
    maxSteerAngle?: number;
    /** How fast the wheel ramps toward lock (degrees/sec). Default: ~229°/s. */
    steerSpeed?: number;
    /** How much steering softens with speed (0 = never; higher = sooner). Default: 0.15. */
    steerSpeedFalloff?: number;
    /** Floor on steering at speed, as a fraction (0–1) of max lock. Default: 0.25. */
    minSteerAtSpeed?: number;
    /**
     * Aerodynamic downforce, in multiples of the car's own weight at 30 m/s, and
     * growing with the SQUARE of speed. This is what keeps a fast car on the road
     * and stops it sailing off crests; slow driving is barely affected.
     * Default: 1. Winged racer 2–3, sports car ~1.5, road car ~0.8,
     * kart or truck ~0.3, 0 for pure ballistic stunt-jump physics.
     */
    downforce?: number;
}

/** Engine-internal resolved handling — every field present, angles in RADIANS. */
export interface ResolvedVehicleHandling {
    topSpeed: number;            // m/s
    reverseTopSpeed: number;     // m/s (positive)
    accelerationScale: number;
    maxSteerAngleRad: number;    // rad
    steerSpeedRad: number;       // rad/s
    steerReturnSpeedRad: number; // rad/s
    steerSpeedFalloff: number;
    minSteerAtSpeed: number;
    downforceG: number;          // g of aero load at DEFAULT_DOWNFORCE_MODEL.referenceSpeed
}

/**
 * Default-basis constants. The size-scaled defaults are derived from these; they are
 * the single source of truth for "stock" vehicle handling (previously hard-coded inside
 * RapierVehicle).
 */
export const HANDLING_DEFAULTS = {
    /** Footprint (m) the defaults are tuned for = the default racing car's length. */
    referenceFootprint: 3.4,
    /**
     * Top-speed cap at default size (m/s); scaled by footprint (smaller = slower).
     * 28 m/s ≈ 100 km/h ≈ 63 mph for a reference car — an arcade "feels fast" pace.
     * (Was 12 m/s ≈ 43 km/h, which read as sluggish across every driving game.)
     * A race game should still OVERRIDE `handling.topSpeed` higher for true speed;
     * this is only the size-scaled fallback when nothing is set.
     */
    maxSpeedBase: 28,
    /** Top-speed cap ∝ sizeFactor^this. */
    topSpeedSizeExponent: 0.6,
    /**
     * Reverse cap as a fraction of top speed. Cars reverse on one short gear;
     * arcade or not, backing up at racing pace is neither realistic nor
     * controllable (the steered wheels trail, so it snakes).
     */
    reverseSpeedFraction: 0.45,
    /** Drive force ∝ sizeFactor^this (capped ≤1). */
    accelSizeExponent: 0.5,
    /** Full-lock steering angle (rad). */
    maxSteerAngleRad: 0.6,
    /** Steering ramp-to-lock speed (rad/s). */
    steerSpeedRad: 4.0,
    /** Steering return-to-center speed (rad/s). Not individually overridable. */
    steerReturnSpeedRad: 6.0,
    /** Speed → steering-softening sensitivity. */
    steerSpeedFalloff: 0.15,
    /** Floor on steering at speed (fraction of max). */
    minSteerAtSpeed: 0.25,
    /**
     * Aero downforce in g at the model's reference speed. 1 g is arcade-generous
     * rather than road-realistic: it is what stops a car at racing pace turning
     * every crest into a long flight. Scales with v², so slow games are untouched.
     */
    downforceG: 1,
} as const;

/**
 * Resolve per-vehicle handling. Each provided override wins; anything omitted uses the
 * size-scaled default. `sizeFactor` is the vehicle footprint ÷ reference (1 = default
 * car, 0.25 = quarter-scale). Override values are used verbatim — only DEFAULTS scale.
 */
export function resolveVehicleHandling(
    overrides: VehicleHandlingConfig | undefined,
    sizeFactor: number,
): ResolvedVehicleHandling {
    const o = overrides ?? {};
    const d = HANDLING_DEFAULTS;
    const topSpeed = o.topSpeed ?? d.maxSpeedBase * Math.pow(sizeFactor, d.topSpeedSizeExponent);
    return {
        topSpeed,
        reverseTopSpeed: o.reverseTopSpeed ?? topSpeed * d.reverseSpeedFraction,
        // Default tapers force DOWN with size (≤1, never boosts a big car); an explicit
        // override is used as-is so the agent can set a boost (>1) too.
        accelerationScale: o.accelerationScale ?? Math.min(1, Math.pow(sizeFactor, d.accelSizeExponent)),
        maxSteerAngleRad: o.maxSteerAngle !== undefined ? o.maxSteerAngle * DEG2RAD : d.maxSteerAngleRad,
        steerSpeedRad: o.steerSpeed !== undefined ? o.steerSpeed * DEG2RAD : d.steerSpeedRad,
        steerReturnSpeedRad: d.steerReturnSpeedRad,
        steerSpeedFalloff: o.steerSpeedFalloff ?? d.steerSpeedFalloff,
        minSteerAtSpeed: o.minSteerAtSpeed ?? d.minSteerAtSpeed,
        // Not size-scaled: aero load depends on speed and body shape, not on how
        // big the car is — and it is already expressed per unit of the car's weight.
        downforceG: o.downforce ?? d.downforceG,
    };
}

/**
 * Gate the requested drive force against the speed caps, using the SIGNED speed
 * along the car's own forward axis — never the velocity magnitude.
 *
 * Magnitude was the original test, and it made the throttle direction-blind: a car
 * reversing faster than `topSpeed` (reverse had no cap at all, so any sustained S
 * got there) had its FORWARD drive zeroed as well, so W applied nothing and the
 * car coasted backwards until it hit something — the classic "S key gets stuck".
 * W never showed it because forward drive is capped and so can't outrun its own
 * limit. Signed speed also stops a fast fall or a big drop from cutting the
 * throttle, since vertical velocity no longer counts toward the cap.
 */
export function gateDriveForce(
    engineForce: number,
    forwardSpeed: number,
    h: Pick<ResolvedVehicleHandling, 'topSpeed' | 'reverseTopSpeed'>,
): number {
    if (engineForce > 0 && forwardSpeed > h.topSpeed) return 0;
    if (engineForce < 0 && forwardSpeed < -h.reverseTopSpeed) return 0;
    return engineForce;
}

/**
 * A speed controller idling at zero throttle must NOT release the parking
 * brake — only a genuine request to move may. Anything a controller emits as
 * "no throttle" rounds to well under this.
 */
export const THROTTLE_PARKING_BRAKE_EPSILON = 0.01;

/**
 * Resolve the throttle a vehicle should apply, in [-1, 1] (+1 = full forward,
 * -1 = full reverse).
 *
 * Analog `throttle` overrides the booleans exactly the way analog `steer`
 * overrides `left`/`right`. With `throttle` undefined this reproduces the
 * original boolean model verbatim, INCLUDING forward winning over backward —
 * shipped games send boolean-only controls and must not change behaviour.
 */
export function resolveThrottle(
    throttle: number | undefined,
    forward: boolean,
    backward: boolean,
): number {
    if (throttle !== undefined) return Math.max(-1, Math.min(1, throttle));
    if (forward) return 1;
    if (backward) return -1;
    return 0;
}

/** Resolve the brake a vehicle should apply, in [0, 1]. See `resolveThrottle`. */
export function resolveBraking(brakeAmount: number | undefined, brake: boolean): number {
    if (brakeAmount !== undefined) return Math.max(0, Math.min(1, brakeAmount));
    return brake ? 1 : 0;
}

/**
 * Resolve this frame's steering ANGLE (radians, + = left) for the player path.
 *
 * Two input models share one wheel:
 *
 * - ANALOG (`steer` non-zero: touch steering pill, gamepad stick) is POSITIONAL —
 *   the wheel goes straight to that fraction of `maxAngle` and stays there. A key
 *   can only say "more left", so the boolean path has to integrate; an axis
 *   already carries the magnitude, and integrating it too made a small deflection
 *   creep to full lock no matter how gently the player was steering.
 * - BOOLEAN (`left`/`right`) integrates at `rampDelta` per frame and unwinds at
 *   `returnDelta` when neither is held — the keyboard feel, unchanged.
 *
 * `steer === 0` deliberately takes the boolean path so releasing an analog input
 * unwinds the wheel through the normal return ramp instead of snapping it straight.
 */
export function resolveSteering(
    steer: number | undefined,
    left: boolean,
    right: boolean,
    current: number,
    maxAngle: number,
    rampDelta: number,
    returnDelta: number,
): number {
    if (steer !== undefined && steer !== 0) {
        return Math.max(-1, Math.min(1, steer)) * maxAngle;
    }
    if (left) return Math.min(current + rampDelta, maxAngle);
    if (right) return Math.max(current - rampDelta, -maxAngle);
    if (current > 0) return Math.max(0, current - returnDelta);
    if (current < 0) return Math.min(0, current + returnDelta);
    return current;
}

/**
 * Raw speed softening, BEFORE the `minSteerAtSpeed` floor: 1 at standstill,
 * decaying toward 0 as speed rises. Speed is normalized by vehicle size so the
 * softening covers each car's own speed range rather than absolute m/s (and the
 * size factor is clamped so a degenerate 0 can't divide by ~zero).
 *
 * Use this for the steering RAMP/RETURN rates, which are allowed to keep slowing
 * past the floor, and `steeringSpeedFactor()` for the steering ANGLE, which is not.
 */
export function steeringSoftening(speed: number, sizeFactor: number, steerSpeedFalloff: number): number {
    return 1.0 / (1.0 + (speed / Math.max(0.15, sizeFactor)) * steerSpeedFalloff);
}

/**
 * Steering authority left at a given speed, in [minSteerAtSpeed, 1] — the speed
 * softening every steering path must share. The result is floored at
 * `minSteerAtSpeed` so a fast car always retains enough lock to corner.
 * setAIControls originally applied the falloff on RAW speed with NO floor; when
 * the 2026-07-24 racing pass raised default top speed 12 → 28 m/s, AI steering
 * authority collapsed to ~15% and every AI car understeered off the track at the
 * first corner — this shared helper is the fix and the regression guard.
 */
export function steeringSpeedFactor(
    speed: number,
    sizeFactor: number,
    h: Pick<ResolvedVehicleHandling, 'steerSpeedFalloff' | 'minSteerAtSpeed'>,
): number {
    return Math.max(h.minSteerAtSpeed, steeringSoftening(speed, sizeFactor, h.steerSpeedFalloff));
}

/** Convert resolved (radians) handling back to the agent-facing config (degrees, m/s),
 *  fully populated — what `vehicle.getHandling()` returns for read-modify-write. */
export function handlingToAgentUnits(r: ResolvedVehicleHandling): Required<VehicleHandlingConfig> {
    return {
        topSpeed: r.topSpeed,
        reverseTopSpeed: r.reverseTopSpeed,
        accelerationScale: r.accelerationScale,
        maxSteerAngle: r.maxSteerAngleRad / DEG2RAD,
        steerSpeed: r.steerSpeedRad / DEG2RAD,
        steerSpeedFalloff: r.steerSpeedFalloff,
        minSteerAtSpeed: r.minSteerAtSpeed,
        downforce: r.downforceG,
    };
}
