import * as THREE from 'three';
import {
    createClassedPartMaterial,
    isClassedPartMaterial,
    type ClassedPartMaterial,
} from 'engine/ClassedPartMaterial.js';
import { GeometryCache } from 'engine/GeometryCache.js';
import type { MaterialQuality } from 'engine/MaterialQuality.js';
import { activeMaterialQuality } from 'engine/DeviceQuality.js';

/**
 * Shared render caches for block-character parts (NPC LOD system, Task 10).
 *
 * Block characters are built from dozens of small BoxGeometry meshes with
 * simple flat-color materials. With hundreds of crowd NPCs those per-part
 * allocations dominate GPU memory and upload time, so identical parts share
 * one geometry / one material instance:
 *
 * - `getSharedBoxGeometry(w, h, d)` deduplicates by dimensions (delegates to
 *   the existing engine `GeometryCache`).
 * - `getSharedLambertMaterial(color, opts)` deduplicates the Lambert materials
 *   produced by CharacterLoader's Standard-to-Lambert conversion.
 *
 * Every cache-owned resource is flagged `userData.__sharedLodCache = true`.
 * Per-NPC teardown paths MUST NOT dispose flagged resources — they are
 * disposed centrally by `clearBlockPartCaches()` (called from
 * `NpcRegistry.disposeAll` at engine teardown). Code that mutates a material
 * in place (tint, damage, flash) must clone first and delete the flag from
 * the clone so the clone is disposed like any per-NPC resource.
 */

let geometryCache = new GeometryCache();
const lambertCache = new Map<string, THREE.MeshLambertMaterial>();

/**
 * Get a shared BoxGeometry for the given dimensions. The returned geometry is
 * cache-owned (`userData.__sharedLodCache`) — never dispose it per-NPC.
 */
export function getSharedBoxGeometry(width: number, height: number, depth: number): THREE.BoxGeometry {
    const geo = geometryCache.box(width, height, depth);
    geo.userData.__sharedLodCache = true;
    return geo;
}

/** Options mirroring the properties CharacterLoader's Lambert conversion preserves. */
export interface SharedLambertOptions {
    emissive?: number | THREE.Color;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    side?: THREE.Side;
}

function toHex(color: number | THREE.Color | undefined, fallback: number): number {
    if (color === undefined) return fallback;
    return typeof color === 'number' ? color : color.getHex();
}

/**
 * Get a shared MeshLambertMaterial for the given color and options. The
 * returned material is cache-owned (`userData.__sharedLodCache`) — never
 * dispose it per-NPC and never mutate it in place (clone-on-write instead).
 */
export function getSharedLambertMaterial(
    color: number | THREE.Color,
    options: SharedLambertOptions = {}
): THREE.MeshLambertMaterial {
    const colorHex = toHex(color, 0xffffff);
    const emissiveHex = toHex(options.emissive, 0x000000);
    const emissiveIntensity = options.emissiveIntensity ?? 1.0;
    const transparent = options.transparent ?? false;
    const opacity = options.opacity ?? 1.0;
    const side = options.side ?? THREE.FrontSide;

    const key = `${colorHex}|${emissiveHex}|${emissiveIntensity}|${transparent ? 1 : 0}|${opacity}|${side}`;
    let mat = lambertCache.get(key);
    if (!mat) {
        mat = new THREE.MeshLambertMaterial({
            color: colorHex,
            emissive: emissiveHex,
            emissiveIntensity,
            transparent,
            opacity,
            side,
        });
        mat.userData.__sharedLodCache = true;
        lambertCache.set(key, mat);
    }
    return mat;
}

/**
 * `userData` key naming the material class a block part REQUESTS — set at
 * construction on the transient `MeshStandardMaterial` (via
 * {@link classedPartStandardMaterial}) and consumed by the block-character
 * conversion, which routes tagged parts to {@link getSharedClassedMaterial}
 * instead of the Lambert cache. Deliberately NOT the factory's own
 * `CLASSED_PART_CLASS` tag: a requested class on a pre-conversion Standard
 * material must not make `isClassedPartMaterial` true (the matte flattener
 * and bloom guards key on that).
 */
export const CHARACTER_PART_CLASS = 'characterPartClass';

/**
 * Build the transient Standard material a block part is authored with, tagged
 * with the material class it should convert to. The pre-conversion look is
 * IDENTICAL to an untagged part (still MeshStandardMaterial with the same
 * params); the class only takes effect at the block-character conversion.
 */
export function classedPartStandardMaterial(
    className: string,
    params: THREE.MeshStandardMaterialParameters,
): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial(params);
    mat.userData[CHARACTER_PART_CLASS] = className;
    return mat;
}

const classedCache = new Map<string, ClassedPartMaterial>();

/**
 * Get a shared CLASSED material — the block-character counterpart of
 * `getSharedLambertMaterial` for parts that declared a material class (a gold
 * buckle, a glass lens). Built by `createClassedPartMaterial` at the resolved
 * MaterialQuality (passed explicitly in tests; resolved per call otherwise, so
 * `setMaterialQuality` affects the next character built), with the authored
 * emissive/transparency/sidedness applied on top. Quality is part of the cache
 * key so a mid-session `?matq=` change can never alias tiers.
 *
 * Cache-owned (`userData.__sharedLodCache`): never dispose per-NPC, never
 * mutate in place — clone-on-write, exactly like the Lambert cache.
 */
export function getSharedClassedMaterial(
    className: string,
    color: number | THREE.Color,
    options: SharedLambertOptions = {},
    quality?: MaterialQuality,
): ClassedPartMaterial {
    const tier = quality ?? activeMaterialQuality();
    const colorHex = toHex(color, 0xffffff);
    const emissiveHex = toHex(options.emissive, 0x000000);
    const emissiveIntensity = options.emissiveIntensity ?? 1.0;
    const transparent = options.transparent ?? false;
    const opacity = options.opacity ?? 1.0;
    const side = options.side ?? THREE.FrontSide;

    const key = `${className}|${tier}|${colorHex}|${emissiveHex}|${emissiveIntensity}|${transparent ? 1 : 0}|${opacity}|${side}`;
    let mat = classedCache.get(key);
    if (!mat) {
        // glow 0: a block part's emissive is AUTHORED (the sparkles), applied
        // below with today's exact semantics — never the class default glow.
        mat = createClassedPartMaterial(className, { color: colorHex, glow: 0 }, tier);
        if (emissiveHex !== 0x000000) {
            mat.emissive = new THREE.Color(emissiveHex);
            mat.emissiveIntensity = emissiveIntensity;
        }
        mat.transparent = transparent;
        mat.opacity = opacity;
        mat.side = side;
        mat.userData.__sharedLodCache = true;
        classedCache.set(key, mat);
    }
    return mat;
}

/**
 * Convert ONE block-part material the way the block-character conversion
 * does: a Standard material becomes the shared Lambert (untagged — the
 * deliberate "characters respond to local lighting" default) or the shared
 * classed material (tagged via {@link CHARACTER_PART_CLASS}); anything else
 * passes through. Disposes the Standard material it replaces. `cloneShared`
 * is the player path: hand out a per-character clone (cache flag stripped) so
 * in-place mutation cannot poison the shared cache.
 */
export function convertBlockPartMaterial(mat: THREE.Material, cloneShared: boolean): THREE.Material {
    if (!(mat instanceof THREE.MeshStandardMaterial)) return mat;
    // MeshPhysicalMaterial EXTENDS MeshStandardMaterial, so an already-classed
    // part would pass the instanceof — leave factory output exactly as is.
    if (isClassedPartMaterial(mat)) return mat;
    const partClass = mat.userData[CHARACTER_PART_CLASS];
    const options: SharedLambertOptions = {
        emissive: mat.emissive,
        emissiveIntensity: mat.emissiveIntensity,
        transparent: mat.transparent,
        opacity: mat.opacity,
        side: mat.side,
    };
    const shared = typeof partClass === 'string'
        ? getSharedClassedMaterial(partClass, mat.color, options)
        : getSharedLambertMaterial(mat.color, options);
    // The original Standard material is per-character and transient — dispose it.
    mat.dispose();
    if (cloneShared) {
        const cloned = shared.clone();
        delete cloned.userData.__sharedLodCache;
        return cloned;
    }
    return shared;
}

/** Dispose every cached geometry and material and empty the caches. */
export function clearBlockPartCaches(): void {
    geometryCache.dispose();
    geometryCache = new GeometryCache();
    for (const mat of lambertCache.values()) mat.dispose();
    lambertCache.clear();
    for (const mat of classedCache.values()) mat.dispose();
    classedCache.clear();
}

/** Cache sizes, for stats/debugging and tests. */
export function blockPartCacheStats(): { geometries: number; materials: number; classedMaterials: number } {
    return { geometries: geometryCache.size, materials: lambertCache.size, classedMaterials: classedCache.size };
}
