import { parseQb, isQbFile } from 'engine/import/QbParser.js';
import { buildQbBytes, ByteWriter } from 'engine/__tests__/helpers/voxelImportFixtures.js';

const CODEFLAG = 2;
const NEXTSLICEFLAG = 6;

describe('QbParser', () => {
    const singleVoxel = (over: Partial<Parameters<typeof buildQbBytes>[0]> = {}) => buildQbBytes({
        matrices: [{
            name: 'main', sizeX: 2, sizeY: 3, sizeZ: 2, posX: 5, posY: 0, posZ: -2,
            voxels: [[1, 2, 0, 200, 100, 50, 255]],
        }],
        ...over,
    });

    /**
     * Hand-assemble a single-matrix .qb file: the 6-field header, then the matrix's
     * name/dims/pos, then a caller-supplied raw compressed voxel-data stream (RGBA
     * color format, right-handed, compressed=1). Lets tests below construct RLE
     * stream shapes (CODEFLAG runs, malformed counts) that buildQbBytes() cannot express.
     */
    const buildCompressedQbShell = (opts: {
        name?: string;
        sizeX: number; sizeY: number; sizeZ: number;
        stream: (w: ByteWriter) => void;
    }): ArrayBuffer => {
        const name = opts.name ?? 'm';
        const w = new ByteWriter();
        w.u32(257).u32(0).u32(1).u32(1).u32(0).u32(1); // version, RGBA, right-handed, compressed, no vis-mask, 1 matrix
        w.u8(name.length).ascii(name);
        w.u32(opts.sizeX).u32(opts.sizeY).u32(opts.sizeZ);
        w.i32(0).i32(0).i32(0);
        opts.stream(w);
        return w.toBuffer();
    };

    test('isQbFile detects version header', () => {
        expect(isQbFile(singleVoxel())).toBe(true);
        expect(isQbFile(new Uint8Array([9, 9, 9, 9, 0, 0, 0, 0]).buffer)).toBe(false);
    });

    test('raw matrix parses grid, palette, and translation instance', () => {
        const f = parseQb(singleVoxel());
        expect(f.format).toBe('qb');
        expect(f.grids).toHaveLength(1);
        expect(f.grids[0]!.name).toBe('main');
        expect(Array.from(f.grids[0]!.voxels)).toEqual([1, 2, 0, 0]);
        expect(Array.from(f.palette.slice(0, 4))).toEqual([200, 100, 50, 255]);
        expect(f.instances[0]!.translation).toEqual([6, 1, -1]);
    });

    test('alpha 0 voxels are air', () => {
        const f = parseQb(buildQbBytes({
            matrices: [{
                name: 'm', sizeX: 2, sizeY: 1, sizeZ: 1, posX: 0, posY: 0, posZ: 0,
                voxels: [[0, 0, 0, 10, 20, 30, 255], [1, 0, 0, 1, 2, 3, 0]],
            }],
        }));
        expect(f.grids[0]!.voxels.length).toBe(4); // one voxel only
    });

    test('RLE-compressed data decodes identically to raw', () => {
        // Asymmetric pattern: a constant-color leading run per row (x < 4, long enough to
        // clear the fixture's run>=4 CODEFLAG threshold) so RLE actually emits a CODEFLAG,
        // plus position-dependent colors elsewhere so literal values also get exercised.
        // Raw and RLE emit voxels in identical (z, y, x) order, so this compares WITHOUT
        // sorting — a real reordering bug between the two decode paths would otherwise be masked.
        const matrices = [{
            name: 'm', sizeX: 6, sizeY: 2, sizeZ: 2, posX: 0, posY: 0, posZ: 0,
            voxels: [] as Array<[number, number, number, number, number, number, number]>,
        }];
        for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 6; x++) {
            const color: [number, number, number, number] = x < 4
                ? [100, 150, 200, 255]
                : [10 + x, 20 + y, 30 + z, 255];
            matrices[0]!.voxels.push([x, y, z, ...color]);
        }
        const raw = parseQb(buildQbBytes({ matrices, compressed: false }));
        const rle = parseQb(buildQbBytes({ matrices, compressed: true }));
        expect(Array.from(rle.grids[0]!.voxels)).toEqual(Array.from(raw.grids[0]!.voxels));
    });

    test('BGRA color format is normalized to RGBA', () => {
        const f = parseQb(singleVoxel({ colorFormat: 1 }));
        expect(Array.from(f.palette.slice(0, 4))).toEqual([200, 100, 50, 255]);
    });

    test('left-handed files are mirrored to right-handed', () => {
        const lh = parseQb(singleVoxel({ zAxisOrientation: 0 }));
        // grid z mirrored within the matrix: z' = (sizeZ-1) - 0 = 1
        expect(Array.from(lh.grids[0]!.voxels)).toEqual([1, 2, 1, 0]);
        // translation z mirrored about the origin: t'z = -(posZ + sizeZ - 1) = -(-2 + 1) = 1
        expect(lh.instances[0]!.translation).toEqual([6, 1, 2]);
    });

    test('multiple named matrices become separate grids/instances', () => {
        const f = parseQb(buildQbBytes({
            matrices: [
                { name: 'a', sizeX: 1, sizeY: 1, sizeZ: 1, posX: 0, posY: 0, posZ: 0, voxels: [[0, 0, 0, 1, 1, 1, 255]] },
                { name: 'b', sizeX: 1, sizeY: 1, sizeZ: 1, posX: 4, posY: 0, posZ: 0, voxels: [[0, 0, 0, 2, 2, 2, 255]] },
            ],
        }));
        expect(f.grids.map(g => g.name)).toEqual(['a', 'b']);
        expect(f.instances[1]!.translation).toEqual([4, 0, 0]);
    });

    test('truncated buffer throws', () => {
        const good = new Uint8Array(singleVoxel());
        expect(() => parseQb(good.slice(0, good.length - 5).buffer)).toThrow(/truncated/i);
    });

    test('CODEFLAG count=0 is harmless', () => {
        const buf = buildCompressedQbShell({
            sizeX: 4, sizeY: 1, sizeZ: 1,
            stream: (w) => {
                w.u32(CODEFLAG).u32(0).u32(0xff646464); // zero-length run: contributes nothing
                w.u32(0xff0a0a0a).u32(0xff141414); // two literal solid voxels
                w.u32(NEXTSLICEFLAG);
            },
        });
        const f = parseQb(buf);
        expect(Array.from(f.grids[0]!.voxels)).toEqual([0, 0, 0, 0, 1, 0, 0, 1]);
    });

    test('RLE run overrunning the slice throws', () => {
        const buf = buildCompressedQbShell({
            sizeX: 2, sizeY: 2, sizeZ: 1, // slice holds 4 cells
            stream: (w) => {
                w.u32(CODEFLAG).u32(5).u32(0xff646464); // count > sizeX*sizeY
                w.u32(NEXTSLICEFLAG);
            },
        });
        expect(() => parseQb(buf)).toThrow(/overruns slice|slice overrun/i);
    });

    test('empty matrix name becomes null', () => {
        const buf = buildCompressedQbShell({
            name: '',
            sizeX: 1, sizeY: 1, sizeZ: 1,
            stream: (w) => {
                w.u32(0xff0a0a0a);
                w.u32(NEXTSLICEFLAG);
            },
        });
        const f = parseQb(buf);
        expect(f.grids[0]!.name).toBeNull();
    });

    test('decompression bomb throws before allocating', () => {
        // Passes the per-axis 65536 sanity bound (23170 < 65536) but its product
        // (23170*23170*1 = 536,848,900) wildly exceeds the 16,777,216-voxel import
        // budget. A single CODEFLAG run declares that many cells up front — the
        // pre-check must reject this before the emit loop starts, so the test
        // completes in milliseconds instead of iterating hundreds of millions of times.
        const buf = buildCompressedQbShell({
            sizeX: 23170, sizeY: 23170, sizeZ: 1,
            stream: (w) => {
                w.u32(CODEFLAG).u32(536_848_900).u32(0xff646464);
                w.u32(NEXTSLICEFLAG);
            },
        });
        const start = Date.now();
        expect(() => parseQb(buf)).toThrow(/import limit/i);
        expect(Date.now() - start).toBeLessThan(1000);
    });
});
