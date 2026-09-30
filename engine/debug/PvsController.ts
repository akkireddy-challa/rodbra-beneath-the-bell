// Neutral owner of the PVS (potentially-visible-set) subsystem. Extracted from
// GaussianSplatEditor so the bake/cull lifecycle no longer belongs to the
// gaussian-splat editor — it now drives REGULAR voxel geometry (the terrain
// VoxelWorld) just as readily as a splat's voxelised collider world.
//
// Owned by GameEngine (constructed once, like CameraPathEditor/ScreenRecorder).
// All world/bounds/gameData lookups come in as provider callbacks so the
// controller stays agnostic about whether a splat is present:
//   - splat scene  → providers resolve the active splat's voxel world + its
//                    env-object id (per-instance persistence)
//   - voxel scene  → providers resolve the terrain VoxelWorld + null env-object
//                    id (scene-wide worldProfile persistence)
//
// The splat side additionally registers its SplatPvsGrid renderers via
// `setSplatRenderersAccessor`, so the same per-cell visibility set culls both
// voxel chunks and splat cells in lock-step. Nothing here imports splat code.
import type * as THREE from 'three';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { WalkableMapVisualizer } from './WalkableMapVisualizer.js';
import { VoxelPvsCuller, type SplatPvsRendererTarget, type PvsCullerStats } from './VoxelPvsCuller.js';
import { persistWalkableMapInBackground, persistPvs, loadWalkableMapFromUrl as walkableLoadFromUrl, loadPvsFromUrl as pvsLoadFromUrl } from './WalkableMapPersistence.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import type { GameData } from 'types/game.js';

type VoxelBounds = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };

export interface PvsControllerProviders {
    scene: THREE.Scene;
    camera: THREE.Camera;
    /** Active voxel world the PVS bakes/culls against — splat collider world when present, else the terrain world. */
    getActiveVoxelWorld: () => VoxelWorld | null;
    /** World-space bounds of `getActiveVoxelWorld()`. */
    getActiveVoxelWorldBounds: () => VoxelBounds | null;
    /** Current game data (for spawn lookup + persistence routing). */
    getGameData: () => GameData | null;
    /** Env-object id the bake belongs to (a placed splat); null for a scene-wide voxel level. */
    getActiveEnvObjectId: () => string | null;
}

export class PvsController {
    private readonly providers: PvsControllerProviders;
    private readonly walkableMap: WalkableMapVisualizer;
    /** Public so debug wiring (`wirePvsProvidersToDebugPanel`) can read prune/stats off the culler. */
    readonly pvsCuller: VoxelPvsCuller;

    constructor(providers: PvsControllerProviders) {
        this.providers = providers;
        this.walkableMap = new WalkableMapVisualizer(providers.scene);
        this.pvsCuller = new VoxelPvsCuller(
            providers.camera,
            () => providers.getActiveVoxelWorld(),
            () => this.walkableMap,
        );
    }

    /**
     * Register the enumerator of splat-grid renderers the culler should drive
     * each tick (the splat side installs this). Without it the culler only
     * culls voxel chunks — which is exactly the splat-less behaviour.
     */
    setSplatRenderersAccessor(getSplatRenderers: () => SplatPvsRendererTarget[]): void {
        this.pvsCuller.setSplatRenderersAccessor(getSplatRenderers);
    }

    /**
     * Build the walkable-cell map for the active voxel world. Works on the
     * terrain VoxelWorld (voxel scene) or a splat's collider world. Persists
     * in the background — per-instance when an env-object owns it, else
     * scene-wide on worldProfileData.
     */
    generateWalkableMap(options: { stepUp?: number; jumpUp?: number; fallDown?: number; playerHeight?: number; maxYAboveSpawn?: number } = {}): { cellCount: number } {
        const world = this.providers.getActiveVoxelWorld();
        if (!world || world.getChunkCount() === 0) {
            console.warn('[PVS] No voxel data — voxelize/generate terrain first');
            return { cellCount: 0 };
        }
        const bounds = this.providers.getActiveVoxelWorldBounds();
        if (!bounds) {
            console.warn('[PVS] No voxel bounds on active world');
            return { cellCount: 0 };
        }
        const gameData = this.providers.getGameData();
        const wpd = (gameData?.worldProfileData ?? null) as unknown as { spawnPoints?: Array<{ type?: string; position?: { x?: number; y?: number; z?: number } }>; playerSpawnPosition?: { x?: number; y?: number; z?: number } } | null;
        const sp = wpd?.spawnPoints?.find?.((s) => s?.type === 'player');
        const spawn = sp?.position ?? wpd?.playerSpawnPosition ?? null;
        if (!spawn || typeof spawn.x !== 'number' || typeof spawn.z !== 'number') {
            console.warn('[PVS] No player spawn position in world data');
            return { cellCount: 0 };
        }
        const result = this.walkableMap.generate(world, bounds, { x: spawn.x, y: spawn.y ?? 0, z: spawn.z }, options);
        if (result.cellCount > 0) persistWalkableMapInBackground(this.walkableMap, this.providers.getActiveEnvObjectId(), gameData);
        return result;
    }

    /** Restore a saved walkable map (per-instance or scene-wide) against the active voxel world. */
    async loadWalkableMapFromUrl(url: string): Promise<{ cellCount: number }> {
        return walkableLoadFromUrl(this.walkableMap, this.providers.getActiveVoxelWorld(), url);
    }

    clearWalkableMap(): void {
        this.walkableMap.clear();
    }

    isWalkableMapVisible(): boolean {
        return this.walkableMap.visible;
    }

    setWalkableMapVisible(v: boolean): void {
        this.walkableMap.setVisible(v);
    }

    /**
     * Compute the PVS for every walkable cell (the GPU cubemap bake), then
     * persist it. Forwards progress to the creator modal. Returns aggregate
     * stats; the per-cell map stays on the visualizer for culling.
     */
    async computeWalkableVisibility(opts: {
        renderer: THREE.WebGLRenderer;
        minEyeHeight?: number;
        maxEyeHeight?: number;
        eyeSamples?: number;
        tileSize?: number;
        faceResolution?: number;
    }): Promise<{ cellCount: number; tileCount: number; avgVisibleTiles: number; maxVisibleTiles: number; tileSize: number; minEye: number; maxEye: number; elapsedMs: number; savedUrl: string | null; savedBytes: number } | null> {
        if (!this.walkableMap.hasMesh) {
            console.warn('[PVS] computeWalkableVisibility called before the walkable map was generated');
            return null;
        }
        const result = await this.walkableMap.computeVisibility({
            ...opts,
            onProgress: (done, total) => {
                safePostMessageToCreator({ type: 'WALKABLE_VISIBILITY_PROGRESS', phase: 'compute', done, total, progress: total > 0 ? done / total : 0 });
            },
        });

        safePostMessageToCreator({ type: 'WALKABLE_VISIBILITY_PROGRESS', phase: 'save', done: 0, total: 1, progress: 0 });
        const saved = await persistPvs(this.walkableMap, this.providers.getActiveEnvObjectId(), this.providers.getGameData());
        safePostMessageToCreator({ type: 'WALKABLE_VISIBILITY_PROGRESS', phase: 'save', done: 1, total: 1, progress: 1 });

        return {
            cellCount: result.cellCount,
            tileCount: result.tileCount,
            avgVisibleTiles: result.avgVisibleTiles,
            maxVisibleTiles: result.maxVisibleTiles,
            tileSize: result.tileSize,
            minEye: result.minEye,
            maxEye: result.maxEye,
            elapsedMs: result.elapsedMs,
            savedUrl: saved.url,
            savedBytes: saved.bytes,
        };
    }

    /** Restore a saved PVS. Caller must have loaded the walkable map first. */
    async loadPvsFromUrl(url: string): Promise<{ cellCount: number; totalEntries: number } | null> {
        return pvsLoadFromUrl(this.walkableMap, url);
    }

    setPvsCullingEnabled(enabled: boolean): void {
        if (enabled) this.pvsCuller.enable(); else this.pvsCuller.disable();
    }

    setPvsLocked(locked: boolean): void {
        this.pvsCuller.setLocked(locked);
    }

    /** Untether the active bake from its persisted PVS (env-object or scene-wide). */
    async clearActivePvs(): Promise<boolean> {
        return (await import('./ClearActivePvs.js')).clearActivePvs(this.providers.getActiveEnvObjectId(), this.pvsCuller, this.walkableMap);
    }

    getPvsStats(): PvsCullerStats | null {
        return this.pvsCuller.getLastStats();
    }
}
