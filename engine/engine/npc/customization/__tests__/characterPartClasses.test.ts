/** @jest-environment jsdom */
import * as THREE from 'three';
import { CLASSED_PART_CLASS } from 'engine/ClassedPartMaterial.js';
import { clearMaterialQuality, setMaterialQuality } from 'engine/MaterialQuality.js';
import { VOXEL_MATERIAL_CLASSES } from 'engine/VoxelMaterialClass.js';
import {
    blockPartCacheStats,
    CHARACTER_PART_CLASS,
    classedPartStandardMaterial,
    clearBlockPartCaches,
    convertBlockPartMaterial,
    getSharedClassedMaterial,
    getSharedLambertMaterial,
} from 'engine/npc/customization/blockPartCaches.js';

/**
 * Material classes for block-character parts: NpcCustomization tags what a
 * part IS at construction (a gold buckle, a glass lens) and the
 * block-character conversion routes tagged parts to the shared classed cache
 * instead of the Lambert cache. The contracts that matter: untagged parts take
 * the EXACT same Lambert path as before (the deliberate matte default),
 * classes climb the quality ladder and collapse back to it at low, shared
 * instances stay cache-owned, and authored emissive/transparency survive.
 */
afterEach(() => {
    clearBlockPartCaches();
    clearMaterialQuality();
});

describe('getSharedClassedMaterial', () => {
    it('rides the quality ladder — gold is Physical at high, Phong at medium, Lambert at low', () => {
        const high = getSharedClassedMaterial('gold', 0xffd700, {}, 'high');
        expect(high).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect((high as THREE.MeshPhysicalMaterial).metalness).toBe(VOXEL_MATERIAL_CLASSES.gold.metalness);

        expect(getSharedClassedMaterial('gold', 0xffd700, {}, 'medium')).toBeInstanceOf(THREE.MeshPhongMaterial);
        expect(getSharedClassedMaterial('gold', 0xffd700, {}, 'low')).toBeInstanceOf(THREE.MeshLambertMaterial);
    });

    it('shares one instance per (class, colour, quality) and flags it cache-owned', () => {
        const a = getSharedClassedMaterial('metal', 0xcccccc, {}, 'high');
        const b = getSharedClassedMaterial('metal', 0xcccccc, {}, 'high');
        expect(a).toBe(b);
        expect(a.userData.__sharedLodCache).toBe(true);

        // Quality is in the key — a mid-session ?matq= change can never alias tiers.
        expect(getSharedClassedMaterial('metal', 0xcccccc, {}, 'low')).not.toBe(a);
        expect(blockPartCacheStats().classedMaterials).toBe(2);
    });

    it('applies authored emissive and transparency on top of the class', () => {
        // The sparkles: explicit emissive at authored intensity, gem-classed.
        const gem = getSharedClassedMaterial('gem', 0xff66cc, { emissive: 0xff66cc, emissiveIntensity: 0.3 }, 'high');
        expect((gem as THREE.MeshPhysicalMaterial).emissive.getHex()).toBe(0xff66cc);
        expect(gem.emissiveIntensity).toBeCloseTo(0.3, 5);

        // The lens: transparency preserved.
        const lens = getSharedClassedMaterial('glass', 0x88ccff, { transparent: true, opacity: 0.3 }, 'high');
        expect(lens.transparent).toBe(true);
        expect(lens.opacity).toBeCloseTo(0.3, 5);
    });

    it('unknown class names degrade to matte Lambert instead of throwing', () => {
        expect(getSharedClassedMaterial('adamantium', 0x123456, {}, 'high')).toBeInstanceOf(THREE.MeshLambertMaterial);
    });
});

describe('convertBlockPartMaterial (the block-character conversion)', () => {
    it('untagged Standard parts take the exact Lambert path they always did', () => {
        const standard = new THREE.MeshStandardMaterial({ color: 0x3f7fc2, roughness: 0.6 });
        const converted = convertBlockPartMaterial(standard, false);
        expect(converted).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(converted).toBe(getSharedLambertMaterial(0x3f7fc2, {}));
        expect(converted.userData[CLASSED_PART_CLASS]).toBeUndefined();
    });

    it('tagged parts become the shared classed material, and the transient Standard is disposed', () => {
        setMaterialQuality('high');
        const buckle = classedPartStandardMaterial('gold', { color: 0xffd700, metalness: 0.8 });
        expect(buckle).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(buckle.userData[CHARACTER_PART_CLASS]).toBe('gold');
        const dispose = jest.spyOn(buckle, 'dispose');

        const converted = convertBlockPartMaterial(buckle, false);
        expect(converted).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect(converted.userData[CLASSED_PART_CLASS]).toBe('gold');
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("at low quality every part — tagged or not — renders Lambert: today's look is the hard opt-out", () => {
        setMaterialQuality('low');
        for (const mat of [
            classedPartStandardMaterial('gold', { color: 0xffd700 }),
            classedPartStandardMaterial('glass', { color: 0x88ccff, transparent: true, opacity: 0.3 }),
            new THREE.MeshStandardMaterial({ color: 0x3f7fc2 }),
        ]) {
            expect(convertBlockPartMaterial(mat, false)).toBeInstanceOf(THREE.MeshLambertMaterial);
        }
    });

    it('the player path clones and strips the cache flag so tinting cannot poison the cache', () => {
        setMaterialQuality('high');
        const shared = convertBlockPartMaterial(classedPartStandardMaterial('gold', { color: 0xffd700 }), false);
        const clone = convertBlockPartMaterial(classedPartStandardMaterial('gold', { color: 0xffd700 }), true);
        expect(clone).not.toBe(shared);
        expect(clone.userData.__sharedLodCache).toBeUndefined();
        expect(shared.userData.__sharedLodCache).toBe(true);
        // The clone keeps its class tag — DamageFlash clones round-trip it too.
        expect(clone.userData[CLASSED_PART_CLASS]).toBe('gold');
    });

    it('leaves non-Standard and already-classed materials exactly alone', () => {
        const basic = new THREE.MeshBasicMaterial({ color: 0xffffff });
        expect(convertBlockPartMaterial(basic, false)).toBe(basic);

        // MeshPhysicalMaterial EXTENDS MeshStandardMaterial: a second pass over
        // a converted tree must not flatten factory output back to Lambert.
        setMaterialQuality('high');
        const classed = convertBlockPartMaterial(classedPartStandardMaterial('gold', { color: 0xffd700 }), false);
        expect(convertBlockPartMaterial(classed, false)).toBe(classed);
    });
});

describe('teardown', () => {
    it('clearBlockPartCaches disposes classed materials too', () => {
        const gold = getSharedClassedMaterial('gold', 0xffd700, {}, 'high');
        const dispose = jest.spyOn(gold, 'dispose');
        clearBlockPartCaches();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(blockPartCacheStats().classedMaterials).toBe(0);
    });
});
