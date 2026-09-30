/** @jest-environment jsdom */
import {
    DEFAULT_MATERIAL_QUALITY,
    clearMaterialQuality,
    isMaterialQuality,
    materialQualityPolicy,
    resolveMaterialQuality,
    setMaterialQuality,
} from 'engine/MaterialQuality.js';
import {
    clampVoxelMaterialLighting,
    resolveVoxelMaterialClass,
    wantsShadingSmoothing,
} from 'engine/VoxelMaterialClass.js';

/**
 * The quality ladder is what keeps material classes affordable on cheap devices:
 * 'medium' must clamp Physical down to Phong (near-free), 'low' must reduce
 * everything to exactly the pre-class Lambert rendering, and the resolution
 * order must let a device-testing URL override everything.
 */
describe('MaterialQuality resolution', () => {
    beforeEach(() => {
        clearMaterialQuality();
        window.history.replaceState(null, '', '/');
    });

    it('non-interactive contexts see the asset\'s full look', () => {
        // The device tier supplies the fallback now (DeviceQuality.ts owns that mapping);
        // this constant is what a worker or the offscreen thumbnail renderer uses.
        expect(DEFAULT_MATERIAL_QUALITY).toBe('high');
    });

    it('?matq= beats the stored choice, which beats the tier\'s answer', () => {
        expect(resolveMaterialQuality('high')).toBe('high');

        setMaterialQuality('low');
        expect(resolveMaterialQuality('high')).toBe('low');

        window.history.replaceState(null, '', '/?matq=medium');
        expect(resolveMaterialQuality('high')).toBe('medium');
    });

    it('an unrecognised override or stored value falls back instead of breaking the load', () => {
        window.history.replaceState(null, '', '/?matq=ultra');
        expect(resolveMaterialQuality('medium')).toBe('medium');
        try {
            localStorage.setItem('bm.materialQuality', 'garbage');
        } catch { /* jsdom always has storage */ }
        window.history.replaceState(null, '', '/');
        expect(resolveMaterialQuality('high')).toBe('high');
    });

    it('isMaterialQuality narrows exactly the ladder', () => {
        expect(isMaterialQuality('high')).toBe(true);
        expect(isMaterialQuality('medium')).toBe(true);
        expect(isMaterialQuality('low')).toBe(true);
        expect(isMaterialQuality('ultra')).toBe(false);
        expect(isMaterialQuality('')).toBe(false);
    });
});

describe('materialQualityPolicy / clampVoxelMaterialLighting', () => {
    it("'high' allows everything; 'medium' clamps environment to direct; 'low' clamps all to lambert", () => {
        expect(clampVoxelMaterialLighting('environment', 'high')).toBe('environment');
        expect(clampVoxelMaterialLighting('direct', 'high')).toBe('direct');

        expect(clampVoxelMaterialLighting('environment', 'medium')).toBe('direct');
        expect(clampVoxelMaterialLighting('direct', 'medium')).toBe('direct');

        expect(clampVoxelMaterialLighting('environment', 'low')).toBe('lambert');
        expect(clampVoxelMaterialLighting('direct', 'low')).toBe('lambert');
        expect(clampVoxelMaterialLighting('lambert', 'high')).toBe('lambert');
    });

    it('only high runs the shading-normal smoothing pass', () => {
        expect(materialQualityPolicy('high').shadingSmoothing).toBe(true);
        expect(materialQualityPolicy('medium').shadingSmoothing).toBe(false);
        expect(materialQualityPolicy('low').shadingSmoothing).toBe(false);
    });

    it('wantsShadingSmoothing combines the class appetite with the tier policy', () => {
        const gold = resolveVoxelMaterialClass('gold');
        const matte = resolveVoxelMaterialClass('matte');
        expect(wantsShadingSmoothing(gold, 'high')).toBe(true);
        expect(wantsShadingSmoothing(gold, 'medium')).toBe(false);
        expect(wantsShadingSmoothing(gold, 'low')).toBe(false);
        // A class that never smooths stays off at every tier.
        expect(wantsShadingSmoothing(matte, 'high')).toBe(false);
    });
});
