import * as THREE from 'three';
import type { BaseAnimationDefinition } from 'types/game.js';
import {
    filterRootMotion,
    measureRootMotionSpeed,
    makeClipLoopable,
} from 'engine/AnimationClipUtils.js';
import {
    type AnimationContext,
    AnimationState,
    type CachedGLTF,
    crossFadeToAction,
    cachedGLTFLoad,
    findAnimationAssetIdByName,
    getCharacterUniformWorldScale,
} from 'engine/animation/AnimationContext.js';
import { DIRECTIONAL_MOVES, POSTURE_MOVES } from 'engine/AnimationPacks.js';
import type { IdleAnimationSystem } from 'engine/animation/IdleAnimationSystem.js';
import type { AttackAnimationSystem } from 'engine/animation/AttackAnimationSystem.js';
import { mapWithConcurrency } from 'engine/AsyncConcurrency.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';
import { DIRECTIONAL_BLEND_IDS, LOCOMOTION_DIRECTIONS, capturedDirectionId } from 'engine/animation/DirectionalLocomotion.js';
import { DirectionalLocomotionPlayer } from 'engine/animation/DirectionalLocomotionPlayer.js';
import { animationAssets } from 'engine/AnimationAssets.js';

const BUILTIN_RUN_IDS = new Set([...animationAssets.coreAnimations, ...animationAssets.generatedAnimations]
    .filter(asset => asset.name.toLowerCase().includes('run')).map(asset => asset.motionId));

/**
 * Manages animation state overrides - allows templates to swap individual
 * locomotion states without replacing the entire animation set.
 */
export class AnimationOverrideSystem {
    private readonly ctx: AnimationContext;
    private readonly idleSystem: IdleAnimationSystem;
    private readonly attackSystem: AttackAnimationSystem;

    constructor(ctx: AnimationContext, idleSystem: IdleAnimationSystem, attackSystem: AttackAnimationSystem) {
        this.ctx = ctx;
        this.idleSystem = idleSystem;
        this.attackSystem = attackSystem;
    }

    /** True when a state override should be activated immediately (i.e. no
     *  custom or priority animation is currently masking the state machine). */
    private canActivateOverride(state: AnimationState): boolean {
        return this.ctx.currentState === state
            && !this.ctx.isPlayingCustomAnimation
            && !this.ctx.priorityAnimationPlaying;
    }

    /**
     * Override the animation clip used for a specific locomotion state.
     */
    setAnimationOverride(state: AnimationState, source: string): boolean {
        if (!this.ctx.mixer) {
            console.warn('setAnimationOverride: No mixer available');
            return false;
        }

        // Resolve the action in order: custom animations (by motionId), then
        // existing clips and idle animations (matched by clip name).
        const sourceLower = source.toLowerCase();
        const findByClipName = (actions: Iterable<THREE.AnimationAction>) => {
            for (const a of actions) {
                if (a.getClip().name.toLowerCase() === sourceLower) return a;
            }
            return undefined;
        };
        const action: THREE.AnimationAction | undefined =
            this.ctx.customAnimations.get(source)
            ?? findByClipName(this.ctx.animations.values())
            ?? findByClipName(this.idleSystem.idleAnimations);

        if (!action) {
            // Check if source has a MixamoAnimationPlayer (lookup by motionId)
            let mixamoPlayer = this.ctx.mixamoAnimationPlayers.get(source);
            let resolvedSource = source;

            // Fallback: if the caller passed an asset NAME (e.g. the user-visible
            // label from world.json) instead of the motionId, resolve it by name
            // and retry. Lets prompts like "use loco_drunk_a0_mXyz as run" work
            // without a separate id-lookup step in calling code.
            if (!mixamoPlayer) {
                const resolvedId = findAnimationAssetIdByName(this.ctx, source);
                if (resolvedId) {
                    const playerByName = this.ctx.mixamoAnimationPlayers.get(resolvedId);
                    if (playerByName) {
                        mixamoPlayer = playerByName;
                        resolvedSource = resolvedId;
                    }
                }
            }

            if (mixamoPlayer) {
                this.ctx.mixamoStateOverrides.set(state, resolvedSource);
                if (this.canActivateOverride(state)) {
                    this.activateMixamoOverride(state);
                }
                return true;
            }

            console.warn(`setAnimationOverride: Animation "${source}" not found. ` +
                `Available custom: [${Array.from(this.ctx.customAnimations.keys()).join(', ')}], ` +
                `Available mixamo: [${Array.from(this.ctx.mixamoAnimationPlayers.keys()).join(', ')}]`);
            return false;
        }

        // Configure for looping locomotion
        if (state !== AnimationState.JUMP && state !== AnimationState.ATTACK) {
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.clampWhenFinished = false;
        }

        this.ctx.stateOverrides.set(state, action);

        if (this.canActivateOverride(state)) {
            crossFadeToAction(this.ctx, action, this.ctx.config.transitionDuration!);
        }

        return true;
    }

    clearAnimationOverride(state: AnimationState): void {
        this.ctx.stateOverrides.delete(state);
        const hadMixamo = this.ctx.mixamoStateOverrides.delete(state);
        if (hadMixamo && this.ctx.trackAMixamoPlayer && this.ctx.currentState === state) {
            this.ctx.trackAMixamoPlayer.stop();
            this.ctx.trackAMixamoPlayer = null;
        }
        // State re-entry after clearing is the caller's responsibility.
    }

    clearAnimationOverrides(): void {
        if (this.ctx.stateOverrides.size === 0 && this.ctx.mixamoStateOverrides.size === 0) return;
        this.ctx.stateOverrides.clear();
        this.ctx.mixamoStateOverrides.clear();
        if (this.ctx.fadingOutTrackAPlayer) {
            this.ctx.fadingOutTrackAPlayer.stop();
            this.ctx.fadingOutTrackAPlayer = null;
        }
        if (this.ctx.trackAMixamoPlayer) {
            this.ctx.trackAMixamoPlayer.stop();
            this.ctx.trackAMixamoPlayer = null;
        }
    }

    getAnimationOverrides(): Map<string, string> {
        const result = new Map<string, string>();
        for (const [state, action] of this.ctx.stateOverrides) {
            const clip = action.getClip();
            result.set(state, clip.name);
        }
        for (const [state, motionId] of this.ctx.mixamoStateOverrides) {
            result.set(state, motionId);
        }
        return result;
    }

    /**
     * Activate a Mixamo animation as the current override for a state.
     */
    activateMixamoOverride(state: AnimationState): void {
        const motionId = resolveLocomotionMotionId(this.ctx, state);
        if (!motionId) return;
        if (state === AnimationState.WALK || state === AnimationState.RUN) {
            this.ctx.playingLocomotionBucket = this.ctx.locomotionDirection;
        }
        this.ctx.playingPosture = this.ctx.posture;

        const player = this.ctx.mixamoAnimationPlayers.get(motionId);
        if (!player) return;
        if (player instanceof DirectionalLocomotionPlayer) player.setDirection(this.ctx.locomotionAngle ?? 0);

        // If the requested player is already the active trackA AND still
        // running (locomotion playing normally), don't call play() — that
        // resets the action and re-runs the flush, which destabilises the
        // idle clip between swings. Idle stays smoothly playing instead.
        if (player === this.ctx.trackAMixamoPlayer && player.isPlaying()) {
            return;
        }

        const outgoing = this.ctx.trackAMixamoPlayer;
        if (outgoing && outgoing !== player) {
            // Reversing a transition must never leave the incoming player in
            // the outgoing slot (completion would stop the live animation).
            if (this.ctx.fadingOutTrackAPlayer && this.ctx.fadingOutTrackAPlayer !== outgoing) {
                this.ctx.fadingOutTrackAPlayer.stop();
            }
            outgoing.setLocomotionMode(false);
            this.ctx.fadingOutTrackAPlayer = outgoing;
            this.ctx.fadingOutCrossfadeProgress = 0;
        }

        const isLooping = state !== AnimationState.JUMP && state !== AnimationState.ATTACK;
        player.setLoop(isLooping);
        // Physics, not source-clip duration, decides when an airborne pose ends.
        player.setHoldLastFrame(state === AnimationState.JUMP);
        player.play();
        if (isLooping) {
            player.setLocomotionMode(true);
        }
        if (outgoing && outgoing !== player && outgoing.getNativeLocomotionSpeed() > .1
            && (state === AnimationState.WALK || state === AnimationState.RUN)) {
            player.synchronizeLocomotionFrom(outgoing);
        }
        this.ctx.trackAMixamoPlayer = player;
    }

    /**
     * Load deferred Mixamo base animations and animation packs with Mixamo content.
     */
    async loadDeferredMixamoAnimations(
        loadAnimationPack: (animations: BaseAnimationDefinition[]) => Promise<void>,
    ): Promise<void> {
        if (this.ctx.pendingMixamoBaseAnimations.length === 0) return;

        const anims = this.ctx.pendingMixamoBaseAnimations;
        this.ctx.pendingMixamoBaseAnimations = [];

        await loadAnimationPack(anims);

        const idleOverrideId = this.ctx.mixamoStateOverrides.get(AnimationState.IDLE);
        if (idleOverrideId && !this.ctx.isPlayingCustomAnimation && !this.ctx.priorityAnimationPlaying) {
            this.ctx.currentState = AnimationState.IDLE;
            this.activateMixamoOverride(AnimationState.IDLE);
        }
    }

    /**
     * Load an animation pack at runtime. All entries MUST be Mixamo
     * (`source: 'mixamo'`) — the engine is Mixamo-only as of the
     * non-Mixamo-routes strip. Non-Mixamo entries are rejected with an error.
     */
    async loadAnimationPack(
        animations: BaseAnimationDefinition[],
        options?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean },
    ): Promise<void> {
        if (!this.ctx.loader) {
            console.warn('No loader available. Cannot load animation pack.');
            return;
        }

        if (!animations || animations.length === 0) {
            console.warn('No animations provided to loadAnimationPack');
            return;
        }

        const replaceLocomotion = options?.replaceLocomotion ?? false;

        const nonMixamo = animations.filter(a => a.source !== 'mixamo');
        if (nonMixamo.length > 0) {
            console.error(
                `AnimationOverrideSystem.loadAnimationPack: Mixamo-only contract violated. ` +
                `These entries are missing source: 'mixamo': ${nonMixamo.map(a => a.name).join(', ')}. ` +
                `Tag them as mixamo or regenerate against the canonical Mixamo skeleton.`,
            );
            return;
        }
        const mixamoAnimations = animations;

        if (replaceLocomotion) {
            this.idleSystem.idleAnimations = [];
            this.idleSystem.idleAnimationMetadata.clear();
        }

        // Load Mixamo animations via MixamoAnimationPlayer
        if (mixamoAnimations.length > 0) {
            const providerData = this.ctx.gameDataProvider?.();
            const scene = providerData?.scene ?? null;

            if (!scene || !this.ctx.character) {
                console.warn('Cannot load Mixamo animations: scene or character not available.');
            } else if (this.ctx.loader) {
                const { MixamoAnimationPlayer } = await import('engine/MixamoAnimationPlayer.js');
                const loaderRef = this.ctx.loader as { loadAsync: (url: string) => Promise<CachedGLTF> };

                // Fetch all animation GLBs concurrently (bounded — mobile gets a
                // lower cap), then BUILD/REGISTER them in array order below. The
                // ordered second pass keeps the first-wins RUN/WALK override logic
                // (SlowRun before FastRun) independent of which download finishes
                // first. cachedGLTFLoad dedups by URL, so shared clips fetch once.
                const loaded = await mapWithConcurrency(
                    mixamoAnimations,
                    activeQualityPolicy().deferred.loadConcurrency,
                    async (animDef): Promise<{ animDef: BaseAnimationDefinition; gltf: CachedGLTF | null }> => {
                        try {
                            return { animDef, gltf: await cachedGLTFLoad(loaderRef, animDef.animationUrl) };
                        } catch (error) {
                            console.error(`Failed to load Mixamo animation "${animDef.name}":`, error);
                            return { animDef, gltf: null };
                        }
                    },
                );

                for (const { animDef, gltf } of loaded) {
                    if (!gltf) continue;
                    const player = new MixamoAnimationPlayer();
                    const success = player.loadFromGLTF(
                        gltf.scene,
                        gltf.animations,
                        scene,
                        this.ctx.character,
                        this.ctx.characterHeight,
                        { retainFullSkeleton: this.ctx.retainFullSkeleton }
                    );
                    if (success) {
                        player.setAnimationName(animDef.motionId);
                        if (animDef.designSpeed) {
                            player.setDesignSpeed(animDef.designSpeed);
                        }
                        this.ctx.mixamoAnimationPlayers.set(animDef.motionId, player);

                        const nameLower = animDef.name.toLowerCase();
                        // First-wins for RUN: packs typically ship SlowRun
                        // (designSpeed 3.5) before FastRun (5.0). For NPCs
                        // moving below 5 m/s, SlowRun-at-≤1x reads more
                        // naturally than FastRun-at-≤0.5x, so we keep
                        // whichever ran first instead of overwriting.
                        if (options?.addToAttackCollection && (nameLower.startsWith('attack') || nameLower.startsWith('kick') || nameLower.startsWith('punch') || nameLower.includes('strike') || nameLower.includes('melee'))) {
                            this.ctx.mixamoStateOverrides.set(AnimationState.ATTACK, animDef.motionId);
                        } else if (nameLower.includes('idle')) {
                            this.setAnimationOverride(AnimationState.IDLE, animDef.motionId);
                        } else if (nameLower.includes('walk') && !nameLower.includes('run')) {
                            if (!this.ctx.mixamoStateOverrides.has(AnimationState.WALK)) {
                                this.setAnimationOverride(AnimationState.WALK, animDef.motionId);
                            }
                        } else if (nameLower.includes('run')) {
                            if (!this.ctx.mixamoStateOverrides.has(AnimationState.RUN)) {
                                this.setAnimationOverride(AnimationState.RUN, animDef.motionId);
                            }
                        } else if (nameLower.includes('jump')) {
                            this.setAnimationOverride(AnimationState.JUMP, animDef.motionId);
                        }
                    }
                }

                // Build an isolated composite only after a COMPLETE set has
                // arrived. Missing clips leave the legacy fallback intact.
                for (const style of ['neutral', 'rifle'] as const) {
                    const id = DIRECTIONAL_BLEND_IDS[style];
                    if (this.ctx.mixamoAnimationPlayers.has(id)) continue;
                    const sources = LOCOMOTION_DIRECTIONS.map(direction => loaded.find(entry =>
                        entry.animDef.motionId === capturedDirectionId(style, direction))?.gltf);
                    if (sources.some(source => !source)) continue;
                    const composite = new DirectionalLocomotionPlayer();
                    const samplers: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer[] = [];
                    let success = true;
                    for (const source of sources) {
                        const sampler = new MixamoAnimationPlayer();
                        samplers.push(sampler);
                        success = sampler.loadFromGLTF(source!.scene, source!.animations, scene,
                            this.ctx.character, this.ctx.characterHeight, { retainFullSkeleton: this.ctx.retainFullSkeleton }) && success;
                    }
                    const forward = sources[0]!;
                    success = composite.loadFromGLTF(forward.scene, forward.animations, scene,
                        this.ctx.character, this.ctx.characterHeight, { retainFullSkeleton: this.ctx.retainFullSkeleton }) && success;
                    if (!success) { samplers.forEach(player => player.dispose()); composite.dispose(); continue; }
                    composite.setAnimationName(id);
                    composite.configure(samplers);
                    this.ctx.mixamoAnimationPlayers.set(id, composite);
                }
            }
        }

        // Idle animations are registered above via mixamoStateOverrides — the
        // standard-mixer `idleSystem.idleAnimations[]` array is empty now and
        // will be removed when IdleAnimationSystem goes full Mixamo (next
        // stage of the strip).

        // A pack that arrives AFTER a posture or direction was set changes
        // what the current state should be playing (a crouch requested before
        // the posture pack loaded is still on the standing idle). Re-resolve
        // now, so the swap happens on arrival instead of on the next state
        // change — otherwise the first crouch of a session stays standing
        // until the player moves and stops.
        const cur = this.ctx.currentState;
        if ((cur === AnimationState.IDLE || cur === AnimationState.WALK || cur === AnimationState.RUN)
            && !this.ctx.isAttacking && !this.ctx.isPlayingCustomAnimation) {
            const wanted = resolveLocomotionMotionId(this.ctx, cur);
            const wantedPlayer = wanted ? this.ctx.mixamoAnimationPlayers.get(wanted) : undefined;
            if (wantedPlayer && wantedPlayer !== this.ctx.trackAMixamoPlayer) {
                this.activateMixamoOverride(cur);
            }
        }
    }

    dispose(): void {
        this.ctx.stateOverrides.clear();
        this.ctx.mixamoStateOverrides.clear();
    }
}

/**
 * The motionId a locomotion state should ACTUALLY play, given which way the
 * character is travelling relative to its facing.
 *
 * Postures take priority. An enabled, complete captured set replaces built-in
 * standing RUN with one eight-way composite. Explicit custom runs keep the
 * legacy routing. Otherwise forward/non-locomotion uses the state override;
 * the other buckets use loaded procedural directional clips. Missing packs
 * fall back to the forward clip. Only the legacy fallback shares its slower
 * strafes between WALK and RUN.
 */
export function resolveLocomotionMotionId(
    ctx: AnimationContext,
    state: AnimationState,
): string | undefined {
    const base = ctx.mixamoStateOverrides.get(state);

    // Posture first: a crouched character's IDLE is the crouch hold and its
    // WALK/RUN the crouch step, whatever direction it moves (the directional
    // clips are standing-only). A posture with no move clip (sit, kneel)
    // freezes locomotion to the hold — a seated character does not walk. All
    // of it gated on the players being loaded, else the standing clip.
    if (ctx.posture !== 'stand') {
        const set = (POSTURE_MOVES as Record<string, { hold: string; move?: string }>)[ctx.posture];
        if (set) {
            const wanted = state === AnimationState.IDLE ? set.hold
                : (state === AnimationState.WALK || state === AnimationState.RUN) ? (set.move ?? set.hold)
                : undefined;
            if (wanted && ctx.mixamoAnimationPlayers.has(wanted)) return wanted;
        }
    }

    if (state !== AnimationState.WALK && state !== AnimationState.RUN) return base;
    // Standing RUN only. The pack is opt-in; walking, postures, jumps and
    // characters without it retain the established behavior. An unloaded
    // posture must not accidentally route into a standing capture.
    if (state === AnimationState.RUN && ctx.directionalLocomotionEnabled !== false
        && (!base || BUILTIN_RUN_IDS.has(base)) && (!ctx.posture || ctx.posture === 'stand')) {
        const blend = DIRECTIONAL_BLEND_IDS[ctx.directionalLocomotionStyle ?? 'neutral'];
        if (ctx.mixamoAnimationPlayers.has(blend)) return blend;
    }
    const bucket = ctx.locomotionDirection;
    if (bucket === 'forward') return base;
    const directional = bucket === 'back'
        ? (state === AnimationState.RUN ? DIRECTIONAL_MOVES.backpedalFast : DIRECTIONAL_MOVES.backpedal)
        : bucket === 'left' ? DIRECTIONAL_MOVES.strafeLeft : DIRECTIONAL_MOVES.strafeRight;
    return ctx.mixamoAnimationPlayers.has(directional) ? directional : base;
}
