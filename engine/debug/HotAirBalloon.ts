import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { Aircraft, type AircraftConfig, type AircraftControls } from 'debug/Aircraft.js';

export interface HotAirBalloonConfig extends AircraftConfig {
    balloonRadius: number;
    basketSize: { width: number; height: number; length: number };
    maxBuoyancy: number;
    windSensitivity: number;
}

export class HotAirBalloon extends Aircraft {
    private balloonConfig: HotAirBalloonConfig;
    private balloonMesh!: THREE.Mesh;
    private basketMesh!: THREE.Mesh;
    private ropeMeshes: THREE.Mesh[] = [];
    private buoyancy: number = 0;
    private targetBuoyancy: number = 0;
    private windForce: THREE.Vector3 = new THREE.Vector3();
    private horizontalThrust: THREE.Vector3 = new THREE.Vector3();
    
    constructor(engine: EngineLike, config: HotAirBalloonConfig) {
        super(engine, config);
        this.balloonConfig = config;
        
        this.createBalloonComponents();
        this.initializeWind();
    }
    
    protected createBody(): void {
        if (!this.engine.scene) return;
        
        // Override to create basket instead of generic body
        // Use config.size for basket dimensions (set in AircraftManager)
        const basketGeometry = new THREE.BoxGeometry(
            this.config.size.width,
            this.config.size.height,
            this.config.size.length
        );
        const basketMaterial = new THREE.MeshStandardMaterial({ 
            color: 0x8B4513 // Brown basket
        });
        
        this.bodyMesh = new THREE.Mesh(basketGeometry, basketMaterial);
        this.bodyMesh.name = 'BalloonBasket';
        this.bodyMesh.position.copy(this.config.position);
        this.bodyMesh.castShadow = true;
        this.bodyMesh.receiveShadow = true;
        
        this.bodyMesh.userData = {
            isAircraft: true,
            aircraftType: this.config.type,
            aircraft: this,
            interactable: this  // Generic interactable reference
        };
        
        this.engine.scene.add(this.bodyMesh);
    }
    
    private createBalloonComponents(): void {
        if (!this.engine.scene) return;
        
        // Create balloon
        const balloonGeometry = new THREE.SphereGeometry(this.balloonConfig.balloonRadius, 16, 12);
        const balloonMaterial = new THREE.MeshStandardMaterial({ 
            color: this.config.bodyColor || 0xff6b6b 
        });
        
        this.balloonMesh = new THREE.Mesh(balloonGeometry, balloonMaterial);
        this.balloonMesh.name = 'HotAirBalloon_Balloon';
        this.balloonMesh.position.set(0, this.balloonConfig.balloonRadius + 2, 0);
        this.balloonMesh.castShadow = true;
        this.bodyMesh.add(this.balloonMesh);
        
        // Create ropes connecting basket to balloon
        const ropeGeometry = new THREE.CylinderGeometry(0.02, 0.02, this.balloonConfig.balloonRadius + 1, 8);
        const ropeMaterial = new THREE.MeshStandardMaterial({ color: 0x654321 });
        
        const ropePositions = [
            { x: -0.4, z: -0.4 },
            { x: 0.4, z: -0.4 },
            { x: -0.4, z: 0.4 },
            { x: 0.4, z: 0.4 }
        ];
        
        ropePositions.forEach((pos, index) => {
            const rope = new THREE.Mesh(ropeGeometry, ropeMaterial);
            rope.name = `BalloonRope_${index}`;
            rope.position.set(pos.x, this.balloonConfig.balloonRadius * 0.5 + 1, pos.z);
            this.bodyMesh.add(rope);
            this.ropeMeshes.push(rope);
        });
    }
    
    private initializeWind(): void {
        // Simple wind simulation
        this.windForce.set(
            (Math.random() - 0.5) * 2,
            0,
            (Math.random() - 0.5) * 2
        );
    }
    
    public updateControls(controls: AircraftControls): void {
        if (!this.isPlayerFlying) return;
        
        // Buoyancy control (heating air in balloon)
        if (controls.up) {
            this.targetBuoyancy = Math.min(this.targetBuoyancy + 0.5, this.balloonConfig.maxBuoyancy);
        } else if (controls.down) {
            this.targetBuoyancy = Math.max(this.targetBuoyancy - 0.5, -this.balloonConfig.maxBuoyancy * 0.5);
        } else {
            // Gradual cooling - balloon naturally wants to descend
            this.targetBuoyancy = Math.max(this.targetBuoyancy - 0.1, 0);
        }
        
        // Strong horizontal control for arcade gameplay
        this.horizontalThrust.set(0, 0, 0);
        const controlForce = 400;
        
        if (controls.forward) this.horizontalThrust.z = -controlForce;
        if (controls.backward) this.horizontalThrust.z = controlForce;
        if (controls.left) this.horizontalThrust.x = -controlForce;
        if (controls.right) this.horizontalThrust.x = controlForce;
        
        // Landing
        if (controls.land && this.canPlayerLand()) {
            this.targetBuoyancy = -this.balloonConfig.maxBuoyancy;
        }
    }
    
    protected calculateFlightForces(): { thrust: THREE.Vector3; lift: THREE.Vector3; drag: THREE.Vector3 } {
        if (!this.aircraftBody) {
            return { thrust: new THREE.Vector3(), lift: new THREE.Vector3(), drag: new THREE.Vector3() };
        }
        
        // Smooth buoyancy transition
        this.buoyancy += (this.targetBuoyancy - this.buoyancy) * 0.05;
        
        // Buoyant force (upward) - needs to overcome gravity (mass * 9.81)
        const lift = new THREE.Vector3(0, this.buoyancy * 300, 0);
        
        // Horizontal thrust (limited directional control)
        const thrust = this.horizontalThrust.clone();
        
        // Wind effects
        const windEffect = this.windForce.clone().multiplyScalar(this.balloonConfig.windSensitivity);
        thrust.add(windEffect);
        
        // Drag (air resistance)
        const velocity = this.aircraftBody.linvel();
        const velocityVec = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
        const speed = velocityVec.length();
        const drag = velocityVec.clone().normalize().multiplyScalar(-speed * speed * this.DRAG_COEFFICIENT * 2); // Higher drag for balloon
        
        return { thrust, lift, drag };
    }
    
    public update(): void {
        super.update();
        
        // Update wind (slowly changing)
        if (Math.random() < 0.01) {
            this.windForce.add(new THREE.Vector3(
                (Math.random() - 0.5) * 0.1,
                0,
                (Math.random() - 0.5) * 0.1
            ));
            this.windForce.multiplyScalar(0.95); // Keep wind reasonable
        }
        
        // Balloon visual effects based on buoyancy
        if (this.balloonMesh) {
            const scale = 1 + this.buoyancy * 0.02; // Balloon expands slightly when heated
            this.balloonMesh.scale.setScalar(Math.max(0.8, Math.min(1.2, scale)));
        }
    }
    
    public canPlayerEnter(): boolean {
        return !this.isPlayerFlying && this.isGrounded && this.buoyancy < 1;
    }
    
    public canPlayerLand(): boolean {
        return this.isPlayerFlying && (this.isGrounded || this.getPosition().y < 5);
    }
    
    public enterAircraft(player: any): boolean {
        if (!this.canPlayerEnter()) return false;
        
        const success = super.enterAircraft(player);
        if (success) {
            // Start with minimal buoyancy
            this.targetBuoyancy = 2;
            this.buoyancy = 0;
            console.log('Hot Air Balloon: Player entered, heating air');
        }
        
        return success;
    }
    
    public exitAircraft(): any {
        // Can exit when close to ground
        if (!this.canPlayerLand()) {
            console.log('Hot Air Balloon: Cannot exit while too high in the air');
            return null;
        }
        
        const pilot = super.exitAircraft();
        if (pilot && this.aircraftBody) {
            // Cool down balloon
            this.buoyancy = 0;
            this.targetBuoyancy = 0;
            this.horizontalThrust.set(0, 0, 0);
            
            // Stop movement
            this.aircraftBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            this.aircraftBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
            
            console.log('Hot Air Balloon: Player exited, cooling down');
        }
        
        return pilot;
    }
    
    public getBuoyancy(): number {
        return this.buoyancy;
    }
    
    public getWindForce(): THREE.Vector3 {
        return this.windForce.clone();
    }
    
    public isInflated(): boolean {
        return this.buoyancy > 1;
    }
}
