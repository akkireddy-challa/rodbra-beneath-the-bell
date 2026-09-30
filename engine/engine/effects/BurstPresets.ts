import { effectNumber } from 'engine/effects/VFXUtils.js';

export type BurstPreset = 'sparks' | 'ricochet' | 'dust' | 'smoke' | 'flame' | 'embers' | 'frost' | 'poison' | 'heal' | 'magic' | 'portal' | 'confetti' | 'splash'
    | 'steam' | 'ash' | 'leaves' | 'bubbles' | 'fireflies' | 'snowflakes' | 'stardust' | 'tornado' | 'fountain' | 'shockwave' | 'charge' | 'comet' | 'petals';
export type BurstMotion = 'cone' | 'plume' | 'orbit' | 'converge' | 'radial' | 'funnel' | 'fall' | 'float' | 'ring' | 'fountain' | 'trail';
export interface BurstRecipe {
    motion: BurstMotion;
    count: number;
    duration: number;
    color: number;
    endColor: number;
    glow: boolean;
    size: number;
    stretch: number;
    speed: number;
    gravity: number;
    spread: number;
    curl: number;
    birthWindow: number;
    ring: number;
    /** Flat particles tumble, optionally fluttering across their trajectory. */
    tumble?: boolean;
    flutter?: number;
}
const sparks: BurstRecipe = {
    motion: 'cone', count: 42, duration: 0.65, color: 0xffe3a0, endColor: 0xe87b22, glow: true,
    size: 0.028, stretch: 5, speed: 2.5, gravity: 1.6, spread: 1.05, curl: 0, birthWindow: 0.08, ring: 0,
};
export const BURST_PRESETS: Readonly<Record<BurstPreset, Readonly<BurstRecipe>>> = {
    sparks,
    ricochet: { ...sparks, count: 18, duration: 0.35, size: 0.025, stretch: 8, speed: 3.8, spread: 0.35 },
    dust: { ...sparks, motion: 'radial', count: 24, duration: 1.2, color: 0xb49b76, endColor: 0x837260,
        glow: false, size: 0.22, stretch: 0.7, speed: 1.2, gravity: 0.15, spread: 1.8, ring: 0.35 },
    smoke: { ...sparks, motion: 'plume', count: 28, duration: 2.4, color: 0x74767c, endColor: 0x96969a,
        glow: false, size: 0.32, stretch: 1, speed: 2.1, gravity: 0, curl: 1.4, birthWindow: 0.5 },
    flame: { ...sparks, motion: 'plume', count: 32, duration: 1.3, color: 0xffde75, endColor: 0xb82b08,
        size: 0.24, stretch: 1.5, speed: 2.3, gravity: 0, curl: 2.5, birthWindow: 0.6 },
    embers: { ...sparks, motion: 'plume', count: 40, duration: 2, color: 0xffb54d, endColor: 0xb32308,
        size: 0.025, stretch: 1.8, speed: 2.7, gravity: 0, curl: 2, birthWindow: 0.45 },
    frost: { ...sparks, motion: 'radial', count: 36, duration: 1.1, color: 0xb2efff, endColor: 0x599cc6,
        glow: false, size: 0.09, stretch: 3.4, speed: 1.6, gravity: 0.65, spread: 2, ring: 0.8 },
    poison: { ...sparks, motion: 'plume', count: 24, duration: 2.1, color: 0xb9ef56, endColor: 0x4e762c,
        glow: false, size: 0.18, stretch: 1, speed: 1.2, gravity: 0, curl: 3, birthWindow: 0.4, ring: 0.25 },
    heal: { ...sparks, motion: 'orbit', count: 32, duration: 1.5, color: 0x89ffc1, endColor: 0x20b6a6,
        size: 0.055, stretch: 1, speed: 1.7, gravity: 0, curl: 4, birthWindow: 0.3, ring: 0.6 },
    magic: { ...sparks, motion: 'radial', count: 48, duration: 1.1, color: 0xcca4ff, endColor: 0x6546df,
        size: 0.045, stretch: 2.2, speed: 1.8, gravity: 0, curl: 2.5, ring: 0.8 },
    portal: { ...sparks, motion: 'converge', count: 60, duration: 1.6, color: 0xaa77ff, endColor: 0xe9c5ff,
        size: 0.04, stretch: 3, speed: 1.1, gravity: 0, curl: 7, birthWindow: 0.2, ring: 1 },
    confetti: { ...sparks, count: 80, duration: 2.2, color: 0xff668a, endColor: 0x75dbc1,
        glow: false, size: 0.07, stretch: 0.2, speed: 2.8, gravity: 3.3, spread: 1.1, birthWindow: 0.15 },
    splash: { ...sparks, count: 46, duration: 0.9, color: 0xbbefff, endColor: 0x559bc7,
        glow: false, size: 0.055, stretch: 2.1, speed: 2.1, gravity: 2.3, spread: 1.3, ring: 0.7 },
    steam: { ...sparks, motion: 'plume', count: 26, duration: 2.2, color: 0xd3e5ec, endColor: 0xb4c4ce,
        glow: false, size: 0.23, stretch: 1.2, speed: 2.6, gravity: 0, curl: 2, birthWindow: 0.45 },
    ash: { ...sparks, motion: 'fall', count: 52, duration: 3.2, color: 0x938d86, endColor: 0x56585f,
        glow: false, size: 0.035, stretch: 0.3, speed: 0.7, gravity: 0, curl: 1.5, birthWindow: 0.2, tumble: true, flutter: 0.25 },
    leaves: { ...sparks, motion: 'fall', count: 30, duration: 3, color: 0xda9237, endColor: 0x827933,
        glow: false, size: 0.15, stretch: 0.15, speed: 1, gravity: 0, curl: 2.5, birthWindow: 0.25, tumble: true, flutter: 0.55 },
    bubbles: { ...sparks, motion: 'float', count: 24, duration: 2.7, color: 0x87cfe4, endColor: 0xc1eef2,
        glow: false, size: 0.12, stretch: 1, speed: 1.7, gravity: 0, curl: 1.8, birthWindow: 0.5 },
    fireflies: { ...sparks, motion: 'float', count: 38, duration: 3, color: 0xe6ffa0, endColor: 0x7ce5a6,
        size: 0.035, stretch: 1, speed: 0.35, gravity: 0, curl: 3.5, birthWindow: 0.2, flutter: 0.4 },
    snowflakes: { ...sparks, motion: 'fall', count: 60, duration: 3.5, color: 0xe9f9ff, endColor: 0xb3dce9,
        glow: false, size: 0.06, stretch: 0.2, speed: 0.9, gravity: 0, curl: 0.8, birthWindow: 0.3, tumble: true, flutter: 0.15 },
    stardust: { ...sparks, motion: 'orbit', count: 64, duration: 2.1, color: 0xffd685, endColor: 0xc89aff,
        size: 0.03, stretch: 2.8, speed: 0.55, gravity: 0, curl: 8, birthWindow: 0.25, ring: 0.3 },
    tornado: { ...sparks, motion: 'funnel', count: 76, duration: 2.8, color: 0x98918b, endColor: 0xb4b0a7,
        glow: false, size: 0.15, stretch: 0.65, speed: 2.4, gravity: 0, curl: 13, birthWindow: 0.4, ring: 0.35 },
    fountain: { ...sparks, motion: 'fountain', count: 76, duration: 1.8, color: 0xa7e7ff, endColor: 0x428abd,
        glow: false, size: 0.05, stretch: 2.2, speed: 3.8, gravity: 4.2, spread: 0.5, birthWindow: 0.55, ring: 0.7 },
    shockwave: { ...sparks, motion: 'ring', count: 64, duration: 0.85, color: 0xc4e8ff, endColor: 0x628fb8,
        size: 0.035, stretch: 4, speed: 2.4, gravity: 0, spread: 0.1, birthWindow: 0, ring: 1.3 },
    charge: { ...sparks, motion: 'converge', count: 44, duration: 1.3, color: 0xffdd7a, endColor: 0xffffff,
        size: 0.045, stretch: 5, speed: 1.4, gravity: 0, curl: 0.6, birthWindow: 0.1, ring: 0.5 },
    comet: { ...sparks, motion: 'trail', count: 64, duration: 1.5, color: 0x8defff, endColor: 0x4854bc,
        size: 0.08, stretch: 4, speed: 3.5, gravity: 0, curl: 2, birthWindow: 0.4 },
    petals: { ...sparks, motion: 'fall', count: 42, duration: 3.1, color: 0xffb3d5, endColor: 0xd5629b,
        glow: false, size: 0.1, stretch: 0.18, speed: 0.75, gravity: 0, curl: 1.5, birthWindow: 0.35, tumble: true, flutter: 0.7 },
};
export function burstRecipe(preset: BurstPreset, overrides?: Partial<BurstRecipe>): Readonly<BurstRecipe> {
    const recipe = BURST_PRESETS[preset];
    if (!Object.prototype.hasOwnProperty.call(BURST_PRESETS, preset)) throw new Error(`Unknown burst preset: ${preset}`);
    if (!overrides) return recipe;
    const result = { ...recipe, ...overrides };
    if (!['cone', 'plume', 'orbit', 'converge', 'radial', 'funnel', 'fall', 'float', 'ring', 'fountain', 'trail'].includes(result.motion)) throw new Error(`Unknown burst motion: ${result.motion}`);
    for (const key of ['color', 'endColor'] as const) result[key] = effectNumber(result[key], key, 0, 0xffffff);
    result.count = effectNumber(result.count, 'count', 0, 256);
    result.duration = effectNumber(result.duration, 'duration', 0.01, 120);
    result.size = effectNumber(result.size, 'size', 0, 5);
    result.stretch = effectNumber(result.stretch, 'stretch', 0, 30);
    result.speed = effectNumber(result.speed, 'speed', 0, 20);
    result.gravity = effectNumber(result.gravity, 'gravity', -20, 20);
    result.spread = effectNumber(result.spread, 'spread', 0, Math.PI);
    result.curl = effectNumber(result.curl, 'curl', -50, 50);
    result.birthWindow = effectNumber(result.birthWindow, 'birthWindow', 0, 0.95);
    result.ring = effectNumber(result.ring, 'ring', 0, 2);
    if (result.flutter !== undefined) result.flutter = effectNumber(result.flutter, 'flutter', 0, 10);
    if (typeof result.glow !== 'boolean' || (result.tumble !== undefined && typeof result.tumble !== 'boolean')) throw new Error('Burst glow/tumble must be booleans');
    return Object.freeze(result);
}
