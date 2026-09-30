import { resolveDestructionMode } from 'engine/PristineDestructible.js';

const bbox = (w: number, h: number, d: number) => ({
    minX: 0, minY: 0, minZ: 0, maxX: w, maxY: h, maxZ: d,
});

// Real assets from the desert racing game / village level.
const CACTUS = bbox(4, 4.4, 2.4);
const SALOON = bbox(14, 9, 12);

describe('resolveDestructionMode', () => {
    it('shatters prop-sized assets whole', () => {
        expect(resolveDestructionMode(undefined, CACTUS)).toBe('shatter');
        expect(resolveDestructionMode({}, bbox(0.6, 1.1, 0.6))).toBe('shatter');
    });

    it('breaks building-sized assets partially', () => {
        expect(resolveDestructionMode(undefined, SALOON)).toBe('partial');
        // The threshold applies to the LARGEST dimension, any axis.
        expect(resolveDestructionMode(undefined, bbox(1, 20, 1))).toBe('partial');
    });

    it('honours an explicit authored mode over size', () => {
        expect(resolveDestructionMode({ destructionMode: 'partial' }, CACTUS)).toBe('partial');
        expect(resolveDestructionMode({ destructionMode: 'shatter' }, SALOON)).toBe('shatter');
    });

    it('accounts for per-instance scale', () => {
        // A prop scaled up past the building threshold breaks partially…
        expect(resolveDestructionMode(undefined, CACTUS, { width: 4, height: 4, depth: 4 })).toBe('partial');
        // …and a scaled-down building shatters.
        expect(resolveDestructionMode(undefined, SALOON, { width: 0.2, height: 0.2, depth: 0.2 })).toBe('shatter');
    });

    it('falls back to the size default on an unknown authored value', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveDestructionMode({ destructionMode: 'explode' }, CACTUS)).toBe('shatter');
        expect(resolveDestructionMode({ destructionMode: 'explode' }, SALOON)).toBe('partial');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('shatters when the asset has no bounding box', () => {
        expect(resolveDestructionMode(undefined, null)).toBe('shatter');
    });
});
