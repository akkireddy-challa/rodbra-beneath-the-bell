import {
    parseMeshLevel,
    MeshLevelSchemaError,
    MESH_LEVEL_FORMAT,
    MESH_LEVEL_VERSION,
    DEFAULT_POINT_LIGHT_DISTANCE_M,
    DEFAULT_SPOT_ANGLE_RAD,
} from 'engine/meshlevel/MeshLevelSchema.js';

/**
 * The `bitmagic-mesh-level` v1 contract: every violation throws with a JSON
 * path, nothing is silently defaulted except the documented optionals, and
 * the smells that are not violations come back as warnings.
 */
function minimal(): Record<string, unknown> {
    return {
        format: MESH_LEVEL_FORMAT,
        version: MESH_LEVEL_VERSION,
        units: 'meters',
        colliders: [{ name: 'floor', shape: 'box', position: [0, -0.25, 0], size: [10, 0.5, 10] }],
        landmarks: [{ name: 'spawn', position: [0, 0.1, 0] }],
    };
}

function expectSchemaError(raw: unknown, pathContains: string): void {
    let caught: unknown;
    try { parseMeshLevel(raw, 'level'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MeshLevelSchemaError);
    expect((caught as MeshLevelSchemaError).path).toContain(pathContains);
}

describe('parseMeshLevel', () => {
    it('accepts the minimal document and fills the documented defaults', () => {
        const { data, warnings } = parseMeshLevel(minimal(), 'level');
        expect(data.colliders).toHaveLength(1);
        const box = data.colliders[0]!;
        expect(box.shape).toBe('box');
        if (box.shape === 'box') expect(box.yaw).toBe(0);
        expect(box.group).toBeUndefined();
        expect(data.landmarks[0]).toEqual({ name: 'spawn', position: [0, 0.1, 0], yaw: 0, tags: [] });
        expect(data.volumes).toEqual([]);
        expect(data.lights).toEqual([]);
        expect(data.extras).toEqual({});
        expect(warnings).toEqual([]);
    });

    it('rejects the wrong format, version and units with the path', () => {
        expectSchemaError({ ...minimal(), format: 'gltf' }, 'format');
        expectSchemaError({ ...minimal(), version: 2 }, 'version');
        expectSchemaError({ ...minimal(), units: 'cm' }, 'units');
    });

    it('rejects an unknown top-level key (only extras is open)', () => {
        expectSchemaError({ ...minimal(), doors: [] }, 'doors');
        const { data } = parseMeshLevel({ ...minimal(), extras: { modules: [1, 2] } }, 'level');
        expect(data.extras).toEqual({ modules: [1, 2] });
    });

    it('rejects duplicate names within one array', () => {
        const raw = minimal();
        raw.landmarks = [{ name: 'a', position: [0, 0, 0] }, { name: 'a', position: [1, 0, 0] }];
        expectSchemaError(raw, 'landmarks[1].name');
    });

    it('rejects non-finite numbers and zero-size boxes at the exact index', () => {
        const raw = minimal();
        raw.colliders = [{ name: 'floor', shape: 'box', position: [0, Number.NaN, 0], size: [1, 1, 1] }];
        expectSchemaError(raw, 'colliders[0].position[1]');
        raw.colliders = [{ name: 'floor', shape: 'box', position: [0, 0, 0], size: [1, 0, 1] }];
        expectSchemaError(raw, 'colliders[0].size[1]');
    });

    it('rejects a hull with fewer than four points and a trimesh index out of range', () => {
        const raw = minimal();
        raw.colliders = [{ name: 'h', shape: 'convexHull', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0] }];
        expectSchemaError(raw, 'colliders[0].vertices');
        raw.colliders = [{ name: 't', shape: 'trimesh', vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 3] }];
        expectSchemaError(raw, 'colliders[0].indices[2]');
    });

    it('rejects an unknown shape, group and a bad colour', () => {
        const raw = minimal();
        raw.colliders = [{ name: 'x', shape: 'sphere', position: [0, 0, 0] }];
        expectSchemaError(raw, 'colliders[0].shape');
        raw.colliders = [{ name: 'x', shape: 'box', position: [0, 0, 0], size: [1, 1, 1], group: 'player' }];
        expectSchemaError(raw, 'colliders[0].group');
        const lit = minimal();
        lit.lights = [{ name: 'l', type: 'point', position: [0, 2, 0], color: 'red', intensity: 1 }];
        expectSchemaError(lit, 'lights[0].color');
    });

    it('requires a target for spot lights and defaults the optional light fields', () => {
        const raw = minimal();
        raw.lights = [{ name: 's', type: 'spot', position: [0, 3, 0], color: '#ffffff', intensity: 5 }];
        expectSchemaError(raw, 'lights[0].target');
        raw.lights = [
            { name: 's', type: 'spot', position: [0, 3, 0], target: [0, 0, 0], color: '#ffffff', intensity: 5 },
            { name: 'p', type: 'point', position: [0, 2, 0], color: '#ffcc88', intensity: 8 },
        ];
        const { data } = parseMeshLevel(raw, 'level');
        const spot = data.lights[0]!;
        const point = data.lights[1]!;
        expect(spot.type === 'spot' && spot.angle).toBe(DEFAULT_SPOT_ANGLE_RAD);
        expect(spot.type === 'spot' && spot.castShadow).toBe(false);
        expect(point.type === 'point' && point.distance).toBe(DEFAULT_POINT_LIGHT_DISTANCE_M);
    });

    it('warns, rather than throws, for no colliders, no spawn and a paper-thin box', () => {
        const noColliders = parseMeshLevel({ ...minimal(), colliders: [] }, 'level');
        expect(noColliders.warnings.some((w) => w.includes('no colliders'))).toBe(true);
        const noSpawn = parseMeshLevel({ ...minimal(), landmarks: [] }, 'level');
        expect(noSpawn.warnings.some((w) => w.includes('"spawn"'))).toBe(true);
        const thin = minimal();
        thin.colliders = [{ name: 'strip', shape: 'box', position: [0, 0, 0], size: [4, 0.01, 4] }];
        expect(parseMeshLevel(thin, 'level').warnings.some((w) => w.includes('thinner'))).toBe(true);
    });

    it('names the source in the path of a root-level error', () => {
        expectSchemaError('not an object', 'level');
        let caught: unknown;
        try { parseMeshLevel([], 'asset "station"'); } catch (e) { caught = e; }
        expect((caught as MeshLevelSchemaError).message).toContain('asset "station"');
    });
});
