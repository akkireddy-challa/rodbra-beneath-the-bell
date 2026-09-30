/**
 * Which renderer backend a fresh page load should construct — the persistence
 * and reload half of renderer switching, split out of GameEngine.ts (which is
 * at its max-lines budget). The active-backend runtime state lives in
 * RendererType.ts; this module only decides the INITIAL pick and performs the
 * reload that makes a new pick take effect.
 */
import type { RendererType } from 'engine/RendererType.js';
import { DEFAULT_RENDERER_TYPE } from 'engine/config.js';

const RENDERER_TYPE_STORAGE_KEY = 'bm:rendererType';

/**
 * Whether this browser can hand us a real WebGPU device.
 *
 * `navigator.gpu` is the only synchronous signal, and its ABSENCE is conclusive:
 * no entry point, no device, ever. (Its presence is not conclusive — the adapter
 * request can still fail — but that resolves asynchronously, long after the
 * engine has had to commit to a material pipeline.)
 */
const webGpuAvailable = (): boolean => {
    try {
        return typeof navigator !== 'undefined' && navigator.gpu !== undefined;
    } catch {
        return false;
    }
};

/**
 * Downgrade a 'webgpu' pick to 'webgl' on a browser with no WebGPU at all.
 *
 * WITHOUT THIS the engine still constructs a `WebGPURenderer`, which does not
 * fail — it silently initialises three's WebGL2 FALLBACK backend and keeps
 * running, so `getActiveRendererType()` stays 'webgpu' and every material
 * factory keeps building TSL NodeMaterials. The whole scene then renders through
 * three's TSL→GLSL3 code generator instead of the classic material pipeline.
 *
 * That path is a real code path with real users (it is what every pre-26 iOS
 * Safari runs today), but it is generated GLSL constrained by WebGL2 limits the
 * WebGPU pipeline was not written against — most sharply the per-material
 * uniform block, which desktop and Apple GPUs cap at 64 KB but many Android GPUs
 * cap at the GLES3 minimum of 16 KB. When a generated shader trips a limit, the
 * materials using it link-fail and their meshes draw NOTHING while the rest of
 * the frame carries on. Reported from the field on a Mali-G72 / Android 10
 * phone: skybox and particles (unlit `MeshBasicNodeMaterial` / `PointsMaterial`,
 * tiny uniform blocks) drew fine, and every voxel — terrain, props, characters,
 * all `MeshLambertNodeMaterial` — was invisible.
 *
 * There is no upside to the fallback backend to weigh against this: it is the
 * WebGPU material pipeline running on WebGL2 either way. Picking 'webgl'
 * up front runs the SAME GPU through the classic renderer, which is the
 * better-supported path (hand-written GLSL, no TSL uniform packing) and the one
 * the creator's WebGL mode exercises daily.
 *
 * Applies to the explicit `?renderer=webgpu` override too — on a browser with no
 * `navigator.gpu` that override cannot produce WebGPU, only the fallback backend
 * it is asking not to be on.
 */
const withoutUnavailableWebGpu = (type: RendererType): RendererType => {
    if (type !== 'webgpu' || webGpuAvailable()) return type;
    console.warn(
        '[Renderer] webgpu requested but this browser has no WebGPU (navigator.gpu is undefined) — ' +
        'using the classic WebGL renderer. Constructing WebGPURenderer here would fall back to ' +
        "three's WebGL2 backend and keep the TSL material pipeline, which drops meshes on GPUs " +
        'with tight WebGL2 uniform limits.',
    );
    return 'webgl';
};

// Initial renderer pick reads, in order:
//   1. ?renderer= URL param — explicit override; the creator iframe sets this
//      because creator and game live on different ports / origins, and lab/dev
//      tooling uses it too.
//   2. <meta name="bm:renderer" content="..."> — baked into published game
//      bundles by PublishController so the published game uses the renderer
//      the creator chose at publish time.
//   3. same-origin localStorage — per-user persistence for direct game loads.
//   4. DEFAULT_RENDERER_TYPE — env-configured fallback (VITE_DEFAULT_RENDERER),
//      defaults to 'webgpu'.
// Whatever wins is then gated on the browser actually having WebGPU — see
// `withoutUnavailableWebGpu`.
export const readInitialRendererType = (): RendererType =>
    withoutUnavailableWebGpu(readRequestedRendererType());

const readRequestedRendererType = (): RendererType => {
    try {
        const fromQuery = new URLSearchParams(window.location.search).get('renderer');
        if (fromQuery === 'webgpu' || fromQuery === 'webgl') return fromQuery;
    } catch {
        // window/URL unavailable — fall through to meta tag
    }
    try {
        const meta = document.querySelector('meta[name="bm:renderer"]');
        const content = meta?.getAttribute('content');
        if (content === 'webgpu' || content === 'webgl') return content;
    } catch {
        // document unavailable — fall through to localStorage
    }
    try {
        const stored = localStorage.getItem(RENDERER_TYPE_STORAGE_KEY);
        if (stored === 'webgpu' || stored === 'webgl') return stored;
    } catch {
        // localStorage unavailable — fall through to env default
    }
    return DEFAULT_RENDERER_TYPE;
};

// Persist the requested type and reload with ?renderer= so the engine
// constructs into the new backend cleanly (no stale-material crashes).
export const reloadIntoRendererType = (type: RendererType): void => {
    try {
        localStorage.setItem(RENDERER_TYPE_STORAGE_KEY, type);
    } catch {
        // localStorage unavailable (private mode etc.) — the URL param still takes effect
    }
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('renderer', type);
        window.location.replace(url.toString());
    } catch (err) {
        console.error('Renderer reload failed:', err);
    }
};
