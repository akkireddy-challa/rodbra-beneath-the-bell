// engine/config.js uses import.meta.env (Vite-only) — stub it out for Jest.
jest.mock('engine/config.js', () => ({
    AI_CHAT_URL: 'http://localhost:4111',
}));

import {
    resolveOutputSize,
    DEFAULT_SCREENSHOT_UPLOAD_OPTIONS,
    type ScreenshotUploadOptions,
} from 'engine/ScreenshotService.js';

function opts(overrides: Partial<ScreenshotUploadOptions> = {}): ScreenshotUploadOptions {
    return { ...DEFAULT_SCREENSHOT_UPLOAD_OPTIONS, ...overrides };
}

describe('resolveOutputSize', () => {
    const canvas = { x: 1920, y: 1080 };

    it('returns canvas dims when camera is null (live-canvas path)', () => {
        expect(resolveOutputSize(opts(), canvas, null)).toEqual({ width: 1920, height: 1080 });
    });

    it('honors explicit width and height regardless of preset', () => {
        const out = resolveOutputSize(
            opts({
                width: 800,
                height: 600,
                camera: { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null },
            }),
            canvas,
            1, // square world
        );
        expect(out).toEqual({ width: 800, height: 600 });
    });

    it('auto-matches world aspect for fitLevel topdown when both dims are null (square world)', () => {
        const out = resolveOutputSize(
            opts({ camera: { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null } }),
            canvas,
            1,
        );
        // cap = 1920, worldAspect = 1 → 1920 × 1920
        expect(out).toEqual({ width: 1920, height: 1920 });
    });

    it('auto-matches world aspect for fitLevel topdown (wide world)', () => {
        const out = resolveOutputSize(
            opts({ camera: { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null } }),
            canvas,
            2, // sizeX:sizeZ = 2:1
        );
        // cap = 1920, worldAspect = 2 → 1920 × 960
        expect(out).toEqual({ width: 1920, height: 960 });
    });

    it('auto-matches world aspect for fitLevel topdown (tall world)', () => {
        const out = resolveOutputSize(
            opts({ camera: { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null } }),
            canvas,
            0.5, // sizeX:sizeZ = 1:2
        );
        // cap = 1920, worldAspect = 0.5 → 960 × 1920
        expect(out).toEqual({ width: 960, height: 1920 });
    });

    it('also auto-matches for fitLevel isometric', () => {
        const out = resolveOutputSize(
            opts({ camera: { kind: 'isometric', fitLevel: true, distance: null, azimuth: 0, margin: null } }),
            canvas,
            1,
        );
        expect(out).toEqual({ width: 1920, height: 1920 });
    });

    it('does NOT auto-match for orbit (no clear world aspect to use)', () => {
        const out = resolveOutputSize(
            opts({
                camera: { kind: 'orbit', target: null, distance: 5, azimuth: 0, pitch: 0 },
            }),
            canvas,
            1, // even with a world aspect available
        );
        expect(out).toEqual({ width: 1920, height: 1080 });
    });

    it('does NOT auto-match for custom camera', () => {
        // Using a minimal stub for THREE.Camera; we never call into it.
        const fakeCam = {} as unknown as import('three').Camera;
        const out = resolveOutputSize(
            opts({ camera: { kind: 'custom', camera: fakeCam } }),
            canvas,
            1,
        );
        expect(out).toEqual({ width: 1920, height: 1080 });
    });

    it('falls back to canvas dims when fitLevel is true but worldAspect is null', () => {
        const out = resolveOutputSize(
            opts({ camera: { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null } }),
            canvas,
            null,
        );
        expect(out).toEqual({ width: 1920, height: 1080 });
    });

    it('partial override (only width set): treats as explicit-not-auto; height falls back to canvas', () => {
        const out = resolveOutputSize(
            opts({
                width: 500,
                camera: { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null },
            }),
            canvas,
            1,
        );
        expect(out).toEqual({ width: 500, height: 1080 });
    });
});
