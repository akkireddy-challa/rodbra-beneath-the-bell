import * as THREE from 'three';

export type VFXQuality = 'low' | 'medium' | 'high';
export type VFXStyle = 'voxel' | 'low-poly';
export const VFX_DENSITY: Readonly<Record<VFXQuality, number>> = { low: 0.4, medium: 0.7, high: 1 };

/** Seed zero is valid. Never consumes the game's random stream. */
export function effectRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = Math.imul(state, 1664525) + 1013904223 | 0;
        return (state >>> 0) / 4294967296;
    };
}

export function effectNumber(value: number, name: string, min: number, max: number): number {
    if (!Number.isFinite(value)) throw new Error(`VFX ${name} must be finite`);
    return THREE.MathUtils.clamp(value, min, max);
}

export function effectPosition(value: THREE.Vector3): void {
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) throw new Error('VFX position must be finite');
}

/** Only the live prefix is drawn; retain capacity without uploading unused slots each frame. */
export function updateEffectAttribute(attribute: THREE.BufferAttribute, count: number): void {
    attribute.clearUpdateRanges();
    if (count === 0) return;
    attribute.addUpdateRange(0, count * attribute.itemSize);
    attribute.needsUpdate = true;
}

export function effectDensity(quality: VFXQuality): number {
    const density = VFX_DENSITY[quality];
    if (!Object.prototype.hasOwnProperty.call(VFX_DENSITY, quality)) throw new Error(`Unknown VFX quality: ${quality}`);
    return density;
}

export const EFFECT_UP = new THREE.Vector3(0, 1, 0);

/** Fully volumetric particles: no hardware point-size or camera-facing shader dependency. */
export function effectGeometry(style: VFXStyle): THREE.BufferGeometry {
    return style === 'voxel' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.IcosahedronGeometry(0.65, 0);
}
