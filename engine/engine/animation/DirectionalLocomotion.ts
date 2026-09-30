/** Gameplay local +Z is forward, +X is LEFT. Order follows positive yaw. */
export { LOCOMOTION_DIRECTIONS, capturedDirectionId } from 'engine/AnimationAssets.js';
export type DirectionalLocomotionStyle = 'neutral' | 'rifle';
export const DIRECTIONAL_BLEND_IDS = { neutral: 'mCapturedJogBlend01', rifle: 'mCapturedRifleBlend01' } as const;

/** Two neighboring samples, continuous through both forward and +/-180°. */
export function directionalWeights(angle: number, result: number[]): void {
    result.fill(0);
    const sector = ((angle / (Math.PI / 4)) % 8 + 8) % 8;
    const lower = Math.floor(sector), fraction = sector - lower;
    result[lower] = 1 - fraction;
    result[(lower + 1) % 8] = fraction;
}
