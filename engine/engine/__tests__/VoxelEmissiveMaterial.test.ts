/**
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import {
    createVoxelMaterial,
    EMISSIVE_INTENSITY,
    GLOW_GAIN_GLSL,
    glowGainForLuminance,
    LUMA_WEIGHTS,
    type VoxelMaterialParams,
} from 'engine/VoxelEmissiveMaterial.js';

// Tests run with the default WebGL backend (isWebGpuActive() === false), so the
// factory takes the MeshLambertMaterial + onBeforeCompile path. The WebGPU node
// path and the actual pixel-level glow (+ bloom) require the running engine and
// are deferred to the Task 8 E2E after a server restart.

const atlasParams: VoxelMaterialParams = {
    map: new THREE.Texture(),
    vertexColors: false,
    flatShading: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
};

const vertexParams: VoxelMaterialParams = {
    map: null,
    vertexColors: true,
    flatShading: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
};

describe('createVoxelMaterial', () => {
    test('EMISSIVE_INTENSITY is the tuned bloom-crossing multiplier', () => {
        expect(EMISSIVE_INTENSITY).toBe(3.0);
    });

    test('emissive=false returns a plain Lambert material with no emissive wiring', () => {
        const mat = createVoxelMaterial(vertexParams, false);
        expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
        // Byte-identical to the pre-feature material: no shader injection, and
        // emissiveIntensity left at the Three.js default (1), emissive black.
        expect(mat.onBeforeCompile).toBe(THREE.Material.prototype.onBeforeCompile);
        const lambert = mat as THREE.MeshLambertMaterial;
        expect(lambert.emissiveIntensity).toBe(1);
        expect(lambert.emissive.getHex()).toBe(0x000000);
    });

    test('emissive=false reproduces the vertex-colour material params exactly', () => {
        const mat = createVoxelMaterial(vertexParams, false) as THREE.MeshLambertMaterial;
        expect(mat.vertexColors).toBe(true);
        expect(mat.map).toBeNull();
        expect(mat.side).toBe(THREE.FrontSide);
        expect(mat.flatShading).toBe(true);
        expect(mat.polygonOffset).toBe(true);
        expect(mat.polygonOffsetFactor).toBe(2);
        expect(mat.polygonOffsetUnits).toBe(4);
    });

    test('emissive=false reproduces the atlas material params exactly', () => {
        const mat = createVoxelMaterial(atlasParams, false) as THREE.MeshLambertMaterial;
        expect(mat.vertexColors).toBe(false);
        expect(mat.map).toBe(atlasParams.map);
        expect(mat.side).toBe(THREE.FrontSide);
        expect(mat.flatShading).toBe(true);
        expect(mat.polygonOffset).toBe(true);
    });

    test('emissive=true wires the per-vertex emissive term (onBeforeCompile + intensity)', () => {
        const mat = createVoxelMaterial(vertexParams, true) as THREE.MeshLambertMaterial;
        expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(mat.onBeforeCompile).not.toBe(THREE.Material.prototype.onBeforeCompile);
        expect(mat.emissive.getHex()).toBe(0xffffff);
        // The uniform carries the 0..1 control only. The multiplier that makes it
        // a glow is per fragment now, because it depends on that fragment's own
        // albedo — see the hue-independence test below.
        expect(mat.emissiveIntensity).toBe(1);
        // Shared params unchanged versus the non-emissive shape.
        expect(mat.vertexColors).toBe(true);
        expect(mat.side).toBe(THREE.FrontSide);
        expect(mat.polygonOffset).toBe(true);
    });

    test('emissive=true injection lands in the REAL lambert shader sources', () => {
        const mat = createVoxelMaterial(atlasParams, true) as THREE.MeshLambertMaterial;
        // Run onBeforeCompile against three's actual lambert shaders so a three
        // upgrade that renames an anchor (`void main() {` in the vertex source,
        // `#include <emissivemap_fragment>` in the fragment source) fails here
        // instead of silently no-oping the glow via String.replace.
        const shader = {
            vertexShader: THREE.ShaderLib.lambert.vertexShader,
            fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
            uniforms: {} as Record<string, THREE.IUniform>,
        };
        mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
        expect(shader.vertexShader).not.toBe(THREE.ShaderLib.lambert.vertexShader);
        expect(shader.fragmentShader).not.toBe(THREE.ShaderLib.lambert.fragmentShader);
        expect(shader.vertexShader).toContain('attribute float emissive;');
        expect(shader.vertexShader).toContain('vEmissive = emissive;');
        expect(shader.fragmentShader).toContain('varying float vEmissive;');
        // The glow is tinted by the voxel's own albedo (diffuseColor.rgb), not white,
        // and scaled by the hue-preserving gain so the tint doesn't decide the brightness.
        expect(shader.fragmentShader).toContain('totalEmissiveRadiance = diffuseColor.rgb * vEmissive * emissive *');
        expect(shader.fragmentShader).toContain(GLOW_GAIN_GLSL);
        // The assignment must land AFTER the include that finishes diffuseColor.
        const frag = shader.fragmentShader;
        expect(frag.indexOf('totalEmissiveRadiance = diffuseColor.rgb'))
            .toBeGreaterThan(frag.indexOf('#include <emissivemap_fragment>'));
    });
});

/**
 * The reason the gain exists. A flat `albedo × 3` made "100% glow" mean a
 * different brightness for every hue, because luma is 71% green: white landed at
 * 3.0 and bloomed, a saturated magenta at 0.767 and sat under a typical 0.87
 * bloom threshold — same slider, same 100%, one glowed and one just got brighter.
 */
describe('a full glow is a glow at any hue', () => {
    const luma = (r: number, g: number, b: number) =>
        LUMA_WEIGHTS[0] * r + LUMA_WEIGHTS[1] * g + LUMA_WEIGHTS[2] * b;
    /** Emissive luminance a full-strength glow of this albedo actually emits. */
    const emitted = (r: number, g: number, b: number) => {
        const l = luma(r, g, b);
        return l * glowGainForLuminance(l);
    };

    it('emits the same luminance for white and for a saturated magenta', () => {
        // #FF00CB, the colour whose LEDs stayed dark at 100% glow.
        expect(emitted(1, 0, 0.6038)).toBeCloseTo(emitted(1, 1, 1), 5);
    });

    it('leaves white exactly where it was, so existing lights do not change', () => {
        expect(glowGainForLuminance(luma(1, 1, 1))).toBe(EMISSIVE_INTENSITY);
    });

    it('clears a typical bloom threshold for every saturated primary', () => {
        // The old behaviour: red 0.64, magenta 0.77, blue 0.22 — all under 0.87.
        for (const [r, g, b] of [[1, 0, 0], [0, 0, 1], [1, 0, 0.6038], [0, 1, 1]]) {
            expect(emitted(r!, g!, b!)).toBeGreaterThan(0.87);
        }
    });

    it('still refuses to light up black — a glow is albedo-tinted', () => {
        expect(emitted(0, 0, 0)).toBe(0);
    });

    it('scales a near-black voxel down rather than hauling it to full brightness', () => {
        expect(emitted(0.01, 0.01, 0.01)).toBeLessThan(emitted(1, 1, 1));
    });
});
