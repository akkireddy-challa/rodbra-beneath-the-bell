import * as THREE from 'three';
import type { BaseAnimationDefinition } from 'types/game.js';
import {
    retargetAnimationToCharacterSkeleton,
    scaleClipPositions,
    detectClipUnitScale,
    makeClipLoopable,
} from 'engine/AnimationClipUtils.js';
import {
    type AnimationContext,
    AnimationState,
    crossFadeToAction,
    keepCurrentActionAlive,
    cachedGLTFLoad,
    findAnimationAsset,
    getActionClip,
} from 'engine/animation/AnimationContext.js';

/**
 * Manages idle animation cycling, including hand-attachment filtering
 * and timer-based custom idle cycling.
 */
export class IdleAnimationSystem {
    // Idle animation collection
    idleAnimations: THREE.AnimationAction[] = [];
    idleAnimationMetadata: Map<THREE.AnimationAction, { name: string; worksWithAttachedObjects: boolean }> = new Map();
    private currentIdleIndex: number = 0;
    private currentIdleStartTime: number = 0;
    private minIdlePlayDuration: number = 2.0;

    // Custom idle animation system (timer-based cycling with LoopRepeat)
    usingCustomIdles: boolean = false;
    private customIdleCycleInterval: number = 0;
    private customIdleElapsed: number = 0;

    // Callback to check if object is attached to hand
    private hasObjectAttachedToHandCallback: (() => boolean) | null = null;

    private readonly ctx: AnimationContext;

    constructor(ctx: AnimationContext) {
        this.ctx = ctx;
    }

    /** Idle transition duration - calculated once for consistency */
    get idleTransitionDuration(): number {
        return Math.max(this.ctx.config.transitionDuration || 0.2, 0.5);
    }

    setHasObjectAttachedToHandCallback(callback: (() => boolean) | null): void {
        this.hasObjectAttachedToHandCallback = callback;
    }

    /**
     * Get available idle animations filtered by hand attachment status.
     */
    getAvailableIdleAnimations(): THREE.AnimationAction[] {
        const hasObjectAttached = this.hasObjectAttachedToHandCallback ? this.hasObjectAttachedToHandCallback() : false;
        if (!hasObjectAttached) {
            return this.idleAnimations;
        }
        return this.idleAnimations.filter(action => {
            const metadata = this.idleAnimationMetadata.get(action);
            return metadata && metadata.worksWithAttachedObjects;
        });
    }

    /**
     * Check if current idle animation is compatible with hand attachment status
     * and switch to a compatible one if needed.
     */
    checkAndSwitchToCompatibleIdleAnimation(): void {
        if (this.ctx.currentState !== AnimationState.IDLE) return;

        const hasObjectAttached = this.hasObjectAttachedToHandCallback ? this.hasObjectAttachedToHandCallback() : false;
        if (!hasObjectAttached) return;

        const currentIdleAction = this.idleAnimations.find(action => action.isRunning());
        if (!currentIdleAction) return;

        const metadata = this.idleAnimationMetadata.get(currentIdleAction);
        if (metadata && metadata.worksWithAttachedObjects) return;

        // Current animation is NOT compatible, switch to a compatible one
        const availableAnimations = this.getAvailableIdleAnimations();
        if (availableAnimations.length === 0) {
            console.warn('checkAndSwitchToCompatibleIdleAnimation: No compatible animations available');
            return;
        }

        const randomIndex = Math.floor(Math.random() * availableAnimations.length);
        const compatibleAction = availableAnimations[randomIndex];
        if (!compatibleAction) return;

        this.currentIdleIndex = this.idleAnimations.indexOf(compatibleAction);
        if (this.currentIdleIndex === -1) {
            console.warn('checkAndSwitchToCompatibleIdleAnimation: Selected animation not found in idleAnimations array');
            return;
        }

        crossFadeToAction(this.ctx, compatibleAction, this.idleTransitionDuration);
        this.currentIdleStartTime = Date.now() / 1000;
    }

    /**
     * Play the next random idle animation.
     */
    playNextIdleAnimation(): void {
        const availableAnimations = this.getAvailableIdleAnimations();
        if (availableAnimations.length === 0) return;

        if (availableAnimations.length === 1) {
            const nextIdleAction = availableAnimations[0];
            if (!nextIdleAction) return;
            this.currentIdleIndex = this.idleAnimations.indexOf(nextIdleAction);
            if (this.currentIdleIndex === -1) {
                console.warn('playNextIdleAnimation: Selected animation not found in idleAnimations array');
                return;
            }
            crossFadeToAction(this.ctx, nextIdleAction, this.idleTransitionDuration);
            this.currentIdleStartTime = Date.now() / 1000;
            return;
        }

        const currentAction = this.idleAnimations[this.currentIdleIndex] || this.ctx.currentAction;
        const currentAvailableIndex = currentAction ? availableAnimations.indexOf(currentAction) : -1;

        let newAvailableIndex;
        do {
            newAvailableIndex = Math.floor(Math.random() * availableAnimations.length);
        } while (newAvailableIndex === currentAvailableIndex && availableAnimations.length > 1);

        const nextIdleAction = availableAnimations[newAvailableIndex];
        if (!nextIdleAction) return;

        this.currentIdleIndex = this.idleAnimations.indexOf(nextIdleAction);
        if (this.currentIdleIndex === -1) {
            console.warn('playNextIdleAnimation: Selected animation not found in idleAnimations array');
            return;
        }

        crossFadeToAction(this.ctx, nextIdleAction, this.idleTransitionDuration);
        this.currentIdleStartTime = Date.now() / 1000;
    }

    /**
     * Play a random idle animation (called on state transition to IDLE).
     */
    playIdleAnimation(): void {
        const availableAnimations = this.getAvailableIdleAnimations();

        if (availableAnimations.length === 0) {
            console.warn('playIdleAnimation: No idle animations available for current hand attachment state');
            if (this.idleAnimations.length > 0) {
                console.warn('playIdleAnimation: Falling back to all animations');
                const fallbackAction = this.idleAnimations[0];
                if (fallbackAction) {
                    this.currentIdleIndex = 0;
                    crossFadeToAction(this.ctx, fallbackAction, this.ctx.config.transitionDuration!);
                    return;
                }
            }
            // Nothing to switch to — keep current action looping so the
            // skeleton never falls to bind pose.
            keepCurrentActionAlive(this.ctx);
            return;
        }

        const hasRunningIdle = this.idleAnimations.some(action => action.isRunning());
        if (hasRunningIdle && this.ctx.currentState === AnimationState.IDLE) {
            return;
        }

        const randomIndex = Math.floor(Math.random() * availableAnimations.length);
        const idleAction = availableAnimations[randomIndex];
        if (!idleAction) {
            console.warn(`playIdleAnimation: No idle action at random index ${randomIndex}`);
            return;
        }

        this.currentIdleIndex = this.idleAnimations.indexOf(idleAction);
        if (this.currentIdleIndex === -1) {
            console.warn('playIdleAnimation: Selected animation not found in idleAnimations array');
            return;
        }

        crossFadeToAction(this.ctx, idleAction, this.idleTransitionDuration);
        this.currentIdleStartTime = Date.now() / 1000;

        if (!idleAction.isRunning()) {
            console.warn('playIdleAnimation: Action did not start playing - may indicate skeleton mismatch');
        }
    }

    /**
     * Update idle cycling logic (called every frame from main update).
     */
    update(deltaTime: number): void {
        if (this.ctx.currentState !== AnimationState.IDLE || this.ctx.isPlayingCustomAnimation) return;

        // Check attachment compatibility
        this.checkAndSwitchToCompatibleIdleAnimation();

        // Timer-based cycling for custom idle animations
        if (this.usingCustomIdles && this.idleAnimations.length > 1) {
            this.customIdleElapsed += deltaTime;
            if (this.customIdleElapsed >= this.customIdleCycleInterval) {
                this.customIdleElapsed = 0;
                this.customIdleCycleInterval = 6 + Math.random() * 4;
                this.playNextIdleAnimation();
            }
        }

        // Preemptive crossfade before idle clip ends
        if (!this.usingCustomIdles && this.ctx.currentAction) {
            const clip = getActionClip(this.ctx.currentAction);
            if (clip && clip.duration > 0) {
                const time = this.ctx.currentAction.time ?? 0;
                const remaining = clip.duration - time;
                const currentTime = Date.now() / 1000;
                const timeSinceStart = currentTime - this.currentIdleStartTime;
                const hasPlayedMinimumTime = timeSinceStart >= this.minIdlePlayDuration;
                const threshold = Math.max(0.3, this.idleTransitionDuration * 1.5);
                if (remaining <= threshold && hasPlayedMinimumTime) {
                    this.playNextIdleAnimation();
                }
            }
        }
    }

    /**
     * Replace idle animations with custom ones loaded by motionId.
     */
    async setIdleAnimations(motionIds: string[]): Promise<void> {
        if (!this.ctx.loader || !this.ctx.mixer) {
            console.warn('setIdleAnimations: loader or mixer not available. Initialize character first.');
            return;
        }

        if (motionIds.length === 0) {
            console.warn('setIdleAnimations: empty motionIds array');
            return;
        }

        // Stop any currently playing idle action
        for (const action of this.idleAnimations) {
            action.stop();
        }

        this.idleAnimations = [];
        this.idleAnimationMetadata.clear();
        this.currentIdleIndex = 0;

        for (const motionId of motionIds) {
            const raw = findAnimationAsset(this.ctx, motionId);
            if (!raw) {
                console.warn(`setIdleAnimations: animation "${motionId}" not found in assets`);
                continue;
            }

            const url = (raw.animationUrl ?? raw.url) as string;
            if (!url) {
                console.warn(`setIdleAnimations: animation "${motionId}" has no URL`);
                continue;
            }

            try {
                const gltf = await cachedGLTFLoad(this.ctx.loader, url);
                if (!gltf.animations || gltf.animations.length === 0) {
                    console.warn(`setIdleAnimations: no animations in ${url}`);
                    continue;
                }

                const rawClip = gltf.animations[0];
                if (!rawClip) continue;

                let clip: THREE.AnimationClip = rawClip;

                if (this.ctx.character) {
                    const boneNames = new Set<string>();
                    this.ctx.character.traverse((child: THREE.Object3D) => { boneNames.add(child.name); });
                    clip = retargetAnimationToCharacterSkeleton(clip, boneNames);
                }

                const detectedScale = detectClipUnitScale(clip);
                if (detectedScale !== 1.0) {
                    clip = scaleClipPositions(clip, detectedScale);
                }

                clip = makeClipLoopable(clip);

                const action = this.ctx.mixer.clipAction(clip);
                action.setLoop(THREE.LoopRepeat, Infinity);

                this.idleAnimations.push(action);
                this.idleAnimationMetadata.set(action, {
                    name: (raw.name as string) ?? motionId,
                    worksWithAttachedObjects: true
                });
            } catch (error) {
                console.error(`setIdleAnimations: failed to load "${motionId}" from ${url}:`, error);
            }
        }

        if (this.idleAnimations.length > 0 && this.idleAnimations[0]) {
            this.ctx.animations.set(AnimationState.IDLE, this.idleAnimations[0]);

            if (this.ctx.currentState === AnimationState.IDLE) {
                crossFadeToAction(this.ctx, this.idleAnimations[0], this.idleTransitionDuration);
                this.currentIdleStartTime = Date.now() / 1000;
            }
        }

        if (this.idleAnimations.length > 0) {
            this.usingCustomIdles = true;
            this.customIdleElapsed = 0;
            this.customIdleCycleInterval = 6 + Math.random() * 4;
        }
    }

    /**
     * Pose the character at the first frame of the first available idle animation.
     */
    poseCharacterAtFirstIdleFrame(): boolean {
        if (!this.ctx.mixer || !this.ctx.character) return false;
        let targetAction: THREE.AnimationAction | undefined;
        if (this.idleAnimations && this.idleAnimations.length > 0) {
            targetAction = this.idleAnimations[0];
        } else {
            targetAction = this.ctx.animations.get(AnimationState.IDLE);
        }
        if (!targetAction) return false;

        this.ctx.mixer.stopAllAction();
        targetAction.reset();
        targetAction.enabled = true;
        targetAction.setEffectiveWeight(1);
        targetAction.setEffectiveTimeScale(0);
        targetAction.play();
        targetAction.time = 0;
        this.ctx.mixer.update(0);
        try {
            targetAction.stop();
            targetAction.reset();
            targetAction.setEffectiveTimeScale(1);
        } catch { /* intentionally empty */ }
        this.ctx.character.updateMatrixWorld(true);
        return true;
    }

    dispose(): void {
        this.idleAnimations = [];
        this.idleAnimationMetadata.clear();
        this.usingCustomIdles = false;
        this.hasObjectAttachedToHandCallback = null;
    }
}
