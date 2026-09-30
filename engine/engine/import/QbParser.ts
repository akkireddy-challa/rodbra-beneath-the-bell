/**
 * Qubicle Binary (.qb, version 1.1.0.0) parser → ImportedVoxelFile.
 *
 * Header: 6 uint32s — version (bytes 1,1,0,0 = 257), colorFormat (0 RGBA / 1 BGRA),
 * zAxisOrientation (0 left-handed / 1 right-handed), compressed (0 raw / 1 RLE),
 * visibilityMaskEncoded, numMatrices. Per matrix: uint8 nameLen + name, uint32
 * sizeX/Y/Z, int32 posX/Y/Z, then sizeX*sizeY*sizeZ uint32 colors (x fastest, then
 * y, then z) — or per-z-slice RLE (CODEFLAG=2: count+value; NEXTSLICEFLAG=6).
 *
 * Alpha byte semantics: 0 = no voxel. When visibilityMaskEncoded is set the alpha
 * bits carry per-face visibility — any nonzero value still means "solid", which is
 * all the importer needs.
 *
 * Qubicle is Y-up. Left-handed files (zAxisOrientation 0) are normalized here by
 * mirroring each matrix's local Z and its Z offset, so everything downstream is
 * uniformly right-handed Y-up.
 */
import type { ImportedVoxelFile, ImportedVoxelGrid, ImportedVoxelInstance } from 'engine/import/ImportedVoxelModel.js';
import { IDENTITY_ROTATION, MAX_IMPORT_VOXELS } from 'engine/import/ImportedVoxelModel.js';

const QB_VERSION_1_1_0_0 = 257; // bytes [1, 1, 0, 0] read little-endian
const CODEFLAG = 2;
const NEXTSLICEFLAG = 6;
const IMPORT_LIMIT_ERROR = `Voxel count exceeds import limit (${MAX_IMPORT_VOXELS.toLocaleString('en-US')})`;

export function isQbFile(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 24) return false;
    return new DataView(buffer).getUint32(0, true) === QB_VERSION_1_1_0_0;
}

export function parseQb(buffer: ArrayBuffer): ImportedVoxelFile {
    const view = new DataView(buffer);
    let offset = 0;
    const need = (n: number): void => {
        if (offset + n > view.byteLength) throw new Error('Truncated .qb file (unexpected end of data)');
    };
    const u8 = (): number => { need(1); return view.getUint8(offset++); };
    const u32 = (): number => { need(4); const v = view.getUint32(offset, true); offset += 4; return v; };
    const i32 = (): number => { need(4); const v = view.getInt32(offset, true); offset += 4; return v; };

    const version = u32();
    if (version !== QB_VERSION_1_1_0_0) {
        throw new Error(`Unsupported .qb version: 0x${version.toString(16)} (expected 1.1.0.0)`);
    }
    const colorFormat = u32();
    const zAxisOrientation = u32();
    const compressed = u32();
    const visibilityMaskEncoded = u32();
    const numMatrices = u32();

    const notes: string[] = [];
    if (visibilityMaskEncoded) {
        notes.push('Per-face visibility masks present — treated as solid voxels');
    }
    const leftHanded = zAxisOrientation === 0;

    const grids: ImportedVoxelGrid[] = [];
    const instances: ImportedVoxelInstance[] = [];
    const paletteMap = new Map<number, number>(); // rgba key → palette index
    const paletteBytes: number[] = [];
    let totalEmitted = 0; // cumulative solid-voxel count across all matrices — DoS budget

    const paletteIndexFor = (raw: number): number => {
        // raw is the uint32 as stored; byte order per colorFormat.
        const b0 = raw & 0xff, b1 = (raw >>> 8) & 0xff, b2 = (raw >>> 16) & 0xff, a = (raw >>> 24) & 0xff;
        const rr = colorFormat === 1 ? b2 : b0;
        const bb = colorFormat === 1 ? b0 : b2;
        const key = (rr << 24) | (b1 << 16) | (bb << 8) | a;
        let idx = paletteMap.get(key);
        if (idx === undefined) {
            idx = paletteBytes.length / 4;
            paletteMap.set(key, idx);
            paletteBytes.push(rr, b1, bb, a);
        }
        return idx;
    };

    for (let m = 0; m < numMatrices; m++) {
        const nameLen = u8();
        need(nameLen);
        let name = '';
        for (let i = 0; i < nameLen; i++) name += String.fromCharCode(view.getUint8(offset + i));
        offset += nameLen;

        const sizeX = u32(), sizeY = u32(), sizeZ = u32();
        const posX = i32(), posY = i32(), posZ = i32();
        if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0 || sizeX > 65536 || sizeY > 65536 || sizeZ > 65536) {
            throw new Error(`Invalid .qb matrix size: ${sizeX}x${sizeY}x${sizeZ}`);
        }

        const voxels: number[] = [];
        const emit = (x: number, y: number, z: number, raw: number): void => {
            if ((raw >>> 24) === 0) return; // alpha 0 = air
            totalEmitted++;
            if (totalEmitted > MAX_IMPORT_VOXELS) throw new Error(IMPORT_LIMIT_ERROR);
            const zz = leftHanded ? (sizeZ - 1) - z : z;
            voxels.push(x, y, zz, paletteIndexFor(raw));
        };

        if (!compressed) {
            for (let z = 0; z < sizeZ; z++)
                for (let y = 0; y < sizeY; y++)
                    for (let x = 0; x < sizeX; x++)
                        emit(x, y, z, u32());
        } else {
            for (let z = 0; z < sizeZ; z++) {
                let index = 0;
                for (;;) {
                    const data = u32();
                    if (data === NEXTSLICEFLAG) break;
                    if (data === CODEFLAG) {
                        const count = u32();
                        const value = u32();
                        // Coarse pre-check: counts the run length regardless of alpha, purely
                        // as a DoS gate — must fire before the loop below allocates/iterates,
                        // so a hostile huge `count` can't force billions of array pushes.
                        if (totalEmitted + count > MAX_IMPORT_VOXELS) {
                            throw new Error(IMPORT_LIMIT_ERROR);
                        }
                        for (let i = 0; i < count; i++) {
                            const x = index % sizeX;
                            const y = Math.floor(index / sizeX);
                            if (y >= sizeY) throw new Error('Truncated .qb file (RLE run overruns slice)');
                            emit(x, y, z, value);
                            index++;
                        }
                    } else {
                        const x = index % sizeX;
                        const y = Math.floor(index / sizeX);
                        if (y >= sizeY) throw new Error('Truncated .qb file (slice overrun)');
                        emit(x, y, z, data);
                        index++;
                    }
                }
            }
        }

        grids.push({ name: name || null, sizeX, sizeY, sizeZ, voxels: new Int32Array(voxels) });
        // Matrix offsets are min-corner translations; represent as an identity-rotation
        // instance so the compiler treats .vox and .qb uniformly. Note the compiler
        // applies translations about floor(size/2) (MagicaVoxel semantics), so shift
        // the min-corner offset to compensate.
        const cx = Math.floor(sizeX / 2), cy = Math.floor(sizeY / 2);
        const czRaw = Math.floor(sizeZ / 2);
        const tz = leftHanded ? -(posZ + sizeZ - 1) : posZ;
        instances.push({
            gridIndex: m,
            rotation: IDENTITY_ROTATION,
            translation: [posX + cx, posY + cy, tz + czRaw],
            name: name || null,
        });
    }

    if (grids.length === 0) throw new Error('No matrices found in .qb file');

    // .qb (1.1.0.0) has per-voxel colors and no material system → never emissive.
    return { format: 'qb', grids, palette: new Uint8Array(paletteBytes), paletteEmissive: null, instances, notes };
}
