import * as THREE from 'three';
import type { BaseAnimationDefinition } from 'types/game.js';

/**
 * Animal Animation Controller - Procedural Animations for 4-Legged Animals
 * 
 * Generates rudimentary animations in code for animals without requiring GLB animation files.
 * Creates basic quadrupedal movement: idle, walk, trot, run.
 * 
 * This is a simplified animation system that manipulates bone rotations directly
 * using procedural logic (sine waves, timing) rather than keyframe animations.
 */
export class AnimalAnimationController {
    private character: THREE.Object3D | null = null;
    private boneMap: Map<string, THREE.Bone> = new Map();
    private animationTime: number = 0;
    private currentState: AnimalAnimationState = AnimalAnimationState.IDLE;
    private isInitialized: boolean = false;

    // Bone name patterns to search for (common animal skeleton naming)
    private bonePatterns = {
        root: ['Hips', 'Root', 'root', 'mixamorigHips', 'Pelvis'],
        spine: ['Spine', 'spine', 'spine1', 'spine2', 'mixamorigSpine'],
        head: ['Head', 'head', 'mixamorigHead'],
        // Front legs
        frontLeftShoulder: ['LeftShoulder', 'left_shoulder', 'L_Shoulder', 'mixamorigLeftShoulder'],
        frontLeftElbow: ['LeftElbow', 'left_elbow', 'L_Elbow', 'mixamorigLeftForeArm'],
        frontLeftPaw: ['LeftHand', 'left_hand', 'L_Hand', 'mixamorigLeftHand'],
        frontRightShoulder: ['RightShoulder', 'right_shoulder', 'R_Shoulder', 'mixamorigRightShoulder'],
        frontRightElbow: ['RightElbow', 'right_elbow', 'R_Elbow', 'mixamorigRightForeArm'],
        frontRightPaw: ['RightHand', 'right_hand', 'R_Hand', 'mixamorigRightHand'],
        // Back legs
        backLeftHip: ['LeftUpLeg', 'left_hip', 'L_Hip', 'mixamorigLeftUpLeg'],
        backLeftKnee: ['LeftLeg', 'left_knee', 'L_Knee', 'mixamorigLeftLeg'],
        backLeftPaw: ['LeftFoot', 'left_foot', 'L_Foot', 'mixamorigLeftFoot'],
        backRightHip: ['RightUpLeg', 'right_hip', 'R_Hip', 'mixamorigRightUpLeg'],
        backRightKnee: ['RightLeg', 'right_knee', 'R_Knee', 'mixamorigRightLeg'],
        backRightPaw: ['RightFoot', 'right_foot', 'R_Foot', 'mixamorigRightFoot'],
    };

    // Animation parameters
    private animationParams = {
        idle: {
            bodyBob: { amplitude: 0.02, frequency: 1.5 }, // Breathing motion
            headBob: { amplitude: 0.01, frequency: 1.0 },
            tailSway: { amplitude: 0.1, frequency: 0.8 }
        },
        walk: {
            cycleSpeed: 2.0, // Steps per second
            legSwing: { amplitude: 0.4, offset: 0 }, // Leg swing angle
            bodyBob: { amplitude: 0.05, frequency: 2.0 },
            stride: 0.15 // How far legs swing
        },
        trot: {
            cycleSpeed: 3.5,
            legSwing: { amplitude: 0.5, offset: 0 },
            bodyBob: { amplitude: 0.08, frequency: 3.5 },
            stride: 0.2
        },
        run: {
            cycleSpeed: 5.0,
            legSwing: { amplitude: 0.7, offset: 0 },
            bodyBob: { amplitude: 0.12, frequency: 5.0 },
            stride: 0.3
        }
    };

    /**
     * Initialize with character skeleton
     */
    async initializeWithCharacter(character: THREE.Object3D, gltf: any, loader: any, baseAnimations: BaseAnimationDefinition[]): Promise<void> {
        this.character = character;
        this.buildBoneMap(character);
        this.isInitialized = true;
        console.log('✅ AnimalAnimationController: Initialized with', this.boneMap.size, 'bones');
    }

    /**
     * Build map of bones by searching for common animal bone names
     */
    private buildBoneMap(character: THREE.Object3D): void {
        const allBones: THREE.Bone[] = [];
        character.traverse((child: THREE.Object3D) => {
            if ((child as any).isBone) {
                allBones.push(child as THREE.Bone);
            }
        });

        // Try to find bones matching our patterns
        for (const [key, patterns] of Object.entries(this.bonePatterns)) {
            for (const pattern of patterns) {
                const bone = allBones.find(b => 
                    b.name.toLowerCase() === pattern.toLowerCase() ||
                    b.name.includes(pattern) ||
                    b.name.toLowerCase().includes(pattern.toLowerCase())
                );
                if (bone) {
                    this.boneMap.set(key, bone);
                    break;
                }
            }
        }

        // Log found bones for debugging
        console.log('AnimalAnimationController: Found bones:', Array.from(this.boneMap.keys()));
    }

    /**
     * Update animation based on movement state
     * Compatible with CharacterAnimationController interface
     */
    updateAnimation(isMoving: boolean, movementSpeed: number, isGrounded: boolean, isJumpPressed: boolean): void {
        if (!this.isInitialized || !this.character) return;

        // Determine animation state based on movement
        if (!isMoving || !isGrounded) {
            this.currentState = AnimalAnimationState.IDLE;
        } else if (movementSpeed < 2.5) {
            this.currentState = AnimalAnimationState.WALK;
        } else if (movementSpeed < 4.5) {
            this.currentState = AnimalAnimationState.TROT;
        } else {
            this.currentState = AnimalAnimationState.RUN;
        }
    }

    /**
     * Update animation every frame
     */
    update(deltaTime: number): void {
        if (!this.isInitialized || !this.character) return;

        this.animationTime += deltaTime;

        switch (this.currentState) {
            case AnimalAnimationState.IDLE:
                this.updateIdleAnimation(deltaTime);
                break;
            case AnimalAnimationState.WALK:
                this.updateWalkAnimation(deltaTime);
                break;
            case AnimalAnimationState.TROT:
                this.updateTrotAnimation(deltaTime);
                break;
            case AnimalAnimationState.RUN:
                this.updateRunAnimation(deltaTime);
                break;
        }
    }

    /**
     * Idle animation - breathing, slight head movement
     */
    private updateIdleAnimation(deltaTime: number): void {
        const params = this.animationParams.idle;
        const t = this.animationTime;

        // Body breathing (spine)
        const spine = this.boneMap.get('spine');
        if (spine) {
            const bob = Math.sin(t * params.bodyBob.frequency) * params.bodyBob.amplitude;
            spine.rotation.x += (bob - spine.rotation.x) * 0.1;
        }

        // Head movement
        const head = this.boneMap.get('head');
        if (head) {
            const bob = Math.sin(t * params.headBob.frequency) * params.headBob.amplitude;
            head.rotation.x += (bob - head.rotation.x) * 0.1;
        }
    }

    /**
     * Walk animation - slow quadrupedal gait
     */
    private updateWalkAnimation(deltaTime: number): void {
        this.updateQuadrupedalGait(this.animationParams.walk);
    }

    /**
     * Trot animation - medium speed quadrupedal gait
     */
    private updateTrotAnimation(deltaTime: number): void {
        this.updateQuadrupedalGait(this.animationParams.trot);
    }

    /**
     * Run animation - fast quadrupedal gait
     */
    private updateRunAnimation(deltaTime: number): void {
        this.updateQuadrupedalGait(this.animationParams.run);
    }

    /**
     * Generic quadrupedal gait animation
     * Uses diagonal leg pairs: front-left + back-right, front-right + back-left
     */
    private updateQuadrupedalGait(params: typeof this.animationParams.walk): void {
        const t = this.animationTime * params.cycleSpeed;
        const phase = t * Math.PI * 2; // Full cycle

        // Diagonal leg pairs move together (trot gait)
        // Front-left + Back-right
        const leftPhase = phase;
        // Front-right + Back-left (opposite phase)
        const rightPhase = phase + Math.PI;

        // Front left leg
        this.animateLeg(
            this.boneMap.get('frontLeftShoulder'),
            this.boneMap.get('frontLeftElbow'),
            this.boneMap.get('frontLeftPaw'),
            leftPhase,
            params
        );

        // Front right leg
        this.animateLeg(
            this.boneMap.get('frontRightShoulder'),
            this.boneMap.get('frontRightElbow'),
            this.boneMap.get('frontRightPaw'),
            rightPhase,
            params
        );

        // Back left leg
        this.animateLeg(
            this.boneMap.get('backLeftHip'),
            this.boneMap.get('backLeftKnee'),
            this.boneMap.get('backLeftPaw'),
            rightPhase,
            params
        );

        // Back right leg
        this.animateLeg(
            this.boneMap.get('backRightHip'),
            this.boneMap.get('backRightKnee'),
            this.boneMap.get('backRightPaw'),
            leftPhase,
            params
        );

        // Body bob (up and down with gait)
        const spine = this.boneMap.get('spine');
        if (spine) {
            const bob = Math.sin(phase) * params.bodyBob.amplitude;
            // Smooth interpolation to avoid jitter
            const targetRotation = bob;
            spine.rotation.x += (targetRotation - spine.rotation.x) * 0.2;
        }

        // Root bone slight rotation for body movement (with heavy damping on z-axis)
        const root = this.boneMap.get('root');
        if (root) {
            const bodySway = Math.sin(phase * 0.5) * 0.05;
            // Use much slower interpolation (0.05 instead of 0.1) to reduce vibration
            root.rotation.z += (bodySway - root.rotation.z) * 0.05;
        }
    }

    /**
     * Animate a single leg (shoulder/hip, elbow/knee, paw/foot)
     */
    private animateLeg(
        upperBone: THREE.Bone | undefined,
        middleBone: THREE.Bone | undefined,
        lowerBone: THREE.Bone | undefined,
        phase: number,
        params: typeof this.animationParams.walk
    ): void {
        // Leg swing (forward/back)
        const swing = Math.sin(phase) * params.legSwing.amplitude;
        
        // Leg lift (up/down during stride)
        const lift = Math.max(0, Math.sin(phase)) * params.stride;

        if (upperBone) {
            // Shoulder/hip rotates forward/back
            upperBone.rotation.x = swing * 0.5;
            
            // Apply z-rotation with smoothing to reduce vibration
            const targetZRotation = lift * 0.3;
            // Use lerp/smoothing with factor 0.15 for slower, smoother movement
            upperBone.rotation.z += (targetZRotation - upperBone.rotation.z) * 0.15;
        }

        if (middleBone) {
            // Elbow/knee bends when leg is lifted
            middleBone.rotation.x = lift * 1.5;
        }

        if (lowerBone) {
            // Paw/foot stays relatively flat
            lowerBone.rotation.x = -lift * 0.5;
        }
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.boneMap.clear();
        this.character = null;
        this.isInitialized = false;
    }
}

/**
 * Animal animation states
 */
export enum AnimalAnimationState {
    IDLE = 'idle',
    WALK = 'walk',
    TROT = 'trot',
    RUN = 'run'
}

