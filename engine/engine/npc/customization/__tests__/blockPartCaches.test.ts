import { getSharedBoxGeometry, getSharedLambertMaterial, clearBlockPartCaches, blockPartCacheStats } from 'engine/npc/customization/blockPartCaches.js';

describe('blockPartCaches', () => {
    afterEach(() => clearBlockPartCaches());

    test('same dims return the same geometry instance', () => {
        const a = getSharedBoxGeometry(0.4, 0.5, 0.25);
        const b = getSharedBoxGeometry(0.4, 0.5, 0.25);
        expect(a).toBe(b);
        expect(getSharedBoxGeometry(0.4, 0.5, 0.26)).not.toBe(a);
    });

    test('same color+opts return the same material; flagged as shared', () => {
        const a = getSharedLambertMaterial(0x3a6ea5, { emissive: 0x000000 });
        const b = getSharedLambertMaterial(0x3a6ea5, { emissive: 0x000000 });
        expect(a).toBe(b);
        expect(a.userData.__sharedLodCache).toBe(true);
    });

    test('clear resets and disposes', () => {
        getSharedBoxGeometry(1, 1, 1);
        getSharedLambertMaterial(0xff0000, {});
        clearBlockPartCaches();
        expect(blockPartCacheStats().geometries).toBe(0);
        expect(blockPartCacheStats().materials).toBe(0);
    });
});
