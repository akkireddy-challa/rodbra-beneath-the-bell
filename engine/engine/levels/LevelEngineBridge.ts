import * as THREE from 'three';
import type { FogConfig, GameData, LightingConfig, PlayerControllerLike, SpawnPoint, WeatherConfig, WorldProfileData } from 'types/game.js';
import type { DynamicObjectManager } from 'engine/DynamicObjectManager.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { LevelManager, resolveLevelVwldAsset, type LevelSwitchStage } from 'engine/levels/LevelManager.js';
import { t } from 'engine/i18n/index.js';
import { resolveLevels } from 'engine/levels/levelResolve.js';
import { VxlSceneTerrainSystem } from 'engine/VxlSceneTerrainSystem.js';
import { FadeOverlay } from 'engine/FadeOverlay.js';
import { SkyboxMaterialHelper } from 'engine/loaders/SkyboxMaterialHelper.js';
import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { fetchNavSidecar } from 'engine/levels/fetchNavSidecar.js';
import { VoxelNavMesh, setGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import { PLAYER_REST_CLEARANCE_M } from 'engine/loaders/PlayerLoader.js';
import type { WarmupProgressFn } from 'engine/GameEngineWarmup.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';
import { profileMark } from 'engine/LoadProfile.js';
import { drawTerrainUploadFrame, uploadFrameEnabled } from 'engine/levels/terrainUploadFrame.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';

/**
 * Where each switch stage puts the fade overlay's progress line. Coarse
 * authored fractions (see showSwitchProgress); translation KEYS rather than
 * strings so the label is resolved per call and follows a language change.
 */
const SWITCH_STEPS: Record<LevelSwitchStage, { fraction: number; labelKey: string }> = {
    terrain: { fraction: 0.15, labelKey: 'game.loading.world' },
    objects: { fraction: 0.45, labelKey: 'game.loading.objects' },
    navmesh: { fraction: 0.7, labelKey: 'game.loading.objects' },
    atmosphere: { fraction: 0.8, labelKey: 'game.loading.objects' },
    warmup: { fraction: 0.9, labelKey: 'game.loading.warmup' },
};

/**
 * The slice of GameEngine the multi-level runtime needs. Only PUBLIC engine
 * surface — the bridge exists so GameEngine (already at the max-lines cap)
 * carries just thin delegates while the level wiring lives here.
 */
export interface LevelEngineSurface {
    scene: THREE.Scene | null;
    physicsWorld: PhysicsWorld | null;
    getDynamicObjectManager(): DynamicObjectManager;
    getPlayerController(): PlayerControllerLike | null;
    applyFogConfig(config?: FogConfig | null): void;
    applyLightingConfig(config?: LightingConfig | null): void;
    applyWeatherConfig(config?: WeatherConfig | null): void;
    applyWaterSurface(waterLevelY: number | null): void;
    /** Re-fit the default shadow coverage/map size to the (new) terrain bounds. */
    fitShadowsToWorld(): void;
    getLightingConfig(): LightingConfig | null;
    refreshEnvironmentLights(): void;
    /**
     * GPU-warm the freshly built level while the transition fade still covers
     * it, reporting within-warmup progress (0..1) to `onProgress`.
     */
    warmUpLoadedScene(onProgress: WarmupProgressFn): Promise<void>;
    /** Per-frame pre-render hook; returns its own unregister. Used to await a real frame. */
    registerBeforeRender(callback: () => void): () => void;
    /**
     * Mark the frames around a level switch as not evidence about the device's speed —
     * a switch never leaves GameState.PLAYING, so nothing else can tell the auto-tuner.
     */
    noteQualityDisturbance(reason: string): void;
}



/**
 * Engine-side wiring for LevelManager: builds its options against the public
 * engine surface, applies per-level atmosphere (fog, lighting, water, skybox),
 * runs the fade/input transition lock, and respawns the player after a switch.
 * Created per loadGame in levels mode; legacy games never construct one.
 */
export class LevelEngineBridge {
    private readonly engine: LevelEngineSurface;
    private readonly gameData: GameData;
    private fadeOverlay: FadeOverlay | null = null;
    /** URL of the skybox currently displayed, so switches skip redundant reloads. */
    private currentSkyboxUrl: string | undefined = undefined;

    constructor(engine: LevelEngineSurface, gameData: GameData) {
        this.engine = engine;
        this.gameData = gameData;
    }

    /** Build the LevelManager wired to this engine. */
    createManager(): LevelManager {
        return new LevelManager({
            noteQualityDisturbance: (reason) => this.engine.noteQualityDisturbance(reason),
            gameData: this.gameData,
            loadTerrain: async (buffer) => {
                const terrain = this.engine.getDynamicObjectManager().getBakedTerrain();
                if (!(terrain instanceof VxlSceneTerrainSystem)) {
                    throw new Error('[LevelManager] active terrain is not a VLSC baked level — re-bake the level to the current format to enable level switching');
                }
                // Release the container the moment the decode is done with it. It is ~35 MB
                // inflated, it has no reader after `decodeVxlScene`, and it would otherwise
                // stay resident through the heaviest part of the load — the renderer build,
                // collider bake and env-object spawn that follow. Freeing it here returns
                // that memory exactly where the pressure peaks.
                //
                // This was previously forbidden, for a real reason: `LevelManager` kept an
                // LRU of these buffers, so detaching one left a ZERO-LENGTH entry that the
                // next load of the same level got back, dying in `decodeVxlScene` and
                // surfacing as an intermittent "Could not load this level". That cache is
                // gone — the browser's own disk cache serves repeat loads — so the buffer
                // now has exactly ONE owner and releasing it is safe. Re-introducing any
                // caching of these buffers means re-introducing that hazard.
                await terrain.loadVxlScene(buffer, { releaseSourceBuffer: true });
                // Colliders must be queryable before the respawn raycast
                // (mirrors WorldGenerator's boot-time step).
                this.engine.physicsWorld?.step(1 / 60);
            },
            settleTerrainUpload: async () => {
                if (!uploadFrameEnabled(activeQualityPolicy().deferred.terrainUploadFrame)) return;
                const terrain = this.engine.getDynamicObjectManager().getBakedTerrain();
                if (!(terrain instanceof VxlSceneTerrainSystem)) return;
                await drawTerrainUploadFrame(terrain, (cb) => this.engine.registerBeforeRender(cb));
            },
            reloadSceneContent: async (levelId) => {
                await getActiveEnvironmentObjectSystem()?.reloadForLevel(levelId);
                profileMark('scenery (env objects)');
                // Light-emitting props follow their instances (re-filters by level).
                this.engine.refreshEnvironmentLights();
            },
            applyAtmosphere: (profile) => this.applyAtmosphere(profile),
            setTransitionLock: (locked) => this.setTransitionLock(locked),
            respawnPlayer: (spawn) => this.respawnPlayer(spawn),
            sendLevelChange: null, // installed by MultiplayerSetup once the room connection exists
            installNavmesh: async (levelId) => {
                await this.installNavmesh(levelId);
                profileMark('navmesh install');
            },
            reportSwitchProgress: (stage) => this.showSwitchProgress(stage),
            warmUpScene: async () => {
                // Map the warmup's own 0..1 onto the overlay's authored
                // 0.9→1.0 band (showSwitchProgress put the bar at 0.9 when
                // the 'warmup' stage was reported). The warmup only emits
                // increasing fractions, so the bar stays monotonic.
                await this.engine.warmUpLoadedScene((fraction, label) =>
                    this.fadeOverlay?.setProgress(0.9 + 0.1 * fraction, label));
                profileMark('gpu warmup');
            },
        });
    }

    /**
     * Render a switch stage as a progress line on the transition fade. The
     * fractions are coarse authored steps (the heavy stages block the main
     * thread, so a byte-accurate bar couldn't repaint anyway) — the point is
     * that a long switch reads as "working on X", never as a dead black
     * screen. The warmup stage additionally reports real sub-progress across
     * its 0.9→1.0 band (see the warmUpScene option above) and turns on the
     * busy shimmer for its blocking stretches. The line is cleared when the
     * lock releases (setTransitionLock).
     */
    private showSwitchProgress(stage: LevelSwitchStage): void {
        const step = SWITCH_STEPS[stage];
        this.fadeOverlay?.setProgress(step.fraction, t(step.labelKey));
        // The warmup ends in main-thread blocks no JS can update a bar
        // through (the warm frame; WebGL compile bursts) — the busy shimmer
        // is a compositor-driven animation that keeps moving through them.
        this.fadeOverlay?.setBusy(stage === 'warmup');
    }

    /**
     * Install the level's prebuilt navmesh sidecar. Baked levels
     * (`VxlSceneTerrainSystem`) never build their own navmesh, so "legacy
     * behavior" for a level with no `navUrl` is `getGlobalNavMesh() === null`
     * — NOT whatever the previously active level happened to install.
     * Leaving a stale mesh in place would have every NPC path-query the
     * WRONG level's geometry the moment a player switches from a dungeon
     * (has `navUrl`) to a legacy/no-nav level. So both "no `navUrl`
     * authored" and "sidecar fetch failed" explicitly clear the global
     * navmesh rather than no-op. The same reasoning covers a corrupt-but-
     * fetched sidecar: `buildFromSerialized` throwing on garbage bytes is
     * caught HERE (not left to `LevelManager.loadLevel`'s outer try/catch),
     * because that outer catch only degrades the *switch* (still activates
     * the level) — it never touches the navmesh, so without a local catch a
     * dungeon-A → dungeon-B switch with B's sidecar corrupt would silently
     * keep serving A's geometry to every NPC path-query in B.
     *
     * Engine-internal (mirrors `LevelManager.installNetworkHooks`): wired
     * into `createManager()`'s options above, never called from game code.
     * Not `private` so `LevelEngineBridge.test.ts` can exercise it directly
     * against the real global-navmesh module state without needing a full
     * `LevelManager.loadLevel` (which would also require a working baked
     * terrain load).
     */
    async installNavmesh(levelId: string): Promise<void> {
        const resolved = resolveLevels(this.gameData);
        const level = resolved?.byId.get(levelId);
        if (!level) throw new Error(`[LevelEngineBridge] unknown level id "${levelId}"`);
        const asset = resolveLevelVwldAsset(this.gameData, level);
        if (!asset.navUrl) {
            setGlobalNavMesh(null); // no prebuilt navmesh authored for this level
            return;
        }
        const buffer = await fetchNavSidecar(asset.navUrl);
        if (!buffer) {
            setGlobalNavMesh(null); // fetchNavSidecar already warned; degrade to none, not the old level's
            return;
        }
        try {
            const mesh = new VoxelNavMesh();
            mesh.buildFromSerialized(buffer);
            setGlobalNavMesh(mesh);
        } catch (err) {
            console.warn(`[LevelEngineBridge] navmesh sidecar for level "${levelId}" failed to decode — clearing navmesh:`, err);
            setGlobalNavMesh(null); // degrade to none, not the old level's
        }
    }

    /**
     * Re-apply the enumerated per-level atmosphere fields from an effective
     * (global + level overrides) profile. Extend ONLY together with
     * WorldLevelOverrides in types/game.ts.
     *
     * Returns the skybox swap's promise (it never rejects — reloadSkybox
     * degrades to the fog-color background internally). LevelManager.loadLevel
     * awaits it before the level warmup so the new skybox's texture and
     * pipeline are built under the fade, not on the first gameplay frame.
     */
    applyAtmosphere(profile: WorldProfileData | undefined): Promise<void> {
        if (!profile) return Promise.resolve();
        this.engine.applyFogConfig(profile.fogConfig ?? null);
        this.engine.applyLightingConfig(profile.lightingConfig ?? null);
        this.engine.applyWeatherConfig(profile.weatherConfig ?? null);
        this.engine.applyWaterSurface(profile.waterLevelY ?? null);
        // The new level's terrain is loaded by now — its extent may differ.
        this.engine.fitShadowsToWorld();
        return this.reloadSkybox(profile.skyboxUrl);
    }

    /**
     * Boot bookkeeping: genre code (frozen templates) loads the GLOBAL skybox
     * URL; when the start level overrides it, swap to the override now.
     */
    noteBootSkybox(genreLoadedUrl: string | undefined, bootEffectiveUrl: string | undefined): void {
        this.currentSkyboxUrl = genreLoadedUrl;
        if (bootEffectiveUrl !== genreLoadedUrl) void this.reloadSkybox(bootEffectiveUrl);
    }

    /**
     * Engine-side skybox swap for level switches. The boot skybox is loaded by
     * genre code (SkyboxLoader) which frozen templates own — this re-implements
     * only the swap: dispose the mesh named 'Skybox', load the new texture,
     * re-create with the configured sky brightness. No-ops on an unchanged URL.
     */
    private async reloadSkybox(url: string | undefined): Promise<void> {
        const scene = this.engine.scene;
        if (url === this.currentSkyboxUrl || !scene) return;
        this.currentSkyboxUrl = url;
        const existing = scene.getObjectByName('Skybox'); // SkyboxLoader.SKYBOX_NAME
        SkyboxMaterialHelper.disposeSkybox(existing);
        if (!url) return; // fog-color background takes over (applyFogConfig)
        try {
            const texture = await new Promise<THREE.Texture>((resolve, reject) => {
                new THREE.TextureLoader().load(url, resolve, undefined, reject);
            });
            if (this.currentSkyboxUrl !== url || !this.engine.scene) return; // superseded mid-load
            const skyboxIntensity = this.engine.getLightingConfig()?.skyboxIntensity ?? 1.0;
            const { mesh } = SkyboxMaterialHelper.createMesh(texture, { brightness: skyboxIntensity });
            mesh.name = 'Skybox';
            this.engine.scene.add(mesh);
        } catch (err) {
            console.warn('[Levels] skybox load failed — keeping fog-color background:', err);
        }
    }

    /** Freeze input + fade to black around a level switch (awaited by LevelManager). */
    private async setTransitionLock(locked: boolean): Promise<void> {
        const pc = this.engine.getPlayerController() as (PlayerControllerLike & { setControlsEnabled?: (v: boolean) => void }) | null;
        pc?.setControlsEnabled?.(!locked);
        if (!this.fadeOverlay) this.fadeOverlay = new FadeOverlay();
        if (locked) {
            // Seed the progress line before any stage report so the black is
            // never featureless; stages then advance it (showSwitchProgress).
            this.fadeOverlay.setProgress(0.05, t('game.loading.world'));
            await this.fadeOverlay.fadeOut();
        } else {
            this.fadeOverlay.setProgress(null);
            await this.fadeOverlay.fadeIn();
        }
    }

    /** Move the local player to the new level's spawn after a switch. */
    private respawnPlayer(spawn: SpawnPoint | null): void {
        const pc = this.engine.getPlayerController();
        if (!pc?.teleportTo) return;
        if (spawn) {
            // teleportTo treats its y as the FEET/ground position (it seats the
            // capsule at y + capsuleHeight/2). Authored spawns (world-forger
            // dungeons included) store the TRUE floor Y — the same raw value
            // PlayerLoader.createPlayerPhysicsBody starts from at boot before
            // lifting to PLAYER_REST_CLEARANCE_M above the floor. Apply the same
            // lift here so a level switch seats the player at the same height as
            // a fresh boot, instead of flush with the floor until the first step
            // re-solves it.
            pc.teleportTo(spawn.position.x, spawn.position.y + PLAYER_REST_CLEARANCE_M, spawn.position.z, spawn.rotationY);
            return;
        }
        // No spawn authored for this level: land on the surface at the terrain center.
        const dom = this.engine.getDynamicObjectManager();
        const bounds = dom.getTerrainBounds();
        const terrain = dom.getBakedTerrain();
        if (bounds && terrain instanceof VxlSceneTerrainSystem) {
            const cx = (bounds.minX + bounds.maxX) / 2;
            const cz = (bounds.minZ + bounds.maxZ) / 2;
            pc.teleportTo(cx, terrain.getHeightAt(cx, cz) + 2, cz);
        }
    }
}
