import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { sphereColliderDesc } from 'engine/physics/BallPhysics.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';

export interface RigidBodyConfig {
    type: 'dynamic' | 'static' | 'kinematic';
    position: THREE.Vector3;
    rotation?: THREE.Quaternion;
    linearDamping?: number;
    angularDamping?: number;
    gravityScale?: number;
    canSleep?: boolean;
    ccdEnabled?: boolean;
}

export interface ColliderConfig {
    shape: ColliderShape;
    mass?: number;
    friction?: number;
    restitution?: number;
    collisionGroup?: number;
    collisionMask?: number;
    isSensor?: boolean;
    offset?: THREE.Vector3;
    offsetRotation?: THREE.Quaternion;
}

export type ColliderShape = 
    | { type: 'box'; halfExtents: THREE.Vector3 }
    | { type: 'sphere'; radius: number }
    | { type: 'capsule'; halfHeight: number; radius: number }
    | { type: 'cylinder'; halfHeight: number; radius: number }
    | { type: 'convexHull'; vertices: Float32Array }
    | { type: 'trimesh'; vertices: Float32Array; indices: Uint32Array }
    /**
     * Rapier heightfield: `nrows` cells along Z, `ncols` along X, heights column-major
     * (index col·(nrows+1) + row), `scale` = the grid's full X/Z size (y = 1: heights are
     * absolute). Centred on the body, so place the body at the grid's centre.
     */
    | { type: 'heightfield'; nrows: number; ncols: number; heights: Float32Array; scale: THREE.Vector3 };

export class PhysicsBodyFactory {
    static createRigidBodyDesc(config: RigidBodyConfig): RAPIER.RigidBodyDesc {
        const RAPIER = getRapier();
        
        let desc: RAPIER.RigidBodyDesc;
        
        switch (config.type) {
            case 'dynamic':
                desc = RAPIER.RigidBodyDesc.dynamic();
                break;
            case 'static':
                desc = RAPIER.RigidBodyDesc.fixed();
                break;
            case 'kinematic':
                desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
                break;
            default:
                throw new Error(`Unknown body type: ${config.type}`);
        }
        
        desc.setTranslation(config.position.x, config.position.y, config.position.z);
        
        if (config.rotation) {
            desc.setRotation({
                x: config.rotation.x,
                y: config.rotation.y,
                z: config.rotation.z,
                w: config.rotation.w
            });
        }
        
        if (config.linearDamping !== undefined) {
            desc.setLinearDamping(config.linearDamping);
        }
        
        if (config.angularDamping !== undefined) {
            desc.setAngularDamping(config.angularDamping);
        }
        
        if (config.gravityScale !== undefined) {
            desc.setGravityScale(config.gravityScale);
        }
        
        if (config.canSleep === false) {
            desc.setCanSleep(false);
        }
        
        if (config.ccdEnabled) {
            desc.setCcdEnabled(true);
        }
        
        return desc;
    }
    
    static createColliderDesc(config: ColliderConfig): RAPIER.ColliderDesc {
        const RAPIER = getRapier();
        
        let desc: RAPIER.ColliderDesc;
        
        switch (config.shape.type) {
            case 'box':
                desc = RAPIER.ColliderDesc.cuboid(
                    config.shape.halfExtents.x,
                    config.shape.halfExtents.y,
                    config.shape.halfExtents.z
                );
                break;
                
            case 'sphere':
                // Never a Ball shape on a dynamic body — see sphereColliderDesc.
                desc = sphereColliderDesc(config.shape.radius);
                break;
                
            case 'capsule':
                desc = RAPIER.ColliderDesc.capsule(
                    config.shape.halfHeight,
                    config.shape.radius
                );
                break;
                
            case 'cylinder':
                desc = RAPIER.ColliderDesc.cylinder(
                    config.shape.halfHeight,
                    config.shape.radius
                );
                break;
                
            case 'convexHull': {
                const hullDesc = RAPIER.ColliderDesc.convexHull(config.shape.vertices);
                if (!hullDesc) {
                    throw new Error('Failed to create convex hull collider');
                }
                desc = hullDesc;
                break;
            }

            case 'trimesh':
                // FIX_INTERNAL_EDGES (144) fixes zero/bad normals at triangle edges
                desc = RAPIER.ColliderDesc.trimesh(
                    config.shape.vertices,
                    config.shape.indices,
                    144
                );
                break;

            case 'heightfield':
                desc = RAPIER.ColliderDesc.heightfield(
                    config.shape.nrows,
                    config.shape.ncols,
                    config.shape.heights,
                    config.shape.scale,
                );
                break;
                
            default:
                throw new Error('Unknown shape type');
        }
        
        if (config.mass !== undefined) {
            desc.setMass(config.mass);
        }
        
        if (config.friction !== undefined) {
            desc.setFriction(config.friction);
        }
        
        if (config.restitution !== undefined) {
            desc.setRestitution(config.restitution);
        }
        
        const group = config.collisionGroup ?? CollisionGroup.ENVIRONMENT;
        const mask = config.collisionMask ?? CollisionMask.ALL;
        desc.setCollisionGroups(this.createCollisionGroups(group, mask));
        
        if (config.isSensor) {
            desc.setSensor(true);
        }
        
        if (config.offset) {
            desc.setTranslation(config.offset.x, config.offset.y, config.offset.z);
        }
        
        if (config.offsetRotation) {
            desc.setRotation({
                x: config.offsetRotation.x,
                y: config.offsetRotation.y,
                z: config.offsetRotation.z,
                w: config.offsetRotation.w
            });
        }
        
        return desc;
    }
    
    static createCollisionGroups(memberOf: number, collidesWith: number): number {
        // Rapier format: lower 16 bits = membership, upper 16 bits = filter (what it collides with)
        return (collidesWith << 16) | memberOf;
    }
    
    /** Body + its single collider, the shape every create*Body helper below has. */
    private static createBody(
        world: PhysicsWorld,
        bodyConfig: RigidBodyConfig,
        colliderConfig: ColliderConfig
    ): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider } {
        const rigidBody = world.createRigidBody(this.createRigidBodyDesc(bodyConfig));
        const collider = world.createCollider(this.createColliderDesc(colliderConfig), rigidBody);

        return { rigidBody, collider };
    }

    static createDynamicBody(
        world: PhysicsWorld,
        position: THREE.Vector3,
        colliderConfig: ColliderConfig,
        options?: Partial<RigidBodyConfig>
    ): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider } {
        return this.createBody(world, { type: 'dynamic', position, ...options }, colliderConfig);
    }

    static createStaticBody(
        world: PhysicsWorld,
        position: THREE.Vector3,
        colliderConfig: ColliderConfig,
        rotation?: THREE.Quaternion
    ): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider } {
        return this.createBody(world, { type: 'static', position, rotation }, colliderConfig);
    }

    static createKinematicBody(
        world: PhysicsWorld,
        position: THREE.Vector3,
        colliderConfig: ColliderConfig,
        options?: Partial<RigidBodyConfig>
    ): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider } {
        return this.createBody(world, { type: 'kinematic', position, ...options }, colliderConfig);
    }

    static createCapsuleCharacter(
        world: PhysicsWorld,
        position: THREE.Vector3,
        height: number,
        radius: number,
        mass: number = 80,
        collisionGroup: number = CollisionGroup.PLAYER,
        collisionMask: number = CollisionMask.PLAYER
    ): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider } {
        const halfHeight = (height - radius * 2) / 2;
        
        return this.createDynamicBody(
            world,
            position,
            {
                shape: { type: 'capsule', halfHeight: Math.max(0, halfHeight), radius },
                mass,
                friction: 0.5,
                restitution: 0,
                collisionGroup,
                collisionMask
            },
            {
                linearDamping: 0.5,
                angularDamping: 1.0,
                canSleep: false,
                ccdEnabled: true
            }
        );
    }
    
    static createProjectile(
        world: PhysicsWorld,
        position: THREE.Vector3,
        velocity: THREE.Vector3,
        radius: number = 0.05,
        mass: number = 0.1,
        collisionGroup: number = CollisionGroup.PROJECTILE,
        collisionMask: number = CollisionMask.PROJECTILE
    ): { rigidBody: RAPIER.RigidBody; collider: RAPIER.Collider } {
        const { rigidBody, collider } = this.createDynamicBody(
            world,
            position,
            {
                shape: { type: 'sphere', radius },
                mass,
                friction: 0,
                restitution: 0,
                collisionGroup,
                collisionMask
            },
            {
                gravityScale: 0,
                linearDamping: 0,
                angularDamping: 0,
                canSleep: false,
                ccdEnabled: true
            }
        );
        
        rigidBody.setLinvel({ x: velocity.x, y: velocity.y, z: velocity.z }, true);
        
        return { rigidBody, collider };
    }
}

