import { getLaunchParams, TRACK_PARAM } from 'engine/LaunchParams.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';
import type { Asset } from 'types/game.js';
import type { GameData, SpawnPoint, WorldLevel, WorldProfileData } from 'types/game.js';
import { levelDetailPlan, resolveLevelDetail } from 'engine/LevelDetail.js';

export interface ResolvedLevels {
    levels: WorldLevel[];
    byId: Map<string, WorldLevel>;
    startLevel: WorldLevel;
}

/**
 * The level a deep link asked for, or null.
 *
 * ⚠ Read HERE rather than by the caller, because two callers resolve the boot
 * level independently — `GameEngine.loadGame` for the effective profile and
 * `WorldGenerator.resolveBootNavAsset` for the boot navmesh — and a link that
 * moved one but not the other would boot a level wearing another level's
 * collision.
 */
function requestedTrackId(): string | null {
    return getLaunchParams().trackLevelId;
}

/**
 * Resolve the multi-level registry from gameData. Null = legacy single-world
 * mode (no `levels[]` or empty) — every consumer must treat null as "no level
 * filtering, exactly the pre-levels behavior".
 */
export function resolveLevels(gameData: GameData | null | undefined): ResolvedLevels | null {
    const levels = gameData?.worldProfileData?.levels;
    if (!levels || levels.length === 0) return null;
    const byId = new Map(levels.map((l) => [l.id, l]));
    const startId = gameData?.worldProfileData?.startLevelId;

    // A deep link outranks the authored start level — that is the whole point
    // of following one. An id that names no level here is an OLD link, to a
    // track since renamed or removed, so it falls through to the normal start
    // rather than failing the load.
    const trackId = requestedTrackId();
    const requested = trackId ? byId.get(trackId) : undefined;
    if (trackId && !requested) {
        console.warn(`[Levels] ?${TRACK_PARAM}=${trackId} names no level in this game — starting where the game says`);
    }

    let startLevel = requested ?? (startId ? byId.get(startId) : undefined);
    if (!startLevel) {
        if (startId) console.warn(`[Levels] startLevelId "${startId}" not in levels[] — using levels[0]`);
        startLevel = levels[0]!;
    }
    return { levels: [...levels], byId, startLevel };
}

/**
 * Per-load options for `GameEngine.loadGame`. Optional param on a
 * long-shipped method — every existing caller keeps its exact behavior.
 * Lives beside `applyBootLevelOverride`, which implements its one field
 * (GameEngine re-exports the type).
 */
export interface LoadGameOptions {
    /**
     * Boot into this level instead of the configured start level (the main
     * screen's level chooser). Only meaningful in levels mode; invalid ids
     * fall back to the normal boot. See applyBootLevelOverride.
     */
    bootLevelId?: string;
}

/**
 * Boot the game into `levelId` instead of the configured start level (the
 * main screen's level chooser passes the player's pick through
 * `GameEngine.loadGame({ bootLevelId })`).
 *
 * Returns a SHALLOW COPY of gameData whose worldProfileData carries the pick
 * as if it had been authored: `startLevelId` plus the legacy mirror fields
 * (`voxelUrl`, `spawnPoints`, `playerSpawnPosition`) are remapped to the
 * chosen level, because frozen genre/work template code boots from those
 * mirrors, not from the level registry. The ORIGINAL gameData is never
 * mutated (load-once rule) — creator flows keep holding the authored data.
 *
 * Lenient by design: unknown level id, missing/invalid vwld asset, or a game
 * without levels[] returns the original gameData unchanged (with a warning) —
 * a bad pick must degrade to the normal boot, never break it.
 */
export function applyBootLevelOverride(gameData: GameData, levelId: string): GameData {
    const resolved = resolveLevels(gameData);
    if (!resolved) {
        console.warn(`[Levels] boot level override "${levelId}" ignored — game has no levels[]`);
        return gameData;
    }
    // No-op only when the AUTHORED mirrors already describe this level. Not
    // `resolved.startLevel` — that honours a `?track=` deep link, and a track
    // boot is precisely a case where the mirrors still point at the authored
    // start level and need the remap below (GameTemplate routes valid track
    // ids through this override).
    const startId = gameData.worldProfileData?.startLevelId;
    const authoredStart = (startId ? resolved.byId.get(startId) : undefined) ?? resolved.levels[0]!;
    if (authoredStart.id === levelId) return gameData;
    const level = resolved.byId.get(levelId);
    if (!level) {
        console.warn(`[Levels] boot level override "${levelId}" not in levels[] — using the configured start level`);
        return gameData;
    }
    // Typed as Asset (not a structural subset) so the device-variant lookup below can read
    // `lodVariants` — narrowing it to id/type/url is what would silently drop the variants.
    const assets = (gameData.assets ?? []) as Asset[];
    const asset = assets.find((a) => a.id === level.vwldAssetId);
    if (!asset?.url || asset.type !== 'vwld') {
        console.warn(`[Levels] boot level override "${levelId}" has no loadable vwld asset — using the configured start level`);
        return gameData;
    }

    const profile = gameData.worldProfileData ?? {};
    const spawnPoints = levelSpawnPoints(profile, level);
    const playerSpawn = spawnPoints.find((p) => p.type === 'player');
    return {
        ...gameData,
        worldProfileData: {
            ...profile,
            startLevelId: levelId,
            // The DEVICE's url, not the authored one: the boot path fetches this string
            // directly, so writing the full container here bypasses the pre-baked LOD
            // variants entirely — and pre-play level selection makes this the primary way
            // a phone loads a level, not an edge case. Measured on the heaviest circuit,
            // the difference is 39.6 MB inflated against 22.8 MB.
            voxelUrl: selectVwldUrlForDevice(asset, preferredLodDrop()),
            spawnPoints,
            ...(playerSpawn ? { playerSpawnPosition: { ...playerSpawn.position } } : {}),
        },
    };
}

/**
 * Instance filtering rule: untagged = global (loads in every level); tagged
 * must match the active level; legacy mode (null active level) loads all.
 */
export function isInstanceInActiveLevel(
    instance: { levelId?: string },
    activeLevelId: string | null,
): boolean {
    if (activeLevelId === null) return true;
    return instance.levelId === undefined || instance.levelId === activeLevelId;
}

/**
 * The active level's spawn points, falling back to the global set when the
 * level defines none (so respawn logic always finds something).
 */
export function levelSpawnPoints(
    profile: WorldProfileData | undefined,
    level: WorldLevel | null,
): SpawnPoint[] {
    const levelPts = level?.spawnPoints;
    if (levelPts && levelPts.length > 0) return [...levelPts];
    return [...(profile?.spawnPoints ?? [])];
}

/**
 * Shallow-merge the level's enumerated overrides over the global profile.
 * Returns a copy; NEVER mutates gameData (load-once rule). Extend only
 * together with WorldLevelOverrides and GameEngine.applyLevelAtmosphere().
 */
export function mergeEffectiveProfile(
    profile: WorldProfileData,
    level: WorldLevel | null,
): WorldProfileData {
    const o = level?.overrides;
    const merged: WorldProfileData = {
        ...profile,
        ...(o?.skyboxUrl !== undefined ? { skyboxUrl: o.skyboxUrl } : {}),
        ...(o?.fogConfig !== undefined ? { fogConfig: o.fogConfig } : {}),
        ...(o?.lightingConfig !== undefined ? { lightingConfig: o.lightingConfig } : {}),
        ...(typeof o?.waterLevelY === 'number' ? { waterLevelY: o.waterLevelY } : {}),
        ...(o?.weatherConfig !== undefined ? { weatherConfig: o.weatherConfig } : {}),
    };
    // A level that says `null` has NO water, whatever the world's default: the
    // key goes, so applyWaterSurface sees nothing rather than the inherited
    // plane (a ship in space once showed an earlier level's flood outside
    // its viewports).
    if (o?.waterLevelY === null) delete merged.waterLevelY;
    return merged;
}

/**
 * How many finest LOD levels this device would rather not download.
 *
 * The number comes from the device quality tier. This used to warn against exactly that —
 * "a table would be a guess that goes stale with every new handset", because there is no
 * reliable way to ask an iPhone how much memory it has (`navigator.deviceMemory` is
 * Chrome-only). That warning still holds against the table it was written about, and
 * `DeviceQualityGuess.ts` respects it: the static half contains only LOWER bounds, so new
 * hardware can only ever fail to match and land on the neutral default, and it picks a
 * STARTING rung that measurement then corrects and persists. A wrong guess costs one load
 * rather than a permanent classification, which is the part that was not available when
 * this comment was first written.
 */
export function preferredLodDrop(): number {
    // Which FILE to fetch — the tier's variant half. The tier's remaining half (extra
    // shedding past the coarsest variant) is applied by the load planner, not here.
    return levelDetailPlan(resolveLevelDetail(activeQualityPolicy().deferred.levelDetail)).fileDrop;
}

/**
 * The URL to fetch for `asset` given a preferred LOD drop.
 *
 * Picks the largest published variant that does not exceed `drop`, so asking for 2 on a
 * level that only published 1 still gets the coarser file rather than falling all the way
 * back to full detail. `drop` 0, no variants, or no match → the full container.
 */
export function selectVwldUrlForDevice(asset: Asset, drop: number): string {
    if (drop <= 0 || !asset.lodVariants || asset.lodVariants.length === 0) return asset.url;
    let best: { drop: number; url: string } | null = null;
    for (const variant of asset.lodVariants) {
        if (variant.drop <= 0 || variant.drop > drop) continue;
        if (!best || variant.drop > best.drop) best = variant;
    }
    return best?.url ?? asset.url;
}
