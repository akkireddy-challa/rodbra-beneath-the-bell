/**
 * Push a quality tier onto a running engine, and report honestly what could not be pushed.
 *
 * `DeviceQualityPolicy` splits its knobs into `live` and `deferred` precisely so this
 * function can exist: it applies every `live` field and returns the `deferred` ones that
 * are now stored but not yet visible, so the settings UI can say "applies at the next
 * level" instead of implying the whole change landed.
 *
 * WHY NOTHING IS REBUILT. Realising the deferred half immediately would mean flushing
 * `MaterialCache` and re-meshing the level — disposing materials that live meshes still
 * reference, and triggering a wave of shader compiles at the exact moment a struggling
 * device can least afford one. `MaterialCache` keys by quality specifically so a
 * mid-session change cannot alias tiers, which makes a MIXED scene the correct outcome:
 * what is already built keeps its old tier, what is built next gets the new one. That is
 * the documented `MaterialQuality` contract, and it is the same call `setLevelDetail`
 * already makes ("re-loading the level underneath a player mid-race is worse than the
 * detail they asked to change").
 *
 * POST-FX IS DELIBERATELY NOT LIVE either, despite sitting in `live`. Rebuilding the
 * composer tears down and recreates the whole node pipeline — a multi-hundred-millisecond
 * synchronous compile stall. Doing that as a rescue would make the rescue the worst hitch
 * of the session, on the device least able to absorb it. It is left to the next natural
 * boundary, where a stall is already expected and invisible.
 */

import type { GameEngine } from 'engine/GameEngine.js';
import {
    activeQualityPolicy, adoptDeviceQualityTier,
    type DeviceQualityPolicy, type DeviceQualityTier,
} from 'engine/DeviceQuality.js';
import { resolveRenderPixelRatio } from 'engine/RenderPixelRatio.js';
import { resolveShadowMapSize } from 'engine/ShadowCamera.js';
import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import {
    getGlobalLodScheduler, scaleCharacterLod, DEFAULT_CHARACTER_LOD,
} from 'engine/character/CharacterLodScheduler.js';

/**
 * A knob the new tier stored but the player cannot see yet. `shadows` is WebGPU only: an
 * allocated shadow map keeps its size, and a parked sun shadow stays off, until the next
 * engine (see ShadowCamera's resolveLiveShadowMapSize and GameEngine.sunShadowParked).
 */
export type PendingQualityChange =
    | 'materials'
    | 'levelDetail'
    | 'sceneryDetail'
    | 'characterDetail'
    | 'effects'
    | 'shadows';

/**
 * Adopt `tier` and apply everything that can change without a reload.
 *
 * Returns the deferred knobs that actually differ from what is currently in effect — an
 * empty array means the change is fully visible right now, which is worth being able to
 * say rather than always warning about a restart.
 */
export function applyDeviceTierLive(
    engine: GameEngine,
    tier: DeviceQualityTier,
    source: 'auto' | 'pinned',
): PendingQualityChange[] {
    const before = activeQualityPolicy();
    adoptDeviceQualityTier(tier, source);
    const after = activeQualityPolicy();

    applyPixelRatio(engine, after.live.maxPixelRatio);
    // Deliberately NOT `fitShadowsToWorld()`: that early-returns unless the coverage
    // distance or the authored size override changed, and a tier change moves neither — so
    // routing through it would silently swallow the new map-size cap.
    // `configureDirectionalShadow` handles the live resize itself: under WebGL it disposes the
    // stale-sized target, the only way that backend re-creates one; under WebGPU it keeps an
    // allocated map's size, reported below as pending.
    engine.applyShadowConfiguration();
    getActiveEnvironmentObjectSystem()?.reapplyQualityScale();
    getGlobalLodScheduler().setConfig(
        scaleCharacterLod(DEFAULT_CHARACTER_LOD, after.live.characterLodScale),
    );

    const pending = pendingChanges(before, after);
    if (shadowResizeDeferred(engine, after.live.shadowMapMaxSize)) pending.push('shadows');
    return pending;
}

/** True when the new tier's map-size `cap` wants a shadow map the engine kept at another size. */
function shadowResizeDeferred(engine: GameEngine, cap: number): boolean {
    const config = engine.getShadowConfig();
    const wanted = resolveShadowMapSize(config.shadowDistance, cap, config.mapSizeOverride);
    return wanted > 0 && config.mapSize !== wanted;
}

/** What differs between two policies that only a reload (or new content) will show. */
function pendingChanges(
    before: DeviceQualityPolicy,
    after: DeviceQualityPolicy,
): PendingQualityChange[] {
    const pending: PendingQualityChange[] = [];
    if (before.deferred.materialQuality !== after.deferred.materialQuality) pending.push('materials');
    if (before.deferred.levelDetail !== after.deferred.levelDetail) pending.push('levelDetail');
    if (before.deferred.envLodDrop !== after.deferred.envLodDrop) pending.push('sceneryDetail');
    if (before.deferred.characterBodyLod !== after.deferred.characterBodyLod) pending.push('characterDetail');
    // Post-FX lives in `live` because it CAN be applied live; it is deferred here only
    // because doing so costs a compile stall. Reported so the UI does not claim otherwise.
    const fxBefore = before.live.postFx;
    const fxAfter = after.live.postFx;
    if (fxBefore.ssr !== fxAfter.ssr || fxBefore.ao !== fxAfter.ao
        || fxBefore.dof !== fxAfter.dof || fxBefore.bloom !== fxAfter.bloom) {
        pending.push('effects');
    }
    return pending;
}

/**
 * The one lever that converts reliably and instantly into frame time.
 *
 * The resize is not optional: `setPixelRatio` alone records the ratio, and it is
 * `onWindowResize` that re-allocates the drawing buffer and re-sizes the composer's targets
 * to match. Without it the renderer would draw at the old resolution and nothing would
 * change except a number.
 */
function applyPixelRatio(engine: GameEngine, maxPixelRatio: number): void {
    const renderer = engine['renderer'];
    if (!renderer) return;
    const next = resolveRenderPixelRatio(window.devicePixelRatio, maxPixelRatio);
    if (renderer.getPixelRatio() === next) return;
    renderer.setPixelRatio(next);
    engine.onWindowResize();
}
