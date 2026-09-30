import { normalizeReadbackPixels } from 'engine/OffscreenRender.js';

// Build a width*height RGBA buffer where every pixel in image-row `r`
// (counting from the TOP of the image) has red channel = marker(r). Rows are
// laid out per the given backend convention so we can assert normalization
// reconstructs a tightly-packed, top-down image.
const marker = (row: number) => (row + 1) * 10;

describe('normalizeReadbackPixels', () => {
    // gl.readPixels (classic WebGLRenderer and the WebGL2 fallback backend of
    // WebGPURenderer) returns tightly-packed rows, bottom-up.
    it('flips bottom-up WebGL readback to top-down without assuming row padding', () => {
        const width = 3; // rowBytes = 12, deliberately NOT a multiple of 256
        const height = 2;
        const rowBytes = width * 4;
        const raw = new Uint8Array(rowBytes * height);
        // Bottom-up: memory row 0 = bottom image row (height-1), last = top (0).
        for (let memRow = 0; memRow < height; memRow += 1) {
            const imageRow = height - 1 - memRow;
            for (let px = 0; px < width; px += 1) {
                raw[memRow * rowBytes + px * 4] = marker(imageRow);
            }
        }

        const out = normalizeReadbackPixels(raw, width, height, 'webgl');

        expect(out.length).toBe(rowBytes * height);
        // Output must be top-down: image-row 0 first, image-row 1 next.
        expect(out[0 * rowBytes]).toBe(marker(0));
        expect(out[1 * rowBytes]).toBe(marker(1));
    });

    // WebGPU backend returns rows padded to a 256-byte stride, top-down.
    it('strips 256-byte row padding from WebGPU readback without flipping', () => {
        const width = 3;
        const height = 2;
        const rowBytes = width * 4;
        const alignedRowBytes = Math.ceil(rowBytes / 256) * 256; // 256
        const raw = new Uint8Array(alignedRowBytes * height);
        // Top-down: memory row r = image row r, padded to 256 bytes.
        for (let imageRow = 0; imageRow < height; imageRow += 1) {
            for (let px = 0; px < width; px += 1) {
                raw[imageRow * alignedRowBytes + px * 4] = marker(imageRow);
            }
        }

        const out = normalizeReadbackPixels(raw, width, height, 'webgpu');

        expect(out.length).toBe(rowBytes * height);
        expect(out[0 * rowBytes]).toBe(marker(0));
        expect(out[1 * rowBytes]).toBe(marker(1));
    });
});
