import type * as THREE from 'three';
import { EffectShape, DEFAULT_EFFECT_SHAPE_OPTIONS, type EffectShapeOptions } from 'engine/effects/EffectShapes.js';
import type { VFXStyle } from 'engine/effects/VFXUtils.js';

export interface CustomEffectOptions extends EffectShapeOptions {
    /** Positive cycle length in seconds; use loop for indefinite playback. */
    duration: number;
    /** Repeat a duration-long cycle until stopped. Duration must be positive. */
    loop: boolean;
}
export const DEFAULT_CUSTOM_EFFECT_OPTIONS: CustomEffectOptions = {
    ...DEFAULT_EFFECT_SHAPE_OPTIONS, duration: 1, loop: false,
};

/** Keep the definition at module scope: its identity and style are the pool key.
 * Defaults describe the look; each spawn inherits the scene's style, quality and
 * next seed unless the caller overrides them. No global catalog registration. */
export interface CustomEffectDefinition<Options extends CustomEffectOptions> {
    defaults: Readonly<Options>;
    create(scene: THREE.Scene, style: VFXStyle): CustomEffectVisual<Options>;
}

/** Extend in game code. Construct owned geometry/materials once, reset all state
 * in rearm(), then compute the image at absolute normalized age in setProgress().
 * The inherited retire/dispose hide the group and free its owned mesh resources.
 * Never parent a game object into this group; override cleanup for non-mesh resources.
 * See agent-docs/samples/custom-visual-effect.ts for a complete implementation. */
export abstract class CustomEffectVisual<Options extends CustomEffectOptions> extends EffectShape {
    abstract rearm(position: THREE.Vector3, options: Readonly<Options>): void;
}
