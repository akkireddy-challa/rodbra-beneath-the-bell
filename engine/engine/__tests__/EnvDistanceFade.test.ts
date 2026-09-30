/**
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import { computeEnvFadeBand } from 'engine/EnvDistanceFadeBand.js';
import { createFadedEnvMaterial, setEnvFadeBand } from 'engine/EnvDistanceFade.js';
import { createVoxelMaterial, type VoxelMaterialParams } from 'engine/VoxelEmissiveMaterial.js';
import { setActiveRendererType } from 'engine/RendererType.js';
import { buildGraph } from 'engine/__mocks__/three-tsl.js';

describe('computeEnvFadeBand', () => {
    it('ends the fade just inside the cull, so it completes before the hard cull', () => {
        const { end } = computeEnvFadeBand(500);
        expect(end).toBeLessThan(500);
        expect(end).toBeGreaterThan(490); // small margin, not a big dead zone
    });

    it('start is nearer than end and never past the halfway point', () => {
        for (const d of [200, 350, 500, 800, 1500]) {
            const { start, end } = computeEnvFadeBand(d);
            expect(start).toBeLessThan(end);
            expect(start).toBeGreaterThanOrEqual(d * 0.5); // mid-scene objects stay solid
            expect(end).toBeLessThan(d);
        }
    });

    it('fade width scales with distance but stays in a sane metre range', () => {
        const narrow = computeEnvFadeBand(150); // 0.2*150=30 → clamped up to 40
        expect(narrow.end - narrow.start).toBeCloseTo(40, 0);
        const mid = computeEnvFadeBand(500); // 0.2*500=100
        expect(mid.end - mid.start).toBeCloseTo(100, 0);
        const wide = computeEnvFadeBand(2000); // 0.2*2000=400 → clamped down to 120
        expect(wide.end - wide.start).toBeCloseTo(120, 0);
    });

    it('disables the fade (band at infinity) for a non-positive/NaN distance', () => {
        for (const d of [0, -10, NaN, Infinity]) {
            const { start, end } = computeEnvFadeBand(d);
            expect(start).toBeGreaterThan(1e8);
            expect(end).toBeGreaterThan(start);
        }
    });
});

// Tests run on the default WebGL backend (isWebGpuActive() === false), so the
// faded material is a MeshLambertMaterial + onBeforeCompile.
describe('createFadedEnvMaterial preserves emissive (instanced/reloaded env objects)', () => {
    const atlasParams: VoxelMaterialParams = {
        map: new THREE.Texture(), vertexColors: false, flatShading: true,
        polygonOffsetFactor: 2, polygonOffsetUnits: 4,
    };
    /** Compile a faded material's shader against three's real lambert sources. */
    function fadedShader(source: THREE.Material) {
        const faded = createFadedEnvMaterial(source) as THREE.MeshLambertMaterial;
        const shader = {
            vertexShader: THREE.ShaderLib.lambert.vertexShader,
            fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
            uniforms: {} as Record<string, THREE.IUniform>,
        };
        faded.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
        return { faded, shader };
    }

    it('re-applies the albedo-tinted emissive term for an emissive source', () => {
        const source = createVoxelMaterial(atlasParams, true);
        const { faded, shader } = fadedShader(source);
        // Emissive glow survived the rebuild...
        expect(shader.fragmentShader).toContain('totalEmissiveRadiance = diffuseColor.rgb * vEmissive * emissive *');
        expect(shader.vertexShader).toContain('vEmissive = emissive;');
        // ...alongside the distance-fade dissolve.
        expect(shader.fragmentShader).toContain('smoothstep(envFadeStart, envFadeEnd, vEnvFadeDepth)');
        expect((faded as THREE.MeshLambertMaterial).emissive.getHex()).toBe(0xffffff);
        expect((faded.customProgramCacheKey as () => string)()).toBe('envDistanceFadeEmissive');
    });

    it('adds no emissive term for a non-emissive source, still fades', () => {
        const source = createVoxelMaterial(atlasParams, false);
        const { faded, shader } = fadedShader(source);
        expect(shader.fragmentShader).not.toContain('totalEmissiveRadiance = diffuseColor.rgb');
        expect(shader.fragmentShader).not.toContain('vEmissive');
        expect(shader.fragmentShader).toContain('smoothstep(envFadeStart, envFadeEnd, vEnvFadeDepth)');
        expect((faded.customProgramCacheKey as () => string)()).toBe('envDistanceFade');
    });
});

// GLB-voxelized env objects (trees) render with per-voxel VERTEX COLORS and no
// texture map (useAtlas:false). The faded clone must keep vertexColors, or the
// geometry's color attribute is ignored and every instance renders pure white.
describe('createFadedEnvMaterial preserves vertex colors (GLB-voxelized env objects)', () => {
    it('keeps vertexColors for a vertex-color (non-atlas) Lambert source', () => {
        const source = new THREE.MeshLambertMaterial({ vertexColors: true });
        const faded = createFadedEnvMaterial(source) as THREE.MeshLambertMaterial;
        expect(faded.vertexColors).toBe(true);
    });

    it('leaves vertexColors off for a textured atlas source', () => {
        const source = new THREE.MeshLambertMaterial({ map: new THREE.Texture(), vertexColors: false });
        const faded = createFadedEnvMaterial(source) as THREE.MeshLambertMaterial;
        expect(faded.vertexColors).toBe(false);
    });
});

/**
 * REGRESSION: the WebGPU faded materials used to share ONE pair of module-global
 * band uniform nodes, and therefore one opacity node graph, across every faded
 * material. A TSL node carries the builder state of the graph currently compiling
 * it, so the second material to build reached nodes already bound into the first
 * material's graph and threw
 *   `THREE.TSL: TypeError: Cannot read properties of undefined (reading 'addToStack')`
 * — which is why a dense voxel forest (a thousand+ faded trees, rocks and houses,
 * each distinct source material getting its own faded clone) failed to render at
 * all on WebGPU while a handful of scenery objects looked fine.
 *
 * Each material must own its whole graph, with only the uniform HANDLES registered
 * so `setEnvFadeBand` still reaches all of them. `buildGraph` (the three/tsl mock)
 * stands in for a material build and throws that same TypeError if two graphs ever
 * reach a shared node.
 */
describe('createFadedEnvMaterial gives every WebGPU material its own node graph', () => {
    beforeEach(() => setActiveRendererType('webgpu'));
    afterEach(() => setActiveRendererType('webgl'));

    interface NodeFaded extends THREE.Material { opacityNode: unknown }

    /** Faded clones of `count` DISTINCT sources — what a forest's varied scenery
     *  produces (EnvironmentObjectSystem caches one faded material per source). */
    function fadedFleet(count: number): NodeFaded[] {
        return Array.from({ length: count }, (_, i) => {
            const source = new THREE.MeshLambertMaterial({ vertexColors: true });
            source.name = `tree${i}`;
            return createFadedEnvMaterial(source) as NodeFaded;
        });
    }

    /** Every uniform node reachable from a material's opacity graph, by identity. */
    function uniformNodesOf(material: NodeFaded): unknown[] {
        const found: unknown[] = [];
        const walk = (node: unknown): void => {
            if (typeof node !== 'object' || node === null) return;
            const n = node as { inputs?: unknown[]; value?: unknown };
            if (typeof n.value === 'number') found.push(node);
            for (const input of n.inputs ?? []) walk(input);
        };
        walk(material.opacityNode);
        return found;
    }

    it('builds a distinct opacity graph per material, sharing no node', () => {
        const fleet = fadedFleet(3);
        const seen = new Set<unknown>();
        for (const material of fleet) {
            expect(material.opacityNode).toBeDefined();
            expect(seen.has(material.opacityNode)).toBe(false);
            for (const u of uniformNodesOf(material)) {
                expect(seen.has(u)).toBe(false);
                seen.add(u);
            }
            seen.add(material.opacityNode);
        }
        // Two band uniforms (start, end) per material, none shared.
        expect(seen.size).toBe(fleet.length * 3);
    });

    it('builds a thousand faded scenery materials without an addToStack error', () => {
        const fleet = fadedFleet(1200);
        // Build each graph, then build them all AGAIN — a material recompiles
        // whenever the shader cache is invalidated, and that must stay legal.
        for (let pass = 0; pass < 2; pass++) {
            for (const material of fleet) {
                expect(() => buildGraph(material.opacityNode)).not.toThrow();
            }
        }
    });

    it('still reaches every live material when the shared band changes', () => {
        const fleet = fadedFleet(4);
        const band = computeEnvFadeBand(600);

        setEnvFadeBand(band);

        for (const material of fleet) {
            const values = uniformNodesOf(material).map((u) => (u as { value: number }).value);
            expect(values).toHaveLength(2);
            expect(values).toEqual(expect.arrayContaining([band.start, band.end]));
        }
        setEnvFadeBand(computeEnvFadeBand(0));
    });

    it('starts a material at the CURRENT band, not the disabled default', () => {
        const band = computeEnvFadeBand(450);
        setEnvFadeBand(band);

        const [late] = fadedFleet(1);
        const values = uniformNodesOf(late!).map((u) => (u as { value: number }).value);

        expect(values).toEqual(expect.arrayContaining([band.start, band.end]));
        setEnvFadeBand(computeEnvFadeBand(0));
    });

    it('drops a disposed material\'s uniforms instead of writing to them forever', () => {
        const [gone] = fadedFleet(1);
        const stale = uniformNodesOf(gone!) as Array<{ value: number }>;
        expect(stale).toHaveLength(2);

        gone!.dispose();
        const band = computeEnvFadeBand(700);
        setEnvFadeBand(band);

        // The disposed material's handles were unregistered, so the update skipped them.
        for (const u of stale) {
            expect(u.value).not.toBe(band.start);
            expect(u.value).not.toBe(band.end);
        }
        setEnvFadeBand(computeEnvFadeBand(0));
    });
});
