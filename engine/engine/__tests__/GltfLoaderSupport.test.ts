/**
 * The GLTF loader factory's state machine.
 *
 * WHAT THIS CAN AND CANNOT CHECK. Every `three/addons/*` import is replaced under Jest by one
 * recursive proxy (`src/engine/__mocks__/three-addons.cjs`), so `new GLTFLoader()`,
 * `new KTX2Loader()` and `loader.setKTX2Loader(x)` all return the same stub object. Any
 * assertion about which loader ended up attached to which — including "all of them share one
 * KTX2 instance", the property most worth having — passes whether the code is right or wrong.
 * Writing those would be theatre, so this covers only the part that is genuinely observable:
 * whether the module believes a renderer has reported its formats, and that handing out a
 * loader never throws in either state. The attachment itself is exercised for real by any
 * scene that loads a GLB.
 */
import { REVISION } from 'three';
import {
    createGltfLoader, initGltfLoaderSupport, gltfLoaderSupportsKtx2, disposeGltfLoaderSupport,
    gltfLoadersAwaitingKtx2, gltfTranscoderPath, setGltfTranscoderPath,
    type KtxCapableRenderer,
} from 'engine/loaders/GltfLoaderSupport.js';

/** Enough of a renderer for `detectSupport` to answer without a GPU. */
function fakeRenderer(kind: 'webgpu' | 'webgl'): KtxCapableRenderer {
    const base = { dispose: () => undefined };
    return (kind === 'webgpu'
        ? { ...base, isWebGPURenderer: true, hasFeature: () => false }
        : { ...base, extensions: { has: () => false, get: () => null } }
    ) as unknown as KtxCapableRenderer;
}

/** '185' from three's own `REVISION`, however it is suffixed ('185dev'). */
const THREE_MINOR = String(REVISION).replace(/\D+.*$/, '');

/** Read before any test can move it, so every test can put it back. */
const DEFAULT_TRANSCODER_PATH = gltfTranscoderPath();

afterEach(() => {
    disposeGltfLoaderSupport();
    setGltfTranscoderPath(DEFAULT_TRANSCODER_PATH);
});

describe('GLTF loader support', () => {
    it('reports no KTX2 support until a renderer has been seen', () => {
        expect(gltfLoaderSupportsKtx2()).toBe(false);
    });

    it('still hands out a loader before a renderer has been seen', () => {
        // Ordinary GLBs — the overwhelming majority — must keep loading during boot, even
        // though the WebGPU device (and so the format list) does not exist yet.
        expect(() => createGltfLoader()).not.toThrow();
    });

    for (const kind of ['webgpu', 'webgl'] as const) {
        it(`reports support once a ${kind} renderer has reported its formats`, () => {
            initGltfLoaderSupport(fakeRenderer(kind));
            expect(gltfLoaderSupportsKtx2()).toBe(true);
            expect(() => createGltfLoader()).not.toThrow();
        });
    }

    it('tolerates being initialised twice for the same renderer', () => {
        // GameEngine calls this from renderer creation, which a backend switch repeats.
        const renderer = fakeRenderer('webgpu');
        initGltfLoaderSupport(renderer);
        expect(() => initGltfLoaderSupport(renderer)).not.toThrow();
        expect(gltfLoaderSupportsKtx2()).toBe(true);
    });

    it('re-detects for a different renderer', () => {
        initGltfLoaderSupport(fakeRenderer('webgpu'));
        expect(() => initGltfLoaderSupport(fakeRenderer('webgl'))).not.toThrow();
        expect(gltfLoaderSupportsKtx2()).toBe(true);
    });

    it('stops claiming support once disposed', () => {
        initGltfLoaderSupport(fakeRenderer('webgl'));
        disposeGltfLoaderSupport();
        expect(gltfLoaderSupportsKtx2()).toBe(false);
    });
});

/**
 * `GameEngine` builds `this.loader` in its constructor and only calls
 * `initGltfLoaderSupport` once the renderer exists — an `await init()` later on
 * WebGPU. Attaching only at construction made that shared loader permanently
 * KTX2-blind, which is every NPC and prop in the game: the catalogue's low-poly
 * characters are REQUIRED to carry KTX2, and failed with
 * "setKTX2Loader must be called before loading KTX2 textures".
 *
 * The attachment cannot be observed under Jest (see this file's header), but the
 * queue that performs it can, and it moves in both directions.
 */
describe('a loader built before the device still gets KTX2', () => {
    it('queues an early loader and drains the queue when the renderer arrives', () => {
        createGltfLoader();
        expect(gltfLoadersAwaitingKtx2()).toBe(1);

        initGltfLoaderSupport(fakeRenderer('webgpu'));

        expect(gltfLoadersAwaitingKtx2()).toBe(0);
        expect(gltfLoaderSupportsKtx2()).toBe(true);
    });

    it('queues nothing once the renderer has been seen', () => {
        initGltfLoaderSupport(fakeRenderer('webgl'));
        createGltfLoader();
        // Attached on the spot, so nothing is held — the set must not grow for the
        // lifetime of the engine.
        expect(gltfLoadersAwaitingKtx2()).toBe(0);
    });

    it('forgets queued loaders on dispose, so a teardown cannot leak them', () => {
        // One loader, not several: the addon mock hands back the same proxy for every
        // `new GLTFLoader()`, so a Set of them collapses to one however many are made.
        // Counting is a mock artifact; emptying is the property under test.
        createGltfLoader();
        expect(gltfLoadersAwaitingKtx2()).toBeGreaterThan(0);
        disposeGltfLoaderSupport();
        expect(gltfLoadersAwaitingKtx2()).toBe(0);
    });
});

/**
 * `import.meta.url`-relative resolution — three's default, and what this module used to
 * rely on — cannot work in a CLI project: the scaffold's import map points
 * `three/examples/jsm/` at esm.sh, so the relative path lands on an esm.sh URL that
 * answers `408 timeout, the module is waiting to be built` forever, because esm.sh
 * transforms ES modules and the transcoder is an emscripten UMD blob. Three fetches it as
 * text and splices it into a Blob worker, so the failure is a SyntaxError in `blob:` that
 * no caller can catch.
 */
describe('the Basis transcoder is fetched from somewhere that actually serves it', () => {
    it('pins the transcoder to the running three, so the two cannot drift', () => {
        // A three upgrade must carry its matching transcoder; a hardcoded version would not.
        expect(gltfTranscoderPath()).toContain(`three@0.${THREE_MINOR}/`);
        expect(gltfTranscoderPath()).toMatch(/\/examples\/jsm\/libs\/basis\/$/);
    });

    it('reads from a CDN that serves package files verbatim, not one that transforms them', () => {
        // esm.sh is where this breaks; jsdelivr serves the raw file.
        expect(gltfTranscoderPath()).toContain('cdn.jsdelivr.net');
        expect(gltfTranscoderPath()).not.toContain('esm.sh');
    });

    it('can be pointed at a self-hosted copy', () => {
        setGltfTranscoderPath('/basis/');
        expect(gltfTranscoderPath()).toBe('/basis/');
        expect(() => initGltfLoaderSupport(fakeRenderer('webgl'))).not.toThrow();
    });
});
