import * as THREE from 'three';
import { createForgedFoliagePreview } from 'debug/ForgedFoliagePreview.js';
import { buildWaterSurfaceMesh } from 'engine/WaterSurface.js';
import { ExplosionVisual } from 'engine/effects/ExplosionVisual.js';
import type { GroundDetailSystem } from 'engine/vxlscene/GroundDetailSystem.js';

/** Combined production materials/assets; intentionally no bloom or grading beyond ACES. */
export function addVisualVillage(scene: THREE.Scene, house: THREE.Mesh, vehicles: THREE.Object3D[]): { tick: (t: number) => void; dispose: () => void } {
    const land = new THREE.Mesh(new THREE.BoxGeometry(90, 1, 64), new THREE.MeshStandardMaterial({ color: 0x697b4c, roughness: 1 }));
    land.position.y = -0.5; land.receiveShadow = true; scene.add(land);
    const road = new THREE.Mesh(new THREE.BoxGeometry(9, 0.05, 64), new THREE.MeshStandardMaterial({ color: 0x4d5255, roughness: 0.95 }));
    road.position.y = 0.025; road.receiveShadow = true; scene.add(road);
    for (const x of [-15, 15]) for (const z of [-20, 0, 20]) {
        const building = house.clone(); building.position.set(x, 0, z);
        building.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
        building.castShadow = true; building.receiveShadow = true; scene.add(building);
        const pavement = new THREE.Mesh(new THREE.BoxGeometry(11, 0.15, 14), new THREE.MeshStandardMaterial({ color: 0x969486, roughness: 1 }));
        pavement.position.set(x, 0.075, z); pavement.receiveShadow = true; scene.add(pavement);
    }
    vehicles.forEach((vehicle, i) => {
        vehicle.position.set(i % 2 ? -2.5 : 2.5, 0.05, -23 + i * 9);
        vehicle.rotation.y = i % 2 ? 0 : Math.PI;
        vehicle.traverse(child => { if (child instanceof THREE.Mesh) { child.castShadow = true; child.receiveShadow = true; } });
        scene.add(vehicle);
    });
    const grass: GroundDetailSystem[] = [];
    for (const x of [-32, 32]) for (const z of [-16, 0, 16]) {
        const group = new THREE.Group(); group.position.set(x, 0, z); scene.add(group);
        grass.push(createForgedFoliagePreview(group, 73 + grass.length * 17));
    }
    const sea = buildWaterSurfaceMesh(-0.2, { minX: -45, maxX: 45, minZ: 29, maxZ: 65 }, new THREE.Vector3(-1, 1.5, 0.8), (_x, z) => -0.1 - Math.max(0, z - 31) * 0.3);
    scene.add(sea);
    const blast = ExplosionVisual.acquire(scene, new THREE.Vector3(-4, 0.35, 24), { radius: 3, color: 0xff5a12, style: 'voxel', seed: 907 });
    return {
        tick(t): void { grass.forEach(system => { system.appearance.time = t; }); blast.setProgress(t % 1); },
        dispose(): void { grass.forEach(system => system.dispose()); },
    };
}
