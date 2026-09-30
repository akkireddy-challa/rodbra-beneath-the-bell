import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SeededRandom } from 'engine/SeededRandom.js';

/** Broad patches tie hue and height together without a checkerboard or a texture lookup. */
export function foliagePatch(x: number, z: number): number {
    return 0.5 + 0.28 * Math.sin(x * 0.71 + Math.sin(z * 0.43)) + 0.22 * Math.sin(z * 1.13 - x * 0.27);
}

/** Stable unsigned seeds: regenerating a chunk cannot reshuffle neighbouring plants. */
export function foliageSeed(seed: number, key: string): number {
    let hash = seed >>> 0;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
    return hash;
}

/** Attributes for a single rooted plant, in the same space as its positions. */
export function addFoliageAttributes(geometry: THREE.BufferGeometry, height: number, flexibility = 1): void {
    const p = geometry.getAttribute('position');
    const flex = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) flex[i] = THREE.MathUtils.clamp(p.getY(i) / height, 0, 1) * flexibility;
    const roots = new THREE.Float32BufferAttribute(new Float32Array(p.count * 4), 4);
    for (let i = 0; i < p.count; i++) roots.setW(i, 1);
    geometry.setAttribute('foliageRoot', roots);
    geometry.setAttribute('foliageFlex', new THREE.Float32BufferAttribute(flex, 1));
    if (!geometry.hasAttribute('color')) geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(p.count * 3).fill(1), 3));
}

/** Position transforms don't affect custom anchors; translate both before region merging. */
export function translateFoliage(geometry: THREE.BufferGeometry, x: number, y: number, z: number): void {
    geometry.translate(x, y, z);
    const root = geometry.getAttribute('foliageRoot');
    for (let i = 0; i < root.count; i++) root.setXYZ(i, root.getX(i) + x, root.getY(i) + y, root.getZ(i) + z);
}

/** Folded, tapered ribbons with one pointed tip. 18 triangles/blade, no textures or alpha overdraw. */
export function createMeadowTuft(rng: SeededRandom, x: number, z: number, groundY: number,
    heightAt: (x: number, z: number) => number): THREE.BufferGeometry {
    const positions: number[] = [], uvs: number[] = [], colors: number[] = [], roots: number[] = [], flex: number[] = [], indices: number[] = [];
    const patch = foliagePatch(x, z);
    // Clump-level growth makes short ground cover and taller accents share a
    // meadow without every plant repeating the same conical silhouette.
    const growth = 0.62 + rng.next() * 0.65;
    const spread = 0.18 + (1.25 - growth) * 0.18;
    const count = 7 + Math.floor(rng.next() * 4);
    const facing = rng.next() * Math.PI * 2;
    for (let blade = 0; blade < count; blade++) {
        const angle = facing + blade * 2.39996 + (rng.next() - 0.5) * 0.65;
        const radius = Math.sqrt(rng.next()) * spread;
        const rx = Math.cos(angle) * radius, rz = Math.sin(angle) * radius;
        const ry = heightAt(x + rx, z + rz) - groundY;
        const height = (0.24 + rng.next() * 0.32) * (0.8 + patch * 0.4) * growth;
        const width = (0.03 + rng.next() * 0.035) * (0.8 + growth * 0.2);
        const lean = height * (0.20 + rng.next() * 0.30);
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const base = positions.length / 3;
        const tint = 0.88 + rng.next() * 0.17 + patch * 0.12;
        const vertex = (t: number, side: number): void => {
            const across = side * width * (1 - t * t) * 0.5;
            const forward = lean * t * t + (side === 0 ? width * 0.18 * (1 - t) : 0);
            positions.push(rx + across * cos + forward * sin, ry + t * height, rz - across * sin + forward * cos);
            uvs.push(0.5, 0.875);
            colors.push((0.53 + 0.55 * t) * tint, (0.64 + 0.46 * t) * tint, (0.48 + 0.24 * t) * tint);
            roots.push(rx, ry, rz, 1); flex.push(t);
        };
        for (let row = 0; row < 5; row++) {
            for (const side of [-1, 0, 1]) vertex(row / 5, side);
            if (row < 4) for (let side = 0; side < 2; side++) {
                const a = base + row * 3 + side;
                indices.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
            }
        }
        vertex(1, 0);
        indices.push(base + 12, base + 13, base + 15, base + 13, base + 14, base + 15);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('foliageRoot', new THREE.Float32BufferAttribute(roots, 4));
    geometry.setAttribute('foliageFlex', new THREE.Float32BufferAttribute(flex, 1));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    return geometry;
}

/** A thin green stem, two leaves and a shallow cup of faceted petals. */
export function createMeadowFlower(rng: SeededRandom): THREE.BufferGeometry {
    const height = 0.3 + rng.next() * 0.25;
    const yaw = rng.next() * Math.PI * 2;
    const parts: THREE.BufferGeometry[] = [];
    const part = (geometry: THREE.BufferGeometry, paletteV: number, color: THREE.Color): void => {
        const uv = geometry.getAttribute('uv'), count = geometry.getAttribute('position').count;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, paletteV);
        const colors: number[] = [];
        for (let i = 0; i < count; i++) colors.push(color.r, color.g, color.b);
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        parts.push(geometry);
    };
    part(new THREE.CylinderGeometry(0.008, 0.014, height, 5).translate(0, height / 2, 0), 0.375, new THREE.Color(0xffffff));
    for (let i = 0; i < 2; i++) {
        const leaf = new THREE.SphereGeometry(1, 5, 3);
        leaf.scale(0.065, 0.01, 0.024); leaf.rotateZ((i === 0 ? 1 : -1) * 0.4);
        leaf.translate(i === 0 ? 0.048 : -0.048, height * (0.35 + i * 0.18), 0); leaf.rotateY(yaw);
        part(leaf, 0.875, new THREE.Color(0xc7d69f));
    }
    const petals = 5 + Math.floor(rng.next() * 2);
    for (let i = 0; i < petals; i++) {
        const angle = yaw + i * Math.PI * 2 / petals;
        const petal = new THREE.SphereGeometry(1, 5, 3);
        petal.scale(0.07, 0.018, 0.037); petal.rotateZ(0.2); petal.translate(0.06, height, 0); petal.rotateY(angle);
        part(petal, 0.625, new THREE.Color().setRGB(1, 0.88 + rng.next() * 0.12, 0.8 + rng.next() * 0.2));
    }
    part(new THREE.SphereGeometry(0.03, 6, 3).scale(1, 0.5, 1).translate(0, height + 0.008, 0), 0.625, new THREE.Color(0xe9a443));
    const geometry = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    addFoliageAttributes(geometry, height, 0.55);
    return geometry;
}

/** Segmented square blade: block silhouette retained, upper sections can bend. */
export function createBlockBlade(size: number): THREE.BufferGeometry {
    const geometry = new THREE.BoxGeometry(size, size, size, 1, 3, 1).translate(0, size / 2, 0);
    const p = geometry.getAttribute('position'), colors: number[] = [];
    for (let i = 0; i < p.count; i++) {
        const t = THREE.MathUtils.clamp(p.getY(i) / size, 0, 1);
        p.setY(i, t * size);
        p.setX(i, p.getX(i) * (1 - t * 0.3));
        p.setZ(i, p.getZ(i) * (1 - t * 0.3) + size * t * t * 0.35);
        colors.push(0.58 + 0.47 * t, 0.67 + 0.4 * t, 0.48 + 0.3 * t);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals(); addFoliageAttributes(geometry, size);
    return geometry;
}
