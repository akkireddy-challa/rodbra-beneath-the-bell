import * as THREE from 'three';

/**
 * How a big ship answers her helm. Input, HUD, sound and the wheel's mesh are
 * the game's; this is only the model the game drives with a command in −1..1.
 *
 * Three things make her feel heavy, and each is the difference from a rowing boat:
 * the wheel itself takes seconds to put over; the rudder does not turn her, it
 * makes her BEGIN to turn, so the swing builds and dies away on its own time
 * constant; and she leans because she is turning, not because the wheel is over,
 * so the heel is still there after the helm has been centred.
 */
export interface ShipHelmOptions {
    /** Seconds to wind the rudder from hard a-port to hard a-starboard. */
    hardOverSeconds: number;
    /** Rate of turn at full rudder once she has settled into it, radians per second. */
    maxTurnRate: number;
    /** Time constant of the swing's answer to the rudder, in seconds. */
    turnLagSeconds: number;
    /** How far she leans out of a full-rate turn, in radians. */
    maxHeel: number;
    /** How quickly the heel follows the swing, per second. */
    heelResponse: number;
}

/**
 * A galleon: 7 s hard over to hard over, ~2.6°/s at full helm (a full circle in
 * about two and a half minutes), a 6 s swing, ~2.5° of heel.
 */
export const DEFAULT_SHIP_HELM_OPTIONS: ShipHelmOptions = {
    hardOverSeconds: 7,
    maxTurnRate: 0.045,
    turnLagSeconds: 6,
    maxHeel: 0.044,
    heelResponse: 1.5,
};

const TAU = Math.PI * 2;

export class ShipHelm {
    private readonly options: ShipHelmOptions;
    private heading: number;
    private rudder = 0;
    private turnRate = 0;
    private heel = 0;

    /** @param initialHeading the course she starts on — usually `VesselFrame.heading`. */
    constructor(initialHeading: number, options: ShipHelmOptions) {
        this.options = options;
        this.heading = ((initialHeading % TAU) + TAU) % TAU;
    }

    /**
     * Advance the helm. `command` is the order: −1 hard a-port, +1 hard
     * a-starboard, 0 to let the rudder come back amidships.
     */
    update(deltaTime: number, command: number): void {
        const o = this.options;
        const target = THREE.MathUtils.clamp(command, -1, 1);
        const step = (2 / o.hardOverSeconds) * deltaTime;
        this.rudder = THREE.MathUtils.clamp(
            this.rudder + THREE.MathUtils.clamp(target - this.rudder, -step, step),
            -1,
            1,
        );

        // Exponential rather than linear so the answer is frame-rate independent,
        // and so meeting her with opposite helm bleeds the swing off as it built.
        const ordered = this.rudder * o.maxTurnRate;
        this.turnRate += (ordered - this.turnRate) * (1 - Math.exp(-deltaTime / o.turnLagSeconds));
        this.heading = (this.heading + this.turnRate * deltaTime + TAU) % TAU;

        const heelTarget = -(this.turnRate / o.maxTurnRate) * o.maxHeel;
        this.heel += (heelTarget - this.heel) * Math.min(1, deltaTime * o.heelResponse);
    }

    /** The course she is making, radians in [0, 2π), gameplay convention. */
    getHeading(): number {
        return this.heading;
    }

    /** Rudder angle, −1 hard a-port to +1 hard a-starboard. Spin the wheel's spokes off this. */
    getRudder(): number {
        return this.rudder;
    }

    /**
     * How fast she is swinging, radians per second (positive to starboard). The
     * one thing a heavy ship gives no other way of reading: centre the helm while
     * she is still swinging and she has plenty more to run.
     */
    getTurnRate(): number {
        return this.turnRate;
    }

    /**
     * Her lean, in radians, as a roll about the view axis (THREE `rotateZ`
     * convention) — hand it straight to `SwellSway.apply`. Turning to starboard
     * leans her to port, which is negative.
     */
    getHeel(): number {
        return this.heel;
    }
}
