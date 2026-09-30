/**
 * MagicaVoxel .vox parser → ImportedVoxelFile.
 *
 * Layout (official spec, ephtracy/voxel-model): "VOX " + int32 version, then a
 * MAIN chunk whose children carry the payload. Every chunk is:
 *   4CC id | int32 contentBytes | int32 childrenBytes | content | child chunks
 * Consumed chunks: SIZE/XYZI (model grids, sequential pairs), RGBA (palette,
 * entry i → color index i+1), nTRN/nGRP/nSHP (scene graph), MATL (`_type:_emit`
 * materials → paletteEmissive via their `_weight`; other types recorded as a note).
 * All other chunks (LAYR, rOBJ, rCAM, PACK, ...) are skipped — that is the
 * format's own forward-compat mechanism.
 */
import type { ImportedVoxelFile, ImportedVoxelGrid, ImportedVoxelInstance } from 'engine/import/ImportedVoxelModel.js';
import { IDENTITY_ROTATION } from 'engine/import/ImportedVoxelModel.js';
import { VOX_DEFAULT_PALETTE } from 'engine/import/VoxDefaultPalette.js';

const VOX_MAGIC = 0x20584f56; // "VOX " little-endian
// DAG re-visits (legal, non-cyclic — the same nSHP/nGRP reachable via multiple parents) can
// explode instance counts exponentially via chained nGRPs with repeated childIds. Cap the walk.
const MAX_SCENE_INSTANCES = 65_536;
// Emissive baseline: a MATL of `_type:_emit` with `_weight` 1.0 and `_flux` 0 →
// 160/255 ≈ 0.63 glow; `_flux` (0..4) raises it toward full 255. MagicaVoxel stores
// the emission strength in the shared `_weight` slider (there is NO `_emit` property —
// `_emit` is only the `_type` value), verified against real exports. Tuned constant.
const EMIT_BASE = 160;

export function isVoxFile(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 8) return false;
    return new DataView(buffer).getUint32(0, true) === VOX_MAGIC;
}

type Mat3 = [number, number, number, number, number, number, number, number, number];
type Vec3 = [number, number, number];

class Reader {
    readonly view: DataView;
    offset: number;
    constructor(buffer: ArrayBuffer, offset = 0) {
        this.view = new DataView(buffer);
        this.offset = offset;
    }
    private need(n: number): void {
        if (this.offset + n > this.view.byteLength) {
            throw new Error('Truncated .vox file (unexpected end of data)');
        }
    }
    u8(): number { this.need(1); return this.view.getUint8(this.offset++); }
    i32(): number { this.need(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
    u32(): number { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    private ascii(len: number): string {
        this.need(len);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(this.view.getUint8(this.offset + i));
        this.offset += len;
        return s;
    }
    fourCC(): string { return this.ascii(4); }
    string(): string {
        const len = this.i32();
        if (len < 0) throw new Error('Truncated .vox file (negative string length)');
        return this.ascii(len);
    }
    dict(): Record<string, string> {
        const n = this.i32();
        const out: Record<string, string> = {};
        for (let i = 0; i < n; i++) {
            const k = this.string();
            out[k] = this.string();
        }
        return out;
    }
}

/** Coerce a possibly-NaN/undefined parsed number to a finite value, defaulting to 0. */
function finite(v: number | undefined): number {
    return v !== undefined && Number.isFinite(v) ? v : 0;
}

/** Decode the MagicaVoxel `_r` rotation byte to a row-major 3x3 sign-permutation matrix. */
function rotationFromByte(b: number): Mat3 {
    const r0 = b & 3;
    const r1 = (b >> 2) & 3;
    if (r0 > 2 || r1 > 2 || r0 === r1) {
        throw new Error(`Invalid .vox rotation byte: ${b}`);
    }
    const r2 = 3 - r0 - r1;
    const m: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    m[0 + r0] = (b >> 4) & 1 ? -1 : 1;
    m[3 + r1] = (b >> 5) & 1 ? -1 : 1;
    m[6 + r2] = (b >> 6) & 1 ? -1 : 1;
    return m;
}

function mulMat3(a: Mat3, b: Mat3): Mat3 {
    const o: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++)
            o[r * 3 + c] = a[r * 3 + 0]! * b[0 + c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    return o;
}

/** Fresh mutable identity rotation (the shared IDENTITY_ROTATION is readonly). */
function identityMat3(): Mat3 {
    return [...IDENTITY_ROTATION] as Mat3;
}

function mulMatVec(m: Mat3, v: Vec3): Vec3 {
    return [
        m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
        m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
        m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
    ];
}

interface TrnNode { kind: 'trn'; childId: number; rotation: Mat3; translation: Vec3; name: string | null; }
interface GrpNode { kind: 'grp'; childIds: number[]; }
interface ShpNode { kind: 'shp'; modelIds: number[]; }
type SceneNode = TrnNode | GrpNode | ShpNode;

export function parseVox(buffer: ArrayBuffer): ImportedVoxelFile {
    if (!isVoxFile(buffer)) throw new Error('Not a MagicaVoxel file (missing "VOX " magic)');
    const r = new Reader(buffer, 4);
    r.i32(); // version (150 / 200) — layout is stable across both for the chunks we read

    const grids: ImportedVoxelGrid[] = [];
    let palette: Uint8Array | null = null;
    const nodes = new Map<number, SceneNode>();
    const referencedIds = new Set<number>();
    let pendingSize: { x: number; y: number; z: number } | null = null;
    const emissiveByColor = new Uint8Array(256);
    let hasEmissive = false;
    let nonEmitMaterials = 0;
    const notes: string[] = [];

    // MAIN wrapper
    const mainId = r.fourCC();
    if (mainId !== 'MAIN') throw new Error(`Not a MagicaVoxel file (expected MAIN chunk, got "${mainId}")`);
    r.i32(); // MAIN content size (always 0)
    const childrenBytes = r.i32();
    if (childrenBytes < 0) throw new Error('Truncated .vox file (negative chunk size)');
    const end = Math.min(r.offset + childrenBytes, r.view.byteLength);

    while (r.offset < end) {
        const id = r.fourCC();
        const contentBytes = r.i32();
        const childBytes = r.i32();
        if (contentBytes < 0 || childBytes < 0) {
            throw new Error('Truncated .vox file (negative chunk size)');
        }
        const contentEnd = r.offset + contentBytes;
        if (contentEnd + childBytes > r.view.byteLength) {
            throw new Error('Truncated .vox file (chunk overruns buffer)');
        }

        switch (id) {
            case 'SIZE': {
                pendingSize = { x: r.i32(), y: r.i32(), z: r.i32() };
                break;
            }
            case 'XYZI': {
                const n = r.u32();
                if (r.offset + n * 4 > contentEnd) throw new Error('Truncated .vox file (XYZI overruns chunk)');
                const voxels = new Int32Array(n * 4);
                for (let i = 0; i < n; i++) {
                    voxels[i * 4 + 0] = r.u8();
                    voxels[i * 4 + 1] = r.u8();
                    voxels[i * 4 + 2] = r.u8();
                    voxels[i * 4 + 3] = r.u8();
                }
                const size = pendingSize ?? { x: 0, y: 0, z: 0 };
                grids.push({ name: null, sizeX: size.x, sizeY: size.y, sizeZ: size.z, voxels });
                pendingSize = null;
                break;
            }
            case 'RGBA': {
                // Entry at position i maps to color index i+1; index 0 stays unused.
                palette = new Uint8Array(256 * 4);
                for (let i = 0; i < 255; i++) {
                    palette[(i + 1) * 4 + 0] = r.u8();
                    palette[(i + 1) * 4 + 1] = r.u8();
                    palette[(i + 1) * 4 + 2] = r.u8();
                    palette[(i + 1) * 4 + 3] = r.u8();
                }
                break;
            }
            case 'nTRN': {
                const nodeId = r.i32();
                const attrs = r.dict();
                const childId = r.i32();
                referencedIds.add(childId);
                r.i32(); // reserved (-1)
                r.i32(); // layer id
                const numFrames = r.i32();
                let rotation: Mat3 = identityMat3();
                let translation: Vec3 = [0, 0, 0];
                for (let i = 0; i < numFrames; i++) {
                    const frame = r.dict();
                    if (i > 0) continue; // frame 0 only (animation frames out of scope)
                    if (frame['_r'] !== undefined) rotation = rotationFromByte(parseInt(frame['_r'], 10));
                    if (frame['_t'] !== undefined) {
                        const parts = frame['_t'].split(' ').map(v => parseInt(v, 10));
                        translation = [finite(parts[0]), finite(parts[1]), finite(parts[2])];
                    }
                }
                nodes.set(nodeId, { kind: 'trn', childId, rotation, translation, name: attrs['_name'] ?? null });
                break;
            }
            case 'nGRP': {
                const nodeId = r.i32();
                r.dict();
                const n = r.i32();
                const childIds: number[] = [];
                for (let i = 0; i < n; i++) {
                    const cid = r.i32();
                    childIds.push(cid);
                    referencedIds.add(cid);
                }
                nodes.set(nodeId, { kind: 'grp', childIds });
                break;
            }
            case 'nSHP': {
                const nodeId = r.i32();
                r.dict();
                const n = r.i32();
                const modelIds: number[] = [];
                for (let i = 0; i < n; i++) {
                    modelIds.push(r.i32());
                    r.dict(); // model attributes
                }
                nodes.set(nodeId, { kind: 'shp', modelIds });
                break;
            }
            case 'MATL': {
                const matId = r.i32();
                const props = r.dict();
                const type = props['_type'];
                if (type === '_emit') {
                    // Emission strength is the shared `_weight` slider (0..1), NOT a
                    // property literally named `_emit` — that string is only the `_type`
                    // value. Confirmed against real MagicaVoxel exports.
                    const weight = parseFloat(props['_weight'] ?? '0'); // 0..1
                    const flux = parseFloat(props['_flux'] ?? '0'); // small int, 0..4
                    // MATL id = 1-based color index; ignore out-of-range ids (0 appears
                    // in some files) and non-finite / non-positive weights.
                    if (Number.isFinite(weight) && weight > 0 && matId >= 1 && matId <= 255) {
                        const v = Math.max(0, Math.min(255, Math.round(weight * EMIT_BASE * (1 + (Number.isFinite(flux) ? flux : 0)))));
                        if (v > 0) { emissiveByColor[matId] = v; hasEmissive = true; }
                    }
                } else if (type !== undefined && type !== '_diffuse') {
                    nonEmitMaterials++; // metal/glass: noted, not yet supported
                }
                break;
            }
            default:
                break; // skip unknown chunk content below
        }

        // Skip whatever remains of this chunk (content we did not consume + children).
        r.offset = contentEnd + childBytes;
    }

    if (grids.length === 0) throw new Error('No models found in .vox file');
    if (hasEmissive) {
        const emissiveCount = emissiveByColor.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
        notes.push(`${emissiveCount} emissive color(s) imported`);
    }
    if (nonEmitMaterials > 0) {
        notes.push(`${nonEmitMaterials} color(s) use metal/glass materials — imported as solid colors (unsupported)`);
    }

    // Resolve the scene graph to flat instances; graph-less files get one
    // identity instance per grid.
    const instances: ImportedVoxelInstance[] = [];
    const hasGraph = Array.from(nodes.values()).some(n => n.kind === 'shp');
    if (hasGraph) {
        let rootId = -1;
        for (const id of nodes.keys()) {
            if (!referencedIds.has(id)) { rootId = id; break; }
        }
        if (rootId === -1) rootId = 0;
        const visiting = new Set<number>();
        const walk = (nodeId: number, rot: Mat3, trans: Vec3, name: string | null): void => {
            const node = nodes.get(nodeId);
            if (!node) return;
            if (visiting.has(nodeId)) throw new Error('Invalid .vox scene graph (cycle detected)');
            visiting.add(nodeId);
            if (node.kind === 'trn') {
                const combinedRot = mulMat3(rot, node.rotation);
                const rotated = mulMatVec(rot, node.translation);
                const combinedTrans: Vec3 = [trans[0] + rotated[0], trans[1] + rotated[1], trans[2] + rotated[2]];
                walk(node.childId, combinedRot, combinedTrans, node.name ?? name);
            } else if (node.kind === 'grp') {
                for (const cid of node.childIds) walk(cid, rot, trans, name);
            } else {
                for (const modelId of node.modelIds) {
                    if (modelId >= 0 && modelId < grids.length) {
                        if (instances.length >= MAX_SCENE_INSTANCES) {
                            throw new Error('Scene graph expands to too many instances (limit 65,536)');
                        }
                        instances.push({ gridIndex: modelId, rotation: rot, translation: trans, name });
                    }
                }
            }
            visiting.delete(nodeId);
        };
        walk(rootId, identityMat3(), [0, 0, 0], null);
    }
    if (instances.length === 0) {
        for (let i = 0; i < grids.length; i++) {
            instances.push({ gridIndex: i, rotation: IDENTITY_ROTATION, translation: [0, 0, 0], name: null });
        }
    }

    return {
        format: 'vox',
        grids,
        palette: palette ?? VOX_DEFAULT_PALETTE,
        paletteEmissive: hasEmissive ? emissiveByColor : null,
        instances,
        notes,
    };
}
