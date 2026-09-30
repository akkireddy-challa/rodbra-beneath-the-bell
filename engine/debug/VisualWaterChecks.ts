import * as THREE from 'three';
import { buildWaterSurfaceMesh } from 'engine/WaterSurface.js';
import { createCoastalGroundSampler } from 'engine/water/CoastalGroundSampler.js';
import type { CoastalHeightAt } from 'engine/water/CoastalDepthField.js';

/** Real water materials over regression geometry, including a channel finer than a facet. */
export function addWaterRegression(scene: THREE.Scene, kind: number): THREE.Box3 {
    const bounds = { minX: -512, maxX: 512, minZ: -64, maxZ: 64, minY: -6, maxY: 3 };
    const box = (x: number, width: number, y: number, height: number, color: number): void => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, 128), new THREE.MeshStandardMaterial({ color, roughness: 1 }));
        mesh.position.set(x, y, 0); mesh.receiveShadow = true; scene.add(mesh);
    };
    let sampler: CoastalHeightAt;
    if (kind === 0) {
        const mask = { width: 1, height: 1, cellSize: 1024, topY: Uint16Array.of(1), types: Uint8Array.of(1) };
        sampler = createCoastalGroundSampler(mask, bounds, () => -5);
        box(0, 1024, -5.5, 1, 0xa9996d);
    } else {
        const x0 = kind === 1 ? 3 : 2, x1 = kind === 1 ? 7 : 2.8;
        sampler = x => x > x0 && x < x1 ? -3 : 3;
        box(0, 1024, -3.5, 1, 0xa9996d);
        box((-512 + x0) / 2, 512 + x0, 0, 6, 0x718356);
        box((512 + x1) / 2, 512 - x1, 0, 6, 0x718356);
    }
    const water = buildWaterSurfaceMesh(0, bounds, new THREE.Vector3(-1, 1.5, 0.8), sampler);
    scene.add(water);
    // Position the camera over a small part of the large map, as a player sees it.
    return new THREE.Box3(new THREE.Vector3(-5, -1, -8), new THREE.Vector3(13, 3, 8));
}
