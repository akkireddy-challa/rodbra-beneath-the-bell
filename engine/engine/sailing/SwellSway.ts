import * as THREE from 'three';

/**
 * The camera rides the swell: a slow roll and heave on top of whatever the
 * active camera controller built this frame.
 *
 * Kept deliberately small. A ship that is the level cannot tilt its deck under
 * the player, so the deck rocks WITH the view rather than the horizon tilting
 * against a steady deck — and past about a degree that reads as a drunk
 * cameraman, not a ship at sea.
 */
export interface SwellSwayOptions {
    /** Two roll components, in radians. Two, so the swell never ticks like a metronome. */
    rollAmplitudes: readonly [number, number];
    /** Their angular rates, radians per second. Keep them mismatched. */
    rollRates: readonly [number, number];
    /** Two heave components, in metres. */
    heaveAmplitudes: readonly [number, number];
    /** Their angular rates, radians per second. */
    heaveRates: readonly [number, number];
    /** Scales roll and heave together — raise it for a storm, lower it for a lagoon. */
    amplitudeScale: number;
}

/** About one degree of roll and 15 cm of heave: an open-ocean swell under a big ship. */
export const DEFAULT_SWELL_SWAY_OPTIONS: SwellSwayOptions = {
    rollAmplitudes: [0.016, 0.007],
    rollRates: [0.62, 1.07],
    heaveAmplitudes: [0.11, 0.04],
    heaveRates: [0.79, 1.43],
    amplitudeScale: 1,
};

export class SwellSway {
    private readonly options: SwellSwayOptions;
    private elapsed = 0;

    constructor(options: SwellSwayOptions) {
        this.options = options;
    }

    update(deltaTime: number): void {
        this.elapsed += deltaTime;
    }

    /** Current swell roll, in radians, without any heel. */
    getRoll(): number {
        const { rollAmplitudes: a, rollRates: r, amplitudeScale } = this.options;
        return amplitudeScale * (a[0] * Math.sin(this.elapsed * r[0]) + a[1] * Math.sin(this.elapsed * r[1]));
    }

    /** Current heave, in metres. */
    getHeave(): number {
        const { heaveAmplitudes: a, heaveRates: r, amplitudeScale } = this.options;
        return amplitudeScale * (a[0] * Math.sin(this.elapsed * r[0]) + a[1] * Math.sin(this.elapsed * r[1]));
    }

    /**
     * Roll and heave `camera`, plus `heel` radians of lean (`ShipHelm.getHeel`).
     *
     * Call AFTER the active camera controller has updated this frame: controllers
     * rebuild position and orientation from scratch, so this absolute offset is
     * laid on top rather than accumulating.
     */
    apply(camera: THREE.Camera | null, heel: number): void {
        if (!camera) return;
        camera.rotateZ(this.getRoll() + heel);
        camera.position.y += this.getHeave();
    }
}
