import * as THREE from 'three';
import {
    GroundDetailSystem,
    planColumnDetail, collectColumnSurfaces, maskDirectionYaw, DEFAULT_GROUND_DETAIL_OPTIONS,
    groundDetailOptionsFor, coverBudgetForDensity, grassHeightScale,
    densityBandForDistance, DENSITY_BAND_BOUNDS,
    type GroundDetailOptions, type DetailInstance,
} from 'engine/vxlscene/GroundDetailSystem.js';
import type { GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_MASK_HEIGHT_STEP } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';
import type { DecodedVxlSceneWorld, DecodedChunk, DecodedChunkQuads } from 'engine/vxlscene/VxlSceneFormat.js';

/** One up-facing Y quad in SoA form (min-cell coords; w along Z, h along X). */
function upQuad(gx: number, gy: number, gz: number, hAlongX: number, wAlongZ: number, colorIdx: number): DecodedChunkQuads {
    return {
        count: 1,
        gx: Uint16Array.of(gx), gy: Uint16Array.of(gy), gz: Uint16Array.of(gz),
        w: Uint16Array.of(wAlongZ), h: Uint16Array.of(hAlongX),
        axisDir: Uint8Array.of(1), // axis=Y (1), dir=+1, offset 0
        colorIdx: Uint16Array.of(colorIdx),
        disp: Int8Array.of(0),
    };
}

function emptyVoxels(): DecodedChunk['voxels'] {
    return {
        count: 0,
        gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
        sizeLevel: new Uint8Array(0), colorIdx: new Uint16Array(0), flags: new Uint8Array(0), disp: null,
    };
}

/**
 * A 16 m world with one ground chunk: an up-facing surface across the whole
 * chunk at min-cell layer gy (top face at (gy+1)*0.5 = 2.0 m for gy 3).
 */
function makeWorld(mask: GroundMaskData): DecodedVxlSceneWorld {
    const chunk: DecodedChunk = {
        cx: 0, cy: 0, cz: 0,
        voxels: emptyVoxels(),
        lodHints: [upQuad(0, 3, 0, 32, 32, 100)],
        namedTrimeshes: [],
        surfaceTile: null,
    };
    return {
        chunkSize: 16,
        minVoxelSize: 0.5,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
        lodDistances: [100],
        chunks: [chunk],
        groundMask: mask,
    };
}

const SURF_Y = 2.0; // (gy 3 + 1) * 0.5
const SURF_Q = Math.round(SURF_Y / GROUND_MASK_HEIGHT_STEP);

function makeMask(fill: (cx: number, cz: number) => number): GroundMaskData {
    const width = 32, height = 32;
    const types = new Uint8Array(width * height);
    const topY = new Uint16Array(width * height);
    for (let cz = 0; cz < height; cz++) {
        for (let cx = 0; cx < width; cx++) {
            const t = fill(cx, cz);
            if (t !== 0) {
                types[cz * width + cx] = t;
                topY[cz * width + cx] = SURF_Q;
            }
        }
    }
    return { cellSize: 0.5, width, height, types, topY };
}

/** A 16 m world whose whole ground mask is one type. */
function worldOf(type: number): DecodedVxlSceneWorld {
    return makeWorld(makeMask(() => type));
}

/** Plan column (0, 0) of `world`, with option overrides on top of the defaults. */
function planColumn(
    world: DecodedVxlSceneWorld,
    overrides: Partial<GroundDetailOptions> = {},
): ReturnType<typeof planColumnDetail> {
    return planColumnDetail(world, world.groundMask!, 0, 0, { ...DEFAULT_GROUND_DETAIL_OPTIONS, ...overrides });
}

/** Grass cover — the instance kinds subject to density and thinning. */
const isCover = (i: DetailInstance): boolean => i.kind === 'tuft' || i.kind === 'flower';

describe('collectColumnSurfaces', () => {
    it('maps typed mask cells to the up-facing quad top + color', () => {
        const world = worldOf(GROUND_TYPE.cobble);
        const surfaces = collectColumnSurfaces(world, world.groundMask!, 0, 0);
        expect(surfaces.size).toBe(32 * 32);
        const s = surfaces.get(5 * 32 + 7)!;
        expect(s.y).toBeCloseTo(SURF_Y, 6);
        expect(s.colorIdx).toBe(100);
    });
});

describe('planColumnDetail', () => {
    it('spawns one dome per cobble cell, none on untyped cells', () => {
        const world = makeWorld(makeMask((cx) => (cx < 8 ? GROUND_TYPE.cobble : GROUND_TYPE.none)));
        const plan = planColumn(world);
        const domes = plan.instances.filter((i) => i.kind === 'dome');
        expect(domes.length).toBe(8 * 32);
        for (const d of domes) {
            expect(d.x).toBeLessThan(4); // cobble strip is x < 8 cells * 0.5 m
            expect(d.y).toBeCloseTo(SURF_Y, 6);
        }
        expect(plan.instances.some((i) => i.kind === 'tuft')).toBe(false);
    });

    it('mask/surface height mismatch (roof, bridge) spawns nothing', () => {
        const mask = makeMask(() => GROUND_TYPE.cobble);
        // Pretend the typed ground is 5 m below the visible surface (i.e. the
        // quad here is a roof/deck, not the typed ground).
        for (let i = 0; i < mask.topY.length; i++) mask.topY[i] = Math.round((SURF_Y - 5) / GROUND_MASK_HEIGHT_STEP);
        const plan = planColumn(makeWorld(mask));
        expect(plan.instances).toHaveLength(0);
    });

    it('grass variants scale cover density; dry gets no flowers', () => {
        const lushPlan = planColumn(worldOf(GROUND_TYPE.grassLush));
        const dryPlan = planColumn(worldOf(GROUND_TYPE.grassDry));
        expect(lushPlan.instances.length).toBeGreaterThan(dryPlan.instances.length * 2);
        expect(dryPlan.instances.some((i) => i.kind === 'flower')).toBe(false);
        expect(lushPlan.instances.some((i) => i.kind === 'tuft')).toBe(true);
    });

    it('brick cells spawn brick pairs and respect the stone budget', () => {
        const plan = planColumn(worldOf(GROUND_TYPE.brick), { maxStonesPerChunk: 100 });
        const bricks = plan.instances.filter((i) => i.kind === 'brick');
        expect(bricks.length).toBe(100);
        expect(plan.stonesDropped).toBeGreaterThan(0);
    });

    it('is deterministic for a fixed seed', () => {
        const world = worldOf(GROUND_TYPE.grass);
        expect(planColumn(world).instances).toEqual(planColumn(world).instances);
    });
});

describe('maskDirectionYaw', () => {
    it('recovers the direction of a typed strip', () => {
        // A horizontal (along-X) brick road strip 4 cells wide.
        const mask = makeMask((_cx, cz) => (cz >= 14 && cz < 18 ? GROUND_TYPE.brick : GROUND_TYPE.none));
        const yaw = maskDirectionYaw(mask, 16, 15);
        // Along X → yaw ~ 0 (mod π).
        const norm = Math.abs(Math.atan2(Math.sin(yaw), Math.cos(yaw)));
        expect(Math.min(norm, Math.PI - norm)).toBeLessThan(0.2);
    });
});

describe('cover density (authorable thickness)', () => {
    const tufts = (t: number, density: number): number =>
        planColumn(worldOf(t), { density, maxCoverPerChunk: coverBudgetForDensity(density) })
            .instances.filter(isCover).length;

    it('density 1 keeps the original sprinkle (~half the cells of lush grass)', () => {
        const n = tufts(GROUND_TYPE.grassLush, 1);
        expect(n).toBeGreaterThan(0.4 * 32 * 32);
        expect(n).toBeLessThan(0.6 * 32 * 32);
    });

    it('raising density thickens the field roughly in proportion', () => {
        const base = tufts(GROUND_TYPE.grassLush, 1);
        const thick = tufts(GROUND_TYPE.grassLush, 5);
        // 5x the cover multiplier → ~5x the tufts (hash jitter, so allow slack).
        expect(thick / base).toBeGreaterThan(4);
        expect(thick / base).toBeLessThan(6);
    });

    it('the per-chunk budget grows with density — a thick field is never silently clamped', () => {
        const world = worldOf(GROUND_TYPE.grassLush);
        const clamped = planColumn(world, { density: 6 }); // stock budget
        const budgeted = planColumn(world, { density: 6, maxCoverPerChunk: coverBudgetForDensity(6) });

        expect(clamped.coverDropped).toBeGreaterThan(0);
        expect(budgeted.coverDropped).toBe(0);
        expect(budgeted.instances.length).toBeGreaterThan(clamped.instances.length);
    });

    it('density 0 leaves bare ground', () => {
        expect(tufts(GROUND_TYPE.grassLush, 0)).toBe(0);
    });

    it('cut grass stays thinner AND shorter than long grass at the same density', () => {
        expect(tufts(GROUND_TYPE.grassDry, 4)).toBeLessThan(tufts(GROUND_TYPE.grassLush, 4));
        expect(grassHeightScale(GROUND_TYPE.grassDry)).toBeLessThan(grassHeightScale(GROUND_TYPE.grassLush));
    });

    it('scale multiplies tuft size so a meadow can stand tall', () => {
        const world = worldOf(GROUND_TYPE.grassLush);
        const at = (scale: number): number =>
            Math.max(...planColumn(world, { scale }).instances.filter((i) => i.kind === 'tuft').map((i) => i.scale));
        expect(at(2)).toBeCloseTo(at(1) * 2, 5);
    });
});

describe('groundDetailOptionsFor', () => {
    it('defaults every field when the game authored no cover config', () => {
        expect(groundDetailOptionsFor(undefined)).toEqual(DEFAULT_GROUND_DETAIL_OPTIONS);
    });

    it('applies the game config and widens the budget to match the density', () => {
        const opts = groundDetailOptionsFor({ density: 5, scale: 1.4, distance: 120 });
        expect(opts.density).toBe(5);
        expect(opts.scale).toBe(1.4);
        expect(opts.detailDistance).toBe(120);
        expect(opts.maxCoverPerChunk).toBe(coverBudgetForDensity(5));
    });

    it('clamps nonsense rather than rendering nothing', () => {
        const opts = groundDetailOptionsFor({ density: -3, scale: 0, distance: 1 });
        expect(opts.density).toBe(0);
        expect(opts.scale).toBeGreaterThan(0);
        expect(opts.detailDistance).toBeGreaterThanOrEqual(10);
    });
});

describe('GroundDetailSystem mow invalidation (dirty columns, cooldown, buffer reuse)', () => {
    // Camera at the center of column (0,0) — well inside the detail ring.
    const CAM = new THREE.Vector3(8, 2, 8);
    const FAR_CAM = new THREE.Vector3(500, 2, 500);
    let nowSpy: jest.SpyInstance;
    const setNow = (ms: number): void => { nowSpy.mockReturnValue(ms); };

    beforeEach(() => { nowSpy = jest.spyOn(performance, 'now').mockReturnValue(0); });
    afterEach(() => { nowSpy.mockRestore(); });

    /** A system with column (0,0) already built at t=1000, plus the live mask to mow. */
    function builtSystem(type: number): { mask: GroundMaskData; parent: THREE.Group; sys: GroundDetailSystem } {
        const mask = makeMask(() => type);
        const parent = new THREE.Group();
        const sys = new GroundDetailSystem(makeWorld(mask), parent, DEFAULT_GROUND_DETAIL_OPTIONS);
        setNow(1000);
        sys.updateDetail(CAM);
        return { mask, parent, sys };
    }

    /** The column's mesh for one detail kind, or undefined while unbuilt/dropped. */
    function detailMesh(parent: THREE.Group, kind: string): THREE.InstancedMesh | undefined {
        const group = parent.children[0] as THREE.Group;
        return group.children.find((c) => c.name === `GroundDetail_${kind}`) as THREE.InstancedMesh | undefined;
    }

    it('keeps the old cover rendering between invalidation and rebuild (no blank flash)', () => {
        const { parent, sys } = builtSystem(GROUND_TYPE.grassLush);
        const mesh = detailMesh(parent, 'tuft')!;
        expect(mesh).toBeDefined();
        const drawn = mesh.count;
        expect(drawn).toBeGreaterThan(0);

        sys.invalidateRegion(0, 0, 16, 16);

        expect(detailMesh(parent, 'tuft')).toBe(mesh);
        expect(mesh.count).toBe(drawn);
    });

    it('rebuilds a stale dirty column on the next update, reusing its instance buffers', () => {
        const { mask, parent, sys } = builtSystem(GROUND_TYPE.grassLush);
        const mesh = detailMesh(parent, 'tuft')!;
        const before = mesh.count;
        const capacity = mesh.instanceMatrix.count;

        // Mow the whole column: lush meadow -> dry stubble (thinner cover).
        mask.types.fill(GROUND_TYPE.grassDry);
        setNow(5000); // last build long ago -> the rebuild must land immediately
        sys.invalidateRegion(0, 0, 16, 16);
        sys.updateDetail(CAM);

        expect(detailMesh(parent, 'tuft')).toBe(mesh);
        expect(mesh.instanceMatrix.count).toBe(capacity);
        expect(mesh.count).toBeGreaterThan(0);
        expect(mesh.count).toBeLessThan(before);
        // Dry stubble grows no flowers — the flower mesh must stop drawing.
        const flowers = detailMesh(parent, 'flower');
        if (flowers) expect(flowers.count).toBe(0);
    });

    it('rate-limits repeated rebuilds of one column to the cooldown window', () => {
        const { parent, sys } = builtSystem(GROUND_TYPE.grassLush);
        const mesh = detailMesh(parent, 'tuft')!;
        const v1 = mesh.instanceMatrix.version;

        setNow(5000);
        sys.invalidateRegion(0, 0, 16, 16);
        sys.updateDetail(CAM); // stale column -> rebuilds right away
        const v2 = mesh.instanceMatrix.version;
        expect(v2).toBeGreaterThan(v1);

        setNow(5016); // one frame later — mowing keeps painting the same column
        sys.invalidateRegion(0, 0, 16, 16);
        sys.updateDetail(CAM); // within the cooldown -> NO rebuild
        expect(mesh.instanceMatrix.version).toBe(v2);

        setNow(5400); // past the cooldown; the column is still dirty
        sys.updateDetail(CAM); // coalesced rebuild lands without a new invalidation
        expect(mesh.instanceMatrix.version).toBeGreaterThan(v2);
    });

    it('replaces the buffer when a replan outgrows its capacity (regrowth)', () => {
        const { mask, parent, sys } = builtSystem(GROUND_TYPE.grassDry);
        const sparseCount = detailMesh(parent, 'tuft')!.count;

        mask.types.fill(GROUND_TYPE.grassLush); // regrow: far more tufts than stubble
        setNow(5000);
        sys.invalidateRegion(0, 0, 16, 16);
        sys.updateDetail(CAM);

        const lush = detailMesh(parent, 'tuft')!;
        expect(lush.count).toBeGreaterThan(sparseCount);
        expect(lush.count).toBeLessThanOrEqual(lush.instanceMatrix.count);
    });

    it('ring exit still disposes the column detail entirely', () => {
        const { parent, sys } = builtSystem(GROUND_TYPE.grassLush);
        expect(detailMesh(parent, 'tuft')).toBeDefined();

        sys.updateDetail(FAR_CAM);
        expect(detailMesh(parent, 'tuft')).toBeUndefined();
    });

    it('reuses wind anchor and colour buffers on mowing, and updates anchors with the live matrices', () => {
        const { mask, parent, sys } = builtSystem(GROUND_TYPE.grassLush);
        const mesh = detailMesh(parent, 'tuft')!;
        const root = mesh.geometry.getAttribute('foliageRoot');
        const tint = mesh.geometry.getAttribute('foliageTint');
        expect(root).toBeInstanceOf(THREE.InstancedBufferAttribute);
        mask.types.fill(GROUND_TYPE.grassDry);
        setNow(5000); sys.invalidateRegion(0, 0, 16, 16); sys.updateDetail(CAM);
        expect(detailMesh(parent, 'tuft')).toBe(mesh);
        expect(mesh.geometry.getAttribute('foliageRoot')).toBe(root);
        expect(mesh.geometry.getAttribute('foliageTint')).toBe(tint);
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < mesh.count; i++) {
            mesh.getMatrixAt(i, matrix);
            expect(root.getX(i)).toBeCloseTo(matrix.elements[12]!);
            expect(root.getY(i)).toBeCloseTo(matrix.elements[13]!);
            expect(root.getZ(i)).toBeCloseTo(matrix.elements[14]!);
        }
        const disposed = jest.fn(); mesh.geometry.addEventListener('dispose', disposed);
        sys.dispose(); expect(disposed).toHaveBeenCalledTimes(1);
    });
});

describe('distance density falloff (foliage LOD)', () => {
    it('band 0 near the camera, sparser bands past each bound', () => {
        expect(densityBandForDistance(0)).toBe(0);
        expect(densityBandForDistance(DENSITY_BAND_BOUNDS[0]! - 1)).toBe(0);
        expect(densityBandForDistance(DENSITY_BAND_BOUNDS[0]! + 1)).toBe(1);
        expect(densityBandForDistance(DENSITY_BAND_BOUNDS[1]! + 1)).toBe(2);
        expect(densityBandForDistance(10_000)).toBe(DENSITY_BAND_BOUNDS.length);
    });

    it('grass cover carries a uniform-ish thinning key; a prefix thins the field evenly', () => {
        const grass = planColumn(worldOf(GROUND_TYPE.grassLush),
            { density: 6, maxCoverPerChunk: coverBudgetForDensity(6) }).instances.filter(isCover);
        expect(grass.length).toBeGreaterThan(1000);
        for (const i of grass) {
            expect(i.thin).toBeGreaterThanOrEqual(0);
            expect(i.thin).toBeLessThan(1);
        }
        // The band prefix draws instances with the smallest keys: at factor 0.3
        // roughly 30% of keys must fall under 0.3 (hash uniformity, with slack).
        const kept = grass.filter((i) => i.thin! < 0.3).length / grass.length;
        expect(kept).toBeGreaterThan(0.24);
        expect(kept).toBeLessThan(0.36);
    });

    it('stone detail carries no thinning key (roads must not develop holes)', () => {
        const plan = planColumn(worldOf(GROUND_TYPE.cobble));
        expect(plan.instances.length).toBeGreaterThan(0);
        for (const i of plan.instances) expect(i.thin).toBeUndefined();
    });
});
