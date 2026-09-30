import * as THREE from 'three';
import { groundContactBounds, NAV_FOOTPRINT_SLICE_M } from 'engine/nav/PropFootprint.js';

/** A lollipop tree: a 0.5 m trunk under a 5 m canopy. */
function tree(): THREE.BufferGeometry {
    const parts = [new THREE.BoxGeometry(0.5, 3, 0.5).translate(0, 1.5, 0), new THREE.BoxGeometry(5, 3, 5).translate(0, 4.5, 0)];
    const pos: number[] = [];
    for (const part of parts) { const p = part.toNonIndexed().getAttribute('position'); for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i)); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
}

describe('prop navmesh footprint', () => {
    it('a tree footprints its trunk, not its canopy', () => {
        const box = groundContactBounds(tree())!;
        expect(box.max.x - box.min.x).toBeCloseTo(0.5, 6);
        expect(box.max.z - box.min.z).toBeCloseTo(0.5, 6);
        expect(box.max.y).toBeLessThanOrEqual(NAV_FOOTPRINT_SLICE_M + 1e-6);
    });

    it('a bus is as wide at the ground as anywhere: the full box', () => {
        const bus = new THREE.BoxGeometry(3, 3, 11); bus.translate(0, 1.5, 0);
        const box = groundContactBounds(bus)!;
        expect(box.max.x - box.min.x).toBeCloseTo(3, 6);
        expect(box.max.z - box.min.z).toBeCloseTo(11, 6);
    });

    it('is computed once per geometry', () => {
        const g = tree();
        expect(groundContactBounds(g)).toBe(groundContactBounds(g));
    });
});
