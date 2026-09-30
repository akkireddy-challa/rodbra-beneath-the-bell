/**
 * Vehicle downloads are fetched once per URL, not once per use.
 *
 * A kart is built at least twice — the showroom builds every kart for selection, then the
 * level load builds the chosen one again — and nothing was shared between them. On a
 * published circuit the player's 181 KB source GLB was re-fetched during the level load
 * and took 5.3s, queued behind the scenery downloads, appearing in the profile under the
 * GPU warmup's name.
 *
 * Both properties here are silent when broken: a cache miss just looks like a slow load,
 * and a cache that hands out a shared MUTABLE scene corrupts every kart built after the
 * first in ways that look like an asset bug.
 */
import * as THREE from 'three';
import { loadVehicleAssetVisual, clearVehicleAssetCache } from 'engine/vehicle/VehicleAssetVisual.js';
import type { VehicleAssetFitment } from 'types/vehicleFitment.js';

/** A GLB-native asset: exercises the GLB path without dragging in VoxelObject. */
const asset = {
    id: 'kart-1',
    name: 'bumblebug',
    type: 'glb',
    url: 'https://assets.example/kart_player_bumblebug.glb',
} as never;

const fitment: VehicleAssetFitment = {
    version: 1,
    platform: { width: 1.2, length: 2.0 },
    axles: [{
        z: 0.7, y: 0.25, radius: 0.25, width: 0.2, track: 1.0,
        steering: true, driven: false, dual: false, wheelStyle: 'steel',
    }],
    bodyBounds: { min: [-0.6, 0, -1], max: [0.6, 0.8, 1] },
    hasWheelNodes: true,
    collisionBoxes: [],
    mass: 300,
};

/** A scene shaped like a real kart export: a body plus one BM_wheel_* node. */
function kartScene(): THREE.Object3D {
    const scene = new THREE.Object3D();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 2));
    body.name = 'chassis';
    const wheel = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 0.5));
    wheel.name = 'BM_wheel_FL';
    wheel.position.set(0.5, 0.25, 0.7);
    scene.add(body, wheel);
    return scene;
}

/** An engine whose loader counts how many times it was actually asked to download. */
function fakeEngine(scene: THREE.Object3D) {
    let loads = 0;
    return {
        engine: {
            loader: {
                loadAsync: async (): Promise<{ scene: THREE.Object3D }> => {
                    loads += 1;
                    return { scene };
                },
            },
            getRenderConfig: () => ({}),
        } as never,
        loadCount: () => loads,
    };
}

describe('vehicle asset caching', () => {
    beforeEach(() => clearVehicleAssetCache());
    afterEach(() => clearVehicleAssetCache());

    it('downloads a kart GLB once however many times it is built', async () => {
        // Showroom builds it, then the level load builds it again. The second build is the
        // one that used to cost 5.3s.
        const f = fakeEngine(kartScene());
        await loadVehicleAssetVisual(f.engine, asset, fitment);
        await loadVehicleAssetVisual(f.engine, asset, fitment);
        await loadVehicleAssetVisual(f.engine, asset, fitment);
        expect(f.loadCount()).toBe(1);
    });

    it('shares one request between callers that start at the same time', async () => {
        // The showroom builds several karts at once. Caching the RESULT rather than the
        // PROMISE would let every concurrent caller start its own download and miss.
        const f = fakeEngine(kartScene());
        await Promise.all([
            loadVehicleAssetVisual(f.engine, asset, fitment),
            loadVehicleAssetVisual(f.engine, asset, fitment),
        ]);
        expect(f.loadCount()).toBe(1);
    });

    it('gives every build its own wheel nodes, not the cached scene', async () => {
        // splitGlbScene DETACHES BM_wheel_* nodes. Doing that to the cached original would
        // leave the first kart built with wheels and every later one without.
        const f = fakeEngine(kartScene());
        const first = await loadVehicleAssetVisual(f.engine, asset, fitment);
        const second = await loadVehicleAssetVisual(f.engine, asset, fitment);
        expect(first.wheelNodes).toHaveLength(1);
        expect(second.wheelNodes).toHaveLength(1);
        // Distinct objects: sharing one would mean two karts moving the same wheel.
        expect(second.wheelNodes[0]!.mesh).not.toBe(first.wheelNodes[0]!.mesh);
        expect(second.chassisObject).not.toBe(first.chassisObject);
    });

    it('retries after a failure instead of replaying it for the session', async () => {
        // A cached rejection would make one flaky download permanent until reload.
        let attempts = 0;
        const scene = kartScene();
        const engine = {
            loader: {
                loadAsync: async (): Promise<{ scene: THREE.Object3D }> => {
                    attempts += 1;
                    if (attempts === 1) throw new Error('network blip');
                    return { scene };
                },
            },
            getRenderConfig: () => ({}),
        } as never;
        await expect(loadVehicleAssetVisual(engine, asset, fitment)).rejects.toThrow('network blip');
        await expect(loadVehicleAssetVisual(engine, asset, fitment)).resolves.toBeTruthy();
        expect(attempts).toBe(2);
    });
});
