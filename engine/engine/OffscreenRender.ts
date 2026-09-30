/**
 * OffscreenRender — capture a scene+camera to an off-screen WebGLRenderTarget
 * and convert the pixels to a WebP blob. Used by ScreenshotService when
 * capturing with a custom (non-live) camera so the player's view never
 * flickers.
 */

import * as THREE from 'three';
import { isWebGpuActive } from 'engine/RendererType.js';

// WebGPU's `readRenderTargetPixelsAsync` returns a fresh TypedArray (no buffer
// arg) with each row aligned to 256 bytes. WebGL's writes into a caller buffer
// with tightly-packed rows. The renderer field is typed as WebGLRenderer
// throughout the engine (see GameEngine.ts header comment), so the WebGPU call
// goes through this minimal structural type to bypass the WebGL-shaped typing.
type WebGpuReader = {
    readRenderTargetPixelsAsync(
        renderTarget: THREE.WebGLRenderTarget,
        x: number, y: number, width: number, height: number,
    ): Promise<Uint8Array>;
};

/** GPU backend that actually produced the readback pixels — distinct from the
 *  renderer *class*. A WebGPURenderer silently falls back to a WebGL2 backend
 *  when WebGPU is unavailable, and the pixel layout follows the backend, not
 *  the renderer the engine asked for. */
export type ReadbackBackend = 'webgpu' | 'webgl';

/**
 * Normalize raw GPU readback bytes into a tightly-packed, top-down RGBA buffer
 * suitable for `ImageData`.
 *  - `webgpu`: rows are padded to a 256-byte stride (WebGPU copy-buffer
 *    alignment) and ordered top-down (texture top-left origin) → strip padding.
 *  - `webgl`: rows are tightly packed and ordered bottom-up (gl.readPixels
 *    framebuffer convention) → flip vertically.
 */
export function normalizeReadbackPixels(
    raw: Uint8Array,
    width: number,
    height: number,
    backend: ReadbackBackend,
): Uint8Array {
    const rowBytes = width * 4;
    const out = new Uint8Array(rowBytes * height);
    // webgpu rows are padded to a 256-byte stride and ordered top-down, so we
    // read row `y` directly. webgl rows are tightly packed and ordered
    // bottom-up, so output row `y` comes from source row `height - 1 - y`.
    const isWebGpu = backend === 'webgpu';
    const srcStride = isWebGpu ? Math.ceil(rowBytes / 256) * 256 : rowBytes;
    for (let y = 0; y < height; y += 1) {
        const srcRow = isWebGpu ? y : height - 1 - y;
        const srcOff = srcRow * srcStride;
        out.set(raw.subarray(srcOff, srcOff + rowBytes), y * rowBytes);
    }
    return out;
}

/** Which backend is *actually* driving the unified WebGPURenderer right now.
 *  `renderer.backend.isWebGPUBackend` is set on the live backend instance and
 *  swapped to the WebGL2 backend by Three.js when WebGPU init fails, so it
 *  reflects reality even though the engine's RendererType flag does not. */
function activeReadbackBackend(renderer: THREE.WebGLRenderer): ReadbackBackend {
    const backend = (renderer as unknown as {
        backend?: { isWebGPUBackend?: boolean };
    }).backend;
    return backend?.isWebGPUBackend === true ? 'webgpu' : 'webgl';
}

/**
 * Render the given scene/camera at the requested resolution and return a
 * WebP-encoded Blob.
 *
 * The camera's aspect is updated to match `width/height` and its projection
 * matrix is refreshed. The live canvas is never touched.
 */
export async function renderToWebpBlob(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
    quality: number,
): Promise<Blob> {
    // Save and restore the camera's aspect so a caller-provided custom camera
    // (e.g. engine.camera passed via { kind: 'custom' }) isn't permanently mutated.
    const isPerspective = camera instanceof THREE.PerspectiveCamera;
    const savedAspect = isPerspective ? camera.aspect : null;
    if (isPerspective) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }

    // UnsignedByteType is required: readRenderTargetPixelsAsync into a Uint8Array
    // produces zeroed/garbage pixels with HalfFloatType or FloatType targets.
    const target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.UnsignedByteType,
    });

    const previousTarget = renderer.getRenderTarget();
    try {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);

        // Read pixels back. The call *signature* depends on the renderer class
        // (the unified WebGPURenderer returns a fresh array; classic
        // THREE.WebGLRenderer writes into a caller buffer), but the pixel
        // *layout* (row padding + vertical orientation) depends on the GPU
        // backend that actually ran — which is NOT the same thing. When WebGPU
        // is unavailable the WebGPURenderer falls back to a WebGL2 backend
        // whose gl.readPixels output is tightly packed and bottom-up, even
        // though isWebGpuActive() still reports the requested 'webgpu'. Branch
        // layout on the live backend so the fallback capture isn't mangled.
        const rowBytes = width * 4;
        let raw: Uint8Array;
        let backend: ReadbackBackend;
        if (isWebGpuActive()) {
            const wgpu = renderer as unknown as WebGpuReader;
            raw = await wgpu.readRenderTargetPixelsAsync(target, 0, 0, width, height);
            backend = activeReadbackBackend(renderer);
        } else {
            raw = new Uint8Array(rowBytes * height);
            await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, raw);
            backend = 'webgl';
        }
        const pixels = normalizeReadbackPixels(raw, width, height, backend);

        const offscreen = new OffscreenCanvas(width, height);
        const ctx = offscreen.getContext('2d');
        if (!ctx) {
            throw new Error('OffscreenCanvas 2D context unavailable');
        }
        // normalizeReadbackPixels already produced tightly-packed, top-down
        // rows — exactly the ImageData layout, so copy straight across.
        const imageData = ctx.createImageData(width, height);
        imageData.data.set(pixels);
        ctx.putImageData(imageData, 0, 0);

        return await offscreen.convertToBlob({ type: 'image/webp', quality });
    } finally {
        renderer.setRenderTarget(previousTarget);
        target.dispose();
        if (isPerspective && savedAspect !== null) {
            camera.aspect = savedAspect;
            camera.updateProjectionMatrix();
        }
    }
}
