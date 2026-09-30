/**
 * @fileoverview Animation Packs - Predefined animation sets for on-demand loading
 *
 * This module defines standard animation packs that can be loaded dynamically
 * by Game templates. Required locomotion animations are loaded automatically by
 * PlayerLoader; optional one-shots are loaded only when used.
 *
 * Animation data (URLs, motion IDs, names) lives in `AnimationAssets.ts` —
 * the single source of truth shared by runtime code and the standalone bundler.
 *
 * The built-in `coreAnimations` list is split into two tiers:
 * - REQUIRED_ANIMATIONS: locomotion + idle + jump + the second-jump flip. The
 *   engine state machine plays these for every game, so they are eager-loaded at
 *   startup (`buildAnimationList()`).
 * - OPTIONAL_BUILTIN_ANIMATIONS: one-shots (Punching, Kicking, MiningChop,
 *   SoccerKick, DanceUthana) that only some games use. These are NOT loaded at
 *   startup — the system or template that needs them loads them on demand, so a
 *   plain game never downloads (or, when published, bundles) clips it never
 *   plays. The bundler mirrors this split in `generate-asset-manifest.mjs`.
 *
 * Other packs:
 * - MELEE_WEAPON_ANIMATIONS: weapon-holding animations (already on-demand).
 */

import type { BaseAnimationDefinition } from 'types/game.js';
import { animationAssets } from 'engine/AnimationAssets.js';

/**
 * Animation pack types that can be loaded on-demand
 */
export type AnimationPackType = 'core' | 'weapon' | 'ranged';

/**
 * The active library is chosen in `AnimationAssets.ts` (`activeLibrary`), which
 * the standalone bundler also reads so it embeds the same set.
 *
 * The two libraries use DIFFERENT motion ids, so switching only changes what the
 * engine loads by default. Anything that names an id explicitly — a published
 * game, a world.json asset, a template calling `playCustomAnimation` — keeps
 * resolving to whichever library that id belongs to, via `getBuiltinAnimationDef`
 * below. That is what lets the two coexist.
 */
const ACTIVE_LIBRARY = animationAssets.activeLibrary === 'generated'
    ? { entries: animationAssets.generatedAnimations, baseUrl: animationAssets.generatedAnimationBaseUrl }
    : { entries: animationAssets.coreAnimations, baseUrl: animationAssets.animationBaseUrl };

/**
 * Motion IDs the engine state machine plays for EVERY game (locomotion + idle +
 * jump + the second-jump flip). These are the only built-in animations loaded
 * eagerly at startup. Keep this in sync with `ENGINE_REQUIRED_MOTION_IDS` in
 * `game/scripts/generate-asset-manifest.mjs` so the bundle embeds exactly what
 * the runtime always loads.
 *
 * Both libraries' ids are listed: the required tier is a property of the ROLE a
 * clip plays, and listing both keeps the set correct whichever library is
 * active — and keeps the bundler's copy a straight mirror of this one.
 */
const REQUIRED_MOTION_IDS = new Set<string>([
    // CDN library
    'mWalkDefault01', // Walk
    'mQdKavT8ahiz',   // SlowRun
    'm9YxTKJfRZWu',   // FastRun
    'muwpHn8cHXFR',   // Jump
    'mIdleDefault01', // Idle
    'mForwardFlip01', // ForwardFlip — auto-played on second jump
    // Hand-authored library
    'mGenWalk01',
    'mGenSlowRun01',
    'mGenFastRun01',
    'mGenJump01',
    'mGenIdle01',
    'mGenForwardFlip01',
]);

const toDefinition = (baseUrl: string) => (a: {
    file: string;
    url?: string;
    motionId: string;
    name: string;
    source?: 'mixamo';
    designSpeed?: number;
    worksWithAttachedObjects?: boolean;
}): BaseAnimationDefinition => ({
    animationUrl: a.url ?? `${baseUrl}/${a.file}`,
    motionId: a.motionId,
    name: a.name,
    source: a.source as 'mixamo' | undefined,
    designSpeed: a.designSpeed,
    worksWithAttachedObjects: a.worksWithAttachedObjects,
});

/**
 * All built-in character animations from the ACTIVE library (locomotion +
 * optional one-shots). Kept as a single derived list for lookups; do NOT
 * eager-load the whole thing — use REQUIRED_ANIMATIONS for startup and load
 * optionals on demand.
 */
export const CORE_ANIMATIONS: BaseAnimationDefinition[] =
    ACTIVE_LIBRARY.entries.map(toDefinition(ACTIVE_LIBRARY.baseUrl));

/**
 * Every built-in clip: BOTH libraries' core sets AND every on-demand pack
 * (melee, ranged, directional, posture). Only used for id lookups.
 *
 * The packs belong here even though nothing loads them at startup — this table
 * is what lets `playCustomAnimation('mGenCrawl01')` lazy-load a clip by name
 * instead of warning "not found, load it first". Without them the ONLY way to
 * see a posture clip was to enter its posture, so "play every animation" (and
 * the debug cycler) silently skipped 40+ clips — reported as the crawl having
 * no animations of its own.
 */
const ALL_BUILTIN_ANIMATIONS: BaseAnimationDefinition[] = [
    ...animationAssets.coreAnimations.map(toDefinition(animationAssets.animationBaseUrl)),
    ...animationAssets.generatedAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl)),
    ...animationAssets.generatedMeleeWeaponAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl)),
    ...animationAssets.generatedRangedWeaponAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl)),
    ...animationAssets.generatedDirectionalAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl)),
    ...animationAssets.generatedPostureAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl)),
];

/**
 * Every built-in motionId that ships with the ACTIVE library, packs included —
 * the list "play/test every animation" should walk. Ordered core-first so a
 * cycle starts on the familiar locomotion clips.
 */
export const ALL_BUILTIN_MOTION_IDS: string[] = [
    ...ACTIVE_LIBRARY.entries.map((a) => a.motionId),
    ...animationAssets.generatedMeleeWeaponAnimations.map((a) => a.motionId),
    ...animationAssets.generatedRangedWeaponAnimations.map((a) => a.motionId),
    ...animationAssets.generatedDirectionalAnimations.map((a) => a.motionId),
    ...animationAssets.generatedPostureAnimations.map((a) => a.motionId),
];

/**
 * Locomotion + idle + jump + flip — always loaded at startup. This is what
 * `buildAnimationList()` returns for the player, NPCs, and remote multiplayer
 * avatars.
 */
export const REQUIRED_ANIMATIONS: BaseAnimationDefinition[] =
    CORE_ANIMATIONS.filter(a => REQUIRED_MOTION_IDS.has(a.motionId));

/**
 * Built-in one-shots (Punching, Kicking, MiningChop, SoccerKick, DanceUthana)
 * that are loaded only when a system/template actually uses them.
 */
export const OPTIONAL_BUILTIN_ANIMATIONS: BaseAnimationDefinition[] =
    CORE_ANIMATIONS.filter(a => !REQUIRED_MOTION_IDS.has(a.motionId));

/**
 * These packs select by clip NAME, not motionId.
 *
 * Names are the one thing the two libraries share — every library has a clip
 * called 'Punching', but their ids differ. Selecting by id would silently return
 * an empty pack under the non-matching library, and the first symptom would be a
 * character that punches with no animation at all.
 */
const byName = (...names: string[]): BaseAnimationDefinition[] =>
    OPTIONAL_BUILTIN_ANIMATIONS.filter(a => names.includes(a.name));

/**
 * Punch + kick clips for `UnarmedMeleeSystem`. Loaded on demand when the attack
 * system is attached (player or NPC), never at startup.
 *
 * The base pair (Punching = right cross, Kicking = front kick) is what the
 * system auto-registers; the six extra strikes are the fighting-game set —
 * jab, hook, uppercut, roundhouse, side kick, leg sweep. They only exist in
 * the generated library, so under the CDN library `byName` simply returns the
 * base pair (names are matched per active library; missing names drop out).
 * Register the extras as moves with `registerCustomAttack` — ids in
 * `UNARMED_MOVES`.
 */
export const UNARMED_COMBAT_ANIMATIONS: BaseAnimationDefinition[] = byName(
    'Punching', 'Kicking',
    'PunchJab', 'PunchHook', 'PunchUppercut',
    'KickRoundhouse', 'KickSide', 'KickSweep',
    // The guard stance. Its name routes it onto AnimationState.IDLE when the
    // pack loads (see AnimationOverrideSystem name routing), which is what
    // gives an unarmed fighter fists-up posture between strikes.
    'FightingIdle',
);

/**
 * Motion ids for every unarmed strike, keyed by move. The strike vocabulary
 * for fighting games — pass these to `registerCustomAttack` after loading
 * UNARMED_COMBAT_ANIMATIONS. Generated-library ids (`mGen*`); the two base
 * moves also exist in the CDN library under their own ids.
 */
export const UNARMED_MOVES = {
    cross: 'mGenPunching01',
    jab: 'mGenPunchJab01',
    hook: 'mGenPunchHook01',
    uppercut: 'mGenPunchUppercut01',
    frontKick: 'mGenKicking01',
    roundhouse: 'mGenKickRoundhouse01',
    sideKick: 'mGenKickSide01',
    sweep: 'mGenKickSweep01',
} as const;

/**
 * Mining swing clip for `PlayerToolSystem`. Loaded on demand when a tool is
 * equipped, never at startup.
 */
export const MINING_ANIMATIONS: BaseAnimationDefinition[] = byName('MiningChop');

/**
 * Look up a built-in animation definition (required or optional) by motionId.
 * Used by the animation controller to lazy-load an optional built-in the first
 * time a game plays it via `playCustomAnimation` / `loadCustomAnimation`.
 */
export function getBuiltinAnimationDef(motionId: string): BaseAnimationDefinition | undefined {
    return ALL_BUILTIN_ANIMATIONS.find(a => a.motionId === motionId);
}

/**
 * Melee weapon animations - for sword/axe/spear combat
 * Load these via loadAnimationPack() in Game templates that use WeaponMeleeSystem
 */
export const MELEE_WEAPON_ANIMATIONS: BaseAnimationDefinition[] =
    animationAssets.activeLibrary === 'generated'
        ? animationAssets.generatedMeleeWeaponAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl))
        : animationAssets.meleeWeaponAnimations.map(a => ({
            animationUrl: a.url,
            motionId: a.motionId,
            name: a.name,
            source: a.source as 'mixamo' | undefined,
        }));

/**
 * On-demand aim/fire clips for ranged weapons. Same load pattern as the melee
 * pack: RangedWeaponSystem loads these the first time a gun is equipped.
 */
export const RANGED_WEAPON_ANIMATIONS: BaseAnimationDefinition[] =
    animationAssets.generatedRangedWeaponAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl));

/**
 * Directional locomotion — strafes and backpedals for aim-locked movement.
 * Loaded on demand the first time an aiming mode locks facing (camera-aim or
 * cursor-aim 'always'); until loaded the forward clips play for every
 * direction, exactly as before this pack existed.
 */
export const DIRECTIONAL_LOCOMOTION_ANIMATIONS: BaseAnimationDefinition[] =
    animationAssets.generatedDirectionalAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl));

/** Motion ids the direction-aware locomotion selection resolves against. */
export const DIRECTIONAL_MOVES = {
    backpedal: 'mGenBackpedal01',
    backpedalFast: 'mGenBackpedalFast01',
    strafeLeft: 'mGenStrafeLeft01',
    strafeRight: 'mGenStrafeRight01',
} as const;

/**
 * Posture clips — a hold (idle) and, where the posture moves, a locomotion
 * loop. Loaded on demand the first time a character enters a posture; until
 * then (or on failure) the standing clips play, exactly as before postures.
 */
export const POSTURE_ANIMATIONS: BaseAnimationDefinition[] =
    animationAssets.generatedPostureAnimations.map(toDefinition(animationAssets.generatedAnimationBaseUrl));

/**
 * The posture vocabulary and its clips. `hold` replaces IDLE, `move` replaces
 * WALK and RUN (one clip per posture — a crouch has no "run"; the stride sync
 * scales it and the posture caps the speed). Postures without `move` freeze
 * locomotion to the hold (a seated character does not walk).
 */
export const POSTURE_MOVES = {
    crouch: { hold: 'mGenCrouchHold01', move: 'mGenCrouchStep01' },
    prone: { hold: 'mGenProneHold01', move: 'mGenCrawl01' },
    sit: { hold: 'mGenSitHold01' },
    kneel: { hold: 'mGenKneelHold01' },
    swim: { hold: 'mGenSwimTread01', move: 'mGenSwimStroke01' },
    climb: { hold: 'mGenClimbHold01', move: 'mGenClimbUp01' },
    supine: { hold: 'mGenSupineHold01' },
    sleep: { hold: 'mGenSleepHold01' },
    floorSit: { hold: 'mGenFloorSitHold01' },
    lean: { hold: 'mGenLeanHold01' },
    // Cover: the hold is behind the wall. 'coverPeek' is the SAME physical
    // posture (capsule/speed stay 'cover' — see PlayerPosture) with the risen
    // clip set; PostureActions.setCoverPeek flips the animation posture
    // between the two while the player aims/fires over the top.
    cover: { hold: 'mGenCoverHold01', move: 'mGenCrouchStep01' },
    coverPeek: { hold: 'mGenCoverPeek01', move: 'mGenCrouchStep01' },
    ledgeHang: { hold: 'mGenLedgeHang01' },
    push: { hold: 'mGenPushStep01', move: 'mGenPushStep01' },
    carry: { hold: 'mGenCarryHold01', move: 'mGenCarryStep01' },
    ride: { hold: 'mGenRideHold01' },
} as const;

/** One-shot posture transitions/actions, played via playCustomAnimation. */
export const POSTURE_ACTIONS = {
    slide: 'mGenSlide01',
    ledgeMantle: 'mGenLedgeMantle01',
    getUp: 'mGenGetUp01',
    vault: 'mGenVault01',
} as const;

export type Posture = 'stand' | keyof typeof POSTURE_MOVES;

/**
 * Hold-style move ids for ranged weapons, plus the grenade throw.
 *
 * Weapons map to HOLDS, not to their own clips: `rangedMovesFor` resolves any
 * archetype id — including ones the registry doesn't have yet (smg, minigun,
 * grenade_launcher…) — onto one of these six sets by name pattern, so a new
 * gun archetype ships with animations on day one.
 */
export const RANGED_MOVES = {
    aimPistol: 'mGenAimPistol01',
    firePistol: 'mGenFirePistol01',
    aimDual: 'mGenAimDualPistols01',
    fireDual: 'mGenFireDualPistols01',
    aimRifle: 'mGenAimRifle01',
    fireRifle: 'mGenFireRifle01',
    aimShoulder: 'mGenAimShoulder01',
    fireShoulder: 'mGenFireShoulder01',
    aimMinigun: 'mGenAimMinigun01',
    fireMinigun: 'mGenFireMinigun01',
    aimBow: 'mGenAimBow01',
    fireBow: 'mGenFireBow01',
    throwGrenade: 'mGenThrowGrenade01',
} as const;

/** One hold style's aim loop + fire clip. `fireLoops` marks sustained fire. */
export interface RangedMoveSet {
    aim: string;
    fire: string;
    /** True when the fire clip loops for as long as the trigger is held (minigun). */
    fireLoops: boolean;
}

/**
 * Resolve a ranged weapon type id to its hold style's clips.
 *
 * Pattern-matched on the id so custom and future archetypes land on a sensible
 * hold without registry changes: 'smg', 'machine_gun' and 'laser_blaster' are
 * all stocked rifles; 'grenade_launcher' rides on the shoulder like a bazooka.
 */
export function rangedMovesFor(weaponTypeId: string): RangedMoveSet {
    const id = weaponTypeId.toLowerCase();
    const set = (aim: string, fire: string, fireLoops = false): RangedMoveSet => ({ aim, fire, fireLoops });

    if (/minigun|gatling/.test(id)) return set(RANGED_MOVES.aimMinigun, RANGED_MOVES.fireMinigun, true);
    if (/dual/.test(id)) return set(RANGED_MOVES.aimDual, RANGED_MOVES.fireDual);
    if (/bazooka|rocket|grenade_launcher|launcher|rpg|mortar/.test(id)) {
        return set(RANGED_MOVES.aimShoulder, RANGED_MOVES.fireShoulder);
    }
    if (/bow(?!ling)/.test(id) && !/crossbow/.test(id)) return set(RANGED_MOVES.aimBow, RANGED_MOVES.fireBow);
    if (/pistol|revolver|handgun/.test(id)) return set(RANGED_MOVES.aimPistol, RANGED_MOVES.firePistol);
    // Rifle is the catch-all long gun: assault rifle, smg, machine gun,
    // crossbow, laser blaster, shotgun — anything stocked at the shoulder.
    return set(RANGED_MOVES.aimRifle, RANGED_MOVES.fireRifle);
}

/**
 * Named weapon moves, for templates that want a specific strike rather than
 * whatever the ATTACK state defaults to.
 *
 * Wire one up with `registerCustomAttack({ animationMotionId: WEAPON_MOVES.whirlwind, … })`
 * — see `CustomAttackMove` in types/game.ts. Falls back to the single legacy
 * sword slash when the CDN library is active, so a template that names a move
 * still gets *something* rather than silently playing nothing.
 */
export const WEAPON_MOVES = {
    slashDown: 'mGenSlashDown01',
    slashSide: 'mGenSlashSide01',
    slashUp: 'mGenSlashUp01',
    thrust: 'mGenThrust01',
    heavyChop: 'mGenHeavyChop01',
    cleave: 'mGenCleave01',
    spearThrust: 'mGenSpearThrust01',
    heavyUp: 'mGenHeavyUp01',
    backCleave: 'mGenBackCleave01',
    whirlwind: 'mGenWhirlwind01',
    guard: 'mGenWeaponGuard01',
} as const;

/**
 * Get animations for a specific pack type
 */
export function getAnimationPack(packType: AnimationPackType): BaseAnimationDefinition[] {
    switch (packType) {
        case 'core':
            return [...CORE_ANIMATIONS];
        case 'weapon':
            return [...MELEE_WEAPON_ANIMATIONS];
        case 'ranged':
            return [...RANGED_WEAPON_ANIMATIONS];
        default:
            console.warn(`Unknown animation pack: ${packType}`);
            return [];
    }
}

/**
 * Build the animation list for initial player loading.
 *
 * Returns only the REQUIRED animations (locomotion + idle + jump + flip) that
 * the engine state machine plays for every game. Optional one-shots (combat,
 * mining, soccer, dance) are loaded on demand by the system or template that
 * uses them — so a game never downloads (or bundles) clips it never plays.
 *
 * @returns Array of required animations to eager-load
 */
export function buildAnimationList(): BaseAnimationDefinition[] {
    console.log(`🎬 AnimationPacks: Loading ${REQUIRED_ANIMATIONS.length} required animations`);
    return [...REQUIRED_ANIMATIONS];
}
