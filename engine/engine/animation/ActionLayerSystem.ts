import * as THREE from 'three';
import type { AnimationContext } from 'engine/animation/AnimationContext.js';

/**
 * Manages the action animation layer - plays action animations (attacks, etc.)
 * on a separate skeleton clone while locomotion continues on the main mixer.
 */
export class ActionLayerSystem {
    private actionSkeleton: THREE.Object3D | null = null;
    private actionMixer: THREE.AnimationMixer | null = null;
    private actionCurrentAction: THREE.AnimationAction | null = null;
    private actionBoneMap: Map<string, THREE.Bone> = new Map();
    private actionBlend: { upperBody: number; lowerBody: number } = { upperBody: 0, lowerBody: 0 };
    private actionPlaying: boolean = false;

    private readonly ctx: AnimationContext;

    constructor(ctx: AnimationContext) {
        this.ctx = ctx;
    }

    /**
     * Initialize the action layer by cloning the character skeleton.
     */
    initActionLayer(character: THREE.Object3D): void {
        const clone = character.clone(true);
        // BONES ONLY, and NOT in the scene graph. The layer exists to evaluate
        // action clips onto a second skeleton that the pose blend reads world
        // transforms from; it never draws. The old form kept the meshes and
        // parented the clone under the character group as a hidden twin, which
        // (a) doubled every skinned NPC's bones in the renderer's per-frame
        // matrix walk, (b) drew a second body exactly on top of the real one
        // whenever anything re-showed it — invisible to the eye, not to the GPU —
        // and (c) double-applied the group transform, since the blend copies the
        // group's own transform onto this root before reading it
        // (CharacterLoader.blendTwoTracks / blendActionBoneTransforms). Detached,
        // that copy IS the world transform, and the clone costs nothing between
        // actions.
        const meshes: THREE.Object3D[] = [];
        clone.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) meshes.push(obj); });
        for (const mesh of meshes) mesh.removeFromParent();
        clone.visible = false;
        this.actionSkeleton = clone;

        this.actionMixer = new THREE.AnimationMixer(this.actionSkeleton);
        this.actionMixer.addEventListener('finished', () => {
            this.actionPlaying = false;
            this.actionCurrentAction = null;
        });

        this.actionBoneMap.clear();
        this.actionSkeleton.traverse((obj: THREE.Object3D) => {
            if ((obj as THREE.Bone).isBone) {
                this.actionBoneMap.set(obj.name, obj as THREE.Bone);
            }
        });
    }

    /**
     * Update the action mixer (call every frame).
     */
    update(deltaTime: number): void {
        if (this.actionMixer && this.actionPlaying) {
            this.actionMixer.update(deltaTime);
        }
    }

    /**
     * Play an action animation on the action layer.
     */
    playActionAnimation(
        clip: THREE.AnimationClip,
        options?: { loop?: boolean; blendIn?: number }
    ): { success: boolean; duration: number } {
        if (!this.actionMixer) {
            console.warn('[AnimController] Action layer not initialized');
            return { success: false, duration: 0 };
        }

        const action = this.actionMixer.clipAction(clip);
        action.reset();
        action.setLoop(
            options?.loop ? THREE.LoopRepeat : THREE.LoopOnce,
            options?.loop ? Infinity : 1
        );
        if (!options?.loop) {
            action.clampWhenFinished = true;
        }
        const blendIn = options?.blendIn ?? 0.25;
        if (this.actionCurrentAction && this.actionCurrentAction !== action) {
            action.crossFadeFrom(this.actionCurrentAction, blendIn, false);
        } else {
            action.fadeIn(blendIn);
        }
        action.play();

        this.actionCurrentAction = action;
        this.actionPlaying = true;

        return { success: true, duration: clip.duration };
    }

    /**
     * Play an action animation by motionId.
     */
    playActionAnimationByMotionId(
        motionId: string,
        options?: { loop?: boolean; blendIn?: number }
    ): { success: boolean; duration: number } {
        const existingAction = this.ctx.customAnimations.get(motionId);
        if (!existingAction) {
            console.warn(`[AnimController] Action animation "${motionId}" not found in customAnimations`);
            return { success: false, duration: 0 };
        }
        const clip = existingAction.getClip();
        return this.playActionAnimation(clip, options);
    }

    stopActionAnimation(fadeOut: number = 0.2): void {
        if (this.actionCurrentAction) {
            this.actionCurrentAction.fadeOut(fadeOut);
        }
        this.actionPlaying = false;
    }

    setActionBlend(weights: { upperBody: number; lowerBody: number }): void {
        this.actionBlend.upperBody = Math.max(0, Math.min(1, weights.upperBody));
        this.actionBlend.lowerBody = Math.max(0, Math.min(1, weights.lowerBody));
    }

    getActionBlend(): { upperBody: number; lowerBody: number } {
        return { ...this.actionBlend };
    }

    isActionAnimationPlaying(): boolean {
        return this.actionPlaying;
    }

    getActionBoneMap(): Map<string, THREE.Bone> | null {
        return this.actionPlaying ? this.actionBoneMap : null;
    }

    getActionSkeletonRoot(): THREE.Object3D | null {
        return this.actionSkeleton;
    }

    dispose(): void {
        if (this.actionMixer) {
            this.actionMixer.stopAllAction();
            this.actionMixer = null;
        }
        this.actionSkeleton = null;
        this.actionBoneMap.clear();
        this.actionPlaying = false;
        this.actionCurrentAction = null;
    }
}
