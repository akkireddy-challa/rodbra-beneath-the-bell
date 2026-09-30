import * as THREE from 'three';
import { AssetSpawner, DEFAULT_SPAWN_ASSET_OPTIONS } from 'engine/AssetSpawner.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import type { EngineLike } from 'types/game.js';

jest.mock('engine/VoxelObject.js', () => {
    const three = jest.requireActual<typeof THREE>('three');
    return { VoxelObject: class extends three.Group {
        useAtlas = true;
        dispose = jest.fn();
        loadFromFile = jest.fn(async () => {});
        getVoxelSize(): number { return 0.5; }
        cloneDataTo(): void {}
    } };
});
jest.mock('engine/builders/VoxelObjectBuilder.js', () => ({ VoxelObjectBuilder: {
    registerExternalObject: jest.fn(), unregisterExternalObject: jest.fn(),
} }));
jest.mock('engine/CollectibleComponent.js', () => ({ CollectibleComponent: class {
    dispose = jest.fn();
} }));

function fixture() {
    const texture = new THREE.Texture();
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const other = new THREE.MeshBasicMaterial({ color: 'blue', map: texture });
    const geometry = new THREE.BoxGeometry();
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(geometry, [material, other, material]), new THREE.Mesh(geometry, material));
    return { scene, geometry, material, other, texture };
}

function setup(load = jest.fn(async () => ({ scene: fixture().scene })), type = 'glb') {
    const group = new THREE.Group();
    const engine = {
        loader: { loadAsync: load },
        physicsWorld: {},
        getWorldGroup: () => group,
        getGameData: () => ({ assets: [{ id: 'pickup', name: 'Pickup', type, url: `pickup.${type}` }] }),
    } as unknown as EngineLike;
    return { spawner: new AssetSpawner(engine), group, load };
}

function mesh(object: THREE.Object3D): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial[]> {
    return object.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial[]>;
}

afterEach(() => jest.restoreAllMocks());

test('disposal cannot invalidate survivors or future clones of the cached GLB', async () => {
    const source = fixture();
    const { spawner, load } = setup(jest.fn(async () => ({ scene: source.scene })));
    const sourceGeometryDispose = jest.spyOn(source.geometry, 'dispose');
    const sourceMaterialDispose = jest.spyOn(source.material, 'dispose');
    const textureDispose = jest.spyOn(source.texture, 'dispose');
    const [first, second] = await Promise.all([
        spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS), spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS),
    ]);
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    const a = mesh(first!.object), b = mesh(second!.object);
    expect(a.geometry).not.toBe(b.geometry);
    expect(a.geometry.index).not.toBe(b.geometry.index);
    expect(a.geometry.index!.array).not.toBe(b.geometry.index!.array);
    expect(a.geometry).not.toBe(source.geometry);
    expect(a.material[0]).not.toBe(b.material[0]);
    expect(a.material[0]).not.toBe(source.material);
    expect(a.material[0]!.map).toBe(source.texture);
    a.material[0]!.color.set('red');
    expect(b.material[0]!.color.equals(source.material.color)).toBe(true);
    const survivorDispose = jest.spyOn(b.geometry, 'dispose');
    first!.dispose(); first!.dispose();
    expect(survivorDispose).not.toHaveBeenCalled();
    expect(sourceGeometryDispose).not.toHaveBeenCalled();
    expect(sourceMaterialDispose).not.toHaveBeenCalled();
    expect(textureDispose).not.toHaveBeenCalled();
    const third = await spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS);
    expect(mesh(third!.object).geometry).not.toBe(b.geometry);
    expect(load).toHaveBeenCalledTimes(1);
    spawner.dispose(); spawner.dispose(); second!.dispose(); third!.dispose();
    expect(survivorDispose).toHaveBeenCalledTimes(1);
    expect(sourceGeometryDispose).toHaveBeenCalledTimes(1);
    expect(sourceMaterialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
});

test('material arrays and resources shared inside one spawn are released once, even after replacement', async () => {
    const source = fixture();
    const { spawner, group } = setup(jest.fn(async () => ({ scene: source.scene })));
    const spawned = (await spawner.spawn('pickup', { ...DEFAULT_SPAWN_ASSET_OPTIONS,
        collectible: { radius: 1, onCollect: null } }))!;
    const first = mesh(spawned.object), sibling = spawned.object.children[1] as THREE.Mesh;
    expect(first.geometry).toBe(sibling.geometry);
    expect(first.material[0]).toBe(first.material[2]);
    const geometryDispose = jest.spyOn(first.geometry, 'dispose');
    const materialDisposes = [...new Set(first.material)].map(m => jest.spyOn(m, 'dispose'));
    const sensorDispose = jest.spyOn(spawned.collectibleComponent!, 'dispose');
    const unregister = jest.spyOn(getObjectIdService(), 'unregister');
    const replacement = new THREE.MeshBasicMaterial();
    const replacementDispose = jest.spyOn(replacement, 'dispose');
    sibling.material = replacement;
    first.material = [replacement];
    spawned.object.remove(first);
    spawned.dispose(); spawned.dispose(); spawner.dispose();
    expect(group.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    for (const dispose of materialDisposes) expect(dispose).toHaveBeenCalledTimes(1);
    expect(sensorDispose).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(replacementDispose).not.toHaveBeenCalled();
    replacement.dispose();
});

test('world teardown drains late GLB loads without adding objects or leaking cached resources', async () => {
    const source = fixture();
    let complete!: (value: { scene: THREE.Group }) => void;
    const { spawner, group, load } = setup(jest.fn(() => new Promise<{ scene: THREE.Group }>(r => { complete = r; })));
    const dispose = jest.spyOn(source.geometry, 'dispose');
    const textureDispose = jest.spyOn(source.texture, 'dispose');
    const pending = spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS);
    const alsoPending = spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS);
    spawner.dispose();
    complete({ scene: source.scene });
    expect(await pending).toBeNull(); expect(await alsoPending).toBeNull();
    expect(group.children).toHaveLength(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(await spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
});

test('failed fetches can retry and cancelled arena spawns can be disposed immediately', async () => {
    const load = jest.fn(async () => ({ scene: fixture().scene }));
    load.mockRejectedValueOnce(new Error('network'));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawner, group } = setup(load);
    expect(await spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS)).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
    const cancelled = (await spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS))!;
    const dispose = jest.spyOn(mesh(cancelled.object).geometry, 'dispose');
    cancelled.dispose();
    const survivor = (await spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS))!;
    expect(group.children).toEqual([survivor.object]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    spawner.dispose();
});

test('VXL handle disposal unregisters the external object and releases the cached template on teardown', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ArrayBuffer(0)));
    const clone = jest.spyOn(VoxelObject.prototype, 'cloneDataTo');
    const { spawner } = setup(undefined, 'vxl');
    const spawned = (await spawner.spawn('pickup', DEFAULT_SPAWN_ASSET_OPTIONS))!;
    const voxel = spawned.object as VoxelObject;
    const template = clone.mock.contexts[0]!;
    expect(template.dispose).not.toHaveBeenCalled();
    spawned.dispose(); spawned.dispose(); spawner.dispose();
    expect(voxel.dispose).toHaveBeenCalledTimes(1);
    expect(template.dispose).toHaveBeenCalledTimes(1);
    expect(VoxelObjectBuilder.unregisterExternalObject).toHaveBeenCalledWith(spawned.objectId);
});
