/**
 * Test-only builders for minimal well-formed .vox / .qb binaries.
 * Layouts follow the official specs:
 *  - .vox: "VOX " + version, then a MAIN chunk whose children are
 *    SIZE/XYZI pairs, optional RGBA, optional scene graph (nTRN/nGRP/nSHP), MATL.
 *    Every chunk = 4CC + int32 contentBytes + int32 childrenBytes + content + children.
 *  - .qb (1.1.0.0): 6 uint32 header fields, then per matrix: name, sizes, position,
 *    and voxel data (raw z→y→x order, or per-slice RLE with CODEFLAG=2 / NEXTSLICEFLAG=6).
 */

// Exported (test-only escape hatch): lets individual test files hand-assemble
// .vox byte layouts that buildVoxBytes()'s fixed topology cannot express —
// e.g. malformed/negative chunk sizes, or scene graphs with cycles / multi-level
// nesting. Keep usage confined to __tests__; this is not a general-purpose
// binary writer.
export class ByteWriter {
    private readonly out: number[] = [];
    u8(v: number): this { this.out.push(v & 0xff); return this; }
    u32(v: number): this {
        this.out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
        return this;
    }
    i32(v: number): this { return this.u32(v >>> 0); }
    ascii(s: string): this {
        for (let i = 0; i < s.length; i++) this.out.push(s.charCodeAt(i) & 0xff);
        return this;
    }
    raw(bytes: ArrayLike<number>): this {
        for (let i = 0; i < bytes.length; i++) this.out.push(bytes[i]! & 0xff);
        return this;
    }
    get length(): number { return this.out.length; }
    toUint8(): Uint8Array { return new Uint8Array(this.out); }
    toBuffer(): ArrayBuffer { return this.toUint8().buffer; }
}

/** Write a .vox length-prefixed ASCII string (test-only, see ByteWriter). */
export function voxString(w: ByteWriter, s: string): void {
    w.u32(s.length).ascii(s);
}

/** Write a .vox string→string dict (test-only, see ByteWriter). */
export function voxDict(w: ByteWriter, pairs: Record<string, string>): void {
    const keys = Object.keys(pairs);
    w.u32(keys.length);
    for (const k of keys) { voxString(w, k); voxString(w, pairs[k]!); }
}

/**
 * Wrap `content`/`children` writers as a .vox chunk: 4CC + int32 contentBytes +
 * int32 childrenBytes + content + children (test-only, see ByteWriter). `contentBytes`/
 * `childrenBytes` may be overridden to values that don't match the real byte length —
 * used to construct malformed chunks (e.g. negative declared sizes) for error-path tests.
 */
export function voxChunk(
    id: string,
    content: ByteWriter,
    children?: ByteWriter,
    sizeOverride?: { contentBytes?: number; childrenBytes?: number },
): ByteWriter {
    const w = new ByteWriter();
    w.ascii(id)
        .u32(sizeOverride?.contentBytes ?? content.length)
        .u32(sizeOverride?.childrenBytes ?? (children ? children.length : 0));
    w.raw(content.toUint8());
    if (children) w.raw(children.toUint8());
    return w;
}

/**
 * Append a minimal 1x1x1 SIZE + XYZI pair (one voxel at (0,0,0), color index 1)
 * to a hand-assembled chunk stream (test-only, see ByteWriter). Convenience for
 * the escape-hatch tests that build scene graphs around a single trivial model.
 */
export function voxSingleVoxelModel(children: ByteWriter): void {
    const size = new ByteWriter();
    size.i32(1).i32(1).i32(1);
    children.raw(voxChunk('SIZE', size).toUint8());
    const xyzi = new ByteWriter();
    xyzi.u32(1).u8(0).u8(0).u8(0).u8(1);
    children.raw(voxChunk('XYZI', xyzi).toUint8());
}

/**
 * Assemble a full ".vox" file (magic + version + MAIN wrapper) from a pre-built
 * `children` chunk stream (test-only, see ByteWriter). Escape hatch for tests that need
 * chunk layouts buildVoxBytes() cannot express (cyclic/nested scene graphs, corrupt chunks).
 */
export function buildVoxBytesFromChunks(children: ByteWriter): ArrayBuffer {
    const file = new ByteWriter();
    file.ascii('VOX ').u32(150);
    file.raw(voxChunk('MAIN', new ByteWriter(), children).toUint8());
    return file.toBuffer();
}

export interface VoxFixtureModel {
    sizeX: number; sizeY: number; sizeZ: number;
    /** [x, y, z, colorIndex] — colorIndex is 1-based. */
    voxels: Array<[number, number, number, number]>;
}

export interface VoxFixturePlacement {
    model: number;
    /** MagicaVoxel `_t` values (source voxel units). */
    translation?: [number, number, number];
    /**
     * Test-only escape hatch: write this exact string as the `_t` dict value
     * instead of deriving it from `translation` — lets malformed/non-numeric
     * `_t` payloads be constructed for error-path tests. Takes precedence over
     * `translation` when both are set.
     */
    rawTranslation?: string;
    /** MagicaVoxel `_r` rotation byte. Omit for identity. */
    rotationByte?: number;
    name?: string;
}

export interface VoxFixtureMaterial {
    /** MATL material id = 1-based color index. Hostile fixtures may pass 0 or >255. */
    id: number;
    /** MagicaVoxel `_type` value, e.g. '_emit', '_metal', '_diffuse'. */
    type: string;
    /**
     * `_weight` property (0..1) — for `_type:_emit` this IS the emission strength
     * (MagicaVoxel has no property literally named `_emit`). Omit → not written.
     */
    weight?: number;
    /** `_flux` property (0..4). Omit → property not written. */
    flux?: number;
    /**
     * When true, also emit the standard "noise" keys a real MagicaVoxel MATL dict
     * carries (`_rough`/`_spec`/`_ior`/`_att`/`_ldr`). Lets a regression fixture
     * mirror a real export so the parser is exercised against a full multi-key dict.
     */
    realShape?: boolean;
}

export function buildVoxBytes(opts: {
    models: VoxFixtureModel[];
    /** Palette entries for color indices 1..N (RGBA). Omit → no RGBA chunk (default palette). */
    palette?: Array<[number, number, number, number]>;
    /** Scene-graph placements. Omit → no graph chunks (implicit one instance per model). */
    scene?: VoxFixturePlacement[];
    /** Append one MATL chunk per entry (material id + `_type`/`_weight`/`_flux` dict). */
    materials?: VoxFixtureMaterial[];
}): ArrayBuffer {
    const children = new ByteWriter();

    for (const m of opts.models) {
        const size = new ByteWriter();
        size.i32(m.sizeX).i32(m.sizeY).i32(m.sizeZ);
        children.raw(voxChunk('SIZE', size).toUint8());

        const xyzi = new ByteWriter();
        xyzi.u32(m.voxels.length);
        for (const [x, y, z, ci] of m.voxels) xyzi.u8(x).u8(y).u8(z).u8(ci);
        children.raw(voxChunk('XYZI', xyzi).toUint8());
    }

    if (opts.scene) {
        // Fixed topology: nTRN(0) → nGRP(1) → [ nTRN(2+2i) → nSHP(3+2i) ]
        const rootTrn = new ByteWriter();
        rootTrn.i32(0); voxDict(rootTrn, {}); rootTrn.i32(1).i32(-1).i32(-1).i32(1); voxDict(rootTrn, {});
        children.raw(voxChunk('nTRN', rootTrn).toUint8());

        const grp = new ByteWriter();
        grp.i32(1); voxDict(grp, {}); grp.i32(opts.scene.length);
        for (let i = 0; i < opts.scene.length; i++) grp.i32(2 + 2 * i);
        children.raw(voxChunk('nGRP', grp).toUint8());

        for (let i = 0; i < opts.scene.length; i++) {
            const p = opts.scene[i]!;
            const trn = new ByteWriter();
            trn.i32(2 + 2 * i);
            voxDict(trn, p.name !== undefined ? { _name: p.name } : {});
            trn.i32(3 + 2 * i).i32(-1).i32(-1).i32(1);
            const frame: Record<string, string> = {};
            if (p.rotationByte !== undefined) frame['_r'] = String(p.rotationByte);
            if (p.rawTranslation !== undefined) frame['_t'] = p.rawTranslation;
            else if (p.translation) frame['_t'] = p.translation.join(' ');
            voxDict(trn, frame);
            children.raw(voxChunk('nTRN', trn).toUint8());

            const shp = new ByteWriter();
            shp.i32(3 + 2 * i); voxDict(shp, {}); shp.i32(1); shp.i32(p.model); voxDict(shp, {});
            children.raw(voxChunk('nSHP', shp).toUint8());
        }
    }

    if (opts.palette) {
        const rgba = new ByteWriter();
        // RGBA chunk stores 256 entries; entry at position i maps to color index i+1.
        for (let i = 0; i < 256; i++) {
            const e = opts.palette[i];
            if (e) rgba.u8(e[0]).u8(e[1]).u8(e[2]).u8(e[3]);
            else rgba.u8(0).u8(0).u8(0).u8(255);
        }
        children.raw(voxChunk('RGBA', rgba).toUint8());
    }

    if (opts.materials) {
        for (const m of opts.materials) {
            const matl = new ByteWriter();
            matl.i32(m.id);
            const props: Record<string, string> = { _type: m.type };
            if (m.weight !== undefined) props['_weight'] = String(m.weight);
            if (m.realShape) {
                // Mirror the noise keys a real MagicaVoxel emit MATL carries, in
                // between `_weight` and `_flux`, so the parser must key-lookup (not
                // read positionally) — matches the real DualStriker.vox layout.
                Object.assign(props, {
                    _rough: '0.1', _spec: '0.5', _spec_p: '0.5', _ior: '0.3',
                    _att: '0', _g0: '-0.5', _g1: '0.8', _gw: '0.7',
                });
            }
            if (m.flux !== undefined) props['_flux'] = String(m.flux);
            if (m.realShape) props['_ldr'] = '0';
            voxDict(matl, props);
            children.raw(voxChunk('MATL', matl).toUint8());
        }
    }

    const file = new ByteWriter();
    file.ascii('VOX ').u32(150);
    file.raw(voxChunk('MAIN', new ByteWriter(), children).toUint8());
    return file.toBuffer();
}

export interface QbFixtureMatrix {
    name: string;
    sizeX: number; sizeY: number; sizeZ: number;
    posX: number; posY: number; posZ: number;
    /** [x, y, z, r, g, b, a] — a=0 means invisible. */
    voxels: Array<[number, number, number, number, number, number, number]>;
}

export function buildQbBytes(opts: {
    matrices: QbFixtureMatrix[];
    compressed?: boolean;
    /** 0 = RGBA (default), 1 = BGRA. */
    colorFormat?: 0 | 1;
    /** 0 = left-handed (Qubicle default), 1 = right-handed. */
    zAxisOrientation?: 0 | 1;
    visibilityMaskEncoded?: 0 | 1;
}): ArrayBuffer {
    const w = new ByteWriter();
    w.u32(257); // version 1.1.0.0 → bytes [1,1,0,0] LE
    w.u32(opts.colorFormat ?? 0);
    w.u32(opts.zAxisOrientation ?? 1);
    w.u32(opts.compressed ? 1 : 0);
    w.u32(opts.visibilityMaskEncoded ?? 0);
    w.u32(opts.matrices.length);

    const CODEFLAG = 2, NEXTSLICEFLAG = 6;
    const packColor = (r: number, g: number, b: number, a: number): number => {
        const bgra = (opts.colorFormat ?? 0) === 1;
        const c0 = bgra ? b : r, c2 = bgra ? r : b;
        return ((a << 24) | (c2 << 16) | (g << 8) | c0) >>> 0;
    };

    for (const m of opts.matrices) {
        w.u8(m.name.length).ascii(m.name);
        w.u32(m.sizeX).u32(m.sizeY).u32(m.sizeZ);
        w.i32(m.posX).i32(m.posY).i32(m.posZ);

        // Dense color grid, 0 = empty (alpha 0).
        const grid = new Uint32Array(m.sizeX * m.sizeY * m.sizeZ);
        for (const [x, y, z, r, g, b, a] of m.voxels) {
            grid[(z * m.sizeY + y) * m.sizeX + x] = packColor(r, g, b, a);
        }

        if (!opts.compressed) {
            for (let z = 0; z < m.sizeZ; z++)
                for (let y = 0; y < m.sizeY; y++)
                    for (let x = 0; x < m.sizeX; x++)
                        w.u32(grid[(z * m.sizeY + y) * m.sizeX + x]!);
        } else {
            for (let z = 0; z < m.sizeZ; z++) {
                const slice: number[] = [];
                for (let y = 0; y < m.sizeY; y++)
                    for (let x = 0; x < m.sizeX; x++)
                        slice.push(grid[(z * m.sizeY + y) * m.sizeX + x]!);
                let i = 0;
                while (i < slice.length) {
                    let run = 1;
                    while (i + run < slice.length && slice[i + run] === slice[i] && run < 0xffff) run++;
                    if (run >= 4) {
                        w.u32(CODEFLAG).u32(run).u32(slice[i]!);
                        i += run;
                    } else {
                        // Literal values equal to CODEFLAG/NEXTSLICEFLAG would corrupt the
                        // stream; fixture colors avoid raw values 2 and 6 (alpha byte is
                        // always 0 or >= 7 in fixtures below).
                        w.u32(slice[i]!);
                        i++;
                    }
                }
                w.u32(NEXTSLICEFLAG);
            }
        }
    }
    return w.toBuffer();
}
