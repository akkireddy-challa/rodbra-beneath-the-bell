import { encodeVxlScene, decodeVxlScene, type VxlSceneWorld } from 'engine/vxlscene/VxlSceneFormat.js';
import type { GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';
import type { SceneVoxel } from 'engine/vxlscene/SceneVoxTypes.js';

function tinyWorld(groundMask?: GroundMaskData | null): VxlSceneWorld {
    const voxel: SceneVoxel = {
        gx: 1, gy: 2, gz: 3, sizeLevel: 0,
        color: { r: 0.5, g: 0.6, b: 0.7 },
        noCollider: false, disp: null,
    };
    return {
        chunkSize: 16,
        minVoxelSize: 0.5,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
        lodDistances: [100],
        chunks: [{
            cx: 0, cy: 0, cz: 0,
            voxels: [voxel],
            lodHints: [[{ gx: 1, gy: 2, gz: 3, w: 1, h: 1, axis: 1, dir: 1, color: { r: 0.5, g: 0.6, b: 0.7 }, disp: 0, offset: 0, noCollider: false }]],
            namedTrimeshes: [],
        }],
        groundMask,
    };
}

function makeMask(): GroundMaskData {
    const width = 32, height = 32;
    const types = new Uint8Array(width * height);
    const topY = new Uint16Array(width * height);
    for (let i = 0; i < width * height; i++) {
        if (i % 5 === 0) { types[i] = GROUND_TYPE.cobble; topY[i] = 20 + (i % 7); }
        else if (i % 3 === 0) { types[i] = GROUND_TYPE.grassLush; topY[i] = 18; }
    }
    return { cellSize: 0.5, width, height, types, topY };
}

describe('VxlScene v6 ground mask', () => {
    it('round-trips the mask planes exactly', async () => {
        const mask = makeMask();
        const bytes = await encodeVxlScene(tinyWorld(mask));
        expect(bytes[4]).toBe(7); // format version (v7 = v6 + optional emissive-palette section)
        const decoded = await decodeVxlScene(bytes);
        expect(decoded.groundMask).not.toBeNull();
        const m = decoded.groundMask!;
        expect(m.cellSize).toBeCloseTo(0.5, 6);
        expect(m.width).toBe(mask.width);
        expect(m.height).toBe(mask.height);
        expect(Array.from(m.types)).toEqual(Array.from(mask.types));
        expect(Array.from(m.topY)).toEqual(Array.from(mask.topY));
        // Chunk payload unaffected by the new header section.
        expect(decoded.chunks).toHaveLength(1);
        expect(decoded.chunks[0]!.voxels.count).toBe(1);
        expect(decoded.chunks[0]!.lodHints[0]!.count).toBe(1);
    });

    it('a v6 file without a mask decodes with groundMask null', async () => {
        const bytes = await encodeVxlScene(tinyWorld(null));
        const decoded = await decodeVxlScene(bytes);
        expect(decoded.groundMask ?? null).toBeNull();
        expect(decoded.chunks[0]!.voxels.count).toBe(1);
    });

    it('a v5 buffer (hand-stamped) still decodes with groundMask null', async () => {
        // Encode WITHOUT a mask, then stamp the version byte back to 5 — the byte
        // layout up to the (absent) mask section is identical to v5.
        const bytes = await encodeVxlScene(tinyWorld(null));
        const v5 = bytes.slice();
        v5[4] = 5;
        // Remove the v6 hasGroundMask flag byte AND the v7 hasEmissivePalette flag
        // byte the encoder writes after the palette (both 0/absent here — this world
        // has no mask and no emissive map): find the pair by re-deriving the offset —
        // wrapper(6) + header(8+24) + lod(2+4) + name table(2) + palette block(1+1+2 + n*2).
        // A true v5 file has neither byte, so both must go to get a real v5 layout.
        const view = new DataView(v5.buffer, v5.byteOffset, v5.byteLength);
        let cur = 6 + 8 + 24;
        const lodCount = view.getUint16(cur, true); cur += 2 + lodCount * 4;
        const nameCount = view.getUint16(cur, true); cur += 2;
        for (let i = 0; i < nameCount; i++) { const len = view.getUint16(cur, true); cur += 2 + len; }
        cur += 1 + 1; // coordsBytes + paletteIdxBytes
        const paletteCount = view.getUint16(cur, true); cur += 2 + paletteCount * 2;
        // cur now points at the v6 flag byte, followed immediately by the v7 flag
        // byte; splice both out to get a true v5 layout.
        const spliced = new Uint8Array(v5.byteLength - 2);
        spliced.set(v5.subarray(0, cur), 0);
        spliced.set(v5.subarray(cur + 2), cur);
        const decoded = await decodeVxlScene(spliced);
        expect(decoded.groundMask ?? null).toBeNull();
        expect(decoded.chunks[0]!.voxels.count).toBe(1);
    });
});
