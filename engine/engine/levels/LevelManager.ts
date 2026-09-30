import type { Asset, GameData, SpawnPoint, WorldLevel, WorldProfileData } from 'types/game.js';
import {
    isInstanceInActiveLevel,
    levelSpawnPoints,
    mergeEffectiveProfile,
    resolveLevels,
    preferredLodDrop,
    selectVwldUrlForDevice,
    type ResolvedLevels,
} from 'engine/levels/levelResolve.js';
import { fetchVwldBuffer, warmVwldCache } from 'engine/levels/fetchVwld.js';
import { profileMark } from 'engine/LoadProfile.js';
import { noteLevelLoadStarted, noteLevelLoadFinished } from 'engine/LevelDetail.js';

/**
 * Everything LevelManager touches in the engine goes through these injected
 * callbacks — GameEngine wires the real implementations once at loadGame;
 * tests inject fakes. All members required (engine options pattern).
 */
export interface LevelManagerOptions {
    gameData: GameData;
    /** Load a VLSC buffer into the live terrain system (atomic replace). Throws if unsupported. */
    loadTerrain: (buffer: ArrayBuffer) => Promise<void>;
    /**
     * Draw one un-culled terrain frame so the batches free their CPU-side geometry
     * BEFORE the scenery build allocates — the two used to be live at once at the
     * point where memory is tightest. Awaited between `loadTerrain` and
     * `reloadSceneContent`; see levels/terrainUploadFrame.ts for why an ordinary frame
     * and not the GPU warmup. Never rejects.
     */
    settleTerrainUpload: () => Promise<void>;
    /** Clear + reload level-scoped scene content (env objects, placed objects) for the level. */
    reloadSceneContent: (activeLevelId: string) => Promise<void>;
    /** Re-apply atmosphere from an effective (global + level overrides) profile.
     *  May return a promise for its async tail (the skybox texture swap) —
     *  loadLevel awaits it BEFORE warmUpScene, so the new skybox's fetch,
     *  upload and pipeline are warmed under the fade instead of landing on the
     *  first gameplay frames. */
    applyAtmosphere: (effectiveProfile: WorldProfileData) => void | Promise<void>;
    /** Freeze/unfreeze player input + show/hide the fade overlay. Awaited, so a
     *  fade-out completes before the world is torn down. */
    setTransitionLock: (locked: boolean) => void | Promise<void>;
    /**
     * Tell the quality auto-tuner that the frames around a level switch are not evidence
     * about the device. A callback rather than an engine reference so this options bag
     * stays a list of effects, and so a test can assert the call without an engine.
     */
    noteQualityDisturbance: (reason: string) => void;
    /** Teleport the local player to a spawn point (after colliders exist). */
    respawnPlayer: (spawn: SpawnPoint | null) => void;
    /**
     * GPU-warm the newly built scene (compile shader programs + upload
     * geometry) while the transition fade is still covering the screen.
     * Awaited last, so it also covers whatever the didLoad hooks added.
     * Never rejects — a warmup failure must not fail the switch.
     */
    warmUpScene: () => Promise<void>;
    /** Multiplayer broadcast hook; null until networking installs one (or single-player). */
    sendLevelChange: ((levelId: string, spawnPointId?: string) => void) | null;
    /**
     * Install the level's prebuilt navmesh sidecar (or no-op when the level
     * has none). Awaited after `reloadSceneContent`, before `applyAtmosphere`;
     * a rejection is caught and logged — nav is an enhancement, so a failure
     * degrades (keeps whatever navmesh already exists) rather than aborting
     * the switch.
     */
    installNavmesh: (levelId: string) => Promise<void>;
    /**
     * Stage boundary reached during a switch. The bridge renders these as a
     * progress line on the transition fade — without it a big level's switch
     * is a multi-second dead-black screen. Called only between the lock/unlock
     * pair ('fetch' excluded: it runs before the fade, old level still up).
     */
    reportSwitchProgress: (stage: LevelSwitchStage) => void;
    /** Fetch override for tests. Defaults to fetchVwldBuffer. */
    fetchBuffer?: (url: string) => Promise<ArrayBuffer>;
}

/** Switch stages in order, as reported to `reportSwitchProgress`. */
export type LevelSwitchStage = 'terrain' | 'objects' | 'navmesh' | 'atmosphere' | 'warmup';

export interface LoadLevelOptions {
    /** Spawn point id within the target level; default = first `type:'player'`. */
    spawnPointId?: string;
    /** Broadcast to the room (default true). False when applying a remote/late-join switch. */
    networked?: boolean;
}

/**
 * Resolve a level's `vwld` asset via the asset registry (levelId → WorldLevel
 * → Asset, matched by `level.vwldAssetId`); throws agent-readable errors.
 * Shared by `LevelManager.resolveVwldUrl` and `LevelEngineBridge.installNavmesh`
 * (and the boot nav path in `WorldGenerator`) so the lookup — and its error
 * text — has exactly one implementation.
 */
export function resolveLevelVwldAsset(gameData: GameData, level: WorldLevel): Asset {
    const assets = (gameData.assets ?? []) as Asset[];
    const asset = assets.find((a) => a.id === level.vwldAssetId);
    if (!asset) throw new Error(`[LevelManager] level "${level.name}" references missing asset "${level.vwldAssetId}"`);
    if (asset.type !== 'vwld') throw new Error(`[LevelManager] level "${level.name}" asset "${asset.id}" has type "${asset.type}", expected 'vwld'`);
    if (!asset.url) throw new Error(`[LevelManager] level "${level.name}" asset "${asset.id}" has no url`);
    return asset;
}

/**
 * Staleness guard for a deferred navmesh install (currently: the boot-time
 * fire-and-forget fetch in `WorldGenerator.loadVxlSceneWorld`). A late-join
 * multiplayer boot's sidecar fetch can resolve AFTER the room owner's level
 * switch already installed the correct mesh for whatever level is active
 * NOW — applying the boot level's mesh at that point would clobber a
 * correct, newer install with a stale one. Mirrors
 * `LevelEngineBridge.reloadSkybox`'s "superseded mid-load" check: capture
 * the deferred work's target identity before the async fetch starts, and
 * re-check it right before applying the result.
 *
 * `activeLevelId` is `getActiveLevelIdOrNull()` read AT APPLY TIME (null
 * outside levels mode — no `LevelManager` exists there, so nothing could
 * have switched out from under the boot install). `bootLevelId` is
 * `undefined` when the caller resolved its asset through a non-levels-mode
 * fallback (no level identity to compare against). Both of those cases have
 * nothing to have raced against, so they apply unconditionally; only when
 * both are known level ids does a mismatch mean "superseded — skip".
 */
export function shouldApplyBootNav(bootLevelId: string | undefined, activeLevelId: string | null): boolean {
    if (bootLevelId === undefined || activeLevelId === null) return true;
    return activeLevelId === bootLevelId;
}

/**
 * Multi-level runtime: owns the active level id and the switch sequence.
 * One active level at a time; switching re-loads the SAME terrain-system
 * instance (VxlSceneTerrainSystem.loadVxlScene is an atomic replace), then
 * reloads level-scoped content, re-applies atmosphere overrides, and
 * respawns the player. Constructed only in levels mode (worldProfileData
 * .levels non-empty); legacy games never see this class.
 */
export class LevelManager {
    private readonly opts: LevelManagerOptions;
    private readonly resolved: ResolvedLevels;
    private activeLevelId: string;
    private switching = false;
    private readonly willUnloadCbs: Array<(fromLevelId: string, toLevelId: string) => void> = [];
    private readonly didLoadCbs: Array<(levelId: string) => void> = [];
    private readonly beforeSceneContentCbs: Array<(levelId: string) => Promise<void> | void> = [];

    /** Throws when the game has no levels[] — construct only in levels mode. */
    constructor(options: LevelManagerOptions) {
        this.opts = options;
        const resolved = resolveLevels(options.gameData);
        if (!resolved) throw new Error('[LevelManager] game has no levels[] — legacy single-world mode');
        this.resolved = resolved;
        this.activeLevelId = resolved.startLevel.id;
    }

    getActiveLevelId(): string {
        return this.activeLevelId;
    }

    /** Includes fetching, scene construction and GPU warmup, even while game state is PLAYING. */
    isLoading(): boolean {
        return this.switching;
    }

    getLevels(): Array<{ id: string; name: string }> {
        return this.resolved.levels.map((l) => ({ id: l.id, name: l.name }));
    }

    getActiveLevel(): WorldLevel {
        return this.resolved.byId.get(this.activeLevelId)!;
    }

    /** Filtering predicate for content loaders (untagged = global). */
    isInActiveLevel(instance: { levelId?: string }): boolean {
        return isInstanceInActiveLevel(instance, this.activeLevelId);
    }

    onLevelWillUnload(cb: (fromLevelId: string, toLevelId: string) => void): void {
        this.willUnloadCbs.push(cb);
    }

    onLevelDidLoad(cb: (levelId: string) => void): void {
        this.didLoadCbs.push(cb);
    }

    /**
     * Register work that must run against the INCOMING level after its terrain is
     * queryable but BEFORE its scenery spawns. Callbacks are awaited in registration
     * order, and `getActiveLevelId()` already reports the incoming level when they run.
     *
     * This exists so that game code which MUTATES environment-object definitions —
     * terrain-aligning them, culling ones with no ground beneath them — can do so while
     * the spawn is still ahead of it. The same work registered on `onLevelDidLoad`
     * arrives after `reloadSceneContent` has already built every instance, mesh and
     * physics body, and can only take effect by asking for a second full rebuild: on a
     * forged circuit that measured ~16.5s of meshing and 289 bodies, built and then
     * immediately discarded. Terrain colliders are ready here because `loadTerrain`
     * ends by stepping the physics world for exactly this reason.
     *
     * A callback that throws is logged and skipped rather than failing the switch —
     * unaligned scenery is a cosmetic defect, a dead level load is not.
     */
    onBeforeSceneContent(cb: (levelId: string) => Promise<void> | void): void {
        this.beforeSceneContentCbs.push(cb);
    }

    /**
     * Engine-internal: networking installs the broadcast hook once the room
     * connection exists (MultiplayerSetup). Never called from game code.
     */
    installNetworkHooks(send: (levelId: string, spawnPointId?: string) => void): void {
        this.opts.sendLevelChange = send;
    }

    /**
     * Resolve a level's vwld URL via the asset registry; throws agent-readable errors.
     *
     * Mobile prefers a pre-baked coarser VARIANT when the level published one. That is the
     * same detail a phone ends up rendering anyway — the load planner sheds to it — but
     * fetching it directly skips downloading, inflating and decoding the levels that are
     * about to be discarded. Levels baked before variants existed have none, and fall back
     * to the full file plus the runtime shed, so both paths stay live indefinitely.
     *
     * The planner still runs either way. A variant is a better STARTING point, not a
     * guarantee it fits: a weak device or an unusually dense level can still need shedding,
     * and removing that safety net would trade one crash class for another.
     */
    private resolveVwldUrl(levelId: string): { level: WorldLevel; url: string } {
        const level = this.resolved.byId.get(levelId);
        if (!level) throw new Error(`[LevelManager] unknown level id "${levelId}"`);
        const asset = resolveLevelVwldAsset(this.opts.gameData, level);
        return { level, url: selectVwldUrlForDevice(asset, preferredLodDrop()) };
    }

    /**
     * Fetch a level container. Deliberately keeps NOTHING.
     *
     * This used to hold an LRU of the fetched buffers, which cost ~35 MB EACH — the
     * container is stored and transferred compressed (~4 MB) but cached here inflated, so
     * three entries was over 100 MB resident with no byte ceiling, larger than the entire
     * render budget the load planner works to. On a phone that was the difference between
     * a level loading and the tab being killed, and it was invisible to every terrain
     * budget because none of them could see it.
     *
     * What the cache bought — skipping a re-download — the browser already provides: these
     * responses carry `max-age` one year, so a repeat load is a disk read. Holding the
     * inflated form to avoid re-reading the compressed one was the wrong trade by roughly
     * an order of magnitude. `prefetchLevel` warms that disk cache instead.
     */
    private async fetchLevelBuffer(url: string): Promise<ArrayBuffer> {
        const fetcher = this.opts.fetchBuffer ?? fetchVwldBuffer;
        return fetcher(url);
    }

    /** Warm the buffer cache for an upcoming switch (round rotation). */
    async prefetchLevel(levelId: string): Promise<void> {
        const { url } = this.resolveVwldUrl(levelId);
        // Warms the browser's disk cache and retains nothing — see `fetchLevelBuffer`.
        // The overlap this buys (downloading while the player picks a car) is the whole
        // point of prefetching; holding the inflated container was never part of it.
        await warmVwldCache(url);
    }

    /**
     * Switch to a level. Re-loading the active level is allowed (arena reset).
     * The buffer is fetched BEFORE any teardown, so a failure up to that point
     * leaves the old level fully playable and emits nothing.
     */
    async loadLevel(levelId: string, options: LoadLevelOptions = {}): Promise<void> {
        if (this.switching) throw new Error('[LevelManager] a level switch is already in flight');
        const { level, url } = this.resolveVwldUrl(levelId);
        profileMark(`level load START: ${levelId}`);
        // Opens the one-strike window. It must OPEN here and close only after the warmup,
        // because the whole span is what iOS kills — and a killed process runs no catch,
        // no finally and no event, so the marker surviving in storage IS the signal.
        noteLevelLoadStarted();
        this.switching = true;
        const fromId = this.activeLevelId;
        let locked = false;
        try {
            // Fetch first — a network failure aborts before the world is touched.
            const buffer = await this.fetchLevelBuffer(url);
            for (const cb of this.willUnloadCbs) cb(fromId, levelId);
            await this.opts.setTransitionLock(true);
            locked = true;
            if ((options.networked ?? true) && this.opts.sendLevelChange) {
                this.opts.sendLevelChange(levelId, options.spawnPointId);
            }
            this.opts.reportSwitchProgress('terrain');
            // Elapsed, not the delta since the last mark — every other column here is a gap
            // between marks, so a row calling itself a TOTAL while showing the tail after
            // the collider bake read as terrain costing 323ms when it cost 2.3s.
            const terrainStartedAt = performance.now();
            await this.opts.loadTerrain(buffer);
            profileMark('terrain finalize', `${Math.round(performance.now() - terrainStartedAt)}ms terrain total`);
            this.activeLevelId = levelId;
            // Hand the terrain's CPU-side geometry back before the scenery asks for its
            // own. A failure here only means the copies stay resident a while longer,
            // which is what happened before this step existed — never a failed switch.
            try {
                await this.opts.settleTerrainUpload();
                profileMark('terrain upload frame');
            } catch (err) {
                console.warn('[LevelManager] terrain upload frame failed — continuing:', err);
            }
            // Reported BEFORE the hooks, not after: aligning and culling env-object
            // definitions is part of getting this level's objects in place, and it can
            // take a while — leaving the bar on 'terrain' through it would under-report
            // where the load actually is.
            this.opts.reportSwitchProgress('objects');
            // Definition-mutating work (alignment, ungrounded culling) gets its turn
            // while the spawn is still ahead of it — see `onBeforeSceneContent`.
            for (const cb of this.beforeSceneContentCbs) {
                try {
                    await cb(levelId);
                } catch (err) {
                    console.warn(`[LevelManager] beforeSceneContent hook failed for level "${levelId}" — continuing:`, err);
                }
            }
            profileMark('scenery START');
            await this.opts.reloadSceneContent(levelId);
            try {
                this.opts.reportSwitchProgress('navmesh');
                await this.opts.installNavmesh(levelId);
            } catch (err) {
                console.warn(`[LevelManager] navmesh install failed for level "${levelId}" — continuing without it:`, err);
            }
            this.opts.reportSwitchProgress('atmosphere');
            await this.opts.applyAtmosphere(
                mergeEffectiveProfile(this.opts.gameData.worldProfileData ?? {}, level),
            );
            profileMark('atmosphere (skybox+lighting)');
            const pts = levelSpawnPoints(this.opts.gameData.worldProfileData, level);
            const spawn = (options.spawnPointId
                ? pts.find((p) => p.id === options.spawnPointId)
                : undefined) ?? pts.find((p) => p.type === 'player') ?? null;
            this.opts.respawnPlayer(spawn);
            profileMark('respawn');
            // Split out because these two used to hide inside the warmup row: everything
            // between the navmesh and the warmup was attributed to the warmup, so a 5.3s
            // player-vehicle GLB download read as "gpu warmup 5569ms". A row has to name
            // the work it measures or it sends the reader at the wrong thing.
            for (const cb of this.didLoadCbs) cb(levelId);
            profileMark('didLoad callbacks (player vehicle, HUD)');
            // Last thing under the fade: link this level's shader programs now
            // rather than on the gameplay frames that first draw them. Only a
            // player's first-ever visit pays that cost (the browser's on-disk
            // program cache absorbs it on every later load), so it never shows
            // up in testing — see GameEngine.warmUpLoadedScene.
            this.opts.reportSwitchProgress('warmup');
            await this.opts.warmUpScene();
            // Reached only on a clean run to the end: the device survived this tier.
            // Deliberately NOT in the finally — a load that threw is one we do not want to
            // repeat at the same detail either, and leaving the marker set lets the next
            // boot drop a tier exactly as a kill would.
            noteLevelLoadFinished();
        } finally {
            if (locked) void this.opts.setTransitionLock(false);
            this.switching = false;
            // A level switch stays in GameState.PLAYING (the fade is DOM-only), so the
            // quality sampler would otherwise judge the device on frames spent fetching,
            // meshing and warming a level. Explicit, because there is no state change to
            // infer it from.
            this.opts.noteQualityDisturbance('level load');
        }
    }
}

// The engine-wide accessor (setActiveLevelManager / getActiveLevelManager /
// getActiveLevelIdOrNull) lives in engine/levels/levelManagerRegistry.ts —
// a type-only-import module so dependency-trivial files can read it.
