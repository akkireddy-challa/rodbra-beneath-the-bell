/**
 * Aerodynamic downforce for a vehicle — why fast cars stay on the road.
 *
 * A raycast vehicle feels the world only through its suspension rays, so it has
 * no aerodynamics at all: the instant the last wheel loses contact, every force
 * acting on it disappears except gravity, and it coasts through a clean ballistic
 * arc whose range grows with the SQUARE of speed. That is why raising top speeds
 * made cars sail off every crest — nothing pushes them back down, and the faster
 * they go the further they sail.
 *
 * A real car has the opposite behaviour: air pressure over the body presses it
 * into the road, and that load also grows with v². It is what keeps a racing car
 * planted at speed, and it is the reason a road car (little downforce) gets light
 * over a crest while a racer (lots of it) does not. Modelling downforce instead
 * of simply adding gravity gets the whole behaviour for free:
 *
 *   - Slow driving is untouched, because at low speed there is barely any load.
 *     A gentle hop off a kerb still floats exactly as it used to.
 *   - Taking the same crest too fast is punished quadratically — precisely the
 *     "I keep flying and going really far" case.
 *   - Different cars can have different amounts of it, so an F1 car sticks and a
 *     muscle car or a kart still gets airborne.
 *
 * **Implemented as a gravity scale.** The load is expressed in g — multiples of
 * the car's own weight — which makes it size-agnostic (a kart and a truck need no
 * separate tuning). A world-down force proportional to mass is *exactly* a change
 * in gravity, so scaling gravity is not an approximation of this model, it is the
 * model, and it costs one number per step instead of a force integration.
 *
 * Pure (no three.js / engine imports) so the response curve is unit-testable.
 */

/** Shape of the aero curve. Shared by every vehicle; per-car strength is separate. */
export interface VehicleDownforceModel {
    /** Speed (m/s) at which a car of coefficient 1.0 generates 1 g of load. */
    referenceSpeed: number;
    /**
     * Ceiling on the load (g). Real wings are limited by drag and stalling; here
     * it mostly stops a very fast car from burying itself in the road.
     */
    maxG: number;
    /**
     * Share of the load applied while a wheel is still down.
     *
     * On the ground the load is reacted by the springs, and this engine's
     * suspension is soft — roughly 0.22 m of sag per g against 0.48 m of travel,
     * so a full racing load at speed would bottom it out and turn the ride harsh.
     * Real racers fit far stiffer springs precisely because of downforce; ours
     * cannot, so the grounded share is trimmed to what the travel can absorb. It
     * is still enough to press the tyres down and raise their grip at speed.
     * Airborne there is no suspension to react anything, so the full load applies.
     */
    groundedFraction: number;
}

export const DEFAULT_DOWNFORCE_MODEL: VehicleDownforceModel = {
    referenceSpeed: 30,
    maxG: 2.5,
    groundedFraction: 0.35,
};

/**
 * Gravity multiplier produced by aero load this step.
 *
 * @param airspeed Speed through the air (m/s). Pass the HORIZONTAL speed: a wing
 *   makes downforce from the air flowing over it, not from falling. Feeding it the
 *   full velocity would let a long drop accelerate its own descent.
 * @param downforceG The car's coefficient — load in g at `model.referenceSpeed`.
 *   0 gives a pure ballistic vehicle.
 * @param anyWheelInContact Whether the suspension can react the load.
 * @returns Multiplier to apply to gravity; 1 means leave it alone.
 */
export function downforceGravityScale(
    airspeed: number,
    downforceG: number,
    anyWheelInContact: boolean,
    model: VehicleDownforceModel = DEFAULT_DOWNFORCE_MODEL,
): number {
    if (!Number.isFinite(airspeed) || airspeed <= 0) return 1;
    if (!Number.isFinite(downforceG) || downforceG <= 0) return 1;

    const ratio = airspeed / model.referenceSpeed;
    const load = Math.min(model.maxG, downforceG * ratio * ratio);
    return 1 + load * (anyWheelInContact ? model.groundedFraction : 1);
}
