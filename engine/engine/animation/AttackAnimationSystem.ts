import type { CustomAttackMove } from 'types/game.js';
import type { AttackResult } from 'engine/ICharacterAnimationController.js';
import type { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { scheduleGameplaySeconds } from 'engine/GameplayTimers.js';
import {
    type AnimationContext,
    AnimationState,
} from 'engine/animation/AnimationContext.js';

interface MixamoPlayOptions {
    fadeInDuration?: number;
    fadeOutDuration?: number;
    speed?: number;
    interruptOnMovement?: boolean;
    splitBodyOnRun?: boolean;
    filterRootMotion?: boolean;
    onFinished?: () => void;
}

type PlayMixamoAnimation = (
    motionId: string,
    player: MixamoAnimationPlayer,
    options?: MixamoPlayOptions,
) => { success: boolean; duration: number };

/**
 * Manages attack animations: random attacks, named custom attacks, and
 * Mixamo-based attack overrides. Mixamo-only — the standard-mixer code path
 * was removed when the engine went 100% Mixamo. Every attack is a
 * `MixamoAnimationPlayer` resolved from `ctx.mixamoAnimationPlayers`.
 *
 * Attack-finished signalling comes from the player's own `onFinished` callback
 * (no `ctx.mixer.addEventListener('finished')`); a watchdog timer is the only
 * safety net for callbacks that never fire.
 */
export class AttackAnimationSystem {
    // Watchdog: if Mixamo onFinished never fires (e.g. player was swapped
    // mid-flight by a state change), force-end the attack so isAttacking
    // can't get stuck true.
    private attackWatchdogGeneration = 0;

    // Custom attack move system
    customAttackMoves: Map<string, CustomAttackMove> = new Map();
    currentAttackMove: CustomAttackMove | null = null;

    /**
     * Notified the instant ANY attack animation starts — random, named, or the
     * ATTACK state override.
     *
     * Lives here because this is the one place every swing passes through.
     * WeaponMeleeSystem used to play its swish from its own input handler, which
     * meant a swing started any other way was silent: a template calling
     * `startNamedAttack('weapon:whirlwind')`, an NPC, or a networked remote
     * character. Sound belongs to the SWING, not to the mouse button.
     */
    onAttackStarted: ((info: { moveName: string; duration: number }) => void) | null = null;

    /**
     * ENGINE-RESERVED attack-started hook, fired alongside the public one.
     *
     * `onAttackStarted` is a single slot that games and systems overwrite
     * freely (the melee swish does, templates do) — which meant anything the
     * ENGINE hung on it (NPC strike hit registration) silently died the
     * moment user code set its own listener. Engine subsystems use this slot;
     * nothing outside `src/engine` may touch it.
     */
    onAttackStartedEngine: ((info: { moveName: string; duration: number }) => void) | null = null;

    private readonly ctx: AnimationContext;
    private readonly playAnimation: (state: AnimationState) => void;
    private readonly playMixamoAnimation: PlayMixamoAnimation;

    constructor(
        ctx: AnimationContext,
        playAnimation: (state: AnimationState) => void,
        playMixamoAnimation: PlayMixamoAnimation,
    ) {
        this.ctx = ctx;
        this.playAnimation = playAnimation;
        this.playMixamoAnimation = playMixamoAnimation;
    }

    /**
     * Mark the attack as active in shared context. Centralised so every
     * code path (random + named) updates the same fields:
     * - isAttacking gates re-entry
     * - currentState = ATTACK lets CharacterAnimationController watch for
     *   resume conditions
     */
    private beginAttackState(): void {
        this.ctx.isAttacking = true;
        this.ctx.attackStartTime = Date.now() / 1000;
        this.ctx.previousState = this.ctx.currentState;
        this.ctx.currentState = AnimationState.ATTACK;
    }

    /**
     * Arm a safety timer to force endAttack() if the natural onFinished
     * event never arrives (Mixamo player swapped, animation cancelled by
     * another track, etc.). Adds a generous margin on top of duration.
     */
    private armWatchdog(durationSeconds: number): void {
        this.clearWatchdog();
        const generation = this.attackWatchdogGeneration;
        scheduleGameplaySeconds(Math.max(.25, durationSeconds + .5), () => {
            if (generation !== this.attackWatchdogGeneration) return;
            if (this.ctx.isAttacking) this.endAttack();
        });
    }

    /** Fire the attack-started hook, never letting a listener break the swing. */
    private announceAttack(moveName: string, duration: number, success: boolean): void {
        if (!success) return;
        // Engine hook first — its hit registration must run even if a game
        // listener throws.
        try {
            this.onAttackStartedEngine?.({ moveName, duration });
        } catch (error) {
            console.warn('[AttackAnimationSystem] engine attack listener threw:', error);
        }
        try {
            this.onAttackStarted?.({ moveName, duration });
        } catch (error) {
            console.warn('[AttackAnimationSystem] onAttackStarted listener threw:', error);
        }
    }

    private clearWatchdog(): void {
        this.attackWatchdogGeneration++;
    }

    /**
     * Start an attack — picks a random registered custom-attack move, or
     * falls back to the ATTACK Mixamo state-override if no moves are
     * registered. Without either, nothing plays.
     */
    startAttack(): AttackResult {
        if (this.ctx.isAttacking) {
            return { success: false, duration: 0, animationName: '' };
        }

        // Prefer registered customAttackMoves (e.g. punch + kick from
        // UnarmedMeleeSystem). Pick one at random.
        if (this.customAttackMoves.size > 0) {
            const moveNames = Array.from(this.customAttackMoves.keys());
            const randomMove = moveNames[Math.floor(Math.random() * moveNames.length)]!;
            return this.startNamedAttack(randomMove);
        }

        // Otherwise fall back to mixamoStateOverrides[ATTACK].
        const mixamoOverrideId = this.ctx.mixamoStateOverrides.get(AnimationState.ATTACK);
        if (mixamoOverrideId) {
            const mixamoPlayer = this.ctx.mixamoAnimationPlayers.get(mixamoOverrideId);
            if (mixamoPlayer) {
                this.beginAttackState();
                // Brief guard-to-strike handoff. Generated clips already have
                // a guard at frame zero; neither snap nor skip anticipation.
                const result = this.playMixamoAnimation(mixamoOverrideId, mixamoPlayer, {
                    fadeInDuration: 0.06,
                    fadeOutDuration: 0.15,
                    onFinished: () => { this.endAttack(); },
                });
                this.armWatchdog(result.duration);
                this.announceAttack('Attack Override', result.duration, result.success);
                return { success: result.success, duration: result.duration, animationName: 'Attack Override' };
            }
        }

        console.warn('No attack animations available');
        return { success: false, duration: 0, animationName: '' };
    }

    endAttack(): void {
        if (!this.ctx.isAttacking) return;
        this.ctx.isAttacking = false;
        this.currentAttackMove = null;
        this.clearWatchdog();
        // Resume to whatever locomotion state CharacterAnimationController.updateAnimation
        // has been tracking during the swing (attackResumeState). That reflects
        // the player's actual feet — if they ran into the swing, kept running,
        // or only just started, attackResumeState already points to the right
        // state and trackA is already set up for it. The same-player guard in
        // activateMixamoOverride makes playAnimation(resumeState) a no-op on
        // trackA when nothing changed, so the legs don't snap.
        //
        // Fallbacks:
        // - Mid-jump (no movement update fired yet): JUMP, so we don't flash
        //   IDLE for a frame and wedge IdleAnimationSystem.
        // - Otherwise: IDLE.
        const resumeState = this.ctx.attackResumeState
            ?? (this.ctx.isJumping ? AnimationState.JUMP : AnimationState.IDLE);
        this.ctx.attackResumeState = null;
        this.ctx.attackTrackAState = null;
        this.playAnimation(resumeState);
    }

    hasAttackAnimations(): boolean {
        return this.customAttackMoves.size > 0
            || this.ctx.mixamoStateOverrides.has(AnimationState.ATTACK);
    }

    /**
     * Register a custom attack move. Resolves `move.animationMotionId` against
     * `ctx.mixamoAnimationPlayers` — the move must be a Mixamo player loaded
     * via `loadCustomAnimation` or `loadAnimationPack`.
     */
    registerCustomAttack(move: CustomAttackMove): boolean {
        const mixamoPlayer = this.ctx.mixamoAnimationPlayers.get(move.animationMotionId);

        if (!mixamoPlayer) {
            console.warn(
                `Cannot register custom attack "${move.name}": Mixamo player for ` +
                `motionId "${move.animationMotionId}" not found. Load the clip first ` +
                `via loadCustomAnimation() or loadAnimationPack() with source: 'mixamo'.`,
            );
            return false;
        }

        this.customAttackMoves.set(move.name, move);
        return true;
    }

    /**
     * Remove a registered custom attack move by name. Returns whether a move
     * with that name existed. `WeaponMeleeSystem` uses this to swap the move
     * set when the equipped weapon changes — without it, switching sword →
     * hammer would leave the sword's slashes in the random-pick pool.
     */
    unregisterCustomAttack(name: string): boolean {
        if (this.currentAttackMove?.name === name) {
            // Mid-swing removal: let the swing finish; it only affects future picks.
            this.currentAttackMove = { ...this.currentAttackMove };
        }
        return this.customAttackMoves.delete(name);
    }

    /**
     * Load and register custom attack moves from combat configuration.
     */
    async loadCustomAttackMoves(
        customMoves: CustomAttackMove[],
        loadCustomAnimation: (motionId: string, options?: { normalizeRootMotion?: boolean; loop?: boolean }) => Promise<void>,
    ): Promise<void> {
        for (const move of customMoves) {
            if (!this.ctx.mixamoAnimationPlayers.has(move.animationMotionId)) {
                try {
                    await loadCustomAnimation(move.animationMotionId, {
                        normalizeRootMotion: true,
                        loop: false,
                    });
                } catch (error) {
                    console.error(`Failed to load animation for custom move "${move.name}":`, error);
                    continue;
                }
            }
            this.registerCustomAttack(move);
        }
    }

    getRegisteredAttackMoves(): string[] {
        return Array.from(this.customAttackMoves.keys());
    }

    /**
     * Full config of a registered move, or null. This is what lets the ENGINE
     * register hits for an attack: the attack-started hook only carries the
     * move NAME, and whoever handles contact needs the move's type (punch vs
     * kick → which limb), side, and damage.
     */
    getAttackMoveConfig(moveName: string): CustomAttackMove | null {
        return this.customAttackMoves.get(moveName) ?? null;
    }

    /**
     * Start a specific attack by move name.
     */
    startNamedAttack(moveName: string): AttackResult {
        if (this.ctx.isAttacking) {
            return { success: false, duration: 0, animationName: '' };
        }

        const move = this.customAttackMoves.get(moveName);
        if (!move) {
            console.warn(`Custom attack move "${moveName}" not found`);
            return { success: false, duration: 0, animationName: '' };
        }

        const mixamoPlayer = this.ctx.mixamoAnimationPlayers.get(move.animationMotionId);
        if (!mixamoPlayer) {
            console.warn(
                `Custom attack move "${moveName}" has no loaded Mixamo player ` +
                `for motionId "${move.animationMotionId}".`,
            );
            return { success: false, duration: 0, animationName: '' };
        }

        this.beginAttackState();
        this.currentAttackMove = move;
        const result = this.playMixamoAnimation(move.animationMotionId, mixamoPlayer, {
            fadeInDuration: 0.1,
            fadeOutDuration: 0.1,
            speed: move.speed,
            interruptOnMovement: move.interruptOnMovement === true,
            splitBodyOnRun: move.splitBodyOnRun === true,
            filterRootMotion: move.filterRootMotion,
            onFinished: () => { this.endAttack(); },
        });
        const duration = result.duration / Math.max(.01, Math.abs(move.speed ?? 1));
        this.armWatchdog(duration);
        this.announceAttack(moveName, duration, result.success);
        return { success: result.success, duration, animationName: moveName, moveConfig: move };
    }

    dispose(): void {
        this.clearWatchdog();
        this.customAttackMoves.clear();
        this.currentAttackMove = null;
    }
}
