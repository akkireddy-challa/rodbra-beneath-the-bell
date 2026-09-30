import * as THREE from 'three';
import { isVoxelEmissiveMaterial } from 'engine/VoxelEmissiveMaterial.js';
import {
    createWetSurfaceMaterial, type WetSurfaceHandle, type WetSurfaceLook,
} from 'engine/weather/WetSurfaceMaterial.js';

/** Matches VxlSceneRenderer's dedicated ride-surface batch name. */
const SURFACE_BATCH_NAME = 'smoothSurface';

/** Wetness dim applied to the shared blocky-terrain materials at full soak.
 *  The full wet-BRDF treatment runs only on the ride surface; the surrounding
 *  terrain gets this cheap albedo darken so the world reads uniformly rained-on
 *  without touching its (shared, cached) Lambert materials' shaders. */
const TERRAIN_WET_DARKEN = 0.8;

/**
 * Swaps the baked ride surface (`smoothSurface` batch) to the wet-asphalt
 * material while weather is active, and dims the surrounding terrain batches'
 * material colour with wetness. Owns restoration: the original material goes
 * back untouched when the weather clears or the controller is disposed.
 *
 * Level switches rebuild the whole terrain renderer, orphaning the previous
 * batch — `needsReapply()` detects that so the weather system can re-apply
 * against the new scene. The controller captures whatever material is current
 * on the batch (e.g. a seasonal road tint) and restores exactly that.
 */
export class WetSurfaceController {
    private handle: WetSurfaceHandle | null = null;
    private surfaceBatch: THREE.Mesh | null = null;
    private originalMaterial: THREE.Material | null = null;
    /** Shared terrain materials we dim, with their original colours. */
    private readonly dimmed = new Map<THREE.Material & { color: THREE.Color }, THREE.Color>();
    private wetness = 0;

    /**
     * Find the ride surface under `group` and swap in the wet material.
     * Returns false when the group has no smooth-surface batch (nothing to do —
     * rain still falls, but there is no road to soak).
     */
    apply(group: THREE.Object3D): boolean {
        let batch: THREE.Mesh | null = null;
        group.traverse((obj) => {
            if (!batch && obj.name === SURFACE_BATCH_NAME && (obj as THREE.Mesh).isMesh) {
                batch = obj as THREE.Mesh;
            }
        });
        if (!batch) return false;
        if (batch === this.surfaceBatch && this.handle) return true;

        this.restore();

        const found: THREE.Mesh = batch;
        const original = found.material as THREE.Material;
        this.handle = createWetSurfaceMaterial({ emissive: isVoxelEmissiveMaterial(original) });
        this.surfaceBatch = found;
        this.originalMaterial = original;
        found.material = this.handle.material;

        this.collectTerrainMaterials(group, found);
        this.applyTerrainDim();
        return true;
    }

    /** True when a level switch orphaned the batch we swapped (re-apply needed). */
    needsReapply(): boolean {
        return this.surfaceBatch !== null && this.surfaceBatch.parent === null;
    }

    /** True while a wet material is installed on a live batch. */
    isApplied(): boolean {
        return this.handle !== null && this.surfaceBatch !== null && this.surfaceBatch.parent !== null;
    }

    setTime(seconds: number): void { this.handle?.setTime(seconds); }

    setWetness(wetness: number): void {
        this.wetness = THREE.MathUtils.clamp(wetness, 0, 1);
        this.handle?.setWetness(this.wetness);
        this.applyTerrainDim();
    }

    setPuddles(puddles: number): void { this.handle?.setPuddles(puddles); }

    setRippleAmount(amount: number): void { this.handle?.setRippleAmount(amount); }

    /** Push the game's authored look dials (weatherConfig) to the material. */
    setLook(look: WetSurfaceLook): void { this.handle?.setLook(look); }

    setEnvironment(env: THREE.Texture | null): void { this.handle?.setEnvironment(env); }

    /** Restore the original surface material + terrain colours. Idempotent. */
    restore(): void {
        if (this.surfaceBatch && this.originalMaterial && this.surfaceBatch.material === this.handle?.material) {
            this.surfaceBatch.material = this.originalMaterial;
        }
        this.handle?.dispose();
        this.handle = null;
        this.surfaceBatch = null;
        this.originalMaterial = null;
        for (const [mat, color] of this.dimmed) {
            mat.color.copy(color);
        }
        this.dimmed.clear();
    }

    dispose(): void {
        this.restore();
    }

    /** Every unique colour-bearing material on the OTHER terrain batches. */
    private collectTerrainMaterials(group: THREE.Object3D, surfaceBatch: THREE.Mesh): void {
        this.dimmed.clear();
        group.traverse((obj) => {
            if (obj === surfaceBatch || !(obj as THREE.Mesh).isMesh) return;
            const mat = (obj as THREE.Mesh).material;
            if (Array.isArray(mat)) return;
            const colored = mat as THREE.Material & { color?: THREE.Color };
            if (colored.color instanceof THREE.Color && !this.dimmed.has(colored as THREE.Material & { color: THREE.Color })) {
                this.dimmed.set(colored as THREE.Material & { color: THREE.Color }, colored.color.clone());
            }
        });
    }

    private applyTerrainDim(): void {
        const dim = 1 - (1 - TERRAIN_WET_DARKEN) * this.wetness;
        for (const [mat, original] of this.dimmed) {
            mat.color.copy(original).multiplyScalar(dim);
        }
    }
}
