import RAPIER2D from '@dimforge/rapier2d-compat';
import { getRapier2D } from 'engine/physics/RapierPhysics2D.js';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';

export interface RigidBodyConfig2D {
    type: 'dynamic' | 'static' | 'kinematic';
    position: { x: number; y: number };
    rotation?: number;
    linearDamping?: number;
    angularDamping?: number;
    gravityScale?: number;
    canSleep?: boolean;
    ccdEnabled?: boolean;
    lockRotation?: boolean;
}

export interface ColliderConfig2D {
    shape: ColliderShape2D;
    mass?: number;
    friction?: number;
    restitution?: number;
    collisionGroup?: number;
    collisionMask?: number;
    isSensor?: boolean;
    offset?: { x: number; y: number };
}

export type ColliderShape2D =
    | { type: 'cuboid'; halfWidth: number; halfHeight: number }
    | { type: 'ball'; radius: number }
    | { type: 'capsule'; halfHeight: number; radius: number }
    | { type: 'segment'; a: { x: number; y: number }; b: { x: number; y: number } }
    | { type: 'convexHull'; vertices: Float32Array }
    | { type: 'polyline'; vertices: Float32Array; indices?: Uint32Array };

export class PhysicsBodyFactory2D {
    static createRigidBodyDesc(config: RigidBodyConfig2D): RAPIER2D.RigidBodyDesc {
        const R = getRapier2D();

        let desc: RAPIER2D.RigidBodyDesc;

        switch (config.type) {
            case 'dynamic':
                desc = R.RigidBodyDesc.dynamic();
                break;
            case 'static':
                desc = R.RigidBodyDesc.fixed();
                break;
            case 'kinematic':
                desc = R.RigidBodyDesc.kinematicPositionBased();
                break;
            default:
                throw new Error(`Unknown body type: ${config.type}`);
        }

        desc.setTranslation(config.position.x, config.position.y);

        if (config.rotation !== undefined) {
            desc.setRotation(config.rotation);
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

        if (config.lockRotation) {
            desc.lockRotations();
        }

        return desc;
    }

    static createColliderDesc(config: ColliderConfig2D): RAPIER2D.ColliderDesc {
        const R = getRapier2D();

        let desc: RAPIER2D.ColliderDesc;

        switch (config.shape.type) {
            case 'cuboid':
                desc = R.ColliderDesc.cuboid(config.shape.halfWidth, config.shape.halfHeight);
                break;

            case 'ball':
                desc = R.ColliderDesc.ball(config.shape.radius);
                break;

            case 'capsule':
                desc = R.ColliderDesc.capsule(config.shape.halfHeight, config.shape.radius);
                break;

            case 'segment':
                desc = R.ColliderDesc.segment(config.shape.a, config.shape.b);
                break;

            case 'convexHull': {
                const hullDesc = R.ColliderDesc.convexHull(config.shape.vertices);
                if (!hullDesc) {
                    throw new Error('Failed to create 2D convex hull collider');
                }
                desc = hullDesc;
                break;
            }

            case 'polyline':
                desc = R.ColliderDesc.polyline(config.shape.vertices, config.shape.indices ?? null);
                break;

            default:
                throw new Error('Unknown 2D shape type');
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

        if (config.collisionGroup !== undefined && config.collisionMask !== undefined) {
            desc.setCollisionGroups(this.createCollisionGroups(config.collisionGroup, config.collisionMask));
        }

        if (config.isSensor) {
            desc.setSensor(true);
        }

        if (config.offset) {
            desc.setTranslation(config.offset.x, config.offset.y);
        }

        return desc;
    }

    static createCollisionGroups(memberOf: number, collidesWith: number): number {
        return (collidesWith << 16) | memberOf;
    }

    static createDynamicBody(
        world: PhysicsWorld2D,
        position: { x: number; y: number },
        colliderConfig: ColliderConfig2D,
        options?: Partial<RigidBodyConfig2D>,
    ): { rigidBody: RAPIER2D.RigidBody; collider: RAPIER2D.Collider } {
        const bodyDesc = this.createRigidBodyDesc({
            type: 'dynamic',
            position,
            ...options,
        });

        const rigidBody = world.createRigidBody(bodyDesc);
        const colliderDesc = this.createColliderDesc(colliderConfig);
        const collider = world.createCollider(colliderDesc, rigidBody);

        return { rigidBody, collider };
    }

    static createStaticBody(
        world: PhysicsWorld2D,
        position: { x: number; y: number },
        colliderConfig: ColliderConfig2D,
        rotation?: number,
    ): { rigidBody: RAPIER2D.RigidBody; collider: RAPIER2D.Collider } {
        const bodyDesc = this.createRigidBodyDesc({
            type: 'static',
            position,
            rotation,
        });

        const rigidBody = world.createRigidBody(bodyDesc);
        const colliderDesc = this.createColliderDesc(colliderConfig);
        const collider = world.createCollider(colliderDesc, rigidBody);

        return { rigidBody, collider };
    }

    static createKinematicBody(
        world: PhysicsWorld2D,
        position: { x: number; y: number },
        colliderConfig: ColliderConfig2D,
        options?: Partial<RigidBodyConfig2D>,
    ): { rigidBody: RAPIER2D.RigidBody; collider: RAPIER2D.Collider } {
        const bodyDesc = this.createRigidBodyDesc({
            type: 'kinematic',
            position,
            ...options,
        });

        const rigidBody = world.createRigidBody(bodyDesc);
        const colliderDesc = this.createColliderDesc(colliderConfig);
        const collider = world.createCollider(colliderDesc, rigidBody);

        return { rigidBody, collider };
    }
}
