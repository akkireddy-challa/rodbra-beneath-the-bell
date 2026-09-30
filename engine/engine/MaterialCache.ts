import * as THREE from 'three';
import { createClassedPartMaterial, type ClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { activeMaterialQuality } from 'engine/DeviceQuality.js';

export interface StandardMaterialOpts {
    roughness?: number;
    metalness?: number;
    emissive?: number;
    transparent?: boolean;
    opacity?: number;
}

export interface BasicMaterialOpts {
    transparent?: boolean;
    opacity?: number;
    depthWrite?: boolean;
}

export interface ClassedMaterialOpts {
    /** Emissive level, 0..1+ of the voxel full-glow — see `ClassedPartMaterialOptions.glow`. */
    glow?: number;
    transparent?: boolean;
    opacity?: number;
}

/**
 * Deduplicates Three.js materials by property key.
 *
 * Instead of creating identical materials for every tower, enemy, or
 * projectile, request one from the cache. If an identical material
 * already exists it is returned; otherwise a new one is created and cached.
 *
 * Prefer {@link getClassed}: name what the surface is MADE OF ('metal',
 * 'wood', 'plastic', … — `engine/VoxelMaterialClass.ts`) and the class picks
 * tuned PBR and rides the material-quality ladder (Physical on desktop-high,
 * Phong on mobile, Lambert on low). The numeric {@link get} form predates
 * material classes and is kept working for published games; avoid it in new
 * code. {@link getBasic} remains the right call for unlit UI/VFX surfaces.
 */
export class MaterialCache {
    private standard = new Map<string, THREE.MeshStandardMaterial>();
    private basic = new Map<string, THREE.MeshBasicMaterial>();
    private classed = new Map<string, ClassedPartMaterial>();

    /**
     * Get or create a MeshStandardMaterial with the given properties.
     * Default roughness=0.45, metalness=0, emissive=0x000000, opaque.
     *
     * LEGACY: hand-tuned PBR numbers, always Standard on every device. New
     * code should name a material class via {@link getClassed} instead.
     */
    get(color: number, opts?: StandardMaterialOpts): THREE.MeshStandardMaterial {
        const roughness = opts?.roughness ?? 0.45;
        const metalness = opts?.metalness ?? 0;
        const emissive = opts?.emissive ?? 0;
        const transparent = opts?.transparent ?? false;
        const opacity = opts?.opacity ?? 1;

        const key = `${color}|${roughness}|${metalness}|${emissive}|${transparent}|${opacity}`;

        let mat = this.standard.get(key);
        if (!mat) {
            mat = new THREE.MeshStandardMaterial({
                color,
                roughness,
                metalness,
                emissive,
                transparent,
                opacity,
            });
            this.standard.set(key, mat);
        }
        return mat;
    }

    /**
     * Get or create a material for a MATERIAL CLASS — what the surface is made
     * of, not what numbers it shades with. Backed by `createClassedPartMaterial`
     * at the quality tier this call resolves (`?matq=` → stored choice →
     * platform default), with the tier in the cache key so a mid-session
     * quality change can never alias tiers.
     *
     *     this.matCache.getClassed('metal', 0x8899aa)
     *     this.matCache.getClassed('glass', 0x88ccff, { transparent: true, opacity: 0.4 })
     */
    getClassed(className: string, color: number, opts?: ClassedMaterialOpts): ClassedPartMaterial {
        const quality = activeMaterialQuality();
        const glow = opts?.glow ?? 0;
        const transparent = opts?.transparent ?? false;
        const opacity = opts?.opacity ?? 1;

        const key = `${className}|${quality}|${color}|${glow}|${transparent}|${opacity}`;

        let mat = this.classed.get(key);
        if (!mat) {
            mat = createClassedPartMaterial(className, { color, glow }, quality);
            // Translucency stays a caller postscript — the classes are opaque.
            mat.transparent = transparent;
            mat.opacity = opacity;
            this.classed.set(key, mat);
        }
        return mat;
    }

    /** Get or create a MeshBasicMaterial — the right call for unlit UI/VFX. */
    getBasic(color: number, opts?: BasicMaterialOpts): THREE.MeshBasicMaterial {
        const transparent = opts?.transparent ?? false;
        const opacity = opts?.opacity ?? 1;
        const depthWrite = opts?.depthWrite ?? true;

        const key = `${color}|${transparent}|${opacity}|${depthWrite}`;

        let mat = this.basic.get(key);
        if (!mat) {
            mat = new THREE.MeshBasicMaterial({
                color,
                transparent,
                opacity,
                depthWrite,
            });
            this.basic.set(key, mat);
        }
        return mat;
    }

    /** Total number of cached materials (standard + basic + classed). */
    get size(): number {
        return this.standard.size + this.basic.size + this.classed.size;
    }

    /** Dispose all cached materials and clear the cache. */
    dispose(): void {
        for (const mat of this.standard.values()) mat.dispose();
        for (const mat of this.basic.values()) mat.dispose();
        for (const mat of this.classed.values()) mat.dispose();
        this.standard.clear();
        this.basic.clear();
        this.classed.clear();
    }
}
