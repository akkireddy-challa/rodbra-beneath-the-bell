/** @jest-environment jsdom */
/**
 * The device quality ladder.
 *
 * The two ANCHOR tests are the point of this file. Every per-subsystem policy is being
 * rewired from `isMobile` to a tier, and the only thing that makes that refactor safe is
 * proof that the top rung still reproduces today's desktop and the mobile-floored `low`
 * rung still reproduces today's phone, field for field. If one of those breaks, a device
 * that ships today just silently changed behaviour — which is exactly the failure no
 * amount of per-module testing would catch, because each module would still be internally
 * consistent.
 *
 * The rest pin the things that drift: monotonicity down the ladder (a hand-edited table is
 * easy to get subtly wrong), the device floors that protect measured findings from a
 * player's pin, and the two-key storage invariant that keeps a player's choice and a
 * machine's conclusion from overwriting each other.
 */
import {
    DEVICE_QUALITY_TIERS, DEFAULT_DEVICE_QUALITY_TIER,
    deviceQualityPolicy, clampPolicyToDevice, isDeviceQualityTier, stepTier, worseTier,
    resolveDeviceQualityTier, readQualityPreference, setQualityPreference,
    setAutoDeviceTier, readAutoDeviceTier, clearAutoDeviceTier,
    type DeviceQualityTier, type DeviceQualityPolicy,
} from 'engine/DeviceQuality.js';
import { MOBILE_MAX_PIXEL_RATIO } from 'engine/RenderPixelRatio.js';
import { MAX_DROPPED_ENV_LODS } from 'engine/EnvLodPolicy.js';

const SIG = 'testsig';

const withUrl = (search: string, fn: () => void): void => {
    window.history.replaceState({}, '', search);
    try { fn(); } finally { window.history.replaceState({}, '', '/'); }
};

const clearAll = (): void => {
    setQualityPreference('auto'); // also clears the auto record
};

describe('device quality ladder', () => {
    beforeEach(clearAll);
    afterEach(clearAll);

    // ── The anchors ────────────────────────────────────────────────────────────────

    it('ultra reproduces today\'s untiered desktop, field for field', () => {
        expect(deviceQualityPolicy('ultra')).toEqual<DeviceQualityPolicy>({
            live: {
                maxPixelRatio: 4,               // uncapped: RenderPixelRatio caps mobile only
                shadowMapMaxSize: 4096,         // SHADOW_MAP_MAX_SIZE_DESKTOP
                envRenderDistanceScale: 1.0,
                characterLodScale: 1.0,
                postFx: { ssr: true, ao: true, dof: true, bloom: true },
            },
            deferred: {
                materialQuality: 'high',        // the untiered desktop material tier
                levelDetail: 0,                 // the untiered desktop level detail
                envLodDrop: 0,                  // desktop drops none
                characterBodyLod: 0,            // NPC bodies at full detail
                warmup: 'full',                 // the untiered desktop warmup rung
                terrainBudget: 'full',          // VXL_SCENE_LOAD_BUDGET_FULL
                terrainUploadFrame: true,       // the upload frame ran off mobile
                vehiclePaint: true,             // VoxelSurfaceFinish ran off mobile
                loadConcurrency: 6,             // the untiered desktop load concurrency
                prefetchAhead: 3,               // DEFAULT_PREFETCH_AHEAD
            },
        });
    });

    it('low, floored to a phone, reproduces today\'s untiered mobile, field for field', () => {
        expect(clampPolicyToDevice(deviceQualityPolicy('low'), true)).toEqual<DeviceQualityPolicy>({
            live: {
                maxPixelRatio: MOBILE_MAX_PIXEL_RATIO,
                shadowMapMaxSize: 2048,         // SHADOW_MAP_MAX_SIZE_MOBILE
                envRenderDistanceScale: 0.7,
                characterLodScale: 0.7,
                // Only SSR is device-gated today; ao/dof/bloom have no mobile branch at
                // all, and turning them off on phones is a change that needs its own
                // evidence rather than riding along with a refactor.
                postFx: { ssr: false, ao: true, dof: true, bloom: true },
            },
            deferred: {
                materialQuality: 'medium',      // the untiered mobile material tier
                levelDetail: 1,                 // the untiered mobile level detail
                envLodDrop: MAX_DROPPED_ENV_LODS,
                characterBodyLod: 1,            // NPC bodies from the coarser level
                warmup: 'light',                // the device-verified mobile rung
                terrainBudget: 'constrained',   // VXL_SCENE_LOAD_BUDGET_CONSTRAINED
                terrainUploadFrame: false,
                vehiclePaint: false,
                loadConcurrency: 3,             // the untiered mobile load concurrency
                prefetchAhead: 1,
            },
        });
    });

    // ── Ladder integrity ───────────────────────────────────────────────────────────

    it('has a policy for every rung and no rung without a policy', () => {
        expect(DEVICE_QUALITY_TIERS).toEqual(['ultra', 'high', 'medium', 'low', 'minimal']);
        for (const tier of DEVICE_QUALITY_TIERS) {
            expect(deviceQualityPolicy(tier)).toBeDefined();
            expect(isDeviceQualityTier(tier)).toBe(true);
        }
        expect(isDeviceQualityTier('extreme')).toBe(false);
        expect(isDeviceQualityTier('')).toBe(false);
    });

    it('never gets more expensive as the ladder descends', () => {
        // Table-driven rather than spelled out per rung, because the failure this catches
        // is a hand-edit that raises one number in the middle of the table — which reads
        // as fine locally and makes a lower rung cost MORE than the one above it.
        const numeric = [
            (p: DeviceQualityPolicy): number => p.live.maxPixelRatio,
            (p: DeviceQualityPolicy): number => p.live.shadowMapMaxSize,
            (p: DeviceQualityPolicy): number => p.live.envRenderDistanceScale,
            (p: DeviceQualityPolicy): number => p.live.characterLodScale,
            (p: DeviceQualityPolicy): number => p.deferred.loadConcurrency,
            (p: DeviceQualityPolicy): number => p.deferred.prefetchAhead,
        ];
        const boolean = [
            (p: DeviceQualityPolicy): boolean => p.live.postFx.ssr,
            (p: DeviceQualityPolicy): boolean => p.live.postFx.ao,
            (p: DeviceQualityPolicy): boolean => p.live.postFx.dof,
            (p: DeviceQualityPolicy): boolean => p.live.postFx.bloom,
            (p: DeviceQualityPolicy): boolean => p.deferred.terrainUploadFrame,
            (p: DeviceQualityPolicy): boolean => p.deferred.vehiclePaint,
        ];
        for (let i = 1; i < DEVICE_QUALITY_TIERS.length; i++) {
            const better = deviceQualityPolicy(DEVICE_QUALITY_TIERS[i - 1]!);
            const worse = deviceQualityPolicy(DEVICE_QUALITY_TIERS[i]!);
            const where = `${DEVICE_QUALITY_TIERS[i - 1]!} -> ${DEVICE_QUALITY_TIERS[i]!}`;
            for (const read of numeric) expect([where, read(worse)]).toEqual([where, Math.min(read(better), read(worse))]);
            for (const read of boolean) expect([where, read(worse) && !read(better)]).toEqual([where, false]);
            // levelDetail and envLodDrop count DOWNWARD: bigger is coarser.
            expect([where, worse.deferred.levelDetail >= better.deferred.levelDetail]).toEqual([where, true]);
            expect([where, worse.deferred.envLodDrop >= better.deferred.envLodDrop]).toEqual([where, true]);
            expect([where, worse.deferred.characterBodyLod >= better.deferred.characterBodyLod]).toEqual([where, true]);
        }
    });

    it('skips level-detail tier 2, which belongs to the crash downgrade', () => {
        // The one-strike rescue lands on 2 from the mobile default of 1 (DOWNGRADE_STEPS).
        // Leaving it unreachable by the ladder keeps "the device crashed" and "the device
        // is slow" telling apart in a bug report.
        const reached = DEVICE_QUALITY_TIERS.map((t) => deviceQualityPolicy(t).deferred.levelDetail);
        expect(reached).not.toContain(2);
    });

    it('steps along the ladder and clamps at both ends', () => {
        expect(stepTier('ultra', -1)).toBe('high');
        expect(stepTier('low', -1)).toBe('minimal');
        expect(stepTier('minimal', -1)).toBe('minimal');
        expect(stepTier('ultra', 1)).toBe('ultra');
        expect(stepTier('minimal', 2)).toBe('medium');
        expect(stepTier('medium', 0)).toBe('medium');
    });

    it('picks the worse of two rungs, which is the only direction the machine may move', () => {
        expect(worseTier('ultra', 'low')).toBe('low');
        expect(worseTier('low', 'ultra')).toBe('low');
        expect(worseTier('medium', 'medium')).toBe('medium');
    });

    // ── Device floors ──────────────────────────────────────────────────────────────

    it('holds every device floor even when a player pins the top rung on a phone', () => {
        // The settings menu can offer Ultra on a phone; what it must NOT be able to do is
        // undo a finding that was paid for by watching real devices die.
        const pinned = clampPolicyToDevice(deviceQualityPolicy('ultra'), true);
        expect(pinned.live.maxPixelRatio).toBe(MOBILE_MAX_PIXEL_RATIO);
        expect(pinned.live.shadowMapMaxSize).toBe(2048);
        expect(pinned.deferred.warmup).toBe('light');
        expect(pinned.deferred.terrainBudget).toBe('constrained');
        expect(pinned.deferred.vehiclePaint).toBe(false);
        expect(pinned.deferred.terrainUploadFrame).toBe(false);
        // Everything the floors do NOT cover still improves, or the pin would be a lie.
        expect(pinned.deferred.materialQuality).toBe('high');
        expect(pinned.deferred.levelDetail).toBe(0);
        expect(pinned.deferred.envLodDrop).toBe(0);
        expect(pinned.live.postFx.ssr).toBe(true);
    });

    it('leaves desktop policies untouched', () => {
        for (const tier of DEVICE_QUALITY_TIERS) {
            expect(clampPolicyToDevice(deviceQualityPolicy(tier), false)).toEqual(deviceQualityPolicy(tier));
        }
    });

    it('never raises a rung that was already below a floor', () => {
        // `minimal` on a phone must stay minimal — a floor is a floor, not a target.
        const floored = clampPolicyToDevice(deviceQualityPolicy('minimal'), true);
        expect(floored.live.maxPixelRatio).toBe(0.75);
        expect(floored.live.shadowMapMaxSize).toBe(0);
        expect(floored.deferred.warmup).toBe('light');
    });

    // ── Resolution order ───────────────────────────────────────────────────────────

    it('prefers the URL over everything, and persists nothing', () => {
        setQualityPreference('low');
        setAutoDeviceTier('minimal', 'measure', SIG);
        withUrl('/?quality=ultra', () => {
            expect(resolveDeviceQualityTier('medium', SIG)).toEqual({ tier: 'ultra', source: 'url' });
        });
        // The override was for that load only; nothing it did outlives the flag.
        expect(readQualityPreference()).toBe('low');
        expect(readAutoDeviceTier(SIG)?.tier).toBe('minimal');
    });

    it('?quality=auto ignores both stored keys so the guess can be tested on a device', () => {
        setQualityPreference('low');
        setAutoDeviceTier('minimal', 'measure', SIG);
        withUrl('/?quality=auto', () => {
            expect(resolveDeviceQualityTier('high', SIG)).toEqual({ tier: 'high', source: 'default' });
        });
    });

    it('prefers a player pin over a machine conclusion', () => {
        setAutoDeviceTier('minimal', 'measure', SIG);
        setQualityPreference('high');
        expect(resolveDeviceQualityTier('low', SIG)).toEqual({ tier: 'high', source: 'pinned' });
    });

    it('falls back through the auto record to the guess', () => {
        expect(resolveDeviceQualityTier('low', SIG)).toEqual({ tier: 'low', source: 'default' });
        setAutoDeviceTier('minimal', 'probe', SIG);
        expect(resolveDeviceQualityTier('low', SIG)).toEqual({ tier: 'minimal', source: 'auto' });
    });

    it('falls through rather than throwing on a value it does not recognise', () => {
        // A typo in a URL being handed round for device testing must not break the load —
        // the contract every sibling policy states explicitly.
        withUrl('/?quality=potato', () => {
            expect(resolveDeviceQualityTier('high', SIG)).toEqual({ tier: 'high', source: 'default' });
        });
        localStorage.setItem('bm.quality', 'potato');
        expect(resolveDeviceQualityTier('high', SIG)).toEqual({ tier: 'high', source: 'default' });
        localStorage.setItem('bm.quality.auto', 'not json at all');
        expect(resolveDeviceQualityTier('high', SIG)).toEqual({ tier: 'high', source: 'default' });
    });

    // ── The two-key invariant ──────────────────────────────────────────────────────

    it('keeps the player\'s choice and the machine\'s conclusion from overwriting each other', () => {
        setQualityPreference('high');
        setAutoDeviceTier('minimal', 'measure', SIG);
        // The machine wrote its conclusion; the pin is untouched and still wins.
        expect(readQualityPreference()).toBe('high');
        expect(readAutoDeviceTier(SIG)?.tier).toBe('minimal');
        expect(resolveDeviceQualityTier('low', SIG).source).toBe('pinned');
    });

    it('treats picking Auto as a fresh start, not a return to the ratcheted rung', () => {
        setAutoDeviceTier('minimal', 'measure', SIG);
        setQualityPreference('high');
        setQualityPreference('auto');
        expect(readQualityPreference()).toBe('auto');
        expect(readAutoDeviceTier(SIG)).toBeNull();
        expect(resolveDeviceQualityTier('medium', SIG)).toEqual({ tier: 'medium', source: 'default' });
    });

    // ── The auto record's own guards ───────────────────────────────────────────────

    it.each(['measure', 'probe'])('reassesses legacy %s conclusions that could include loading', (reason) => {
        localStorage.setItem('bm.quality.auto', JSON.stringify({
            v: 1, tier: 'minimal', reason, at: Date.now(), sig: SIG,
        }));
        expect(readAutoDeviceTier(SIG)).toBeNull();
        expect(resolveDeviceQualityTier('ultra', SIG)).toEqual({ tier: 'ultra', source: 'default' });
        setQualityPreference('high');
        expect(resolveDeviceQualityTier('ultra', SIG)).toEqual({ tier: 'high', source: 'pinned' });
    });

    it('preserves legacy crash recovery records', () => {
        localStorage.setItem('bm.quality.auto', JSON.stringify({
            v: 1, tier: 'low', reason: 'crash', at: Date.now(), sig: SIG,
        }));
        expect(readAutoDeviceTier(SIG)?.tier).toBe('low');
    });

    it('drops a conclusion reached about a different device', () => {
        setAutoDeviceTier('minimal', 'measure', SIG);
        expect(readAutoDeviceTier('a-different-machine')).toBeNull();
        expect(resolveDeviceQualityTier('ultra', 'a-different-machine').source).toBe('default');
    });

    it('drops a conclusion older than the expiry, so a device is never stranded', () => {
        // A tier measured on a thermally-throttled bus ride should not hold forever; the
        // tuner is a ratchet and can never raise one on its own, so expiry is the way back.
        setAutoDeviceTier('minimal', 'measure', SIG);
        const stale = JSON.parse(localStorage.getItem('bm.quality.auto')!) as { at: number };
        stale.at = Date.now() - (31 * 24 * 60 * 60 * 1000);
        localStorage.setItem('bm.quality.auto', JSON.stringify(stale));
        expect(readAutoDeviceTier(SIG)).toBeNull();
    });

    it('round-trips every reason, so the note can name what lowered the tier', () => {
        for (const reason of ['probe', 'measure', 'crash'] as const) {
            setAutoDeviceTier('low', reason, SIG);
            expect(readAutoDeviceTier(SIG)?.reason).toBe(reason);
        }
        // An unknown reason is a record this build cannot interpret; dropping it is safer
        // than defaulting, which would attribute a downgrade to the wrong cause.
        localStorage.setItem('bm.quality.auto', JSON.stringify({ v: 1, tier: 'low', reason: 'vibes', at: Date.now(), sig: SIG }));
        expect(readAutoDeviceTier(SIG)).toBeNull();
    });

    it('drops a record written by a future schema rather than misreading it', () => {
        localStorage.setItem('bm.quality.auto', JSON.stringify({ v: 2, tier: 'low', reason: 'measure', at: Date.now(), sig: SIG }));
        expect(readAutoDeviceTier(SIG)).toBeNull();
    });

    it('clears only the machine conclusion, leaving a pin alone', () => {
        setQualityPreference('medium');
        setAutoDeviceTier('minimal', 'probe', SIG);
        clearAutoDeviceTier();
        expect(readAutoDeviceTier(SIG)).toBeNull();
        expect(readQualityPreference()).toBe('medium');
    });

    it('defaults non-interactive contexts to the full look', () => {
        // Tests, workers and the offscreen thumbnail renderer must see the asset, not a
        // rescue rung — the same reason DEFAULT_MATERIAL_QUALITY is 'high'.
        expect(DEFAULT_DEVICE_QUALITY_TIER).toBe<DeviceQualityTier>('ultra');
    });
});
