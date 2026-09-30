/** @jest-environment jsdom */
/**
 * The contract between the ladder and the policies it feeds.
 *
 * Each policy module now takes the ladder's answer as a plain `fallback` and keeps its own
 * `?param=` and storage handling. That is what keeps them leaf modules with no import cycle
 * — but it also means nothing inside any single module can notice if the ladder and a
 * consumer stop agreeing. This file is where that is noticed: for every rung, every
 * consumer must return exactly what the ladder said, with no override in play.
 *
 * The other half of the contract is direction. Several of these knobs count DOWNWARD
 * (level detail, LOD drop), so "the lower rung is cheaper" is not something a reader can
 * check by eye across six modules with six different conventions. It is asserted here once.
 */
import {
    DEVICE_QUALITY_TIERS, deviceQualityPolicy, clampPolicyToDevice,
} from 'engine/DeviceQuality.js';
import { resolveMaterialQuality } from 'engine/MaterialQuality.js';
import { resolveLevelDetail, clearLevelDetail } from 'engine/LevelDetail.js';
import { resolveWarmupMode } from 'engine/WarmupPolicy.js';
import { resolveRenderPixelRatio } from 'engine/RenderPixelRatio.js';
import { resolveShadowMapSize } from 'engine/ShadowCamera.js';
import { prefetchAheadFor } from 'engine/AssetBufferPrefetch.js';
import { uploadFrameEnabled } from 'engine/levels/terrainUploadFrame.js';
import { scaleCharacterLod, DEFAULT_CHARACTER_LOD } from 'engine/character/CharacterLodScheduler.js';

describe('every consumer agrees with the ladder', () => {
    beforeEach(() => {
        clearLevelDetail();
        window.history.replaceState(null, '', '/');
        localStorage.removeItem('bm.materialQuality');
    });

    it.each([...DEVICE_QUALITY_TIERS])('%s', (tier) => {
        const p = deviceQualityPolicy(tier);
        expect(resolveMaterialQuality(p.deferred.materialQuality)).toBe(p.deferred.materialQuality);
        expect(resolveLevelDetail(p.deferred.levelDetail)).toBe(p.deferred.levelDetail);
        expect(resolveWarmupMode(p.deferred.warmup)).toBe(p.deferred.warmup);
        expect(prefetchAheadFor(p.deferred.prefetchAhead)).toBe(p.deferred.prefetchAhead);
        expect(uploadFrameEnabled(p.deferred.terrainUploadFrame)).toBe(p.deferred.terrainUploadFrame);
        // A dpr-3 phone panel, so the cap is what shows: only a rung that caps below 3
        // changes the answer, which is exactly what `maxPixelRatio` means.
        expect(resolveRenderPixelRatio(3, p.live.maxPixelRatio)).toBe(Math.min(3, p.live.maxPixelRatio));
        // 200 m is DEFAULT_SHADOW_DISTANCE, which at 10 texels/m wants 4096 — so every rung
        // below the top is pinned by its cap, and the rescue rung returns 0 (shadows off).
        expect(resolveShadowMapSize(200, p.live.shadowMapMaxSize)).toBe(p.live.shadowMapMaxSize);
    });

    it('lets a URL override beat the ladder on every knob', () => {
        // The tier replaces only the BOTTOM of each resolution chain. A device-testing URL
        // still wins, which is what keeps `?matq=low&lod=3&warmup=off` working.
        const p = deviceQualityPolicy('ultra');
        window.history.replaceState(null, '', '/?matq=low&lod=3&warmup=off&prefetch=1&uploadframe=0&dpr=1');
        expect(resolveMaterialQuality(p.deferred.materialQuality)).toBe('low');
        expect(resolveLevelDetail(p.deferred.levelDetail)).toBe(3);
        expect(resolveWarmupMode(p.deferred.warmup)).toBe('off');
        expect(prefetchAheadFor(p.deferred.prefetchAhead)).toBe(1);
        expect(uploadFrameEnabled(p.deferred.terrainUploadFrame)).toBe(false);
        expect(resolveRenderPixelRatio(3, p.live.maxPixelRatio)).toBe(1);
    });

    it('scales character LOD down the ladder and never to zero work', () => {
        // This module had no device branch at all before the tier, so the top rungs must be
        // byte-identical to what shipped and the lower ones must still schedule SOME work —
        // a cap rounded to 0 would stop that work happening rather than happen less often.
        for (const tier of DEVICE_QUALITY_TIERS) {
            const scale = deviceQualityPolicy(tier).live.characterLodScale;
            const cfg = scaleCharacterLod(DEFAULT_CHARACTER_LOD, scale);
            if (scale >= 1) {
                expect(cfg).toBe(DEFAULT_CHARACTER_LOD);
                continue;
            }
            expect(cfg.r0DistanceM).toBeLessThan(DEFAULT_CHARACTER_LOD.r0DistanceM);
            expect(cfg.r1DistanceM).toBeLessThan(DEFAULT_CHARACTER_LOD.r1DistanceM);
            expect(cfg.nearEvalDistanceM).toBeLessThan(DEFAULT_CHARACTER_LOD.nearEvalDistanceM);
            for (const n of Object.values(cfg.caps)) expect(n).toBeGreaterThanOrEqual(1);
            // A ring's tick rate is what that ring MEANS. Scaling it would make "r1" a
            // different thing per device and make a bug report unreadable.
            expect(cfg.rates).toEqual(DEFAULT_CHARACTER_LOD.rates);
            expect(cfg.hysteresisFraction).toBe(DEFAULT_CHARACTER_LOD.hysteresisFraction);
            expect(cfg.shadowMaxRing).toBe(DEFAULT_CHARACTER_LOD.shadowMaxRing);
            expect(cfg.boundingRadiusM).toBe(DEFAULT_CHARACTER_LOD.boundingRadiusM);
        }
    });

    it('holds every device floor through the consumers, not just in the policy record', () => {
        // The floors exist because a player can pin the top rung on a phone. Asserting them
        // on the record alone would not catch a consumer that read the UNclamped policy.
        const floored = clampPolicyToDevice(deviceQualityPolicy('ultra'), true);
        expect(resolveRenderPixelRatio(3, floored.live.maxPixelRatio)).toBe(2);
        expect(resolveShadowMapSize(200, floored.live.shadowMapMaxSize)).toBe(2048);
        expect(resolveWarmupMode(floored.deferred.warmup)).toBe('light');
        expect(uploadFrameEnabled(floored.deferred.terrainUploadFrame)).toBe(false);
        expect(floored.deferred.terrainBudget).toBe('constrained');
        expect(floored.deferred.vehiclePaint).toBe(false);
    });
});
