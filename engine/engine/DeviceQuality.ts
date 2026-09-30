/**
 * Device quality tier — the one rung the whole engine agrees on, and the thing every
 * per-subsystem policy reads instead of asking "is this a phone".
 *
 * Until this existed, `isMobileRuntime()` WAS the quality knob: every device was either
 * "phone" or "desktop", so a Chromebook rendered like a 4090 and an iPhone 16 Pro Max
 * rendered like an iPhone SE. This is the missing middle — a capability tier sitting
 * between the device and the material/LOD/resolution ladders that were already there.
 *
 * ⚠ `isMobileRuntime()` is still the RIGHT question for UI and controls, and the wrong
 * one for capability. "Is this a small touch screen" and "how fast is this device" are
 * different questions with different answers: a Steam Deck is fast and touch, a cheap
 * Chromebook is slow and mouse-driven. HUD layout, control schemes, orientation locks and
 * pointer-lock hints keep asking `isMobileRuntime()`. Do not "finish the migration".
 *
 * Modelled on the sibling policy modules it now feeds (`MaterialQuality.ts`,
 * `WarmupPolicy.ts`, `LevelDetail.ts`): one small closed ladder, a policy record saying
 * what each rung switches on, and a resolution order of `?quality=` → stored → default.
 * The scalar tier is what gets stored, URL-overridden, stepped by the auto-tuner and shown
 * in the settings menu; the policy record is what consumers read. Neither works alone — a
 * bare record cannot be stepped or persisted or listed in a menu, and a bare scalar makes
 * every consumer re-derive its own mapping, which is exactly the drift `LevelDetail.ts`'s
 * header describes ("a tier used to mean 'which file' while the load planner separately
 * applied a floor of its own, so asking for 1 rendered like 2").
 *
 * WHY FIVE RUNGS. Below today's mobile behaviour you need two: a slightly weaker phone,
 * and a rescue rung nobody should reach by default. Above it you need two: the top must
 * be bit-identical to today's desktop, which leaves nothing to express an integrated-GPU
 * laptop. The phone band itself is one rung, and `medium` — reachable both by demoting a
 * desktop and by promoting a flagship phone — is what makes this ONE ladder instead of two.
 *
 * TWO ANCHORS, and they are the regression net for everything this feeds:
 *
 *   ultra ≡ today's desktop, field for field.
 *   clampPolicyToDevice(low, isMobile = true) ≡ today's mobile, field for field.
 *
 * As long as those hold, rewiring a policy from `isMobile` to a tier cannot change what
 * any device that ships today actually gets. `DeviceQuality.test.ts` asserts both.
 */

import { materialQualityEpoch, resolveMaterialQuality, type MaterialQuality } from 'engine/MaterialQuality.js';
import type { WarmupMode } from 'engine/WarmupPolicy.js';
import { deviceSignature, guessStartingTier, readDeviceSignals } from 'engine/DeviceQualityGuess.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';

/** One rung of the ladder, best first. */
export type DeviceQualityTier = 'ultra' | 'high' | 'medium' | 'low' | 'minimal';

/** What the player asked for: a pinned rung, or `'auto'` to follow detection. */
export type QualityPreference = 'auto' | DeviceQualityTier;

/**
 * Best → worst. The ORDER is the ladder: index arithmetic is how `stepTier` moves and how
 * the settings menu lists rungs, so do not reorder without meaning to.
 */
export const DEVICE_QUALITY_TIERS: readonly DeviceQualityTier[] = ['ultra', 'high', 'medium', 'low', 'minimal'];

/**
 * What a rung switches on, split by WHEN it can be applied.
 *
 * The split is in the type on purpose. A knob's application cost is a property of the
 * knob, not of the code that happens to change it, and a flat record makes it far too easy
 * for a later field to land on the wrong side — "just set it" on something that needs a
 * level reload, or a deferred write on something the player expected to see move. With the
 * split, `applyDeviceTierLive` can iterate `live` exhaustively and report `deferred`
 * honestly, and adding a field forces the author to decide which half it belongs to.
 */
export interface DeviceQualityPolicy {
    /** Knobs that take effect the moment they are set. */
    live: {
        /**
         * Ceiling handed to `resolveRenderPixelRatio`.
         *
         * ⚠ A cap in CSS-PIXEL terms, not a fraction of the device ratio: `0.75` means
         * 0.75 device pixels per CSS pixel on every display, so on a dpr-3 phone that is
         * one SIXTEENTH of the pixels of ratio 3, not 75% of them. That is why `minimal`
         * is a rescue rung and why there is nothing between 2 and 0.75. `4` is effectively
         * uncapped — it matches `MAX_RENDER_PIXEL_RATIO` and no shipping display exceeds it.
         */
        maxPixelRatio: number;
        /** Ceiling for `resolveShadowMapSize`. 0 means no sun shadows at all. */
        shadowMapMaxSize: number;
        /** Multiplier on `EnvironmentObjectSystem.maxRenderDistance`. */
        envRenderDistanceScale: number;
        /** Multiplier on `CharacterLodScheduler` ring distances and per-frame caps. */
        characterLodScale: number;
        /**
         * Post-processing passes this rung allows. Each is still ALSO subject to the
         * per-game config and to its own correctness gates — an allowance here never turns
         * an effect on, it only declines to turn one off.
         */
        postFx: { ssr: boolean; ao: boolean; dof: boolean; bloom: boolean };
    };
    /** Knobs that land at the next construction, next level load, or next warmup. */
    deferred: {
        /**
         * Next material construction — already-built materials are not rebuilt.
         *
         * The phone band lands on 'medium', not 'low', for the reason that made it the
         * mobile default before the ladder existed: the medium tier's Phong lobe is
         * near-free per fragment and it is what keeps a stone cliff reading as stone on a
         * phone. 'low' is the rescue rung, and stays reachable via `?matq=low` and the
         * stored setting for a device where even a specular lobe is unwelcome.
         */
        materialQuality: MaterialQuality;
        /**
         * Next level load. Composed with the crash-downgrade floor by MAX, never by sum —
         * see `resolveLevelDetail`.
         *
         * A phone still starts one tier down, as it did before the ladder; what the ladder
         * adds is that a *weak* phone can start further down than that.
         */
        levelDetail: number;
        /** Finest baked env LODs never meshed at load. Next `VoxelObject` construction. */
        envLodDrop: number;
        /**
         * Voxel level a rigged `.vxl` NPC body is built from — 0 the file's full detail,
         * 1 its coarser level (about 4.5× fewer triangles: a library townsperson is
         * ~105k triangles at 0 and ~23k at 1). Next character load. NPCs only: the
         * player's own body is seen close-up every frame and stays at 0 on every tier.
         * A file without the requested level falls back to the finest it has.
         */
        characterBodyLod: number;
        /** Next warmup. */
        warmup: WarmupMode;
        /**
         * Which `VxlSceneLoadBudget` to use. A SELECTOR, not the numbers — the measured
         * byte budgets stay next to their load/crash table in `VxlSceneTerrainSystem.ts`
         * so the evidence never drifts away from the constant it justifies.
         */
        terrainBudget: 'full' | 'constrained';
        /** The CPU-geometry upload frame between terrain and scenery. */
        terrainUploadFrame: boolean;
        /** The per-chassis vehicle paint finish. */
        vehiclePaint: boolean;
        /**
         * Cap on concurrent asset loads (fetch + decode), handed straight to
         * `mapWithConcurrency`.
         *
         * Weaker rungs get a smaller cap because the binding constraint there is **memory**
         * from decoding several assets at once (iOS Safari / Android Chrome kill the tab
         * under memory pressure), NOT the per-host connection count — the CDN is HTTP/2,
         * which multiplexes many requests over one connection. Tune the ladder, not call
         * sites.
         */
        loadConcurrency: number;
        /** Downloads run ahead of the scenery build's consumer. */
        prefetchAhead: number;
    };
}

const POLICIES: Readonly<Record<DeviceQualityTier, DeviceQualityPolicy>> = {
    // ── The desktop anchor. Every value here is what an untiered desktop gets today. ──
    ultra: {
        live: {
            maxPixelRatio: 4,
            shadowMapMaxSize: 4096,
            envRenderDistanceScale: 1.0,
            characterLodScale: 1.0,
            postFx: { ssr: true, ao: true, dof: true, bloom: true },
        },
        deferred: {
            materialQuality: 'high',
            levelDetail: 0,
            envLodDrop: 0,
            characterBodyLod: 0,
            warmup: 'full',
            terrainBudget: 'full',
            terrainUploadFrame: true,
            vehiclePaint: true,
            loadConcurrency: 6,
            prefetchAhead: 3,
        },
    },
    // A capable machine that is not a gaming desktop: an integrated-GPU laptop, a 4-core
    // Retina Mac. Sheds the two most expensive desktop-only extras (wet-weather SSR and
    // the 4096 shadow map) and nothing a player would name.
    high: {
        live: {
            maxPixelRatio: 4,
            shadowMapMaxSize: 2048,
            envRenderDistanceScale: 1.0,
            characterLodScale: 1.0,
            postFx: { ssr: false, ao: true, dof: true, bloom: true },
        },
        deferred: {
            materialQuality: 'high',
            levelDetail: 0,
            envLodDrop: 0,
            characterBodyLod: 0,
            warmup: 'full',
            terrainBudget: 'full',
            terrainUploadFrame: true,
            vehiclePaint: true,
            loadConcurrency: 6,
            prefetchAhead: 3,
        },
    },
    // The overlap rung: a weak laptop demoted, or a flagship phone promoted. This is where
    // the pixel-ratio cap and the Phong material tier start, i.e. where the picture first
    // changes in a way anyone could point at.
    medium: {
        live: {
            maxPixelRatio: 2,
            shadowMapMaxSize: 2048,
            envRenderDistanceScale: 0.85,
            characterLodScale: 0.85,
            postFx: { ssr: false, ao: true, dof: true, bloom: true },
        },
        deferred: {
            materialQuality: 'medium',
            levelDetail: 1,
            envLodDrop: 1,
            characterBodyLod: 1,
            warmup: 'culled',
            terrainBudget: 'constrained',
            terrainUploadFrame: true,
            vehiclePaint: false,
            loadConcurrency: 4,
            prefetchAhead: 2,
        },
    },
    // ── The mobile anchor. Every value here is what an untiered phone gets today. ──
    low: {
        live: {
            maxPixelRatio: 2,
            shadowMapMaxSize: 2048,
            envRenderDistanceScale: 0.7,
            characterLodScale: 0.7,
            postFx: { ssr: false, ao: true, dof: true, bloom: true },
        },
        deferred: {
            materialQuality: 'medium',
            levelDetail: 1,
            envLodDrop: 2,
            characterBodyLod: 1,
            warmup: 'light',
            terrainBudget: 'constrained',
            terrainUploadFrame: false,
            vehiclePaint: false,
            loadConcurrency: 3,
            prefetchAhead: 1,
        },
    },
    // The rescue rung. Sub-1 render scale, no sun shadows, no post, everything matte.
    // Nothing reaches it from the static guess except a software rasteriser and a phone
    // that is measurably too old; otherwise it is where the auto-tuner puts a device that
    // is failing rather than merely slow. It should look poor — it exists so the game runs.
    minimal: {
        live: {
            maxPixelRatio: 0.75,
            shadowMapMaxSize: 0,
            envRenderDistanceScale: 0.5,
            characterLodScale: 0.5,
            postFx: { ssr: false, ao: false, dof: false, bloom: false },
        },
        deferred: {
            materialQuality: 'low',
            // 3, not 2: tier 2 is where the one-strike crash downgrade LANDS from the
            // mobile default of 1, and that mechanism should stay the only thing that puts
            // a device there. Skipping past it keeps the two systems legible apart.
            levelDetail: 3,
            envLodDrop: 2,
            characterBodyLod: 1,
            warmup: 'light',
            terrainBudget: 'constrained',
            terrainUploadFrame: false,
            vehiclePaint: false,
            loadConcurrency: 2,
            prefetchAhead: 1,
        },
    },
};

/**
 * The tier for non-interactive contexts — tests, workers, the offscreen thumbnail
 * renderer, and any automated browser. They see the full look, for the same reason
 * `DEFAULT_MATERIAL_QUALITY` is `high`: an asset preview must show the asset, and a
 * `bitmagic verify` screenshot can become a published game's cover art.
 */
export const DEFAULT_DEVICE_QUALITY_TIER: DeviceQualityTier = 'ultra';

/** The player's pin. Written only by the settings UI. */
const PREFERENCE_KEY = 'bm.quality';
/** What detection and measurement concluded. Written only by the probe and the tuner. */
const AUTO_KEY = 'bm.quality.auto';

/**
 * How long an auto record stands before the next boot re-derives one.
 *
 * A tier is evidence about a device, and evidence about a device goes off. A phone
 * measured mid-summer on a thermally-throttled bus ride should not be held at that rung
 * forever, and a browser update that ships a working WebGPU backend should get a chance to
 * show it. One possibly-rough session a month is a cheaper mistake than stranding a device
 * on a rung it earned once — especially since the tuner is a ratchet and can never raise
 * one on its own.
 */
const AUTO_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Why the stored auto tier is what it is, and therefore what the player is told.
 *
 *   probe    legacy load-time correction; new probes are diagnostic only.
 *   measure  the in-play tuner lowered it because frames were being missed.
 *   crash    the one-strike rescue lowered it because a load killed the tab.
 */
export type AutoTierReason = 'probe' | 'measure' | 'crash';

/** The persisted conclusion of detection + measurement. */
export interface AutoTierRecord {
    /** Schema version, so a later shape change discards rather than misreads. */
    v: 1;
    tier: DeviceQualityTier;
    reason: AutoTierReason;
    /** Epoch ms, for the expiry above. */
    at: number;
    /** Device signature; a mismatch means a different machine and drops the record. */
    sig: string;
    /** Gameplay measurement policy; older automatic measurements may include loading gaps. */
    measurementVersion?: number;
}

const AUTO_MEASUREMENT_VERSION = 2;

/** Where the active tier came from. Gates the auto-tuner AND labels the settings row. */
export type DeviceQualitySource = 'url' | 'pinned' | 'auto' | 'default';

/** What `tier` switches on, before device floors. Prefer `activeQualityPolicy()`. */
export function deviceQualityPolicy(tier: DeviceQualityTier): DeviceQualityPolicy {
    return POLICIES[tier];
}

/** Whether `value` names a rung (narrowing, so callers need no cast). */
export function isDeviceQualityTier(value: string): value is DeviceQualityTier {
    return Object.prototype.hasOwnProperty.call(POLICIES, value);
}

/**
 * Move `delta` rungs along the ladder (negative = worse), clamped at both ends.
 * `stepTier('low', -1) === 'minimal'`; `stepTier('minimal', -1) === 'minimal'`.
 */
export function stepTier(tier: DeviceQualityTier, delta: number): DeviceQualityTier {
    const i = DEVICE_QUALITY_TIERS.indexOf(tier);
    const next = Math.max(0, Math.min(DEVICE_QUALITY_TIERS.length - 1, i - delta));
    return DEVICE_QUALITY_TIERS[next]!;
}

/** The worse (lower) of two rungs. The probe and the tuner may only ever move downward. */
export function worseTier(a: DeviceQualityTier, b: DeviceQualityTier): DeviceQualityTier {
    return DEVICE_QUALITY_TIERS.indexOf(a) >= DEVICE_QUALITY_TIERS.indexOf(b) ? a : b;
}

/**
 * Apply the floors a real device measurably needs, whatever rung was asked for.
 *
 * Several of the mobile constants this ladder replaced were not preferences — they were
 * findings, each with its evidence written next to it, and several of them were paid for
 * by watching real phones die. The ladder must not be able to undo one, which matters most
 * for the case the settings menu makes possible: a player pinning "Ultra" on a phone gets
 * everything the ladder can give EXCEPT the handful of things a device measurably died on.
 *
 * Each clamp names the file that measured it, so nobody removes one after reading the
 * ladder and not the evidence.
 */
export function clampPolicyToDevice(p: DeviceQualityPolicy, isMobile: boolean): DeviceQualityPolicy {
    if (!isMobile) return p;
    return {
        live: {
            ...p.live,
            // RenderPixelRatio.ts: every render target scales with the SQUARE of this, and
            // an iPhone reports 3. This is the arithmetic that was killing iOS loads.
            maxPixelRatio: Math.min(p.live.maxPixelRatio, MOBILE_MAX_PIXEL_RATIO_FLOOR),
            // ShadowCamera.ts: a 4096² depth target frequently fails to allocate on mobile
            // GPUs even where maxTextureSize allows it — the map silently never exists.
            shadowMapMaxSize: Math.min(p.live.shadowMapMaxSize, MOBILE_SHADOW_MAP_FLOOR),
        },
        deferred: {
            ...p.deferred,
            // WarmupPolicy.ts: `light` is the rung a real iPhone was VERIFIED to survive
            // (2026-08-11). "Treat it as a floor, not a preference."
            warmup: MOBILE_WARMUP_FLOOR.has(p.deferred.warmup) ? p.deferred.warmup : 'light',
            // VxlSceneTerrainSystem.ts: the 240 MB budget has a measured load/crash table.
            terrainBudget: 'constrained',
            // VoxelSurfaceFinish.ts: 53.7 ms of a 105.6 ms kart load, per chassis.
            vehiclePaint: false,
            // terrainUploadFrame.ts: "a level that loaded at tier 1 on the previous build
            // was killed on the one carrying this."
            terrainUploadFrame: false,
        },
    };
}

/**
 * Mirrors of the floors above, kept local so this module does not import the six files it
 * clamps for — that would make every consumer of a tier pull in the terrain system.
 * `DeviceQuality.test.ts` asserts each against its owning module's exported constant.
 */
const MOBILE_MAX_PIXEL_RATIO_FLOOR = 2;
const MOBILE_SHADOW_MAP_FLOOR = 2048;
/** Warmup rungs at or below mobile's verified ceiling. */
const MOBILE_WARMUP_FLOOR: ReadonlySet<WarmupMode> = new Set<WarmupMode>(['light', 'off']);

// ---------------------------------------------------------------------------
// Storage and resolution
//
// TWO keys, one writer each. One key cannot tell "the player chose Medium" from
// "measurement decided Medium": the next measurement pass would silently overwrite a
// deliberate pin, and clearing a pin would also erase everything measurement had learned.
// Split, `setQualityPreference` and `setAutoDeviceTier` cannot interfere, and the settings
// row can honestly render "Auto (Medium)".
// ---------------------------------------------------------------------------

/**
 * `?quality=<rung>` forces a rung for this load only; `?quality=auto` ignores BOTH stored
 * keys and exercises the static guess, which is how the guess gets tested on a device.
 * Returns `'auto'`, a rung, or null when absent/unparseable.
 */
function urlOverride(): QualityPreference | null {
    try {
        const raw = new URLSearchParams(window.location.search).get('quality');
        if (raw === null) return null;
        if (raw === 'auto') return 'auto';
        if (isDeviceQualityTier(raw)) return raw;
    } catch {
        // No window/location (tests, workers) — fall through.
    }
    return null;
}

/** The player's pin, or null when they have not chosen (or chose Auto). */
function storedPreference(): DeviceQualityTier | null {
    try {
        const raw = localStorage.getItem(PREFERENCE_KEY);
        if (raw !== null && isDeviceQualityTier(raw)) return raw;
    } catch {
        // Privacy mode / no storage.
    }
    return null;
}

/**
 * The stored auto conclusion, or null when there is none, it is for a different device, it
 * has expired, or it does not parse. A bad record is DROPPED rather than throwing — this
 * is read on the boot path, and a hand-edited or half-written value must not be the thing
 * that stops a game loading.
 */
export function readAutoDeviceTier(signature: string): AutoTierRecord | null {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(AUTO_KEY);
    } catch {
        return null;
    }
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const rec = parsed as Partial<AutoTierRecord>;
        if (rec.v !== 1) return null;
        if (typeof rec.tier !== 'string' || !isDeviceQualityTier(rec.tier)) return null;
        if (rec.reason !== 'probe' && rec.reason !== 'measure' && rec.reason !== 'crash') return null;
        // Reassess conclusions made before loading was excluded. Preserve crash rescue
        // and player pins: neither is a claim based on the old frame-time measurements.
        if (rec.reason !== 'crash' && rec.measurementVersion !== AUTO_MEASUREMENT_VERSION) return null;
        if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) return null;
        // A different machine, browser or renderer backend: the conclusion was about
        // something else. Same instinct as `pagehide` telling a navigation from a kill.
        if (rec.sig !== signature) return null;
        if (Date.now() - rec.at > AUTO_RECORD_MAX_AGE_MS) return null;
        return {
            v: 1, tier: rec.tier, reason: rec.reason, at: rec.at, sig: rec.sig,
            measurementVersion: rec.measurementVersion,
        };
    } catch {
        return null;
    }
}

/**
 * Persist what detection or measurement concluded. Never touches the player's pin: a
 * player who chose a rung keeps it, and the tuner is gated on `deviceQualitySource()`
 * anyway, so this is belt and braces on the one invariant worth being sure of.
 */
export function setAutoDeviceTier(tier: DeviceQualityTier, reason: AutoTierReason, signature: string): void {
    const record: AutoTierRecord = {
        v: 1, tier, reason, at: Date.now(), sig: signature, measurementVersion: AUTO_MEASUREMENT_VERSION,
    };
    try {
        localStorage.setItem(AUTO_KEY, JSON.stringify(record));
    } catch {
        /* privacy mode — the conclusion applies to this session only */
    }
}

/** Forget what measurement concluded, so the next boot derives a fresh tier. */
export function clearAutoDeviceTier(): void {
    try {
        localStorage.removeItem(AUTO_KEY);
    } catch {
        /* nothing stored, nothing to clear */
    }
}

/** What the player has chosen, for the settings row. `'auto'` when they have not pinned. */
export function readQualityPreference(): QualityPreference {
    return storedPreference() ?? 'auto';
}

let preferenceEpoch = 0;

/** Changes only on a player choice, so an in-flight measurement cannot overwrite it. */
export function qualityPreferenceEpoch(): number {
    return preferenceEpoch;
}

/**
 * Record the player's choice.
 *
 * `'auto'` clears the auto record as well as the pin, and that is the whole point:
 * "back to Auto" has to mean a fresh start, not "back to whatever rung the tuner had
 * already ratcheted me down to". Takes full effect on the next load — see
 * `applyDeviceTierLive` for what moves immediately.
 */
export function setQualityPreference(pref: QualityPreference): void {
    preferenceEpoch++;
    if (pref === 'auto') {
        try {
            localStorage.removeItem(PREFERENCE_KEY);
        } catch {
            /* privacy mode */
        }
        clearAutoDeviceTier();
        return;
    }
    try {
        localStorage.setItem(PREFERENCE_KEY, pref);
    } catch {
        /* privacy mode — the choice applies to this session only */
    }
}

/**
 * The rung this load runs at, and where it came from.
 *
 *   ?quality=<rung>  that rung, this load only, nothing persisted, auto-tuning OFF
 *   ?quality=auto    ignore both stored keys and use `guess`
 *   pin              the player's choice
 *   auto record      what detection/measurement concluded, if still valid
 *   guess            the static starting guess
 *
 * An unrecognised value falls through rather than throwing — the same contract
 * `resolveWarmupMode` and `resolveMaterialQuality` state explicitly: a typo in a URL being
 * handed round for device testing must not be the thing that breaks the load.
 *
 * `guess` and `signature` are passed in rather than probed so this stays pure and trivially
 * testable, which is the convention every sibling policy follows.
 */
export function resolveDeviceQualityTier(
    guess: DeviceQualityTier,
    signature: string,
): { tier: DeviceQualityTier; source: DeviceQualitySource } {
    const url = urlOverride();
    if (url === 'auto') return { tier: guess, source: 'default' };
    if (url !== null) return { tier: url, source: 'url' };

    const pin = storedPreference();
    if (pin !== null) return { tier: pin, source: 'pinned' };

    const auto = readAutoDeviceTier(signature);
    if (auto !== null) return { tier: auto.tier, source: 'auto' };

    return { tier: guess, source: 'default' };
}

// ---------------------------------------------------------------------------
// Session accessors
//
// Memoised, and that is load-bearing rather than tidiness: `MaterialCache.getClassed` and
// `getSharedClassedMaterial` resolve a quality tier on EVERY material construction, so an
// unmemoised accessor would re-parse `window.location.search` and hit `localStorage` once
// per material. The memo is the reason this can sit on that path at all.
// ---------------------------------------------------------------------------

interface ActiveQuality {
    tier: DeviceQualityTier;
    source: DeviceQualitySource;
    policy: DeviceQualityPolicy;
    signature: string;
    /** The ladder's material tier after `?matq=` / the stored choice have had their say. */
    materialQuality: MaterialQuality;
    /** `materialQualityEpoch()` when the line above was computed. */
    materialEpoch: number;
}

let active: ActiveQuality | null = null;

function buildActive(tier: DeviceQualityTier, source: DeviceQualitySource, signature: string): ActiveQuality {
    const policy = clampPolicyToDevice(deviceQualityPolicy(tier), isMobileRuntime());
    return {
        tier,
        source,
        policy,
        signature,
        materialQuality: resolveMaterialQuality(policy.deferred.materialQuality),
        materialEpoch: materialQualityEpoch(),
    };
}

function resolveActive(): ActiveQuality {
    if (active !== null) return active;
    const isMobile = isMobileRuntime();
    const signals = readDeviceSignals(isMobile);
    const signature = deviceSignature(signals);
    const { tier, source } = resolveDeviceQualityTier(guessStartingTier(signals), signature);
    active = buildActive(tier, source, signature);
    return active;
}

/** The rung this session is running at. */
export function activeDeviceQualityTier(): DeviceQualityTier {
    return resolveActive().tier;
}

/** What this session's rung switches on, device floors already applied. */
export function activeQualityPolicy(): DeviceQualityPolicy {
    return resolveActive().policy;
}

/** Where the active rung came from — gates the auto-tuner and labels the settings row. */
export function deviceQualitySource(): DeviceQualitySource {
    return resolveActive().source;
}

/** This device's signature, for reading and writing the auto record. */
export function activeDeviceSignature(): string {
    return resolveActive().signature;
}

/**
 * The material tier this session builds materials at — the ladder's answer, with `?matq=`
 * and the stored choice still winning over it.
 *
 * The memo is why this exists as its own accessor rather than a `resolveMaterialQuality`
 * call at each site: `MaterialCache.getClassed` and `getSharedClassedMaterial` run per
 * MATERIAL, and the unmemoised path re-parses `window.location.search` and hits
 * `localStorage` every time.
 */
export function activeMaterialQuality(): MaterialQuality {
    const current = resolveActive();
    // A stored choice made since this was resolved has to win, or `setMaterialQuality`
    // silently does nothing — see `materialQualityEpoch`.
    if (current.materialEpoch !== materialQualityEpoch()) {
        active = buildActive(current.tier, current.source, current.signature);
        return active.materialQuality;
    }
    return current.materialQuality;
}

/**
 * Adopt a new rung for the rest of this session.
 *
 * Only updates what this module reports; applying it to a running engine is
 * `applyDeviceTierLive`'s job, and the deferred half lands at the next load. `source`
 * becomes `'auto'` or `'pinned'` to match who asked, so the tuner correctly stops touching
 * a tier the player has since pinned.
 */
export function adoptDeviceQualityTier(tier: DeviceQualityTier, source: 'auto' | 'pinned'): void {
    active = buildActive(tier, source, resolveActive().signature);
}

/**
 * Forget the memoised resolution so the next read re-derives it from storage.
 *
 * Needed after the stored keys change underneath the memo — the settings row choosing
 * "Auto" clears both keys, and the rung it then resolves to has to be recomputed rather
 * than read back as whatever the tuner had already ratcheted this device down to. Also the
 * seam a test uses between cases, for the same reason: the memo outlives a `beforeEach`.
 */
export function refreshActiveDeviceQuality(): void {
    active = null;
}
