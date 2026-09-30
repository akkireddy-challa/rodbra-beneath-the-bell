import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { getVisualEffects, type BurstSpawnOptions, type ExplosionSpawnOptions, type EffectHandle } from 'engine/effects/index.js';
import { runeHalo } from './custom-visual-effect.js';

/** Game-local art direction. Editing this does not change other uses of "frost". */
export const ICE_NOVA = {
    radius: 2.4, duration: 1.6, amount: 0.9,
    recipe: { motion: 'disk', fire: 0, smoke: 8, sparks: 30, debris: 24,
        smokeColor: 0xbce8ef, debrisColor: 0x90cfe8, ringColor: 0xf1ffff, debrisStretch: 3.8 },
} satisfies ExplosionSpawnOptions;

export const COOLING_MOTES = {
    radius: 1.4,
    recipe: { motion: 'float', color: 0xd9ffff, endColor: 0x6285bb, count: 20,
        duration: 2, speed: 0.5, curl: 2, size: 0.025, flutter: 0.15, ring: 0 },
} satisfies BurstSpawnOptions;

/** Compose recognizable layers, with one cancellation point for the owning ability. */
export function castIceNova(engine: EngineLike, position: THREE.Vector3, normal: THREE.Vector3, seed: number): () => void {
    const effects = getVisualEffects(engine);
    const layers: EffectHandle[] = [
        effects.explosion('frost', position, { ...ICE_NOVA, seed }),
        effects.burst('fireflies', position, { ...COOLING_MOTES, seed: seed + 1, direction: normal }),
        effects.custom(runeHalo, position, { seed: seed + 2, direction: normal, color: 0xafffff, turns: -0.4 }),
    ];
    // Each layer has its own authored duration. Do not set timers to clean it up.
    return () => { for (const layer of layers) layer.stop(); };
}

export function attachCustomAura(engine: EngineLike, character: THREE.Object3D): () => void {
    const aura = getVisualEffects(engine).custom(runeHalo, character, { loop: true, duration: 2, rise: 0.2 });
    // Engine handles pause and level unload. Stop when this ability/entity ends.
    return () => aura.stop();
}
