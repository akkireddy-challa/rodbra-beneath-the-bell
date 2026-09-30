import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { Interactable } from 'types/interactable.js';
import { t } from 'engine/i18n/index.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';

export interface AircraftConfig {
    position: THREE.Vector3;
    mass: number;
    size: { width: number; height: number; length: number };
    maxAltitude: number;
    bodyColor?: number;
    type: 'airplane' | 'helicopter' | 'balloon';
}

export interface AircraftControls {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    land: boolean;
}

export abstract class Aircraft implements Interactable {
    protected engine: EngineLike;
    protected bodyMesh!: THREE.Mesh;
    protected aircraftBody: RAPIER.RigidBody | null = null;
    protected aircraftCollider: RAPIER.Collider | null = null;
    protected config: AircraftConfig;
    protected isPlayerFlying: boolean = false;
    protected currentPilot: any = null;
    protected interactableComponent: InteractableComponent | null = null;
    
    // Flight physics
    protected velocity: THREE.Vector3 = new THREE.Vector3();
    protected angularVelocity: THREE.Vector3 = new THREE.Vector3();
    protected thrust: number = 0;
    protected lift: number = 0;
    protected isGrounded: boolean = true;
    
    // Constants
    protected readonly GRAVITY = -9.81;
    protected readonly AIR_DENSITY = 1.225; // kg/m³
    protected readonly DRAG_COEFFICIENT = 0.02;
    
    constructor(engine: EngineLike, config: AircraftConfig) {
        this.engine = engine;
        this.config = config;
        
        this.createBody();
        this.createPhysics();

        // Create trigger sensor for interaction detection
        if (this.aircraftBody && this.engine.physicsWorld) {
            this.interactableComponent = new InteractableComponent(this.engine.physicsWorld, {
                interactable: this,
                object3D: this.bodyMesh,
                physicsBody: this.aircraftBody,
                radius: 5.0,
            });
        }
    }
    
    protected getRapierWorld(): RAPIER.World | null {
        return this.engine.physicsWorld?.getRapierWorld() ?? null;
    }
    
    protected createBody(): void {
        if (!this.engine.scene) {
            throw new Error('Engine scene is not initialized');
        }
        
        // Create basic aircraft body (can be overridden by subclasses)
        const geometry = new THREE.BoxGeometry(
            this.config.size.width,
            this.config.size.height,
            this.config.size.length
        );
        const material = new THREE.MeshStandardMaterial({ 
            color: this.config.bodyColor || 0x0066cc 
        });
        
        this.bodyMesh = new THREE.Mesh(geometry, material);
        this.bodyMesh.name = `Aircraft_${this.config.type}_Body`;
        this.bodyMesh.position.copy(this.config.position);
        this.bodyMesh.castShadow = true;
        this.bodyMesh.receiveShadow = true;
        
        // Add user data for identification
        this.bodyMesh.userData = {
            isAircraft: true,
            aircraftType: this.config.type,
            aircraft: this,
        };

        this.engine.scene.add(this.bodyMesh);
    }
    
    protected createPhysics(): void {
        if (!this.engine.physicsWorld) {
            throw new Error('Physics world is not initialized');
        }
        
        const RAPIER = getRapier();
        const world = this.getRapierWorld();
        if (!world) {
            throw new Error('Rapier world is not available');
        }
        
        // Create rigid body descriptor
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(this.config.position.x, this.config.position.y, this.config.position.z)
            .setGravityScale(0) // Disable gravity initially - we'll handle flight physics manually
            .setLinearDamping(0.1)
            .setAngularDamping(0.5);
        
        this.aircraftBody = world.createRigidBody(bodyDesc);
        
        // Create main body collider
        // Rapier format: lower 16 bits = membership, upper 16 bits = filter (what it collides with)
        const collisionGroups = (CollisionMask.VEHICLE << 16) | CollisionGroup.VEHICLE;
        const colliderDesc = RAPIER.ColliderDesc.cuboid(
            this.config.size.width * 0.5,
            this.config.size.height * 0.5,
            this.config.size.length * 0.5
        )
            .setMass(this.config.mass)
            .setCollisionGroups(collisionGroups);
        
        this.aircraftCollider = world.createCollider(colliderDesc, this.aircraftBody);
        
        // For airplanes, add wing collider
        if (this.config.type === 'airplane') {
            const wingSpan = (this.config as any).wingSpan ?? this.config.size.width * 4;
            const wingColliderDesc = RAPIER.ColliderDesc.cuboid(
                wingSpan * 0.5,
                0.05,
                this.config.size.length * 0.2
            )
                .setTranslation(0, 0.2, 0)
                .setCollisionGroups(collisionGroups);
            
            world.createCollider(wingColliderDesc, this.aircraftBody);
        }
    }
    
    public abstract updateControls(controls: AircraftControls): void;
    
    protected abstract calculateFlightForces(): { thrust: THREE.Vector3; lift: THREE.Vector3; drag: THREE.Vector3 };
    
    public update(): void {
        if (!this.aircraftBody) return;
        
        // Get current physics state
        const pos = this.aircraftBody.translation();
        const rot = this.aircraftBody.rotation();
        
        // Update visual position
        this.bodyMesh.position.set(pos.x, pos.y, pos.z);
        this.bodyMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
        
        // Apply flight physics if player is flying
        if (this.isPlayerFlying) {
            this.updateFlightPhysics();
        }
        
        // Check if grounded
        this.checkGrounded();
    }
    
    protected updateFlightPhysics(): void {
        if (!this.aircraftBody) return;
        
        // Calculate flight forces
        const forces = this.calculateFlightForces();
        
        // Apply forces to physics body - reduce gravity for easier flight
        const gravityForce = this.config.type === 'airplane' ? this.GRAVITY * this.config.mass * 0.7 : this.GRAVITY * this.config.mass;
        const totalForce = {
            x: forces.thrust.x + forces.lift.x + forces.drag.x,
            y: forces.thrust.y + forces.lift.y + forces.drag.y + gravityForce,
            z: forces.thrust.z + forces.lift.z + forces.drag.z
        };
        
        this.aircraftBody.addForce(totalForce, true);
        
        // Altitude limit
        const currentPos = this.getPosition();
        if (currentPos.y > this.config.maxAltitude) {
            const velocity = this.aircraftBody.linvel();
            if (velocity.y > 0) {
                this.aircraftBody.setLinvel({ x: velocity.x, y: 0, z: velocity.z }, true);
            }
        }
    }
    
    protected checkGrounded(): void {
        if (!this.engine.physicsWorld) return;
        
        const position = this.getPosition();
        const rayOrigin = new THREE.Vector3(position.x, position.y, position.z);
        const rayDirection = new THREE.Vector3(0, -1, 0);
        const maxDistance = 2;
        
        const result = this.engine.physicsWorld.raycast(rayOrigin, rayDirection, maxDistance, CollisionMask.ENVIRONMENT);
        
        this.isGrounded = result.hasHit && result.hitPoint.y > position.y - 1.5;
    }
    
    public getPosition(): THREE.Vector3 {
        return this.bodyMesh.position.clone();
    }
    
    public getBodyObject(): THREE.Mesh {
        return this.bodyMesh;
    }
    
    public isNearPosition(position: THREE.Vector3, maxDistance: number = 4.0): boolean {
        return this.getPosition().distanceTo(position) <= maxDistance;
    }
    
    public canPlayerEnter(): boolean {
        return !this.isPlayerFlying && this.isGrounded;
    }
    
    public canPlayerLand(): boolean {
        return this.isPlayerFlying && this.isGrounded;
    }
    
    public enterAircraft(player: any): boolean {
        if (!this.canPlayerEnter()) return false;
        
        this.isPlayerFlying = true;
        this.currentPilot = player;
        
        // Position player inside aircraft
        if (player && player.position) {
            player.position.copy(this.getPosition());
            player.position.y += 0.5;
        }
        
        // Enable custom gravity for flight physics (already set to 0 in createPhysics)
        if (this.aircraftBody) {
            this.aircraftBody.setGravityScale(0, true);
        }
        
        return true;
    }
    
    public exitAircraft(): any {
        if (!this.isPlayerFlying) return null;
        
        const pilot = this.currentPilot;
        this.isPlayerFlying = false;
        this.currentPilot = null;
        
        // Reset controls
        this.thrust = 0;
        this.lift = 0;
        
        // Position player next to aircraft
        if (pilot && pilot.position) {
            const aircraftPosition = this.getPosition();
            pilot.position.set(
                aircraftPosition.x + this.config.size.width * 0.7,
                aircraftPosition.y + 0.5,
                aircraftPosition.z
            );
        }
        
        // Re-enable normal gravity when not flying
        if (this.aircraftBody) {
            this.aircraftBody.setGravityScale(1.0, true);
        }
        
        return pilot;
    }
    
    public isPlayerInAircraft(): boolean {
        return this.isPlayerFlying;
    }
    
    public getCurrentPilot(): any {
        return this.currentPilot;
    }
    
    public getAircraftType(): string {
        return this.config.type;
    }
    
    public isAircraftGrounded(): boolean {
        return this.isGrounded;
    }

    /**
     * Interactable interface implementation
     * Called when player starts interacting (entering aircraft)
     */
    public onInteractStart(): boolean {
        if (!this.canPlayerEnter()) {
            return false;
        }

        // Aircraft interaction logic is minimal here
        // The actual enter logic is handled by enterAircraft() called from PlayerController
        return true;
    }

    /**
     * Called when player stops interacting (exiting aircraft)
     */
    public onInteractEnd(): void {
        // Aircraft interaction end is handled by exitAircraft()
        // This is called from PlayerController when landing
    }

    /**
     * Get display text for starting interaction based on aircraft type
     */
    public getInteractStartDisplayName(): string {
        switch (this.config.type) {
            case 'airplane':
                return t('game.interaction.enterAirplane');
            case 'helicopter':
                return t('game.interaction.enterHelicopter');
            case 'balloon':
                return t('game.interaction.enterBalloon');
            default:
                return t('game.interaction.enterAircraft');
        }
    }

    /**
     * Get display text for ending interaction based on aircraft type
     */
    public getInteractEndDisplayName(): string {
        switch (this.config.type) {
            case 'airplane':
                return t('game.interaction.landAirplane');
            case 'helicopter':
                return t('game.interaction.landHelicopter');
            case 'balloon':
                return t('game.interaction.landBalloon');
            default:
                return t('game.interaction.landAircraft');
        }
    }

    public dispose(): void {
        // Dispose interactable trigger sensor (before physics body removal)
        if (this.interactableComponent) {
            this.interactableComponent.dispose();
            this.interactableComponent = null;
        }

        // Remove from physics world
        const world = this.getRapierWorld();
        if (world && this.aircraftBody) {
            world.removeRigidBody(this.aircraftBody);
            this.aircraftBody = null;
            this.aircraftCollider = null;
        }

        // Remove from scene
        if (this.engine.scene && this.bodyMesh) {
            this.engine.scene.remove(this.bodyMesh);
        }
    }
}
