import { fetchVwldBuffer } from 'engine/levels/fetchVwld.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';

describe('fetchVwldBuffer', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        ASSET_MAP.clear();
    });

    test('fetches the original url when nothing is bundled', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
        const spy = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });
        global.fetch = spy as unknown as typeof fetch;

        await expect(fetchVwldBuffer('https://cdn/x.vwld')).resolves.toBe(bytes);
        expect(spy).toHaveBeenCalledWith('https://cdn/x.vwld');
    });

    // Regression guard: a standalone single-file build inlines every level's
    // .vwld as a data URL. Without this lookup the fetch went to the network,
    // so an offline bundle had no world to switch to at all.
    test('prefers the bundled data url when one exists', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
        const spy = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });
        global.fetch = spy as unknown as typeof fetch;
        ASSET_MAP.set('https://cdn/x.vwld', 'data:application/octet-stream;base64,AQIDBA==');

        await fetchVwldBuffer('https://cdn/x.vwld');
        expect(spy).toHaveBeenCalledWith('data:application/octet-stream;base64,AQIDBA==');
    });

    test('throws on HTTP failure', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
        await expect(fetchVwldBuffer('https://cdn/x.vwld')).rejects.toThrow('404');
    });
});
