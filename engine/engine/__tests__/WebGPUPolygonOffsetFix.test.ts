import { applyWebGPUPolygonOffsetCacheFix } from 'engine/WebGPUPolygonOffsetFix.js';

/**
 * Mock of Three.js's WebGPU backend cache key, which (r183) is BLIND to polygon
 * offset: the key derives only from blending/depth/stencil/side/topology/geometry.
 * So two materials differing only in polygonOffset* collide here — the bug under
 * test. We model that by returning a constant key regardless of offset.
 */
interface MockMaterial {
    polygonOffset?: boolean;
    polygonOffsetFactor?: number;
    polygonOffsetUnits?: number;
}
function makeBackend() {
    return {
        getRenderCacheKey(_ro: { material: MockMaterial }): string {
            return 'shaderA,depthOn,sideFront,topoTriList,geomXYZ';
        },
    };
}
function ro(material: MockMaterial) {
    return { material };
}

describe('applyWebGPUPolygonOffsetCacheFix', () => {
    it('makes materials that differ only in polygon offset produce DISTINCT keys', () => {
        const backend = makeBackend();
        const renderer = { backend };

        // Before the fix: the per-bias-step terrain materials all collide.
        const step1 = ro({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const step2 = ro({ polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
        const step3 = ro({ polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 });
        expect(backend.getRenderCacheKey(step1)).toBe(backend.getRenderCacheKey(step2));

        applyWebGPUPolygonOffsetCacheFix(renderer);

        const k1 = backend.getRenderCacheKey(step1);
        const k2 = backend.getRenderCacheKey(step2);
        const k3 = backend.getRenderCacheKey(step3);
        expect(new Set([k1, k2, k3]).size).toBe(3);
    });

    it('leaves materials without polygon offset unchanged (no re-bucketing)', () => {
        const backend = makeBackend();
        const baseline = backend.getRenderCacheKey(ro({ polygonOffset: false }));
        applyWebGPUPolygonOffsetCacheFix({ backend });
        expect(backend.getRenderCacheKey(ro({ polygonOffset: false }))).toBe(baseline);
        // Step 0 of the voxel terrain (polygonOffset disabled) must not collide
        // with the biased steps, and must stay on the un-suffixed key.
        const biased = backend.getRenderCacheKey(ro({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        expect(biased).not.toBe(baseline);
    });

    it('buckets fractional offsets (i32 depthBias coerces ~0) so the cache cannot explode', () => {
        const backend = makeBackend();
        applyWebGPUPolygonOffsetCacheFix({ backend });
        // Legacy ZFightingRegistry style: -0.001 * index. All coerce to depthBias 0
        // on WebGPU, so they must share ONE pipeline key, not hundreds.
        const keys = new Set<string>();
        for (let i = 1; i <= 200; i++) {
            keys.add(backend.getRenderCacheKey(ro({
                polygonOffset: true,
                polygonOffsetFactor: -0.001 * i,
                polygonOffsetUnits: -0.001 * i,
            })));
        }
        expect(keys.size).toBe(1);
    });

    it('is idempotent — applying twice does not double-wrap or change keys', () => {
        const backend = makeBackend();
        applyWebGPUPolygonOffsetCacheFix({ backend });
        const once = backend.getRenderCacheKey(ro({ polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
        applyWebGPUPolygonOffsetCacheFix({ backend });
        const twice = backend.getRenderCacheKey(ro({ polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
        expect(twice).toBe(once);
    });

    it('no-ops safely when the backend or method is absent', () => {
        expect(() => applyWebGPUPolygonOffsetCacheFix(undefined)).not.toThrow();
        expect(() => applyWebGPUPolygonOffsetCacheFix({})).not.toThrow();
        expect(() => applyWebGPUPolygonOffsetCacheFix({ backend: {} })).not.toThrow();
    });
});
