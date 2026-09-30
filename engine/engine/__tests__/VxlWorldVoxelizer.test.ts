/**
 * Unit tests for the pure option-mapping helper in the GLB→VWLD entry.
 *
 * The full GLB round-trip (THREE.GLTFLoader + texture decode) does NOT run
 * cleanly under jsdom, so the entry's testable surface is the pure
 * `buildControlsByNode` mapping that turns the sparse per-object
 * option maps into a dense `Record<string, ObjectControls>`.
 */

import {
    bakeVisibleGroundMask,
    buildControlsByNode,
    computeLevelSizeTransform,
    cullGroundMask,
    remapPathPoints,
    type VxlWorldVoxelizeOptions,
} from 'engine/VxlWorldVoxelizer.js';
import { buildPathCullMask } from 'engine/vxlscene/PathCull.js';
import { bakeSceneFromTriangles } from 'engine/vxlscene/bakeScene.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import { DEFAULT_OBJECT_CONTROLS } from 'engine/vxlscene/SceneVoxTypes.js';

function baseOptions(overrides: Partial<VxlWorldVoxelizeOptions> = {}): VxlWorldVoxelizeOptions {
    return {
        levelSizeX: 32,
        levelSizeZ: 32,
        minVoxelSize: 1,
        maxVoxelSize: 4,
        ...overrides,
    };
}

function groundQuad(x0: number, x1: number, nodeName: string): RasterTriangle[] {
    const tri = (v0: [number, number, number], v1: [number, number, number], v2: [number, number, number]): RasterTriangle => ({
        v0, v1, v2, normal: [0, 1, 0], nodeName,
        sampleColor: () => ({ r: 0.4, g: 0.5, b: 0.6 }),
    });
    return [
        tri([x0, 1, 0], [x1, 1, 0], [x1, 1, 2]),
        tri([x0, 1, 0], [x1, 1, 2], [x0, 1, 2]),
    ];
}

describe('buildControlsByNode', () => {
    it('maps objectCollisionOnlyNodes to the collisionOnly control', () => {
        const controls = buildControlsByNode(baseOptions({
            objectCollisionOnlyNodes: { DungeonCollision: true },
        }));

        expect(controls.DungeonCollision).toEqual({
            ...DEFAULT_OBJECT_CONTROLS,
            collisionOnly: true,
        });
    });

    it('lets collision-only win over a redundant trimesh collider, with a warning, rather than refusing the bake', () => {
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const controls = buildControlsByNode(baseOptions({
                objectCollisionOnlyNodes: { DungeonCollision: true },
                objectTrimeshColliders: { DungeonCollision: true },
            }));
            expect(controls.DungeonCollision).toEqual({ ...DEFAULT_OBJECT_CONTROLS, collisionOnly: true });
            expect(warning).toHaveBeenCalledWith(expect.stringContaining('DungeonCollision'));
        } finally {
            warning.mockRestore();
        }
    });

    it('unions the four per-object maps and applies each control to the right node', () => {
        const controls = buildControlsByNode(baseOptions({
            objectLodOffsets: { a: 1 },
            objectLodPins: { b: true },
            objectTrimeshColliders: { c: true },
            objectDisplacementAxes: { d: 'y' },
        }));

        // All four distinct keys are present.
        expect(Object.keys(controls).sort()).toEqual(['a', 'b', 'c', 'd']);

        // Node 'a' — only the LOD offset is set; everything else defaults.
        expect(controls.a).toEqual({ lodOffset: 1, pinned: false, trimeshCollider: false, noCollider: false, collisionOnly: false, displacementAxis: null });
        // Node 'b' — only pinned.
        expect(controls.b).toEqual({ lodOffset: 0, pinned: true, trimeshCollider: false, noCollider: false, collisionOnly: false, displacementAxis: null });
        // Node 'c' — only trimesh collider.
        expect(controls.c).toEqual({ lodOffset: 0, pinned: false, trimeshCollider: true, noCollider: false, collisionOnly: false, displacementAxis: null });
        // Node 'd' — only displacement axis.
        expect(controls.d).toEqual({ lodOffset: 0, pinned: false, trimeshCollider: false, noCollider: false, collisionOnly: false, displacementAxis: 'y' });
    });

    it('maps objectNoColliders to the noCollider control', () => {
        const controls = buildControlsByNode(baseOptions({
            objectNoColliders: { lines: true },
        }));
        expect(controls.lines).toEqual({ ...DEFAULT_OBJECT_CONTROLS, noCollider: true });
    });

    it('merges multiple controls on a single node', () => {
        const controls = buildControlsByNode(baseOptions({
            objectLodOffsets: { obj: -2 },
            objectLodPins: { obj: true },
            objectTrimeshColliders: { obj: true },
            objectDisplacementAxes: { obj: 'x' },
        }));

        expect(Object.keys(controls)).toEqual(['obj']);
        expect(controls.obj).toEqual({
            lodOffset: -2,
            pinned: true,
            trimeshCollider: true,
            noCollider: false,
            collisionOnly: false,
            displacementAxis: 'x',
        });
    });

    it('returns an empty record when no per-object maps are supplied', () => {
        expect(buildControlsByNode(baseOptions())).toEqual({});
    });

    it('falls back to defaults for nodes only present in one map', () => {
        const controls = buildControlsByNode(baseOptions({
            objectDisplacementAxes: { ramp: 'z' },
        }));
        expect(controls.ramp).toEqual({
            ...DEFAULT_OBJECT_CONTROLS,
            displacementAxis: 'z',
        });
    });
});

describe('collision-only visual side channels', () => {
    it('keeps a ground-typed collision-only node in named collision but out of render and ground-mask data', async () => {
        const normal = groundQuad(0, 2, 'Ground');
        const collisionOnly = groundQuad(2, 4, 'DungeonCollision');
        const triangles = [...normal, ...collisionOnly];
        const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 4, maxZ: 4 };
        const controls = buildControlsByNode(baseOptions({
            objectCollisionOnlyNodes: { DungeonCollision: true },
        }));

        const world = await bakeSceneFromTriangles(triangles, {
            chunkSize: 4,
            minVoxelSize: 1,
            maxVoxelSize: 4,
            additionalLods: 0,
            lodDistances: [50],
            fillInterior: false,
            controlsByNode: controls,
            bounds,
        });
        expect(world.chunks.flatMap((chunk) => chunk.namedTrimeshes).map((mesh) => mesh.name))
            .toContain('DungeonCollision');
        expect(world.chunks.flatMap((chunk) => chunk.lodHints[0] ?? []).length).toBeGreaterThan(0);
        const collisionOnlyWorld = await bakeSceneFromTriangles(collisionOnly, {
            chunkSize: 4,
            minVoxelSize: 1,
            maxVoxelSize: 4,
            additionalLods: 0,
            lodDistances: [50],
            fillInterior: false,
            controlsByNode: controls,
            bounds,
        });
        expect(collisionOnlyWorld.chunks.flatMap((chunk) => chunk.voxels)).toHaveLength(0);
        expect(collisionOnlyWorld.chunks.flatMap((chunk) => chunk.lodHints[0] ?? [])).toHaveLength(0);

        const expected = bakeVisibleGroundMask(
            normal,
            { Ground: 1, DungeonCollision: 2 },
            bounds,
            { DungeonCollision: true },
        );
        const actual = bakeVisibleGroundMask(
            triangles,
            { Ground: 1, DungeonCollision: 2 },
            bounds,
            { DungeonCollision: true },
        );
        expect(actual).toEqual(expected);
        expect(actual).not.toBeNull();
        expect([...actual!.types]).toContain(1);
        expect([...actual!.types]).not.toContain(2);
    });
});

describe('computeLevelSizeTransform', () => {
    // 64 × 64 m footprint, 20 m tall, centred on the origin.
    const src = { minX: -32, minY: 0, minZ: -32, maxX: 32, maxY: 20, maxZ: 32 };

    it('maps the source footprint onto the requested level size, min corner at the origin', () => {
        const xf = computeLevelSizeTransform(src, 128, 128, undefined, 16);
        expect(xf.scaleXZ).toBe(2);
        // Y auto-sizes off the same uniform scale, snapped up to a chunk multiple.
        expect(xf.bounds).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 128, maxY: 48, maxZ: 128 });
        // The world exactly fits the scaled geometry, so there is no padding.
        expect(src.minX * xf.scaleXZ + xf.translateX).toBeCloseTo(0);
        expect(src.minZ * xf.scaleXZ + xf.translateZ).toBeCloseTo(0);
    });

    it('scales uniformly off the tighter axis and centres the slack', () => {
        const xf = computeLevelSizeTransform(src, 256, 128, undefined, 16);
        expect(xf.scaleXZ).toBe(2); // Z is the binding constraint
        // 128 m of scaled width inside a 256 m world → 64 m of padding each side.
        expect(src.minX * xf.scaleXZ + xf.translateX).toBeCloseTo(64);
        expect(src.minZ * xf.scaleXZ + xf.translateZ).toBeCloseTo(0);
    });
});

describe('remapPathPoints', () => {
    const src = { minX: -50, minY: 0, minZ: -50, maxX: 50, maxY: 20, maxZ: 50 };
    const at128 = computeLevelSizeTransform(src, 128, 128, undefined, 16);
    const at256 = computeLevelSizeTransform(src, 256, 256, undefined, 16);

    it('is a no-op when both bakes used the same level size', () => {
        const pts = [{ x: 10, z: 20 }, { x: 30, z: 40 }];
        expect(remapPathPoints(pts, at128, at128)).toEqual(pts);
    });

    it('re-expresses points authored at one level size in another', () => {
        // The centre of the 128 m world is the centre of the 256 m world.
        expect(remapPathPoints([{ x: 64, z: 64 }], at128, at256)[0]).toEqual({ x: 128, z: 128 });
        // And a point a quarter of the way in stays a quarter of the way in.
        const [p] = remapPathPoints([{ x: 32, z: 96 }], at128, at256);
        expect(p!.x).toBeCloseTo(64);
        expect(p!.z).toBeCloseTo(192);
    });

    it('round-trips: authored → other size → back', () => {
        const pts = [{ x: 12, z: 100 }, { x: 77, z: 5 }];
        const there = remapPathPoints(pts, at128, at256);
        const back = remapPathPoints(there, at256, at128);
        for (let i = 0; i < pts.length; i++) {
            expect(back[i]!.x).toBeCloseTo(pts[i]!.x);
            expect(back[i]!.z).toBeCloseTo(pts[i]!.z);
        }
    });
});

describe('cullGroundMask', () => {
    /** A 32×32 m horizontal ground plate at y = 1. */
    const groundPlate = (): RasterTriangle[] => {
        const tri = (
            v0: [number, number, number], v1: [number, number, number], v2: [number, number, number],
        ): RasterTriangle => ({
            v0, v1, v2, normal: [0, 1, 0], nodeName: 'Ground',
            sampleColor: () => ({ r: 0.4, g: 0.5, b: 0.6 }),
        });
        return [
            tri([0, 1, 0], [32, 1, 0], [32, 1, 32]),
            tri([0, 1, 0], [32, 1, 32], [0, 1, 32]),
        ];
    };

    it('blanks typed cells outside the keep-region and leaves the rest alone', () => {
        const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 32 };
        const mask = bakeVisibleGroundMask(groundPlate(), { Ground: 1 }, bounds, undefined);
        expect(mask).not.toBeNull();
        const typedBefore = mask!.types.reduce((n, t) => n + (t !== 0 ? 1 : 0), 0);
        expect(typedBefore).toBeGreaterThan(0);

        cullGroundMask(mask!, bounds, buildPathCullMask(
            { points: [{ x: 0, z: 16 }, { x: 32, z: 16 }], closed: false, distanceM: 4, mode: 'both' },
            { minX: 0, minZ: 0, maxX: 32, maxZ: 32 },
        ));

        for (let cz = 0; cz < mask!.height; cz++) {
            for (let cx = 0; cx < mask!.width; cx++) {
                const i = cz * mask!.width + cx;
                if (mask!.types[i] === 0) continue;
                const z = bounds.minZ + (cz + 0.5) * mask!.cellSize;
                expect(Math.abs(z - 16)).toBeLessThanOrEqual(4);
            }
        }
        const typedAfter = mask!.types.reduce((n, t) => n + (t !== 0 ? 1 : 0), 0);
        expect(typedAfter).toBeGreaterThan(0);
        expect(typedAfter).toBeLessThan(typedBefore);
    });
});
