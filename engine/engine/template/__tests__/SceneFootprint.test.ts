import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import { collectSceneFootprint } from 'engine/template/SceneFootprint.js';

jest.mock('engine/EnvironmentObjectSystem.js', () => ({ getActiveEnvironmentObjectSystem: () => null }));

function box(size: number, x: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    mesh.position.set(x, 0, 0);
    return mesh;
}

function fakeEngine(scene: THREE.Scene, player: THREE.Object3D, envObjects: unknown[]): GameEngine {
    return {
        scene,
        getPlayerController: () => ({ getPlayerObject: () => player }),
        getNpcRegistry: () => null,
        genreModule: { worldGenerator: { serializeEnvironmentObjects: () => envObjects } },
    } as unknown as GameEngine;
}

describe('collectSceneFootprint', () => {
    it('keys static meshes and env objects by content, skipping the player and instanced meshes', () => {
        const scene = new THREE.Scene();
        const player = new THREE.Group();
        player.add(box(1, 50));
        const hidden = box(2, 10);
        hidden.visible = false; // culling hides things; they still count
        scene.add(box(2, 0), hidden, player, new THREE.InstancedMesh(new THREE.BoxGeometry(), undefined, 10));

        const entries = collectSceneFootprint(fakeEngine(scene, player, [{ assetId: 'crate', position: { x: 3, y: 0, z: 0 } }]));

        expect(entries.map(e => e.k)).toEqual([
            'mesh:24|0,0,0|2,2,2',
            'mesh:24|10,0,0|2,2,2',
            'env:crate|3,1,0|2,2,2',
        ]);
    });

    it('skips character bodies that live outside the rig, by their naming convention', () => {
        const scene = new THREE.Scene();
        const body = new THREE.Group();
        body.name = 'BlockCharacter_Knight';
        body.add(box(1, 20));
        scene.add(box(2, 0), body);

        const entries = collectSceneFootprint(fakeEngine(scene, new THREE.Group(), []));

        expect(entries.map(e => e.k)).toEqual(['mesh:24|0,0,0|2,2,2']);
    });
});
