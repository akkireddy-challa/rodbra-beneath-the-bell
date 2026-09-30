import * as THREE from 'three';

/**
 * Rain collision height field, built on the CPU from PHYSICS RAYCASTS against
 * the level's colliders — the same finest-LOD trimeshes vehicles drive on.
 *
 * This replaced a top-down GPU render bake for a hard reason: a scene render
 * captures the batches at whatever LOD they happen to be showing when it runs,
 * and the bake naturally runs while the camera is far from most of the map —
 * so distant chunks baked as coarse LOD produced many-meter height staircases,
 * splashes floated in mid-air on hillsides, and roads sat under phantom
 * coarse-LOD terrain. Raycasting the colliders is deterministic, LOD-free, and
 * immune to the renderer's async pipeline warmup entirely.
 *
 * The build is TIME-SLICED: `step()` raycasts rows under a per-frame time
 * budget until the grid is full (~a few seconds after level load), then
 * uploads one half-float texture. Until `isReady`, the rain simply falls
 * without surface coupling — invisible during a level's countdown/menus.
 */
const FIELD_SIZE = 768;
/** Raycast budget per frame (ms) while building. */
const STEP_BUDGET_MS = 4;
const CAMERA_MARGIN_M = 4;

export interface RainFieldBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
}

export class RainHeightField {
    /** Half-float single-channel height texture (r16f is linearly filterable). */
    readonly texture: THREE.DataTexture;
    /** World rect the texture covers — the compute shader's uv mapping. */
    readonly mapMin = new THREE.Vector2();
    readonly mapSize = new THREE.Vector2(1, 1);
    /** Recycle height for drops that leave the mapped area. */
    noHitFloorY = -100;

    private readonly heights = new Uint16Array(FIELD_SIZE * FIELD_SIZE);
    private buildRow = -1;
    private ready = false;

    constructor() {
        this.texture = new THREE.DataTexture(
            this.heights, FIELD_SIZE, FIELD_SIZE,
            THREE.RedFormat, THREE.HalfFloatType,
        );
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.generateMipmaps = false;
    }

    get isReady(): boolean {
        return this.ready;
    }

    /** Begin (re)building for a freshly loaded level. */
    start(bounds: RainFieldBounds): void {
        this.mapMin.set(bounds.minX - CAMERA_MARGIN_M, bounds.minZ - CAMERA_MARGIN_M);
        this.mapSize.set(
            Math.max(1e-3, (bounds.maxX - bounds.minX) + 2 * CAMERA_MARGIN_M),
            Math.max(1e-3, (bounds.maxZ - bounds.minZ) + 2 * CAMERA_MARGIN_M),
        );
        this.noHitFloorY = bounds.minY - 5;
        this.buildRow = 0;
        this.ready = false;
    }

    /**
     * Raycast as many rows as fit in the frame budget. Call once per frame
     * while `!isReady` (after `start`). `heightAt` is the physics query —
     * VxlSceneTerrainSystem.getHeightAt, which hits TERRAIN + ENVIRONMENT
     * colliders and falls back to the world floor where nothing is hit.
     */
    step(heightAt: (x: number, z: number) => number): void {
        if (this.ready || this.buildRow < 0) return;
        const deadline = performance.now() + STEP_BUDGET_MS;
        const stepX = this.mapSize.x / FIELD_SIZE;
        const stepZ = this.mapSize.y / FIELD_SIZE;
        while (this.buildRow < FIELD_SIZE && performance.now() < deadline) {
            const row = this.buildRow++;
            const z = this.mapMin.y + (row + 0.5) * stepZ;
            const base = row * FIELD_SIZE;
            for (let i = 0; i < FIELD_SIZE; i++) {
                const x = this.mapMin.x + (i + 0.5) * stepX;
                const h = heightAt(x, z);
                this.heights[base + i] = THREE.DataUtils.toHalfFloat(
                    Number.isFinite(h) ? h : this.noHitFloorY,
                );
            }
        }
        if (this.buildRow >= FIELD_SIZE) {
            this.texture.needsUpdate = true;
            this.ready = true;
        }
    }

    dispose(): void {
        this.texture.dispose();
    }
}
