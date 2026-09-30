import * as THREE from 'three';

/**
 * Block Animal Animation Controller - Procedural Animations for Box-Based Animals
 * 
 * This animates animals built from primitive box geometries (not skeletal meshes).
 * Supports both quadrupeds (4-legged) and bipeds (2-legged like birds).
 * 
 * Creates lifelike movement through:
 * - Leg rotations for walking/running gaits (quadruped or biped)
 * - Wing flapping for birds and dragons
 * - Body bobbing and breathing
 * - Head movement (pecking for birds)
 * - Tail wagging/feather animation
 * - Squash & stretch effects
 * 
 * Works with mesh names from AnimalCustomization.ts:
 * - FrontLeftLeg, FrontRightLeg, BackLeftLeg, BackRightLeg (quadrupeds)
 * - BackLeftLeg, BackRightLeg (bipeds - birds only have back legs)
 * - LeftWing, RightWing (winged creatures)
 * - AnimalBody, AnimalHead, AnimalTail
 */
export class BlockAnimalAnimationController {
    private character: THREE.Object3D | null = null;
    
    // Cached mesh references (found by name)
    private body: THREE.Object3D | null = null;
    private head: THREE.Object3D | null = null;
    private tail: THREE.Object3D | null = null;
    private frontLeftLeg: THREE.Object3D | null = null;
    private frontRightLeg: THREE.Object3D | null = null;
    private backLeftLeg: THREE.Object3D | null = null;
    private backRightLeg: THREE.Object3D | null = null;
    private leftWing: THREE.Object3D | null = null;
    private rightWing: THREE.Object3D | null = null;
    private leftWingOuter: THREE.Object3D | null = null;
    private rightWingOuter: THREE.Object3D | null = null;
    private leftFin: THREE.Object3D | null = null;
    private rightFin: THREE.Object3D | null = null;
    private dorsalFin: THREE.Object3D | null = null;
    private tailFin: THREE.Object3D | null = null;
    /** Ring tentacles (Tentacle0..N-1), indexed for phase-offset undulation. */
    private tentacles: THREE.Object3D[] = [];
    /** Squid feeding pair (LongTentacle0/1) — streams behind instead of waving. */
    private longTentacles: THREE.Object3D[] = [];

    // Creature type detection
    private isBiped: boolean = false;
    private hasWings: boolean = false;
    private isFish: boolean = false;
    /** Flying quadruped (dragon plan): flight uses heavier wing-beat params. */
    private isQuadrupedFlyer: boolean = false;
    /** Legless swimmer with tentacles (octopus/squid): pulse-jet animation. */
    private isCephalopod: boolean = false;
    /** How this creature traverses the world ('ground' | 'swim' | 'fly'), stamped by the builder. */
    private locomotionMode: 'ground' | 'swim' | 'fly' = 'ground';

    // Animation state
    private animationTime: number = 0;
    private currentState: BlockAnimalAnimationState = BlockAnimalAnimationState.IDLE;
    private isInitialized: boolean = false;

    // ── Motion hints (self-derived; no extra integration calls needed) ──
    // Tracked from the character root's transform deltas each update and
    // smoothed. Drive banking (roll into turns) and pitch (climb/dive).
    private lastYaw: number | null = null;
    private lastY: number | null = null;
    /** Smoothed yaw rate in rad/s (positive = turning left). */
    private turnRate: number = 0;
    /** Smoothed vertical velocity in m/s (positive = rising). */
    private verticalVelocity: number = 0;
    /** Smoothed flap blend for birds: 1 = full flap, 0 = glide. */
    private flapWeight: number = 1;
    /** Smoothed leg-tuck blend for birds: 1 = tucked (flying), 0 = standing. */
    private legTuckWeight: number = 0;
    /** Smoothed pectoral-fin tuck blend for fish: 1 = tucked (sprinting). */
    private finTuckWeight: number = 0;
    
    // Smoothing factor for interpolation (0.1 = slow/smooth, 0.5 = fast/responsive)
    private readonly SMOOTH_FACTOR = 0.15;
    private readonly SCALE_SMOOTH_FACTOR = 0.1;  // Even slower for scale to avoid vibration
    
    // Current smoothed values (to lerp towards targets)
    private smoothedBodyY: number = 0;
    private smoothedBodyScale: THREE.Vector3 = new THREE.Vector3(1, 1, 1);
    private smoothedLegPositions: Map<THREE.Object3D, number> = new Map();
    private smoothedLegScales: Map<THREE.Object3D, number> = new Map();
    
    // Store original transforms for reset
    private originalTransforms: Map<THREE.Object3D, { 
        position: THREE.Vector3; 
        rotation: THREE.Euler; 
        scale: THREE.Vector3 
    }> = new Map();
    
    // Animation parameters for different states
    private animationParams = {
        idle: {
            // Breathing - gentle body scale
            bodyBreath: { amplitude: 0.02, frequency: 1.2 },
            // Head subtle look-around
            headBob: { amplitude: 0.03, frequency: 0.8 },
            headTurn: { amplitude: 0.1, frequency: 0.5 },
            // Tail gentle sway
            tailWag: { amplitude: 0.15, frequency: 1.0 },
            // Wing fold/ruffle
            wingRuffle: { amplitude: 0.05, frequency: 0.5 }
        },
        walk: {
            cycleSpeed: 3.0,        // Full gait cycles per second
            legSwing: 0.35,         // Max leg rotation (radians)
            legLift: 0.08,          // Leg lift during swing (reduced)
            bodyBob: 0.015,         // Body vertical bob (reduced - was causing vibration)
            bodyRoll: 0.015,        // Body side-to-side (reduced)
            bodyStretch: 0.008,     // Squash/stretch amplitude (reduced)
            headBob: 0.02,          // Head follows body (reduced)
            tailWag: 0.25,          // Tail wag amplitude
            wingFlap: 0.1           // Slight wing movement while walking
        },
        trot: {
            cycleSpeed: 5.0,
            legSwing: 0.5,
            legLift: 0.12,          // Reduced
            bodyBob: 0.025,         // Reduced
            bodyRoll: 0.02,         // Reduced
            bodyStretch: 0.012,     // Reduced
            headBob: 0.03,          // Reduced
            tailWag: 0.35,
            wingFlap: 0.2
        },
        run: {
            cycleSpeed: 8.0,
            legSwing: 0.7,
            legLift: 0.18,          // Reduced
            bodyBob: 0.04,          // Reduced (was 0.08)
            bodyRoll: 0.025,        // Reduced
            bodyStretch: 0.02,      // Reduced (was 0.04)
            headBob: 0.04,          // Reduced
            tailWag: 0.5,
            wingFlap: 0.6           // Wings flap more when running
        },
        // Fish swimming parameters (tail-sweep frequency scales with state)
        swim: {
            tailFrequency: 1.6,     // Tail sweeps per second
            tailAmplitude: 0.28,    // Tail yaw sweep (radians)
            tailFinLag: 0.7,        // Phase lag of the caudal fin behind the tail (radians)
            bodySway: 0.07,         // Body counter-yaw amplitude
            finFlutter: 0.3,        // Pectoral fin oscillation amplitude
            finFrequency: 1.6,      // Pectoral fin beats per second
            dorsalSway: 0.12,       // Dorsal fin follow amplitude
            hoverBob: 0,            // No idle bob while actively swimming
        },
        swimFast: {
            tailFrequency: 3.4,
            tailAmplitude: 0.42,
            tailFinLag: 0.9,
            bodySway: 0.1,
            finFlutter: 0.12,       // Fins mostly tucked at speed
            finFrequency: 2.4,
            dorsalSway: 0.16,
            hoverBob: 0,
        },
        swimIdle: {
            tailFrequency: 0.7,     // Lazy hover sweeps
            tailAmplitude: 0.14,
            tailFinLag: 0.5,
            bodySway: 0.035,
            finFlutter: 0.4,        // Fins paddle gently while hovering
            finFrequency: 1.0,
            dorsalSway: 0.08,
            hoverBob: 0.015,        // Gentle vertical drift (visual group only)
        },
        // Cephalopod (octopus/squid) swimming — mantle pulse-jet + tentacle wave
        cephalopodIdle: {
            pulseFrequency: 0.7,    // Slow resting mantle pulse (Hz)
            pulseAmplitude: 0.04,   // Mantle squash/stretch scale
            tentacleWave: 0.2,      // Tentacle undulation amplitude (radians)
            tentacleFrequency: 0.6, // Waves per second
            trail: 0.06,            // How far tentacles sweep back (radians)
            forwardTilt: 0,         // Body pitch into the motion
            hoverBob: 0.02,         // Gentle vertical drift while hovering
        },
        cephalopodSwim: {
            pulseFrequency: 1.5,
            pulseAmplitude: 0.09,
            tentacleWave: 0.3,
            tentacleFrequency: 1.3,
            trail: 0.5,
            forwardTilt: 0.35,
            hoverBob: 0,
        },
        cephalopodSwimFast: {
            pulseFrequency: 2.5,
            pulseAmplitude: 0.13,
            tentacleWave: 0.16,     // Streamlined — less wave, more trail
            tentacleFrequency: 2.0,
            trail: 0.9,
            forwardTilt: 0.55,
            hoverBob: 0,
        },
        // Bird flight parameters
        flight: {
            flapFrequency: 3.2,     // Wing beats per second at full flap
            flapAmplitude: 0.85,    // Inner wing stroke (radians)
            outerLag: 0.55,         // Outer segment phase lag (radians)
            outerAmplitudeScale: 1.5, // Outer segment exaggerates the stroke
            strokeSkew: 0.35,       // Phase warp — downstroke faster than upstroke
            glideDihedral: 0.1,     // Slight upward V while gliding
            legTuck: 1.1,           // Legs rotate back this far in flight (radians)
            tailElevatorGain: 0.18, // Tail pitch per m/s of vertical velocity
            bodyPitchGain: 0.1,     // Body pitch per m/s of vertical velocity
            bodyBankGain: 0.4,      // Body roll per rad/s of turn rate
        },
        // Dragon flight: a winged quadruped reads as MASSIVE — wing beats are
        // slower and deeper, glides are flatter, legs trail rather than tuck,
        // and the long tail does more of the steering.
        dragonFlight: {
            flapFrequency: 1.7,
            flapAmplitude: 1.0,
            outerLag: 0.7,          // Long wings — tip trails the root further
            outerAmplitudeScale: 1.6,
            strokeSkew: 0.4,        // Powerful downstroke
            glideDihedral: 0.05,    // Near-flat soar
            legTuck: 0.7,           // Legs trail beneath, not fully folded
            tailElevatorGain: 0.25,
            bodyPitchGain: 0.12,
            bodyBankGain: 0.45,
        },
        // Special biped (bird) parameters
        bipedWalk: {
            cycleSpeed: 4.0,
            legSwing: 0.5,
            legLift: 0.15,          // Reduced
            bodyBob: 0.025,         // Reduced (was 0.06)
            bodyRoll: 0.03,         // Reduced - waddle for birds
            bodyStretch: 0.01,      // Reduced
            headBob: 0.06,          // Reduced - bird head bobs (pecking motion)
            tailWag: 0.15,
            wingFlap: 0.15
        },
        bipedRun: {
            cycleSpeed: 7.0,
            legSwing: 0.7,
            legLift: 0.25,          // Reduced
            bodyBob: 0.05,          // Reduced (was 0.1)
            bodyRoll: 0.05,         // Reduced
            bodyStretch: 0.015,     // Reduced
            headBob: 0.08,          // Reduced
            tailWag: 0.3,
            wingFlap: 0.8           // Wings flap a lot when running
        },
        // Flying animation (for eagles, dragons in flight)
        flying: {
            wingFlap: 1.2,          // Full wing flap amplitude
            wingSpeed: 3.0,         // Flaps per second
            bodyUndulate: 0.05,     // Body wave motion
            tailFlow: 0.3           // Tail follows body
        }
    };

    /**
     * Initialize with the animal's character group
     */
    async initializeWithCharacter(
        character: THREE.Object3D, 
        _gltf: unknown, 
        _loader: unknown, 
        _baseAnimations: unknown[]
    ): Promise<void> {
        this.character = character;
        this.findMeshParts(character);
        this.detectCreatureType();
        this.storeOriginalTransforms();
        this.isInitialized = true;
        
        const type = this.isBiped ? 'biped' : 'quadruped';
        const wings = this.hasWings ? ' with wings' : '';
        console.log(`✅ BlockAnimalAnimationController: Initialized ${type}${wings}`);
    }

    /**
     * Find all the animal mesh parts by name
     */
    private findMeshParts(root: THREE.Object3D): void {
        root.traverse((child: THREE.Object3D) => {
            // The builder stamps the resolved body plan / locomotion mode on the
            // character group it populated — pick it up wherever it sits.
            if (child.userData.locomotionMode === 'swim' || child.userData.locomotionMode === 'fly' || child.userData.locomotionMode === 'ground') {
                this.locomotionMode = child.userData.locomotionMode;
            }
            switch (child.name) {
                case 'AnimalBody':
                    this.body = child;
                    break;
                case 'AnimalHead':
                    this.head = child;
                    break;
                case 'AnimalTail':
                    this.tail = child;
                    break;
                case 'FrontLeftLeg':
                    this.frontLeftLeg = child;
                    break;
                case 'FrontRightLeg':
                    this.frontRightLeg = child;
                    break;
                case 'BackLeftLeg':
                    this.backLeftLeg = child;
                    break;
                case 'BackRightLeg':
                    this.backRightLeg = child;
                    break;
                case 'LeftWing':
                    this.leftWing = child;
                    break;
                case 'RightWing':
                    this.rightWing = child;
                    break;
                case 'LeftWingOuter':
                    this.leftWingOuter = child;
                    break;
                case 'RightWingOuter':
                    this.rightWingOuter = child;
                    break;
                case 'LeftFin':
                    this.leftFin = child;
                    break;
                case 'RightFin':
                    this.rightFin = child;
                    break;
                case 'DorsalFin':
                    this.dorsalFin = child;
                    break;
                case 'TailFin':
                    this.tailFin = child;
                    break;
                default:
                    // Tentacle ring members carry an index suffix (Tentacle0..N-1,
                    // LongTentacle0/1) — collect and sort by index so each gets a
                    // stable undulation phase.
                    if (/^Tentacle\d+$/.test(child.name)) {
                        this.tentacles.push(child);
                    } else if (/^LongTentacle\d+$/.test(child.name)) {
                        this.longTentacles.push(child);
                    }
                    break;
            }
        });
        const byIndex = (a: THREE.Object3D, b: THREE.Object3D) =>
            parseInt(a.name.replace(/\D/g, ''), 10) - parseInt(b.name.replace(/\D/g, ''), 10);
        this.tentacles.sort(byIndex);
        this.longTentacles.sort(byIndex);

        const found = [
            this.body && 'body',
            this.head && 'head',
            this.tail && 'tail',
            this.frontLeftLeg && 'FL-leg',
            this.frontRightLeg && 'FR-leg',
            this.backLeftLeg && 'BL-leg',
            this.backRightLeg && 'BR-leg',
            this.leftWing && 'L-wing',
            this.rightWing && 'R-wing',
            this.leftWingOuter && 'L-wing-outer',
            this.rightWingOuter && 'R-wing-outer',
            this.leftFin && 'L-fin',
            this.rightFin && 'R-fin',
            this.dorsalFin && 'dorsal',
            this.tailFin && 'tail-fin',
            this.tentacles.length > 0 && `${this.tentacles.length}-tentacles`,
            this.longTentacles.length > 0 && `${this.longTentacles.length}-long-tentacles`,
        ].filter(Boolean);

        console.log(`🐾 BlockAnimalAnimationController: Found parts: ${found.join(', ')}`);
    }

    /**
     * Detect if this is a biped, quadruped or fish, and if it has wings
     */
    private detectCreatureType(): void {
        const hasFrontLegs = this.frontLeftLeg !== null || this.frontRightLeg !== null;
        const hasBackLegs = this.backLeftLeg !== null || this.backRightLeg !== null;

        // Biped if no front legs but has back legs
        this.isBiped = !hasFrontLegs && hasBackLegs;

        // Legless swimmers: tentacles → cephalopod (pulse-jet), else fish
        // (tail-sweep). An eel with neither fins nor tentacles still swims.
        const isLeglessSwimmer = !hasFrontLegs && !hasBackLegs && this.locomotionMode !== 'fly';
        this.isCephalopod = isLeglessSwimmer && (this.tentacles.length > 0 || this.longTentacles.length > 0);
        this.isFish = isLeglessSwimmer && !this.isCephalopod;
        if (isLeglessSwimmer) this.locomotionMode = 'swim';

        // Dragon: a flying creature with front legs — flight params shift to
        // slow, heavy wing beats.
        this.isQuadrupedFlyer = this.locomotionMode === 'fly' && hasFrontLegs;

        // Has wings if either wing is present
        this.hasWings = this.leftWing !== null || this.rightWing !== null;
    }

    /** The creature's locomotion mode as resolved from the builder/parts. */
    getLocomotionMode(): 'ground' | 'swim' | 'fly' {
        return this.locomotionMode;
    }

    /**
     * Store original transforms so we can apply deltas
     */
    private storeOriginalTransforms(): void {
        const parts = [
            this.body, this.head, this.tail,
            this.frontLeftLeg, this.frontRightLeg,
            this.backLeftLeg, this.backRightLeg,
            this.leftWing, this.rightWing,
            this.leftWingOuter, this.rightWingOuter,
            this.leftFin, this.rightFin,
            this.dorsalFin, this.tailFin,
            ...this.tentacles, ...this.longTentacles
        ];
        
        for (const part of parts) {
            if (part) {
                this.originalTransforms.set(part, {
                    position: part.position.clone(),
                    rotation: part.rotation.clone(),
                    scale: part.scale.clone()
                });
            }
        }
        
        // Initialize smoothed values to current positions
        if (this.body) {
            this.smoothedBodyY = this.body.position.y;
            this.smoothedBodyScale.copy(this.body.scale);
        }
    }

    /**
     * Get the current animation state string (e.g. 'idle', 'walk', 'trot', 'run').
     * Used by AnimationStateProvider for network sync.
     */
    getCurrentState(): string {
        return this.currentState;
    }

    /**
     * Set the animation state directly from a state string.
     * Used by AnimationStateReceiver for network sync on remote animals.
     */
    setState(state: string): void {
        if (!this.isInitialized) return;
        const mapped = state as BlockAnimalAnimationState;
        if (Object.values(BlockAnimalAnimationState).includes(mapped)) {
            this.currentState = mapped;
        }
    }

    /**
     * Update animation state based on movement
     * Compatible with CharacterAnimationController interface
     */
    updateAnimation(
        isMoving: boolean,
        movementSpeed: number,
        _isGrounded: boolean,
        _isJumpPressed: boolean
    ): void {
        if (!this.isInitialized) return;

        if (this.locomotionMode === 'swim') {
            // Fish: hover when stopped, sprint past ~4 m/s
            if (!isMoving || movementSpeed < 0.1) {
                this.currentState = BlockAnimalAnimationState.IDLE;
            } else if (movementSpeed < 4.0) {
                this.currentState = BlockAnimalAnimationState.SWIM;
            } else {
                this.currentState = BlockAnimalAnimationState.SWIM_FAST;
            }
            return;
        }

        if (this.locomotionMode === 'fly') {
            // Birds: flap when climbing/cruising, glide when descending gently
            // or soaring without a target.
            if (!isMoving || movementSpeed < 0.1) {
                this.currentState = BlockAnimalAnimationState.GLIDE;
            } else if (this.verticalVelocity < -0.6) {
                this.currentState = BlockAnimalAnimationState.GLIDE;
            } else {
                this.currentState = BlockAnimalAnimationState.FLY;
            }
            return;
        }

        if (!isMoving || movementSpeed < 0.1) {
            this.currentState = BlockAnimalAnimationState.IDLE;
        } else if (movementSpeed < 3.0) {
            this.currentState = BlockAnimalAnimationState.WALK;
        } else if (movementSpeed < 5.5) {
            this.currentState = BlockAnimalAnimationState.TROT;
        } else {
            this.currentState = BlockAnimalAnimationState.RUN;
        }
    }

    /**
     * Update animation every frame
     */
    update(deltaTime: number): void {
        if (!this.isInitialized || !this.character) return;

        this.animationTime += deltaTime;
        this.updateMotionHints(deltaTime);

        switch (this.currentState) {
            case BlockAnimalAnimationState.IDLE:
                if (this.isCephalopod) {
                    this.updateCephalopodAnimation(this.animationParams.cephalopodIdle);
                } else if (this.isFish) {
                    this.updateFishAnimation(this.animationParams.swimIdle, deltaTime);
                } else {
                    this.updateIdleAnimation();
                }
                break;
            case BlockAnimalAnimationState.SWIM:
                if (this.isCephalopod) {
                    this.updateCephalopodAnimation(this.animationParams.cephalopodSwim);
                } else {
                    this.updateFishAnimation(this.animationParams.swim, deltaTime);
                }
                break;
            case BlockAnimalAnimationState.SWIM_FAST:
                if (this.isCephalopod) {
                    this.updateCephalopodAnimation(this.animationParams.cephalopodSwimFast);
                } else {
                    this.updateFishAnimation(this.animationParams.swimFast, deltaTime);
                }
                break;
            case BlockAnimalAnimationState.FLY:
            case BlockAnimalAnimationState.GLIDE:
                this.updateBirdFlightAnimation(deltaTime);
                break;
            case BlockAnimalAnimationState.WALK:
                if (this.isBiped) {
                    this.updateBipedLocomotion(this.animationParams.bipedWalk);
                } else {
                    this.updateQuadrupedLocomotion(this.animationParams.walk, BlockAnimalAnimationController.GAIT_WALK);
                }
                break;
            case BlockAnimalAnimationState.TROT:
                if (this.isBiped) {
                    // Bipeds go straight to "run" style at trot speed
                    this.updateBipedLocomotion(this.animationParams.bipedRun);
                } else {
                    this.updateQuadrupedLocomotion(this.animationParams.trot, BlockAnimalAnimationController.GAIT_TROT);
                }
                break;
            case BlockAnimalAnimationState.RUN:
                if (this.isBiped) {
                    this.updateBipedLocomotion(this.animationParams.bipedRun);
                } else {
                    this.updateQuadrupedLocomotion(this.animationParams.run, BlockAnimalAnimationController.GAIT_GALLOP);
                }
                break;
        }

        // Ground-state wing animation (idle ruffle, run flapping). Flight states
        // drive the wings themselves inside updateBirdFlightAnimation.
        if (this.currentState !== BlockAnimalAnimationState.FLY
            && this.currentState !== BlockAnimalAnimationState.GLIDE) {
            if (this.hasWings) {
                this.updateWingAnimation();
            }
            // Untuck legs after landing so the next takeoff ramps from zero
            this.legTuckWeight = Math.max(0, this.legTuckWeight - deltaTime * 2.5);
        }
    }

    /**
     * Derive smoothed motion hints (turn rate, vertical velocity) from the
     * character root's transform deltas. Self-contained: no extra calls from
     * the controller are needed for banking/pitch to work.
     */
    private updateMotionHints(deltaTime: number): void {
        if (!this.character || deltaTime <= 0) return;
        const yaw = this.character.rotation.y;
        const y = this.character.position.y;
        if (this.lastYaw !== null && this.lastY !== null) {
            let yawDelta = yaw - this.lastYaw;
            // Unwrap across the ±π seam
            if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
            if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
            const rawTurnRate = yawDelta / deltaTime;
            const rawVerticalVelocity = (y - this.lastY) / deltaTime;
            // Smooth aggressively — these drive lean/pitch, not gameplay
            const blend = Math.min(1, deltaTime * 8);
            this.turnRate += (rawTurnRate - this.turnRate) * blend;
            this.verticalVelocity += (rawVerticalVelocity - this.verticalVelocity) * blend;
        }
        this.lastYaw = yaw;
        this.lastY = y;
    }

    /**
     * Idle animation - breathing, subtle movements
     */
    private updateIdleAnimation(): void {
        const params = this.animationParams.idle;
        const t = this.animationTime;

        // Body breathing (scale Y slightly)
        let breathScale = 1;
        if (this.body) {
            breathScale = 1 + Math.sin(t * params.bodyBreath.frequency * Math.PI * 2) * params.bodyBreath.amplitude;
            this.body.scale.y = breathScale;
            
            // Slight body sway
            const original = this.originalTransforms.get(this.body);
            if (original) {
                this.body.rotation.z = original.rotation.z + Math.sin(t * 0.7) * 0.01;
            }
        }

        // Counter-scale legs to compensate for body breathing animation
        // Since legs are children of body, they inherit body's scale. 
        // To keep legs grounded, we apply inverse scale.
        if (breathScale !== 1) {
            const inverseScale = 1 / breathScale;
            this.counterScaleLegs(inverseScale);
        }

        // Head subtle look around (more for birds - pecking motion)
        if (this.head) {
            const original = this.originalTransforms.get(this.head);
            if (original) {
                // Gentle nod (more pronounced for birds)
                const nodAmplitude = this.isBiped ? params.headBob.amplitude * 2 : params.headBob.amplitude;
                const nod = Math.sin(t * params.headBob.frequency * Math.PI * 2) * nodAmplitude;
                // Slow turn left/right
                const turn = Math.sin(t * params.headTurn.frequency * Math.PI * 2) * params.headTurn.amplitude;
                
                this.head.rotation.x = original.rotation.x + nod;
                this.head.rotation.y = original.rotation.y + turn;
            }
        }

        // Tail gentle sway
        if (this.tail) {
            const original = this.originalTransforms.get(this.tail);
            if (original) {
                const sway = Math.sin(t * params.tailWag.frequency * Math.PI * 2) * params.tailWag.amplitude;
                this.tail.rotation.y = original.rotation.y + sway;
            }
        }

        // Wings at rest - slight ruffle
        if (this.hasWings) {
            this.updateIdleWings(params.wingRuffle.amplitude, params.wingRuffle.frequency);
        }

        // Legs at rest - very slight weight shift
        this.resetLegsToOriginal();
    }
    
    /**
     * Counter-scale legs to compensate for body scale changes.
     * This keeps legs grounded when body scales for breathing animation.
     */
    private counterScaleLegs(inverseYScale: number): void {
        const legs = [this.frontLeftLeg, this.frontRightLeg, this.backLeftLeg, this.backRightLeg];
        for (const leg of legs) {
            if (leg) {
                const original = this.originalTransforms.get(leg);
                if (original) {
                    // Apply inverse Y scale to counteract parent body's scale
                    leg.scale.y = original.scale.y * inverseYScale;
                    // Adjust position to keep feet grounded
                    // When body scales up, leg attachment point moves up, so we need to move leg down
                    leg.position.y = original.position.y * inverseYScale;
                }
            }
        }
    }

    /**
     * Idle wing animation - slight ruffle/fold adjustment
     */
    private updateIdleWings(amplitude: number, frequency: number): void {
        const t = this.animationTime;
        const ruffle = Math.sin(t * frequency * Math.PI * 2) * amplitude;

        if (this.leftWing) {
            const original = this.originalTransforms.get(this.leftWing);
            if (original) {
                this.leftWing.rotation.z = original.rotation.z + ruffle;
            }
        }

        if (this.rightWing) {
            const original = this.originalTransforms.get(this.rightWing);
            if (original) {
                this.rightWing.rotation.z = original.rotation.z - ruffle;
            }
        }
    }

    /**
     * Footfall phase offsets (fraction of a full cycle) per gait, per leg.
     * Real quadruped gaits differ by WHEN each foot lands, not just speed:
     *
     * - WALK: 4-beat lateral sequence — each foot lands alone, a quarter cycle
     *   apart, hind foot followed by the same-side front foot (BL, FL, BR, FR).
     * - TROT: 2-beat diagonal pairs — FL+BR land together, FR+BL half a cycle later.
     * - GALLOP: rotary gallop — near-synced hind pair drives, near-synced front
     *   pair catches, with a small lag inside each pair and a suspension moment.
     */
    static readonly GAIT_WALK: BlockAnimalGaitPhases = { frontLeft: 0.25, frontRight: 0.75, backLeft: 0.0, backRight: 0.5 };
    static readonly GAIT_TROT: BlockAnimalGaitPhases = { frontLeft: 0.0, frontRight: 0.5, backLeft: 0.5, backRight: 0.0 };
    static readonly GAIT_GALLOP: BlockAnimalGaitPhases = { frontLeft: 0.0, frontRight: 0.15, backLeft: 0.5, backRight: 0.65 };

    /** Lean into turns: body roll per rad/s of yaw rate, and its clamp. */
    private static readonly TURN_LEAN_GAIN = 0.12;
    private static readonly TURN_LEAN_MAX = 0.22;

    /**
     * Quadruped locomotion with per-gait footfall patterns
     */
    private updateQuadrupedLocomotion(params: typeof this.animationParams.walk, gait: BlockAnimalGaitPhases): void {
        const t = this.animationTime;
        const cyclePhase = t * params.cycleSpeed * Math.PI * 2;
        const TWO_PI = Math.PI * 2;

        // ═══════════════════════════════════════════════════════════════
        // LEG ANIMATION - Gait-specific footfall phases
        // ═══════════════════════════════════════════════════════════════
        this.animateLeg(this.frontLeftLeg, cyclePhase + gait.frontLeft * TWO_PI, params, true);
        this.animateLeg(this.frontRightLeg, cyclePhase + gait.frontRight * TWO_PI, params, true);
        this.animateLeg(this.backLeftLeg, cyclePhase + gait.backLeft * TWO_PI, params, false);
        this.animateLeg(this.backRightLeg, cyclePhase + gait.backRight * TWO_PI, params, false);

        // Body and head animation
        this.animateBodyAndHead(cyclePhase, params);

        // Tail animation
        this.animateTail(cyclePhase, params);
    }

    /**
     * Biped locomotion - 2-legged alternating gait with waddle
     */
    private updateBipedLocomotion(params: typeof this.animationParams.bipedWalk): void {
        const t = this.animationTime;
        const cyclePhase = t * params.cycleSpeed * Math.PI * 2;

        // ═══════════════════════════════════════════════════════════════
        // LEG ANIMATION - Alternating gait (left, right, left, right)
        // ═══════════════════════════════════════════════════════════════
        
        const leftPhase = cyclePhase;
        const rightPhase = cyclePhase + Math.PI;

        // Only animate back legs (birds don't have front legs)
        this.animateLeg(this.backLeftLeg, leftPhase, params, false);
        this.animateLeg(this.backRightLeg, rightPhase, params, false);

        // ═══════════════════════════════════════════════════════════════
        // BODY ANIMATION - Waddle and squash/stretch (NO position.y changes to avoid physics conflicts)
        // ═══════════════════════════════════════════════════════════════
        if (this.body) {
            const original = this.originalTransforms.get(this.body);
            if (original) {
                // Side-to-side waddle (more pronounced for birds)
                const targetWaddle = Math.sin(cyclePhase) * params.bodyRoll;
                
                // Slight forward lean when moving
                const lean = 0.1;
                
                // Squash/stretch instead of position bob (won't fight with physics)
                // When "up" in the bob cycle, stretch slightly taller
                const bobCycle = Math.abs(Math.sin(cyclePhase * 2));
                const targetScaleY = 1.0 + bobCycle * params.bodyStretch;
                const targetScaleXZ = 1.0 - bobCycle * params.bodyStretch * 0.5; // Conserve volume
                
                // Smooth scale interpolation
                this.smoothedBodyScale.y = this.lerp(this.smoothedBodyScale.y, targetScaleY, this.SCALE_SMOOTH_FACTOR);
                this.smoothedBodyScale.x = this.lerp(this.smoothedBodyScale.x, targetScaleXZ, this.SCALE_SMOOTH_FACTOR);
                this.smoothedBodyScale.z = this.lerp(this.smoothedBodyScale.z, targetScaleXZ, this.SCALE_SMOOTH_FACTOR);
                
                this.body.scale.set(
                    original.scale.x * this.smoothedBodyScale.x,
                    original.scale.y * this.smoothedBodyScale.y,
                    original.scale.z * this.smoothedBodyScale.z
                );
                
                // Keep body at original Y position (physics handles vertical)
                this.body.position.y = original.position.y;
                
                // Smooth interpolation for rotation only
                const targetRotZ = original.rotation.z + targetWaddle;
                const targetRotX = original.rotation.x + lean;
                this.body.rotation.z = this.lerp(this.body.rotation.z, targetRotZ, this.SMOOTH_FACTOR);
                this.body.rotation.x = this.lerp(this.body.rotation.x, targetRotX, this.SMOOTH_FACTOR);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // HEAD ANIMATION - Bird pecking motion while walking
        // ═══════════════════════════════════════════════════════════════
        if (this.head) {
            const original = this.originalTransforms.get(this.head);
            if (original) {
                // Bird head bobs forward/back (pecking motion)
                const peck = Math.sin(cyclePhase * 2) * params.headBob;
                // Counter the body waddle slightly
                const counterWaddle = -Math.sin(cyclePhase) * params.bodyRoll * 0.3;
                
                this.head.rotation.x = original.rotation.x + peck;
                this.head.rotation.z = original.rotation.z + counterWaddle;
                
                // Head also moves forward/back in position
                this.head.position.z = original.position.z + peck * 0.5;
            }
        }

        // Tail animation
        this.animateTail(cyclePhase, params);
    }

    /**
     * Body and head animation helper - with smoothing to prevent vibration
     * NOTE: No body.position.y changes - only scale/rotation to avoid physics conflicts
     */
    private animateBodyAndHead(cyclePhase: number, params: typeof this.animationParams.walk): void {
        // ═══════════════════════════════════════════════════════════════
        // BODY ANIMATION - Roll and squash/stretch only (NO position.y changes)
        // ═══════════════════════════════════════════════════════════════
        if (this.body) {
            const original = this.originalTransforms.get(this.body);
            if (original) {
                // Bob cycle for squash/stretch (twice per cycle - once for each diagonal pair)
                const bobPhase = cyclePhase * 2;
                const bobCycle = Math.abs(Math.sin(bobPhase));

                // Side-to-side roll (once per cycle) + lean INTO turns.
                // Positive yaw rate = turning left; leaning left is negative
                // roll around +Z for a +Z-forward body, hence the negation.
                const turnLean = THREE.MathUtils.clamp(
                    -this.turnRate * BlockAnimalAnimationController.TURN_LEAN_GAIN,
                    -BlockAnimalAnimationController.TURN_LEAN_MAX,
                    BlockAnimalAnimationController.TURN_LEAN_MAX
                );
                const targetRoll = Math.sin(cyclePhase) * params.bodyRoll + turnLean;
                
                // Squash & stretch instead of position bob
                // When "up" in bob cycle, stretch taller and narrower (conserve volume)
                const targetStretchY = 1 + bobCycle * params.bodyStretch;
                const targetStretchX = 1 - bobCycle * params.bodyStretch * 0.3;
                const targetStretchZ = 1 + Math.sin(cyclePhase) * params.bodyStretch * 0.5;
                
                // Keep body at original Y position (physics handles vertical)
                this.body.position.y = original.position.y;
                
                // Smooth interpolation for rotation
                const targetRotZ = original.rotation.z + targetRoll;
                this.body.rotation.z = this.lerp(this.body.rotation.z, targetRotZ, this.SMOOTH_FACTOR);
                
                // Smooth interpolation for scale (extra slow to avoid jitter)
                this.smoothedBodyScale.x = this.lerp(this.smoothedBodyScale.x, targetStretchX, this.SCALE_SMOOTH_FACTOR);
                this.smoothedBodyScale.y = this.lerp(this.smoothedBodyScale.y, targetStretchY, this.SCALE_SMOOTH_FACTOR);
                this.smoothedBodyScale.z = this.lerp(this.smoothedBodyScale.z, targetStretchZ, this.SCALE_SMOOTH_FACTOR);
                
                this.body.scale.set(
                    original.scale.x * this.smoothedBodyScale.x,
                    original.scale.y * this.smoothedBodyScale.y,
                    original.scale.z * this.smoothedBodyScale.z
                );
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // HEAD ANIMATION - Follows body with slight lag (with smoothing)
        // ═══════════════════════════════════════════════════════════════
        if (this.head) {
            const original = this.originalTransforms.get(this.head);
            if (original) {
                // Head counters body motion slightly (stabilization)
                const targetHeadBob = Math.sin(cyclePhase * 2 + 0.5) * params.headBob;
                const targetHeadRoll = -Math.sin(cyclePhase) * params.bodyRoll * 0.5;
                
                // Smooth interpolation
                const targetRotX = original.rotation.x + targetHeadBob;
                const targetRotZ = original.rotation.z + targetHeadRoll;
                this.head.rotation.x = this.lerp(this.head.rotation.x, targetRotX, this.SMOOTH_FACTOR);
                this.head.rotation.z = this.lerp(this.head.rotation.z, targetRotZ, this.SMOOTH_FACTOR);
            }
        }
    }
    
    /**
     * Linear interpolation helper
     */
    private lerp(current: number, target: number, factor: number): number {
        return current + (target - current) * factor;
    }

    /**
     * Tail animation helper - independent of leg cycle for natural movement
     */
    private animateTail(_cyclePhase: number, params: typeof this.animationParams.walk): void {
        if (this.tail) {
            const original = this.originalTransforms.get(this.tail);
            if (original) {
                // Tail wags at its own slower, natural frequency (not synced to legs)
                // ~1.5 wags per second feels natural for most animals
                const tailFrequency = 1.5;
                const tailPhase = this.animationTime * tailFrequency * Math.PI * 2;
                
                const targetWag = Math.sin(tailPhase) * params.tailWag;
                // Slight up-lift during movement
                const targetLift = params.tailWag * 0.2;
                
                // Smooth interpolation for tail movement
                const targetRotY = original.rotation.y + targetWag;
                const targetRotX = original.rotation.x - targetLift;
                
                this.tail.rotation.y = this.lerp(this.tail.rotation.y, targetRotY, this.SMOOTH_FACTOR);
                this.tail.rotation.x = this.lerp(this.tail.rotation.x, targetRotX, this.SMOOTH_FACTOR);
            }
        }
    }

    /**
     * Fish swimming — the whole body is the propeller.
     *
     * Anatomy of the motion (all yaw sweeps around the spine):
     * - tail sweeps left/right at the swim frequency
     * - caudal (tail) fin lags the tail by a phase offset — the two-segment
     *   whip that sells the motion
     * - body counter-sways slightly out of phase, head stabilizes against it
     * - pectoral fins paddle while hovering and tuck against the body at speed
     * - banking rolls the body into turns; pitch follows climb/dive
     */
    private updateFishAnimation(params: typeof this.animationParams.swim, deltaTime: number): void {
        const t = this.animationTime;
        const tailPhase = t * params.tailFrequency * Math.PI * 2;
        const tailSweep = Math.sin(tailPhase) * params.tailAmplitude;

        if (this.tail) {
            const original = this.originalTransforms.get(this.tail);
            if (original) {
                this.tail.rotation.y = this.lerp(this.tail.rotation.y, original.rotation.y + tailSweep, this.SMOOTH_FACTOR * 2);
            }
        }

        if (this.tailFin) {
            const original = this.originalTransforms.get(this.tailFin);
            if (original) {
                // The caudal fin trails the tail — bigger sweep, delayed phase
                const finSweep = Math.sin(tailPhase - params.tailFinLag) * params.tailAmplitude * 1.4;
                this.tailFin.rotation.y = this.lerp(this.tailFin.rotation.y, original.rotation.y + finSweep, this.SMOOTH_FACTOR * 2);
            }
        }

        if (this.body) {
            const original = this.originalTransforms.get(this.body);
            if (original) {
                // Counter-sway: the front of the body swings opposite the tail
                const bodySway = Math.sin(tailPhase + Math.PI) * params.bodySway;
                this.body.rotation.y = this.lerp(this.body.rotation.y, original.rotation.y + bodySway, this.SMOOTH_FACTOR);

                // Bank into turns, pitch with climb/dive
                const bank = THREE.MathUtils.clamp(-this.turnRate * 0.25, -0.5, 0.5);
                const pitch = THREE.MathUtils.clamp(-this.verticalVelocity * 0.12, -0.45, 0.45);
                this.body.rotation.z = this.lerp(this.body.rotation.z, original.rotation.z + bank, this.SMOOTH_FACTOR);
                this.body.rotation.x = this.lerp(this.body.rotation.x, original.rotation.x + pitch, this.SMOOTH_FACTOR);

                // Gentle hover drift while idling (visual group only — the
                // physics capsule is untouched, so nothing fights the body)
                const targetBobY = original.position.y + (params.hoverBob > 0
                    ? Math.sin(t * 0.5 * Math.PI * 2) * params.hoverBob
                    : 0);
                this.body.position.y = this.lerp(this.body.position.y, targetBobY, this.SCALE_SMOOTH_FACTOR);

                // Subtle breathing
                const breath = 1 + Math.sin(t * 1.1 * Math.PI * 2) * 0.012;
                this.body.scale.set(original.scale.x * breath, original.scale.y, original.scale.z * (2 - breath));
            }
        }

        if (this.head) {
            const original = this.originalTransforms.get(this.head);
            if (original) {
                // Head counter-yaws against the body sway → gaze stays stable
                const headCounter = Math.sin(tailPhase + Math.PI) * params.bodySway * -0.6;
                this.head.rotation.y = this.lerp(this.head.rotation.y, original.rotation.y + headCounter, this.SMOOTH_FACTOR);
            }
        }

        // Pectoral fins: paddle at hover, tuck at speed
        const tuckTarget = this.currentState === BlockAnimalAnimationState.SWIM_FAST ? 1 : 0;
        this.finTuckWeight += (tuckTarget - this.finTuckWeight) * Math.min(1, deltaTime * 4);
        const finPhase = t * params.finFrequency * Math.PI * 2;
        const flutter = Math.sin(finPhase) * params.finFlutter * (1 - this.finTuckWeight * 0.8);
        const tuck = this.finTuckWeight * 0.9;

        if (this.leftFin) {
            const original = this.originalTransforms.get(this.leftFin);
            if (original) {
                this.leftFin.rotation.z = original.rotation.z + flutter + tuck;
                this.leftFin.rotation.y = original.rotation.y + flutter * 0.3;
            }
        }
        if (this.rightFin) {
            const original = this.originalTransforms.get(this.rightFin);
            if (original) {
                this.rightFin.rotation.z = original.rotation.z - flutter - tuck;
                this.rightFin.rotation.y = original.rotation.y - flutter * 0.3;
            }
        }

        if (this.dorsalFin) {
            const original = this.originalTransforms.get(this.dorsalFin);
            if (original) {
                // Dorsal fin follows the body wave at reduced amplitude
                this.dorsalFin.rotation.y = original.rotation.y + Math.sin(tailPhase - 0.4) * params.dorsalSway;
            }
        }

        // No legs to reset — fish never have leg groups
    }

    /**
     * Cephalopod swimming (octopus/squid) — the mantle is the engine, the
     * tentacles are the wake.
     *
     * - Mantle pulse: rhythmic squash/stretch of the body (contract radially,
     *   elongate vertically) — the jet-propulsion look. Faster + deeper with
     *   speed.
     * - Ring tentacles: each undulates with a phase offset from its ring index
     *   (a travelling wave around the ring), plus a speed-scaled backward
     *   trail so they stream behind during bursts.
     * - Squid feeding pair: trails harder, waves less — they stream.
     * - Body tilts into the motion (tentacles trail the heading), banks into
     *   turns and pitches with climb/dive like a fish.
     */
    private updateCephalopodAnimation(params: typeof this.animationParams.cephalopodSwim): void {
        const t = this.animationTime;
        const pulsePhase = t * params.pulseFrequency * Math.PI * 2;
        const pulse = Math.sin(pulsePhase);

        if (this.body) {
            const original = this.originalTransforms.get(this.body);
            if (original) {
                // Mantle pulse: contract in X/Z while stretching in Y (volume-ish conserving)
                const stretch = 1 + pulse * params.pulseAmplitude;
                const squeeze = 1 - pulse * params.pulseAmplitude * 0.6;
                this.smoothedBodyScale.y = this.lerp(this.smoothedBodyScale.y, stretch, this.SCALE_SMOOTH_FACTOR * 2);
                this.smoothedBodyScale.x = this.lerp(this.smoothedBodyScale.x, squeeze, this.SCALE_SMOOTH_FACTOR * 2);
                this.smoothedBodyScale.z = this.lerp(this.smoothedBodyScale.z, squeeze, this.SCALE_SMOOTH_FACTOR * 2);
                this.body.scale.set(
                    original.scale.x * this.smoothedBodyScale.x,
                    original.scale.y * this.smoothedBodyScale.y,
                    original.scale.z * this.smoothedBodyScale.z
                );

                // Tilt into the motion (tentacles trail), bank into turns,
                // pitch with climb/dive
                const bank = THREE.MathUtils.clamp(-this.turnRate * 0.2, -0.4, 0.4);
                const pitch = params.forwardTilt
                    + THREE.MathUtils.clamp(-this.verticalVelocity * 0.1, -0.35, 0.35);
                this.body.rotation.x = this.lerp(this.body.rotation.x, original.rotation.x + pitch, this.SMOOTH_FACTOR * 0.6);
                this.body.rotation.z = this.lerp(this.body.rotation.z, original.rotation.z + bank, this.SMOOTH_FACTOR);

                // Hover drift while idling (visual group only)
                const targetBobY = original.position.y + (params.hoverBob > 0
                    ? Math.sin(t * 0.45 * Math.PI * 2) * params.hoverBob
                    : 0);
                this.body.position.y = this.lerp(this.body.position.y, targetBobY, this.SCALE_SMOOTH_FACTOR);
            }
        }

        // Ring tentacles: travelling wave around the ring + backward trail.
        // The wave rides the pulse phase so the tentacles visibly answer each
        // mantle contraction.
        const wavePhase = t * params.tentacleFrequency * Math.PI * 2;
        const count = Math.max(1, this.tentacles.length);
        for (let i = 0; i < this.tentacles.length; i++) {
            const tentacle = this.tentacles[i]!;
            const original = this.originalTransforms.get(tentacle);
            if (!original) continue;
            const phaseOffset = (i / count) * Math.PI * 2;
            const wave = Math.sin(wavePhase + phaseOffset) * params.tentacleWave;
            const crossWave = Math.sin(wavePhase + phaseOffset + Math.PI / 3) * params.tentacleWave * 0.5;
            // rotation.x positive sweeps the hanging (−Y) tip backward (−Z)
            tentacle.rotation.x = this.lerp(tentacle.rotation.x, original.rotation.x + params.trail + wave, this.SMOOTH_FACTOR * 1.5);
            tentacle.rotation.z = this.lerp(tentacle.rotation.z, original.rotation.z + crossWave, this.SMOOTH_FACTOR * 1.5);
        }

        // Feeding pair: mostly trail, gentle slow wave
        for (let i = 0; i < this.longTentacles.length; i++) {
            const tentacle = this.longTentacles[i]!;
            const original = this.originalTransforms.get(tentacle);
            if (!original) continue;
            const wave = Math.sin(wavePhase * 0.6 + i * Math.PI) * params.tentacleWave * 0.4;
            tentacle.rotation.x = this.lerp(tentacle.rotation.x, original.rotation.x + params.trail * 1.3 + wave, this.SMOOTH_FACTOR);
        }

        // Head (if any) counter-pitches a little so the eyes hold the horizon
        if (this.head) {
            const original = this.originalTransforms.get(this.head);
            if (original) {
                this.head.rotation.x = this.lerp(this.head.rotation.x, original.rotation.x - params.forwardTilt * 0.5, this.SMOOTH_FACTOR);
            }
        }
    }

    /**
     * Bird flight — flapping with an asymmetric stroke, two-segment wings,
     * glide blending, tucked legs, tail elevator, banking.
     *
     * FLY and GLIDE share this method: `flapWeight` smoothly blends between
     * full flapping (1) and extended-wing soaring (0) so state flips never pop.
     */
    private updateBirdFlightAnimation(deltaTime: number): void {
        const t = this.animationTime;
        const params = this.isQuadrupedFlyer
            ? this.animationParams.dragonFlight
            : this.animationParams.flight;

        // Blend flap intensity toward the current state's target
        const flapTarget = this.currentState === BlockAnimalAnimationState.GLIDE ? 0.12 : 1;
        this.flapWeight += (flapTarget - this.flapWeight) * Math.min(1, deltaTime * 3);

        // Legs tuck up in flight (and untuck on the ground via resetLegsToOriginal)
        this.legTuckWeight += (1 - this.legTuckWeight) * Math.min(1, deltaTime * 2.5);

        // ── Wings: asymmetric stroke (downstroke faster than upstroke) ──
        // Phase warp: adding a sine of the phase to itself compresses one half
        // of the cycle and stretches the other.
        const basePhase = t * params.flapFrequency * Math.PI * 2;
        const warpedPhase = basePhase + params.strokeSkew * Math.sin(basePhase);
        const flap = Math.sin(warpedPhase) * params.flapAmplitude * this.flapWeight;
        const glideLift = (1 - this.flapWeight) * params.glideDihedral;

        if (this.leftWing) {
            const original = this.originalTransforms.get(this.leftWing);
            if (original) {
                this.leftWing.rotation.z = original.rotation.z + flap - glideLift;
                this.leftWing.rotation.x = original.rotation.x + flap * 0.15;
            }
        }
        if (this.rightWing) {
            const original = this.originalTransforms.get(this.rightWing);
            if (original) {
                this.rightWing.rotation.z = original.rotation.z - flap + glideLift;
                this.rightWing.rotation.x = original.rotation.x + flap * 0.15;
            }
        }

        // Outer segments lag the inner stroke and exaggerate it — the wing-tip
        // whip that makes a flap read as powerful instead of stiff
        const outerFlap = Math.sin(warpedPhase - params.outerLag) * params.flapAmplitude * params.outerAmplitudeScale * this.flapWeight;
        if (this.leftWingOuter) {
            const original = this.originalTransforms.get(this.leftWingOuter);
            if (original) {
                this.leftWingOuter.rotation.z = original.rotation.z + outerFlap * 0.5 - glideLift * 0.5;
            }
        }
        if (this.rightWingOuter) {
            const original = this.originalTransforms.get(this.rightWingOuter);
            if (original) {
                this.rightWingOuter.rotation.z = original.rotation.z - outerFlap * 0.5 + glideLift * 0.5;
            }
        }

        // ── Body: bank into turns, pitch with climb/dive, flap-synced bob ──
        if (this.body) {
            const original = this.originalTransforms.get(this.body);
            if (original) {
                const bank = THREE.MathUtils.clamp(-this.turnRate * params.bodyBankGain, -0.6, 0.6);
                const pitch = THREE.MathUtils.clamp(-this.verticalVelocity * params.bodyPitchGain, -0.35, 0.35);
                this.body.rotation.z = this.lerp(this.body.rotation.z, original.rotation.z + bank, this.SMOOTH_FACTOR);
                this.body.rotation.x = this.lerp(this.body.rotation.x, original.rotation.x + pitch, this.SMOOTH_FACTOR);

                // The body dips on the downstroke (visual group only)
                const bob = Math.sin(warpedPhase - Math.PI / 3) * 0.02 * this.flapWeight;
                this.body.position.y = this.lerp(this.body.position.y, original.position.y + bob, this.SCALE_SMOOTH_FACTOR * 2);
            }
        }

        // Head stabilizes: counter-roll against the bank
        if (this.head) {
            const original = this.originalTransforms.get(this.head);
            if (original) {
                const counterRoll = -THREE.MathUtils.clamp(-this.turnRate * params.bodyBankGain, -0.6, 0.6) * 0.4;
                this.head.rotation.z = this.lerp(this.head.rotation.z, original.rotation.z + counterRoll, this.SMOOTH_FACTOR);
            }
        }

        // Tail works as an elevator: pitches against vertical motion
        if (this.tail) {
            const original = this.originalTransforms.get(this.tail);
            if (original) {
                const elevator = THREE.MathUtils.clamp(this.verticalVelocity * params.tailElevatorGain, -0.4, 0.4);
                this.tail.rotation.x = this.lerp(this.tail.rotation.x, original.rotation.x + elevator, this.SMOOTH_FACTOR);
            }
        }

        // Legs trail tucked backward while airborne
        const tuck = this.legTuckWeight * params.legTuck;
        for (const leg of [this.backLeftLeg, this.backRightLeg, this.frontLeftLeg, this.frontRightLeg]) {
            if (!leg) continue;
            const original = this.originalTransforms.get(leg);
            if (original) {
                leg.rotation.x = this.lerp(leg.rotation.x, original.rotation.x + tuck, this.SMOOTH_FACTOR);
            }
        }
    }

    /** How far ground-dragon wings sweep back against the flanks (radians around Y). */
    private static readonly WING_FOLD_ANGLE = 1.25;
    /** Extra fold on the outer wing segment — tightens the packet. */
    private static readonly WING_FOLD_OUTER_ANGLE = 0.6;

    /**
     * Tucked-wing pose for grounded winged quadrupeds: wings sweep BACKWARD
     * along the body sides (rotated around Y toward −Z) instead of resting in
     * their authored spread pose, with only a breathing micro-ruffle. Smoothly
     * lerped so a landing flying dragon folds its wings rather than snapping.
     */
    private applyFoldedWings(): void {
        const t = this.animationTime;
        const ruffle = Math.sin(t * 0.5 * Math.PI * 2) * 0.03;

        // Left wing extends −X: a NEGATIVE Y rotation sweeps its tip toward −Z
        // (backward along the flank); the right wing mirrors.
        if (this.leftWing) {
            const original = this.originalTransforms.get(this.leftWing);
            if (original) {
                this.leftWing.rotation.y = this.lerp(this.leftWing.rotation.y, original.rotation.y - BlockAnimalAnimationController.WING_FOLD_ANGLE, this.SMOOTH_FACTOR);
                this.leftWing.rotation.z = original.rotation.z + ruffle;
            }
        }
        if (this.rightWing) {
            const original = this.originalTransforms.get(this.rightWing);
            if (original) {
                this.rightWing.rotation.y = this.lerp(this.rightWing.rotation.y, original.rotation.y + BlockAnimalAnimationController.WING_FOLD_ANGLE, this.SMOOTH_FACTOR);
                this.rightWing.rotation.z = original.rotation.z - ruffle;
            }
        }

        // Outer segments fold further back, tightening the wing packet
        if (this.leftWingOuter) {
            const original = this.originalTransforms.get(this.leftWingOuter);
            if (original) {
                this.leftWingOuter.rotation.y = this.lerp(this.leftWingOuter.rotation.y, original.rotation.y - BlockAnimalAnimationController.WING_FOLD_OUTER_ANGLE, this.SMOOTH_FACTOR);
            }
        }
        if (this.rightWingOuter) {
            const original = this.originalTransforms.get(this.rightWingOuter);
            if (original) {
                this.rightWingOuter.rotation.y = this.lerp(this.rightWingOuter.rotation.y, original.rotation.y + BlockAnimalAnimationController.WING_FOLD_OUTER_ANGLE, this.SMOOTH_FACTOR);
            }
        }
    }

    /**
     * Wing animation based on current movement state
     */
    private updateWingAnimation(): void {
        const t = this.animationTime;
        let flapAmplitude: number;
        let flapSpeed: number;

        // Winged QUADRUPEDS (ground dragons) NEVER beat their wings on the
        // ground — they hold them TUCKED, swept back against the flanks, at
        // every gait INCLUDING a full gallop. A grounded dragon pumping (or
        // even spreading) its wings reads as a takeoff; actual lift-off and
        // flapping are exclusively the flying 'dragon' body plan, which never
        // enters this code path.
        if (!this.isBiped) {
            this.applyFoldedWings();
            return;
        }

        // Bipeds (chickens & co) flutter progressively with speed.
        switch (this.currentState) {
            case BlockAnimalAnimationState.IDLE:
                flapAmplitude = 0.05;  // Just a slight fold adjustment
                flapSpeed = 0.5;
                break;
            case BlockAnimalAnimationState.WALK:
                flapAmplitude = 0.2;
                flapSpeed = 2.0;
                break;
            case BlockAnimalAnimationState.TROT:
                flapAmplitude = 0.4;
                flapSpeed = 3.0;
                break;
            case BlockAnimalAnimationState.RUN:
                flapAmplitude = 0.8;
                flapSpeed = 4.0;
                break;
            default:
                flapAmplitude = 0.1;
                flapSpeed = 1.0;
        }

        const flapPhase = t * flapSpeed * Math.PI * 2;
        const flap = Math.sin(flapPhase) * flapAmplitude;

        // Left wing flaps up
        if (this.leftWing) {
            const original = this.originalTransforms.get(this.leftWing);
            if (original) {
                // Wing rotates around Z axis (up/down flap)
                this.leftWing.rotation.z = original.rotation.z + flap;
                // Slight forward/back motion
                this.leftWing.rotation.x = original.rotation.x + flap * 0.3;
            }
        }

        // Right wing flaps (mirror of left)
        if (this.rightWing) {
            const original = this.originalTransforms.get(this.rightWing);
            if (original) {
                this.rightWing.rotation.z = original.rotation.z - flap;
                this.rightWing.rotation.x = original.rotation.x + flap * 0.3;
            }
        }
    }

    /**
     * Animate a single leg with IK-like stretching to maintain ground contact
     */
    private animateLeg(
        leg: THREE.Object3D | null,
        phase: number,
        params: typeof this.animationParams.walk,
        isFront: boolean
    ): void {
        if (!leg) return;

        const original = this.originalTransforms.get(leg);
        if (!original) return;

        // Leg swing (forward/back rotation around X axis)
        // Front legs and back legs swing in opposite directions
        const swingDirection = isFront ? 1 : -1;
        const targetSwing = Math.sin(phase) * params.legSwing * swingDirection;

        // Leg "lift" is simulated by bending at the knee (more rotation when lifted)
        // This keeps the foot planted while the upper leg rotates
        const liftPhase = Math.max(0, Math.sin(phase));
        const bendAmount = liftPhase * params.legLift * 2; // Extra bend during lift phase

        // Apply smooth interpolation for main swing rotation
        const targetRotX = original.rotation.x + targetSwing + bendAmount;
        leg.rotation.x = this.lerp(leg.rotation.x, targetRotX, this.SMOOTH_FACTOR * 1.5);
        
        // ═══════════════════════════════════════════════════════════════
        // IK-LIKE LEG STRETCHING - Extend leg to maintain ground contact
        // ═══════════════════════════════════════════════════════════════
        // When a leg swings (rotates), its foot rises off the ground.
        // To compensate, we stretch the leg (scale Y) to keep the foot planted.
        // 
        // Math: If leg rotates by angle θ, vertical reach = L * cos(θ)
        // To maintain same vertical reach, scale by 1/cos(θ)
        
        const totalRotation = Math.abs(targetSwing + bendAmount);
        
        // Calculate stretch factor to maintain ground contact
        // Use cos of the swing angle - when leg is vertical (0), cos=1 (no stretch)
        // When leg is angled, cos < 1, so we need to stretch by 1/cos
        const cosAngle = Math.cos(totalRotation);
        // Clamp to prevent extreme stretching (max 30% stretch)
        const stretchFactor = Math.min(1.3, 1.0 / Math.max(0.7, cosAngle));
        
        // During the "planted" phase (leg moving back), stretch more
        // During the "swing" phase (leg moving forward/up), allow slight retraction
        const plantedPhase = Math.max(0, -Math.sin(phase)); // 1 when planted, 0 when swinging up
        const swingUpPhase = Math.max(0, Math.sin(phase));  // 1 when swinging up, 0 when planted
        
        // Blend between stretch (planted) and slight compression (swing up)
        const targetScaleY = (stretchFactor * plantedPhase) + (0.95 * swingUpPhase) + 
                            (1.0 * (1 - plantedPhase - swingUpPhase)); // Default when transitioning
        
        // Smooth the scale change to avoid popping
        let currentSmoothedScale = this.smoothedLegScales.get(leg) ?? 1.0;
        currentSmoothedScale = this.lerp(currentSmoothedScale, targetScaleY, this.SCALE_SMOOTH_FACTOR * 2);
        this.smoothedLegScales.set(leg, currentSmoothedScale);
        
        // Apply scale - only stretch in Y (length), keep X and Z the same
        leg.scale.set(original.scale.x, original.scale.y * currentSmoothedScale, original.scale.z);
        
        // Keep legs at their original Y position
        leg.position.y = original.position.y;
        
        // Slight outward splay during swing for more natural look
        const targetRotZ = original.rotation.z + liftPhase * 0.1;
        leg.rotation.z = this.lerp(leg.rotation.z, targetRotZ, this.SMOOTH_FACTOR);
    }

    /**
     * Reset legs to original position and scale (for idle)
     */
    private resetLegsToOriginal(): void {
        const legs = [
            this.frontLeftLeg, this.frontRightLeg,
            this.backLeftLeg, this.backRightLeg
        ];

        for (const leg of legs) {
            if (leg) {
                const original = this.originalTransforms.get(leg);
                if (original) {
                    // Smooth interpolation back to rest position
                    leg.rotation.x += (original.rotation.x - leg.rotation.x) * 0.1;
                    leg.rotation.z += (original.rotation.z - leg.rotation.z) * 0.1;
                    leg.position.y += (original.position.y - leg.position.y) * 0.1;
                    
                    // Reset scale back to original (from walking stretch)
                    leg.scale.x += (original.scale.x - leg.scale.x) * 0.1;
                    leg.scale.y += (original.scale.y - leg.scale.y) * 0.1;
                    leg.scale.z += (original.scale.z - leg.scale.z) * 0.1;
                    
                    // Reset smoothed scale tracker
                    this.smoothedLegScales.set(leg, leg.scale.y / original.scale.y);
                }
            }
        }
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.originalTransforms.clear();
        this.smoothedLegScales.clear();
        this.smoothedLegPositions.clear();
        this.body = null;
        this.head = null;
        this.tail = null;
        this.frontLeftLeg = null;
        this.frontRightLeg = null;
        this.backLeftLeg = null;
        this.backRightLeg = null;
        this.leftWing = null;
        this.rightWing = null;
        this.leftWingOuter = null;
        this.rightWingOuter = null;
        this.leftFin = null;
        this.rightFin = null;
        this.dorsalFin = null;
        this.tailFin = null;
        this.tentacles = [];
        this.longTentacles = [];
        this.character = null;
        this.isInitialized = false;
    }
}

/**
 * Footfall phase offsets (fraction of a full gait cycle) for each leg.
 */
export interface BlockAnimalGaitPhases {
    frontLeft: number;
    frontRight: number;
    backLeft: number;
    backRight: number;
}

/**
 * Animation states for block-based animals
 */
export enum BlockAnimalAnimationState {
    IDLE = 'idle',
    WALK = 'walk',
    TROT = 'trot',
    RUN = 'run',
    /** Fish cruising inside a water volume */
    SWIM = 'swim',
    /** Fish sprint — higher tail frequency, tucked pectoral fins */
    SWIM_FAST = 'swimFast',
    /** Bird powered flight (flapping) */
    FLY = 'fly',
    /** Bird soaring — wings extended, micro-ruffle only */
    GLIDE = 'glide'
}
