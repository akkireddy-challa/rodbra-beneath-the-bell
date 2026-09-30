/**
 * End-to-end fidelity of the smooth ride surface: does what the player SEES
 * match the mesh the level was baked from (and therefore the trimesh collider
 * the vehicle actually drives on)?
 *
 * Runs the real pipeline — `rasterizeChunk` (which measures `dispOffset` from
 * the cell CENTRE) → `buildSurfaceField` → `cornerNormal` — and compares the
 * result against the analytic source surface.
 *
 * Two properties are guarded:
 *   HEIGHT — the rendered surface must sit ON the source surface. It used to
 *            float half a min-voxel (6.25 cm at the forger's 0.125 m default)
 *            above it, because the decoder applied a centre-relative `dy` to
 *            the cell TOP. The road then rendered above its own collider.
 *   NORMAL — a FLAT road must render exactly flat. This is the property the wet
 *            asphalt/SSR path is brutally sensitive to: at grazing incidence a
 *            near-mirror amplifies any normal error, so a wobble invisible on
 *            matte Lambert asphalt becomes a lattice of streaked reflections.
 *
 * Two source-mesh shapes are covered, because the forge chooses between them:
 * a dense ribbon (`path-mesh.ts`) and the terrain-grid tessellation that
 * `road-surface.ts` marches out for a carved track (vertices only on the
 * heightfield grid, metres apart, linearly interpolated between).
 */
import { rasterizeChunk, unpackCell, type RasterTriangle, type RasterCtx } from 'engine/vxlscene/SurfaceRasterizer.js';
import { DEFAULT_OBJECT_CONTROLS } from 'engine/vxlscene/SceneVoxTypes.js';
import { buildSurfaceField, cornerHeightAt } from 'engine/vxlscene/SurfaceMeshBuilder.js';
import type { DecodedVxlSceneWorld, DecodedChunkVoxels } from 'engine/vxlscene/VxlSceneFormat.js';

const S = 0.125;          // minVoxelSize (world-forger default)
const CHUNK = 16;         // chunkSize
const CELLS = CHUNK / S;  // 128

type V3 = [number, number, number];
type Height = (x: number, z: number) => number;

function tri(v0: V3, v1: V3, v2: V3, n: V3): RasterTriangle {
    return { v0, v1, v2, normal: n, nodeName: 'road', sampleColor: () => ({ r: 0.2, g: 0.2, b: 0.2 }) };
}

function norm(a: V3): V3 {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
}

/** Analytic normal of `h` at (x,z). */
function analyticNormal(h: Height, x: number, z: number): V3 {
    const e = 1e-3;
    return norm([-(h(x + e, z) - h(x - e, z)) / (2 * e), 1, -(h(x, z + e) - h(x, z - e)) / (2 * e)]);
}

/** Degrees between two unit vectors. */
function angleDeg(a: V3, b: V3): number {
    const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    return Math.acos(d) * 180 / Math.PI;
}

/**
 * Top surface tessellated on an axis-aligned grid of `cell` metres, each quad
 * split on a fixed diagonal — the shape `road-surface.ts` marches over the
 * terrain heightfield grid. `cell = S` approximates a dense swept ribbon.
 */
function gridTop(h: Height, cell: number): RasterTriangle[] {
    const out: RasterTriangle[] = [];
    const at = (x: number, z: number): V3 => [x, h(x, z), z];
    for (let x = 0; x < CHUNK; x += cell) {
        for (let z = 0; z < CHUNK; z += cell) {
            const x1 = Math.min(CHUNK, x + cell), z1 = Math.min(CHUNK, z + cell);
            const n = analyticNormal(h, (x + x1) / 2, (z + z1) / 2);
            const a = at(x, z), b = at(x, z1), c = at(x1, z1), d = at(x1, z);
            out.push(tri(a, b, c, n), tri(a, c, d, n));
        }
    }
    return out;
}

/** Rasterize + convert the grid's displaced cells into a decoded voxel block. */
function rasterizeToVoxels(tris: RasterTriangle[]): DecodedChunkVoxels {
    const ctx: RasterCtx = {
        originCellX: 0, originCellY: 0, originCellZ: 0,
        cellsPerAxis: CELLS, minVoxelSize: S,
        controlsByNode: { road: { ...DEFAULT_OBJECT_CONTROLS, trimeshCollider: true, displacementAxis: 'y' } },
    };
    const grid = rasterizeChunk(tris, ctx);
    const cells = [...grid.entries()].filter(([, c]) => c.displacementAxis === 'y');
    const n = cells.length;
    const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
    const sizeLevel = new Uint8Array(n), colorIdx = new Uint16Array(n), flags = new Uint8Array(n);
    const disp = new Int8Array(n * 3);
    cells.forEach(([key, c], i) => {
        const [x, y, z] = unpackCell(key);
        gx[i] = x; gy[i] = y; gz[i] = z;
        flags[i] = 2;
        disp[i * 3 + 1] = Math.round(c.dispOffset * 127); // VoxelCompactor.buildDisp
    });
    return { count: n, gx, gy, gz, sizeLevel, colorIdx, flags, disp };
}

/** `SurfaceMeshBuilder.cornerNormal`, rebuilt on the exported corner accessor. */
function cornerNormal(field: ReturnType<typeof buildSurfaceField>, X: number, Z: number): V3 | null {
    const h = cornerHeightAt(field, X, Z);
    if (h === null) return null;
    const N = field.step;
    const hxp = cornerHeightAt(field, X + N, Z) ?? h;
    const hxm = cornerHeightAt(field, X - N, Z) ?? h;
    const hzp = cornerHeightAt(field, X, Z + N) ?? h;
    const hzm = cornerHeightAt(field, X, Z - N) ?? h;
    const span = 2 * N * field.s;
    return norm([-(hxp - hxm) / span, 1, -(hzp - hzm) / span]);
}

interface Fidelity {
    /** Worst |rendered normal − analytic normal| over the interior, in degrees. */
    maxNormalDeg: number;
    /** Worst |rendered height − analytic height| over the interior, in metres. */
    maxHeightErr: number;
    /** Mean signed height error — catches a CONSTANT float/sink of the surface. */
    meanHeightErr: number;
}

function measure(tris: RasterTriangle[], h: Height): Fidelity {
    const voxels = rasterizeToVoxels(tris);
    const world: DecodedVxlSceneWorld = {
        chunkSize: CHUNK, minVoxelSize: S,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
        lodDistances: [],
        chunks: [{ cx: 0, cy: 0, cz: 0, voxels, lodHints: [], namedTrimeshes: [] }],
    };
    const field = buildSurfaceField(world, 1);

    // Interior corners only (4-cell margin): at the rim `cornerNormal` falls back
    // to the centre height for absent neighbours, which is an edge behaviour, not
    // a fidelity statement.
    let maxNormalDeg = 0, maxHeightErr = 0, sum = 0, n = 0;
    for (let ix = 4; ix < field.sx - 4; ix++) {
        for (let iz = 4; iz < field.sz - 4; iz++) {
            const X = field.gx0 + ix, Z = field.gz0 + iz;
            const hh = cornerHeightAt(field, X, Z);
            if (hh === null) continue;
            const nrm = cornerNormal(field, X, Z);
            if (nrm) maxNormalDeg = Math.max(maxNormalDeg, angleDeg(nrm, analyticNormal(h, X * S, Z * S)));
            const err = hh - h(X * S, Z * S);
            maxHeightErr = Math.max(maxHeightErr, Math.abs(err));
            sum += err; n++;
        }
    }
    expect(n).toBeGreaterThan(1000); // the sample actually covered the surface
    return { maxNormalDeg, maxHeightErr, meanHeightErr: sum / n };
}

/** A perfectly level road, at a height deliberately off the voxel lattice. */
const flat: Height = () => 8.137;
/**
 * A realistic carved track: a gentle vertical roll along travel plus a constant
 * 6% cross-fall — metres of undulation over tens of metres, the kind a forged
 * track legitimately has.
 */
const rolling: Height = (x, z) => 8.0 + 0.9 * Math.sin(z * Math.PI / 40) + 0.06 * (x - 8);

describe('smooth ride surface fidelity', () => {
    describe.each([
        ['dense ribbon', S],
        ['1 m grid', 1],
        ['2 m grid', 2],
        ['4 m grid', 4],
    ])('%s source mesh', (_label, cell) => {
        it('renders a FLAT road exactly flat, at the source height', () => {
            const f = measure(gridTop(flat, cell), flat);
            // Exactly flat: the wet/SSR path amplifies normal error enormously at
            // grazing incidence, so anything above noise here shows up as a lattice
            // of streaked reflections on a road the designer authored as level.
            expect(f.maxNormalDeg).toBeCloseTo(0, 6);
            // On the source surface, not floating above it. Bounded by the height
            // quantum (minVoxelSize/127 ≈ 1 mm), NOT by half a voxel.
            expect(f.maxHeightErr).toBeLessThan(S / 127 + 1e-6);
        });

        it('tracks a rolling, cross-fallen road within a degree', () => {
            const f = measure(gridTop(rolling, cell), rolling);
            expect(f.maxNormalDeg).toBeLessThan(1.0);
            expect(f.maxHeightErr).toBeLessThan(0.02);
            // No systematic float/sink — this is the regression that let the road
            // render half a min-voxel above its own trimesh collider.
            expect(Math.abs(f.meanHeightErr)).toBeLessThan(0.01);
        });
    });
});
