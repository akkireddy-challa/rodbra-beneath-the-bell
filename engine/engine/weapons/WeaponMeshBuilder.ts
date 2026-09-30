import * as THREE from 'three';
import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
import type { WeaponVisualStyle } from 'engine/WeaponVisualStyle.js';

export type WeaponSurface = 'steel' | 'edge' | 'dark' | 'wood' | 'grip' | 'brass' | 'body' | 'glow';
const SURFACES: Record<WeaponSurface, { className: string; color: number }> = {
    steel: { className: 'metal', color: 0x728593 },
    edge: { className: 'metal', color: 0xd2e0e5 },
    dark: { className: 'matte', color: 0x202932 },
    wood: { className: 'wood', color: 0x815035 },
    grip: { className: 'leather', color: 0x3e2c29 },
    brass: { className: 'metal', color: 0xc29a50 },
    body: { className: 'metal', color: 0x536456 },
    glow: { className: 'neon', color: 0xff354b },
};
type Point = readonly [number, number, number];

/**
 * Small authored parts compile into ONE mesh per surface, not one draw per rivet.
 * No global material cache: an equipped weapon owns and disposes its resources.
 * Geometry owns hard normals, so facets survive the first-person material clamp.
 */
export class WeaponMeshBuilder {
    private readonly parts = new Map<WeaponSurface, THREE.BufferGeometry[]>();

    constructor(readonly style: WeaponVisualStyle, private readonly colors: Partial<Record<WeaponSurface, number>> = {}) {}

    add(geometry: THREE.BufferGeometry, surface: WeaponSurface, position: Point = [0, 0, 0], rotation: Point = [0, 0, 0]): void {
        const flat = geometry.index ? geometry.toNonIndexed() : geometry;
        if (flat !== geometry) geometry.dispose();
        flat.computeVertexNormals();
        flat.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
        flat.translate(...position);
        const bucket = this.parts.get(surface) ?? [];
        bucket.push(flat);
        this.parts.set(surface, bucket);
    }

    box(surface: WeaponSurface, size: Point, position: Point, rotation: Point = [0, 0, 0]): void {
        this.add(new THREE.BoxGeometry(...size), surface, position, rotation);
    }

    /** Outline in (Z,Y), extruded across X. Bevels catch light without smoothing. */
    profile(surface: WeaponSurface, outline: readonly (readonly [number, number])[], thickness: number, bevel: number,
        position: Point = [0, 0, 0], rotation: Point = [0, 0, 0]): void {
        const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: thickness - bevel * 2, steps: 1, curveSegments: 1,
            bevelEnabled: bevel > 0, bevelSegments: 1, bevelSize: bevel, bevelThickness: bevel,
        });
        geometry.translate(0, 0, -thickness / 2 + bevel);
        geometry.rotateY(-Math.PI / 2);
        this.add(geometry, surface, position, rotation);
    }

    rod(surface: WeaponSurface, radiusBottom: number, radiusTop: number, start: Point, end: Point): void {
        const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end);
        const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, a.distanceTo(b), this.style === 'block' ? 4 : 8);
        if (this.style === 'block') geometry.rotateY(Math.PI / 4);
        geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
        this.add(geometry, surface, a.add(b).multiplyScalar(0.5).toArray());
    }

    /** Closed blade with a broad flat, cutting bevels and a true tip; no overlapping skins. */
    blade(surface: WeaponSurface, rings: readonly { y: number; z: number; width: number; thickness: number }[], tip: Point,
        ridgeSurface: WeaponSurface = surface): void {
        const vertices: THREE.Vector3[] = [];
        for (const r of rings) {
            vertices.push(new THREE.Vector3(0, r.y, r.z - r.width / 2),
                new THREE.Vector3(r.thickness / 2, r.y, r.z - r.width * 0.22),
                new THREE.Vector3(r.thickness / 2, r.y, r.z + r.width * 0.22),
                new THREE.Vector3(0, r.y, r.z + r.width / 2),
                new THREE.Vector3(-r.thickness / 2, r.y, r.z + r.width * 0.22),
                new THREE.Vector3(-r.thickness / 2, r.y, r.z - r.width * 0.22));
        }
        const buckets = new Map<WeaponSurface, number[]>();
        const triangle = (slot: WeaponSurface, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
            const positions = buckets.get(slot) ?? [];
            positions.push(...a.toArray(), ...b.toArray(), ...c.toArray());
            buckets.set(slot, positions);
        };
        for (let r = 0; r < rings.length - 1; r++) {
            for (let j = 0; j < 6; j++) {
                const slot = j === 1 || j === 4 ? ridgeSurface : surface;
                const a = vertices[r * 6 + j]!, b = vertices[r * 6 + (j + 1) % 6]!;
                const c = vertices[(r + 1) * 6 + j]!, d = vertices[(r + 1) * 6 + (j + 1) % 6]!;
                triangle(slot, a, c, b); triangle(slot, b, c, d);
            }
        }
        for (let j = 1; j < 5; j++) triangle(surface, vertices[0]!, vertices[j]!, vertices[j + 1]!);
        const last = (rings.length - 1) * 6;
        for (let j = 0; j < 6; j++) triangle(j === 1 || j === 4 ? ridgeSurface : surface,
            vertices[last + j]!, new THREE.Vector3(...tip), vertices[last + (j + 1) % 6]!);
        for (const [slot, positions] of buckets) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(positions.flatMap((_, i) => i % 3 === 0 ? [positions[i + 2]!, positions[i + 1]!] : []), 2));
            this.add(geometry, slot);
        }
    }

    finish(group: THREE.Group): void {
        group.userData.weaponVisualStyle = this.style;
        for (const [surface, parts] of this.parts) {
            const geometry = new THREE.BufferGeometry();
            for (const [name, itemSize] of [['position', 3], ['normal', 3], ['uv', 2]] as const) {
                const length = parts.reduce((sum, part) => sum + part.getAttribute(name).array.length, 0);
                const values = new Float32Array(length);
                let offset = 0;
                for (const part of parts) {
                    const source = part.getAttribute(name).array;
                    values.set(source, offset); offset += source.length;
                }
                geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
            }
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
            const definition = SURFACES[surface];
            const material = createWeaponPartMaterial(definition.className, { color: this.colors[surface] ?? definition.color });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = `WeaponSurface_${surface}`;
            // A lightsaber blade emits light; it must not cast an opaque shadow.
            mesh.castShadow = surface !== 'glow';
            mesh.receiveShadow = surface !== 'glow';
            group.add(mesh);
            for (const part of parts) part.dispose();
        }
        this.parts.clear();
    }
}
