/**
 * Active renderer backend, accessible without threading the renderer reference
 * through every material-construction site. Set once by GameEngine at startup
 * (and on swap). Used by material factories in VoxelWorld, VoxelShadowSystem,
 * SkyboxMaterialHelper, CurvedGroundShader, AmbientLighting to branch between
 * the TSL NodeMaterial path (WebGPU) and the classic THREE.Material path (WebGL).
 *
 * Why module-level: switching backends requires a page reload (NodeMaterials
 * already in the scene won't render under THREE.WebGLRenderer), so there is no
 * coherent mid-session "swap" — the value is effectively set once per page load.
 */
export type RendererType = 'webgl' | 'webgpu';

let activeRendererType: RendererType = 'webgl';

export function setActiveRendererType(type: RendererType): void {
    activeRendererType = type;
}

export function getActiveRendererType(): RendererType {
    return activeRendererType;
}

export function isWebGpuActive(): boolean {
    return activeRendererType === 'webgpu';
}

/**
 * The GPU backend ACTUALLY driving the renderer right now — distinct from
 * `getActiveRendererType()`, which only reports which renderer *class* was
 * requested (and thus which material pipeline, TSL vs GLSL, is in use).
 *
 * A `WebGPURenderer` silently falls back to the WebGL2 backend when the browser
 * has no WebGPU support (console: "THREE.WebGPURenderer: WebGPU is not
 * available, running under WebGL2 backend"). Three.js swaps in the WebGL2
 * backend instance, whose `isWebGPUBackend` flag is false — so this reflects
 * reality. A plain `THREE.WebGLRenderer` has no `.backend` and is always WebGL2.
 *
 * Note: for a `WebGPURenderer` the backend is only resolved after `init()`
 * completes; call this at display time (debug panel, perf report), not at boot.
 */
export type RendererBackend = 'webgpu' | 'webgl2';

export function getActiveBackend(renderer: unknown): RendererBackend {
    const backend = (renderer as { backend?: { isWebGPUBackend?: boolean } } | null | undefined)?.backend;
    return backend?.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}

/**
 * Whether the renderer can be drawn with yet.
 *
 * WebGPURenderer.init() runs asynchronously (GameEngine.createRenderer fires it
 * without awaiting). Calling renderer.render() before it resolves throws
 * "Renderer: .render() called before the backend is initialized".
 * THREE.WebGLRenderer has no hasInitialized() and is ready synchronously, so it
 * reads as ready.
 */
export function rendererBackendReady(renderer: unknown): boolean {
    const hasInitialized = (renderer as { hasInitialized?: () => boolean } | null)?.hasInitialized;
    return typeof hasInitialized === 'function' ? hasInitialized.call(renderer) : true;
}
