/**
 * WebGPU bakes polygon offset into the immutable render pipeline, but Three.js
 * (r183) omits it from the pipeline cache key (`WebGPUBackend.getRenderCacheKey`).
 * So materials differing only in polygon offset collide onto one cached pipeline
 * and share whichever `depthBias` compiled first — z-fighting under WebGPU only
 * (WebGL applies `gl.polygonOffset` as dynamic per-draw state). This wraps the
 * cache key so distinct offsets get distinct pipelines, mirroring WebGL.
 */

interface PolygonOffsetMaterial {
    polygonOffset?: boolean;
    polygonOffsetFactor?: number;
    polygonOffsetUnits?: number;
}

interface CacheKeyRenderObject {
    material: PolygonOffsetMaterial;
}

interface PipelineCacheBackend {
    getRenderCacheKey(renderObject: CacheKeyRenderObject): string;
    __polygonOffsetCacheFixApplied?: boolean;
}

export function applyWebGPUPolygonOffsetCacheFix(renderer: unknown): void {
    const backend = (renderer as { backend?: PipelineCacheBackend } | null)?.backend;
    if (!backend || typeof backend.getRenderCacheKey !== 'function') return;
    if (backend.__polygonOffsetCacheFixApplied === true) return;
    backend.__polygonOffsetCacheFixApplied = true;

    const original = backend.getRenderCacheKey.bind(backend);
    backend.getRenderCacheKey = (renderObject: CacheKeyRenderObject): string => {
        const baseKey = original(renderObject);
        const material = renderObject.material;
        if (material.polygonOffset !== true) return baseKey;
        // Match WebGPU's i32 `depthBias` coercion for the constant term; bucket
        // the slope scale to an integer (the only meaningful factors here are
        // integers, and tiny fractional offsets produce a ~zero effective bias).
        const units = Math.trunc(material.polygonOffsetUnits ?? 0);
        const slope = Math.round(material.polygonOffsetFactor ?? 0);
        return `${baseKey},po:${units}:${slope}`;
    };
}
