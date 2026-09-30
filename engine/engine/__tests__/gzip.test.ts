import { gzip, gunzip } from 'engine/gzip.js';
import { gzipSync } from 'fflate';

function sample(): Uint8Array {
    const s = 'voxel-cathedral-' .repeat(500);
    return new Uint8Array([...s].map(c => c.charCodeAt(0)));
}

describe('gzip/gunzip helpers', () => {
    const orig = {
        CompressionStream: (globalThis as any).CompressionStream,
        DecompressionStream: (globalThis as any).DecompressionStream,
    };
    afterEach(() => {
        (globalThis as any).CompressionStream = orig.CompressionStream;
        (globalThis as any).DecompressionStream = orig.DecompressionStream;
    });

    it('round-trips with the native Compression Streams API', async () => {
        const data = sample();
        const out = await gunzip(await gzip(data));
        expect(out).toEqual(data);
    });

    it('round-trips when DecompressionStream is missing (iOS < 16.4 fallback)', async () => {
        // Simulate older WebKit: the native decompressor doesn't exist.
        delete (globalThis as any).DecompressionStream;
        const data = sample();
        const out = await gunzip(await gzip(data));
        expect(out).toEqual(data);
    });

    it('fflate fallback decodes a natively/independently gzipped payload', async () => {
        // Payload produced WITHOUT the native API (fflate), decoded via the
        // fallback path — proves cross-compatibility of the gzip container.
        const data = sample();
        const compressed = gzipSync(data);
        delete (globalThis as any).DecompressionStream;
        const out = await gunzip(compressed);
        expect(out).toEqual(data);
    });

    it('gunzip handles a subarray view (offset into a larger buffer)', async () => {
        const data = sample();
        const compressed = await gzip(data);
        // Place the gzip bytes at a non-zero offset inside a bigger buffer,
        // mirroring `new Uint8Array(buffer, 5)` in the VXL decoders.
        const padded = new Uint8Array(compressed.length + 5);
        padded.set(compressed, 5);
        const view = padded.subarray(5);
        delete (globalThis as any).DecompressionStream;
        const out = await gunzip(view);
        expect(out).toEqual(data);
    });
});
