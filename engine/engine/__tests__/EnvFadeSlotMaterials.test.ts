/**
 * Placed instances of a SLOTTED voxel asset must keep their colour and glow.
 *
 * Environment objects render through `createFadedEnvMaterial`, which rebuilds
 * each template material as a distance-fading equivalent. Two things used to go
 * wrong for an asset with material slots, and together they made a placed
 * instance draw flat white and unlit while the same asset looked correct in the
 * voxel editor:
 *
 *  1. A slotted mesh's `material` is an ARRAY (base + one per slot) over
 *     matching geometry groups. It was cast to a single `THREE.Material`, so
 *     every property read off it came back undefined — no map, no vertex
 *     colours, no tint.
 *  2. Slot materials carry their emissive in a uniform (WebGPU) or an
 *     `onBeforeCompile` (WebGL) and are NOT tagged with the base emissive flag,
 *     so even a correctly-cloned copy dropped the light.
 */

import * as THREE from 'three';
import { createFadedEnvMaterial } from 'engine/EnvDistanceFade.js';
import {
    createVoxelSlotMaterial,
    slotInfoFromMaterial,
    VOXEL_SLOT_FLAG,
} from 'engine/VoxelSlotMaterial.js';
import type { VoxelMaterialParams } from 'engine/VoxelEmissiveMaterial.js';
import { VOXEL_MATERIAL_CLASSES } from 'engine/VoxelMaterialClass.js';

const PARAMS: VoxelMaterialParams = {
    map: null,
    vertexColors: true,
    flatShading: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
};

describe('slot materials describe themselves', () => {
    it('reports its slot name and current level', () => {
        const handle = createVoxelSlotMaterial(PARAMS, { name: 'beacon', emissive: 255 }, false, 'high');
        const info = slotInfoFromMaterial(handle.material);
        expect(info).not.toBeNull();
        expect(info!.name).toBe('beacon');
        expect(info!.level).toBeCloseTo(1, 5);
    });

    it('keeps the reported level in step with setEmissive', () => {
        const handle = createVoxelSlotMaterial(PARAMS, { name: 'beacon', emissive: 255 }, false, 'high');
        handle.setEmissive(0.25);
        expect(slotInfoFromMaterial(handle.material)!.level).toBeCloseTo(0.25, 5);
    });

    it('reports null for an ordinary material', () => {
        expect(slotInfoFromMaterial(new THREE.MeshLambertMaterial())).toBeNull();
    });
});

describe('createFadedEnvMaterial preserves material slots', () => {
    it('rebuilds a slot material as a slot material at the same level', () => {
        const handle = createVoxelSlotMaterial(PARAMS, { name: 'sign', emissive: 128 }, false, 'high');
        const faded = createFadedEnvMaterial(handle.material);

        const info = slotInfoFromMaterial(faded);
        expect(info).not.toBeNull();
        expect(info!.name).toBe('sign');
        expect(info!.level).toBeCloseTo(128 / 255, 3);
    });

    it('keeps vertex colours on the faded copy — the flat-white symptom', () => {
        const handle = createVoxelSlotMaterial(PARAMS, { name: 'sign', emissive: 255 }, false, 'high');
        expect(createFadedEnvMaterial(handle.material).vertexColors).toBe(true);
    });

    it('gives each slot its own program cache key', () => {
        const a = createFadedEnvMaterial(createVoxelSlotMaterial(PARAMS, { name: 'a', emissive: 255 }, false, 'high').material);
        const b = createFadedEnvMaterial(createVoxelSlotMaterial(PARAMS, { name: 'b', emissive: 255 }, false, 'high').material);
        const plain = createFadedEnvMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }));
        const key = (m: THREE.Material): string => m.customProgramCacheKey?.() ?? '';
        expect(key(a)).not.toBe(key(b));
        expect(key(a)).not.toBe(key(plain));
    });

    it('leaves a non-slot material on the ordinary path', () => {
        const faded = createFadedEnvMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }));
        expect(faded.userData?.[VOXEL_SLOT_FLAG]).toBeUndefined();
        expect(faded.vertexColors).toBe(true);
    });
});

/**
 * The MATERIAL CLASS has to survive the same rebuild, for the same reason the
 * level does: this path sees only the material, so anything missing from a slot
 * material's self-description is silently lost on every PLACED instance. Without
 * it a gold asset shines in the Assets tab and comes back matte the moment it is
 * placed in the world — the exact shape of the bug that lost the glow before the
 * level was recorded in `userData`.
 */
describe('createFadedEnvMaterial preserves the material class', () => {
    const slotMaterial = (
        name: string,
        materialClass: string | undefined,
        smoothed = true,
    ): THREE.Material => createVoxelSlotMaterial(
        PARAMS,
        { name, emissive: 0, ...(materialClass === undefined ? {} : { materialClass }) },
        smoothed,
        // 'high': these tests pin the CLASS round-trip; the quality clamp has its
        // own coverage in MaterialQuality.test.ts.
        'high',
    ).material;

    it('rebuilds a gold slot as gold, not as matte', () => {
        const faded = createFadedEnvMaterial(slotMaterial('trim', 'gold'));
        expect(slotInfoFromMaterial(faded)!.materialClass).toBe('gold');
        expect(faded).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect((faded as THREE.MeshPhysicalMaterial).metalness)
            .toBe(VOXEL_MATERIAL_CLASSES.gold.metalness);
    });

    it('rebuilds a direct-tier slot on the direct tier', () => {
        const faded = createFadedEnvMaterial(slotMaterial('grip', 'leather'));
        expect(faded).toBeInstanceOf(THREE.MeshPhongMaterial);
    });

    it('carries the smoothed flag through, so the fallback resolves the same way', () => {
        // An unsmoothed chrome slot renders as its fallback. If the flag were
        // lost, the faded copy would resolve chrome differently from the original
        // and a placed instance would shade unlike the unplaced one.
        const unsmoothed = createFadedEnvMaterial(slotMaterial('mirror', 'chrome', false));
        const smoothed = createFadedEnvMaterial(slotMaterial('mirror', 'chrome', true));
        expect(slotInfoFromMaterial(unsmoothed)!.smoothed).toBe(false);
        expect(slotInfoFromMaterial(smoothed)!.smoothed).toBe(true);
        expect(unsmoothed).toBeInstanceOf(THREE.MeshPhongMaterial);      // → plastic
        expect(smoothed).toBeInstanceOf(THREE.MeshPhysicalMaterial);     // → chrome
    });

    it('reports matte for a class-free slot', () => {
        expect(slotInfoFromMaterial(slotMaterial('plain', undefined))!.materialClass).toBe('matte');
        expect(createFadedEnvMaterial(slotMaterial('plain', undefined)))
            .toBeInstanceOf(THREE.MeshLambertMaterial);
    });

    it('gives two classes of the same slot NAME different program cache keys', () => {
        // Two tiers compile different shaders. Sharing one program would shade one
        // of them as the other.
        const gold = createFadedEnvMaterial(slotMaterial('trim', 'gold'));
        const wood = createFadedEnvMaterial(slotMaterial('trim', 'wood'));
        const key = (m: THREE.Material): string => m.customProgramCacheKey?.() ?? '';
        expect(key(gold)).not.toBe(key(wood));
    });
});
