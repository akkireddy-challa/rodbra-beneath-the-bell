/** @jest-environment jsdom */
import type * as THREE from 'three';
import { probeTier, runGpuProbe } from 'engine/quality/DeviceGpuProbe.js';
import { DEVICE_QUALITY_TIERS, type DeviceQualityTier } from 'engine/DeviceQuality.js';

describe('load-time GPU probe decisions', () => {
    it.each([0, 4, 8.99, Number.NaN, Number.POSITIVE_INFINITY])('keeps the current tier at %s ms', (ms) => {
        for (const tier of DEVICE_QUALITY_TIERS) expect(probeTier(ms, tier)).toBe(tier);
    });

    it.each([9, 10, 14, 24, 100])('makes at most one correction at %s ms, without entering Minimal', (ms) => {
        const expected: Record<DeviceQualityTier, DeviceQualityTier> = {
            ultra: 'high', high: 'medium', medium: 'low', low: 'low', minimal: 'minimal',
        };
        for (const tier of DEVICE_QUALITY_TIERS) expect(probeTier(ms, tier)).toBe(expected[tier]);
    });
});

describe('GPU measurement', () => {
    beforeEach(() => {
        window.history.replaceState({}, '', '/');
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => { jest.restoreAllMocks(); });

    it.each(['webgpu', 'webgl'] as const)('warms four frames and times eight completed GPU frames on %s', async (backend) => {
        const events: string[] = [];
        const wait = jest.fn(() => { events.push('gpu'); });
        const renderer = (backend === 'webgpu'
            ? { backend: { device: { queue: { onSubmittedWorkDone: async () => wait() } } } }
            : { getContext: () => ({ finish: wait }) }) as unknown as THREE.WebGLRenderer;
        let time = 100;
        const result = await runGpuProbe(renderer, () => events.push('draw'), 'ultra', () => {
            events.push('clock');
            const previous = time;
            time += 80;
            return previous;
        });
        expect(events).toEqual([
            ...Array<string>(4).fill('draw'), 'gpu', 'clock',
            ...Array<string>(8).fill('draw'), 'gpu', 'clock',
        ]);
        expect(result).toEqual({ msPerFrame: 10, tier: 'high' });
    });

    it('skips all GPU work with tierprobe=0', async () => {
        window.history.replaceState({}, '', '?tierprobe=0');
        const draw = jest.fn();
        expect(await runGpuProbe({} as THREE.WebGLRenderer, draw, 'ultra')).toBeNull();
        expect(draw).not.toHaveBeenCalled();
    });

    it('keeps loading when a draw throws', async () => {
        expect(await runGpuProbe({} as THREE.WebGLRenderer, () => {
            throw new Error('lost renderer');
        }, 'ultra')).toBeNull();
    });

    it.each([0, -10, Number.NaN, Number.POSITIVE_INFINITY])('rejects an unusable elapsed time of %s', async (elapsed) => {
        const now = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(elapsed);
        expect(await runGpuProbe({} as THREE.WebGLRenderer, () => {}, 'ultra', now)).toBeNull();
    });
});
