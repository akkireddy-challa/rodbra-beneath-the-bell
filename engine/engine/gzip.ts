import { gzipSync, gunzipSync } from 'fflate';

/**
 * Gzip / gunzip helpers with a pure-JS fallback.
 *
 * The native Compression Streams API (`CompressionStream` /
 * `DecompressionStream`) is fast and streaming, but only shipped in iOS Safari
 * / WebKit 16.4. Older iOS devices (and some embedded WebViews) throw
 * `ReferenceError: Can't find variable: DecompressionStream` when loading a
 * gzipped VXL / VWLD / scene blob, which makes every compressed asset fail to
 * load. We feature-detect and fall back to fflate's synchronous codec, which
 * runs everywhere. fflate is bundled (not externalized) so it works offline
 * and without an import map.
 *
 * Inputs are typed-array views (often a subarray over a larger ArrayBuffer);
 * both the native and fflate paths honour the view's offset/length.
 */
export async function gzip(input: Uint8Array): Promise<Uint8Array> {
    if (typeof CompressionStream !== 'undefined') {
        const stream = new Blob([input as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return gzipSync(input);
}

export async function gunzip(input: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return gunzipSync(input);
}
