/**
 * createDamageVisualSystem mutates material colours per NPC, so it installs
 * clones. Block characters wear CACHE-OWNED materials
 * (userData.__sharedLodCache): the clone must not inherit the flag (clone()
 * deep-copies userData), and disposing the system must never touch the
 * shared original.
 */
import * as THREE from 'three';
import { createDamageVisualSystem } from 'engine/effects/VoxelEffects.js';

test('damage visual clones carry no shared-cache flag and leave the original alone', () => {
    const shared = new THREE.MeshLambertMaterial({ color: 0x336699 });
    shared.userData.__sharedLodCache = true;
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
    root.add(mesh);
    const sharedDispose = jest.spyOn(shared, 'dispose');

    const controller = createDamageVisualSystem(new THREE.Scene(), root);
    const installed = mesh.material as THREE.Material;
    expect(installed).not.toBe(shared);
    expect(installed.userData.__sharedLodCache).toBeUndefined();
    expect(shared.userData.__sharedLodCache).toBe(true);

    controller.dispose();
    expect(sharedDispose).not.toHaveBeenCalled();
});
