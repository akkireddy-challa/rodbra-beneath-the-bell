import * as THREE from 'three';
import { ProceduralPoseLayers, type ProceduralPoseLayer } from 'engine/animation/ProceduralPoseLayers.js';
import type { BaseAnimationDefinition, CustomAttackMove } from 'types/game.js';
import type { AttackResult } from 'engine/ICharacterAnimationController.js';
import type { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import {
    findRootMotionBone,
    suppressThreeJSWarnings,
} from 'engine/AnimationClipUtils.js';
import {
    type AnimationContext,
    AnimationState,
    type CharacterAnimationConfig,
    crossFadeToAction,
    keepCurrentActionAlive,
    ensureMixerWeightCovered,
} from 'engine/animation/AnimationContext.js';
import { IdleAnimationSystem } from 'engine/animation/IdleAnimationSystem.js';
import { AttackAnimationSystem } from 'engine/animation/AttackAnimationSystem.js';
import { CustomAnimationSystem } from 'engine/animation/CustomAnimationSystem.js';
import { AnimationOverrideSystem, resolveLocomotionMotionId } from 'engine/animation/AnimationOverrideSystem.js';
import { collectLocomotionOverrides } from 'engine/animation/locomotionOverrides.js';
import { DIRECTIONAL_MOVES } from 'engine/AnimationPacks.js';
import { ActionLayerSystem } from 'engine/animation/ActionLayerSystem.js';
import { PriorityAnimationSystem } from 'engine/animation/PriorityAnimationSystem.js';
import { DirectionalLocomotionPlayer } from 'engine/animation/DirectionalLocomotionPlayer.js';
import type { DirectionalLocomotionStyle } from 'engine/animation/DirectionalLocomotion.js';

// Re-export for backward compatibility
export { AnimationState, type CharacterAnimationConfig } from 'engine/animation/AnimationContext.js';

interface MixamoPlayOptions {
    fadeInDuration?: number;
    fadeOutDuration?: number;
    speed?: number;
    interruptOnMovement?: boolean;
    splitBodyOnRun?: boolean;
    filterRootMotion?: boolean;
    onFinished?: () => void;
}

/**
 * Hysteresis half-width (m/s) around walkToRunThreshold so a noisy speed signal
 * can't flicker walk↔run during accel/decel: switch up to RUN only above
 * threshold + band, and drop back to WALK only below threshold − band.
 */
const WALK_RUN_HYSTERESIS = 0.4;

/**
 * Character Animation Controller - Skeleton Animator
 *
 * Delegates to focused subsystems for each animation concern:
 * - IdleAnimationSystem: idle cycling, hand-attachment filtering
 * - AttackAnimationSystem: attack animations, custom attack moves
 * - CustomAnimationSystem: custom animation loading/playback (standard + Mixamo)
 * - AnimationOverrideSystem: locomotion state overrides, animation packs
 * - ActionLayerSystem: action layer on cloned skeleton
 * - PriorityAnimationSystem: priority animations that lock out movement
 */
export class CharacterAnimationController {
    /**
     * Ceiling on strafe playback (clip design speed 2.2 m/s → about 3 m/s of
     * honest lateral movement), roughly where a real side-step tops out.
     */
    private static readonly MAX_STRAFE_PLAYBACK_RATE = 1.35;

    // Shared mutable context accessible to all subsystems
    private readonly ctx: AnimationContext;

    // Subsystems
    private readonly idleSystem: IdleAnimationSystem;
    private readonly attackSystem: AttackAnimationSystem;
    private readonly customSystem: CustomAnimationSystem;
    private readonly overrideSystem: AnimationOverrideSystem;
    private readonly actionSystem: ActionLayerSystem;
    private readonly prioritySystem: PriorityAnimationSystem;

    // Last walk/run/idle/jump locomotion decision. Drives walk↔run hysteresis
    // independently of currentState, which can be ATTACK during a split-body
    // swing while the legs still follow locomotion.
    private lastLocomotionState: AnimationState = AnimationState.IDLE;

    constructor(config: CharacterAnimationConfig = {}) {
        this.ctx = {
            mixer: null,
            character: null,
            config: {
                idleAnimationName: 'idle',
                walkAnimationName: 'walk',
                runAnimationName: 'run',
                jumpAnimationName: 'jump',
                runSpeed: 5.0,
                walkToRunThreshold: 3.0,
                transitionDuration: 0.35,
                ...config
            },
            loader: null,
            isInitialized: false,
            currentAction: null,
            currentState: AnimationState.IDLE,
            previousState: AnimationState.IDLE,
            animations: new Map(),
            nativeSpeedByState: new Map(),
            locomotionDirection: 'forward',
            playingLocomotionBucket: 'forward',
            posture: 'stand',
            playingPosture: 'stand',
            rootMotionBone: null,
            rootMotionTargets: [],
            isJumping: false,
            jumpStartTime: 0,
            jumpDuration: 1.0,
            isAttacking: false,
            attackStartTime: 0,
            isPlayingCustomAnimation: false,
            customAnimationHeld: false,
            customAnimationInterruptOnMovement: false,
            customAnimationSplitOnMove: false,
            customAnimationSplitApplied: false,
            currentCustomMotionId: null,
            priorityAnimationPlaying: false,
            trackAMixamoPlayer: null,
            trackBMixamoPlayer: null,
            fadingOutTrackAPlayer: null,
            fadingOutCrossfadeProgress: 0,
            fadingOutCrossfadeDuration: 0.3,
            mixamoAnimationPlayers: new Map(),
            stateOverrides: new Map(),
            mixamoStateOverrides: new Map(),
            pendingMixamoBaseAnimations: [],
            trackBlend: null,
            attackResumeState: null,
            attackTrackAState: null,
            customAnimations: new Map(),
            characterHeight: 1.75,
            retainFullSkeleton: false,
            gameDataProvider: null,
        };

        const playAnimationBound = (state: AnimationState) => this.playAnimation(state);
        const playMixamoAnimationBound = (
            motionId: string,
            player: MixamoAnimationPlayer,
            options?: MixamoPlayOptions,
        ) => this.customSystem.playMixamoAnimation(motionId, player, options);

        this.idleSystem = new IdleAnimationSystem(this.ctx);
        this.attackSystem = new AttackAnimationSystem(this.ctx, playAnimationBound, playMixamoAnimationBound);
        this.customSystem = new CustomAnimationSystem(this.ctx, playAnimationBound);
        this.overrideSystem = new AnimationOverrideSystem(this.ctx, this.idleSystem, this.attackSystem);
        this.actionSystem = new ActionLayerSystem(this.ctx);
        this.prioritySystem = new PriorityAnimationSystem(this.ctx, playAnimationBound, playMixamoAnimationBound);
    }

    // ── Initialization ──────────────────────────────────────────────────

    async initializeWithCharacter(
        character: THREE.Object3D,
        gltf: any,
        loader: any,
        baseAnimations: BaseAnimationDefinition[],
        gameDataProvider?: () => { assets?: unknown[]; scene?: THREE.Scene | null } | null
    ): Promise<void> {
        this.ctx.character = character;
        suppressThreeJSWarnings();
        this.ctx.loader = loader || null;

        if (!gltf) {
            console.error('CharacterAnimationController: No GLTF data provided');
            return;
        }

        this.ctx.mixer = new THREE.AnimationMixer(character);
        this.actionSystem.initActionLayer(character);

        // Note: no 'finished' listener is installed on ctx.mixer under the
        // Mixamo-only contract. Idle cycling for the standard-mixer hatch
        // (`IdleAnimationSystem.setIdleAnimations`) uses preemptive crossfade
        // in its own update loop, not mixer 'finished' events. Mixamo-based
        // attacks/idles signal completion via their player's `onFinished`
        // callback (see AttackAnimationSystem, MixamoAnimationPlayer).

        this.ctx.rootMotionBone = findRootMotionBone(character);

        // Mixamo-only contract: every baseAnimation must declare `source: 'mixamo'`.
        // The standard-mixer code path was removed once the engine-shipped CORE
        // animations went 100% Mixamo (see game/CLAUDE.md → "Character animation").
        // Templates that need an unprefixed-rig clip should run it through Uthana
        // against the canonical Mixamo skeleton first (`tools/extract-mixamo-skeleton.mjs`).
        const nonMixamo = baseAnimations.filter(a => a.source !== 'mixamo');
        if (nonMixamo.length > 0) {
            console.error(
                `CharacterAnimationController: Mixamo-only contract violated. ` +
                `These baseAnimations are missing source: 'mixamo': ${nonMixamo.map(a => a.name).join(', ')}. ` +
                `Tag them as mixamo or regenerate against the canonical Mixamo skeleton.`,
            );
            return;
        }
        this.ctx.pendingMixamoBaseAnimations = baseAnimations;

        this.ctx.isInitialized = true;

        // Don't auto-play IDLE here — there are no standard-mixer actions to
        // fall back to. The Mixamo idle override gets installed by
        // loadDeferredMixamoAnimations below and that function plays it once
        // the override is registered.

        if (gameDataProvider) {
            this.setGameDataProvider(gameDataProvider);
            await this.loadDeferredMixamoAnimations();
        }
    }

    poseCharacterAtFirstIdleFrame(): boolean {
        return this.idleSystem.poseCharacterAtFirstIdleFrame();
    }

    // ── State Machine ───────────────────────────────────────────────────

    updateAnimation(
        isMoving: boolean,
        movementSpeed: number,
        isGrounded: boolean,
        isJumpPressed: boolean,
        // True only when the player is actively requesting movement (input), as
        // opposed to merely having velocity. Drives interrupt-on-movement so a
        // one-shot move that commits its own root motion (e.g. a kick stepping
        // into the ball) isn't cancelled by its own forward slide. Falls back to
        // `isMoving` for callers (NPCs, remote, 2D) that don't distinguish.
        hasMovementInput: boolean = isMoving,
    ): void {
        this.poseGrounded = isGrounded && !isJumpPressed;
        if (!this.ctx.mixer || !this.ctx.isInitialized) return;

        // Interrupt-on-movement: cancel a running one-shot custom animation
        // (e.g. soccer kick) the moment the player starts moving so locomotion
        // takes over. Set per-call via playCustomAnimation({ interruptOnMovement: true }).
        if (this.ctx.isPlayingCustomAnimation
            && this.ctx.customAnimationInterruptOnMovement
            && hasMovementInput) {
            this.customSystem.stopCustomAnimation();
            // If the custom anim was an attack, end it cleanly so isAttacking
            // clears and locomotion can resume on the same frame.
            this.attackSystem.endAttack();
            // stopCustomAnimation calls playAnimation(currentState) — fall through
            // so this frame still runs the locomotion update for the new pose.
        }

        // Hand the legs back the moment the character moves. A fire clip (or any
        // `splitBodyOnRun` custom animation) that began from a standstill plays full-body and
        // blocks this whole update — which is also what keeps `currentState` stuck at idle, so
        // the clip can never re-decide for itself. Checked here, against live movement input,
        // before the early return that would otherwise freeze the walk cycle mid-stride.
        if (this.ctx.isPlayingCustomAnimation
            && this.ctx.customAnimationSplitOnMove
            && !this.ctx.trackBlend
            && (hasMovementInput || isMoving)) {
            this.ctx.trackBlend = { upperBody: 1, lowerBody: 0 };
            this.ctx.customAnimationSplitApplied = true;
            this.ctx.customAnimationSplitOnMove = false;
        }

        if (this.ctx.isPlayingCustomAnimation && !this.ctx.trackBlend) return;
        if (this.ctx.priorityAnimationPlaying) return;

        const currentTime = Date.now() / 1000;

        if (isJumpPressed && isGrounded && !this.ctx.isJumping) {
            this.ctx.isJumping = true;
            this.ctx.jumpStartTime = currentTime;
            this.playAnimation(AnimationState.JUMP);
        }

        if (this.ctx.isJumping && isGrounded) {
            this.ctx.isJumping = false;
            const jumpAction = this.ctx.animations.get(AnimationState.JUMP);
            if (jumpAction) { jumpAction.reset(); jumpAction.stop(); }
        }

        // Walk vs run: pick WALK below the threshold if a walk animation
        // exists for this character, otherwise fall through to RUN. Same
        // resolution for Mixamo state overrides — a pack may supply only one
        // or the other.
        const hasWalk = this.ctx.animations.has(AnimationState.WALK)
            || this.ctx.stateOverrides.has(AnimationState.WALK)
            || this.ctx.mixamoStateOverrides.has(AnimationState.WALK);
        const hasRun = this.ctx.animations.has(AnimationState.RUN)
            || this.ctx.stateOverrides.has(AnimationState.RUN)
            || this.ctx.mixamoStateOverrides.has(AnimationState.RUN);
        const walkThreshold = this.ctx.config.walkToRunThreshold ?? 3.0;

        // Locomotion target (independent of attack). When attacking, currentState
        // stays ATTACK but we still want trackA to follow movement so the legs
        // (driven by trackBlend.lowerBody = 0 in WeaponMeleeSystem) animate the
        // actual run/walk/idle/jump pose instead of freezing on whatever was
        // active when the swing started.
        let locomotionState: AnimationState;
        if (!isGrounded || this.ctx.isJumping) {
            locomotionState = AnimationState.JUMP;
        } else if (!isMoving) {
            locomotionState = AnimationState.IDLE;
        } else if (!hasWalk) {
            locomotionState = AnimationState.RUN;    // no walk clip → always run
        } else if (!hasRun) {
            locomotionState = AnimationState.WALK;   // no run clip → always walk
        } else {
            // Both clips present: hysteresis around walkThreshold, biased toward
            // the state we're already in so a speed hovering on the threshold
            // (e.g. while decelerating) can't flicker walk↔run frame to frame.
            const runCutoff = this.lastLocomotionState === AnimationState.RUN
                ? walkThreshold - WALK_RUN_HYSTERESIS
                : walkThreshold + WALK_RUN_HYSTERESIS;
            locomotionState = movementSpeed < runCutoff ? AnimationState.WALK : AnimationState.RUN;
        }
        this.lastLocomotionState = locomotionState;

        // Only drive trackA from locomotion when split-body is actually active
        // (upperBody > lowerBody). Without that gate, NPC/animal attacks —
        // which never set trackBlend — would unintentionally swap trackA mid-
        // swing, and CharacterLoader's "Mixamo overlay active" branch (which
        // uses a uniform trackB weight) would then bleed locomotion into the
        // swing's upper body too.
        const splitBodyActive = !!this.ctx.trackBlend
            && this.ctx.trackBlend.upperBody > this.ctx.trackBlend.lowerBody;

        if (this.ctx.isAttacking && splitBodyActive) {
            // Drive trackA from locomotion during the swing so the legs animate
            // the player's actual movement. We deliberately don't go through
            // playAnimation() — that would clobber currentState (ATTACK) and
            // disrupt the attack lifecycle. activateMixamoOverride() alone
            // swaps trackA via the same crossfade machinery as normal locomotion
            // transitions; its same-player guard keeps the call cheap when
            // locomotion hasn't actually changed.
            //
            // Mixamo-only: when the locomotion state has no Mixamo override
            // (standard-mixer-only setups), the attack action shares the same
            // mixer as locomotion. Crossfading to a locomotion clip mid-swing
            // would fade out the attack action and break the swing — so we
            // skip the swap and the standard mixer plays the attack
            // uninterrupted.
            this.ctx.attackResumeState = locomotionState;
            if (locomotionState !== this.ctx.attackTrackAState) {
                if (this.ctx.mixamoStateOverrides.has(locomotionState)) {
                    this.overrideSystem.activateMixamoOverride(locomotionState);
                }
                this.ctx.attackTrackAState = locomotionState;
            }
        } else if (!this.ctx.isAttacking) {
            if (locomotionState !== this.ctx.currentState) {
                this.playAnimation(locomotionState);
            } else if (
                (locomotionState === AnimationState.WALK || locomotionState === AnimationState.RUN)
                && this.ctx.playingLocomotionBucket !== this.ctx.locomotionDirection
            ) {
                // Same state, new travel direction: crossfade to the clip for
                // the new bucket (playAnimation resolves it). Stamp the bucket
                // even when the directional clip isn't loaded and the resolver
                // fell back to the forward clip — otherwise this branch would
                // re-fire every frame for a character without the pack.
                this.playAnimation(locomotionState);
                this.ctx.playingLocomotionBucket = this.ctx.locomotionDirection;
            } else if (
                this.ctx.playingPosture !== this.ctx.posture
                && (locomotionState === AnimationState.IDLE
                    || locomotionState === AnimationState.WALK
                    || locomotionState === AnimationState.RUN)
            ) {
                // Same state, new posture (stand→crouch etc.): the hold/move
                // clip for the posture takes over. Same stamping rule. Gated
                // to the states the resolver actually swaps — in JUMP a
                // posture toggle would otherwise replay the finished jump.
                this.playAnimation(locomotionState);
                this.ctx.playingPosture = this.ctx.posture;
            }
            this.ctx.attackResumeState = null;
            this.ctx.attackTrackAState = null;
        }

        // Direction/style may change while an upper-body action owns the state
        // machine. Resolve Track A independently without restarting that action.
        if (!this.ctx.isAttacking || splitBodyActive) {
            const wanted = resolveLocomotionMotionId(this.ctx, locomotionState);
            if (wanted && this.ctx.mixamoAnimationPlayers.get(wanted) !== this.ctx.trackAMixamoPlayer) {
                this.overrideSystem.activateMixamoOverride(locomotionState);
            }
        }
        if (this.ctx.trackAMixamoPlayer instanceof DirectionalLocomotionPlayer) {
            this.ctx.trackAMixamoPlayer.setDirection(this.ctx.locomotionAngle ?? 0);
        }

        // Speed-match against the effective locomotion state. During a split-
        // body attack, currentState is ATTACK but trackA holds the locomotion
        // clip — use locomotionState so it scales to actual movement speed.
        // For non-split-body attacks (NPC/animal), trackA isn't following
        // movement; fall back to currentState so the attack animation gets
        // timeScale=1 via the else branch.
        const speedState = (this.ctx.isAttacking && splitBodyActive)
            ? locomotionState
            : this.ctx.currentState;
        if (speedState === AnimationState.RUN || speedState === AnimationState.WALK) {
            if (this.ctx.trackAMixamoPlayer && this.ctx.mixamoStateOverrides.has(speedState)) {
                const nativeSpeed = this.ctx.trackAMixamoPlayer.getNativeLocomotionSpeed();
                if (nativeSpeed > 0) {
                    // Cap 3x, not 2x: this branch is override clips only, and
                    // custom locomotion (a 0.8 m/s zombie shuffle on a 2 m/s
                    // chaser) legitimately needs more headroom than the
                    // built-ins, whose native speeds sit close to actual
                    // movement. Above the cap feet slide — that residue means
                    // the clip and the character's moveSpeed genuinely
                    // disagree and one of them should change.
                    //
                    // STRAFES get a much tighter cap. A side-step cannot
                    // lengthen the way a run can (the stride is limited by how
                    // far a leg crosses sideways, measured: past ~68 cm per
                    // step the plant skates), so cadence is the only thing
                    // left to absorb speed — and games happily strafe at full
                    // run speed, which no human does. Unbounded, the legs
                    // blur; the character reads as panicking rather than
                    // moving. Past the cap the feet slide instead, which is
                    // the quieter of the two lies.
                    // Keyed on the CLIP that resolved, not the direction
                    // bucket: a crouched cover-shooter strafing plays the
                    // crouch step (which can absorb speed), not a strafe.
                    const resolvedId = resolveLocomotionMotionId(this.ctx, speedState);
                    const isStrafeClip = resolvedId === DIRECTIONAL_MOVES.strafeLeft
                        || resolvedId === DIRECTIONAL_MOVES.strafeRight;
                    const cap = isStrafeClip ? CharacterAnimationController.MAX_STRAFE_PLAYBACK_RATE : 3.0;
                    this.ctx.trackAMixamoPlayer.setSpeed(Math.max(0.1, Math.min(movementSpeed / nativeSpeed, cap)));
                }
            } else {
                const action = this.ctx.stateOverrides.get(speedState) || this.ctx.animations.get(speedState);
                if (action) {
                    const native = this.ctx.nativeSpeedByState.get(speedState) || 0;
                    const nativeInMeters = native > 50 ? native * 0.01 : native;
                    action.timeScale = nativeInMeters > 0 ? Math.max(0.1, Math.min(movementSpeed / nativeInMeters, 2.0)) : 1.0;
                }
            }
        } else {
            const action = this.ctx.animations.get(speedState);
            if (action) action.timeScale = 1;
        }
    }

    private poseDeltaSeconds = 1 / 60;
    private poseGrounded = true;
    private readonly proceduralPoseLayers = new ProceduralPoseLayers();
    getPoseGrounded(): boolean { return this.poseGrounded; }
    getProceduralPoseLayers(): ProceduralPoseLayers { return this.proceduralPoseLayers; }
    setProceduralPoseLayer(name: string, spec: ProceduralPoseLayer): void { this.proceduralPoseLayers.set(name, spec); }
    updateProceduralPoseLayer(name: string, rotations: ReadonlyMap<string, THREE.Quaternion>): boolean {
        return this.proceduralPoseLayers.updateTargets(name, rotations);
    }
    removeProceduralPoseLayer(name: string): void { this.proceduralPoseLayers.remove(name); }
    getPoseDeltaSeconds(): number { return this.poseDeltaSeconds; }

    update(deltaTime: number): void {
        deltaTime = Number.isFinite(deltaTime) ? Math.max(0, Math.min(deltaTime, 0.1)) : 0;
        this.poseDeltaSeconds = deltaTime;
        this.proceduralPoseLayers.update(deltaTime);
        if (this.ctx.mixer) this.ctx.mixer.update(deltaTime);
        // Per-frame guarantee that the mixer's cumulative weight is >= 1 so
        // PropertyMixer never blends in the bind pose (T-pose). Boosts
        // currentAction if any prior transition left a weight deficit.
        ensureMixerWeightCovered(this.ctx);
        this.actionSystem.update(deltaTime);

        if (this.ctx.trackAMixamoPlayer) this.ctx.trackAMixamoPlayer.update(deltaTime);
        if (this.ctx.trackBMixamoPlayer && this.ctx.trackBMixamoPlayer !== this.ctx.trackAMixamoPlayer) {
            this.ctx.trackBMixamoPlayer.update(deltaTime);
        }
        this.customSystem.updatePendingImpact();

        if (this.ctx.fadingOutTrackAPlayer) {
            this.ctx.fadingOutTrackAPlayer.update(deltaTime);
            this.ctx.fadingOutCrossfadeProgress += deltaTime / this.ctx.fadingOutCrossfadeDuration;
            if (this.ctx.fadingOutCrossfadeProgress >= 1) {
                this.ctx.fadingOutCrossfadeProgress = 1;
                this.ctx.fadingOutTrackAPlayer.stop();
                this.ctx.fadingOutTrackAPlayer = null;
            }
        }

        this.idleSystem.update(deltaTime);
    }

    private playAnimation(state: AnimationState): void {
        if (this.ctx.isPlayingCustomAnimation && this.ctx.trackBlend) {
            const standardAction = this.ctx.stateOverrides.get(state) || this.ctx.animations.get(state);
            if (standardAction) {
                crossFadeToAction(this.ctx, standardAction, this.ctx.config.transitionDuration!);
            } else if (state === AnimationState.IDLE && this.idleSystem.idleAnimations.length > 0) {
                this.idleSystem.playIdleAnimation();
            } else {
                // No replacement action — keep whatever is currently playing
                // looping at full weight rather than letting the skeleton fall
                // to bind pose.
                keepCurrentActionAlive(this.ctx);
            }
            this.ctx.previousState = this.ctx.currentState;
            this.ctx.currentState = state;
            return;
        }

        const mixamoOverrideId = resolveLocomotionMotionId(this.ctx, state);
        // One owner for A→A handoffs: activateMixamoOverride needs the outgoing
        // player still installed to phase-match its contact and reverse safely.
        // Only transitions OUT of the Mixamo path stop it here.
        if (!mixamoOverrideId && this.ctx.trackAMixamoPlayer && state !== this.ctx.currentState) {
            this.ctx.trackAMixamoPlayer.stop();
            this.ctx.trackAMixamoPlayer = null;
        }
        if (mixamoOverrideId) {
            this.overrideSystem.activateMixamoOverride(state);
        } else if (this.ctx.stateOverrides.has(state)) {
            crossFadeToAction(this.ctx, this.ctx.stateOverrides.get(state)!, this.ctx.config.transitionDuration!);
        } else if (state === AnimationState.IDLE && this.idleSystem.idleAnimations.length > 0) {
            this.idleSystem.playIdleAnimation();
        } else {
            const newAction = this.ctx.animations.get(state);
            if (!newAction) {
                // No target animation for this state — fall back to looping
                // whatever is playing now so the skeleton never reaches bind pose.
                keepCurrentActionAlive(this.ctx);
                this.ctx.previousState = this.ctx.currentState;
                this.ctx.currentState = state;
                return;
            }
            crossFadeToAction(this.ctx, newAction, this.ctx.config.transitionDuration!);
        }

        this.ctx.previousState = this.ctx.currentState;
        this.ctx.currentState = state;
    }

    /**
     * Which way the character is travelling relative to its FACING, as a
     * character-local vector: +Z forward, +X left (the gameplay convention).
     * Call every frame while moving — PlayerController feeds it from the
     * body's velocity — and the WALK/RUN states swap between the forward,
     * backpedal and strafe clips when the directional pack is loaded
     * (see resolveLocomotionMotionId; without the pack this is inert).
     *
     * Buckets carry ±10° of hysteresis so a diagonal can't flicker between
     * two clips, and a near-zero vector keeps the previous direction — the
     * decision belongs to the last frames that were actually moving.
     */
    /**
     * Body posture ('stand' | 'crouch' | 'prone' | 'sit' | 'kneel' | 'swim' |
     * 'climb'). Swaps IDLE to the posture's hold and WALK/RUN to its move
     * clip when the posture pack is loaded (see resolveLocomotionMotionId);
     * inert otherwise. Physics (capsule height, speed) is PlayerController's
     * business — see PlayerController.setPosture, which calls this.
     */
    setPosture(posture: string): void {
        this.ctx.posture = posture;
    }

    getPosture(): string { return this.ctx.posture; }

    setLocomotionDirection(localX: number, localZ: number): void {
        if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return;
        if (Math.hypot(localX, localZ) < 0.15) return;
        this.ctx.locomotionAngle = Math.atan2(localX, localZ);
        const prev = this.ctx.locomotionDirection;
        const deg = Math.abs(Math.atan2(localX, localZ)) * (180 / Math.PI);
        const forwardEdge = prev === 'forward' ? 55 : 45;
        const backEdge = prev === 'back' ? 125 : 135;
        this.ctx.locomotionDirection =
            deg <= forwardEdge ? 'forward'
            : deg >= backEdge ? 'back'
            : localX > 0 ? 'left' : 'right';
    }

    /** Select captured running stance; posture and action layers keep priority. */
    setDirectionalLocomotionStyle(style: DirectionalLocomotionStyle): void {
        this.ctx.directionalLocomotionStyle = style;
    }
    setDirectionalLocomotionEnabled(enabled: boolean): void {
        this.ctx.directionalLocomotionEnabled = enabled;
    }

    // ── State Getters ───────────────────────────────────────────────────

    getCurrentState(): AnimationState { return this.ctx.currentState; }
    getIsJumping(): boolean { return this.ctx.isJumping; }
    getMixer(): THREE.AnimationMixer | null { return this.ctx.mixer; }
    getIsAttacking(): boolean { return this.ctx.isAttacking; }

    getIsPlayingCustomAnimation(): boolean { return this.ctx.isPlayingCustomAnimation; }

    // ── Idle Delegation ─────────────────────────────────────────────────

    setHasObjectAttachedToHandCallback(callback: (() => boolean) | null): void {
        this.idleSystem.setHasObjectAttachedToHandCallback(callback);
    }

    async setIdleAnimations(motionIds: string[]): Promise<void> {
        return this.idleSystem.setIdleAnimations(motionIds);
    }

    // ── Attack Delegation ───────────────────────────────────────────────

    startAttack(): AttackResult { return this.attackSystem.startAttack(); }
    endAttack(): void { this.attackSystem.endAttack(); }
    hasAttackAnimations(): boolean { return this.attackSystem.hasAttackAnimations(); }
    registerCustomAttack(move: CustomAttackMove): boolean { return this.attackSystem.registerCustomAttack(move); }

    unregisterCustomAttack(name: string): boolean { return this.attackSystem.unregisterCustomAttack(name); }
    getRegisteredAttackMoves(): string[] { return this.attackSystem.getRegisteredAttackMoves(); }
    getAttackMoveConfig(moveName: string): CustomAttackMove | null { return this.attackSystem.getAttackMoveConfig(moveName); }
    startNamedAttack(moveName: string): AttackResult { return this.attackSystem.startNamedAttack(moveName); }

    /**
     * Listen for the start of ANY attack animation — random, named, or the
     * ATTACK state override. Used by WeaponMeleeSystem to sound the swing.
     *
     * Registered on the animation layer on purpose: a swing can start from a
     * mouse click, from a template calling startNamedAttack, from an NPC, or
     * from a networked remote character, and all of them should sound.
     */
    setAttackStartedListener(
        listener: ((info: { moveName: string; duration: number }) => void) | null,
    ): void {
        this.attackSystem.onAttackStarted = listener;
    }

    /**
     * Engine-internal: reserved attack-started hook that user listeners cannot
     * clobber. Used by NpcController's strike hit registration. Do not call
     * from game/template code — use setAttackStartedListener.
     */
    setEngineAttackStartedListener(
        listener: ((info: { moveName: string; duration: number }) => void) | null,
    ): void {
        this.attackSystem.onAttackStartedEngine = listener;
    }

    async loadCustomAttackMoves(customMoves: CustomAttackMove[]): Promise<void> {
        return this.attackSystem.loadCustomAttackMoves(
            customMoves,
            (motionId, options) => this.customSystem.loadCustomAnimation(motionId, options),
        );
    }

    // ── Custom Animation Delegation ─────────────────────────────────────

    async loadCustomAnimation(
        motionId: string,
        options?: { normalizeRootMotion?: boolean; loop?: boolean },
    ): Promise<void> {
        return this.customSystem.loadCustomAnimation(motionId, options);
    }

    async loadAllAnimationAssets(options?: { normalizeRootMotion?: boolean; loop?: boolean }): Promise<void> {
        await this.customSystem.loadAllAnimationAssets(options);
        this.applyPersistedLocomotionOverrides();
    }

    /**
     * Honour `assets[].locomotionState` (see types/game.ts): a clip pinned to
     * idle/walk/run in world.json overrides that state without any template
     * code. Runs after every asset load so the clips it names are resolvable.
     */
    private applyPersistedLocomotionOverrides(): void {
        const assets = this.ctx.gameDataProvider?.()?.assets;
        if (!assets) return;
        for (const [state, motionId] of collectLocomotionOverrides(assets)) {
            if (!this.overrideSystem.setAnimationOverride(state, motionId)) {
                console.warn(`locomotionState: could not assign "${motionId}" to ${state}`);
            }
        }
    }

    playCustomAnimation(
        motionId: string,
        options?: {
            loop?: boolean;
            fadeInDuration?: number;
            fadeOutDuration?: number;
            speed?: number;
            onFinished?: () => void;
            applyRootMotion?: boolean;
            onRootMotionDisplacement?: (displacement: THREE.Vector3) => void;
            holdLastFrame?: boolean;
            filterRootMotion?: boolean;
            splitBodyOnRun?: boolean;
            interruptOnMovement?: boolean;
            onImpact?: () => void;
            impactTime?: number;
        }
    ): { success: boolean; duration: number } {
        return this.customSystem.playCustomAnimation(motionId, options);
    }

    isPlayingCustom(): boolean { return this.customSystem.isPlayingCustom(); }
    getCustomMotionId(): string | null { return this.customSystem.getCustomMotionId(); }
    getCustomAnimationProgress(): number { return this.customSystem.getCustomAnimationProgress(); }
    getAvailableCustomAnimations(): string[] { return this.customSystem.getAvailableCustomAnimations(); }
    stopCustomAnimation(): void { this.customSystem.stopCustomAnimation(); }
    setAnimationSpeed(speed: number): void { this.customSystem.setAnimationSpeed(speed); }
    getAnimationSpeed(): number { return this.customSystem.getAnimationSpeed(); }
    setAnimationTime(time: number): void { this.customSystem.setAnimationTime(time); }
    getAnimationTime(): number { return this.customSystem.getAnimationTime(); }

    // ── Mixamo Player Access ────────────────────────────────────────────

    getActiveMixamoPlayer(): MixamoAnimationPlayer | null {
        return this.ctx.trackBMixamoPlayer ?? this.ctx.trackAMixamoPlayer;
    }
    getTrackAMixamoPlayer(): MixamoAnimationPlayer | null {
        return this.ctx.trackAMixamoPlayer;
    }
    getTrackBMixamoPlayer(): MixamoAnimationPlayer | null {
        return this.ctx.trackBMixamoPlayer;
    }
    getAttackContactCheckPhases(fallback: readonly number[]): readonly number[] {
        return this.ctx.trackBMixamoPlayer?.getContactCheckPhases(fallback) ?? fallback;
    }
    getAttackPlaybackToken(): string {
        const player = this.ctx.trackBMixamoPlayer;
        return player ? `${player.getSkeletonRoot()?.uuid}:${player.getPlayRevision()}` : '';
    }
    getFadingOutTrackAPlayer(): MixamoAnimationPlayer | null {
        return this.ctx.fadingOutTrackAPlayer;
    }
    getFadingOutCrossfadeProgress(): number { return this.ctx.fadingOutCrossfadeProgress; }

    updateMixamoPlayer(deltaTime: number): void {
        if (this.ctx.trackAMixamoPlayer) this.ctx.trackAMixamoPlayer.update(deltaTime);
        if (this.ctx.trackBMixamoPlayer && this.ctx.trackBMixamoPlayer !== this.ctx.trackAMixamoPlayer) {
            this.ctx.trackBMixamoPlayer.update(deltaTime);
        }
    }

    // ── Override Delegation ─────────────────────────────────────────────

    setAnimationOverride(state: AnimationState, source: string): boolean {
        return this.overrideSystem.setAnimationOverride(state, source);
    }

    clearAnimationOverride(state: AnimationState): void {
        this.overrideSystem.clearAnimationOverride(state);
        if (this.ctx.currentState === state && !this.ctx.isPlayingCustomAnimation && !this.ctx.priorityAnimationPlaying) {
            this.playAnimation(state);
        }
    }

    clearAnimationOverrides(): void {
        this.overrideSystem.clearAnimationOverrides();
        if (!this.ctx.isPlayingCustomAnimation && !this.ctx.priorityAnimationPlaying) {
            this.playAnimation(this.ctx.currentState);
        }
    }

    getAnimationOverrides(): Map<string, string> { return this.overrideSystem.getAnimationOverrides(); }

    async loadDeferredMixamoAnimations(): Promise<void> {
        return this.overrideSystem.loadDeferredMixamoAnimations(
            (anims) => this.loadAnimationPack(anims),
        );
    }

    async loadAnimationPack(
        animations: BaseAnimationDefinition[],
        options?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean },
    ): Promise<void> {
        return this.overrideSystem.loadAnimationPack(animations, options);
    }

    // ── Action Layer Delegation ─────────────────────────────────────────

    playActionAnimation(
        clip: THREE.AnimationClip,
        options?: { loop?: boolean; blendIn?: number },
    ): { success: boolean; duration: number } {
        return this.actionSystem.playActionAnimation(clip, options);
    }

    playActionAnimationByMotionId(
        motionId: string,
        options?: { loop?: boolean; blendIn?: number },
    ): { success: boolean; duration: number } {
        return this.actionSystem.playActionAnimationByMotionId(motionId, options);
    }

    stopActionAnimation(fadeOut: number = 0.2): void { this.actionSystem.stopActionAnimation(fadeOut); }
    setActionBlend(weights: { upperBody: number; lowerBody: number }): void { this.actionSystem.setActionBlend(weights); }
    getActionBlend(): { upperBody: number; lowerBody: number } { return this.actionSystem.getActionBlend(); }
    isActionAnimationPlaying(): boolean { return this.actionSystem.isActionAnimationPlaying(); }
    getActionBoneMap(): Map<string, THREE.Bone> | null { return this.actionSystem.getActionBoneMap(); }
    getActionSkeletonRoot(): THREE.Object3D | null { return this.actionSystem.getActionSkeletonRoot(); }

    // ── Manual stance offsets (movement-system-driven posture) ──────────
    private manualBoneOffsets: Map<string, THREE.Quaternion> | null = null;
    setManualBoneOffsets(offsets: Map<string, THREE.Quaternion> | null): void { this.manualBoneOffsets = offsets; }
    getManualBoneOffsets(): Map<string, THREE.Quaternion> | null { return this.manualBoneOffsets; }

    private footIkTargets: import('engine/loaders/LegIK.js').LegIkTargets | null = null;
    setFootIkTargets(targets: import('engine/loaders/LegIK.js').LegIkTargets | null): void { this.footIkTargets = targets; }
    getFootIkTargets(): import('engine/loaders/LegIK.js').LegIkTargets | null { return this.footIkTargets; }

    // ── Priority Animation Delegation ───────────────────────────────────

    playPriorityAnimation(
        animationName: string,
        options?: {
            fadeInDuration?: number;
            fadeOutDuration?: number;
            speed?: number;
            loop?: boolean;
            onFinished?: () => void;
        }
    ): { success: boolean; duration: number } {
        return this.prioritySystem.playPriorityAnimation(animationName, options);
    }

    isPriorityAnimationPlaying(): boolean { return this.prioritySystem.isPriorityAnimationPlaying(); }

    // ── Body Blend ──────────────────────────────────────────────────────

    setCustomAnimationBodyBlend(blend: { upperBody: number; lowerBody: number } | null): void {
        this.ctx.trackBlend = blend
            ? {
                upperBody: THREE.MathUtils.clamp(blend.upperBody, 0, 1),
                lowerBody: THREE.MathUtils.clamp(blend.lowerBody, 0, 1),
            }
            : null;
    }

    getCustomAnimationBodyBlend(): { upperBody: number; lowerBody: number } | null {
        return this.ctx.trackBlend ? { ...this.ctx.trackBlend } : null;
    }

    // ── Configuration ───────────────────────────────────────────────────

    setCharacterHeight(height: number): void { this.ctx.characterHeight = height; }

    /**
     * Whether Mixamo players loaded from now on keep their full skeleton
     * (fingers, toes, end bones) instead of pruning to the block-character
     * parts. Must be set before initializeWithCharacter / loadAnimationPack:
     * players already loaded are not rebuilt.
     */
    setRetainFullSkeleton(retain: boolean): void { this.ctx.retainFullSkeleton = retain; }

    setGameDataProvider(provider: () => { assets?: unknown[]; scene?: THREE.Scene | null } | null): void {
        this.ctx.gameDataProvider = provider;
    }

    // ── Dispose ─────────────────────────────────────────────────────────

    dispose(): void {
        this.proceduralPoseLayers.clear();
        this.actionSystem.dispose();
        this.idleSystem.dispose();
        this.attackSystem.dispose();
        this.customSystem.dispose();
        this.overrideSystem.dispose();
        this.prioritySystem.dispose();

        if (this.ctx.mixer) {
            this.ctx.mixer.stopAllAction();
            this.ctx.animations.clear();
            this.ctx.customAnimations.clear();
            if (this.ctx.fadingOutTrackAPlayer) {
                this.ctx.fadingOutTrackAPlayer.stop();
                this.ctx.fadingOutTrackAPlayer = null;
            }
            for (const player of this.ctx.mixamoAnimationPlayers.values()) {
                player.dispose();
            }
            this.ctx.mixamoAnimationPlayers.clear();
            this.ctx.mixer = null;
        }
        this.ctx.character = null;
        this.ctx.isAttacking = false;
        this.ctx.isPlayingCustomAnimation = false;
        this.ctx.currentCustomMotionId = null;
        this.ctx.customAnimationHeld = false;
        this.ctx.nativeSpeedByState.clear();
    }
}
