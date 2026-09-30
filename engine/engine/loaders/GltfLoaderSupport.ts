/**
 * One place that knows how to build a GLTFLoader, so every GLB in the engine decodes the
 * same set of formats.
 *
 * WHY THIS EXISTS. `new GLTFLoader()` appeared at a dozen call sites — environment objects,
 * animals, splat overlays, the voxelizer, the editor's preview panes — and each one decoded
 * whatever the bare loader happens to support. That was invisible while every GLB carried
 * plain PNG textures. It stops being invisible the moment one carries a KTX2 texture: the
 * loader throws on the `KHR_texture_basisu` extension unless a KTX2Loader is attached, so
 * "does this asset load" would depend on which call site happened to fetch it. A shared
 * factory makes that one decision instead of thirteen.
 *
 * WHY KTX2. A base colour map is the largest thing most assets own, and PNG says nothing
 * about what the GPU stores: a 2048² map is ~16 MB of video memory however small the file
 * was. KTX2 with Basis Universal transcodes to whatever compressed format the device
 * actually has, which is roughly a quarter of that, and carries its own mip chain. This
 * module is only the READ side — nothing here encodes — but nothing downstream (per-asset
 * texture variants, a resolution the player or the device tier can change) can be built
 * until the engine can load the format at all.
 *
 * THE TRANSCODER IS FETCHED FROM A CDN, and it has to be. `KTX2Loader` otherwise resolves it
 * through `new URL('../libs/basis/…', import.meta.url)`, which this file used to claim every
 * bundler here follows into its own asset graph. Nothing in this repository has ever served
 * those two files, in any lane — the claim was never exercised, because until the character
 * catalogue shipped, no asset used the format.
 *
 * In a CLI project it cannot work even in principle. The scaffold's import map points
 * `three/examples/jsm/` at esm.sh (`cli/src/scaffold/project-files.ts`), so `import.meta.url`
 * is an esm.sh URL and the relative path lands on
 * `https://esm.sh/*three@x/es2022/examples/jsm/libs/basis/basis_transcoder.js`, which answers
 * `408 timeout, the module is waiting to be built` for good: esm.sh transforms ES modules, and
 * this is an emscripten UMD blob it can never build. `KTX2Loader` fetches the file as TEXT and
 * splices it into a Blob worker, so the error surfaces as a SyntaxError inside `blob:` —
 * outside any caller's try/catch, which is how one unreadable NPC took the whole boot down.
 *
 * jsDelivr serves package files verbatim, which is exactly what is needed. The version comes
 * from three's own `REVISION`, so the transcoder cannot drift from the runtime that uses it.
 * This does trade the "no CDN to be down" property the old comment claimed — but that property
 * was imaginary, and a published single-file bundle has nowhere local to read these from
 * anyway. `setGltfTranscoderPath` exists for a deployment that would rather self-host.
 *
 * ORDERING, AND WHY IT IS NOT THE CALLER'S PROBLEM. `detectSupport` asks the renderer which
 * compressed formats exist, so it needs a live device. On WebGL that is true the moment the
 * renderer is constructed; on WebGPU only after `init()` resolves, which is why `GameEngine`
 * calls this from inside that same async block.
 *
 * `GameEngine` builds its shared loader in the CONSTRUCTOR, long before either. Attaching
 * KTX2 only at construction therefore left `engine.loader` — the loader every NPC, prop and
 * animal goes through — permanently unable to read the extension, however late the asset was
 * fetched. It surfaced as `setKTX2Loader must be called before loading KTX2 textures` on the
 * first catalogue character, an asset class that is REQUIRED to be KTX2, and was silent
 * before that only because nothing shipped the format.
 *
 * So loaders handed out early are remembered and wired up when the device appears. Three
 * reads `ktx2Loader` at parse time, not at construction, so this is enough: boot order can no
 * longer decide whether an asset is readable.
 */

import { REVISION } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

/**
 * Where `basis_transcoder.js` and `.wasm` are read from.
 *
 * Derived from the running three's own `REVISION` ('185' -> `three@0.185`), so a three upgrade
 * carries its matching transcoder with it and the two cannot fall out of step. jsDelivr
 * resolves the range to the newest matching patch.
 */
function defaultTranscoderPath(): string {
    const revision = String(REVISION).replace(/\D+.*$/, '');
    return `https://cdn.jsdelivr.net/npm/three@0.${revision}/examples/jsm/libs/basis/`;
}

let transcoderPath = defaultTranscoderPath();

/**
 * Point the transcoder somewhere else — a self-hosted copy, or a test.
 *
 * Must be called before the first `initGltfLoaderSupport`; after that the shared loader has
 * already been told. The path is a DIRECTORY: three appends `basis_transcoder.js` and
 * `basis_transcoder.wasm` to it.
 */
export function setGltfTranscoderPath(path: string): void {
    transcoderPath = path;
    sharedKtx2?.setTranscoderPath(path);
}

/** Where the transcoder will be read from — for tests and diagnostics. */
export function gltfTranscoderPath(): string {
    return transcoderPath;
}

/**
 * Minimal shape of the renderers `KTX2Loader.detectSupport` accepts.
 *
 * `dispose` is here to give the type a REQUIRED member. Both backends have one, and without
 * it an all-optional interface structurally matches nothing — TypeScript rejects a concrete
 * `WebGLRenderer` for having "no properties in common".
 */
export interface KtxCapableRenderer {
    /** Present on WebGPURenderer only; `detectSupport` branches on it. */
    readonly isWebGPURenderer?: boolean;
    dispose(): void;
}

/**
 * Shared across every loader this module hands out.
 *
 * One instance, because it owns a worker pool and a compiled transcoder: a per-call-site
 * loader would spawn a pool each and re-fetch the wasm each.
 */
let sharedKtx2: KTX2Loader | null = null;

/** Guards against a second `detectSupport` on the same renderer (recreate is legitimate). */
let detectedFor: KtxCapableRenderer | null = null;

/**
 * Loaders handed out before the device existed, waiting to be told about KTX2.
 *
 * `GameEngine` builds its shared loader in the constructor and only reaches
 * `initGltfLoaderSupport` once the renderer is up — on WebGPU, an `await init()`
 * later. Attaching only at construction left that loader permanently unable to
 * read the extension, which is every NPC and every other GLB that goes through
 * `engine.loader`. Populated only during that window and cleared when it closes,
 * so this holds nothing after boot.
 */
const awaitingKtx2 = new Set<GLTFLoader>();

/**
 * Teach the shared loader what this renderer can decompress. Idempotent per renderer.
 *
 * Call once the GPU device exists. Safe to call again after the renderer is recreated —
 * switching backend changes the answer, and the transcoder itself is kept.
 */
export function initGltfLoaderSupport(renderer: KtxCapableRenderer): void {
    if (detectedFor === renderer) return;
    if (sharedKtx2 === null) {
        sharedKtx2 = new KTX2Loader();
        // Before detectSupport and before any load: the path is read when the transcoder is
        // first fetched, and that can be triggered by the very next GLB.
        sharedKtx2.setTranscoderPath(transcoderPath);
    }
    // Typed loosely on purpose: three types this as WebGPURenderer|WebGLRenderer, and the
    // engine's own renderer field is a union that does not narrow to either.
    (sharedKtx2 as unknown as { detectSupport(r: unknown): unknown }).detectSupport(renderer);
    detectedFor = renderer;
    // Retrofit the boot-time loaders. Three reads `ktx2Loader` when it parses a
    // file, not when the loader is built, so a loader handed out minutes ago
    // starts decoding KTX2 from its next load.
    for (const loader of awaitingKtx2) loader.setKTX2Loader(sharedKtx2);
    awaitingKtx2.clear();
}

/**
 * A GLTFLoader that decodes everything this engine supports.
 *
 * Use this instead of `new GLTFLoader()`. A loader built before the device
 * exists is remembered and wired up by `initGltfLoaderSupport`, so boot order
 * cannot decide whether an asset is readable — which it did, silently, for
 * anything holding `engine.loader` across startup.
 */
export function createGltfLoader(): GLTFLoader {
    const loader = new GLTFLoader();
    if (sharedKtx2) loader.setKTX2Loader(sharedKtx2);
    else awaitingKtx2.add(loader);
    return loader;
}

/** True once a renderer has reported its formats — for tests and diagnostics. */
export function gltfLoaderSupportsKtx2(): boolean {
    // `detectedFor` alone is the answer: it is only ever set after `sharedKtx2` exists, and
    // dispose clears the two together.
    return detectedFor !== null;
}

/**
 * How many handed-out loaders are still waiting to be told about KTX2 — for tests
 * and diagnostics.
 *
 * The attachment itself cannot be asserted under Jest (see this module's test),
 * but the queue that drives it can: non-zero before a renderer is seen, zero
 * after. A regression in either direction changes this number.
 */
export function gltfLoadersAwaitingKtx2(): number {
    return awaitingKtx2.size;
}

/**
 * Drop the worker pool. Called when the engine tears down; the next
 * `initGltfLoaderSupport` builds a fresh one.
 */
export function disposeGltfLoaderSupport(): void {
    sharedKtx2?.dispose();
    sharedKtx2 = null;
    detectedFor = null;
    awaitingKtx2.clear();
}
