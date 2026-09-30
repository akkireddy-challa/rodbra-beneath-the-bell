import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { getVisualEffects, type EmitterHandle, type EffectHandle } from 'engine/effects/index.js';
import { AttackVFX, IMPACT_EFFECT_PRESETS } from 'engine/AttackVFX.js';
import type { ExplosionConfig } from 'engine/Projectile.js';
import type { ExplosionEvent } from 'engine/networking/index.js';

export function showEffects(engine: EngineLike): { fire: EmitterHandle; bolt: EffectHandle } {
    const effects = getVisualEffects(engine);
    const origin = new THREE.Vector3(0, 0.1, 0);
    effects.explosion('fragmentation', origin, { radius: 3, amount: 1.2, variance: 0.8, seed: 42 });
    effects.burst('heal', origin, { radius: 1.5 });
    const bolt = effects.lightning([new THREE.Vector3(0, 5, 0), origin], { preset: 'tesla', seed: 0 });
    effects.beam(origin, new THREE.Vector3(5, 1, 0), 'energy-beam');
    effects.beam(origin, new THREE.Vector3(5, 1, 0), 'railgun');
    effects.beam(origin, new THREE.Vector3(0, 4, 0), 'tractor-beam');
    effects.explosion('implosion', origin, { radius: 2, seed: 17 });
    effects.burst('tornado', origin, { radius: 1.2, amount: 0.7 });
    const fire = effects.emit('flame', origin, { interval: 0.2, burst: { radius: 0.6, amount: 0.5 } });
    fire.moveTo(new THREE.Vector3(1, 0.1, 0));
    // GameEngine owns all of the above playback and teardown.
    return { fire, bolt };
}

export function makeIceImpacts(scene: THREE.Scene): AttackVFX {
    // This pre-existing standalone API still needs its owner's update/dispose calls.
    return new AttackVFX(scene, { ...IMPACT_EFFECT_PRESETS.ice, seed: 42 });
}

export function showTrackedEffects(engine: EngineLike, muzzle: THREE.Object3D, projectile: THREE.Object3D, character: THREE.Object3D): () => void {
    const effects = getVisualEffects(engine);
    const fire = effects.fire('flamethrower', muzzle, { direction: new THREE.Vector3(0, 0, 1), amount: 1.2 });
    fire.setDirection(new THREE.Vector3(1, 0, 0));
    const beam = effects.continuousBeam(muzzle, character, 'healing-link');
    beam.setEndpoints(muzzle, projectile);
    const shield = effects.shield('hex-shield', character, { radius: 1.5 });
    shield.hit(new THREE.Vector3(0, 1, 1.5), new THREE.Vector3(0, 0, 1));
    const trail = effects.trail('missile', projectile, { width: 0.12, lifetime: 0.5, teleportDistance: 8 });
    const mark = effects.surface('scorch', new THREE.Vector3(), { direction: new THREE.Vector3(0, 1, 0), duration: 30 });
    const transition = effects.transition('teleport-in', character, { duration: 1.1 });
    // Normal gameplay owns these visual triggers; cancellation also restores target materials.
    return () => { fire.stop(); beam.stop(); shield.stop(); trail.stop(); mark.stop(); transition.stop(); };
}

export const plasmaExplosion: ExplosionConfig = {
    enabled: true, radius: 3, duration: 1.1, damage: 30, damageRadius: 4,
    preset: 'plasma', amount: 1.5, variance: 0.6, seed: 17,
};
export const explosionEvent: ExplosionEvent = { ...plasmaExplosion, position: { x: 0, y: 0, z: 0 } };
