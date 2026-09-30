import * as THREE from 'three';
import type { BaseAnimationDefinition, CustomAttackMove } from 'types/game.js';

/**
 * Result returned when starting an attack, includes move configuration for hit detection
 */
export interface AttackResult {
    success: boolean;
    duration: number;
    animationName: string;
    /** Custom move configuration if this attack uses a registered custom move */
    moveConfig?: CustomAttackMove;
}

/**
 * Interface for character animation controllers
 * Allows different implementations (skinned mesh vs block character) to share the same animation logic
 */
export interface ICharacterAnimationController {
    /** Optional for previously shipped controller implementations. */
    setProceduralPoseLayer?(name: string, spec: import('engine/animation/ProceduralPoseLayers.js').ProceduralPoseLayer): void;
    updateProceduralPoseLayer?(name: string, rotations: ReadonlyMap<string, THREE.Quaternion>): boolean;
    removeProceduralPoseLayer?(name: string): void;
    getAttackContactCheckPhases?(fallback: readonly number[]): readonly number[];
    getAttackPlaybackToken?(): string;
    /**
     * Initialize the animation controller with a character and animation data
     * @param baseAnimations - Optional array of base animations to load from URLs instead of using GLB animations
     */
    initializeWithCharacter(
        character: THREE.Object3D,
        gltf: any,
        loader?: any,
        baseAnimations?: BaseAnimationDefinition[],
        gameDataProvider?: () => { assets?: unknown[]; scene?: THREE.Scene | null } | null
    ): Promise<void>;

    /**
     * Update animation state based on movement and actions
     */
    updateAnimation(isMoving: boolean, speed: number, isGrounded: boolean, isJumping: boolean, hasMovementInput?: boolean): void;

    /**
     * Which way the character is travelling relative to its facing, as a
     * character-local vector (+Z forward, +X left). Drives the directional
     * locomotion clips (strafe/backpedal) when that pack is loaded; inert
     * otherwise. Optional for backward compatibility — implementations that
     * predate the directional pack simply never strafe.
     */
    setLocomotionDirection?(localX: number, localZ: number): void;
    setDirectionalLocomotionStyle?(style: 'neutral' | 'rifle'): void;
    setDirectionalLocomotionEnabled?(enabled: boolean): void;

    /**
     * Body posture ('stand' | 'crouch' | 'prone' | 'sit' | 'kneel' | 'swim' |
     * 'climb'): swaps IDLE to the posture's hold and WALK/RUN to its move clip
     * when the posture pack is loaded; inert otherwise. Optional for backward
     * compatibility — implementations that predate postures simply stand.
     */
    setPosture?(posture: string): void;

    /**
     * Update the animation controller (should be called every frame)
     */
    update(deltaTime: number): void;

    /**
     * Start an attack animation
     * Returns AttackResult with success status, duration, animation name, and optional move config
     */
    startAttack(): AttackResult;

    /**
     * Get current animation state
     */
    getCurrentState(): string;

    /**
     * Check if currently attacking
     */
    getIsAttacking(): boolean;

    /**
     * Is a one-shot custom animation currently playing (`playCustomAnimation`)?
     *
     * Distinct from `getIsAttacking()`, which is only true for clips routed
     * through the attack system. A template that plays a swing directly gets a
     * moving weapon arm with `isAttacking` false the whole time — which is why
     * `WeaponMeleeSystem` needs both before deciding whether the animation or the
     * weapon-stabilizer owns the blade's orientation.
     *
     * Optional: templates that predate this method simply don't report it, and
     * callers fall back to `getIsAttacking()` alone.
     */
    getIsPlayingCustomAnimation?(): boolean;

    /**
     * Dispose of resources
     */
    dispose(): void;

    /**
     * Get the underlying mixer for advanced operations
     */
    getMixer(): THREE.AnimationMixer | null;

    /**
     * Set the game data provider so the animation controller can look up
     * animation assets by ID internally (no need to pass data arrays).
     */
    setGameDataProvider?(provider: () => { assets?: unknown[]; scene?: THREE.Scene | null } | null): void;

    /**
     * Load a specific animation by its asset ID.
     * The animation is looked up from the engine's assets list automatically.
     * Requires setGameDataProvider() to have been called.
     *
     * Use this to load only the animations you need:
     *   await animController.loadCustomAnimation('zombie-standup');
     *   await animController.loadCustomAnimation('sword-run', { loop: true });
     *
     * @param motionId - The animation asset ID
     * @param options - Optional configuration for the animation
     */
    loadCustomAnimation?(
        motionId: string,
        options?: {
            normalizeRootMotion?: boolean;
            loop?: boolean;
        }
    ): Promise<void>;

    /**
     * Load ALL animation assets from the game data (every asset with type 'animation').
     * Use loadCustomAnimation() instead if you only need specific animations.
     *
     * @param options - Optional configuration applied to all animations
     */
    loadAllAnimationAssets?(options?: { normalizeRootMotion?: boolean; loop?: boolean }): Promise<void>;

    /**
     * Play a custom animation by motionId
     * @param motionId - Motion ID of the custom animation to play
     * @param options - Optional configuration
     * @returns Object with success status and animation duration
     */
    playCustomAnimation?(
        motionId: string,
        options?: {
            fadeInDuration?: number;
            fadeOutDuration?: number;
            speed?: number;
            onFinished?: () => void;
            applyRootMotion?: boolean;
            onRootMotionDisplacement?: (displacement: THREE.Vector3) => void;
            /** When true, the animation stays clamped on its last frame instead of
             *  transitioning back to idle. The state machine is blocked until the
             *  next playCustomAnimation / playAnimation call. */
            holdLastFrame?: boolean;
            /** When true (Mixamo path only), the hips position track is locked
             *  to the first frame on all axes — animation rotates in place and
             *  the character's translation is owned by physics. */
            filterRootMotion?: boolean;
            /** When true and the player is currently running, set an
             *  upper-body-only blend so legs keep the run cycle while the
             *  custom clip plays on the upper body — same behaviour as
             *  WeaponMeleeSystem's melee strike. Has no effect outside RUN. */
            splitBodyOnRun?: boolean;
            /** When true, the custom animation is stopped the moment the
             *  player has movement input and the locomotion state machine
             *  resumes. Use for short one-shot moves (kicks, dodges) that
             *  should yield to player control. */
            interruptOnMovement?: boolean;
            /** Fired once when playback crosses the clip's auto-detected
             *  contact frame. Use to apply a physical effect (ball impulse,
             *  hit) at the moment of contact instead of at frame 0. No-ops if
             *  the clip has no detectable strike and no impactTime is given. */
            onImpact?: () => void;
            /** Override (clip-local seconds) of the contact frame; beats the
             *  auto-detected value. */
            impactTime?: number;
        }
    ): { success: boolean; duration: number };

    /**
     * Check if a custom animation is currently playing
     */
    isPlayingCustom?(): boolean;

    /**
     * Get the motionId of the currently playing custom animation, or null if none.
     * Used by network animation sync to broadcast custom animation state.
     */
    getCustomMotionId?(): string | null;
    /** 0..1 progress of the playing custom clip; 0 when none. */
    getCustomAnimationProgress?(): number;

    /**
     * Get list of available custom animation motionIds
     */
    getAvailableCustomAnimations?(): string[];

    /**
     * Stop the currently playing custom animation
     */
    stopCustomAnimation?(): void;

    /**
     * Set the playback speed of the currently playing custom or priority animation.
     * 0 = paused (frozen on current frame), 1 = normal speed, 0.5 = half speed, etc.
     *
     * @example
     * animController.playCustomAnimation('zombie-standup', { speed: 0 });
     * // ... later ...
     * animController.setAnimationSpeed(1);
     */
    setAnimationSpeed?(speed: number): void;

    /**
     * Get the playback speed of the currently playing animation.
     */
    getAnimationSpeed?(): number;

    /**
     * Seek the currently playing custom or priority animation to a specific
     * time in seconds. Combine with setAnimationSpeed(0) to hold on an
     * arbitrary frame.
     *
     * @example
     * const { duration } = animController.playCustomAnimation('jump');
     * const holdTime = (9 / 25) * duration; // frame 9 of 25
     * animController.setAnimationSpeed(0);
     * animController.setAnimationTime(holdTime);
     */
    setAnimationTime?(time: number): void;

    /**
     * Get the current playback time (in seconds) of the playing animation.
     */
    getAnimationTime?(): number;

    /**
     * Play a high-priority animation that locks out idle/movement animations
     * @param animationName - Name of the animation clip to play
     * @param options - Configuration options
     * @returns Object with success status and animation duration
     */
    playPriorityAnimation?(
        animationName: string,
        options?: {
            fadeInDuration?: number;
            fadeOutDuration?: number;
            speed?: number;
            loop?: boolean;
            onFinished?: () => void;
        }
    ): { success: boolean; duration: number };

    /**
     * Check if a priority animation is currently playing (blocks idle/movement)
     */
    isPriorityAnimationPlaying?(): boolean;

    /**
     * Set callback to check if object is attached to hand
     * Used to filter idle animations based on whether they work with attached objects
     */
    setHasObjectAttachedToHandCallback?(callback: (() => boolean) | null): void;

    /**
     * Dynamically load an animation pack at runtime.
     * Use this to load additional animations after initial setup.
     * 
     * @param animations - Array of animation definitions to load
     * @param options.addToAttackCollection - If true, add Punch/Kick/Attack animations to attack collection
     * @param options.replaceLocomotion - If true, replace Run/Jump/Idle (for weapon packs)
     * @returns Promise that resolves when all animations are loaded
     */
    loadAnimationPack?(
        animations: BaseAnimationDefinition[],
        options?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean }
    ): Promise<void>;

    /**
     * Load Mixamo-skeleton base animations deferred from initializeWithCharacter.
     * Call after block character setup when scene/character refs are ready.
     */
    loadDeferredMixamoAnimations?(): Promise<void>;

    /**
     * Check if attack animations are available.
     * Useful for UI to show/hide attack buttons.
     */
    hasAttackAnimations?(): boolean;

    /**
     * Register a custom attack move with specific animation and combat properties.
     * The animation must already be loaded (either as a base animation or custom animation).
     * 
     * @param move - Custom attack move configuration
     * @returns true if the move was registered successfully
     */
    registerCustomAttack?(move: CustomAttackMove): boolean;

    /**
     * Remove a registered custom attack move by name. Returns whether a move
     * with that name existed. Used when the move set changes at runtime —
     * e.g. `WeaponMeleeSystem` swaps grip-appropriate moves on weapon switch.
     */
    unregisterCustomAttack?(name: string): boolean;

    /**
     * Load and register custom attack moves from combat configuration.
     * Loads animations from the assets list and registers them as attack moves.
     * Requires setGameDataProvider() to have been called.
     * 
     * @param customMoves - Array of custom attack move definitions
     */
    loadCustomAttackMoves?(
        customMoves: CustomAttackMove[]
    ): Promise<void>;

    /**
     * Get list of registered custom attack move names
     */
    getRegisteredAttackMoves?(): string[];
    /** Full config of a registered attack move, or null — lets engine-side
     *  systems (NPC strike hit registration) resolve limb/side/damage. */
    getAttackMoveConfig?(moveName: string): CustomAttackMove | null;

    /**
     * Start a specific attack by move name (for custom moves)
     * @param moveName - Name of the registered custom move
     * @returns AttackResult with move configuration
     */
    startNamedAttack?(moveName: string): AttackResult;

    /**
     * Listen for the start of ANY attack animation — random, named, or the
     * ATTACK state override. `WeaponMeleeSystem` uses it to sound the swing.
     *
     * OPTIONAL, and it has to be: published games ship frozen template code that
     * implements this interface, so a required member here would fail to compile
     * against an engine they cannot be rebuilt for (see game/AGENTS.md). Callers
     * must null-check with `?.`.
     */
    setAttackStartedListener?(
        listener: ((info: { moveName: string; duration: number }) => void) | null,
    ): void;

    /**
     * Override the animation clip used for a specific locomotion state.
     * The state machine still determines which state to be in (idle, walk, run, etc.);
     * the override only changes *which clip* plays for that state.
     *
     * The source can be a motionId (from loadCustomAnimation) or a clip name
     * from the mixer's existing clips.
     *
     * @param state - The animation state to override (e.g. 'run', 'idle', 'walk')
     * @param source - motionId or clip name identifying the animation to use
     * @returns true if the override was set successfully
     *
     * @example
     * // Use a "Run with sword" animation when in RUN state
     * animController.setAnimationOverride('run', 'motionId_run_with_sword');
     * // Use a combat idle when in IDLE state
     * animController.setAnimationOverride('idle', 'motionId_combat_idle');
     */
    setAnimationOverride?(state: string, source: string): boolean;

    /**
     * Clear the animation override for a specific state, reverting to the default.
     * @param state - The animation state to clear (e.g. 'run', 'idle')
     */
    clearAnimationOverride?(state: string): void;

    /**
     * Clear all animation state overrides, reverting everything to defaults.
     */
    clearAnimationOverrides?(): void;

    /**
     * Get the list of currently active animation overrides.
     * @returns Map of state name to clip name for all active overrides
     */
    getAnimationOverrides?(): Map<string, string>;

    /**
     * Set per-body-part blend weights for custom animations.
     * Applies to all custom animation paths (uploaded animations, action layer, etc.).
     * 0 = full locomotion (standard animation), 1 = full custom animation.
     *
     * Upper/lower body is determined automatically from the skeleton hierarchy:
     * everything in the spine subtree is upper body, everything else is lower body.
     *
     * Pass null to revert to uniform blending.
     */
    setCustomAnimationBodyBlend?(blend: { upperBody: number; lowerBody: number } | null): void;

    /**
     * Get the current per-body-part blend weights for custom animations.
     * Returns null when uniform blending is in effect.
     */
    getCustomAnimationBodyBlend?(): { upperBody: number; lowerBody: number } | null;

    /**
     * Movement-system stance: local bone-rotation offsets keyed by body-part
     * name ('leftShin', 'torso', ...), applied on top of the animated pose so a
     * controller can HOLD a posture (e.g. a snowboard crouch) without an
     * animation clip. Pass null to clear.
     */
    setManualBoneOffsets?(offsets: Map<string, import('three').Quaternion> | null): void;
    getManualBoneOffsets?(): Map<string, import('three').Quaternion> | null;

    /**
     * Keep every bone and track in the Mixamo players loaded from now on
     * instead of pruning to the block-character parts. The skinned render
     * path sets this before animations load, because a skin may weight
     * vertices to fingers and toes the block body never needs.
     */
    setRetainFullSkeleton?(retain: boolean): void;

    /**
     * Foot IK targets: plant each ankle at a world position with a world
     * orientation (e.g. bolted to a snowboard), knees solving to reach them, so
     * the feet stay on the board independent of the upper-body pose. null = off.
     */
    setFootIkTargets?(targets: import('engine/loaders/LegIK.js').LegIkTargets | null): void;
    getFootIkTargets?(): import('engine/loaders/LegIK.js').LegIkTargets | null;

    /**
     * Track A Mixamo player (locomotion override).
     * Null when Track A uses the standard mixer.
     */
    getTrackAMixamoPlayer?(): import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null;

    /**
     * Track B Mixamo player (custom/override animation).
     * Null when Track B is inactive or uses the action layer.
     */
    getTrackBMixamoPlayer?(): import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null;

    /**
     * Outgoing Track A Mixamo player during a mixamo→mixamo crossfade.
     * Null when no crossfade is in progress.
     */
    getFadingOutTrackAPlayer?(): import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null;

    /**
     * Crossfade progress from outgoing to incoming Track A player.
     * 0 = 100% outgoing, 1 = 100% incoming.
     */
    getFadingOutCrossfadeProgress?(): number;

}
