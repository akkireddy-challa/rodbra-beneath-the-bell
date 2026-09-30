/**
 * Damage Flash Effect
 * 
 * Provides visual feedback when any object takes damage.
 * Works with any THREE.Object3D - NPCs, animals, player, destructible objects.
 */

import * as THREE from 'three';

export interface DamageFlashConfig {
    /** Flash color (default: red-white 0xff4444) */
    color?: number;
    /** Emissive intensity during flash (default: 2.0) */
    intensity?: number;
    /** Flash duration in milliseconds (default: 100) */
    duration?: number;
    /** Whether flash is enabled (default: true) */
    enabled?: boolean;
}

export class DamageFlash {
    private target: THREE.Object3D;
    private originalMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]> = new Map();
    private isFlashing: boolean = false;
    private enabled: boolean = true;
    private flashColor: THREE.Color;
    private flashIntensity: number;
    private flashDuration: number;
    private timeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(target: THREE.Object3D, config?: DamageFlashConfig) {
        this.target = target;
        this.flashColor = new THREE.Color(config?.color ?? 0xff4444);
        this.flashIntensity = config?.intensity ?? 2.0;
        this.flashDuration = config?.duration ?? 100;
        this.enabled = config?.enabled ?? true;
    }

    /**
     * Trigger the damage flash effect
     * @param intensityMultiplier - Optional multiplier for flash intensity (e.g., 2.0 for critical hits)
     */
    trigger(intensityMultiplier: number = 1.0): void {
        if (!this.enabled || this.isFlashing) return;
        
        this.isFlashing = true;
        const intensity = this.flashIntensity * intensityMultiplier;

        // Store original materials and apply flash
        this.target.traverse((child) => {
            if (child instanceof THREE.Mesh && child.material) {
                // Store original if not already stored
                if (!this.originalMaterials.has(child)) {
                    this.originalMaterials.set(child, child.material);
                }

                // Apply flash material
                child.material = this.createFlashMaterial(child.material, intensity);
            }
        });

        // Clear any existing timeout
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }

        // Restore original materials after flash duration
        this.timeoutId = setTimeout(() => {
            this.restoreOriginalMaterials();
            this.isFlashing = false;
            this.timeoutId = null;
        }, this.flashDuration);
    }

    private createFlashMaterial(
        original: THREE.Material | THREE.Material[],
        intensity: number
    ): THREE.Material | THREE.Material[] {
        if (Array.isArray(original)) {
            return original.map(mat => this.cloneWithFlash(mat, intensity));
        }
        return this.cloneWithFlash(original, intensity);
    }

    private cloneWithFlash(material: THREE.Material, intensity: number): THREE.Material {
        // Handle MeshStandardMaterial and MeshPhysicalMaterial (have emissive)
        // (MeshLambertMaterial also matches — including shared cache-owned
        // Lamberts, which must be cloned before mutation).
        if ('emissive' in material && 'emissiveIntensity' in material) {
            const flashMat = material.clone() as THREE.MeshStandardMaterial;
            // clone() copies userData — drop the shared-cache flag so the flash
            // clone is disposed normally on restore.
            delete flashMat.userData.__sharedLodCache;
            flashMat.emissive = this.flashColor.clone();
            flashMat.emissiveIntensity = intensity;
            return flashMat;
        }

        // Handle MeshBasicMaterial (no emissive, change color directly)
        if (material instanceof THREE.MeshBasicMaterial) {
            const flashMat = material.clone();
            delete flashMat.userData.__sharedLodCache;
            flashMat.color.lerp(this.flashColor, 0.7);
            return flashMat;
        }

        // Handle MeshLambertMaterial (has emissive but different structure).
        // NOTE: effectively dead — Lambert (like Phong and Physical, so classed
        // character parts too) satisfies the first branch's emissive check.
        if (material instanceof THREE.MeshLambertMaterial) {
            const flashMat = material.clone();
            delete flashMat.userData.__sharedLodCache;
            flashMat.emissive = this.flashColor.clone();
            flashMat.emissiveIntensity = intensity;
            return flashMat;
        }

        // Fallback: return original (can't flash unknown material types)
        return material;
    }

    private restoreOriginalMaterials(): void {
        this.target.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const original = this.originalMaterials.get(child);
            if (!original) return;

            // Dispose only what cloneWithFlash created. Its fallback hands the
            // ORIGINAL back for material types it cannot flash, and disposing
            // that would pull a live material — on a block character a
            // cache-owned one, shared by every NPC wearing that colour.
            const originals = Array.isArray(original) ? original : [original];
            const flashMats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of flashMats) {
                if (!originals.includes(mat)) mat.dispose();
            }
            child.material = original;
        });
    }

    /**
     * Update the target object (useful if meshes are added/removed dynamically)
     */
    setTarget(target: THREE.Object3D): void {
        // Restore any active flash first
        if (this.isFlashing) {
            this.restoreOriginalMaterials();
            this.isFlashing = false;
        }
        this.originalMaterials.clear();
        this.target = target;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        // If disabling while flashing, restore immediately
        if (!enabled) {
            this.restoreImmediately();
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    setColor(color: number): void {
        this.flashColor.setHex(color);
    }

    setIntensity(intensity: number): void {
        this.flashIntensity = intensity;
    }

    setDuration(duration: number): void {
        this.flashDuration = duration;
    }

    /**
     * Immediately restore original materials (cancels any active flash)
     * Call this before cloning meshes (e.g., before explosion) to ensure
     * cloned meshes have original materials, not flash materials.
     */
    restoreImmediately(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        if (this.isFlashing) {
            this.restoreOriginalMaterials();
            this.isFlashing = false;
        }
    }

    /**
     * Check if currently flashing
     */
    isCurrentlyFlashing(): boolean {
        return this.isFlashing;
    }

    dispose(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        if (this.isFlashing) {
            this.restoreOriginalMaterials();
        }
        this.originalMaterials.clear();
    }
}

/**
 * Create a damage flash effect for any object
 * Convenience function for one-off usage
 */
export function createDamageFlash(target: THREE.Object3D, config?: DamageFlashConfig): DamageFlash {
    return new DamageFlash(target, config);
}
