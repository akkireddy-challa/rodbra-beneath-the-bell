/** @jest-environment jsdom */
import * as THREE from 'three';
import { clearMaterialQuality, setMaterialQuality } from 'engine/MaterialQuality.js';
import { createVertexColourTerrainMaterial } from 'engine/VoxelWorld.js';

/**
 * VoxelWorld's vertex-colour terrain material stops deciding its own lighting
 * tier: 'standard' (the default, the Gaussian-splat paths) is Standard only
 * when the quality ladder allows the environment tier and Lambert otherwise,
 * while 'lambert' stays the forced-Lambert published contract. Parameters are
 * identical across the tiers — only the lighting model moves.
 */
afterEach(() => {
    clearMaterialQuality();
});

const OFFSET = { factor: 1.5, units: 2.5 };

function expectTerrainParams(mat: THREE.Material): void {
    const m = mat as THREE.MeshLambertMaterial;
    expect(m.vertexColors).toBe(true);
    expect(m.flatShading).toBe(true);
    expect(m.side).toBe(THREE.FrontSide);
    expect(m.polygonOffset).toBe(true);
    expect(m.polygonOffsetFactor).toBeCloseTo(OFFSET.factor, 5);
    expect(m.polygonOffsetUnits).toBeCloseTo(OFFSET.units, 5);
    expect(m.depthWrite).toBe(true);
    expect(m.depthTest).toBe(true);
}

it("'standard' at high quality is today's exact MeshStandardMaterial", () => {
    setMaterialQuality('high');
    const mat = createVertexColourTerrainMaterial('standard', OFFSET);
    expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
    expectTerrainParams(mat);
});

it("'standard' clamps to Lambert on medium and low — same parameters, cheaper lighting", () => {
    for (const quality of ['medium', 'low'] as const) {
        setMaterialQuality(quality);
        const mat = createVertexColourTerrainMaterial('standard', OFFSET);
        expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
        expectTerrainParams(mat);
    }
});

it("'lambert' is forced Lambert regardless of quality — the published API contract", () => {
    setMaterialQuality('high');
    const mat = createVertexColourTerrainMaterial('lambert', OFFSET);
    expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
    expectTerrainParams(mat);
});
