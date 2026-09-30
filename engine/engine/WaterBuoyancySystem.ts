/**
 * WaterBuoyancySystem - Applies buoyancy using Rapier sensor intersection events.
 * 
 * Uses collision events to track what's currently in water.
 * Water sensors emit intersection events; we track active intersections and apply forces.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';

interface WaterSensor {
    collider: RAPIER.Collider;
    fluidDensity: number;
    surfaceY: number;
    viscosity: number;
}

interface TrackedBody {
    bodyHandle: number;
    sensorHandle: number;
    intersectionCount: number; // Track multiple collider intersections
}

class WaterBuoyancySystemImpl {
    private physicsWorld: PhysicsWorld | null = null;
    private waterSensors: Map<number, WaterSensor> = new Map();
    
    // Bodies currently in water - uses intersection count for multi-collider bodies
    private bodiesInWater: Map<number, TrackedBody> = new Map();
    
    private gravity = 9.81;
    private tempForce = new THREE.Vector3();
    initialized = false;
    
    initialize(physicsWorld: PhysicsWorld): void {
        if (this.initialized) return;
        this.physicsWorld = physicsWorld;
        physicsWorld.registerPreStepCallback((dt: number) => this.applyBuoyancy(dt));
        this.initialized = true;
    }
    
    registerWaterSensor(collider: RAPIER.Collider, fluidDensity: number, surfaceY: number, viscosity: number = 0.3): void {
        this.waterSensors.set(collider.handle, { collider, fluidDensity, surfaceY, viscosity });
    }
    
    unregisterWaterSensor(collider: RAPIER.Collider): void {
        this.waterSensors.delete(collider.handle);
        for (const [bodyHandle, info] of this.bodiesInWater) {
            if (info.sensorHandle === collider.handle) {
                this.bodiesInWater.delete(bodyHandle);
            }
        }
    }
    
    onIntersectionStart(colliderHandle1: number, colliderHandle2: number): void {
        const sensor1 = this.waterSensors.get(colliderHandle1);
        const sensor2 = this.waterSensors.get(colliderHandle2);
        
        const addBody = (sensorHandle: number, otherHandle: number) => {
            const otherCollider = this.physicsWorld?.getRapierWorld()?.getCollider(otherHandle);
            if (!otherCollider) return;

            // Skip characters that drive their own physics. The player has a
            // dedicated swimming system, and NPCs (ENEMY group) overwrite
            // velocity every frame via WalkingAndJumpingMovement.setLinvel —
            // so buoyancy impulses either get erased or, when the NPC briefly
            // pops above the surface, drive an exit/re-enter oscillation that
            // launches them out of the water and jitters them on shore tiles.
            const membership = otherCollider.collisionGroups() & 0xFFFF;
            if (membership === CollisionGroup.PLAYER || membership === CollisionGroup.ENEMY) return;

            const body = otherCollider.parent();
            if (!body || !body.isDynamic()) return;
            
            // Note: Rapier handles may appear as tiny floats but are valid for Map keys
            const bodyHandle = body.handle;
            
            const existing = this.bodiesInWater.get(bodyHandle);
            if (existing) {
                existing.intersectionCount++;
            } else {
                this.bodiesInWater.set(bodyHandle, { bodyHandle, sensorHandle, intersectionCount: 1 });
            }
        };
        
        if (sensor1) addBody(colliderHandle1, colliderHandle2);
        else if (sensor2) addBody(colliderHandle2, colliderHandle1);
    }
    
    onIntersectionEnd(colliderHandle1: number, colliderHandle2: number): void {
        const sensor1 = this.waterSensors.get(colliderHandle1);
        const sensor2 = this.waterSensors.get(colliderHandle2);
        
        const removeBody = (otherHandle: number) => {
            const otherCollider = this.physicsWorld?.getRapierWorld()?.getCollider(otherHandle);
            if (!otherCollider) return;
            const body = otherCollider.parent();
            if (!body) return;
            
            const bodyHandle = body.handle;
            
            const existing = this.bodiesInWater.get(bodyHandle);
            if (existing) {
                existing.intersectionCount--;
                if (existing.intersectionCount <= 0) {
                    body.resetForces(true);
                    this.bodiesInWater.delete(bodyHandle);
                }
            }
        };
        
        if (sensor1) removeBody(colliderHandle2);
        else if (sensor2) removeBody(colliderHandle1);
    }
    
    private applyBuoyancy(dt: number): void {
        if (!this.physicsWorld) return;
        const world = this.physicsWorld.getRapierWorld();
        if (!world) return;
        
        
        for (const [bodyHandle, info] of this.bodiesInWater) {
            const body = world.getRigidBody(bodyHandle);
            if (!body || !body.isDynamic() || !body.isValid()) { this.bodiesInWater.delete(bodyHandle); continue; }
            
            const sensor = this.waterSensors.get(info.sensorHandle);
            if (!sensor || !sensor.collider.isValid()) { body.resetForces(true); this.bodiesInWater.delete(bodyHandle); continue; }
            
            const pos = body.translation();
            
            // CRITICAL: Position-based removal - if body center is above water surface, remove immediately
            // Reset forces to prevent floating forever in air
            if (pos.y > sensor.surfaceY + 0.5) {
                body.resetForces(true);
                this.bodiesInWater.delete(bodyHandle);
                continue;
            }
            
            
            // Get body dimensions - use mass for rotation-independent calculation
            const mass = body.mass();
            if (mass <= 0) continue;
            
            // Estimate volume and height from first non-sensor collider
            const numColliders = body.numColliders();
            let volume = 1.0, bodyHeight = 1.0;
            for (let i = 0; i < numColliders; i++) {
                const col = body.collider(i);
                if (col && !col.isSensor()) {
                    const shape = col.shape;
                    const shapeType = shape.type;
                    if (shapeType === 1) { // Cuboid
                        const he = (shape as any).halfExtents;
                        if (he) {
                            volume = he.x * 2 * he.y * 2 * he.z * 2;
                            bodyHeight = he.y * 2;
                        }
                    } else if (shapeType === 0) { // Ball
                        const r = (shape as any).radius ?? 0.5;
                        volume = (4/3) * Math.PI * r * r * r;
                        bodyHeight = r * 2;
                    }
                    break;
                }
            }
            
            // Calculate submersion ratio (simplified - assumes upright)
            const bodyBottom = pos.y - bodyHeight / 2;
            const bodyTop = pos.y + bodyHeight / 2;
            
            let submersionRatio: number;
            if (bodyTop <= sensor.surfaceY) submersionRatio = 1.0;
            else if (bodyBottom >= sensor.surfaceY) submersionRatio = 0.0;
            else submersionRatio = Math.max(0, Math.min(1, (sensor.surfaceY - bodyBottom) / bodyHeight));
            
            // If not submerged, remove from tracking and reset forces
            if (submersionRatio <= 0) {
                body.resetForces(true);
                this.bodiesInWater.delete(bodyHandle);
                continue;
            }
            
            // Buoyancy force: F = ρ_fluid × V_displaced × g
            const displacedVolume = volume * submersionRatio;
            const buoyancyForce = sensor.fluidDensity * displacedVolume * this.gravity;
            const weight = mass * this.gravity;
            const objectDensity = mass / volume;
            
            // Net force: buoyancy (already scaled by submersion) minus full weight
            // Positive = floats up, negative = sinks
            const netBuoyancyForce = buoyancyForce - weight;
            
            // Get velocity for damping
            const vel = body.linvel();
            const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
            
            // Check if object should float but is stuck at bottom
            const shouldFloat = objectDensity < sensor.fluidDensity;
            const stuckAtBottom = shouldFloat && speed < 0.5 && submersionRatio > 0.9;
            
            // If stuck at bottom, apply strong upward impulse to break free from ground contact
            if (stuckAtBottom) {
                const liftImpulse = mass * 3.0;
                body.applyImpulse({ x: 0, y: liftImpulse, z: 0 }, true);
            }
            
            // Linear damping based on fluid viscosity (0.3 = water, 0.7 = slime, 0.9 = quicksand)
            // Scale viscosity to damping coefficient range (viscosity 0.3 -> damping ~2.0)
            const dampingCoeff = sensor.viscosity * 6.67; // 0.3 * 6.67 ≈ 2.0
            const dampingForceX = -vel.x * dampingCoeff * mass * submersionRatio;
            // Skip Y damping for stuck floaters - let them rise freely
            const dampingForceY = stuckAtBottom ? 0 : -vel.y * dampingCoeff * mass * submersionRatio;
            const dampingForceZ = -vel.z * dampingCoeff * mass * submersionRatio;
            
            // CRITICAL: Reset forces before adding new ones - addForce accumulates!
            body.resetForces(true);
            
            // Apply net buoyancy force
            this.tempForce.set(0, netBuoyancyForce, 0);
            body.addForce(this.tempForce, true);
            
            // Apply damping force
            this.tempForce.set(dampingForceX, dampingForceY, dampingForceZ);
            body.addForce(this.tempForce, true);
        }
    }
    
    isBodyInWater(bodyHandle: number): boolean {
        return this.bodiesInWater.has(bodyHandle);
    }
    
    isPositionUnderwater(x: number, y: number, z: number): boolean {
        for (const sensor of this.waterSensors.values()) {
            if (y < sensor.surfaceY) {
                return true;
            }
        }
        return false;
    }
    
    dispose(): void {
        this.waterSensors.clear();
        this.bodiesInWater.clear();
        this.initialized = false;
    }
}

let instance: WaterBuoyancySystemImpl | null = null;

export function getWaterBuoyancySystem(): WaterBuoyancySystemImpl {
    if (!instance) instance = new WaterBuoyancySystemImpl();
    return instance;
}
