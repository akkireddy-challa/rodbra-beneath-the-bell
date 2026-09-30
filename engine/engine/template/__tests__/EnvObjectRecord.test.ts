import { buildEnvObject, findAssetById, INSTANCE_FLAG_FIELDS, rotationDegToRad, type VoxelPlacementInput } from 'engine/template/EnvObjectRecord.js';

describe('findAssetById', () => {
  it('finds the asset the placement names by id, among several of one name', () => {
    const assets = [{ id: 'a_old', name: 'Fixture_lamp_wall' }, { id: 'a_new', name: 'Fixture_lamp_wall' }];
    expect(findAssetById(assets, 'a_new')?.id).toBe('a_new');
    expect(findAssetById(assets, 'a_nope')).toBeUndefined();
    expect(findAssetById(assets, undefined)).toBeUndefined();
    expect(findAssetById(undefined, 'a_new')).toBeUndefined();
  });
});

describe('buildEnvObject', () => {
    const baseInput: VoxelPlacementInput = {
        asset_name: 'decor_bush',
        position: { x: 1, z: 2 },
    };
    const position = { x: 1, y: 0, z: 2 };

    it('writes the core record fields', () => {
        const env = buildEnvObject(baseInput, 'asset_1', 'inst_1', position);
        expect(env).toMatchObject({
            id: 'inst_1',
            type: 'decor_bush',
            assetId: 'asset_1',
            position,
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
        });
    });

    it('omits every optional flag when the input provides none', () => {
        const env = buildEnvObject(baseInput, 'asset_1', 'inst_1', position);
        for (const field of INSTANCE_FLAG_FIELDS) {
            expect(env).not.toHaveProperty(field.out ?? field.in);
        }
    });

    it('round-trips collision: false so decorative props skip their collider', () => {
        const env = buildEnvObject({ ...baseInput, collision: false }, 'asset_1', 'inst_1', position);
        // Regression guard: collision must survive into world.json, otherwise the
        // runtime collider opt-out never takes effect (it is read off this record).
        expect(env.collision).toBe(false);
    });

    it('forwards every placement flag from input to record', () => {
        const fullInput: VoxelPlacementInput = {
            ...baseInput,
            name: 'shrub',
            interactable: true,
            placeOnTerrain: true,
            collectible: true,
            destructible: true,
            dynamic: true,
            mass: 4,
            force_position: true,
            flatten_terrain: false,
            collision: false,
        };
        const env = buildEnvObject(fullInput, 'asset_1', 'inst_1', position);
        expect(env).toMatchObject({
            name: 'shrub',
            interactable: true,
            placeOnTerrain: true,
            collectible: true,
            destructible: true,
            dynamic: true,
            mass: 4,
            forcePosition: true,
            flattenTerrain: false,
            collision: false,
        });
        // Every declared flag must produce an output key for this fully-populated
        // input — catches a flag added to the data model but not the write path.
        for (const field of INSTANCE_FLAG_FIELDS) {
            expect(env).toHaveProperty(field.out ?? field.in);
        }
    });

    it('writes dynamic: true so the prop becomes an individual movable VoxelObject', () => {
        const env = buildEnvObject({ ...baseInput, dynamic: true }, 'asset_1', 'inst_1', position);
        // Without this, the engine batches the prop into a static InstancedMesh
        // and gameplay code can't attach a body to it (kickable-ball bug).
        expect(env.dynamic).toBe(true);
    });

    it('omits dynamic when not requested', () => {
        const env = buildEnvObject(baseInput, 'asset_1', 'inst_1', position);
        expect(env).not.toHaveProperty('dynamic');
    });

    it('round-trips an authored mass and omits it when absent', () => {
        // Authored mass beats the engine's bounding-box estimate (which
        // overestimates sparse shapes); absence must stay absent so the
        // estimate fallback triggers.
        const env = buildEnvObject({ ...baseInput, dynamic: true, mass: 4 }, 'asset_1', 'inst_1', position);
        expect(env.mass).toBe(4);
        const noMass = buildEnvObject({ ...baseInput, dynamic: true }, 'asset_1', 'inst_1', position);
        expect(noMass).not.toHaveProperty('mass');
    });

    it('converts rotation from degrees to radians', () => {
        expect(rotationDegToRad({ x: 0, y: 180, z: 0 })).toMatchObject({ y: Math.PI });
        expect(rotationDegToRad(undefined)).toEqual({ x: 0, y: 0, z: 0 });
    });
});
