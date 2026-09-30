import { resolveBakedSpawnPosition, BAKED_ROOFTOP_CLEARANCE_M } from 'engine/bakedSpawnResolver.js';

/**
 * Baked v2-octree level spawn detection. On a baked map the ground registers on
 * CollisionGroup.TERRAIN and placed buildings/props stay on ENVIRONMENT, so a
 * TERRAIN-only raycast yields the bare street while getWorldHeightAt yields the
 * full surface. resolveBakedSpawnPosition turns that pair into a spawn decision:
 * a position on walkable ground, or null over a rooftop.
 */
describe('resolveBakedSpawnPosition (baked level spawn detection)', () => {
    const DROP_Y = 42; // stand-in for "just above the map's top bound"

    it('returns a ground position on an open street (surface == terrain)', () => {
        // Bare street: full surface and terrain-only ray hit the same baked ground.
        const pos = resolveBakedSpawnPosition(10, 20, 2, 2, DROP_Y);
        expect(pos).not.toBeNull();
        expect(pos!.x).toBe(10);
        expect(pos!.z).toBe(20);
        expect(pos!.y).toBeCloseTo(2, 5); // sits on the street, not the drop fallback
    });

    it('rejects a building/prop top (full surface well above bare terrain) → null', () => {
        // Over a building: getWorldHeightAt returns the roof (14), TERRAIN-only ray
        // passes through the ENVIRONMENT building and hits the street (2) below.
        const pos = resolveBakedSpawnPosition(10, 20, 14, 2, DROP_Y);
        expect(pos).toBeNull();
    });

    it('accepts ground clutter below the rooftop clearance (kerb/step)', () => {
        // A small lip under the clearance is still a walkable street, not a rooftop.
        const surfaceY = 2 + (BAKED_ROOFTOP_CLEARANCE_M - 0.1);
        const pos = resolveBakedSpawnPosition(10, 20, surfaceY, 2, DROP_Y);
        expect(pos).not.toBeNull();
        expect(pos!.y).toBeCloseTo(surfaceY, 5);
    });

    it('rejects exactly past the clearance threshold', () => {
        const surfaceY = 2 + BAKED_ROOFTOP_CLEARANCE_M + 0.01;
        expect(resolveBakedSpawnPosition(10, 20, surfaceY, 2, DROP_Y)).toBeNull();
    });

    it('does not reject when the terrain ray missed (cannot tell — fall through)', () => {
        // No TERRAIN hit (colliders not yet enabled): never reject; use the surface,
        // or the drop fallback when nothing was hit at all.
        const onSurface = resolveBakedSpawnPosition(10, 20, 7, null, DROP_Y);
        expect(onSurface).not.toBeNull();
        expect(onSurface!.y).toBeCloseTo(7, 5);

        const nothingHit = resolveBakedSpawnPosition(10, 20, 0, null, DROP_Y);
        expect(nothingHit).not.toBeNull();
        expect(nothingHit!.y).toBe(DROP_Y); // dropped from above the top bound
    });

    it('honours the requested x/z verbatim (no snapping/collapse)', () => {
        const pos = resolveBakedSpawnPosition(123.456, -78.9, 5, 5, DROP_Y);
        expect(pos).not.toBeNull();
        expect(pos!.x).toBe(123.456);
        expect(pos!.z).toBe(-78.9);
    });
});
