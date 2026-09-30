/**
 * Chrome 153 on macOS cannot compile a WGSL shader that swizzles a swizzle.
 *
 * Three's TSL emits `nodeVar3.xy.x` wherever a node reads `.xy` off a vector and a
 * later node reads `.x` off THAT — its own `getAlphaHashThreshold` (`alphaHash`),
 * and the DFG lookup in the physical lighting model (`textureSample(...).xy.x`)
 * both do. WGSL allows it, and every other backend compiles it, but Chrome 153's
 * Tint IR → Metal lowering (stable on 2026-08-29) rejects it:
 *
 *   THREE.WebGPURenderer: Async render pipeline creation failed
 *   (renderPipeline_Env_faded_104): An error occurred while generating Tint IR
 *   error: swizzle view instruction still has usages after lowering
 *
 * The pipeline never builds, the meshes that use it never draw, and — because
 * the faded env materials are among the first the Creator compiles — the game
 * never reports GAME_LOADED, so the Creator and every CLI forge session sit at a
 * timeout. Bisected against the captured WGSL: un-chaining the swizzles is the
 * one edit that makes the shader compile; nothing else in it matters.
 *
 * This is the smallest correct intervention: rewrite the shader SOURCE on its
 * way into `GPUDevice.createShaderModule`, so every shader three ever builds is
 * covered, including the ones inside three's own lighting models that no
 * material of ours could avoid. The rewrite is exact — `a.xy.y` and `a.y` are the
 * same expression, `a.zw.x` is `a.z` — so it is applied unconditionally rather
 * than gated on a browser version: there is no rendering difference to protect
 * on a browser that did not need it, and the failure it guards against is a
 * shader that silently does not draw.
 */

/** `rgba` and `xyzw` name the same lanes; `% 4` folds both into one index space. */
function lane(c: string): number {
    return 'xyzwrgba'.indexOf(c) % 4;
}

/** A swizzle read off a swizzle: the inner one, then the outer one. */
const CHAINED_SWIZZLE = /\.([xyzw]{2,4}|[rgba]{2,4})\.([xyzw]{1,4}|[rgba]{1,4})\b/g;

/**
 * `expr.xy.x` → `expr.x`, repeated until no swizzle follows a swizzle.
 *
 * The outer swizzle need not be a single component: `a.zw.yx` collapses to
 * `a.wz`, because every outer lane is mapped through the inner swizzle rather
 * than substituted positionally. A lane outside the inner swizzle (`a.xy.z`) is
 * invalid WGSL and is left alone for Tint to report.
 */
export function unchainWgslSwizzles(code: string): string {
    let previous: string;
    let current = code;
    do {
        previous = current;
        current = current.replace(CHAINED_SWIZZLE, (whole, inner: string, outer: string) => {
            let collapsed = '';
            for (const c of outer) {
                const i = lane(c);
                if (i >= inner.length) return whole;
                collapsed += inner[i];
            }
            return `.${collapsed}`;
        });
    } while (current !== previous);
    return current;
}

interface ShaderModuleDescriptor {
    code: string;
}

interface PatchableDevice {
    createShaderModule(descriptor: ShaderModuleDescriptor): unknown;
    __swizzleFixApplied?: boolean;
}

/**
 * Install the rewrite on the renderer's `GPUDevice`. Call once the WebGPU
 * backend has initialised (the device does not exist before `renderer.init()`);
 * a renderer running three's WebGL2 fallback has no device and is left alone.
 */
export function applyWebGPUSwizzleFix(renderer: unknown): boolean {
    const device = (renderer as { backend?: { device?: PatchableDevice } } | null)?.backend?.device;
    if (!device || typeof device.createShaderModule !== 'function') return false;
    if (device.__swizzleFixApplied === true) return true;
    device.__swizzleFixApplied = true;

    const original = device.createShaderModule.bind(device);
    device.createShaderModule = (descriptor: ShaderModuleDescriptor) =>
        original({ ...descriptor, code: unchainWgslSwizzles(descriptor.code) });
    return true;
}
