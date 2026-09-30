import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { Aircraft, type AircraftConfig, type AircraftControls } from 'debug/Aircraft.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';

export interface HelicopterConfig extends AircraftConfig {
    rotorRadius: number;
    maxVerticalSpeed: number;
    maxHorizontalSpeed: number;
    hoverStability: number;
}

export class Helicopter extends Aircraft {
    private helicopterConfig: HelicopterConfig;
    private rotorMesh!: THREE.Mesh;
    private tailRotorMesh!: THREE.Mesh;
    private rotorSpeed: number = 0;
    private targetRotorSpeed: number = 0;
    private verticalInput: number = 0;
    private horizontalThrust: THREE.Vector3 = new THREE.Vector3();
    private currentAltitude: number = 0;
    private targetAltitude: number = 0;
    private trackedRotation: number = 0;
    
    constructor(engine: EngineLike, config: HelicopterConfig) {
        super(engine, config);
        this.helicopterConfig = config;
        
        this.createRotors();
    }
    
    private createRotors(): void {
        if (!this.engine.scene) return;
        
        // Create main rotor with individual blades
        this.rotorMesh = new THREE.Group() as any;
        this.rotorMesh.name = 'HelicopterRotor_Main';
        this.rotorMesh.position.set(0, this.config.size.height * 0.6, 0);
        
        // Create rotor blades
        const bladeGeometry = new THREE.BoxGeometry(
            this.helicopterConfig.rotorRadius * 0.9,
            0.02,
            0.1
        );
        const bladeMaterial = new THREE.MeshStandardMaterial({ color: 0x222222 });
        
        // Create 2 main rotor blades
        for (let i = 0; i < 2; i++) {
            const blade = new THREE.Mesh(bladeGeometry, bladeMaterial);
            blade.name = `HelicopterBlade_${i}`;
            blade.rotation.y = (i * Math.PI); // Opposite blades
            blade.castShadow = true;
            this.rotorMesh.add(blade);
        }
        
        this.bodyMesh.add(this.rotorMesh);
        
        // Tail rotor
        const tailRotorGeometry = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16);
        this.tailRotorMesh = new THREE.Mesh(tailRotorGeometry, bladeMaterial);
        this.tailRotorMesh.name = 'HelicopterRotor_Tail';
        this.tailRotorMesh.position.set(0, 0, -this.config.size.length * 0.6);
        this.tailRotorMesh.rotation.x = Math.PI / 2;
        this.bodyMesh.add(this.tailRotorMesh);
    }
    
    public updateControls(controls: AircraftControls): void {
        if (!this.isPlayerFlying) return;
        
        this.currentAltitude = this.getPosition().y;
        
        if (controls.up) {
            this.verticalInput = 1.0;
            this.targetRotorSpeed = 8;
            this.targetAltitude = this.currentAltitude;
        } else if (controls.down) {
            this.verticalInput = -1.0;
            this.targetRotorSpeed = 8;
            this.targetAltitude = this.currentAltitude;
        } else {
            this.verticalInput = 0;
            this.targetRotorSpeed = 6;
        }
        
        this.horizontalThrust.set(0, 0, 0);
        const controlForce = 3000;
        
        if (controls.forward) {
            this.horizontalThrust.z = controlForce;
        }
        if (controls.backward) {
            this.horizontalThrust.z = -controlForce;
        }
        if (controls.left) {
            this.horizontalThrust.x = -controlForce;
        }
        if (controls.right) {
            this.horizontalThrust.x = controlForce;
        }
        
        if (controls.land && this.canPlayerLand()) {
            this.targetRotorSpeed = 0;
            this.verticalInput = -2.0;
        }
    }
    
    protected calculateFlightForces(): { thrust: THREE.Vector3; lift: THREE.Vector3; drag: THREE.Vector3 } {
        if (!this.aircraftBody) {
            return { thrust: new THREE.Vector3(), lift: new THREE.Vector3(), drag: new THREE.Vector3() };
        }
        
        this.rotorSpeed += (this.targetRotorSpeed - this.rotorSpeed) * 0.15;
        
        const velocity = this.aircraftBody.linvel();
        const velocityVec = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
        
        const mass = this.config.mass || 500;
        
        const gravityVec = this.engine.physicsWorld?.getGravity() ?? new THREE.Vector3(0, -9.81, 0);
        const gravityMagnitude = Math.abs(gravityVec.y);
        const hoverForce = mass * gravityMagnitude;
        
        const verticalVelocity = velocityVec.y;
        let verticalForce = hoverForce;
        
        if (this.verticalInput > 0) {
            verticalForce = hoverForce + 8000 - (verticalVelocity * 300);
        } else if (this.verticalInput < 0) {
            verticalForce = hoverForce - 6000 - (verticalVelocity * 300);
        } else {
            const altitudeError = this.targetAltitude - this.currentAltitude;
            const strongDamping = verticalVelocity * 1200;
            
            if (altitudeError > 0.1) {
                const liftBoost = Math.min(altitudeError * 2500, 5000);
                verticalForce = hoverForce + liftBoost - strongDamping;
            } else if (altitudeError < -0.1) {
                const descentForce = Math.min(Math.abs(altitudeError) * 3000, 6000);
                verticalForce = -descentForce - strongDamping;
            } else {
                verticalForce = hoverForce - strongDamping;
            }
        }
        
        const lift = new THREE.Vector3(0, verticalForce, 0);
        
        const forward = new THREE.Vector3();
        this.bodyMesh.getWorldDirection(forward);
        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        
        const worldThrust = new THREE.Vector3();
        worldThrust.add(forward.clone().multiplyScalar(this.horizontalThrust.z));
        worldThrust.add(right.clone().multiplyScalar(this.horizontalThrust.x));
        
        const horizontalVelocity = new THREE.Vector3(velocityVec.x, 0, velocityVec.z);
        const horizontalSpeed = horizontalVelocity.length();
        const horizontalDrag = horizontalVelocity.clone().normalize().multiplyScalar(-horizontalSpeed * 400);
        worldThrust.add(horizontalDrag);
        
        const speed = velocityVec.length();
        const drag = velocityVec.clone().normalize().multiplyScalar(-speed * speed * this.DRAG_COEFFICIENT * 0.8);
        
        return { thrust: worldThrust, lift, drag };
    }
    
    protected updateFlightPhysics(): void {
        if (!this.aircraftBody) return;
        
        if (this.isGrounded && this.verticalInput === 0) {
            return;
        }
        
        const forces = this.calculateFlightForces();
        
        const totalForce = {
            x: forces.thrust.x + forces.drag.x,
            y: forces.lift.y + forces.drag.y,
            z: forces.thrust.z + forces.drag.z
        };
        
        this.aircraftBody.addForce(totalForce, true);
        this.aircraftBody.wakeUp();
        
        const currentPos = this.getPosition();
        if (currentPos.y > this.config.maxAltitude) {
            const velocity = this.aircraftBody.linvel();
            if (velocity.y > 0) {
                this.aircraftBody.setLinvel({ x: velocity.x, y: 0, z: velocity.z }, true);
            }
        }
    }
    
    public update(): void {
        super.update();
        
        if (this.isPlayerFlying && !this.isGrounded && this.engine.camera) {
            this.alignWithCamera();
        }
        
        if (this.rotorSpeed > 0.1) {
            this.rotorMesh.rotation.y += this.rotorSpeed * 0.5;
            this.tailRotorMesh.rotation.z += this.rotorSpeed * 0.8;
        }
        
        if (!this.isPlayerFlying && this.rotorSpeed > 0) {
            this.rotorSpeed = Math.max(0, this.rotorSpeed - 0.02);
            this.targetRotorSpeed = 0;
        }
    }
    
    private alignWithCamera(): void {
        if (!this.engine.camera || !this.aircraftBody) return;
        
        const cameraDirection = new THREE.Vector3();
        this.engine.camera.getWorldDirection(cameraDirection);
        cameraDirection.negate();
        cameraDirection.y = 0;
        
        if (cameraDirection.lengthSq() < 0.001) return;
        cameraDirection.normalize();
        
        const targetAngle = Math.atan2(cameraDirection.x, cameraDirection.z);
        
        let angleDiff = targetAngle - this.trackedRotation;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        
        const rotationSpeed = 0.03;
        this.trackedRotation += angleDiff * rotationSpeed;
        
        const appliedRotation = this.trackedRotation + Math.PI;
        
        this.bodyMesh.rotation.set(0, appliedRotation, 0);
        
        // Create quaternion for rotation
        const quat = new THREE.Quaternion();
        quat.setFromEuler(new THREE.Euler(0, appliedRotation, 0, 'YXZ'));
        
        // Set rotation on physics body
        this.aircraftBody.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
        
        // Stop angular velocity
        this.aircraftBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    public canPlayerEnter(): boolean {
        return !this.isPlayerFlying && this.isGrounded && this.rotorSpeed < 0.5;
    }
    
    public canPlayerLand(): boolean {
        return this.isPlayerFlying && (this.isGrounded || this.getPosition().y < 3);
    }
    
    public enterAircraft(player: any): boolean {
        if (!this.canPlayerEnter()) return false;
        
        const success = super.enterAircraft(player);
        if (success && this.aircraftBody) {
            this.targetRotorSpeed = 2;
            
            const rotation = this.aircraftBody.rotation();
            const quat = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
            const euler = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
            this.trackedRotation = euler.y;
            
            this.targetAltitude = this.getPosition().y;
            this.currentAltitude = this.targetAltitude;
        }
        
        return success;
    }
    
    public exitAircraft(): any {
        if (!this.canPlayerLand()) {
            return null;
        }
        
        const pilot = super.exitAircraft();
        if (pilot) {
            this.rotorSpeed = 0;
            this.targetRotorSpeed = 0;
            this.verticalInput = 0;
            this.horizontalThrust.set(0, 0, 0);
        }
        
        return pilot;
    }
    
    public getRotorSpeed(): number {
        return this.rotorSpeed;
    }
    
    public isHovering(): boolean {
        if (!this.aircraftBody) return false;
        const velocity = this.aircraftBody.linvel();
        const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
        return this.isPlayerFlying && speed < 2 && !this.isGrounded;
    }
}
