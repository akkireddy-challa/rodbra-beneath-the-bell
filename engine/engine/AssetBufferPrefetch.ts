/**
 * Sliding-window prefetch for the scenery build's asset downloads.
 *
 * The env-object loop fetches one asset, builds its meshes, then fetches the next — so
 * every download's latency is paid with the main thread idle and the network idle during
 * every build. Measured on a forged circuit: ~1.7s of a 4765ms scenery build was nothing
 * but serialized round-trips.
 *
 * Why a WINDOW and not `Promise.all` over every asset. Fetching them all at once would
 * hide all the latency and hold every decoded buffer in memory simultaneously — on the
 * platform this whole area exists to keep alive, that trades a second of load time for the
 * one resource that actually kills the tab. A window of N keeps at most N buffers resident
 * while still overlapping downloads with the build work, which is where the time goes.
 *
 * Buffers are handed over on `take` and dropped from the queue, so a consumed asset is
 * owned solely by its caller and can be released as soon as that caller is done.
 */

/**
 * How many downloads run ahead of the consumer. Small on purpose: the win comes from
 * overlapping fetch with build at all, and the returns flatten quickly while the memory
 * cost stays strictly linear.
 */
export const DEFAULT_PREFETCH_AHEAD = 3;

/**
 * Window for THIS device: `?prefetch=N` for measurement, else the quality tier's answer.
 * The bottom rungs ask for ONE — exactly the old sequential behaviour, no extra buffer
 * resident — because a device being killed during load cannot spend memory to buy latency,
 * and the scenery build is where memory is tightest.
 */
export function prefetchAheadFor(fallback: number): number {
    try {
        const raw = new URLSearchParams(window.location.search).get('prefetch');
        if (raw !== null) {
            const n = Number.parseInt(raw, 10);
            if (Number.isFinite(n) && n >= 1) return n;
        }
    } catch { /* no window (tests, workers) */ }
    return fallback;
}

/** The subset of an object definition and an asset record this needs. */
interface HasAssetId { assetId?: string }
interface AssetLike { url?: string; type?: string }

/**
 * A prefetcher for the vxl assets a scenery build is about to need, in the order it will
 * need them. Kept here rather than at the call site so the derivation and the fetch stay
 * next to the queue whose behaviour they feed — and so the scenery file, which is at its
 * line cap, carries one call instead of twenty lines.
 *
 * One entry per TYPE, taken from its first object that names an asset, mirroring how the
 * loop itself picks. Non-vxl and unresolvable ids drop out; duplicates are harmless.
 */
export function prefetchVxlAssets(
    defsByType: Iterable<HasAssetId[]>,
    resolveAsset: (assetId: string) => AssetLike | null | undefined,
    resolveUrl: (url: string) => string,
    ahead: number = DEFAULT_PREFETCH_AHEAD,
): AssetBufferPrefetch {
    const urls: string[] = [];
    for (const defs of defsByType) {
        const id = defs.find((d) => d.assetId)?.assetId;
        const asset = id ? resolveAsset(id) : null;
        if (asset?.url && asset.type === 'vxl') urls.push(asset.url);
    }
    return new AssetBufferPrefetch(urls, async (url) => {
        const response = await fetch(resolveUrl(url));
        if (!response.ok) {
            console.warn(`⚠️ Failed to fetch VXL asset: ${response.status} ${response.statusText}`);
            return null;
        }
        return response.arrayBuffer();
    }, ahead);
}

export type BufferFetcher = (url: string) => Promise<ArrayBuffer | null>;

export class AssetBufferPrefetch {
    private readonly inflight = new Map<string, Promise<ArrayBuffer | null>>();
    private readonly queue: string[];
    private cursor = 0;

    /**
     * @param urls   Asset URLs in the order the consumer expects to need them. Duplicates
     *               are fine — one fetch is shared by every consumer of that URL.
     * @param fetcher How to fetch one URL. Injected so this module needs no knowledge of
     *               asset maps, and so tests need no network.
     */
    constructor(
        urls: string[],
        private readonly fetcher: BufferFetcher,
        private readonly ahead: number = DEFAULT_PREFETCH_AHEAD,
    ) {
        this.queue = [...urls];
        this.fill();
    }

    /**
     * The buffer for `url`, waiting on it only if it has not landed yet.
     *
     * Starts the fetch on the spot if the consumer has outrun the window or asks for
     * something that was never queued — the queue is a HINT about order, and a consumer
     * that skips entries (an unregistered type, a failed one) must still work.
     */
    async take(url: string): Promise<ArrayBuffer | null> {
        const pending = this.inflight.get(url) ?? this.start(url);
        this.inflight.delete(url);
        // Refill only after removing, so the window counts buffers still held here rather
        // than every fetch ever started.
        this.fill();
        return pending;
    }

    /** Abandon anything still queued. The in-flight requests themselves are not cancelled. */
    dispose(): void {
        this.inflight.clear();
        this.cursor = this.queue.length;
        this.queue.length = 0;
    }

    private start(url: string): Promise<ArrayBuffer | null> {
        // Never rejects: a failed asset is one missing prop, and the scenery loop already
        // degrades per type. A rejection here would instead surface at whichever `take`
        // happened to be awaiting it, which may be a different type entirely.
        const p = this.fetcher(url).catch((err) => {
            console.warn(`[AssetBufferPrefetch] fetch failed for ${url}:`, err);
            return null;
        });
        this.inflight.set(url, p);
        return p;
    }

    private fill(): void {
        while (this.inflight.size < this.ahead && this.cursor < this.queue.length) {
            const url = this.queue[this.cursor++]!;
            if (!this.inflight.has(url)) this.start(url);
        }
    }
}
