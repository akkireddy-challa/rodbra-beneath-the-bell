/**
 * Loader + renderer for the `.points` preview format generated at upload
 * time (see `game-play-agent/src/mastra/utils/splat-preview-encoder.ts`).
 *
 * The preview is a downsampled colored point cloud — ~5% of the source
 * gaussians, positions in f16, colors in RGB565, gzipped. It exists to keep
 * the creator iframe responsive on big splat files; the full SPZ is still
 * loaded for voxelization and for runtime play. We render it with a single
 * `THREE.Points` mesh — one draw call regardless of point count.
 *
 * Wire format (gzipped):
 *   Header (16 B): magic 'PNTS' u32 | version u32 | numPoints u32 | reserved u32
 *   Per point (8 B): x f16, y f16, z f16, color rgb565
 */
import * as THREE from 'three';

/** Decode an IEEE 754 half-precision (f16) bit pattern to float32. In-house
 *  replacement for spark's `fromHalf` so the preview loader carries no spark
 *  dependency (the WebGL Spark renderer was removed). */
function decodeHalf(bits: number): number {
    const sign = (bits & 0x8000) ? -1 : 1;
    const exp = (bits >> 10) & 0x1f;
    const frac = bits & 0x3ff;
    if (exp === 0) return sign * frac * 2 ** -24;            // subnormal / zero
    if (exp === 31) return frac ? NaN : sign * Infinity;     // inf / nan
    return sign * (1 + frac / 1024) * 2 ** (exp - 15);       // normal
}

const PNTS_MAGIC = 0x53544E50;
const PNTS_VERSION = 1;
const HEADER_BYTES = 16;
const POINT_BYTES = 8;

export interface PreviewMeshOptions {
    /**
     * Render-time point size (world-space, metres). Larger values hide gaps
     * between sampled points on dense surfaces; smaller values give crisper
     * sparse detail. Default 0.04 m looks reasonable for typical splat
     * scenes; callers can tweak per-asset later.
     */
    pointSize?: number;
}

/** Fetch a `.points` URL, decode, and return a Three.js mesh ready to add to a scene. */
export async function loadSplatPreviewMesh(url: string, opts: PreviewMeshOptions = {}): Promise<THREE.Points> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Preview fetch failed: ${response.status} ${response.statusText}`);
    const gzipped = new Uint8Array(await response.arrayBuffer());

    const decompressed = await gunzipBytes(gzipped);
    const view = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);

    if (decompressed.byteLength < HEADER_BYTES) {
        throw new Error(`Preview file too small: ${decompressed.byteLength} bytes`);
    }
    const magic = view.getUint32(0, true);
    if (magic !== PNTS_MAGIC) {
        throw new Error(`Preview magic mismatch: 0x${magic.toString(16)}`);
    }
    const version = view.getUint32(4, true);
    if (version !== PNTS_VERSION) {
        throw new Error(`Preview version unsupported: ${version}`);
    }
    const numPoints = view.getUint32(8, true);
    const expectedBytes = HEADER_BYTES + numPoints * POINT_BYTES;
    if (decompressed.byteLength < expectedBytes) {
        throw new Error(`Preview truncated: ${decompressed.byteLength} < ${expectedBytes}`);
    }

    const positions = new Float32Array(numPoints * 3);
    const colors = new Float32Array(numPoints * 3);
    for (let i = 0; i < numPoints; i++) {
        const off = HEADER_BYTES + i * POINT_BYTES;
        positions[i * 3 + 0] = decodeHalf(view.getUint16(off + 0, true));
        positions[i * 3 + 1] = decodeHalf(view.getUint16(off + 2, true));
        positions[i * 3 + 2] = decodeHalf(view.getUint16(off + 4, true));
        const c = view.getUint16(off + 6, true);
        colors[i * 3 + 0] = ((c >> 11) & 0x1F) / 31;
        colors[i * 3 + 1] = ((c >> 5) & 0x3F) / 63;
        colors[i * 3 + 2] = (c & 0x1F) / 31;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const material = new THREE.PointsMaterial({
        size: opts.pointSize ?? 0.04,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: false,
    });

    const mesh = new THREE.Points(geometry, material);
    mesh.name = 'SplatPreview';
    mesh.frustumCulled = true;
    return mesh;
}

async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
