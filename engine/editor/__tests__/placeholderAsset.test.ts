import { isPlaceholderAsset } from 'editor/placeholderAsset.js';

/**
 * The regression this pins: the inspector used to require a `description` before it
 * would offer HQ regeneration, and the forger only set `placeholder` when the designer
 * had written one — so 283 of 389 forge-baked assets across the test games (28 of 35
 * games entirely) had no upgrade path at all. A described-ness test must never gate the
 * offer; it may only distinguish an ALREADY-REGENERATED asset from a legacy stand-in.
 */

const FORGE_BAKED = {
    fitBox: { x: 10, z: 20, height: 25 },
    sourceGlbUrl: 'https://example.test/VillageChurch-abc.glb',
};

describe('isPlaceholderAsset', () => {
    it('offers regeneration for a current forger bake, described or not', () => {
        expect(isPlaceholderAsset({ ...FORGE_BAKED, placeholder: true, description: 'a stone church' })).toBe(true);
        expect(isPlaceholderAsset({ ...FORGE_BAKED, placeholder: true })).toBe(true);
    });

    it('offers regeneration for a legacy bake with no description (the reported bug)', () => {
        // Exactly the VillageChurch entry from the report: flagged false by the old
        // description gate, and undescribed because the designer skipped it.
        expect(isPlaceholderAsset({ ...FORGE_BAKED, placeholder: false })).toBe(true);
        // Pre-flag bakes carry no flag at all.
        expect(isPlaceholderAsset({ ...FORGE_BAKED })).toBe(true);
        // Whitespace is not a description.
        expect(isPlaceholderAsset({ ...FORGE_BAKED, placeholder: false, description: '   ' })).toBe(true);
    });

    it('stops offering once an asset has been regenerated', () => {
        // The HQ job writes placeholder:false AND carries the prompt across as the
        // description — that pairing is what marks it done.
        expect(isPlaceholderAsset({ ...FORGE_BAKED, placeholder: false, description: 'a stone church' })).toBe(false);
    });

    it('ignores assets that never came from the forger', () => {
        expect(isPlaceholderAsset({})).toBe(false);
        expect(isPlaceholderAsset({ description: 'a hand-made sword' })).toBe(false);
        // A user-uploaded GLB has a source but no allocated box.
        expect(isPlaceholderAsset({ sourceGlbUrl: 'https://example.test/sword.glb' })).toBe(false);
        // A forger LEVEL asset has a box but no GLB source of its own.
        expect(isPlaceholderAsset({ fitBox: { x: 1, z: 1, height: 1 } })).toBe(false);
    });
});
