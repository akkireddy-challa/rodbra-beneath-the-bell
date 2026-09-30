/**
 * Voxel MATERIAL CLASSES — what a material slot is made OF.
 *
 * A material slot (`engine/VoxelMaterialSlots.ts`) already gives a voxel an
 * identity independent of its colour, and already becomes its own geometry group
 * with its own material instance at mesh-assembly time. Until now the only thing
 * a slot could say about itself was how brightly it glows. Everything shaded
 * through `MeshLambertMaterial` — pure diffuse, no specular lobe — so a steel
 * blade and the leather grip below it returned the identical lighting response.
 *
 * A material class is the missing half: a NAME (`metal`, `wood`, `gem`) that the
 * table below maps to a lighting model and its parameters. Slot 0 — every voxel
 * that has not said otherwise — is `matte`, which is exactly today's Lambert, so
 * an asset with no classes renders byte-for-byte as it did before this file.
 *
 * ── Why a name and not numbers ───────────────────────────────────────────────
 *
 * The stored identity is the class NAME, not a metalness/roughness pair, for the
 * same reasons `VxlV3Rig` stores a `skeletonRef` rather than a joint layout:
 *
 *  - The look stays tunable. Every number here can change without re-baking a
 *    single `.vxl`; a stored 0.83 would be frozen into every asset that used it.
 *  - Unknown names degrade instead of breaking (`resolveVoxelMaterialClass`
 *    returns the default), so an older engine loading a newer asset renders it
 *    plainly rather than throwing.
 *  - It is a label a classifier can actually justify. "This is steel" is a claim
 *    that can be checked; "metalness 0.83" is a number nothing can calibrate.
 *  - It is reusable. `impact` below is already the hook for impact sounds and
 *    spark effects, so a second, divergent classification does not have to
 *    appear later for gameplay.
 *
 * ── Why THREE lighting tiers ─────────────────────────────────────────────────
 *
 * This is the load-bearing decision, and it is taken from a measurement already
 * recorded in `VoxelSurfaceFinish.VoxelPaintParams`: a voxel surface moved from
 * Lambert to Standard/Physical GAINS image-based diffuse light that Lambert never
 * received — measured at 1.26x luminance and 0.34x saturation on a kart under an
 * open sky. The kart stopped matching the world around it, which is why the
 * vehicle 'paint' finish deliberately defaults to a non-IBL gloss.
 *
 *  'lambert'     — `matte` alone. Literally today's code path.
 *  'direct'      — `MeshPhongMaterial`. three routes `scene.environment`
 *                  EXCLUSIVELY to Standard/Physical, so choosing Phong IS the
 *                  per-material opt-out from image-based lighting. Its diffuse
 *                  response equals Lambert's, so a glossy-wood slot sitting
 *                  beside a Lambert base group differs only by an additive
 *                  highlight — there is no tonal seam to fix. The highlight still
 *                  travels across the surface, because the SHADING NORMALS do
 *                  that work, not the reflection.
 *  'environment' — `MeshPhysicalMaterial`, real reflections of
 *                  `scene.environment`. Only where that is the entire point:
 *                  metal, gold, chrome, gem, glass. These accept the tonal shift
 *                  by design — chrome is not supposed to match the paint beside
 *                  it — with `albedoScale` to trim what remains.
 *
 * The consequence worth stating outright: the BASE slot never changes tier.
 * Promoting it to Physical to "match" a shiny slot would apply that measured
 * shift to 100% of an asset's voxels in service of the few per cent that are
 * shiny, and make every voxel object in every scene pay for image-based lighting.
 * The all-one-material case needs no such promotion anyway: if a class owns every
 * palette entry the base group ends up empty, and `assembleVoxelMesh` only adds a
 * group when its index count is non-zero, so an all-gold asset costs no extra
 * draw call and has no Lambert group to seam against.
 *
 * ── Why `fur` is on the reflective tier without reflecting anything ──────────
 *
 * Every dial above answers one question — how does light bounce OFF this? — and
 * that is enough for eleven of the twelve classes. It is not enough for `fur`. A
 * fibre mat's whole visual signature is light caught and scattered by the TIPS, so
 * it is brightest exactly where the surface turns away from the eye and a specular
 * lobe has nothing left to give. Tuned with `shininess` and `specular` alone, fur
 * is cloth with the numbers turned down: measured on a lit sphere, the difference
 * was about one 8-bit level.
 *
 * three has the right model already — the Charlie SHEEN lobe — and it exists only
 * on `MeshPhysicalMaterial`. So `fur` takes the 'environment' tier for its BRDF
 * and then switches the environment itself off with `envMapIntensity: 0`, which
 * zeroes both `getIBLIrradiance` and `getIBLRadiance` at source. It therefore
 * takes none of the tonal shift the tier normally accepts: no image-based light
 * reaches it, and the sheen comes from the scene's own lights (`BRDF_Sheen` runs
 * in the DIRECT loop), so fur in an unlit room is black like everything else.
 *
 * The alternative considered and rejected was a hand-written rim term added to the
 * emissive channel. It needed a GLSL patch and a TSL twin kept in step by hand, it
 * could not be lit — fur would have glowed in a pitch-black cave — and at a gain
 * low enough not to glow it was barely visible at all.
 */

import { materialQualityPolicy, type MaterialQuality } from 'engine/MaterialQuality.js';

/**
 * The closed vocabulary. Ordered loosely from least to most reflective, which is
 * also the order the collapse chain below walks when an asset is over its slot
 * budget.
 */
export type VoxelMaterialClassName =
    | 'matte'
    | 'cloth'
    | 'fur'
    | 'leather'
    | 'wood'
    | 'stone'
    | 'plastic'
    | 'paint'
    | 'metal'
    | 'gold'
    | 'chrome'
    | 'gem'
    | 'glass'
    | 'filament'
    | 'neon'
    | 'lava';

/**
 * The class every voxel is in unless it says otherwise — and the fallback for
 * any name this engine build does not recognise.
 */
export const DEFAULT_VOXEL_MATERIAL_CLASS: VoxelMaterialClassName = 'matte';

/**
 * Stored with a uint8 length prefix, like a slot name. Longer than any name here
 * so a future class does not need a format change to be spelled out.
 */
export const VOXEL_MATERIAL_CLASS_NAME_MAX = 24;

/** Which lighting model backs a class — see the file header for why three. */
export type VoxelMaterialLighting = 'lambert' | 'direct' | 'environment';

/**
 * What a voxel surface is made of, in render terms. Every field is required with
 * a value in the table below (`game/docs/engine-options-pattern.md`: a brand-new
 * engine API prefers required members over optional ones).
 */
export interface VoxelMaterialClass {
    /** Which of the three lighting models this class is built on. */
    lighting: VoxelMaterialLighting;
    /**
     * Metallic fraction, read only by the 'environment' tier. At 1 the diffuse
     * term is gone entirely and the surface IS its reflection, tinted by the
     * voxel's colour — which is what makes a gold voxel read as gold metal
     * rather than as a yellow shiny plastic.
     */
    metalness: number;
    /** Microfacet roughness for 'environment'. Low is mirror-like. */
    roughness: number;
    /** Clearcoat layer strength for 'environment'; 1 is a full lacquer. */
    clearcoat: number;
    /** Clearcoat roughness — keep low, this is the tight gloss lobe. */
    clearcoatRoughness: number;
    /** Phong specular exponent for the 'direct' tier. Higher is tighter. */
    shininess: number;
    /** Phong specular colour intensity for 'direct', 0…1. */
    specular: number;
    /** Multiplier on the reflected environment, 'environment' tier only. */
    envMapIntensity: number;
    /**
     * Multiplier on the base colour, 0…1 — the tonal compensation described in
     * the file header, and the same knob `VoxelPaintParams.albedoScale` is.
     *
     * Kept at 1 for the high-metalness classes on purpose: there the colour is
     * the REFLECTION TINT rather than an albedo, so scaling it down does not
     * correct a brightness error, it just makes the metal dingy.
     */
    albedoScale: number;
    /**
     * How much shading-normal smoothing this class needs, 0…1 (0 = the stock
     * faceted voxel look).
     *
     * Not cosmetic for the reflective classes. A voxel mesh has exactly six
     * distinct face normals, and a reflection is a function of the normal, so an
     * unsmoothed metal blade samples the environment in three directions and
     * returns three flat tones — it reads as flat grey paint, not as steel. The
     * smoothing pass is what makes the highlight ROLL along the blade while the
     * stair-stepped silhouette survives exactly as authored.
     */
    smoothness: number;
    /** Smoothing neighbourhood radius, in voxel lengths. */
    smoothRadiusVoxels: number;
    /**
     * Charlie sheen strength, 0..1, where 0 is off — the retroreflective lobe that
     * makes a fibre surface brightest where it turns AWAY from the eye.
     *
     * Read only by the 'environment' tier, because three implements sheen on
     * `MeshPhysicalMaterial` alone. It is the one lobe here that is not a
     * reflection, and the only reason `fur` is on that tier at all — see the file
     * header. Non-zero for `fur` and nothing else.
     *
     * Note it does not simply ADD light: three's energy compensation takes the
     * sheen's share out of the diffuse term, so a sheened surface redistributes
     * its brightness towards the silhouette rather than getting hotter overall.
     */
    sheen: number;
    /**
     * Sheen lobe width, 0..1 — and the knob that decides whether this reads as fur
     * or as a mistake, in the opposite direction to the intuitive one.
     *
     * A BROAD lobe sounds like the soft option and is not: measured on a lit
     * sphere, 0.9 lifts the whole surface roughly evenly and strips ~12% of its
     * saturation, so the albedo washes out and nothing reads as a rim. Around 0.35
     * the lobe stays at grazing angles, where it belongs — the outer third of the
     * form brightens smoothly towards the silhouette while the centre moves by
     * about one 8-bit level. Tighter still (0.25) and the halo collapses into a
     * hairline at the very edge.
     */
    sheenRoughness: number;
    /**
     * Sheen tint, as a hex colour. Kept off pure white on purpose: at full white
     * the lobe drags the surface towards grey, and on a voxel asset the albedo IS
     * the identity — a beige teddy bear that rims to neutral grey has lost the
     * thing that made it a beige teddy bear.
     */
    sheenColor: number;
    /**
     * What to render as when the smoothing pass is refused (mobile, or a mesh
     * over the vertex budget), or null to keep this class regardless.
     *
     * Only for a class whose whole identity is a reflection: unsmoothed chrome is
     * the six-flat-tones failure above, and plastic is a better lie than that.
     * A gold sword still reads as gold with faceted normals, so `gold` keeps
     * itself.
     */
    mobileFallback: VoxelMaterialClassName | null;
    /**
     * The class this collapses into when an asset has more material classes than
     * its slot budget allows, or null for a terminal class.
     *
     * Ordered by render-parameter proximity, so a collapse loses detail rather
     * than lying: gold is a metal, a gem is glassy, leather is a kind of cloth.
     */
    collapsesTo: VoxelMaterialClassName | null;
    /**
     * The glow this class ships with, 0..255, in `VoxelSlot.emissive`'s units.
     *
     * NEVER read at render time. The slot's own emissive is the truth on the
     * wire, and this is the number an AUTHORING step seeds it with — the editor
     * creating a material, a template part that names a class and nothing else.
     * Keeping it out of the renderer is what lets `emissive: 0` go on meaning
     * "dark, and runtime code may light it" for a `neon` slot the creator
     * deliberately switched off, and what keeps an older engine — which has
     * never heard of `neon` — rendering the same asset at the same brightness.
     *
     * Zero for every surface class, because a surface does not emit. The three
     * classes that do are the whole point of the field: it is what lets "Made
     * of" answer "how much does this glow?" so the editor stops asking.
     */
    defaultGlow: number;
    /**
     * How this surface sounds and behaves when struck. The renderer never reads
     * it; it exists so impact sounds, sparks and mining hardness can key off the
     * same classification rather than growing a second, divergent one.
     */
    impact: 'soft' | 'hard' | 'metallic' | 'glassy' | 'wood';
}

/** Shared defaults, so each entry below states only what makes it itself. */
const BASE: VoxelMaterialClass = {
    lighting: 'direct',
    metalness: 0,
    roughness: 1,
    clearcoat: 0,
    clearcoatRoughness: 0.06,
    shininess: 30,
    specular: 0.2,
    envMapIntensity: 1,
    albedoScale: 1,
    smoothness: 0.4,
    smoothRadiusVoxels: 2.5,
    sheen: 0,
    sheenRoughness: 1,
    sheenColor: 0xffffff,
    mobileFallback: null,
    collapsesTo: 'matte',
    impact: 'hard',
    defaultGlow: 0,
};

/**
 * The table. Values are a starting point tuned to be conservative — a class that
 * reads slightly understated is a much cheaper mistake than one that blows out,
 * because a wrongly-shiny surface is what a player notices and screenshots.
 */
export const VOXEL_MATERIAL_CLASSES: Readonly<Record<VoxelMaterialClassName, VoxelMaterialClass>> = {
    // The default. 'lambert' means the material factory takes its original
    // branch, so this entry's other numbers are never read.
    matte: {
        ...BASE,
        lighting: 'lambert',
        smoothness: 0,
        collapsesTo: null,
        impact: 'hard',
    },

    // ── 'direct' tier: a highlight from the scene's real lights, no IBL, so the
    //    diffuse tone is identical to an unclassified voxel's.
    cloth: {
        ...BASE,
        shininess: 6,
        specular: 0.05,
        smoothness: 0.5,
        collapsesTo: 'matte',
        impact: 'soft',
    },
    // The only class carrying a `sheen` lobe, and the only one on the
    // 'environment' tier that reflects nothing. A teddy bear reads as plush for
    // two reasons — the fibre tips catch light at the silhouette, and the form is
    // soft rather than faceted — so this pairs three's Charlie sheen with the
    // highest smoothing in the table. See the file header for why the tier.
    fur: {
        ...BASE,
        lighting: 'environment',
        // A dielectric, and as rough as it gets: the GGX lobe should contribute
        // essentially nothing. Everything fur-shaped comes from the sheen below.
        metalness: 0,
        roughness: 1,
        // THE point of the entry. Zero means no environment reaches this material,
        // so it takes none of the tier's tonal shift and goes properly dark in an
        // unlit room; the sheen is fed by the scene's own lights instead.
        envMapIntensity: 0,
        // Measured, not guessed — see `sheenRoughness` above. This profile lifts
        // the outer third of the form smoothly towards the silhouette (roughly
        // double the matte edge luminance) and leaves the centre within one 8-bit
        // level of matte, so a brown bear stays brown. Strength stops at 0.5 for
        // the reason the whole table is conservative: understated is the cheaper
        // mistake. The tint is warm rather than white because backscatter through
        // pale fibre tips is warm, and a white lobe drags the surface to grey.
        sheen: 0.5,
        sheenRoughness: 0.35,
        sheenColor: 0xe8d6bc,
        // Rounds the six face normals so shading rolls over the form while the
        // stair-stepped silhouette survives exactly as authored. Higher than
        // `paint`'s 0.75 because fur has no deliberate detail to melt.
        smoothness: 0.9,
        // Wider than BASE's 2.5 for the same reason: there are no edges to keep.
        smoothRadiusVoxels: 3,
        // Same reasoning as chrome's, for the same failure: a sheen lobe is a
        // function of the normal, so across six flat face normals it is six flat
        // halos rather than a rim. Cloth is the better lie, and it also keeps
        // Physical-plus-sheen off phones.
        mobileFallback: 'cloth',
        // Fur is a kind of cloth, so a collapse loses detail rather than lying.
        collapsesTo: 'cloth',
        impact: 'soft',
    },
    leather: {
        ...BASE,
        shininess: 16,
        specular: 0.13,
        smoothness: 0.5,
        collapsesTo: 'cloth',
        impact: 'soft',
    },
    wood: {
        ...BASE,
        shininess: 22,
        specular: 0.12,
        smoothness: 0.35,
        collapsesTo: 'matte',
        impact: 'wood',
    },
    stone: {
        ...BASE,
        shininess: 10,
        specular: 0.07,
        smoothness: 0.3,
        collapsesTo: 'matte',
        impact: 'hard',
    },
    plastic: {
        ...BASE,
        shininess: 60,
        specular: 0.33,
        smoothness: 0.45,
        collapsesTo: 'matte',
        impact: 'hard',
    },
    // Automotive paint, matching the vehicle finish's own tuning so a painted
    // slot and a painted chassis read the same. VEHICLE_PAINT_SMOOTHNESS is 0.75
    // for the reason given there: high enough that the highlight travels, short
    // of 1 so deliberate detail does not melt.
    paint: {
        ...BASE,
        shininess: 45,
        specular: 0.55,
        smoothness: 0.75,
        collapsesTo: 'plastic',
        impact: 'hard',
    },

    // ── 'environment' tier: real reflections of scene.environment. See the file
    //    header for the tonal shift these accept by design.
    metal: {
        ...BASE,
        lighting: 'environment',
        metalness: 0.9,
        roughness: 0.35,
        envMapIntensity: 1,
        smoothness: 0.8,
        smoothRadiusVoxels: 2.5,
        collapsesTo: 'matte',
        impact: 'metallic',
    },
    gold: {
        ...BASE,
        lighting: 'environment',
        metalness: 1,
        roughness: 0.22,
        envMapIntensity: 1,
        smoothness: 0.8,
        collapsesTo: 'metal',
        impact: 'metallic',
    },
    chrome: {
        ...BASE,
        lighting: 'environment',
        metalness: 1,
        roughness: 0.05,
        envMapIntensity: 1,
        smoothness: 0.9,
        // A mirror with six normals is six flat tones; plastic is the better lie.
        mobileFallback: 'plastic',
        collapsesTo: 'metal',
        impact: 'metallic',
    },
    // A dielectric, not a metal: the sparkle is a tight clearcoat lobe over a
    // saturated body colour. Metalness 0 means the albedo IS an albedo here, so
    // this is where albedoScale earns its keep.
    gem: {
        ...BASE,
        lighting: 'environment',
        metalness: 0,
        roughness: 0.05,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        envMapIntensity: 1.2,
        albedoScale: 0.86,
        smoothness: 0.6,
        collapsesTo: 'glass',
        impact: 'glassy',
    },
    // OPAQUE, deliberately — no `transmission`. A transparent group inside a
    // material array shares the one mesh's single sort position and cannot
    // depth-sort against its own opaque groups, so real glass needs its own mesh
    // and renderOrder. That is a separate feature; this is a hard, bright,
    // reflective surface that reads as glass at voxel scale.
    glass: {
        ...BASE,
        lighting: 'environment',
        metalness: 0,
        roughness: 0.02,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        envMapIntensity: 1.2,
        albedoScale: 0.86,
        smoothness: 0.5,
        collapsesTo: 'metal',
        impact: 'glassy',
    },

    // ── The emissive family. These are the classes that answer "how much does
    //    this glow?" on their own, which is the entire reason the editor no
    //    longer has to ask.
    //
    //    All three are 'direct', not 'environment', and that is deliberate: what
    //    identifies a neon tube is its own light, not the sky in it. The
    //    Physical tier's measured 1.26x luminance / 0.34x saturation shift (see
    //    the file header) would fight the glow rather than serve it, and would
    //    make every lit bulb in a scene pay for image-based lighting to look
    //    slightly worse. `mobileFallback` is null throughout for the same
    //    reason the gold entry keeps itself: an unsmoothed bulb still reads as a
    //    bulb, because the glow is doing the work the reflection would.
    //
    //    NAMED AFTER MATERIALS, NOT OBJECTS, and that is load-bearing rather
    //    than a style preference. `VxlMaterialSlotTransforms` decides which
    //    slots a re-classification may move voxels out of by asking whether the
    //    SLOT NAME is a class name, so every word added here becomes a name a
    //    creator can no longer safely give a hand-made light. 'lamp' and
    //    'screen' are what someone calls the slot; 'filament' and 'neon' are
    //    what the surface is made of.

    // A hot wire in a bulb, a lantern flame, a torch. The everyday light, and
    // the reason its glow is 70% rather than full: an incandescent source that
    // clips to white loses the warm colour that made it worth authoring.
    filament: {
        ...BASE,
        shininess: 12,
        specular: 0.08,
        smoothness: 0.45,
        collapsesTo: 'matte',
        impact: 'glassy',
        defaultGlow: 180,
    },
    // A gas tube or an LED sign — the saturated, unambiguous glow, and the only
    // class that ships at full strength, which is the level `EMISSIVE_INTENSITY`
    // and the bloom threshold are tuned against.
    neon: {
        ...BASE,
        shininess: 40,
        specular: 0.1,
        smoothness: 0.55,
        collapsesTo: 'filament',
        impact: 'glassy',
        defaultGlow: 255,
    },
    // Molten rock: still rock, which is why it collapses to `stone` rather than
    // to another light. Under budget pressure a lava flow is better off as the
    // stone it is made of than as a bulb.
    lava: {
        ...BASE,
        shininess: 4,
        specular: 0.03,
        smoothness: 0.35,
        collapsesTo: 'stone',
        impact: 'hard',
        defaultGlow: 215,
    },
};

/** Every class name, for schema generation and editor pickers. */
export const VOXEL_MATERIAL_CLASS_NAMES: readonly VoxelMaterialClassName[] =
    Object.keys(VOXEL_MATERIAL_CLASSES) as VoxelMaterialClassName[];

/** True when `name` is one this engine build knows. */
export function isVoxelMaterialClassName(name: string | undefined): name is VoxelMaterialClassName {
    if (name === undefined) return false;
    return VOXEL_MATERIAL_CLASSES[name as VoxelMaterialClassName] !== undefined;
}

/**
 * Normalise a stored class name, or `undefined` for the default.
 *
 * Returns the DEFAULT name for anything unrecognised rather than throwing, which
 * is what lets a newer asset load in an older engine: it renders plainly instead
 * of failing. Matching is case-insensitive and trims, because these names arrive
 * from GLB material names, hand-written JSON and model output.
 */
export function normalizeVoxelMaterialClassName(name: string | undefined | null): VoxelMaterialClassName {
    if (typeof name !== 'string') return DEFAULT_VOXEL_MATERIAL_CLASS;
    const lower = name.trim().toLowerCase();
    return isVoxelMaterialClassName(lower) ? lower : DEFAULT_VOXEL_MATERIAL_CLASS;
}

/**
 * The class name to STORE, or `''` for "no class at all".
 *
 * Distinct from {@link normalizeVoxelMaterialClassName}, and the distinction is the
 * whole point: that function answers "how does this shade?", so an unrecognised
 * name comes back as the default. This one answers "what should the file say?",
 * and an unrecognised name is KEPT.
 *
 * Conflating the two silently strips any class a newer vocabulary introduced the
 * moment an older engine re-encodes the asset — the file would come back saying
 * `matte` because that build happened not to know the word yet.
 *
 * Only two things map to `''`: nothing, and the default itself. Storing `matte`
 * explicitly would raise the file's version and change its bytes to record the
 * absence of a decision.
 */
export function storedVoxelMaterialClassName(name: string | undefined | null): string {
    if (typeof name !== 'string') return '';
    const trimmed = name.trim().toLowerCase().slice(0, VOXEL_MATERIAL_CLASS_NAME_MAX);
    return trimmed === DEFAULT_VOXEL_MATERIAL_CLASS ? '' : trimmed;
}

/**
 * The render parameters for a stored class name. Never throws; an unknown name
 * resolves to the default, so a caller never has to guard.
 */
export function resolveVoxelMaterialClass(name: string | undefined | null): VoxelMaterialClass {
    return VOXEL_MATERIAL_CLASSES[normalizeVoxelMaterialClassName(name)];
}

/**
 * The glow an AUTHORING step should give a slot that is made of `name`, 0..255.
 *
 * The one accessor for `defaultGlow`, so the "never at render time" rule in the
 * field's own docs has a single place to be broken and therefore a single place
 * to be checked. An unknown or absent class resolves to `matte`'s 0, which is
 * also what an older asset means by saying nothing.
 *
 * Callers use it two ways, and both matter:
 *  - as a SEED, when a material is created (the editor, a template part naming
 *    only a class) — the number lands in `VoxelSlot.emissive` and is thereafter
 *    the creator's to change;
 *  - as an UNTOUCHED TEST, when a material is re-classed. A slot still sitting
 *    on its old class's default has never been tuned by hand, so it follows the
 *    new class; anything else is a decision somebody made, and re-classing must
 *    not quietly undo it.
 */
export function defaultGlowForVoxelMaterialClass(name: string | undefined | null): number {
    return VOXEL_MATERIAL_CLASSES[normalizeVoxelMaterialClassName(name)].defaultGlow;
}

/**
 * The class to actually RENDER, after the runtime's own limits are applied.
 *
 * `smoothed` is whether this slot's shading-normal pass actually ran. When it did
 * not — mobile, or a mesh over the vertex budget — a class whose identity is a
 * reflection falls back rather than rendering as six flat tones. Split from
 * `resolveVoxelMaterialClass` so the stored identity and the rendered one stay
 * distinguishable: the file still says `chrome` on a phone.
 */
export function effectiveVoxelMaterialClassName(
    name: string | undefined | null,
    smoothed: boolean,
): VoxelMaterialClassName {
    const resolved = normalizeVoxelMaterialClassName(name);
    if (smoothed) return resolved;
    const fallback = VOXEL_MATERIAL_CLASSES[resolved].mobileFallback;
    return fallback ?? resolved;
}

/**
 * Whether this class wants the shading-normal smoothing pass at all, given the
 * material quality this load resolved to (`MaterialQuality.ts` — callers resolve
 * once per assembly and pass it in, so this module stays platform-free).
 *
 * A cheaper tier skips the PASS, not the material: the Phong and Physical lobes
 * are near-free, and a gold sword should still read as gold on a phone. What a
 * cheap device cannot afford is the O(vertices x neighbourhood) smoothing —
 * measured at 53.7ms of a 105.6ms load for one 5,537-leaf kart on desktop, an
 * order of magnitude worse on a phone, per object.
 */
export function wantsShadingSmoothing(cls: VoxelMaterialClass, quality: MaterialQuality): boolean {
    if (cls.smoothness <= 0) return false;
    return materialQualityPolicy(quality).shadingSmoothing;
}

/**
 * The lighting tier to actually BUILD, after the quality tier's clamp: a
 * disallowed 'environment' steps down to 'direct' (Phong with the class's own
 * specular numbers — a better likeness than collapsing to another class), and a
 * disallowed 'direct' steps down to 'lambert'. The stored class name never
 * changes — the same stored-vs-rendered split the smoothing fallback keeps.
 */
export function clampVoxelMaterialLighting(
    lighting: VoxelMaterialLighting,
    quality: MaterialQuality,
): VoxelMaterialLighting {
    const policy = materialQualityPolicy(quality);
    if (lighting === 'environment' && !policy.environmentTier) lighting = 'direct';
    if (lighting === 'direct' && !policy.directTier) lighting = 'lambert';
    return lighting;
}
