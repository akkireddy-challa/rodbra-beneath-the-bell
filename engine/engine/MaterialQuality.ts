/**
 * Material quality tier — how expensively voxel material classes are allowed to shade,
 * from 'high' (full Physical/IBL + the CPU shading-normal pass) down to 'low' (everything
 * matte Lambert, exactly the pre-material-class rendering).
 *
 * Modelled on the other per-subsystem policy modules (`LevelDetail.ts`, `WarmupPolicy.ts`):
 * one small closed ladder, a policy record saying what each rung switches on, and a
 * resolution order of `?matq=` URL override → stored choice → the device quality tier's
 * answer. That last one is passed in as a plain fallback rather than looked up here, so
 * this module imports nothing, stays free of platform detection, and is trivially
 * testable — the convention every sibling policy follows. `DeviceQuality.ts` owns the
 * tier→tier mapping and `activeMaterialQuality()` is the memoised way to ask for it.
 *
 * Why the ladder has exactly these rungs:
 *
 *   high    Physical materials with image-based reflections for the 'environment' tier
 *           (metal, gold, chrome, gem, glass, fur) plus the O(vertices × neighbourhood)
 *           shading-normal smoothing pass that makes those reflections roll instead of
 *           stepping. The desktop default.
 *   medium  The 'environment' tier is CLAMPED down to Phong ('direct') at material
 *           construction — a specular highlight from the scene's real lights, no IBL, no
 *           tonal shift — and the smoothing pass never runs. Phong's per-fragment cost is
 *           ≈ Lambert + one specular lobe, which is why this is the MOBILE default: a
 *           rocky mountain still reads as rock on a phone, at near-Lambert cost.
 *   low     Everything renders matte Lambert. Terrain ignores its material-class LUT
 *           entirely (the batches built are byte-identical to a pre-feature build), and
 *           asset slots construct Lambert whatever their class says. The hard opt-out for
 *           a device where even a specular lobe is unwelcome.
 *
 * The tier clamps the LIGHTING TIER at material construction, never the stored class
 * name: the file still says `gold` at every quality, so raising the tier back restores
 * the full look with no re-bake (the same stored-vs-effective split
 * `effectiveVoxelMaterialClassName` maintains for the smoothing fallback).
 */

/** One rung of the quality ladder, cheapest last. */
export type MaterialQuality = 'high' | 'medium' | 'low';

/** What a quality tier actually switches on. */
export interface MaterialQualityPolicy {
    /** Allow 'environment'-tier (Physical/IBL) materials; off ⇒ they clamp to Phong. */
    environmentTier: boolean;
    /** Allow 'direct'-tier (Phong) materials; off ⇒ everything clamps to Lambert. */
    directTier: boolean;
    /** Run the CPU shading-normal smoothing pass for shiny asset slots. */
    shadingSmoothing: boolean;
}

const POLICIES: Readonly<Record<MaterialQuality, MaterialQualityPolicy>> = {
    high: { environmentTier: true, directTier: true, shadingSmoothing: true },
    medium: { environmentTier: false, directTier: true, shadingSmoothing: false },
    low: { environmentTier: false, directTier: false, shadingSmoothing: false },
};

/**
 * The default when nothing platform-specific has been resolved — and the value
 * non-interactive contexts (tests, workers, the offscreen thumbnail renderer)
 * should use, so an asset preview shows the asset's full look.
 */
export const DEFAULT_MATERIAL_QUALITY: MaterialQuality = 'high';

const STORAGE_KEY = 'bm.materialQuality';

/** What `quality` switches on. */
export function materialQualityPolicy(quality: MaterialQuality): MaterialQualityPolicy {
    return POLICIES[quality];
}

/** Whether `value` names a tier (narrowing, so callers need no cast). */
export function isMaterialQuality(value: string): value is MaterialQuality {
    return Object.prototype.hasOwnProperty.call(POLICIES, value);
}

/** `?matq=<tier>` — forces a tier for this load only. */
function urlOverride(): MaterialQuality | null {
    try {
        const raw = new URLSearchParams(window.location.search).get('matq');
        if (raw !== null && isMaterialQuality(raw)) return raw;
    } catch {
        // No window/location (tests, workers) — fall through.
    }
    return null;
}

function stored(): MaterialQuality | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw !== null && isMaterialQuality(raw)) return raw;
    } catch {
        // Privacy mode / no storage.
    }
    return null;
}

/**
 * The tier this load should use: `?matq=` → stored choice → `fallback`, which is the
 * device quality tier's answer. An unrecognised value falls back rather than throwing — a
 * typo in a device-testing URL must not break the load (same contract as
 * `resolveWarmupMode`).
 *
 * Prefer `activeMaterialQuality()` over calling this directly: it is on the per-material
 * construction path, and this function re-reads the URL and `localStorage` every call.
 */
export function resolveMaterialQuality(fallback: MaterialQuality): MaterialQuality {
    return urlOverride() ?? stored() ?? fallback;
}

/**
 * Bumped whenever the STORED choice changes.
 *
 * `activeMaterialQuality()` memoises the resolved tier because it sits on the
 * per-material construction path, and a memo that nothing invalidates would quietly turn
 * `setMaterialQuality` into a no-op — which is exactly what it did, and what
 * `ClassedPartMaterial.test.ts` caught. An integer compared per lookup is far cheaper
 * than the URL parse plus `localStorage` read it replaces, and it keeps the invalidation
 * in the hands of the only two functions that can cause it, with no import back from this
 * leaf module to the ladder.
 */
let storedEpoch = 0;

/** Read by the memoised accessor to notice a stored choice it has not seen. */
export function materialQualityEpoch(): number {
    return storedEpoch;
}

/**
 * Persist a chosen tier (the settings dial, or an automatic downgrade). Takes effect on
 * the next material construction — already-built materials are not rebuilt.
 */
export function setMaterialQuality(quality: MaterialQuality): void {
    storedEpoch++;
    try {
        localStorage.setItem(STORAGE_KEY, quality);
    } catch {
        /* privacy mode — the choice applies to this session only */
    }
}

/** Forget the stored choice, returning to the device quality tier's answer. */
export function clearMaterialQuality(): void {
    storedEpoch++;
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* nothing stored, nothing to clear */
    }
}
