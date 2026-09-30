import RAPIER2D from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import type { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { CollisionMask } from 'engine/CollisionLayers.js';
import { DEFAULT_PHYSICS, CAPSULE } from './PhysicsConfig.js';

/**
 * TODO: this genre is unplayable on a phone, and nothing reports it.
 *
 * Movement is read from raw `window` keydown/keyup listeners (see the constructor). Those events
 * never arrive on touch, so left/right/jump have no input at all there — and unlike the voxel
 * genre this class does not extend `engine/PlayerController`, so it inherits none of the mobile
 * machinery: no `MobileControls`, no joystick, no jump button, no `keys` flags for one to drive.
 *
 * It is also invisible to the safety net. `GameTemplate.runMobileParityCheck` is a duck-typed
 * `'verifyMobileParity' in playerController` guard, and this class has no such method, so the
 * check silently no-ops rather than reporting a gap.
 *
 * Not urgent today only because no CLI template uses this genre — all six are `voxel`
 * (`templates/index.json`); it is reachable through the web Creator's physics2d genre. Fixing it
 * means feeding `keysHeld` from the engine's input layer instead of from `document` — either by
 * extending `PlayerController` or by reading its `keys.left/right/ascend`, which the joystick and
 * jump button already drive. See `game/agent-docs/control-system.md`.
 */
export class Physics2DPlayerController {
    private playerBody: RAPIER2D.RigidBody;
    private physicsWorld: PhysicsWorld2D;
    private playerMesh: THREE.Object3D;
    private animationController: CharacterAnimationController | null = null;

    private runSpeed: number;
    private groundFriction: number;
    private airFriction: number;
    private airControlMultiplier: number;
    private jumpVelocity: number;
    private characterHeight: number;
    private capsuleHalfHeight: number;
    private capsuleRadius: number;
    private blockFeetOffset: number;

    private walkStepHeight: number;
    private hopStepHeight: number;
    private stepClimbSpeed: number;
    private stepClimbStartX = 0;
    private stepClimbStartY = 0;
    private stepClimbTargetX = 0;
    private stepClimbTargetY = 0;
    private stepClimbProgress = 0;
    private stepClimbDir = 0;
    private stepClimbActive = false;

    private keysHeld = { left: false, right: false, jump: false };
    private jumpJustPressed = false;
    private isGrounded = false;
    private facingRight = true;
    private controlsEnabled = true;
    private jumpsRemaining = 2;
    private maxJumps = 2;

    private boundKeyDown: (e: KeyboardEvent) => void;
    private boundKeyUp: (e: KeyboardEvent) => void;

    constructor(
        playerMesh: THREE.Object3D,
        playerBody: RAPIER2D.RigidBody,
        physicsWorld: PhysicsWorld2D,
        characterHeight: number,
        blockFeetOffset: number,
    ) {
        this.playerMesh = playerMesh;
        this.playerBody = playerBody;
        this.physicsWorld = physicsWorld;
        this.characterHeight = characterHeight;
        this.capsuleHalfHeight = characterHeight / 2;
        this.capsuleRadius = CAPSULE.radius;
        this.blockFeetOffset = blockFeetOffset;

        this.runSpeed = DEFAULT_PHYSICS.runSpeed;
        this.groundFriction = DEFAULT_PHYSICS.groundFriction;
        this.airFriction = DEFAULT_PHYSICS.airFriction;
        this.airControlMultiplier = DEFAULT_PHYSICS.airControlMultiplier;
        this.walkStepHeight = DEFAULT_PHYSICS.walkStepHeight;
        this.hopStepHeight = DEFAULT_PHYSICS.hopStepHeight;
        this.stepClimbSpeed = DEFAULT_PHYSICS.stepClimbSpeed;

        this.jumpVelocity = Math.sqrt(2 * Math.abs(DEFAULT_PHYSICS.gravity) * DEFAULT_PHYSICS.jumpHeight);

        // TODO: keyboard-only — no touch input reaches these. See the class doc above.
        this.boundKeyDown = this.onKeyDown.bind(this);
        this.boundKeyUp = this.onKeyUp.bind(this);
        window.addEventListener('keydown', this.boundKeyDown);
        window.addEventListener('keyup', this.boundKeyUp);
    }

    setAnimationController(controller: CharacterAnimationController): void {
        this.animationController = controller;
    }

    setControlsEnabled(enabled: boolean): void {
        this.controlsEnabled = enabled;
        if (!enabled) {
            this.keysHeld = { left: false, right: false, jump: false };
            this.jumpJustPressed = false;
        }
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.controlsEnabled) return;
        const key = e.key.toLowerCase();
        if (key === 'a' || key === 'arrowleft') this.keysHeld.left = true;
        if (key === 'd' || key === 'arrowright') this.keysHeld.right = true;
        if (key === 'w' || key === 'arrowup' || key === ' ') {
            if (!this.keysHeld.jump) {
                this.keysHeld.jump = true;
                this.jumpJustPressed = true;
            }
        }
    }

    private onKeyUp(e: KeyboardEvent): void {
        const key = e.key.toLowerCase();
        if (key === 'a' || key === 'arrowleft') this.keysHeld.left = false;
        if (key === 'd' || key === 'arrowright') this.keysHeld.right = false;
        if (key === 'w' || key === 'arrowup' || key === ' ') this.keysHeld.jump = false;
    }

    update(deltaTime: number): void {
        if (!this.controlsEnabled) return;

        // If mid-climb, keep interpolating — unless player presses jump to cancel
        if (this.stepClimbActive) {
            if (this.jumpJustPressed && this.jumpsRemaining > 0) {
                this.stepClimbActive = false;
                this.isGrounded = true;
                this.jumpsRemaining = this.maxJumps;
            } else {
                this.handleStepClimbing(deltaTime);
                this.syncMeshToBody();
                const speed = Math.abs(this.playerBody.linvel().x);
                this.updateAnimation(speed);
                return;
            }
        }

        this.checkGrounded();

        // Try to start a new step climb (needs grounded state from above)
        if (this.handleStepClimbing(deltaTime)) {
            this.syncMeshToBody();
            const speed = Math.abs(this.playerBody.linvel().x);
            this.updateAnimation(speed);
            return;
        }

        if (this.isGrounded) {
            this.jumpsRemaining = this.maxJumps;
        }

        const vel = this.playerBody.linvel();

        let desiredVx = 0;
        if (this.keysHeld.left) desiredVx -= this.runSpeed;
        if (this.keysHeld.right) desiredVx += this.runSpeed;

        if (desiredVx !== 0) {
            this.facingRight = desiredVx > 0;
        }

        const friction = this.isGrounded ? this.groundFriction : this.airFriction;
        const control = this.isGrounded ? 1.0 : this.airControlMultiplier;
        let newVx: number;
        if (desiredVx !== 0) {
            newVx = vel.x + (desiredVx - vel.x) * control;
        } else {
            newVx = vel.x * friction;
        }

        let newVy = vel.y;
        if (this.jumpJustPressed && this.jumpsRemaining > 0) {
            newVy = this.jumpVelocity;
            this.jumpsRemaining--;
        }
        this.jumpJustPressed = false;

        this.playerBody.setLinvel({ x: newVx, y: newVy }, true);

        this.syncMeshToBody();

        const speed = Math.abs(newVx);
        this.updateAnimation(speed);
    }

    private checkGrounded(): void {
        const pos = this.playerBody.translation();
        const capsuleBottom = pos.y - this.capsuleHalfHeight;
        const rayOrigin = { x: pos.x, y: capsuleBottom + 0.02 };
        const rayDir = { x: 0, y: -1 };
        const maxDist = 0.1;

        const result = this.physicsWorld.raycast(rayOrigin, rayDir, maxDist, CollisionMask.GROUND_CHECK_NO_DEBRIS);
        this.isGrounded = result.hasHit;

        // Ground correction: only for clear penetration. A loose threshold (<0.01) fights
        // float error on compound statics and causes vertical bobbing when many colliders
        // are near the feet (e.g. debris piles below the ray while the capsule rests on terrain).
        if (result.hasHit && result.hitDistance < 0.004) {
            const vel = this.playerBody.linvel();
            if (vel.y <= 0) {
                const surfaceY = capsuleBottom + 0.02 - result.hitDistance;
                this.playerBody.setTranslation(
                    { x: pos.x, y: surfaceY + this.capsuleHalfHeight },
                    true,
                );
            }
        }
    }

    /**
     * 2D step climbing: automatically walk over small obstacles.
     * Steps ≤ walkStepHeight are silently glided over.
     * Steps ≤ hopStepHeight get a small upward boost (auto-hop).
     * Returns true when a climb is controlling position this frame.
     */
    private handleStepClimbing(deltaTime: number): boolean {
        // === Continue existing climb ===
        if (this.stepClimbActive) {
            this.stepClimbProgress += this.stepClimbSpeed * deltaTime;

            if (this.stepClimbProgress >= 1.0) {
                this.playerBody.setTranslation(
                    { x: this.stepClimbTargetX, y: this.stepClimbTargetY },
                    true,
                );
                this.playerBody.setLinvel(
                    { x: this.stepClimbDir * this.runSpeed * 0.4, y: 0 },
                    true,
                );
                this.stepClimbActive = false;
                this.isGrounded = true;
                return true;
            }

            const t = 1 - Math.pow(1 - this.stepClimbProgress, 2);
            const nx = this.stepClimbStartX + (this.stepClimbTargetX - this.stepClimbStartX) * t;
            const ny = this.stepClimbStartY + (this.stepClimbTargetY - this.stepClimbStartY) * t;
            this.playerBody.setTranslation({ x: nx, y: ny }, true);
            this.playerBody.setLinvel({ x: 0, y: 0 }, true);
            this.isGrounded = true;
            return true;
        }

        // === Try to start a new climb ===
        if (!this.isGrounded) return false;

        let dir = 0;
        if (this.keysHeld.left) dir -= 1;
        if (this.keysHeld.right) dir += 1;
        if (dir === 0) return false;

        const vel = this.playerBody.linvel();
        if (vel.y < -3) return false;

        const pos = this.playerBody.translation();
        const footY = pos.y - this.capsuleHalfHeight;

        // 1. Horizontal ray from shin height to detect a wall ahead
        const probeY = footY + this.walkStepHeight * 0.5;
        const probeLen = this.capsuleRadius + 0.3;
        const wallCheck = this.physicsWorld.raycast(
            { x: pos.x, y: probeY },
            { x: dir, y: 0 },
            probeLen,
            CollisionMask.GROUND_CHECK_NO_DEBRIS,
        );

        if (!wallCheck.hasHit) return false;
        if (wallCheck.hitRigidBody && !wallCheck.hitRigidBody.isFixed()) return false;

        // 2. Downward ray from above to find the step surface
        const aheadX = pos.x + dir * (this.capsuleRadius + 0.2);
        const surfaceCheck = this.physicsWorld.raycast(
            { x: aheadX, y: footY + this.hopStepHeight + 0.3 },
            { x: 0, y: -1 },
            this.hopStepHeight + 0.5,
            CollisionMask.GROUND_CHECK_NO_DEBRIS,
        );

        if (!surfaceCheck.hasHit) return false;

        const stepSurfaceY = surfaceCheck.hitPoint.y;
        const stepHeight = stepSurfaceY - footY;

        if (stepHeight < 0.03 || stepHeight > this.hopStepHeight) return false;
        if (footY > stepSurfaceY - 0.03) return false;

        // 3. Check headroom: make sure there's space above the step for the player
        const headCheck = this.physicsWorld.raycast(
            { x: aheadX, y: stepSurfaceY + 0.05 },
            { x: 0, y: 1 },
            this.characterHeight,
            CollisionMask.GROUND_CHECK_NO_DEBRIS,
        );
        if (headCheck.hasHit && headCheck.hitDistance < this.characterHeight * 0.9) return false;

        // 4. Start climb interpolation
        const targetY = stepSurfaceY + this.capsuleHalfHeight + 0.02;
        const forwardBoost = this.capsuleRadius + 0.15;

        this.stepClimbStartX = pos.x;
        this.stepClimbStartY = pos.y;
        this.stepClimbTargetX = pos.x + dir * forwardBoost;
        this.stepClimbTargetY = targetY;
        this.stepClimbDir = dir;
        this.stepClimbProgress = 0;
        this.stepClimbActive = true;

        this.playerBody.setLinvel({ x: 0, y: 0 }, true);
        return true;
    }

    private syncMeshToBody(): void {
        const pos = this.playerBody.translation();
        const capsuleBottom = pos.y - this.capsuleHalfHeight;
        // Matches CharacterLoader.syncCharacterWithPhysics:
        // blockFeetOffset is negative (feet below block root origin),
        // so subtracting it raises the group, compensating for the offset
        // that updateBlockCharacter re-applies when positioning the block root.
        const characterY = capsuleBottom - this.blockFeetOffset;
        this.playerMesh.position.set(pos.x, characterY, 0);
        this.playerMesh.rotation.y = this.facingRight ? Math.PI * 0.5 : -Math.PI * 0.5;
    }

    private updateAnimation(speed: number): void {
        if (!this.animationController) return;

        const isMoving = speed > 0.3;
        const isJumpPressed = this.keysHeld.jump;
        this.animationController.updateAnimation(isMoving, speed, this.isGrounded, isJumpPressed);
    }

    getPosition(): THREE.Vector3 {
        const pos = this.playerBody.translation();
        return new THREE.Vector3(pos.x, pos.y, 0);
    }

    getVelocity(): { x: number; y: number } {
        return this.playerBody.linvel();
    }

    getBody(): RAPIER2D.RigidBody {
        return this.playerBody;
    }

    isOnGround(): boolean {
        return this.isGrounded;
    }

    dispose(): void {
        window.removeEventListener('keydown', this.boundKeyDown);
        window.removeEventListener('keyup', this.boundKeyUp);
    }
}
