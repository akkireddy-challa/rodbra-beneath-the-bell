/**
 * MixamoAnimationPlayer
 * 
 * Plays uploaded Mixamo animations on their native skeleton, then maps
 * bone world transforms to block character parts.
 * 
 * This avoids the need for complex quaternion retargeting between different
 * skeleton rest poses. The Mixamo skeleton is loaded from the uploaded GLB
 * and animated directly. Block character parts read world transforms from
 * Mixamo bones using a name mapping.
 */

import * as THREE from 'three';
import { removeLinearRootTravel } from 'engine/animation/LocomotionRootMotion.js';
import { readAnimationTiming, contactCheckPhases, type AnimationTiming } from 'engine/animation/AnimationTiming.js';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { pickImpactStrike } from 'engine/animation/ImpactFrameDetector.js';
import { captureRootMotionBaseline, rootMotionWorldTravelXZ } from 'engine/animation/RootMotion.js';

/**
 * Mapping from block character part names to skeleton bone names.
 * Supports Mixamo (mixamorig / mixamorig2 prefixes, unprefixed) and
 * Unreal Engine 5 Manny / Uthana naming (lowercase, *_l / *_r suffixes).
 */
const BLOCK_PART_TO_MIXAMO_BONE: Record<string, string[]> = {
    head: ['mixamorig2Head', 'mixamorigHead', 'Head', 'head'],
    neck: ['mixamorig2Neck', 'mixamorigNeck', 'Neck', 'neck_01'],
    torso: ['mixamorig2Spine1', 'mixamorigSpine1', 'Spine1', 'mixamorig2Spine', 'mixamorigSpine', 'Spine', 'spine_03', 'spine_02'],
    leftUpperArm: ['mixamorig2LeftArm', 'mixamorigLeftArm', 'LeftArm', 'upperarm_l'],
    leftForearm: ['mixamorig2LeftForeArm', 'mixamorigLeftForeArm', 'LeftForeArm', 'lowerarm_l'],
    leftHand: ['mixamorig2LeftHand', 'mixamorigLeftHand', 'LeftHand', 'hand_l'],
    rightUpperArm: ['mixamorig2RightArm', 'mixamorigRightArm', 'RightArm', 'upperarm_r'],
    rightForearm: ['mixamorig2RightForeArm', 'mixamorigRightForeArm', 'RightForeArm', 'lowerarm_r'],
    rightHand: ['mixamorig2RightHand', 'mixamorigRightHand', 'RightHand', 'hand_r'],
    leftThigh: ['mixamorig2LeftUpLeg', 'mixamorigLeftUpLeg', 'LeftUpLeg', 'thigh_l'],
    leftShin: ['mixamorig2LeftLeg', 'mixamorigLeftLeg', 'LeftLeg', 'calf_l'],
    leftFoot: ['mixamorig2LeftFoot', 'mixamorigLeftFoot', 'LeftFoot', 'foot_l'],
    rightThigh: ['mixamorig2RightUpLeg', 'mixamorigRightUpLeg', 'RightUpLeg', 'thigh_r'],
    rightShin: ['mixamorig2RightLeg', 'mixamorigRightLeg', 'RightLeg', 'calf_r'],
    rightFoot: ['mixamorig2RightFoot', 'mixamorigRightFoot', 'RightFoot', 'foot_r'],
};

export interface MixamoAnimationState {
    isPlaying: boolean;
    progress: number;
    duration: number;
}

// Mixamo FBX files are in centimeters, game uses meters
const MIXAMO_CM_TO_M = 0.01;

// Standard Mixamo skeleton height in meters (after cm->m conversion)
// Mixamo's default character is ~175cm, so 1.75m after conversion
const MIXAMO_DEFAULT_HEIGHT = 1.75;

// Debug: show the Mixamo skeleton mesh next to the player (set to false for production)
const DEBUG_SHOW_SKELETON = false;
const DEBUG_OFFSET_X = 0; // Set to non-zero to offset debug skeleton from player

// Default blend duration in seconds
const DEFAULT_BLEND_IN_DURATION = 0.3;
const DEFAULT_BLEND_OUT_DURATION = 0.3;

/** FK samples for impact-frame detection at clip load. 48 ≈ 25 Hz on a 2 s clip. */
const IMPACT_DETECTION_SAMPLES = 48;

/** Bone/node name an animation track targets ("mixamorigHips.position" -> "mixamorigHips"),
 *  or null when the name has no "." property suffix (i.e. no clear bone target). */
function trackTargetBone(trackName: string): string | null {
    const dotIndex = trackName.indexOf('.');
    return dotIndex > 0 ? trackName.substring(0, dotIndex) : null;
}

/** Per-load options. Every member is optional so existing callers are unchanged. */
export interface MixamoPlayerLoadOptions {
    /**
     * Keep every bone and every track of the clip. By default the player strips
     * tracks and prunes bone subtrees outside the block-character parts (fingers,
     * toes, end bones) — a saving the block body never notices, but a skinned
     * mesh whose skin reaches those bones would freeze them in bind pose. The
     * skinned render path sets this; the block path leaves it off.
     */
    retainFullSkeleton?: boolean;
}

export class MixamoAnimationPlayer {
    private timing: AnimationTiming = readAnimationTiming(null);
    private originalHipsValues: Float32Array | null = null;
    private leftContactPhase: number | null = null;
    getContactCheckPhases(fallback: readonly number[]): readonly number[] { return contactCheckPhases(this.timing, fallback); }
    private skeleton: THREE.Object3D | null = null;
    private mixer: THREE.AnimationMixer | null = null;
    private currentAction: THREE.AnimationAction | null = null;
    private boneMap: Map<string, THREE.Bone> = new Map();
    private blockPartToBone: Map<string, THREE.Bone> = new Map();
    /** Cached normalized contact-frame fraction (0..1) detected at load, or null
     *  when the clip has no clear strike. Consumed by the onImpact hook. */
    private impactFraction: number | null = null;
    /** End-effector that strikes in this clip (e.g. 'rightFoot'), or null. Set with impactFraction. */
    private impactPart: string | null = null;
    private onCompleteCallback: (() => void) | null = null;
    private scene: THREE.Scene | null = null;
    private playerPositionRef: THREE.Object3D | null = null;
    private hipsBone: THREE.Bone | null = null; // For feet offset calculation
    private targetCharacterHeight: number = MIXAMO_DEFAULT_HEIGHT;
    /**
     * The clip skeleton's REST pose, captured at load before any track poses it
     * (impact detection samples the clip during load; the mixer never returns the
     * bones to rest). Rotations are in the skeleton root's frame, keyed by bone
     * name. Read by the skinned render path to retarget a rig whose bind differs.
     */
    private restRotations: Map<string, THREE.Quaternion> = new Map();
    /** See getPosedBoneNames. Fixed at load: a player plays one clip. */
    private posedBoneNames: Set<string> = new Set();
    /** Foot/toe bones, and the lowest of their rest heights above the skeleton root. */
    private footBones: THREE.Bone[] = [];
    private restFeetLevel: number = 0;
    /** Hips rest position relative to the skeleton root, in the root's frame (world units), or null without hips. */
    private restHipsOffset: THREE.Vector3 | null = null;
    private readonly _footScratch = new THREE.Vector3();
    private animationLabel: string = '';
    
    // Blending state
    private blendWeight: number = 0; // 0 = standard animation, 1 = Mixamo animation
    private blendInDuration: number = DEFAULT_BLEND_IN_DURATION;
    private blendOutDuration: number = DEFAULT_BLEND_OUT_DURATION;
    private isBlendingIn: boolean = false;
    private isBlendingOut: boolean = false;
    private animationDuration: number = 0;
    private animationElapsed: number = 0;
    // Locomotion mode: blend weight stays at 1.0, no blend-out, root motion filtered
    private locomotionMode: boolean = false;
    // Hold last frame: blend weight stays at 1.0 after blend-in, no blend-out
    private _holdLastFrame: boolean = false;
    /**
     * For looping clips (WALK / RUN / IDLE locomotion overrides), the
     * cycle phase the action was at when `stop()` was last called. Restored
     * on the next `play()` so the walk loop resumes mid-cycle instead of
     * snapping back to frame 0 every time the agent re-activates the
     * override (e.g. NPC briefly stops → starts again). Without this, the
     * visible symptom is a "walk animation reset" twitch every transition.
     * `null` means no preserved phase (first play or non-looping clip).
     */
    private preservedLoopTime: number | null = null;
    // Native root motion speed in meters/second (calculated before filtering root motion)
    private nativeLocomotionSpeed: number = 0;
    // Fallback design speed (m/s) for in-place animations without root motion
    private designSpeed: number = 0;
    // Pre-allocated temp objects to avoid per-frame allocations
    private _tempPosition = new THREE.Vector3();
    private _tempQuaternion = new THREE.Quaternion();

    // Root-motion commit: when set, the clip's authored hips travel is reported
    // (as a per-frame world-space XZ delta) to this callback instead of snapping
    // back when the clip ends, and consumed from the visible skeleton so the body
    // doesn't advance twice. Used for one-shot moves that step the player (e.g. a
    // soccer kick stepping into the ball). See enableRootMotion / applyRootMotion.
    private rootMotionCallback: ((displacement: THREE.Vector3) => void) | null = null;
    private rootMotionBaseline: THREE.Vector3 | null = null;
    private readonly _rmCumulative = new THREE.Vector3();
    private readonly _rmHipsWorld = new THREE.Vector3();
    private readonly _rmTravel = new THREE.Vector3();
    private readonly _rmDelta = new THREE.Vector3();

    /**
     * Load a Mixamo skeleton + animation from a GLB URL.
     * The GLB should contain the skeleton hierarchy and animation clips.
     * @param url - URL to the GLB file
     * @param loader - GLTFLoader instance
     * @param scene - Scene to add the skeleton to (required for world matrix updates)
     * @param playerPositionRef - Object to track for positioning the skeleton
     * @param targetHeight - Target character height in meters (from world.json)
     */
    async load(
        url: string, 
        loader: GLTFLoader, 
        scene: THREE.Scene,
        playerPositionRef: THREE.Object3D,
        targetHeight: number = MIXAMO_DEFAULT_HEIGHT,
        options?: MixamoPlayerLoadOptions
    ): Promise<boolean> {
        try {
            const gltf = await loader.loadAsync(url);
            return this.initFromGLTF(gltf.scene, gltf.animations, scene, playerPositionRef, targetHeight, options);
        } catch (error) {
            console.error('[MixamoPlayer] Failed to load:', error);
            return false;
        }
    }

    /**
     * Initialize from pre-loaded GLTF data. Clones the scene so each instance
     * gets its own skeleton hierarchy. Use this when caching the GLTF load.
     */
    loadFromGLTF(
        cachedScene: THREE.Group,
        cachedAnimations: THREE.AnimationClip[],
        scene: THREE.Scene,
        playerPositionRef: THREE.Object3D,
        targetHeight: number = MIXAMO_DEFAULT_HEIGHT,
        options?: MixamoPlayerLoadOptions
    ): boolean {
        const clonedScene = cachedScene.clone(true);
        const clonedAnimations = cachedAnimations.map(clip => clip.clone());
        return this.initFromGLTF(clonedScene, clonedAnimations, scene, playerPositionRef, targetHeight, options);
    }

    /** Record this bone as the hips/pelvis if its name matches either keyword. */
    private detectHipsBone(bone: THREE.Bone): void {
        const name = bone.name.toLowerCase();
        if (name.includes('hips') || name.includes('pelvis')) {
            this.hipsBone = bone;
        }
    }

    private initFromGLTF(
        sceneRoot: THREE.Group,
        animations: THREE.AnimationClip[],
        scene: THREE.Scene,
        playerPositionRef: THREE.Object3D,
        targetHeight: number,
        options?: MixamoPlayerLoadOptions
    ): boolean {
        try {
            this.skeleton = sceneRoot;
            // GLTFExporter wraps a Group in an auxiliary Scene. Its extras
            // round-trip on that root NODE, not necessarily gltf.scene itself.
            let timingMetadata: unknown = sceneRoot.userData.bmAnimation;
            sceneRoot.traverse(node => { timingMetadata ??= node.userData.bmAnimation; });
            this.timing = readAnimationTiming(timingMetadata);
            this.scene = scene;
            this.playerPositionRef = playerPositionRef;
            this.targetCharacterHeight = targetHeight;
            
            // Neutralize any intermediate scales baked into the GLB hierarchy
            // (e.g. FBX→GLB converters may bake a 0.01 cm→m scale into the
            // Armature node). We want only our root scale to apply.
            this.skeleton.traverse(child => {
                child.matrixAutoUpdate = true;
                if (child !== sceneRoot && !(child as THREE.Bone).isBone) {
                    const s = child.scale;
                    if (Math.abs(s.x - 1) > 0.001 || Math.abs(s.y - 1) > 0.001 || Math.abs(s.z - 1) > 0.001) {
                        // Neutralize intermediate scale (e.g. Armature 0.01 from FBX→GLB conversion)
                        child.scale.setScalar(1);
                    }
                }
                if ((child as THREE.Mesh).isMesh) {
                    child.visible = DEBUG_SHOW_SKELETON;
                }
            });

            // Scale: cm to meters, then adjust to match target character height
            const heightScale = targetHeight / MIXAMO_DEFAULT_HEIGHT;
            const finalScale = MIXAMO_CM_TO_M * heightScale;
            this.skeleton.scale.setScalar(finalScale);
            
            // Only add to scene when debugging; in production the skeleton is
            // invisible and updateMatrixWorld(true) is called explicitly, so
            // keeping ~65 bone nodes out of the scene graph avoids per-frame
            // traversal overhead for every inactive MixamoAnimationPlayer.
            if (DEBUG_SHOW_SKELETON) {
                scene.add(this.skeleton);
            }
            
            // Build bone map
            this.boneMap.clear();
            this.skeleton.traverse(child => {
                if ((child as THREE.Bone).isBone) {
                    this.boneMap.set(child.name, child as THREE.Bone);
                    this.detectHipsBone(child as THREE.Bone); // for feet offset
                }
            });

            // FBX→GLB conversions may produce some nodes as Bone and others as
            // plain Object3D. Always discover animated nodes from the tracks and
            // add any that weren't already found via the isBone flag.
            if (animations && animations.length > 0) {
                const animatedNodeNames = new Set<string>();
                for (const clip of animations) {
                    for (const track of clip.tracks) {
                        const node = trackTargetBone(track.name);
                        if (node) animatedNodeNames.add(node);
                    }
                }

                this.skeleton.traverse(child => {
                    if (animatedNodeNames.has(child.name) && !this.boneMap.has(child.name)) {
                        this.boneMap.set(child.name, child as THREE.Bone);
                        this.detectHipsBone(child as THREE.Bone);
                    }
                });
            }
            this.registerInteriorJoints();

            // Build block part to bone mapping
            this.blockPartToBone.clear();
            for (const [partName, boneNames] of Object.entries(BLOCK_PART_TO_MIXAMO_BONE)) {
                for (const boneName of boneNames) {
                    const bone = this.boneMap.get(boneName);
                    if (bone) {
                        this.blockPartToBone.set(partName, bone);
                        break;
                    }
                }
            }

            // Rest pose, before any track runs and before pruning: the bones still
            // hold the GLB's node transforms here, which for a Mixamo export is the
            // T-pose every CORE clip shares.
            this.captureRestPose();

            // Strip tracks for non-essential bones (fingers, toes, end bones)
            // and prune those bone nodes from the hierarchy to reduce both
            // mixer interpolation and updateMatrixWorld traversal cost. A
            // skinned rig may weight vertices to exactly those bones, so the
            // skinned render path asks to keep everything.
            if (!options?.retainFullSkeleton) {
                const neededBones = this.buildNeededBoneSet();
                if (neededBones.size > 0) {
                    this.stripUnusedTracks(animations, neededBones);
                    this.pruneUnneededSubtrees(neededBones);
                }
            }

            // Create mixer
            this.mixer = new THREE.AnimationMixer(this.skeleton);
            
            // Select the best animation clip.
            // Mixamo GLBs often include a static T-pose/reference as the first clip.
            // Pick the longest clip (most likely the actual animation, not the reference pose).
            if (animations && animations.length > 0) {
                let bestClip = animations[0]!;
                for (let i = 1; i < animations.length; i++) {
                    if (animations[i]!.duration > bestClip.duration) {
                        bestClip = animations[i]!;
                    }
                }
                this.currentAction = this.mixer.clipAction(bestClip);
                this.currentAction.setLoop(THREE.LoopOnce, 1);
                this.currentAction.clampWhenFinished = true;
            }
            this.posedBoneNames = this.computePosedBoneNames();

            // Detect the clip's contact ("impact") frame once at load so the
            // onImpact hook can fire physical effects at the moment of contact
            // (e.g. a kick's impulse) instead of at frame 0. Cheap: a few dozen
            // FK samples. Non-strike clips (idle/run/dance) return null.
            this.impactFraction = this.detectImpactFraction(IMPACT_DETECTION_SAMPLES);
            this.impactFraction = this.timing.impactPhase ?? this.impactFraction;
            const hipsTrack = this.findHipsPositionTrack();
            this.originalHipsValues = hipsTrack ? Float32Array.from(hipsTrack.values) : null;

            // Listen for animation complete
            this.mixer.addEventListener('finished', () => {
                if (this.onCompleteCallback) {
                    this.onCompleteCallback();
                }
            });

            return true;
        } catch (error) {
            console.error('[MixamoPlayer] Failed to load:', error);
            return false;
        }
    }

    /**
     * Play the loaded animation with blend-in from the current animation.
     * @param onComplete - Callback when animation finishes
     * @param blendInDuration - Duration of blend-in in seconds (default 0.3)
     * @param blendOutDuration - Duration of blend-out in seconds (default 0.3)
     */
    private playRevision = 0;
    getPlayRevision(): number { return this.playRevision; }

    play(onComplete?: () => void, blendInDuration?: number, blendOutDuration?: number): void {
        if (!this.currentAction) {
            console.warn('[MixamoPlayer] No animation loaded');
            return;
        }
        
        if (!this.mixer) {
            console.warn('[MixamoPlayer] No mixer available');
            return;
        }
        
        this.onCompleteCallback = onComplete || null;
        this.playRevision++;
        this.blendInDuration = blendInDuration ?? DEFAULT_BLEND_IN_DURATION;
        this.blendOutDuration = blendOutDuration ?? DEFAULT_BLEND_OUT_DURATION;
        
        this.isBlendingOut = false;
        this.animationElapsed = 0;

        if (this.blendInDuration <= 0) {
            // Instant start: 100% custom animation from frame 1
            this.blendWeight = 1;
            this.isBlendingIn = false;
        } else {
            this.blendWeight = 0;
            this.isBlendingIn = true;
        }
        
        this.currentAction.reset();
        this.currentAction.setEffectiveWeight(1);
        this.currentAction.setEffectiveTimeScale(1);
        this.currentAction.play();

        const clip = this.currentAction.getClip();
        this.animationDuration = clip.duration;

        const isLooping = this.currentAction.loop === THREE.LoopRepeat;
        // Start at the authored first frame. Generated clips already start in
        // guard; blanket skipping deletes anticipation and shifts impact timing.
        if (!isLooping) this.currentAction.time = Math.min(this.timing.startTime, Math.max(0, clip.duration - 1e-4));
        this.animationElapsed = this.currentAction.time;

        // Resume the cycle phase that was saved when this player was last
        // stopped. Three.js's `stop()` internally calls `reset()` which
        // zeros `time`, and the `reset()` call above re-zeros it — so
        // without this restore, every WALK→IDLE→WALK transition would
        // visibly snap the walk loop back to frame 0. Only restore for
        // looping clips; one-shots (ATTACK, JUMP) should always start
        // from the beginning. Modulo the clip length in case the clip
        // was shortened between sessions.
        if (isLooping && this.preservedLoopTime !== null && this.animationDuration > 0) {
            this.currentAction.time = this.preservedLoopTime % this.animationDuration;
        }
        this.preservedLoopTime = null;
        // Flush the mixer so the Mixamo skeleton's bones reflect the clip's
        // current frame BEFORE the first render — otherwise the bones hold
        // their previous pose (bind pose for a never-played player, or the
        // previous clip's last frame for a re-played one), and
        // `blendBoneTransforms` would render that stale pose for the first
        // frame of the swing. We use a tiny positive delta because Three.js's
        // `AnimationAction._update` early-returns when `timeDirection === 0`
        // (which `mixer.update(0)` produces) right after `play()` sets the
        // action's `_startTime` — so `mixer.update(0)` is a no-op here.
        this.mixer.update(1e-6);
    }

    /**
     * Stop the animation.
     *
     * For LoopRepeat clips (locomotion overrides — walk / run / idle), the
     * action's current `time` is saved to `preservedLoopTime` BEFORE the
     * underlying `currentAction.stop()` call. Three.js's `stop()` invokes
     * `reset()` which zeros `time`, so without this snapshot we would lose
     * the cycle phase and the next `play()` would snap the loop back to
     * frame 0 — the visible "walk animation keeps resetting" twitch.
     * Non-looping clips don't snapshot; they restart from 0 on next play
     * (which is the desired behaviour for one-shot attacks / jumps).
     */
    stop(): void {
        if (this.currentAction) {
            if (this.currentAction.loop === THREE.LoopRepeat) {
                this.preservedLoopTime = this.currentAction.time;
            }
            this.currentAction.stop();
        }
    }

    /**
     * Re-anchor the cloned skeleton to the tracked player object's world
     * transform. Called every frame from update(); also exposed so scripted code
     * (e.g. PlayerController.teleportTo during a cutscene, where the per-frame
     * update loop is frozen) can keep the pose source under the moved player —
     * otherwise the block/skinned character renders at the skeleton's stale world
     * position (typically the level origin).
     */
    syncSkeletonToPlayer(): void {
        if (this.skeleton && this.playerPositionRef) {
            this.playerPositionRef.getWorldPosition(this._tempPosition);

            if (DEBUG_SHOW_SKELETON) {
                this.skeleton.position.set(
                    this._tempPosition.x + DEBUG_OFFSET_X,
                    this._tempPosition.y,
                    this._tempPosition.z
                );
            } else {
                this.skeleton.position.copy(this._tempPosition);
            }

            this.playerPositionRef.getWorldQuaternion(this._tempQuaternion);
            this.skeleton.quaternion.copy(this._tempQuaternion);
        }

        if (this.skeleton) {
            this.skeleton.updateMatrixWorld(true);
        }
    }

    /**
     * Update the animation mixer. Call this every frame.
     */
    update(deltaTime: number): void {
        if (this.mixer) {
            this.mixer.update(deltaTime);
        }
        
        // Track animation elapsed time for blend-out timing (respect playback speed)
        const effectiveSpeed = this.currentAction?.getEffectiveTimeScale() ?? 1;
        this.animationElapsed += deltaTime * Math.abs(effectiveSpeed);
        
        // Update blend weight
        this.updateBlendWeight(deltaTime);
        
        // Position skeleton at player location
        this.syncSkeletonToPlayer();

        // Commit this frame's clip-authored root motion to the player (kick
        // step-in etc.). Runs after the matrices above are current.
        if (this.rootMotionCallback && this.skeleton && this.hipsBone) {
            this.applyRootMotion();
        }
    }

    /**
     * Begin committing the clip's root motion. Each subsequent `update` reports
     * the world-space XZ displacement since the previous frame via `callback`
     * (the consumer moves the player by it) and removes that travel from the
     * visible skeleton so the body advances exactly once. Resets the baseline so
     * a re-played clip starts measuring from its own first frame.
     */
    enableRootMotion(callback: (displacement: THREE.Vector3) => void): void {
        this.restoreRootMotion();
        this.rootMotionCallback = callback;
        this.rootMotionBaseline = null;
        this._rmCumulative.set(0, 0, 0);
    }

    /** Stop committing root motion (clip finished / interrupted / not requested). */
    disableRootMotion(): void {
        this.rootMotionCallback = null;
        this.rootMotionBaseline = null;
        this._rmCumulative.set(0, 0, 0);
    }

    /**
     * Extract the clip's hips travel for this frame, report the delta, and shift
     * the skeleton root back by the cumulative travel so the visible body stays
     * put relative to the (separately advancing) player position — no double
     * move, no end-of-clip snap-back. See engine/animation/RootMotion.ts.
     */
    private applyRootMotion(): void {
        const skeleton = this.skeleton!;
        const hips = this.hipsBone!;
        hips.getWorldPosition(this._rmHipsWorld);

        if (!this.rootMotionBaseline) {
            // First frame: capture the rest pose; no travel to report yet.
            this.rootMotionBaseline = captureRootMotionBaseline(skeleton, this._rmHipsWorld);
            return;
        }

        rootMotionWorldTravelXZ(skeleton, this._rmHipsWorld, this.rootMotionBaseline, this._rmTravel);
        this._rmDelta.set(
            this._rmTravel.x - this._rmCumulative.x,
            0,
            this._rmTravel.z - this._rmCumulative.z,
        );
        this._rmCumulative.copy(this._rmTravel);
        this.rootMotionCallback!(this._rmDelta);

        // Consume the cumulative travel from the visible skeleton (re-applied
        // fresh each frame; update() resets skeleton.position next frame).
        skeleton.position.x -= this._rmTravel.x;
        skeleton.position.z -= this._rmTravel.z;
        skeleton.updateMatrixWorld(true);
    }

    /**
     * Update blend weight for smooth transitions.
     */
    private updateBlendWeight(deltaTime: number): void {
        if (this.locomotionMode) {
            this.blendWeight = 1;
            return;
        }

        if (this._holdLastFrame && !this.isBlendingIn) {
            this.blendWeight = 1;
            return;
        }

        // Blend in phase
        if (this.isBlendingIn) {
            if (this.blendInDuration > 0) {
                this.blendWeight += deltaTime / this.blendInDuration;
            } else {
                this.blendWeight = 1;
            }
            
            if (this.blendWeight >= 1) {
                this.blendWeight = 1;
                this.isBlendingIn = false;
            }
        }
        
        // Check if we should start blend-out
        // A looping held action (e.g. minigun fire) does not fade itself away
        // after its first cycle. One-shot fade windows are gameplay seconds,
        // not unscaled clip seconds, so fast/slow attacks retain the same fade.
        if (this.currentAction?.loop === THREE.LoopRepeat) return;
        const speed = Math.abs(this.currentAction?.getEffectiveTimeScale() ?? 1);
        const timeRemaining = speed > 0 ? (this.animationDuration - this.animationElapsed) / speed : Infinity;
        if (!this.isBlendingIn && !this.isBlendingOut && timeRemaining <= this.blendOutDuration) {
            this.isBlendingOut = true;
        }
        
        // Blend out phase
        if (this.isBlendingOut) {
            if (this.blendOutDuration > 0) {
                this.blendWeight -= deltaTime / this.blendOutDuration;
            } else {
                this.blendWeight = 0;
            }
            
            if (this.blendWeight <= 0) {
                this.blendWeight = 0;
            }
        }
    }
    
    /**
     * Get the current blend weight (0 = standard animation, 1 = Mixamo animation).
     */
    getBlendWeight(): number {
        return this.blendWeight;
    }
    
    /**
     * Check if the animation is currently blending (in or out).
     */
    isBlending(): boolean {
        return this.isBlendingIn || this.isBlendingOut;
    }

    /**
     * Get the world position of a bone for a block character part.
     */
    getBoneWorldPosition(partName: string, target: THREE.Vector3): boolean {
        const bone = this.blockPartToBone.get(partName);
        if (!bone) return false;
        bone.getWorldPosition(target);
        return true;
    }

    /**
     * Get the cached contact-frame fraction (0..1) for this clip, or null when
     * no clear strike was detected. Computed once at load.
     */
    getImpactFraction(): number | null {
        return this.impactFraction;
    }

    /**
     * The end-effector that strikes in this clip (e.g. 'rightFoot' / 'leftHand'),
     * or null when no clear strike was detected. Lets contact tests gate on the
     * actual striking limb instead of, say, the planted foot. Detected at load.
     */
    getImpactPart(): string | null {
        return this.impactPart;
    }

    /**
     * Step the clip through `samples` poses via forward kinematics and pick the
     * contact frame from end-effector world-space speed. Restores the action to
     * a clean stopped state afterwards (real play() resets it anyway).
     */
    private detectImpactFraction(samples: number): number | null {
        if (!this.mixer || !this.currentAction || !this.skeleton) return null;
        const duration = this.currentAction.getClip().duration;
        if (duration <= 0 || samples < 3) return null;

        const parts = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'];
        const series = new Map<string, number[]>();
        for (const p of parts) series.set(p, []);
        const prev = new Map<string, THREE.Vector3>();
        const tmp = new THREE.Vector3();
        const hipsPos = new THREE.Vector3();
        const dt = duration / (samples - 1);

        // Activate the action at full weight so setTime() poses the bones.
        this.currentAction.enabled = true;
        this.currentAction.setEffectiveWeight(1);
        this.currentAction.play();

        for (let i = 0; i < samples; i++) {
            this.mixer.setTime(i * dt);
            this.skeleton.updateMatrixWorld(true); // must precede getBoneWorldPosition reads
            // Measure each striking limb RELATIVE TO THE HIPS. Detection runs at
            // load, before any root-motion filtering, so clips that translate the
            // whole body — e.g. mSoccerKick01 steps forward into the ball (played
            // with filterRootMotion:false on purpose) — would otherwise add that
            // constant forward drift to every limb's world speed. That inflates
            // the mean and spawns secondary peaks on the planted foot/hands,
            // defeating pickImpactFraction's peak-to-mean and single-peak gate so
            // a real strike returns null and onImpact never fires (the ball never
            // leaves the foot). A strike is the limb's motion relative to the
            // body, not its world translation. Falls back to world space when the
            // rig has no resolvable hips bone.
            const haveHips = this.hipsBone !== null;
            if (haveHips) this.hipsBone!.getWorldPosition(hipsPos);
            for (const p of parts) {
                if (!this.getBoneWorldPosition(p, tmp)) continue;
                if (haveHips) tmp.sub(hipsPos);
                const cur = tmp.clone();
                const last = prev.get(p);
                if (last) series.get(p)!.push(cur.distanceTo(last) / dt);
                prev.set(p, cur);
            }
        }

        // Leave the player clean for real playback.
        this.currentAction.stop();
        this.mixer.setTime(0);
        this.mixer.update(1e-6);

        const strike = pickImpactStrike(series);
        this.impactPart = strike?.part ?? null;
        return strike?.fraction ?? null;
    }

    /**
     * Get the world quaternion of a bone for a block character part.
     */
    getBoneWorldQuaternion(partName: string, target: THREE.Quaternion): boolean {
        const bone = this.blockPartToBone.get(partName);
        if (!bone) return false;
        bone.getWorldQuaternion(target);
        return true;
    }

    /**
     * Get the skeleton root for adding to scene (hidden).
     */
    getSkeletonRoot(): THREE.Object3D | null {
        return this.skeleton;
    }
    
    /**
     * Get the bone map for use with BlockCharacterRenderer.
     * This allows the standard update logic to read from Mixamo bones.
     */
    getBoneMap(): Map<string, THREE.Bone> {
        return this.boneMap;
    }

    /**
     * Bone names actually animated by the current clip's tracks. Bones not in
     * this set sit at the Mixamo skeleton's bind pose, so consumers blending
     * Mixamo against the standard skeleton should treat them as "no Mixamo
     * contribution" (use 100% standard) to avoid bind-pose leakage.
     */
    getAnimatedBoneNames(): Set<string> {
        const animated = new Set<string>();
        const clip = this.currentAction?.getClip();
        if (!clip) return animated;
        for (const track of clip.tracks) {
            const boneName = trackTargetBone(track.name);
            if (boneName) animated.add(boneName);
        }
        return animated;
    }

    /**
     * Bone names whose pose the current clip DETERMINES: every bone a track
     * animates, plus the joints between them that the clip deliberately leaves
     * still. A joint with an animated joint above AND below it is carried by
     * the one and carries the other, so its world pose is as authored as
     * theirs — "no relative motion here" is the clip's statement, not a gap.
     * A still joint with nothing animated below it (an un-keyed finger, toe or
     * whole limb) is NOT in the set: the clip says nothing about that limb, and
     * its rest pose must not be blended in. Two-track blends use this, not
     * {@link getAnimatedBoneNames}, to decide whether a track contributes a bone.
     */
    getPosedBoneNames(): ReadonlySet<string> {
        return this.posedBoneNames;
    }

    private computePosedBoneNames(): Set<string> {
        const tracked = this.getAnimatedBoneNames();
        const posed = new Set(tracked);
        if (!this.skeleton || tracked.size === 0) return posed;
        /** Returns whether `node` or anything under it is animated. */
        const visit = (node: THREE.Object3D, animatedAbove: boolean): boolean => {
            const animated = tracked.has(node.name);
            let animatedBelow = false;
            for (const child of node.children) {
                if (visit(child, animatedAbove || animated)) animatedBelow = true;
            }
            if (!animated && animatedAbove && animatedBelow && this.boneMap.get(node.name) === node) posed.add(node.name);
            return animated || animatedBelow;
        };
        visit(this.skeleton, false);
        return posed;
    }

    /**
     * Make the joints the two passes in initFromGLTF cannot see part of the
     * clip skeleton: named nodes with a registered bone both above and below.
     *
     * An exporter that drops constant tracks (Uthana does) leaves a joint the
     * motion never turns with no track, and a clip GLB without a skin gives
     * its nodes no bone flag — so such a joint was in neither the bone map nor
     * the rest pose. The character's bone of that name then fell through
     * CharacterLoader.resolveMixamoBone to its substring rule and took ANOTHER
     * bone's pose: `mixamorigSpine2` matched `mixamorigSpine`, and a skinned
     * chest bent 5.7 degrees back against Spine1 on every stride of a walk
     * whose Spine2 never moves (measured 2026-09-18).
     *
     * Only INTERIOR joints: a still joint with no bone below it is a limb the
     * clip does not pose at all, and registering it would hand its rest pose
     * to every blend (see getPosedBoneNames). Those keep resolving as before.
     */
    private registerInteriorJoints(): void {
        if (!this.skeleton) return;
        /** Returns whether `node` or anything under it is a registered bone. */
        const visit = (node: THREE.Object3D, boneAbove: boolean): boolean => {
            const registered = this.boneMap.get(node.name) === node;
            let boneBelow = false;
            for (const child of node.children) {
                if (visit(child, boneAbove || registered)) boneBelow = true;
            }
            if (!registered && boneAbove && boneBelow && node.name && !this.boneMap.has(node.name) && !(node as THREE.Mesh).isMesh) {
                this.boneMap.set(node.name, node as THREE.Bone);
            }
            return registered || boneBelow;
        };
        visit(this.skeleton, false);
    }

    /**
     * Check if animation is currently playing.
     */
    isPlaying(): boolean {
        return this.currentAction?.isRunning() ?? false;
    }

    /**
     * Enable locomotion mode: blend weight locked at 1.0, no blend-out,
     * and root motion (hips XZ position) is filtered from the clip.
     * Also calculates the native root motion speed for animation speed matching.
     */
    setLocomotionMode(enabled: boolean): void {
        this.locomotionMode = enabled;
        if (enabled) {
            this.blendWeight = 1;
            this.isBlendingIn = false;
            this.isBlendingOut = false;
            this.measureAndFilterHipsRootMotion();
        }
    }

    /**
     * When enabled, blend weight stays at 1.0 after blend-in completes and
     * the automatic blend-out is suppressed.  The animation action still
     * clamps on its last frame so the pose is preserved indefinitely.
     */
    setHoldLastFrame(hold: boolean): void {
        this._holdLastFrame = hold;
        if (hold) {
            this.isBlendingOut = false;
        }
    }

    /**
     * Native locomotion speed in m/s, derived from hips XZ root motion displacement.
     * Falls back to designSpeed for in-place animations.
     * Only valid after setLocomotionMode(true).
     */
    getNativeLocomotionSpeed(): number {
        // Use root motion speed if available, otherwise fall back to designSpeed
        return this.nativeLocomotionSpeed > 0.1 ? this.nativeLocomotionSpeed : this.designSpeed;
    }

    /**
     * Set the design speed for in-place animations (m/s at which the animation looks natural).
     */
    setDesignSpeed(speed: number): void {
        this.designSpeed = speed;
    }

    /**
     * Find the hips/pelvis position track on the current clip, if any.
     */
    private findHipsPositionTrack(): THREE.KeyframeTrack | null {
        const clip = this.currentAction?.getClip();
        if (!clip) return null;
        return clip.tracks.find(track => {
            if (!track.name.endsWith('.position')) return false;
            const lower = track.name.toLowerCase();
            return lower.includes('hips') || lower.includes('pelvis');
        }) ?? null;
    }

    /**
     * Measure the hips XZ root motion distance (for speed matching), then remove
     * net linear travel so root motion doesn't fight code movement while the
     * clip's cyclic sway survives. Idempotent — the measurement is taken on the FIRST call before
     * we filter the track. Subsequent calls would read zero displacement from
     * the already-filtered values; we skip those so the original measured speed
     * is preserved for accurate movement-speed matching across re-activations.
     */
    private measureAndFilterHipsRootMotion(): void {
        const track = this.findHipsPositionTrack();
        if (!track) return;
        const values = track.values;
        if (values.length < 6) return;

        // Already measured + filtered — preserve the original native speed value.
        if (this.nativeLocomotionSpeed > 0) { removeLinearRootTravel(track); return; }

        const firstX = values[0]!;
        const firstZ = values[2]!;
        const lastX = values[values.length - 3]!;
        const lastZ = values[values.length - 1]!;

        // XZ displacement in Mixamo units (centimeters), converted to meters
        const dx = (lastX - firstX) * MIXAMO_CM_TO_M;
        const dz = (lastZ - firstZ) * MIXAMO_CM_TO_M;
        const distance = Math.sqrt(dx * dx + dz * dz);

        // Account for character height scaling
        const duration = this.currentAction!.getClip().duration;
        const heightScale = this.targetCharacterHeight / MIXAMO_DEFAULT_HEIGHT;
        this.nativeLocomotionSpeed = duration > 0 ? (distance * heightScale) / duration : 0;

        // Remove only net locomotion. Locking every sample to the first frame
        // also deletes the pelvis sway that the planted legs counterbalance.
        removeLinearRootTravel(track);
    }

    /**
     * Remove net hips XZ travel while retaining vertical motion and cyclic
     * sway. Use for one-shot moves
     * (flips, dodges) where the character's translation is owned by physics
     * or other game logic, not the clip.
     */
    filterAllRootMotion(): void {
        this.restoreRootMotion();
        const track = this.findHipsPositionTrack();
        if (!track) return;
        const values = track.values;
        if (values.length < 3) return;
        // Remove net XZ travel, retaining cyclic sway. Filtering stops a clip's
        // LOCOMOTION — hips travel across the ground plane — from dragging a
        // character whose position physics owns. Vertical hips motion is not
        // locomotion, it is animation: the dip that loads an uppercut, the
        // 40cm crouch under a leg sweep, the sink into a kick's counter-lean.
        // Flattening Y too (as this did originally) silently deleted all of
        // those on every filtered clip — the strike clips previewed correctly
        // and then played standing bolt upright in game.
        removeLinearRootTravel(track);
    }

    /** Switching a cached player between in-place and committed motion must not
     * permanently destroy its source track. */
    restoreRootMotion(): void {
        const track = this.findHipsPositionTrack();
        if (track && this.originalHipsValues) track.values.set(this.originalHipsValues);
    }

    /** Match a left-foot contact, not the arbitrary frame-zero of another clip.
     * Only ground locomotion callers invoke this; idles/jumps never participate. */
    synchronizeLocomotionFrom(other: MixamoAnimationPlayer): void {
        const from = other.getLocomotionContactPhase();
        const to = this.getLocomotionContactPhase();
        if (from === null || to === null || other.getDuration() <= 0) return;
        const phase = other.getTime() / other.getDuration() - from + to;
        this.setTime(((phase % 1 + 1) % 1) * this.getDuration());
    }

    getLocomotionContactPhase(): number | null {
        if (this.leftContactPhase !== null) return this.leftContactPhase;
        if (!this.currentAction || !this.mixer || !this.skeleton) return null;
        const foot = this.blockPartToBone.get('leftFoot');
        if (!foot || !this.hipsBone) return null;
        const time = this.getTime();
        const duration = this.getDuration();
        const samples: { y: number; phase: number }[] = [];
        const p = new THREE.Vector3();
        let minY = Infinity;
        for (let i = 0; i < 48; i++) {
            this.setTime(duration * i / 48);
            this.skeleton.updateMatrixWorld(true);
            foot.getWorldPosition(p);
            // Character-local coordinates remove world position/facing/scale.
            this.skeleton.worldToLocal(p);
            minY = Math.min(minY, p.y);
            samples.push({ y: p.y, phase: i / 48 });
        }
        this.setTime(time);
        this.skeleton.updateMatrixWorld(true);
        // Landing is direction-independent: use descent into the contact
        // band, not "furthest +Z", which reverses backpedals and misreads strafes.
        const contact = samples.map((s, i) => ({ ...s,
            descent: samples[(i + samples.length - 1) % samples.length]!.y - s.y }))
            .filter(s => s.y <= minY + 3).sort((a, b) => b.descent - a.descent)[0];
        this.leftContactPhase = contact?.phase ?? 0;
        return this.leftContactPhase;
    }

    /**
     * Configure loop mode. Locomotion overrides need LoopRepeat.
     */
    setLoop(loop: boolean): void {
        if (!this.currentAction) return;
        this.currentAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
        this.currentAction.clampWhenFinished = !loop;
    }

    /**
     * Set playback speed. 0 = paused (frozen on current frame), 1 = normal, 2 = double speed, etc.
     */
    setSpeed(speed: number): void {
        if (this.currentAction) {
            this.currentAction.setEffectiveTimeScale(speed);
        }
    }

    /**
     * Get current playback speed.
     */
    getSpeed(): number {
        return this.currentAction?.getEffectiveTimeScale() ?? 1;
    }

    /**
     * Seek the animation to a specific time in seconds.
     * Combine with setSpeed(0) to hold on an arbitrary frame.
     *
     * Flushes the mixer with update(0) so bone transforms reflect the new
     * time immediately, regardless of frame update ordering.
     */
    setTime(time: number): void {
        if (this.currentAction) {
            this.currentAction.time = time;
            this.mixer?.update(0);
        }
    }

    /**
     * Get the current playback time in seconds.
     */
    getTime(): number {
        return this.currentAction?.time ?? 0;
    }

    /**
     * Get animation duration.
     */
    getDuration(): number {
        return this.currentAction?.getClip().duration ?? 0;
    }

    /**
     * Human-readable label for logging (typically the motionId).
     */
    setAnimationName(name: string): void {
        this.animationLabel = name;
    }

    getAnimationName(): string {
        return this.animationLabel || this.currentAction?.getClip().name || 'unknown';
    }

    /**
     * Record every bone's rest rotation (root frame) and the rest hips height
     * above the lowest foot joint. Called once at load; see the field docs.
     */
    private captureRestPose(): void {
        if (!this.skeleton) return;
        this.skeleton.updateMatrixWorld(true);
        const rootQuatInv = new THREE.Quaternion();
        this.skeleton.getWorldQuaternion(rootQuatInv).invert();
        const rootPos = new THREE.Vector3();
        this.skeleton.getWorldPosition(rootPos);

        this.restRotations.clear();
        this.footBones = [];
        const q = new THREE.Quaternion();
        const p = new THREE.Vector3();
        let lowestFoot = Infinity;
        for (const [name, bone] of this.boneMap) {
            bone.getWorldQuaternion(q);
            this.restRotations.set(name, rootQuatInv.clone().multiply(q));
            const lower = name.toLowerCase();
            if (lower.includes('foot') || lower.includes('toe') || lower.includes('ball_')) {
                this.footBones.push(bone);
                bone.getWorldPosition(p);
                if (p.y < lowestFoot) lowestFoot = p.y;
            }
        }
        this.restFeetLevel = lowestFoot === Infinity ? 0 : lowestFoot - rootPos.y;
        if (this.hipsBone) {
            this.hipsBone.getWorldPosition(p);
            this.restHipsOffset = p.sub(rootPos).applyQuaternion(rootQuatInv);
        } else {
            this.restHipsOffset = null;
        }
    }

    /**
     * Where the hips sit at REST relative to the skeleton root, in the root's
     * own frame and in world units. Subtracting it from a posed hips position
     * (in the same frame) leaves the clip's authored hips travel — the sway and
     * weight shift a rotation-only retarget would otherwise turn into sliding
     * feet. Null when the rig has no hips bone.
     */
    getRestHipsOffset(): THREE.Vector3 | null {
        return this.restHipsOffset;
    }

    /** Rest rotation of every clip-skeleton bone in the skeleton root's frame, keyed by bone name. */
    getRestRotations(): ReadonlyMap<string, THREE.Quaternion> {
        return this.restRotations;
    }

    /**
     * How far the clip lifts BOTH feet off its own rest foot level this frame,
     * in world units — 0 whenever any foot is planted (every walk, idle and
     * turn), positive only during a run's flight or a jump. This is the
     * authored vertical a foot-planting render path would otherwise delete.
     * Null when the clip skeleton has no foot bones to measure.
     *
     * Both skeletons are scaled to the same character height, so the value
     * transfers to a rig with no conversion. Reads the skeleton as posed by the
     * last update(); root motion only ever touches XZ.
     */
    getAuthoredFootLift(): number | null {
        if (!this.skeleton || this.footBones.length === 0) return null;
        let lowest = Infinity;
        for (const bone of this.footBones) {
            bone.getWorldPosition(this._footScratch);
            if (this._footScratch.y < lowest) lowest = this._footScratch.y;
        }
        if (lowest === Infinity) return null;
        this.skeleton.getWorldPosition(this._footScratch);
        return Math.max(0, lowest - this._footScratch.y - this.restFeetLevel);
    }

    /**
     * Build the set of bone names needed for block character animation.
     * Includes all bones mapped in blockPartToBone plus their ancestors
     * up to the skeleton root. Bones outside this set (fingers, toes,
     * end-effectors) can be safely stripped and pruned.
     */
    private buildNeededBoneSet(): Set<string> {
        const needed = new Set<string>();

        for (const bone of this.blockPartToBone.values()) {
            let current: THREE.Object3D | null = bone;
            while (current && current !== this.skeleton) {
                needed.add(current.name);
                current = current.parent;
            }
        }

        if (this.hipsBone) {
            let current: THREE.Object3D | null = this.hipsBone;
            while (current && current !== this.skeleton) {
                needed.add(current.name);
                current = current.parent;
            }
        }

        return needed;
    }

    /**
     * Remove animation tracks targeting bones outside the needed set.
     * Eliminates per-frame interpolation work for ~40-50 finger/toe/end bones.
     */
    private stripUnusedTracks(animations: THREE.AnimationClip[], neededBones: Set<string>): void {
        for (const clip of animations) {
            clip.tracks = clip.tracks.filter(track => {
                const boneName = trackTargetBone(track.name);
                // Tracks with no clear bone target are kept untouched.
                return boneName === null || neededBones.has(boneName);
            });
        }
    }

    /**
     * Recursively remove bone subtrees that contain no needed bones.
     * Reduces the node count traversed by updateMatrixWorld.
     */
    private pruneUnneededSubtrees(neededBones: Set<string>): void {
        if (!this.skeleton) return;

        const prune = (node: THREE.Object3D): boolean => {
            let keep = neededBones.has(node.name) || (node as THREE.Mesh).isMesh;

            for (let i = node.children.length - 1; i >= 0; i--) {
                if (prune(node.children[i]!)) {
                    keep = true;
                } else {
                    node.children.splice(i, 1);
                }
            }

            return keep;
        };

        prune(this.skeleton);
    }

    /**
     * Dispose resources.
     */
    dispose(): void {
        if (this.mixer) {
            this.mixer.stopAllAction();
        }
        // Remove from scene
        if (this.skeleton && this.scene) {
            this.scene.remove(this.skeleton);
        }
        if (this.skeleton) {
            this.skeleton.traverse(child => {
                if ((child as THREE.Mesh).geometry) {
                    (child as THREE.Mesh).geometry.dispose();
                }
            });
        }
        this.skeleton = null;
        this.mixer = null;
        this.currentAction = null;
        this.boneMap.clear();
        this.blockPartToBone.clear();
        this.restRotations.clear();
        this.posedBoneNames.clear();
        this.footBones = [];
    }
}
