import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { Aircraft, type AircraftConfig, type AircraftControls } from 'debug/Aircraft.js';
import { CollisionMask } from 'engine/CollisionLayers.js';

export interface AirplaneConfig extends AircraftConfig {
    wingSpan: number;
    minSpeed: number; // Minimum speed to stay airborne
    maxSpeed: number;
    climbRate: number;
    turnRate: number;
}

export class Airplane extends Aircraft {
    private airplaneConfig: AirplaneConfig;
    private currentSpeed: number = 0;
    private targetSpeed: number = 0;
    private pitchAngle: number = 0;
    private rollAngle: number = 0;
    private yawRate: number = 0;
    private targetRollAngle: number = 0;
    private logicalYaw: number = 0; // Actual flight heading (like Unity)
    private lastLogTime: number = 0; // For throttled logging
    private isLanding: boolean = false;
    private wasSpacePressed: boolean = false; // Track space key state
    private isFlying: boolean = false;
    
    // Wing mesh for visual
    private wingMesh!: THREE.Mesh;
    
    constructor(engine: EngineLike, config: AirplaneConfig) {
        super(engine, config);
        this.airplaneConfig = config;
        
        this.createWings();
        
        // Set initial speed to 0 when created (parked)
        this.currentSpeed = 0;
        this.targetSpeed = 0;
        
        // Initialize logical heading from airplane's initial Y rotation
        this.logicalYaw = this.bodyMesh.rotation.y;
    }
    
    private createWings(): void {
        if (!this.engine.scene) return;
        
        // Create wing geometry
        const wingGeometry = new THREE.BoxGeometry(
            this.airplaneConfig.wingSpan,
            0.15,
            this.config.size.length * 0.25
        );
        const wingMaterial = new THREE.MeshStandardMaterial({ 
            color: this.config.bodyColor || 0x0066cc 
        });

        this.wingMesh = new THREE.Mesh(wingGeometry, wingMaterial);
        this.wingMesh.name = 'AirplaneWings';
        this.wingMesh.position.set(0, 0.2, 0);
        this.wingMesh.castShadow = true;
        this.bodyMesh.add(this.wingMesh);

        // Wing collision handled via compound shape built in createPhysics
        
    }
    
    public updateControls(controls: AircraftControls): void {
        if (!this.isPlayerFlying) return;
        
        // Unity-style controls: W = nose up, S = nose down, A/D = turn left/right
        
        // Pitch control - W/S controls nose up/down (like Unity)
        const pitchInput = controls.forward ? 1 : (controls.backward ? -1 : 0); // W = nose up, S = nose down
        const pitchSpeed = 30; // degrees per second - slower pitch
        const maxPitchAngle = 30; // degrees - less extreme pitch
        
        if (Math.abs(pitchInput) > 0.01) {
            this.pitchAngle += pitchInput * pitchSpeed * (1/60) * (Math.PI/180); // Convert to radians per frame
            this.pitchAngle = Math.max(-maxPitchAngle * (Math.PI/180), Math.min(maxPitchAngle * (Math.PI/180), this.pitchAngle));
        } else {
            // Gradually level out when no input (like Unity)
            this.pitchAngle = this.pitchAngle * 0.95;
        }
        
        // Yaw control - A/D controls turn left/right (like Unity)
        const yawInput = controls.left ? 1 : (controls.right ? -1 : 0); // Fixed inversion
        const turningSpeed = 60; // degrees per second - slower turning
        
        if (Math.abs(yawInput) > 0.01) {
            this.yawRate = yawInput * turningSpeed * (1/60) * (Math.PI/180); // Convert to radians per frame
            this.targetRollAngle = -yawInput * 20 * (Math.PI/180); // Banking when turning (20 degrees max, less banking)
            
            // Update logical flight heading (like Unity)
            this.logicalYaw += this.yawRate;
            // Keep in 0-2π range
            if (this.logicalYaw < 0) this.logicalYaw += Math.PI * 2;
            if (this.logicalYaw >= Math.PI * 2) this.logicalYaw -= Math.PI * 2;
        } else {
            // Stop turning and level wings when no input
            this.yawRate = 0;
            this.targetRollAngle = 0;
        }
        
        // Smooth roll transition (banking)
        this.rollAngle += (this.targetRollAngle - this.rollAngle) * 0.2;
        
        // Simple Space key logic - only on key release (onKeyUp)
        const spacePressed = controls.up;
        if (!spacePressed && this.wasSpacePressed) { // Only trigger on key release
            if (!this.isFlying && !this.isLanding) {
                // State 1: Start flying
                this.isFlying = true;
                this.targetSpeed = this.airplaneConfig.maxSpeed * 0.5;
                this.currentSpeed = this.airplaneConfig.minSpeed;
                console.log('Airplane: Starting to fly');
            } else if (this.isFlying && this.isLowToGround()) {
                // State 2: Start landing
                this.isLanding = true;
                this.isFlying = false; // Stop flying state so player can exit
                console.log('Airplane: Starting landing sequence');
            }
        }
        this.wasSpacePressed = spacePressed;
        
        // Emergency land
        if (controls.land && this.canPlayerLand()) {
            this.targetSpeed = 0;
        }
    }
    
    protected calculateFlightForces(): { thrust: THREE.Vector3; lift: THREE.Vector3; drag: THREE.Vector3 } {
        // Throttled debug logging (once per second)
        const now = Date.now();
        if (now - this.lastLogTime > 1000) {
            console.log('Airplane: isPlayerFlying:', this.isPlayerFlying, 'currentSpeed:', this.currentSpeed, 'targetSpeed:', this.targetSpeed);
            this.lastLogTime = now;
        }
        
        // Smooth speed transition
        this.currentSpeed += (this.targetSpeed - this.currentSpeed) * 0.1;
        
        // Auto-maintain flying speed when airborne (no manual throttle control)
        if (!this.isGrounded && this.currentSpeed > this.airplaneConfig.minSpeed) {
            const cruiseSpeed = this.airplaneConfig.maxSpeed * 0.5; // 50% of max speed - gradual increase from 30%
            this.targetSpeed = cruiseSpeed;
        }
        
        // Proper matrix math: Apply rotations separately and multiply matrices
        
        // Start with forward direction (0, 0, 1) in local space
        const baseForward = new THREE.Vector3(0, 0, 1);
        
        // Create rotation matrices separately
        const yawRotation = new THREE.Matrix4().makeRotationY(this.logicalYaw);
        const pitchRotation = new THREE.Matrix4().makeRotationX(this.pitchAngle);
        
        // Multiply matrices in correct order: first pitch, then yaw
        const combinedRotation = new THREE.Matrix4();
        combinedRotation.multiplyMatrices(yawRotation, pitchRotation);
        
        // Apply combined rotation to base forward vector
        const pitchedDirection = baseForward.clone();
        pitchedDirection.applyMatrix4(combinedRotation);
        
        // Directly set velocity in the nose direction (like Unity)
        const targetVelocity = pitchedDirection.clone().multiplyScalar(this.currentSpeed);
        
        // Throttled velocity logging
        if (this.currentSpeed > 0.1 && now - this.lastLogTime > 1000) {
            console.log('Airplane: Setting velocity, currentSpeed:', this.currentSpeed, 'direction:', pitchedDirection);
        }
        
        // Set the physics body velocity directly to match nose direction
        if (this.aircraftBody) {
            this.aircraftBody.setLinvel({ x: targetVelocity.x, y: targetVelocity.y, z: targetVelocity.z }, true);
        }
        
        // Update visual rotation to match logical direction + banking
        this.updateVisualRotation();
        
        // Return minimal forces since we're setting velocity directly
        const thrust = new THREE.Vector3(0, 0, 0);
        const lift = new THREE.Vector3(0, 0, 0);
        const drag = new THREE.Vector3(0, 0, 0);
        
        return { thrust, lift, drag };
    }
    
    private isLowToGround(): boolean {
        if (!this.engine.physicsWorld) return false;
        
        const position = this.getPosition();
        const rayOrigin = new THREE.Vector3(position.x, position.y, position.z);
        const rayDirection = new THREE.Vector3(0, -1, 0);
        const maxDistance = 10;
        
        const result = this.engine.physicsWorld.raycast(rayOrigin, rayDirection, maxDistance, CollisionMask.ENVIRONMENT);
        
        return result.hasHit && (position.y - result.hitPoint.y) <= 2;
    }
    
    private startLanding(): void {
        console.log('Airplane: Starting landing sequence');
        this.isLanding = true;
        this.targetSpeed = 0; // Slow down to stop
        this.pitchAngle = -0.1; // Slight nose down for landing
    }
    
    private updateLanding(): void {
        if (!this.isLanding || !this.aircraftBody) return;
        
        // Gradually lower target speed (current speed will follow automatically) - slower decline
        this.targetSpeed = Math.max(this.targetSpeed - 0.05, 0);
        
        // Force gentle descent
        const currentPos = this.getPosition();
        const descendRate = -1.5; // Gentle descent
        
        // Calculate landing direction (forward + down)
        const landingDirection = new THREE.Vector3(
            Math.sin(this.logicalYaw) * 0.3, // Slow forward movement
            descendRate,                      // Downward movement
            Math.cos(this.logicalYaw) * 0.3  // Slow forward movement
        );
        
        this.aircraftBody.setLinvel({ x: landingDirection.x, y: landingDirection.y, z: landingDirection.z }, true);
        
        // Check if landing is complete
        if (this.currentSpeed < 0.5 && currentPos.y < 1.5) {
            // Landing complete
            this.isLanding = false;
            this.currentSpeed = 0;
            this.targetSpeed = 0;
            this.pitchAngle = 0;
            this.isGrounded = true;
            
            // Stop all movement
            this.aircraftBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            this.aircraftBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
            
            console.log('Airplane: Landing complete, stopped');
        }
    }
    
    private updateVisualRotation(): void {
        // Use the SAME matrix math for visual rotation as for movement direction
        // This ensures the airplane visually points where it's actually moving
        
        // Create the same rotation matrices used for movement
        const yawRotation = new THREE.Matrix4().makeRotationY(this.logicalYaw);
        const pitchRotation = new THREE.Matrix4().makeRotationX(this.pitchAngle);
        const rollRotation = new THREE.Matrix4().makeRotationZ(this.rollAngle);
        
        // Apply in same order: yaw, then pitch, then roll for visual banking
        const combinedRotation = new THREE.Matrix4();
        combinedRotation.multiplyMatrices(yawRotation, pitchRotation);
        combinedRotation.multiply(rollRotation);
        
        // Extract quaternion from matrix and apply to mesh
        const quaternion = new THREE.Quaternion();
        quaternion.setFromRotationMatrix(combinedRotation);
        this.bodyMesh.quaternion.copy(quaternion);
    }
    
    public update(): void {
        if (!this.aircraftBody) return;
        
        // Get current physics state
        const pos = this.aircraftBody.translation();
        
        // Update visual position (but not rotation - we handle that in applyVisualBanking)
        this.bodyMesh.position.set(pos.x, pos.y, pos.z);
        
        // Apply flight physics if player is flying
        if (this.isPlayerFlying) {
            if (this.isLanding) {
                this.updateLanding();
            } else {
                this.updateFlightPhysics();
            }
        }
        
        // Check if grounded
        this.checkGrounded();
    }
    
    public canPlayerEnter(): boolean {
        return !this.isPlayerFlying && this.isGrounded && this.currentSpeed < 1;
    }
    
    public canPlayerLand(): boolean {
        return this.isPlayerFlying && this.isGrounded && this.currentSpeed < 1;
    }
    
    public enterAircraft(player: any): boolean {
        if (!this.canPlayerEnter()) return false;
        
        const success = super.enterAircraft(player);
        if (success) {
            // Start with engines off - player must press Space to start
            this.targetSpeed = 0;
            this.currentSpeed = 0;
            console.log('Airplane: Player entered, press Space to start engines');
        }
        
        return success;
    }
    
    public exitAircraft(): any {
        // Can exit when not flying (includes landing state)
        if (this.isFlying) {
            console.log('Airplane: Cannot exit while flying');
            return null;
        }
        
        const pilot = super.exitAircraft();
        if (pilot && this.aircraftBody) {
            // Reset airplane to ready state
            this.isFlying = false;
            this.isLanding = false;
            this.currentSpeed = 0;
            this.targetSpeed = 0;
            this.pitchAngle = 0;
            this.yawRate = 0;
            
            // Stop physics movement
            this.aircraftBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            this.aircraftBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
            
            console.log('Airplane: Player exited, ready for next flight');
        }
        
        return pilot;
    }
    
    public getCurrentSpeed(): number {
        return this.currentSpeed;
    }
    
    public getTargetSpeed(): number {
        return this.targetSpeed;
    }
    
    public isStalled(): boolean {
        return this.currentSpeed < this.airplaneConfig.minSpeed && !this.isGrounded;
    }
}
