/**
 * Turns ordinary meshes translucent for ghost presentation.
 *
 * Nothing in the engine provided this — `PlayerVisibility` is binary show/hide
 * — so it lives here, deliberately small.
 *
 * 🚫 Never branch on `instanceof` to identify a material. Under WebGPU stock
 * materials are swapped for their `Mesh*NodeMaterial` equivalents, so every
 * `instanceof THREE.MeshStandardMaterial` check silently evaluates false and
 * the ghost renders opaque on one backend and translucent on the other. Read
 * and write properties STRUCTURALLY instead, which works on both.
 */

import * as THREE from 'three';

export interface GhostMaterialOptions {
    /** 0 = invisible, 1 = solid. */
    opacity: number;
    /** Blended toward the material's own colour, so ghosts stay distinguishable. */
    tint: THREE.ColorRepresentation | null;
    /** How strongly `tint` overrides the original colour, 0..1. */
    tintStrength: number;
    /**
     * Ghosts draw after opaque geometry. Without this a ghost sitting in front
     * of the player's car can sort behind it.
     */
    renderOrder: number;
}

export const DEFAULT_GHOST_MATERIAL_OPTIONS: GhostMaterialOptions = {
    opacity: 0.45,
    tint: null,
    tintStrength: 0.35,
    renderOrder: 10,
};

/** A material-ish object, described by the properties we actually touch. */
interface MaterialLike {
    transparent?: boolean;
    opacity?: number;
    depthWrite?: boolean;
    color?: THREE.Color;
    emissive?: THREE.Color;
    needsUpdate?: boolean;
}

function materialsOf(mesh: THREE.Mesh): MaterialLike[] {
    const material: unknown = mesh.material;
    if (Array.isArray(material)) return material as MaterialLike[];
    return material ? [material as MaterialLike] : [];
}

/**
 * Clone every material under `root` and make the copies translucent.
 *
 * Cloning is not optional: ghost visuals are frequently built from the same
 * cached geometry and materials as the player's own car, and mutating a shared
 * material in place would turn the LIVE vehicle translucent too.
 */
export function applyGhostMaterial(root: THREE.Object3D, options: GhostMaterialOptions): void {
    const tint = options.tint === null ? null : new THREE.Color(options.tint);

    root.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;

        const source: unknown = mesh.material;
        const cloned = Array.isArray(source)
            ? source.map((entry) => (entry as THREE.Material).clone())
            : (source as THREE.Material | undefined)?.clone();
        if (cloned) mesh.material = cloned as THREE.Material | THREE.Material[];

        mesh.renderOrder = options.renderOrder;
        for (const material of materialsOf(mesh)) {
            material.transparent = true;
            material.opacity = options.opacity;
            // Ghosts overlap themselves — wheels through arches, body through
            // glass. Writing depth would make the nearer surface erase the
            // farther one and produce holes.
            material.depthWrite = false;
            if (tint && material.color) {
                material.color.lerp(tint, options.tintStrength);
            }
            if (tint && material.emissive) {
                material.emissive.lerp(tint, options.tintStrength * 0.5);
            }
            material.needsUpdate = true;
        }
    });
}

/** Release cloned materials created by `applyGhostMaterial`. */
export function disposeGhostMaterials(root: THREE.Object3D): void {
    root.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material: unknown = mesh.material;
        if (Array.isArray(material)) {
            for (const entry of material) (entry as THREE.Material).dispose();
        } else if (material) {
            (material as THREE.Material).dispose();
        }
    });
}
