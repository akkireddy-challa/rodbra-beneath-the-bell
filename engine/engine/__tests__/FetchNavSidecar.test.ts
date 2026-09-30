import { fetchNavSidecar } from 'engine/levels/fetchNavSidecar.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';

describe('fetchNavSidecar', () => {
    const originalFetch = global.fetch;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        global.fetch = originalFetch;
        ASSET_MAP.clear();
        warnSpy.mockRestore();
    });

    // Regression guard: a standalone single-file build inlines each level's
    // navmesh sidecar; without this lookup every offline level switch degraded
    // to "no prebuilt navmesh".
    test('prefers the bundled data url when one exists', async () => {
        const spy = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        });
        global.fetch = spy as unknown as typeof fetch;
        ASSET_MAP.set('http://x/nav.bin', 'data:application/octet-stream;base64,AQIDBA==');

        await fetchNavSidecar('http://x/nav.bin');
        expect(spy).toHaveBeenCalledWith('data:application/octet-stream;base64,AQIDBA==');
    });

    test('happy path resolves the fetched ArrayBuffer', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => bytes,
        }) as unknown as typeof fetch;

        const result = await fetchNavSidecar('http://x/nav.bin');
        expect(result).toBe(bytes);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('HTTP error resolves null and warns once', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 404,
        }) as unknown as typeof fetch;

        const result = await fetchNavSidecar('http://x/missing.bin');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('http://x/missing.bin');
    });

    test('network throw resolves null and warns once', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('net down')) as unknown as typeof fetch;

        const result = await fetchNavSidecar('http://x/nav.bin');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('http://x/nav.bin');
    });

    test('empty body resolves null and warns once', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(0),
        }) as unknown as typeof fetch;

        const result = await fetchNavSidecar('http://x/empty.bin');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('http://x/empty.bin');
    });
});
