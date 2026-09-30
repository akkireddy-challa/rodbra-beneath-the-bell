import { getActiveBackend } from 'engine/RendererType.js';

/**
 * `getActiveBackend` answers "what GPU is actually under this renderer", which is a
 * DIFFERENT question from "which renderer class was constructed" — and the difference
 * is load-bearing. `WebGPURenderer` sets `isWebGPURenderer = true` in its constructor,
 * before it knows whether it will get a WebGPU device; with none it initialises the
 * WebGL2 fallback backend and keeps the flag.
 *
 * Anything that spends real GPU capability has to gate on THIS, not on the class. A
 * screen-space-reflection pass gated on the class flag ran on every iOS device (all
 * iOS browsers are WebKit, so all of them are on the fallback) and crashed the one
 * Joyride level whose weather asks for reflections.
 */
describe('getActiveBackend', () => {
    /** A WebGPURenderer that really got a WebGPU device. */
    const webgpuRenderer = { isWebGPURenderer: true, backend: { isWebGPUBackend: true } };
    /** THE iOS CASE: same class, same flag, WebGL2 backend underneath. */
    const fallbackRenderer = { isWebGPURenderer: true, backend: { isWebGLBackend: true } };
    /** A plain THREE.WebGLRenderer — no `.backend` at all. */
    const webglRenderer = { isWebGPURenderer: undefined };

    it('reports webgpu only when the BACKEND is WebGPU', () => {
        expect(getActiveBackend(webgpuRenderer)).toBe('webgpu');
    });

    it('reports webgl2 for a WebGPURenderer on its fallback backend — the class flag lies', () => {
        expect(fallbackRenderer.isWebGPURenderer).toBe(true);        // the flag that fooled the SSR gate
        expect(getActiveBackend(fallbackRenderer)).toBe('webgl2');
    });

    it('reports webgl2 for a classic WebGLRenderer, which has no backend object', () => {
        expect(getActiveBackend(webglRenderer)).toBe('webgl2');
    });

    it('degrades to webgl2 rather than throwing when there is no renderer yet', () => {
        // A WebGPURenderer's backend is only resolved after init(); a caller that asks
        // too early must get the CONSERVATIVE answer, never a capability it lacks.
        expect(getActiveBackend(null)).toBe('webgl2');
        expect(getActiveBackend(undefined)).toBe('webgl2');
        expect(getActiveBackend({ isWebGPURenderer: true })).toBe('webgl2');
    });
});
