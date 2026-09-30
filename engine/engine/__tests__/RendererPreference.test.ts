/**
 * @jest-environment jsdom
 *
 * The pick reads `window.location.search`, a `<meta>` tag, `localStorage` and
 * `navigator.gpu` — all four need a DOM.
 */
import { readInitialRendererType } from 'engine/RendererPreference.js';

/**
 * The renderer pick is a CAPABILITY decision, not just a preference one.
 *
 * `WebGPURenderer` does not fail on a browser without WebGPU — it quietly
 * initialises three's WebGL2 fallback backend, so the engine keeps reporting
 * 'webgpu' and every material factory keeps building TSL NodeMaterials. The
 * scene then runs through generated GLSL bounded by WebGL2 limits, and on a GPU
 * with a 16 KB uniform-block cap the lit materials link-fail and their meshes
 * vanish: reported from a Mali-G72 / Android 10 phone as skybox and particles
 * drawing while every voxel was invisible.
 *
 * So a 'webgpu' pick from ANY source — including the explicit `?renderer=`
 * override, which on such a browser can only select the fallback backend — has
 * to come back as 'webgl'.
 */
describe('readInitialRendererType', () => {
    const setLocation = (search: string): void => {
        Object.defineProperty(window, 'location', {
            value: { search, href: `https://example.test/${search}` },
            writable: true,
            configurable: true,
        });
    };

    /** Present `navigator.gpu` (a real device) or remove it entirely (no WebGPU). */
    const setWebGpu = (available: boolean): void => {
        Object.defineProperty(navigator, 'gpu', {
            value: available ? {} : undefined,
            writable: true,
            configurable: true,
        });
    };

    beforeEach(() => {
        setLocation('');
        localStorage.clear();
        document.head.innerHTML = '';
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('honours a webgpu pick when the browser really has WebGPU', () => {
        setWebGpu(true);
        setLocation('?renderer=webgpu');
        expect(readInitialRendererType()).toBe('webgpu');
    });

    it('downgrades to webgl when navigator.gpu is absent', () => {
        setWebGpu(false);
        setLocation('?renderer=webgpu');
        expect(readInitialRendererType()).toBe('webgl');
    });

    it('downgrades the published-bundle meta tag too — THE FIELD CASE', () => {
        // A game published from a creator on WebGPU bakes bm:renderer=webgpu, and
        // every phone without WebGPU then booted the fallback backend.
        setWebGpu(false);
        document.head.innerHTML = '<meta name="bm:renderer" content="webgpu">';
        expect(readInitialRendererType()).toBe('webgl');
    });

    it('downgrades the stored preference as well', () => {
        setWebGpu(false);
        localStorage.setItem('bm:rendererType', 'webgpu');
        expect(readInitialRendererType()).toBe('webgl');
    });

    it('leaves an explicit webgl pick alone on a WebGPU-capable browser', () => {
        setWebGpu(true);
        setLocation('?renderer=webgl');
        expect(readInitialRendererType()).toBe('webgl');
    });

    it('prefers the URL param over the meta tag, then the meta tag over storage', () => {
        setWebGpu(true);
        document.head.innerHTML = '<meta name="bm:renderer" content="webgl">';
        localStorage.setItem('bm:rendererType', 'webgl');
        setLocation('?renderer=webgpu');
        expect(readInitialRendererType()).toBe('webgpu');

        setLocation('');
        expect(readInitialRendererType()).toBe('webgl');
    });
});
