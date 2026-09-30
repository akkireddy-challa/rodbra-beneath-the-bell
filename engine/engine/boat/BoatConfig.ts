/**
 * Tuning for `engine/boat/BoatMovement.ts`. Flat numbers and booleans only, so
 * the same shape works in code and in world.json
 * `worldProfileData.playerMovement.boat` (unknown keys are ignored, see
 * `mergeBoatConfig`).
 *
 * Defaults are tuned for arcade watercraft racing — a jet-ski / offshore
 * powerboat feel: quick to plane, loose in the tail, launches off crests.
 */

export interface BoatConfig {
    // ---- speed ----
    /** Top speed under full throttle (m/s). ~26 m/s ≈ 94 km/h. */
    maxSpeed: number;
    /** Top speed while the boost input is held (m/s). */
    boostMaxSpeed: number;
    /** Top speed in reverse (m/s). Reverse is for getting unstuck, not racing. */
    reverseMaxSpeed: number;
    /** Thrust under full throttle (m/s²). */
    acceleration: number;
    /** Extra thrust while boosting (m/s²), added to `acceleration`. */
    boostAcceleration: number;
    /** Thrust astern (m/s²). */
    reverseAcceleration: number;
    /** Deceleration when the brake/reverse key is held while moving forward (m/s²). */
    brakeDecel: number;
    /**
     * Skin drag (1/s), linear in speed — the part that dominates at low speed
     * and stops a drifting boat coasting forever.
     *
     * There is deliberately NO authored quadratic drag term. The hull's
     * quadratic drag is DERIVED from `acceleration`, `maxSpeed` and this value
     * so that thrust and drag cancel exactly at `maxSpeed` (see
     * `quadraticDragFor`). Authoring both a top speed and a drag curve means
     * they disagree — the first version of this config did, and the boats
     * plateaued at 8 m/s with `maxSpeed: 24` sitting in the file looking
     * correct.
     */
    dragLinear: number;

    // ---- steering ----
    /** Turn rate at low speed (deg/s). A boat barely steers when not moving. */
    turnRateLowDeg: number;
    /** Turn rate at top speed (deg/s). */
    turnRateHighDeg: number;
    /**
     * Speed (m/s) at which steering authority peaks. Below this a boat has no
     * water flowing over the hull to bite on; above it, momentum resists.
     */
    turnPeakSpeed: number;
    /** Fraction of the ground turn rate available while airborne (0..1). */
    airTurnFactor: number;
    /**
     * How fast sideways velocity is converted back into forward motion (1/s).
     * This is the drift knob: 8+ is on rails, ~3 slides through corners the way
     * an arcade watercraft should, below 1 is an ice rink.
     */
    gripRate: number;

    // ---- waves ----
    /** How high the hull's origin rides above the water surface (m). */
    rideHeight: number;
    /**
     * How fast the hull settles onto a new surface height (1/s). Low values
     * make a heavy boat that ploughs through chop; high values glue it to
     * every ripple.
     */
    buoyancyRate: number;
    /**
     * Extra speed (m/s²) gained running down a wave face, lost climbing one.
     * This is what makes a swell into gameplay instead of decoration.
     */
    waveSurfAccel: number;
    /**
     * Downward acceleration (m/s²) once airborne. Deliberately separate from
     * world gravity: arcade boats want a snappier arc than 9.81 gives.
     */
    gravity: number;
    /**
     * How much faster than gravity the water has to fall away before the hull
     * leaves it (m/s). Small values launch off every ripple; large values keep
     * the boat glued through crests.
     */
    liftoffMargin: number;
    /** Take-off speed of a deliberate hop (m/s). 0 disables the jump. */
    jumpSpeed: number;
    /** Speed (m/s) lost on a hard landing, scaled by impact speed. */
    landingSpeedLoss: number;

    // ---- pose ----
    /** How strongly the hull matches the water's tilt (0 = flat, 1 = full). */
    waveAlign: number;
    /** Roll into a turn (deg at full lock and full speed). */
    turnLeanDeg: number;
    /** Bow lift under acceleration (deg at full thrust). */
    bowLiftDeg: number;
    /** Rate the visual pose chases its target (1/s). */
    poseRate: number;

    // ---- visuals ----
    /** Draw the procedural hull under the rider. */
    showHull: boolean;
    /** Hull body colour (hex). */
    hullColor: number;
    /** Hull trim / deck colour (hex). */
    trimColor: number;
    /** Seat colour (hex). */
    seatColor: number;
    /** Overall hull scale. 1 ≈ a 3.2 m jet-ski. */
    hullScale: number;
    /**
     * Draw a simple crouched rider on the hull.
     *
     * OFF for the player, whose own character is placed on the deck by
     * `BoatMovement` — turning it on there gives them a passenger sitting
     * inside their own body. ON for `AiBoat`, which has no character behind it
     * and reads as a driverless prop without one.
     */
    showRider: boolean;
    /** Rider suit colour (hex). */
    riderColor: number;
    /** Rider helmet colour (hex). */
    riderHelmetColor: number;
    /** Emit wake and spray VFX. */
    showWake: boolean;
}

export const DEFAULT_BOAT_CONFIG: BoatConfig = {
    maxSpeed: 26,
    boostMaxSpeed: 34,
    reverseMaxSpeed: 5,
    acceleration: 13,
    boostAcceleration: 9,
    reverseAcceleration: 6,
    brakeDecel: 16,
    dragLinear: 0.12,

    turnRateLowDeg: 40,
    turnRateHighDeg: 105,
    turnPeakSpeed: 11,
    airTurnFactor: 0.35,
    gripRate: 3.2,

    rideHeight: 0.34,
    buoyancyRate: 9,
    waveSurfAccel: 7.5,
    gravity: 16,
    liftoffMargin: 1.6,
    jumpSpeed: 5.2,
    landingSpeedLoss: 0.18,

    waveAlign: 0.72,
    turnLeanDeg: 22,
    bowLiftDeg: 7,
    poseRate: 7,

    showHull: true,
    hullColor: 0xd8402f,
    trimColor: 0xf2c53d,
    seatColor: 0x1e2b46,
    hullScale: 1,
    showRider: false,
    riderColor: 0xc9382c,
    riderHelmetColor: 0x21365e,
    showWake: true,
};

/**
 * Quadratic drag coefficient (1/m) that makes thrust and drag cancel exactly at
 * `maxSpeed`: solve `acceleration = q·v² + dragLinear·v` for q at v = maxSpeed.
 *
 * Deriving it is why `maxSpeed` means what it says. Clamped at zero for configs
 * whose linear drag alone already exceeds the available thrust — those top out
 * below `maxSpeed`, which is at least monotonic and obvious.
 */
export function quadraticDragFor(config: BoatConfig): number {
    const v = Math.max(1e-3, config.maxSpeed);
    return Math.max(0, (config.acceleration - config.dragLinear * v) / (v * v));
}

/** Fields that must stay positive for the motor to behave. */
const POSITIVE_KEYS: ReadonlyArray<keyof BoatConfig> = [
    'maxSpeed', 'boostMaxSpeed', 'acceleration', 'turnPeakSpeed', 'buoyancyRate',
    'gravity', 'poseRate', 'hullScale',
];

/**
 * Merge partial overrides (typically straight out of world.json) over the
 * defaults, dropping anything with the wrong type or an impossible value.
 * A world file is authored by an AI agent and edited by hand; a stray string
 * or a `maxSpeed: 0` must degrade to the default, not produce a boat that
 * cannot move or a division by zero.
 */
export function mergeBoatConfig(partial?: Partial<BoatConfig> | Record<string, unknown>): BoatConfig {
    const out: BoatConfig = { ...DEFAULT_BOAT_CONFIG };
    if (!partial) return out;
    for (const [key, value] of Object.entries(partial)) {
        if (!(key in DEFAULT_BOAT_CONFIG)) continue;
        const k = key as keyof BoatConfig;
        const expected = typeof DEFAULT_BOAT_CONFIG[k];
        if (typeof value !== expected) continue;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        if (typeof value === 'number' && POSITIVE_KEYS.includes(k) && value <= 0) continue;
        // Each branch narrows to one primitive family, so the assignment is
        // checked rather than cast wholesale.
        if (typeof value === 'number') (out[k] as number) = value;
        else if (typeof value === 'boolean') (out[k] as boolean) = value;
    }
    return out;
}
