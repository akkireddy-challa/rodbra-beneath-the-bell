/**
 * KeyPickup construction-path tests with a stubbed EngineLike — no real
 * Rapier/PhysicsWorld is built. The fallback path's collectible sensor is
 * built through the injected `CollectibleSensorFactory` seam (see
 * engine/doors/KeyPickup.ts) instead of a real CollectibleComponent, since
 * a real one needs a live WASM-backed PhysicsWorld that would be
 * disproportionate to spin up just to verify KeyPickup's own wiring.
 */
import * as THREE from 'three';
import { KeyPickup, type CollectibleSensorFactory } from 'engine/doors/KeyPickup.js';
import { Keyring } from 'engine/doors/Keyring.js';
import type { EngineLike, KeyItemDefinition } from 'types/game.js';
import type { SpawnedAsset } from 'engine/AssetSpawner.js';

function baseDef(overrides: Partial<KeyItemDefinition> = {}): KeyItemDefinition {
    return {
        id: 'key_1',
        keyId: 'golden_key',
        name: 'Golden Key',
        position: { x: 1, y: 2, z: 3 },
        ...overrides,
    };
}

interface StubSensor {
    factory: CollectibleSensorFactory;
    calls: Array<{ physicsWorld: unknown; config: { object3D: THREE.Object3D; radius: number; collectible: { onCollect: () => void } } }>;
    disposeSpy: jest.Mock;
}

function stubSensorFactory(): StubSensor {
    const disposeSpy = jest.fn();
    const calls: StubSensor['calls'] = [];
    const factory: CollectibleSensorFactory = (physicsWorld, config) => {
        calls.push({ physicsWorld, config: config as StubSensor['calls'][number]['config'] });
        return { dispose: disposeSpy };
    };
    return { factory, calls, disposeSpy };
}

describe('KeyPickup — fallback path (no assetId / no spawnAsset)', () => {
    it('adds the fallback mesh to the world group and wires the sensor via the injected factory', () => {
        const group = new THREE.Group();
        const physicsWorldMarker = {};
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            physicsWorld: physicsWorldMarker,
            registerBeforeRender: jest.fn(() => jest.fn()),
        } as unknown as EngineLike;

        const { factory, calls } = stubSensorFactory();
        const pickup = new KeyPickup(engine, baseDef(), new Keyring(), jest.fn(), factory);

        expect(group.children).toHaveLength(1);
        const mesh = group.children[0] as THREE.Mesh;
        expect(mesh).toBeInstanceOf(THREE.Mesh);
        expect(mesh.position.toArray()).toEqual([1, 2, 3]);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.physicsWorld).toBe(physicsWorldMarker);
        expect(calls[0]!.config.object3D).toBe(mesh);
        expect(calls[0]!.config.radius).toBe(1.5);

        pickup.dispose();
    });

    it('onCollect grants the key, notifies, and disposes (mesh removed, sensor disposed)', () => {
        const group = new THREE.Group();
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            physicsWorld: {},
            registerBeforeRender: jest.fn(() => jest.fn()),
        } as unknown as EngineLike;

        const keyring = new Keyring();
        const notify = jest.fn();
        const { factory, calls, disposeSpy } = stubSensorFactory();

        new KeyPickup(engine, baseDef({ name: 'Golden Key' }), keyring, notify, factory);

        calls[0]!.config.collectible.onCollect();

        expect(keyring.has('golden_key')).toBe(true);
        expect(notify).toHaveBeenCalledWith('Picked up: Golden Key');
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(group.children).toHaveLength(0);
    });

    it('registers a beforeRender callback that spins the mesh, and unregisters it on dispose', () => {
        const group = new THREE.Group();
        const unregister = jest.fn();
        const registerBeforeRender = jest.fn(() => unregister);
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            physicsWorld: {},
            registerBeforeRender,
            getDeltaTime: () => 1,
        } as unknown as EngineLike;

        const { factory } = stubSensorFactory();
        const pickup = new KeyPickup(engine, baseDef(), new Keyring(), jest.fn(), factory);

        const mesh = group.children[0] as THREE.Mesh;
        const spinCallback = registerBeforeRender.mock.calls[0]![0] as () => void;
        const before = mesh.rotation.y;
        spinCallback();
        expect(mesh.rotation.y).not.toBe(before);

        pickup.dispose();
        expect(unregister).toHaveBeenCalledTimes(1);
    });

    it('warns and builds no sensor when physicsWorld is unavailable, but still adds the mesh', () => {
        const group = new THREE.Group();
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            physicsWorld: null,
        } as unknown as EngineLike;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const pickup = new KeyPickup(engine, baseDef(), new Keyring(), jest.fn());
        expect(group.children).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalled();

        expect(() => pickup.dispose()).not.toThrow();
        warnSpy.mockRestore();
    });
});

describe('KeyPickup — spawnAsset path', () => {
    it('spawns via engine.spawnAsset; onCollect grants + notifies + disposes the spawned asset', async () => {
        const group = new THREE.Group();
        const disposeSpy = jest.fn();
        let capturedOnCollect: ((spawned: SpawnedAsset) => void) | null = null;
        const spawnAsset = jest.fn((_assetId: string, options: { collectible: { onCollect: (s: SpawnedAsset) => void } }) => {
            capturedOnCollect = options.collectible.onCollect;
            const spawned: SpawnedAsset = {
                object: new THREE.Object3D(),
                objectId: 'obj_1',
                name: 'key-asset',
                collectibleComponent: null,
                dispose: disposeSpy,
            };
            return Promise.resolve(spawned);
        });
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            spawnAsset,
        } as unknown as EngineLike;

        const keyring = new Keyring();
        const notify = jest.fn();
        new KeyPickup(engine, baseDef({ assetId: 'golden_key_asset', name: 'Golden Key' }), keyring, notify);

        expect(spawnAsset).toHaveBeenCalledWith('golden_key_asset', {
            position: { x: 1, y: 2, z: 3 },
            collectible: { radius: 1.5, onCollect: expect.any(Function) },
        });

        // Let the spawn promise's .then() microtask run.
        await Promise.resolve();
        await Promise.resolve();

        expect(capturedOnCollect).not.toBeNull();
        (capturedOnCollect as unknown as (s: SpawnedAsset) => void)({} as SpawnedAsset);

        expect(keyring.has('golden_key')).toBe(true);
        expect(notify).toHaveBeenCalledWith('Picked up: Golden Key');
        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('disposes the spawned asset immediately if disposed while the spawn was still in flight', async () => {
        const disposeSpy = jest.fn();
        let resolveSpawn!: (spawned: SpawnedAsset) => void;
        const spawnPromise = new Promise<SpawnedAsset>((resolve) => { resolveSpawn = resolve; });
        const spawnAsset = jest.fn(() => spawnPromise);
        const engine = { scene: null, spawnAsset } as unknown as EngineLike;

        const pickup = new KeyPickup(engine, baseDef({ assetId: 'golden_key_asset' }), new Keyring(), jest.fn());
        pickup.dispose(); // disposed before the spawn resolves

        resolveSpawn({
            object: new THREE.Object3D(),
            objectId: 'obj_2',
            name: 'key-asset',
            collectibleComponent: null,
            dispose: disposeSpy,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('wraps a spawned bottom-origin asset in a pivot at def.position, offsetting the child down by its bbox centre', async () => {
        const group = new THREE.Group();
        // Simulate a baked bottom-origin asset: x/z centred, y = 0 at the
        // bottom, spanning up to height 2 — bbox centre (0, 1, 0).
        const geometry = new THREE.BoxGeometry(1, 2, 1);
        geometry.translate(0, 1, 0);
        const assetMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
        const spawnAsset = jest.fn(() => Promise.resolve<SpawnedAsset>({
            object: assetMesh,
            objectId: 'obj_3',
            name: 'key-asset',
            collectibleComponent: null,
            dispose: jest.fn(),
        }));
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            registerBeforeRender: jest.fn(() => jest.fn()),
            spawnAsset,
        } as unknown as EngineLike;

        new KeyPickup(engine, baseDef({ assetId: 'golden_key_asset', position: { x: 1, y: 2, z: 3 } }), new Keyring(), jest.fn());

        await Promise.resolve();
        await Promise.resolve();

        // The pivot — not the asset itself — is what's added to the world
        // group, and it sits at def.position.
        expect(group.children).toHaveLength(1);
        const pivot = group.children[0]!;
        expect(pivot).not.toBe(assetMesh);
        expect(pivot.position.toArray()).toEqual([1, 2, 3]);

        // The asset is reparented under the pivot, offset down by its own
        // bbox centre so the pivot's origin lands on the asset's true middle
        // rather than its bottom-origin local (0,0,0).
        expect(assetMesh.parent).toBe(pivot);
        // toBeCloseTo (not toEqual) — the x/z offsets are computed as -0, which
        // is numerically equal to 0 but fails strict Object.is-based equality.
        expect(assetMesh.position.x).toBeCloseTo(0);
        expect(assetMesh.position.y).toBeCloseTo(-1);
        expect(assetMesh.position.z).toBeCloseTo(0);
    });

    it('registers the beforeRender spin on the pivot for the spawnAsset path too', async () => {
        const group = new THREE.Group();
        const assetMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        const registerBeforeRender = jest.fn(() => jest.fn());
        const spawnAsset = jest.fn(() => Promise.resolve<SpawnedAsset>({
            object: assetMesh,
            objectId: 'obj_4',
            name: 'key-asset',
            collectibleComponent: null,
            dispose: jest.fn(),
        }));
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            registerBeforeRender,
            getDeltaTime: () => 1,
            spawnAsset,
        } as unknown as EngineLike;

        new KeyPickup(engine, baseDef({ assetId: 'golden_key_asset' }), new Keyring(), jest.fn());
        await Promise.resolve();
        await Promise.resolve();

        expect(registerBeforeRender).toHaveBeenCalledTimes(1);
        const pivot = group.children[0]!;
        const spinCallback = registerBeforeRender.mock.calls[0]![0] as () => void;
        const before = pivot.rotation.y;
        spinCallback();
        expect(pivot.rotation.y).not.toBe(before);
        // The asset's own local rotation is untouched — the pivot is what spins.
        expect(assetMesh.rotation.y).toBe(0);
    });

    it('dispose after a successful spawnAsset landing tears down both the asset and the pivot cleanly', async () => {
        const group = new THREE.Group();
        const assetMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        // Mimic AssetSpawner's real SpawnedAsset.dispose(): detaches the asset from its parent.
        const disposeSpy = jest.fn(() => { assetMesh.parent?.remove(assetMesh); });
        const unregister = jest.fn();
        const registerBeforeRender = jest.fn(() => unregister);
        const spawnAsset = jest.fn(() => Promise.resolve<SpawnedAsset>({
            object: assetMesh,
            objectId: 'obj_5',
            name: 'key-asset',
            collectibleComponent: null,
            dispose: disposeSpy,
        }));
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            registerBeforeRender,
            spawnAsset,
        } as unknown as EngineLike;

        const pickup = new KeyPickup(engine, baseDef({ assetId: 'golden_key_asset' }), new Keyring(), jest.fn());
        await Promise.resolve();
        await Promise.resolve();

        expect(group.children).toHaveLength(1); // the pivot landed

        pickup.dispose();

        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(unregister).toHaveBeenCalledTimes(1);
        expect(assetMesh.parent).toBeNull();
        expect(group.children).toHaveLength(0); // the now-empty pivot left the group too

        expect(() => pickup.dispose()).not.toThrow(); // idempotent
    });

    it('falls back to the box-mesh pickup when spawnAsset resolves null (bad/missing asset id)', async () => {
        const group = new THREE.Group();
        const spawnAsset = jest.fn(() => Promise.resolve(null));
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            physicsWorld: {},
            registerBeforeRender: jest.fn(() => jest.fn()),
            spawnAsset,
        } as unknown as EngineLike;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { factory, calls, disposeSpy } = stubSensorFactory();

        const keyring = new Keyring();
        const notify = jest.fn();
        new KeyPickup(engine, baseDef({ assetId: 'missing_asset', name: 'Golden Key' }), keyring, notify, factory);

        // Let the spawn promise's .then() microtask run.
        await Promise.resolve();
        await Promise.resolve();

        expect(group.children).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalled();

        // The fallback pickup is fully functional: collecting it still grants + notifies + disposes.
        calls[0]!.config.collectible.onCollect();
        expect(keyring.has('golden_key')).toBe(true);
        expect(notify).toHaveBeenCalledWith('Picked up: Golden Key');
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(group.children).toHaveLength(0);

        warnSpy.mockRestore();
    });

    it('disposing mid-flight during a failing spawn stays clean — no fallback is built after dispose', async () => {
        const group = new THREE.Group();
        let rejectSpawn!: (err: unknown) => void;
        const spawnPromise = new Promise<SpawnedAsset | null>((_resolve, reject) => { rejectSpawn = reject; });
        const spawnAsset = jest.fn(() => spawnPromise);
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            physicsWorld: {},
            registerBeforeRender: jest.fn(() => jest.fn()),
            spawnAsset,
        } as unknown as EngineLike;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { factory, calls } = stubSensorFactory();

        const pickup = new KeyPickup(engine, baseDef({ assetId: 'missing_asset' }), new Keyring(), jest.fn(), factory);
        pickup.dispose(); // disposed before the spawn settles

        rejectSpawn(new Error('network error'));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(group.children).toHaveLength(0);
        expect(calls).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
    });
});

describe('KeyPickup — key already held at construction', () => {
    it('constructs inert: no spawn, no mesh, and dispose() is a safe no-op', () => {
        const group = new THREE.Group();
        const spawnAsset = jest.fn();
        const engine = {
            getWorldGroup: () => group,
            scene: null,
            physicsWorld: {},
            spawnAsset,
        } as unknown as EngineLike;

        const keyring = new Keyring();
        keyring.grant('golden_key');
        const notify = jest.fn();

        const pickup = new KeyPickup(engine, baseDef({ assetId: 'golden_key_asset' }), keyring, notify);

        expect(spawnAsset).not.toHaveBeenCalled();
        expect(group.children).toHaveLength(0);

        expect(() => pickup.dispose()).not.toThrow();
        expect(() => pickup.dispose()).not.toThrow();
        expect(notify).not.toHaveBeenCalled();
    });
});
