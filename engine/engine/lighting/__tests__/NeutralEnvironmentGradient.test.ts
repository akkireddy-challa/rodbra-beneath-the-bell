import * as THREE from 'three';
import { neutralEnvironmentGradient, NEUTRAL_ENV_HEIGHT, NEUTRAL_ENV_WIDTH } from 'engine/lighting/NeutralEnvironmentGradient.js';

function rowLuminance(data: Uint8Array, width: number, y: number): number {
    const i = y * width * 4;
    return (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
}

describe('neutralEnvironmentGradient', () => {
    it('is RGBA at the declared size with an opaque alpha', () => {
        const g = neutralEnvironmentGradient(null);
        expect(g.width).toBe(NEUTRAL_ENV_WIDTH);
        expect(g.height).toBe(NEUTRAL_ENV_HEIGHT);
        expect(g.data.length).toBe(NEUTRAL_ENV_WIDTH * NEUTRAL_ENV_HEIGHT * 4);
        for (let i = 3; i < g.data.length; i += 4) expect(g.data[i]).toBe(255);
    });

    it('is wide enough for PMREM to build usable mips (cube size = width / 4, needs >= 32)', () => {
        // A 4x2 source produced a 1-texel PMREM cube with maxMip 0, which sampled black.
        expect(NEUTRAL_ENV_WIDTH / 4).toBeGreaterThanOrEqual(32);
        expect(Math.log2(NEUTRAL_ENV_WIDTH) - 2).toBeGreaterThanOrEqual(4);
    });

    it('has a horizon brighter than both the zenith and the ground, and a ground darker than the sky', () => {
        const g = neutralEnvironmentGradient(null);
        const top = rowLuminance(g.data, g.width, 0);
        const horizon = rowLuminance(g.data, g.width, g.height / 2 - 1);
        const bottom = rowLuminance(g.data, g.width, g.height - 1);
        expect(horizon).toBeGreaterThan(top);
        expect(horizon).toBeGreaterThan(bottom);
        expect(bottom).toBeLessThan(top);
    });

    it('keeps the area-weighted mean at the legacy flat-grey brightness', () => {
        for (const bg of [null, new THREE.Color(0x87ceeb), new THREE.Color(0x000000), new THREE.Color(0xffffff)]) {
            const g = neutralEnvironmentGradient(bg);
            let weighted = 0;
            let weightSum = 0;
            for (let y = 0; y < g.height; y++) {
                const w = Math.sin(((y + 0.5) / g.height) * Math.PI);
                weighted += rowLuminance(g.data, g.width, y) * w;
                weightSum += w;
            }
            expect(weighted / weightSum).toBeCloseTo(0.36, 1);
        }
    });

    it('borrows only the hue of a colour background for the sky', () => {
        const warm = neutralEnvironmentGradient(new THREE.Color(1, 0.5, 0.2));
        const cool = neutralEnvironmentGradient(new THREE.Color(0.2, 0.5, 1));
        // Zenith row: warm sky is redder than blue, cool sky the reverse.
        expect(warm.data[0]!).toBeGreaterThan(warm.data[2]!);
        expect(cool.data[2]!).toBeGreaterThan(cool.data[0]!);
        // Same brightness regardless of the background's own intensity.
        expect(rowLuminance(warm.data, warm.width, 0)).toBeCloseTo(rowLuminance(cool.data, cool.width, 0), 1);
    });

    it('falls back to the default sky for a black background', () => {
        const black = neutralEnvironmentGradient(new THREE.Color(0, 0, 0));
        const none = neutralEnvironmentGradient(null);
        expect(Array.from(black.data.subarray(0, 4))).toEqual(Array.from(none.data.subarray(0, 4)));
    });
});
