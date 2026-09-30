import * as THREE from 'three';
import { addFoliageAttributes } from 'engine/foliage/FoliageGeometry.js';

/** Dense forged levels can draw hundreds of thousands of tufts: nine triangles each. */
export function createGroundCoverTuft(): THREE.BufferGeometry {
    const p: number[] = [], colors: number[] = [], flex: number[] = [], indices: number[] = [];
    const blades = [
        { x: -0.07, z: -0.04, h: 0.3, lean: 0.1, yaw: 0 },
        { x: 0.06, z: 0.05, h: 0.4, lean: 0.13, yaw: 2.1 },
        { x: 0.01, z: -0.08, h: 0.24, lean: 0.09, yaw: 4.2 },
    ];
    for (const blade of blades) {
        const base = p.length / 3;
        for (const [t, side] of [[0, -1], [0, 1], [0.55, -1], [0.55, 1], [1, 0]]) {
            const across = side! * 0.042 * (1 - t! * t!);
            const forward = blade.lean * t! * t!;
            p.push(blade.x + across * Math.cos(blade.yaw) + forward * Math.sin(blade.yaw), t! * blade.h,
                blade.z - across * Math.sin(blade.yaw) + forward * Math.cos(blade.yaw));
            colors.push(0.66 + t! * 0.5, 0.74 + t! * 0.38, 0.6 + t! * 0.22); flex.push(t!);
        }
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    addFoliageAttributes(geometry, 0.4);
    geometry.setAttribute('foliageFlex', new THREE.Float32BufferAttribute(flex, 1));
    // All grass receives the baked terrain tint.
    geometry.setAttribute('foliagePetal', new THREE.Float32BufferAttribute(new Float32Array(flex.length).fill(1), 1));
    return geometry;
}

/** Crossed stems and a five-petal cup. 19 triangles, with terrain-coloured leaves. */
export function createGroundCoverFlower(): THREE.BufferGeometry {
    const p: number[] = [], colors: number[] = [], mask: number[] = [], indices: number[] = [];
    const vertex = (x: number, y: number, z: number, color: THREE.Color, tint: number): number => {
        const index = p.length / 3; p.push(x, y, z); colors.push(color.r, color.g, color.b); mask.push(tint); return index;
    };
    const leaf = new THREE.Color(0xffffff), petal = new THREE.Color(0xffedbb), pollen = new THREE.Color(0xd3a13c);
    for (const yaw of [0, Math.PI / 2]) {
        const c = Math.cos(yaw) * 0.012, s = Math.sin(yaw) * 0.012;
        const b = vertex(-c, 0, -s, leaf, 1);
        vertex(c, 0, s, leaf, 1); vertex(-c, 0.34, -s, leaf, 1); vertex(c, 0.34, s, leaf, 1);
        indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 2 / 5, c = Math.cos(a), s = Math.sin(a);
        const b = vertex(c * 0.024, 0.35, s * 0.024, pollen, 0);
        vertex(c * 0.065 - s * 0.035, 0.36, s * 0.065 + c * 0.035, petal, 0);
        vertex(c * 0.12, 0.38, s * 0.12, petal, 0);
        vertex(c * 0.065 + s * 0.035, 0.36, s * 0.065 - c * 0.035, petal, 0);
        const center = vertex(0, 0.35, 0, pollen, 0);
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3, center, b + 1, b + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('foliagePetal', new THREE.Float32BufferAttribute(mask, 1));
    geometry.setIndex(indices); geometry.computeVertexNormals(); addFoliageAttributes(geometry, 0.38, 0.55);
    return geometry;
}
