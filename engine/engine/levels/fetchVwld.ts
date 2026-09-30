import { gunzip } from 'engine/gzip.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';
import { reportWorldSubProgress } from 'engine/progress/LoadProgress.js';
import { profileMark } from 'engine/LoadProfile.js';

/**
 * Fetch a baked level (.vwld) and return the inflated container bytes.
 *
 * A .vwld is uploaded gzipped + served with Content-Encoding: gzip, so the
 * browser normally hands us the inflated container. If a host serves the
 * stored gzip bytes WITHOUT that header, inflate here so the format sniff
 * still works — the container itself is never double-gzipped (v4 chunk blobs
 * are raw; one gzip does all the work).
 *
 * The ASSET_MAP lookup is what makes levels work in a standalone single-file
 * build: without it this went to the network for every level, so an offline
 * bundle had no world at all beyond whatever the boot path had already loaded.
 * Bundled entries are stored STILL GZIPPED (generate-asset-manifest.mjs
 * re-compresses them, because node's fetch transparently inflates the
 * Content-Encoding: gzip response and the inflated container is ~5x larger) —
 * the sniff below is what turns them back into the container bytes.
 *
 * Throws on HTTP failure — callers decide the fallback (boot falls through
 * to the procedural path; a level switch aborts and keeps the old level).
 */
export async function fetchVwldBuffer(url: string): Promise<ArrayBuffer> {
    profileMark('vwld fetch START');
    const resp = await fetch(ASSET_MAP.get(url) ?? url);
    if (!resp.ok) throw new Error(`[fetchVwld] HTTP ${resp.status} for ${url}`);
    let buf = await readBodyWithProgress(resp);
    profileMark('vwld fetch', `${(buf.byteLength / 1048576).toFixed(1)} MB inflated`);
    if (buf.byteLength > 1) {
        const head = new Uint8Array(buf, 0, 2);
        if (head[0] === 0x1f && head[1] === 0x8b) {
            const inflated = await gunzip(new Uint8Array(buf));
            const copy = new Uint8Array(inflated.byteLength);
            copy.set(inflated);
            buf = copy.buffer;
        }
    }
    return buf;
}

/**
 * Drain a response body, feeding byte progress to the main screen's loading
 * bar. reportWorldSubProgress drops reports outside the boot 'world' phase,
 * so level-switch and prefetch fetches through this same helper stay silent.
 * Data URLs (bundled assets) and missing Content-Length fall back to a plain
 * arrayBuffer() — no progress, same bytes.
 */
async function readBodyWithProgress(resp: Response): Promise<ArrayBuffer> {
    // headers/body are capability probes, not error swallowing: minimal
    // Response doubles (tests) and data: URLs lack them, and the contract in
    // both cases is simply "no byte progress".
    const total = Number(resp.headers?.get('content-length') ?? 0);
    if (!resp.body || !Number.isFinite(total) || total <= 0) {
        return resp.arrayBuffer();
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        reportWorldSubProgress('terrain-fetch', loaded / total);
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out.buffer;
}

/**
 * Download a level so the BROWSER caches it, without keeping the bytes.
 *
 * `.vwld` responses are served `cache-control: public, max-age=31536000`, so once a level
 * has been fetched the browser holds it on disk — as the ~4 MB COMPRESSED response, not
 * the ~35 MB inflated container. Warming that cache is therefore the cheap way to overlap
 * a download with whatever the player is doing (picking a car, reading a track name): the
 * later real load reads from disk instead of the network, and nothing is held in the
 * meantime.
 *
 * The body is drained rather than read into an ArrayBuffer. Reading it would materialise
 * the full inflated container just to throw it away, which is the memory cost this exists
 * to avoid; draining decompresses a chunk at a time and retains none of it. It must be
 * drained to completion — cancelling mid-flight can leave the response unstored, which
 * would turn a prefetch into a wasted download.
 *
 * Never throws: a warm that fails simply means the real load pays full price.
 */
export async function warmVwldCache(url: string): Promise<void> {
    // A bundled asset is already local; there is no network fetch to warm.
    if (ASSET_MAP.get(url)) return;
    try {
        const resp = await fetch(url);
        if (!resp.ok || !resp.body) return;
        const reader = resp.body.getReader();
        for (;;) {
            const { done } = await reader.read();
            if (done) break;
        }
    } catch {
        /* offline, aborted, CORS — the real load will report its own failure */
    }
}
