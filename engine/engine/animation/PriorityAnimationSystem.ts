import * as THREE from 'three';
import type { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import {
    type AnimationContext,
    AnimationState,
    fadeOutAllOtherActions,
    fadeInFromWeight,
    totalOtherActiveWeight,
    getActionClip,
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
 * Manages priority animations that lock out idle/movement animations.
 * Used for attacks, emotes, or other important animations.
 *
 * Mixamo-first resolution: an animationName that matches a registered
 * MixamoAnimationPlayer key (by motionId, exact or case-insensitive) plays
 * via the Mixamo path (track B). The standard-mixer path remains as a
 * fallback for legacy user-uploaded clips that still land on `ctx.mixer`
 * (e.g. idles loaded via `IdleAnimationSystem.setIdleAnimations`).
 */
export class PriorityAnimationSystem {
    private priorityAnimationFinishedCallback: (() => void) | null = null;

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
     * Play a high-priority animation that locks out idle/movement.
     */
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
        // 1. Mixamo path — the primary path for every engine-shipped clip and
        //    every uploaded/generated animation routed through MixamoAnimationPlayer.
        const resolved = this.resolveMixamoPlayer(animationName);
        if (resolved) {
            this.ctx.priorityAnimationPlaying = true;
            this.priorityAnimationFinishedCallback = options?.onFinished ?? null;
            const result = this.playMixamoAnimation(resolved.id, resolved.player, {
                fadeInDuration: options?.fadeInDuration,
                fadeOutDuration: options?.fadeOutDuration,
                speed: options?.speed,
                onFinished: () => {
                    this.ctx.priorityAnimationPlaying = false;
                    if (this.priorityAnimationFinishedCallback) {
                        this.priorityAnimationFinishedCallback();
                        this.priorityAnimationFinishedCallback = null;
                    }
                    if (!options?.loop) {
                        this.playAnimation(AnimationState.IDLE);
                    }
                },
            });
            return result;
        }

        // 2. Legacy standard-mixer fallback — only reachable for clips loaded
        //    via `IdleAnimationSystem.setIdleAnimations` (user-uploaded idles
        //    from world.json `assets[]` that didn't go through Mixamo). Will
        //    be removed when that path is also Mixamo-ified.
        if (!this.ctx.mixer) {
            console.warn(`Priority animation "${animationName}" not found (no Mixamo player matched, no mixer available)`);
            return { success: false, duration: 0 };
        }

        const lowerName = animationName.toLowerCase();
        let action: THREE.AnimationAction | undefined;
        for (const stateAction of this.ctx.animations.values()) {
            const clip = getActionClip(stateAction);
            if (clip && clip.name.toLowerCase() === lowerName) {
                action = stateAction;
                break;
            }
        }
        action ??= this.ctx.customAnimations.get(animationName);

        if (!action) {
            const mixamoIds = Array.from(this.ctx.mixamoAnimationPlayers.keys());
            console.warn(
                `Priority animation "${animationName}" not found. ` +
                `Available Mixamo players: ${mixamoIds.length > 0 ? mixamoIds.join(', ') : '(none)'}`,
            );
            return { success: false, duration: 0 };
        }

        this.ctx.priorityAnimationPlaying = true;
        this.priorityAnimationFinishedCallback = options?.onFinished ?? null;

        if (options?.loop) {
            action.setLoop(THREE.LoopRepeat, Infinity);
        } else {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
        }

        const fadeInDuration = options?.fadeInDuration ?? 0.3;
        action.reset();
        if (options?.speed !== undefined) {
            action.timeScale = options.speed;
        }
        action.play();
        const otherTotal = Math.min(1, totalOtherActiveWeight(this.ctx.mixer, action));
        fadeInFromWeight(action, fadeInDuration, 1 - otherTotal);
        fadeOutAllOtherActions(this.ctx.mixer, action, fadeInDuration);
        this.ctx.currentAction = action;

        if (!options?.loop) {
            const onFinished = (event: any) => {
                if (event.action === action) {
                    this.ctx.priorityAnimationPlaying = false;

                    const fadeOutDuration = options?.fadeOutDuration ?? 0.3;
                    action.fadeOut(fadeOutDuration);

                    if (this.priorityAnimationFinishedCallback) {
                        this.priorityAnimationFinishedCallback();
                        this.priorityAnimationFinishedCallback = null;
                    }

                    this.ctx.mixer?.removeEventListener('finished', onFinished);
                    this.playAnimation(AnimationState.IDLE);
                }
            };

            this.ctx.mixer.addEventListener('finished', onFinished);
        }

        const clip = getActionClip(action);
        const duration = clip?.duration ?? 0;

        return { success: true, duration };
    }

    /**
     * Resolve `animationName` to a loaded `MixamoAnimationPlayer` by motionId
     * (exact match first, then case-insensitive). Returns both the canonical
     * id and the player so callers don't have to look the id up again.
     */
    private resolveMixamoPlayer(
        animationName: string,
    ): { id: string; player: MixamoAnimationPlayer } | null {
        const exact = this.ctx.mixamoAnimationPlayers.get(animationName);
        if (exact) return { id: animationName, player: exact };
        const lower = animationName.toLowerCase();
        for (const [id, player] of this.ctx.mixamoAnimationPlayers) {
            if (id.toLowerCase() === lower) return { id, player };
        }
        return null;
    }

    isPriorityAnimationPlaying(): boolean {
        return this.ctx.priorityAnimationPlaying;
    }

    dispose(): void {
        this.priorityAnimationFinishedCallback = null;
    }
}
