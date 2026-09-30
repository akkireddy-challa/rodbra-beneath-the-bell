/**
 * Visual body sway (roll + pitch) for a vehicle — weight transfer you can see.
 *
 * A car's body sits on springs above its contact patches. When the tyres push it
 * sideways or along its length, the body's inertia lags: it leans OUT of a
 * corner, squats under power, and dives under braking. This reproduces that lean
 * for the RENDERED body only — nothing here touches the rigid body, so grip,
 * collisions and handling are bit-for-bit unchanged.
 *
 * Physically motivated rather than hand-keyed:
 *   - Lean is expressed in degrees per g, the same "roll gradient" chassis
 *     engineers quote (a road car is ~3-7°/g). Because it is an angle per unit
 *     of acceleration, it needs no per-vehicle tuning — a kart and a bus lean the
 *     same amount for the same cornering force.
 *   - Lateral load comes from the centripetal term `v · yawRate` rather than a
 *     differentiated velocity: it is the same quantity, without the frame-to-frame
 *     noise that differentiating a physics velocity introduces.
 *   - The body reaches that lean through a damped spring, so it has mass: it
 *     rolls in over a beat and settles, instead of snapping to the target.
 *
 * Pure (no three.js / engine imports) so the response curve is unit-testable.
 */

/** Gravity used to convert an acceleration into g, matching the physics world. */
const G = 9.81;

export interface VehicleBodySwayOptions {
    /** Body roll per 1 g of lateral acceleration (degrees). Road cars: ~3-7. */
    rollDegPerG: number;
    /** Body pitch per 1 g of longitudinal acceleration (degrees). */
    pitchDegPerG: number;
    /** Hard cap on roll (degrees) so a hard corner can't roll the body over. */
    maxRollDeg: number;
    /** Hard cap on pitch (degrees). */
    maxPitchDeg: number;
    /** Suspension frequency (Hz) — how quickly the body reaches its lean. */
    frequencyHz: number;
    /** 1 = critically damped (no overshoot); below 1 lets the body rebound. */
    dampingRatio: number;
    /** Low-pass on the measured longitudinal acceleration (Hz). */
    accelSmoothingHz: number;
}

/**
 * Arcade-leaning defaults: a touch more than a real road car so the weight
 * transfer reads on screen, still small enough to look like suspension travel
 * rather than a boat in a swell.
 */
export const DEFAULT_VEHICLE_BODY_SWAY: VehicleBodySwayOptions = {
    rollDegPerG: 6,
    pitchDegPerG: 5,
    maxRollDeg: 8,
    maxPitchDeg: 6,
    frequencyHz: 1.8,
    dampingRatio: 0.65,
    accelSmoothingHz: 6,
};

const DEG2RAD = Math.PI / 180;

/** Per-frame vehicle state the sway is derived from (body frame, +Z forward). */
export interface VehicleBodySwayInput {
    /** Speed along the vehicle's own forward axis (m/s; negative = reversing). */
    forwardSpeed: number;
    /** Yaw rate about world up (rad/s). Positive = turning toward +X. */
    yawRate: number;
}

/** The lean to apply to the rendered body, in radians. */
export interface VehicleBodySwayAngles {
    /**
     * Rotation about the body's FORWARD (+Z) axis. Positive raises the +X side,
     * which is the outside-lean of a turn toward +X.
     */
    rollRad: number;
    /**
     * Rotation about the body's RIGHT-HAND (+X) axis. Positive pitches the nose
     * DOWN (braking dive); negative lifts it (power squat).
     */
    pitchRad: number;
}

/**
 * Integrates the body's lean. One instance per vehicle; call `update` once per
 * rendered frame.
 */
export class VehicleBodySway {
    private opts: VehicleBodySwayOptions;

    private roll = 0;
    private rollVel = 0;
    private pitch = 0;
    private pitchVel = 0;

    /** Smoothed longitudinal acceleration (m/s²), and the speed it came from. */
    private longAccel = 0;
    private prevForwardSpeed: number | null = null;

    constructor(opts: VehicleBodySwayOptions = DEFAULT_VEHICLE_BODY_SWAY) {
        this.opts = { ...opts };
    }

    setOptions(opts: Partial<VehicleBodySwayOptions>): void {
        this.opts = { ...this.opts, ...opts };
    }

    /** Drop all lean and history — use when a vehicle is teleported or respawned. */
    reset(): void {
        this.roll = 0;
        this.rollVel = 0;
        this.pitch = 0;
        this.pitchVel = 0;
        this.longAccel = 0;
        this.prevForwardSpeed = null;
    }

    /** Current lean without advancing the simulation. */
    getAngles(): VehicleBodySwayAngles {
        return { rollRad: this.roll, pitchRad: this.pitch };
    }

    update(deltaTime: number, input: VehicleBodySwayInput): VehicleBodySwayAngles {
        if (!(deltaTime > 0)) return this.getAngles();
        // A long stall (tab hidden, load hitch) would otherwise integrate one
        // huge step and fling the body; clamp to a plausible frame.
        const dt = Math.min(deltaTime, 1 / 20);
        const o = this.opts;

        // Longitudinal: rate of change of forward speed, low-passed. The first
        // frame has no previous sample, so it contributes no acceleration.
        const rawLongAccel = this.prevForwardSpeed === null
            ? 0
            : (input.forwardSpeed - this.prevForwardSpeed) / dt;
        this.prevForwardSpeed = input.forwardSpeed;
        const accelBlend = 1 - Math.exp(-2 * Math.PI * o.accelSmoothingHz * dt);
        this.longAccel += (rawLongAccel - this.longAccel) * accelBlend;

        // Lateral: centripetal acceleration of the turn the car is actually
        // driving, positive toward +X (the inside of a +X turn).
        const latAccel = input.forwardSpeed * input.yawRate;

        // Targets. The body leans AWAY from the force the tyres apply, which for
        // roll about +Z means raising the +X side when accelerating toward +X.
        const targetRoll = clamp(
            o.rollDegPerG * (latAccel / G), -o.maxRollDeg, o.maxRollDeg,
        ) * DEG2RAD;
        // Nose down under braking: positive pitch is nose-down, and braking is a
        // negative longitudinal acceleration, hence the sign flip.
        const targetPitch = clamp(
            -o.pitchDegPerG * (this.longAccel / G), -o.maxPitchDeg, o.maxPitchDeg,
        ) * DEG2RAD;

        const omega = 2 * Math.PI * o.frequencyHz;
        const spring = (x: number, v: number, target: number): [number, number] => {
            // Semi-implicit Euler: velocity first, then position, which stays
            // stable at the stiffnesses suspension wants.
            const accel = omega * omega * (target - x) - 2 * o.dampingRatio * omega * v;
            const nv = v + accel * dt;
            return [x + nv * dt, nv];
        };
        [this.roll, this.rollVel] = spring(this.roll, this.rollVel, targetRoll);
        [this.pitch, this.pitchVel] = spring(this.pitch, this.pitchVel, targetPitch);

        return this.getAngles();
    }
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}
