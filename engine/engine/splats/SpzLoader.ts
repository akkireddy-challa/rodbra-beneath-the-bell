/**
 * SpzLoader — parse a Gaussian-splat `.spz` file into GPU-upload-ready typed
 * arrays for the WebGPU splat renderer.
 *
 * The SPZ container is a gzip stream of tightly packed sections (v3 layout):
 *   header(16B) → centers(9B/splat, 24-bit fixed) → alphas(1B) → rgb(3B)
 *   → scales(3B, log-encoded) → quats(4B, smallest-three) → SH(optional)
 * Decode formulas mirror Spark's `SpzReader` exactly (the same codec the
 * WebGL path uses), so both backends see identical splats:
 *   alpha = b/255                       (linear opacity)
 *   color = (b/255 − 0.5)·(SH_C0/0.15) + 0.5   ([0,1] base colour)
 *   scale = exp(b/16 − 10)              (linear, metres)
 *
 * Output layout (all vec4-strided — WGSL storage arrays of vec3 pad to 16B,
 * so explicit vec4 keeps the JS arrays and the shader views in lockstep):
 *   centers:  (x, y, z, opacity)
 *   covA:     (Σxx, Σxy, Σxz, 0)   — upper triangle of the 3D covariance,
 *   covB:     (Σyy, Σyz, Σzz, 0)     precomputed from quat+scale at load
 *   colorsU32: r | g<<8 | b<<16     — packed 8-bit base colour
 *
 * Spherical harmonics beyond the DC band are skipped for now (flat base
 * colour); the trailing SH section simply isn't read.
 */

/** SPZ header magic ("NGSP" little-endian). */
const SPZ_MAGIC = 1347635022;
const SH_C0 = 0.28209479177387814;
/** Coefficient count per SH degree (vec3 coefficients per splat). */
const SH_DEGREE_TO_VECS: Record<number, number> = { 1: 3, 2: 8, 3: 15 };

export interface GpuSplatData {
    numSplats: number;
    /** vec4 per splat: x, y, z, opacity. */
    centers: Float32Array;
    /** vec4 per splat: cov3d xx, xy, xz, 0. */
    covA: Float32Array;
    /** vec4 per splat: cov3d yy, yz, zz, 0. */
    covB: Float32Array;
    /** u32 per splat: base colour packed r | g<<8 | b<<16. */
    colorsU32: Uint32Array;
    /** Object-space AABB of all splat centers. */
    boundsMin: { x: number; y: number; z: number };
    boundsMax: { x: number; y: number; z: number };
}

/** Decode an IEEE float16 (used by SPZ v1 centers only). */
function fromHalf(h: number): number {
    const sign = (h & 0x8000) ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    if (exp === 0) return sign * frac * 2 ** -24;
    if (exp === 31) return frac ? NaN : sign * Infinity;
    return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/** Gunzip a fetched body into one contiguous byte array. */
async function gunzip(compressed: ArrayBuffer): Promise<Uint8Array> {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([compressed]).stream().pipeThrough(ds);
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
}

/**
 * Parse decompressed SPZ bytes. Throws on bad magic / unsupported version so
 * callers fail loudly instead of rendering garbage.
 */
export function parseSpz(bytes: Uint8Array): GpuSplatData {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== SPZ_MAGIC) throw new Error('Invalid SPZ file (bad magic)');
    const version = view.getUint32(4, true);
    if (version < 1 || version > 3) throw new Error(`Unsupported SPZ version: ${version}`);
    const numSplats = view.getUint32(8, true);
    const shDegree = view.getUint8(12);
    const fractionalBits = view.getUint8(13);

    // Section sizes are fixed per version — verify the buffer is big enough
    // up front so a truncated download fails with a clear message.
    const centerBytes = version === 1 ? numSplats * 6 : numSplats * 9;
    const quatBytes = version === 3 ? numSplats * 4 : numSplats * 3;
    const shBytes = shDegree >= 1 ? numSplats * (SH_DEGREE_TO_VECS[shDegree] ?? 0) * 3 : 0;
    const needed = 16 + centerBytes + numSplats + numSplats * 3 + numSplats * 3 + quatBytes + shBytes;
    if (bytes.length < needed - shBytes) {
        throw new Error(`Truncated SPZ: have ${bytes.length} bytes, need ${needed - shBytes}`);
    }

    const centers = new Float32Array(numSplats * 4);
    const covA = new Float32Array(numSplats * 4);
    const covB = new Float32Array(numSplats * 4);
    const colorsU32 = new Uint32Array(numSplats);
    const boundsMin = { x: Infinity, y: Infinity, z: Infinity };
    const boundsMax = { x: -Infinity, y: -Infinity, z: -Infinity };

    let off = 16;

    // ── Centers ──
    if (version === 1) {
        for (let i = 0; i < numSplats; i++) {
            const x = fromHalf(view.getUint16(off, true));
            const y = fromHalf(view.getUint16(off + 2, true));
            const z = fromHalf(view.getUint16(off + 4, true));
            off += 6;
            const o4 = i * 4;
            centers[o4] = x; centers[o4 + 1] = y; centers[o4 + 2] = z;
        }
    } else {
        const fixed = 1 << fractionalBits;
        for (let i = 0; i < numSplats; i++) {
            // 24-bit signed little-endian fixed point per component.
            const x = ((bytes[off + 2]! << 24 | bytes[off + 1]! << 16 | bytes[off]! << 8) >> 8) / fixed;
            const y = ((bytes[off + 5]! << 24 | bytes[off + 4]! << 16 | bytes[off + 3]! << 8) >> 8) / fixed;
            const z = ((bytes[off + 8]! << 24 | bytes[off + 7]! << 16 | bytes[off + 6]! << 8) >> 8) / fixed;
            off += 9;
            const o4 = i * 4;
            centers[o4] = x; centers[o4 + 1] = y; centers[o4 + 2] = z;
        }
    }
    for (let i = 0; i < numSplats; i++) {
        const o4 = i * 4;
        const x = centers[o4]!, y = centers[o4 + 1]!, z = centers[o4 + 2]!;
        if (x < boundsMin.x) boundsMin.x = x; if (x > boundsMax.x) boundsMax.x = x;
        if (y < boundsMin.y) boundsMin.y = y; if (y > boundsMax.y) boundsMax.y = y;
        if (z < boundsMin.z) boundsMin.z = z; if (z > boundsMax.z) boundsMax.z = z;
    }

    // ── Alphas (linear opacity) → centers.w ──
    for (let i = 0; i < numSplats; i++) {
        centers[i * 4 + 3] = bytes[off + i]! / 255;
    }
    off += numSplats;

    // ── Base colours → packed u32 ──
    // The splat is trained on tonemapped sRGB screenshots, so its colours are
    // display values. The WebGPU pipeline outputs through an sRGB encode, so
    // store linearised values here — the encode round-trips them back to the
    // trained appearance (the splat material itself has tone mapping off).
    {
        const scale = SH_C0 / 0.15;
        const toLinear8 = (c: number): number => {
            const s = Math.max(0, Math.min(1, c));
            const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
            return Math.max(0, Math.min(255, Math.round(lin * 255)));
        };
        for (let i = 0; i < numSplats; i++) {
            const i3 = off + i * 3;
            const r = (bytes[i3]! / 255 - 0.5) * scale + 0.5;
            const g = (bytes[i3 + 1]! / 255 - 0.5) * scale + 0.5;
            const b = (bytes[i3 + 2]! / 255 - 0.5) * scale + 0.5;
            colorsU32[i] = toLinear8(r) | (toLinear8(g) << 8) | (toLinear8(b) << 16);
        }
        off += numSplats * 3;
    }

    // ── Scales (linear, decoded from log bytes) — kept on the stack per splat ──
    const scalesOff = off;
    off += numSplats * 3;

    // ── Quaternions ──
    // v3: smallest-three packing in a u32; v1/v2: xyz bytes with w derived.
    // Decoded inline in the covariance loop below.
    const quatsOff = off;

    const SQRT1_2 = Math.SQRT1_2;
    for (let i = 0; i < numSplats; i++) {
        const so = scalesOff + i * 3;
        const sx = Math.exp(bytes[so]! / 16 - 10);
        const sy = Math.exp(bytes[so + 1]! / 16 - 10);
        const sz = Math.exp(bytes[so + 2]! / 16 - 10);

        let qx: number, qy: number, qz: number, qw: number;
        if (version === 3) {
            const qo = quatsOff + i * 4;
            const combined = (bytes[qo]! | (bytes[qo + 1]! << 8) | (bytes[qo + 2]! << 16) | (bytes[qo + 3]! << 24)) >>> 0;
            const largestIndex = combined >>> 30;
            const q = [0, 0, 0, 0];
            let remaining = combined;
            let sumSquares = 0;
            for (let c = 3; c >= 0; c--) {
                if (c !== largestIndex) {
                    const value = remaining & 511;
                    const sign = (remaining >>> 9) & 1;
                    remaining = remaining >>> 10;
                    let comp = SQRT1_2 * (value / 511);
                    if (sign !== 0) comp = -comp;
                    q[c] = comp;
                    sumSquares += comp * comp;
                }
            }
            q[largestIndex] = Math.sqrt(Math.max(1 - sumSquares, 0));
            qx = q[0]!; qy = q[1]!; qz = q[2]!; qw = q[3]!;
        } else {
            const qo = quatsOff + i * 3;
            qx = bytes[qo]! / 127.5 - 1;
            qy = bytes[qo + 1]! / 127.5 - 1;
            qz = bytes[qo + 2]! / 127.5 - 1;
            qw = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz));
        }

        // Rotation matrix from quaternion, columns scaled: M = R·diag(s).
        const m00 = (1 - 2 * (qy * qy + qz * qz)) * sx;
        const m01 = (2 * (qx * qy - qw * qz)) * sy;
        const m02 = (2 * (qx * qz + qw * qy)) * sz;
        const m10 = (2 * (qx * qy + qw * qz)) * sx;
        const m11 = (1 - 2 * (qx * qx + qz * qz)) * sy;
        const m12 = (2 * (qy * qz - qw * qx)) * sz;
        const m20 = (2 * (qx * qz - qw * qy)) * sx;
        const m21 = (2 * (qy * qz + qw * qx)) * sy;
        const m22 = (1 - 2 * (qx * qx + qy * qy)) * sz;

        // Σ = M·Mᵀ (symmetric 3×3 covariance).
        const o4 = i * 4;
        covA[o4] = m00 * m00 + m01 * m01 + m02 * m02;     // xx
        covA[o4 + 1] = m00 * m10 + m01 * m11 + m02 * m12; // xy
        covA[o4 + 2] = m00 * m20 + m01 * m21 + m02 * m22; // xz
        covB[o4] = m10 * m10 + m11 * m11 + m12 * m12;     // yy
        covB[o4 + 1] = m10 * m20 + m11 * m21 + m12 * m22; // yz
        covB[o4 + 2] = m20 * m20 + m21 * m21 + m22 * m22; // zz
    }

    return { numSplats, centers, covA, covB, colorsU32, boundsMin, boundsMax };
}

/** Fetch an `.spz` URL, gunzip, and parse. */
export async function loadSpz(url: string, onProgress?: (loaded: number, total: number) => void): Promise<GpuSplatData> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch splat: ${response.status} ${url}`);

    let compressed: ArrayBuffer;
    const total = Number(response.headers.get('Content-Length') ?? 0);
    if (onProgress && response.body && total > 0) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            onProgress(loaded, total);
        }
        const all = new Uint8Array(loaded);
        let pos = 0;
        for (const c of chunks) { all.set(c, pos); pos += c.byteLength; }
        compressed = all.buffer;
    } else {
        compressed = await response.arrayBuffer();
    }

    const bytes = await gunzip(compressed);
    return parseSpz(bytes);
}
