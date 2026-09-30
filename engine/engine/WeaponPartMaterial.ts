/**
 * Classed materials for weapon parts — the weapon-facing surface over the
 * neutral core in `engine/ClassedPartMaterial.ts`. A blade says `'metal'` and a
 * grip says `'wood'` instead of hand-tuned metalness/roughness numbers, shades
 * the way a classed voxel of the same class does, and rides the MaterialQuality
 * ladder — which the hand-tuned `MeshStandardMaterial` parts this replaced
 * never did: they paid the full Standard+IBL cost on every device.
 *
 * The core (factory, options type, userData tags, the single-path backend
 * reasoning) moved to `ClassedPartMaterial.ts` when characters and vehicle
 * wheels joined weapons as consumers. This module keeps every export it ever
 * had — generated weapon code in published games imports from here and is
 * frozen — plus the two weapon-specific pieces: the per-equip quality-resolving
 * wrapper and the first-person direct-tier clamp.
 */
import * as THREE from 'three';
import {
    CLASSED_PART_CLASS,
    CLASSED_PART_COLOR,
    CLASSED_PART_GLOW,
    createClassedPartMaterial,
    type ClassedPartMaterial,
    type ClassedPartMaterialOptions,
} from 'engine/ClassedPartMaterial.js';

export { createClassedPartMaterial, isClassedPartMaterial, type ClassedPartMaterial } from 'engine/ClassedPartMaterial.js';

/** The weapon-era names for the shared userData tags — same stored strings. */
export const WEAPON_PART_CLASS = CLASSED_PART_CLASS;
/** The caller's part colour (a number), pre-`albedoScale`. */
export const WEAPON_PART_COLOR = CLASSED_PART_COLOR;
/** The resolved glow level, 0..1+ of the voxel full-glow. */
export const WEAPON_PART_GLOW = CLASSED_PART_GLOW;

export type WeaponPartMaterialOptions = ClassedPartMaterialOptions;

/**
 * The weapon-era name for `createClassedPartMaterial` with the quality omitted
 * (resolved per call — see the core's doc). Kept because generated weapon code
 * in published games makes this exact call and is frozen:
 *
 *     part(group, geometry, createWeaponPartMaterial('metal', { color: 0xcccccc }), y);
 *
 * New non-weapon consumers call `createClassedPartMaterial` from
 * `engine/ClassedPartMaterial.js` instead.
 */
export function createWeaponPartMaterial(
    className: string,
    options: WeaponPartMaterialOptions,
): ClassedPartMaterial {
    return createClassedPartMaterial(className, options);
}

/**
 * Rebuild every helper-tagged 'environment'-tier material under `root` at the
 * 'direct' tier, in place, disposing what it replaces.
 *
 * For meshes drawn where `scene.environment` does not exist — the first-person
 * view-model layer, which is deliberately world-independent and lit for
 * legibility. A Physical material there has no environment to reflect and
 * renders metals dark and flat; Phong under the layer's bright key/fill rig
 * gives the readable travelling highlight instead. Untagged materials
 * (old-style hand-tuned customs) are left exactly as they are, and so are
 * caller postscripts: `transparent`/`opacity` survive the rebuild.
 */
export function clampWeaponPartMaterialsToDirect(root: THREE.Object3D): void {
    root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const current = child.material;
        const materials = Array.isArray(current) ? current : [current];
        const rebuilt = materials.map((mat) => {
            const className = mat.userData[WEAPON_PART_CLASS];
            if (typeof className !== 'string' || !(mat instanceof THREE.MeshPhysicalMaterial)) return mat;
            const color = mat.userData[WEAPON_PART_COLOR];
            const glow = mat.userData[WEAPON_PART_GLOW];
            // 'medium' allows 'direct' and clamps 'environment' — exactly this
            // function's contract — without hard-coding a tier name mapping here.
            const next = createClassedPartMaterial(
                className,
                {
                    color: typeof color === 'number' ? color : 0xffffff,
                    glow: typeof glow === 'number' ? glow : 0,
                    vertexColors: mat.vertexColors === true,
                },
                'medium',
            );
            next.transparent = mat.transparent;
            next.opacity = mat.opacity;
            mat.dispose();
            return next;
        });
        child.material = Array.isArray(current) ? rebuilt : rebuilt[0]!;
    });
}
