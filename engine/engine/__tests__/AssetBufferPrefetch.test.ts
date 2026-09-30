/**
 * The scenery build's asset prefetch.
 *
 * Two properties matter and neither is visible at runtime. The WINDOW is the whole reason
 * this is not a `Promise.all`: exceeding it would hide the same latency while holding
 * every decoded asset in memory at once, which on a phone trades a second of load time
 * for the resource that actually kills the tab — and it would look like a pure win in
 * every desktop measurement. The other is that the queue is only a HINT about order: the
 * scenery loop skips types (unregistered, failed, non-vxl), so a consumer that asks out of
 * order, or for something never queued, must still get its buffer.
 */
import { AssetBufferPrefetch, DEFAULT_PREFETCH_AHEAD, prefetchVxlAssets } from 'engine/AssetBufferPrefetch.js';

/** A fetcher that records call order and resolves only when told to. */
function controllable() {
    const started: string[] = [];
    const resolvers = new Map<string, (b: ArrayBuffer | null) => void>();
    const fetcher = (url: string): Promise<ArrayBuffer | null> => {
        started.push(url);
        return new Promise((resolve) => resolvers.set(url, resolve));
    };
    const settle = (url: string, bytes = 4): void => {
        resolvers.get(url)?.(new ArrayBuffer(bytes));
        resolvers.delete(url);
    };
    return { started, fetcher, settle };
}

const urls = (n: number): string[] => Array.from({ length: n }, (_, i) => `asset-${i}.vxl`);

describe('AssetBufferPrefetch', () => {
    it('starts only a window of fetches, not all of them', () => {
        const c = controllable();
        new AssetBufferPrefetch(urls(10), c.fetcher, 3);
        // The memory bound. Ten assets queued, three downloads resident.
        expect(c.started).toEqual(['asset-0.vxl', 'asset-1.vxl', 'asset-2.vxl']);
    });

    it('advances the window as buffers are taken, not as they arrive', async () => {
        // Arriving does not free the memory — the buffer sits here until a consumer takes
        // it. Refilling on arrival would let the resident set grow past the window.
        const c = controllable();
        const p = new AssetBufferPrefetch(urls(10), c.fetcher, 3);
        c.settle('asset-0.vxl');
        c.settle('asset-1.vxl');
        await Promise.resolve();
        expect(c.started).toHaveLength(3);

        await p.take('asset-0.vxl');
        expect(c.started).toEqual([
            'asset-0.vxl', 'asset-1.vxl', 'asset-2.vxl', 'asset-3.vxl',
        ]);
    });

    it('fetches on demand when the consumer outruns the window', async () => {
        // The scenery loop skips types, so it can ask for something the window has not
        // reached. That must work rather than deadlock waiting for a fetch never started.
        const c = controllable();
        const p = new AssetBufferPrefetch(urls(10), c.fetcher, 2);
        const pending = p.take('asset-7.vxl');
        expect(c.started).toContain('asset-7.vxl');
        c.settle('asset-7.vxl', 16);
        expect((await pending)?.byteLength).toBe(16);
    });

    it('serves a URL that was never queued at all', async () => {
        const c = controllable();
        const p = new AssetBufferPrefetch([], c.fetcher, 3);
        const pending = p.take('surprise.vxl');
        c.settle('surprise.vxl', 8);
        expect((await pending)?.byteLength).toBe(8);
    });

    it('shares one fetch between repeats of the same URL', async () => {
        // Several object types commonly point at the same asset. Fetching it twice would
        // cost a download and hold two copies.
        const c = controllable();
        const p = new AssetBufferPrefetch(['same.vxl', 'same.vxl', 'other.vxl'], c.fetcher, 3);
        expect(c.started.filter((u) => u === 'same.vxl')).toHaveLength(1);
        c.settle('same.vxl');
        await p.take('same.vxl');
        expect(c.started.filter((u) => u === 'same.vxl')).toHaveLength(1);
    });

    it('resolves null instead of rejecting when a fetch throws', async () => {
        // A rejection would surface at whichever take happened to await it — possibly a
        // different type than the one that failed. One missing prop must stay one missing
        // prop.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const p = new AssetBufferPrefetch(['bad.vxl'], async () => { throw new Error('offline'); }, 1);
        await expect(p.take('bad.vxl')).resolves.toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('defaults to a small window', () => {
        // Documented as a value, so a change to it is a deliberate edit rather than drift.
        expect(DEFAULT_PREFETCH_AHEAD).toBe(3);
    });
});

describe('prefetchVxlAssets', () => {
    const assets: Record<string, { url?: string; type?: string }> = {
        tree: { url: 'tree.vxl', type: 'vxl' },
        rock: { url: 'rock.vxl', type: 'vxl' },
        sign: { url: 'sign.glb', type: 'glb' },
        broken: { type: 'vxl' },
    };
    const resolve = (id: string) => assets[id] ?? null;
    const identity = (u: string) => u;

    it('queues one url per type, in order, skipping what the loop would not fetch', () => {
        const started: string[] = [];
        const realFetch = global.fetch;
        global.fetch = (async (u: string) => {
            started.push(u);
            return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
        }) as never;
        try {
            prefetchVxlAssets(
                [
                    [{ assetId: 'tree' }, { assetId: 'rock' }], // first-with-asset wins
                    [{ assetId: 'sign' }],                      // not vxl
                    [{}],                                       // no asset at all
                    [{ assetId: 'broken' }],                    // vxl but no url
                    [{ assetId: 'rock' }],
                ],
                resolve,
                identity,
            );
            // Window is 3, but only two entries survive the filter.
            expect(started).toEqual(['tree.vxl', 'rock.vxl']);
        } finally {
            global.fetch = realFetch;
        }
    });

    it('maps the url through the bundled-asset lookup before fetching', async () => {
        // Published bundles rewrite asset urls; fetching the raw one 404s.
        let asked = '';
        const realFetch = global.fetch;
        global.fetch = (async (u: string) => {
            asked = u;
            return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
        }) as never;
        try {
            const p = prefetchVxlAssets([[{ assetId: 'tree' }]], resolve, () => 'bundled/tree.vxl');
            await p.take('tree.vxl');
            expect(asked).toBe('bundled/tree.vxl');
        } finally {
            global.fetch = realFetch;
        }
    });
});
