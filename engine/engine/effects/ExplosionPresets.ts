import { effectNumber } from 'engine/effects/VFXUtils.js';

export type ExplosionPreset = 'blast' | 'fireball' | 'fragmentation' | 'plasma' | 'emp' | 'frost' | 'poison' | 'dust'
    | 'inferno' | 'napalm' | 'volcanic' | 'steam' | 'sonic' | 'implosion' | 'arcane' | 'shatter';
export type ExplosionLayer = 'flash' | 'fire' | 'smoke' | 'sparks' | 'debris' | 'ring';
export interface ExplosionRecipe {
    color: number;
    smokeColor: number;
    sparkColor: number;
    debrisColor: number;
    ringColor: number;
    fire: number;
    smoke: number;
    sparks: number;
    debris: number;
    flash: number;
    ring: number;
    lift: number;
    speed: number;
    swirl: number;
    duration: number;
    debrisStretch: number;
    /** Defaults to the original outward burst. */
    motion?: 'outward' | 'inward' | 'column' | 'disk';
}

const blast: ExplosionRecipe = {
    color: 0xff5a12, smokeColor: 0x62666a, sparkColor: 0xffc46b, debrisColor: 0x5a4b3b, ringColor: 0xe3c092,
    fire: 18, smoke: 12, sparks: 36, debris: 20, flash: 1, ring: 1, lift: 1, speed: 1, swirl: 0.15, duration: 1.2, debrisStretch: 0.7,
};

/** Presets change layer composition and motion, not just tint. Counts are high-quality baselines. */
export const EXPLOSION_PRESETS: Readonly<Record<ExplosionPreset, Readonly<ExplosionRecipe>>> = {
    blast,
    fireball: { ...blast, fire: 30, smoke: 24, sparks: 22, debris: 6, lift: 1.7, speed: 0.65, swirl: 0.4, duration: 2 },
    fragmentation: { ...blast, fire: 8, smoke: 7, sparks: 64, debris: 40, lift: 0.45, speed: 1.5, duration: 0.85 },
    plasma: { ...blast, color: 0x5577ff, sparkColor: 0xa8eaff, ringColor: 0x67cfff,
        fire: 16, smoke: 0, sparks: 44, debris: 0, ring: 1.5, lift: 0.25, swirl: 1.8, duration: 1.1 },
    emp: { ...blast, color: 0x52dcff, sparkColor: 0xccf7ff, ringColor: 0x48bfff,
        fire: 0, smoke: 0, sparks: 48, debris: 0, flash: 0.55, ring: 2, lift: 0, speed: 0.75, swirl: 0, duration: 0.8 },
    frost: { ...blast, color: 0x99eaff, smokeColor: 0xb4dce2, sparkColor: 0xdfffff, debrisColor: 0x75bdd8, ringColor: 0xc1f5ff,
        fire: 4, smoke: 10, sparks: 18, debris: 36, flash: 0.6, debrisStretch: 2.6, lift: 0.35, speed: 0.8, duration: 1.5 },
    poison: { ...blast, color: 0x98e844, smokeColor: 0x668342, sparkColor: 0xb9ff63, debrisColor: 0x53652f, ringColor: 0x94be4d,
        fire: 8, smoke: 26, sparks: 12, debris: 4, flash: 0.25, lift: 1.3, speed: 0.45, swirl: 1.2, duration: 2.5 },
    dust: { ...blast, smokeColor: 0xa28a69, debrisColor: 0x8e7758, ringColor: 0xb9a386,
        fire: 0, smoke: 30, sparks: 0, debris: 32, flash: 0, lift: 0.35, speed: 0.7, swirl: 0.25, duration: 1.8 },
    inferno: { ...blast, fire: 32, smoke: 28, sparks: 56, debris: 8, color: 0xff3909,
        smokeColor: 0x38343a, lift: 2.2, speed: 0.85, swirl: 2.4, duration: 2.6 },
    napalm: { ...blast, motion: 'disk', fire: 32, smoke: 18, sparks: 24, debris: 0, color: 0xff7018,
        smokeColor: 0x4b4541, flash: 0.4, ring: 0.3, lift: 1.2, speed: 0.6, swirl: 0.5, duration: 2.8 },
    volcanic: { ...blast, motion: 'column', fire: 16, smoke: 20, sparks: 44, debris: 38,
        debrisColor: 0x3e3030, lift: 1.6, speed: 1.1, swirl: 0.6, flash: 0.65, ring: 0.5, duration: 2.2, debrisStretch: 1.4 },
    steam: { ...blast, motion: 'column', fire: 0, smoke: 32, sparks: 0, debris: 0, flash: 0,
        smokeColor: 0xc7d9df, ringColor: 0xdaeff2, lift: 1.15, swirl: 1.6, ring: 0.25, duration: 2.1 },
    sonic: { ...blast, motion: 'disk', fire: 0, smoke: 14, sparks: 48, debris: 8, flash: 0.2, ring: 2,
        smokeColor: 0xb4ccd1, sparkColor: 0xc7f6ff, ringColor: 0xa2e9ff, lift: 0, speed: 1.4, duration: 0.9 },
    implosion: { ...blast, motion: 'inward', fire: 14, smoke: 0, sparks: 64, debris: 24, flash: 0.8, ring: 1.5,
        color: 0x5830c4, sparkColor: 0xd29aff, debrisColor: 0x513f6f, ringColor: 0xa080ff, lift: 0, swirl: 4, duration: 1.5 },
    arcane: { ...blast, fire: 10, smoke: 0, sparks: 64, debris: 18, color: 0xd759ed, sparkColor: 0xffbbef,
        debrisColor: 0xa679d4, ringColor: 0xe89bff, lift: 0, speed: 0.7, swirl: 4, ring: 1.6, debrisStretch: 3.8, duration: 1.6 },
    shatter: { ...blast, fire: 0, smoke: 6, sparks: 24, debris: 42, flash: 0.35, ring: 0.45,
        smokeColor: 0xc5d4e4, sparkColor: 0xf1dcff, debrisColor: 0xc3a2ed, ringColor: 0xdebdff,
        lift: 0.3, speed: 1.25, debrisStretch: 4.5, duration: 1.25 },
};

export function explosionRecipe(preset: ExplosionPreset, overrides?: Partial<ExplosionRecipe>): Readonly<ExplosionRecipe> {
    const recipe = EXPLOSION_PRESETS[preset];
    if (!Object.prototype.hasOwnProperty.call(EXPLOSION_PRESETS, preset)) throw new Error(`Unknown explosion preset: ${preset}`);
    if (!overrides) return recipe;
    const result = { ...recipe, ...overrides };
    for (const key of ['color', 'smokeColor', 'sparkColor', 'debrisColor', 'ringColor'] as const) result[key] = effectNumber(result[key], key, 0, 0xffffff);
    for (const key of ['fire', 'smoke', 'sparks', 'debris'] as const) result[key] = effectNumber(result[key], key, 0, 256);
    for (const key of ['flash', 'ring'] as const) result[key] = effectNumber(result[key], key, 0, 2);
    for (const key of ['lift', 'speed', 'debrisStretch'] as const) result[key] = effectNumber(result[key], key, 0, 20);
    result.swirl = effectNumber(result.swirl, 'swirl', -50, 50);
    result.duration = effectNumber(result.duration, 'duration', 0.01, 120);
    if (result.motion !== undefined && !['outward', 'inward', 'column', 'disk'].includes(result.motion)) throw new Error(`Unknown explosion motion: ${result.motion}`);
    return Object.freeze(result);
}
