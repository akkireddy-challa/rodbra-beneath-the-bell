/**
 * Single source of truth for all built-in GLB asset URLs.
 * Used by runtime code (AnimationPacks, CharacterConfig, SkeletonAnimalLoader)
 * and by the standalone build script (generate-asset-manifest.mjs).
 */

// Keep this module dependency-free: Node's standalone manifest builder imports it.
export const LOCOMOTION_DIRECTIONS = [
    'Forward', 'Forward_Left', 'Left', 'Backward_Left',
    'Backward', 'Backward_Right', 'Right', 'Forward_Right',
] as const;
export const capturedDirectionId = (style: 'neutral' | 'rifle', direction: string): string =>
    `mCaptured${style === 'rifle' ? 'Rifle' : 'Jog'}${direction.replace(/_/g, '')}01`;

const capturedDirectionalBase = 'https://mini.bitmagic.ai/worlds/v3/captured_locomotion/20260914-directional-v1';

interface AnimationEntry {
    file: string;
    /**
     * Absolute URL that overrides `<library base>/<file>`. The default
     * locomotion of the generated library points at the Mixamo motion-capture
     * walk and run this way, while other clips stay generated. Imported clips
     * must be retargeted offline to the raw canonical skeleton before publishing
     * so captured locomotion and generated actions share the same bind pose.
     */
    url?: string;
    motionId: string;
    name: string;
    source?: 'mixamo';
    designSpeed?: number;
    worksWithAttachedObjects?: boolean;
}

interface WeaponAnimationEntry {
    url: string;
    motionId: string;
    name: string;
    source?: 'mixamo';
}

/**
 * Which built-in animation library ships.
 *
 * `'cdn'` is the original set of imported Mixamo clips on mini.bitmagic.ai;
 * `'generated'` is the hand-authored library built by
 * `tools/build-animation-library.mjs` (see game/docs/authoring-animations.md).
 *
 * Lives here rather than in AnimationPacks because the standalone bundler
 * (`scripts/generate-asset-manifest.mjs`) imports this module and has to bundle
 * the same set the runtime will load.
 */
export type AnimationLibraryId = 'cdn' | 'generated';

interface AnimationAssetsData {
    activeLibrary: AnimationLibraryId;
    animationBaseUrl: string;
    generatedAnimationBaseUrl: string;
    animalBaseUrl: string;
    voxelAnimalBaseUrl: string;
    voxelFishBaseUrl: string;
    characterUrls: {
        default: string;
        defaultFallback: string;
        /**
         * Every URL an older writer baked into game.json / world.json as "the default
         * character". None names a custom rig; see isDefaultCharacterUrl.
         */
        legacyDefaults: readonly string[];
    };
    coreAnimations: AnimationEntry[];
    generatedAnimations: AnimationEntry[];
    meleeWeaponAnimations: WeaponAnimationEntry[];
    generatedMeleeWeaponAnimations: AnimationEntry[];
    generatedRangedWeaponAnimations: AnimationEntry[];
    generatedDirectionalAnimations: AnimationEntry[];
    generatedPostureAnimations: AnimationEntry[];
    animalSkeletons: Record<string, string>;
}

export const animationAssets: AnimationAssetsData = {
    activeLibrary: 'generated',
    // The core animation GLBs are mirrored brotli-compressed in this folder
    // (served with Content-Encoding: br + Content-Type: model/gltf-binary,
    // transparent to fetch/GLTFLoader). The uncompressed originals remain at
    // worlds/v3/animations/ as a rollback. ~63% smaller download per game.
    animationBaseUrl: 'https://mini.bitmagic.ai/worlds/v3/animations_brotli',
    // The hand-authored library (see game/docs/authoring-animations.md), published
    // to S3 by `tools/upload-generated-animations.mjs`.
    //
    // Every publish creates a NEW datetime-stamped folder and uploads it
    // `immutable` with a one-year max-age. Those go together: because no URL is
    // ever reused, nothing inside a folder can change, so it is safe to cache
    // forever — and there is no window where some clips are fresh and others
    // stale, which would look like an animation bug rather than a caching one.
    // Iterating therefore means: rebuild, re-upload, and change ONLY this line.
    //
    // Brotli-compressed, served with Content-Encoding: br — transparent to the
    // browser, so no loader-side decompression. (Note that a curl built without
    // brotli will show garbage for these; that is curl, not the asset.)
    //
    // To go back to serving from the repo for local iteration, set this to
    // '/animations/generated' — `game/animations/generated/` sits under the dev
    // server's root, so the relative base resolves with no route.
    generatedAnimationBaseUrl: 'https://mini.bitmagic.ai/worlds/v3/code_generated_animations/20260909-062358',
    animalBaseUrl: 'https://mini.bitmagic.ai/worlds/v3/animations/animals',
    // Voxel animal bodies (GlbAnimalBody). On localhost these are served by the
    // serve-voxel-animals vite middleware; this URL is the non-local (S3/CDN)
    // base. Objects live in prod-mini-cloudsave-bucket under worlds/v3/voxel_animals/
    // (uploaded by tools/upload-voxel-animals.js) and are brotli-compressed,
    // served with `Content-Encoding: br` — transparent to the browser, so the
    // loader needs no brotli code.
    voxelAnimalBaseUrl: 'https://mini.bitmagic.ai/worlds/v3/voxel_animals',
    // Voxel FISH bodies (aquatic creatures — they swim, see AnimalController).
    // Same scheme as voxelAnimalBaseUrl but a separate worlds/v3/fishes_voxel_brotli/
    // folder so fish are managed/served apart from land animals.
    voxelFishBaseUrl: 'https://mini.bitmagic.ai/worlds/v3/fishes_voxel_brotli',
    characterUrls: {
        // ┌──────────────────────────────────────────────────────────────────────────────────────┐
        // │ DEFAULT CHARACTER RIG — SOURCE OF TRUTH. ⚠️ NEVER DELETE THESE URLs.                   │
        // │ The live, working files are hosted ONLY under:                                         │
        // │   https://magic-mesh-gen.sandbox.dev.bitmagic.cloud/worlds/v3/                         │
        // │     • BaseCharacter_brotli2.glb — brotli-compressed copy (Content-Encoding: br)        │
        // │     • BaseCharacter.glb         — uncompressed canonical copy (the fallback)           │
        // │ The historical copy, https://mini.bitmagic.ai/worlds/v3/BaseCharacter.glb, is a        │
        // │ DEAD 404 — do NOT switch to it (see world-json-split-migration.ts). If the rig ever    │
        // │ 404s again, restore THESE magic-mesh-gen URLs; do not invent a new path.               │
        // └──────────────────────────────────────────────────────────────────────────────────────┘
        // PlayerLoader loads `default` (brotli) first and falls back to `defaultFallback`
        // (uncompressed) after two failed attempts — see loadPlayerWithRetry. Both are the SAME
        // rig, so nothing else should hardcode a default character URL (the world.json migration
        // deliberately leaves characterUrl empty and lets this default apply). By default the
        // VISIBLE character is the clean BoxGeometry block mascot (BitmagicPlayerCharacter); this
        // GLB then serves only as the HIDDEN Mixamo animation rig that poses the blocks (never
        // shown), so its own look doesn't matter — only its skeleton. When the user asks for a
        // highres character, generate_character sets worldProfileData.characterUrl
        // (+ useHighResCharacter) and this default no longer applies. The rig MUST be
        // rerigTarget:'default' (Mixamo, Y-up): the engine retargets Mixamo animation while keeping
        // each bone's bind position, so bones must point +Y. 'ue5' rigs render mangled.
        default: 'https://magic-mesh-gen.sandbox.dev.bitmagic.cloud/worlds/v3/BaseCharacter_brotli2.glb',
        defaultFallback: 'https://magic-mesh-gen.sandbox.dev.bitmagic.cloud/worlds/v3/BaseCharacter.glb',
        // The world.json split migration used to hardcode this into EVERY game.json it
        // produced, so hundreds of saved games carry it verbatim. It is not a character
        // choice and the file behind it is gone — a reader that takes it literally fetches a
        // 404 four times and aborts the load.
        legacyDefaults: ['https://mini.bitmagic.ai/worlds/v3/BaseCharacter.glb'],
    },
    coreAnimations: [
        { file: 'NewWalk.glb', motionId: 'mWalkDefault01', name: 'Walk', source: 'mixamo', designSpeed: 1.8 },
        { file: 'NewRun.glb', motionId: 'mQdKavT8ahiz', name: 'SlowRun', source: 'mixamo', designSpeed: 3.5 },
        { file: 'NewRun.glb', motionId: 'm9YxTKJfRZWu', name: 'FastRun', source: 'mixamo', designSpeed: 5.0 },
        { file: 'NewJump.glb', motionId: 'muwpHn8cHXFR', name: 'Jump', source: 'mixamo' },
        { file: 'NewIdle.glb', motionId: 'mIdleDefault01', name: 'Idle', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'ForwardFlip.glb', motionId: 'mForwardFlip01', name: 'ForwardFlip', source: 'mixamo' },
        { file: 'Kicking.glb', motionId: 'mKicking01', name: 'Kicking', source: 'mixamo' },
        { file: 'Punching.glb', motionId: 'mPunching01', name: 'Punching', source: 'mixamo' },
        { file: 'SoccerKick.glb', motionId: 'mSoccerKick01', name: 'SoccerKick', source: 'mixamo' },
        { file: 'miningChop.glb', motionId: 'mMiningChop01', name: 'MiningChop', source: 'mixamo' },
        { file: 'mixamoDanceUthana.glb', motionId: 'mDanceUthana01', name: 'DanceUthana', source: 'mixamo' },
    ],
    // Hand-authored replacements for `coreAnimations`, generated by
    // `tools/build-animation-library.mjs` from the clip modules in
    // `tools/animation-library/clips/`. Keep this table in sync with the
    // `library.json` that build writes — it is the same data.
    //
    // These carry NEW motion ids (`mGen*`) rather than reusing the ids above.
    // Published games and any world.json referencing `mIdleDefault01` and
    // friends keep resolving to the CDN clips, so switching libraries can't
    // break anything already shipped.
    //
    // `source: 'mixamo'` is required, not cosmetic: it is the tag that routes a
    // clip through MixamoAnimationPlayer, and CharacterAnimationController hard
    // errors on base animations without it.
    generatedAnimations: [
        // Motion capture for the default locomotion (see `url` on AnimationEntry).
        // The generated Walk/SlowRun/FastRun still build and publish; they are
        // reachable by swapping `url` out again, and the forger's gait code is
        // what `generate animation` authors custom gaits with.
        { file: 'Walk.glb', url: 'https://mini.bitmagic.ai/worlds/v3/captured_locomotion/20260909-094403/Walking.glb', motionId: 'mGenWalk01', name: 'Walk', source: 'mixamo', designSpeed: 1.8 },
        { file: 'SlowRun.glb', url: 'https://mini.bitmagic.ai/worlds/v3/captured_locomotion/20260909-094403/Running.glb', motionId: 'mGenSlowRun01', name: 'SlowRun', source: 'mixamo', designSpeed: 3.5 },
        { file: 'FastRun.glb', url: 'https://mini.bitmagic.ai/worlds/v3/captured_locomotion/20260909-094403/Running.glb', motionId: 'mGenFastRun01', name: 'FastRun', source: 'mixamo', designSpeed: 5.0 },
        { file: 'Jump.glb', motionId: 'mGenJump01', name: 'Jump', source: 'mixamo' },
        { file: 'Idle.glb', motionId: 'mGenIdle01', name: 'Idle', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'ForwardFlip.glb', motionId: 'mGenForwardFlip01', name: 'ForwardFlip', source: 'mixamo' },
        { file: 'Kicking.glb', motionId: 'mGenKicking01', name: 'Kicking', source: 'mixamo' },
        { file: 'Punching.glb', motionId: 'mGenPunching01', name: 'Punching', source: 'mixamo' },
        // Fighting-game strike set — 3 extra punches + 3 extra kicks alongside
        // Punching (right cross) and Kicking (front kick). Optional tier: only
        // games that load UNARMED_COMBAT_ANIMATIONS download them.
        { file: 'PunchJab.glb', motionId: 'mGenPunchJab01', name: 'PunchJab', source: 'mixamo' },
        { file: 'PunchHook.glb', motionId: 'mGenPunchHook01', name: 'PunchHook', source: 'mixamo' },
        { file: 'PunchUppercut.glb', motionId: 'mGenPunchUppercut01', name: 'PunchUppercut', source: 'mixamo' },
        { file: 'KickRoundhouse.glb', motionId: 'mGenKickRoundhouse01', name: 'KickRoundhouse', source: 'mixamo' },
        { file: 'KickSide.glb', motionId: 'mGenKickSide01', name: 'KickSide', source: 'mixamo' },
        { file: 'KickSweep.glb', motionId: 'mGenKickSweep01', name: 'KickSweep', source: 'mixamo' },
        // Unarmed guard idle — becomes the IDLE override while UnarmedMeleeSystem
        // is attached (pack name routing: any pack clip named *idle* replaces idle).
        { file: 'FightingIdle.glb', motionId: 'mGenFightingIdle01', name: 'FightingIdle', source: 'mixamo' },
        { file: 'SoccerKick.glb', motionId: 'mGenSoccerKick01', name: 'SoccerKick', source: 'mixamo' },
        { file: 'MiningChop.glb', motionId: 'mGenMiningChop01', name: 'MiningChop', source: 'mixamo' },
        { file: 'Dance.glb', motionId: 'mGenDance01', name: 'Dance', source: 'mixamo' },
    ],
    meleeWeaponAnimations: [
        { url: 'https://magic-mesh-gen.sandbox.dev.bitmagic.cloud/worlds/v3/675J6VJ53GIO/animations/1773229936741-Standing Melee Attack Downward.glb', motionId: 'mSwordSlash01', name: 'AttackSwordSlash', source: 'mixamo' },
    ],
    // Hand-authored weapon moves, loaded on demand by `WeaponMeleeSystem` when a
    // weapon is equipped. Same build pipeline as `generatedAnimations`; see
    // game/docs/authoring-animations.md.
    //
    // The `Attack` prefix is what puts a clip in the engine's ATTACK collection
    // (`AnimationOverrideSystem`, via `addToAttackCollection`). Templates pick a
    // specific move by motionId through `registerCustomAttack`; the LAST attack
    // entry here becomes the default ATTACK, so the plain overhead cut is listed
    // last on purpose.
    //
    // `WeaponGuard` is deliberately not called "WeaponIdle" — a name containing
    // "idle" would bind it to the IDLE state for unarmed play too.
    // Ranged-weapon pack — aim holds (loops) and fire one-shots, authored per
    // HOLD STYLE rather than per weapon: pistol / dual / rifle / shoulder /
    // minigun / bow, plus the grenade throw. An SMG and an assault rifle share
    // AimRifle/FireRifle; a grenade launcher shares the bazooka's shoulder set.
    // Loaded on demand when a ranged weapon is equipped (pack: 'ranged').
    generatedRangedWeaponAnimations: [
        { file: 'AimPistol.glb', motionId: 'mGenAimPistol01', name: 'AimPistol', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'FirePistol.glb', motionId: 'mGenFirePistol01', name: 'FirePistol', source: 'mixamo' },
        { file: 'AimDualPistols.glb', motionId: 'mGenAimDualPistols01', name: 'AimDualPistols', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'FireDualPistols.glb', motionId: 'mGenFireDualPistols01', name: 'FireDualPistols', source: 'mixamo' },
        { file: 'AimRifle.glb', motionId: 'mGenAimRifle01', name: 'AimRifle', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'FireRifle.glb', motionId: 'mGenFireRifle01', name: 'FireRifle', source: 'mixamo' },
        { file: 'AimShoulder.glb', motionId: 'mGenAimShoulder01', name: 'AimShoulder', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'FireShoulder.glb', motionId: 'mGenFireShoulder01', name: 'FireShoulder', source: 'mixamo' },
        { file: 'AimMinigun.glb', motionId: 'mGenAimMinigun01', name: 'AimMinigun', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'FireMinigun.glb', motionId: 'mGenFireMinigun01', name: 'FireMinigun', source: 'mixamo' },
        { file: 'AimBow.glb', motionId: 'mGenAimBow01', name: 'AimBow', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'FireBow.glb', motionId: 'mGenFireBow01', name: 'FireBow', source: 'mixamo' },
        { file: 'ThrowGrenade.glb', motionId: 'mGenThrowGrenade01', name: 'ThrowGrenade', source: 'mixamo' },
    ],
    // Directional locomotion for aim-locked movement (strafing while facing
    // the camera or cursor): loaded on demand when an aiming mode activates,
    // never at startup (pack: 'directional'). Names deliberately avoid the
    // walk/run substrings so AnimationOverrideSystem's name routing never
    // binds them to a locomotion state — the direction-aware selection in
    // CharacterAnimationController picks them by motionId instead.
    generatedDirectionalAnimations: [
        { file: 'Backpedal.glb', motionId: 'mGenBackpedal01', name: 'Backpedal', designSpeed: 1.4, source: 'mixamo' },
        { file: 'BackpedalFast.glb', motionId: 'mGenBackpedalFast01', name: 'BackpedalFast', designSpeed: 3.2, source: 'mixamo' },
        { file: 'StrafeLeft.glb', motionId: 'mGenStrafeLeft01', name: 'StrafeLeft', designSpeed: 2.2, source: 'mixamo' },
        { file: 'StrafeRight.glb', motionId: 'mGenStrafeRight01', name: 'StrafeRight', designSpeed: 2.2, source: 'mixamo' },
        ...(['neutral', 'rifle'] as const).flatMap(style => LOCOMOTION_DIRECTIONS.map(direction => ({
            file: `${style === 'rifle' ? 'Run' : 'Jog'}_${direction}.glb`,
            url: `${capturedDirectionalBase}/${style === 'rifle' ? 'Run' : 'Jog'}_${direction}.glb`,
            motionId: capturedDirectionId(style, direction),
            // Avoid the legacy name-based walk/run/idle registration route.
            name: `Directional${style === 'rifle' ? 'Rifle' : 'Jog'}${direction.replace(/_/g, '')}`,
            source: 'mixamo' as const,
        }))),
        ...(['Left', 'Right'] as const).map(side => ({
            file: `Sidestep_${side}.glb`, url: `${capturedDirectionalBase}/Sidestep_${side}.glb`,
            motionId: `mCapturedSidestep${side}01`, name: `Sidestep${side}`, source: 'mixamo' as const,
        })),
    ],
    // Postures — crouch / prone / sit / kneel / swim / climb / slide. Loaded on
    // demand when a game first enters a posture (PlayerController.setPosture)
    // or when SwimmingMovement takes over (pack: 'posture'). Names avoid the
    // idle/walk/run/jump substrings on purpose (see AnimationOverrideSystem
    // name routing) — the posture axis selects them, never the name router.
    generatedPostureAnimations: [
        { file: 'CrouchHold.glb', motionId: 'mGenCrouchHold01', name: 'CrouchHold', source: 'mixamo' },
        { file: 'CrouchStep.glb', motionId: 'mGenCrouchStep01', name: 'CrouchStep', designSpeed: 0.9, source: 'mixamo' },
        { file: 'ProneHold.glb', motionId: 'mGenProneHold01', name: 'ProneHold', source: 'mixamo' },
        { file: 'Crawl.glb', motionId: 'mGenCrawl01', name: 'Crawl', designSpeed: 0.6, source: 'mixamo' },
        { file: 'SitHold.glb', motionId: 'mGenSitHold01', name: 'SitHold', source: 'mixamo' },
        { file: 'KneelHold.glb', motionId: 'mGenKneelHold01', name: 'KneelHold', source: 'mixamo' },
        { file: 'SwimTread.glb', motionId: 'mGenSwimTread01', name: 'SwimTread', source: 'mixamo' },
        { file: 'SwimStroke.glb', motionId: 'mGenSwimStroke01', name: 'SwimStroke', designSpeed: 1.6, source: 'mixamo' },
        { file: 'ClimbHold.glb', motionId: 'mGenClimbHold01', name: 'ClimbHold', source: 'mixamo' },
        { file: 'ClimbUp.glb', motionId: 'mGenClimbUp01', name: 'ClimbUp', designSpeed: 0.5, source: 'mixamo' },
        { file: 'Slide.glb', motionId: 'mGenSlide01', name: 'Slide', source: 'mixamo' },
        { file: 'SupineHold.glb', motionId: 'mGenSupineHold01', name: 'SupineHold', source: 'mixamo' },
        { file: 'SleepHold.glb', motionId: 'mGenSleepHold01', name: 'SleepHold', source: 'mixamo' },
        { file: 'FloorSitHold.glb', motionId: 'mGenFloorSitHold01', name: 'FloorSitHold', source: 'mixamo' },
        { file: 'LeanHold.glb', motionId: 'mGenLeanHold01', name: 'LeanHold', source: 'mixamo' },
        { file: 'CoverHold.glb', motionId: 'mGenCoverHold01', name: 'CoverHold', source: 'mixamo' },
        { file: 'CoverPeek.glb', motionId: 'mGenCoverPeek01', name: 'CoverPeek', source: 'mixamo' },
        { file: 'LedgeHang.glb', motionId: 'mGenLedgeHang01', name: 'LedgeHang', source: 'mixamo' },
        { file: 'LedgeMantle.glb', motionId: 'mGenLedgeMantle01', name: 'LedgeMantle', source: 'mixamo' },
        { file: 'PushStep.glb', motionId: 'mGenPushStep01', name: 'PushStep', designSpeed: 0.7, source: 'mixamo' },
        { file: 'CarryHold.glb', motionId: 'mGenCarryHold01', name: 'CarryHold', source: 'mixamo' },
        { file: 'CarryStep.glb', motionId: 'mGenCarryStep01', name: 'CarryStep', designSpeed: 1.4, source: 'mixamo' },
        { file: 'RideHold.glb', motionId: 'mGenRideHold01', name: 'RideHold', source: 'mixamo' },
        { file: 'GetUp.glb', motionId: 'mGenGetUp01', name: 'GetUp', source: 'mixamo' },
        { file: 'Vault.glb', motionId: 'mGenVault01', name: 'Vault', source: 'mixamo' },
    ],
    generatedMeleeWeaponAnimations: [
        { file: 'AttackThrust.glb', motionId: 'mGenThrust01', name: 'AttackThrust', source: 'mixamo' },
        { file: 'AttackSlashSide.glb', motionId: 'mGenSlashSide01', name: 'AttackSlashSide', source: 'mixamo' },
        { file: 'AttackSlashUp.glb', motionId: 'mGenSlashUp01', name: 'AttackSlashUp', source: 'mixamo' },
        { file: 'AttackCleave.glb', motionId: 'mGenCleave01', name: 'AttackCleave', source: 'mixamo' },
        { file: 'AttackHeavyChop.glb', motionId: 'mGenHeavyChop01', name: 'AttackHeavyChop', source: 'mixamo' },
        { file: 'AttackSpearThrust.glb', motionId: 'mGenSpearThrust01', name: 'AttackSpearThrust', source: 'mixamo' },
        { file: 'AttackHeavyUp.glb', motionId: 'mGenHeavyUp01', name: 'AttackHeavyUp', source: 'mixamo' },
        { file: 'AttackBackCleave.glb', motionId: 'mGenBackCleave01', name: 'AttackBackCleave', source: 'mixamo' },
        { file: 'AttackWhirlwind.glb', motionId: 'mGenWhirlwind01', name: 'AttackWhirlwind', source: 'mixamo' },
        { file: 'WeaponGuard.glb', motionId: 'mGenWeaponGuard01', name: 'WeaponGuard', worksWithAttachedObjects: true, source: 'mixamo' },
        { file: 'AttackSlashDown.glb', motionId: 'mGenSlashDown01', name: 'AttackSlashDown', source: 'mixamo' },
    ],
    animalSkeletons: {
        chicken: 'Chicken_001_rig.glb',
        deer: 'Deer_001_rig.glb',
        dog: 'Dog_001_rig.glb',
        horse: 'Horse_001_rig.glb',
        kitty: 'Kitty_001_rig.glb',
        pinguin: 'Pinguin_001_rig.glb',
        tiger: 'Tiger_001_rig.glb',
    },
};

/**
 * True when `url` is the built-in character rig rather than a per-game asset: the current
 * default (either copy) or one of the URLs older writers stamped into game.json as the
 * default. A game carrying one of these has NO custom character; the engine must run its
 * normal default-rig path (brotli copy, then the uncompressed fallback) instead of treating
 * the value as an override with no fallback.
 */
export function isDefaultCharacterUrl(url: string): boolean {
    const u = animationAssets.characterUrls;
    return url === u.default || url === u.defaultFallback || u.legacyDefaults.includes(url);
}
