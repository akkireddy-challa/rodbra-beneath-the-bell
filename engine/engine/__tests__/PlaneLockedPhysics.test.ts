/**
 * PlaneLockedPhysics — the Rapier 2D world behind the 3D character pipeline.
 *
 * Two kinds of guarantee live here:
 *  1. Behaviour against a REAL rapier2d world: Z projection, ray parametrisation,
 *     wrapper identity, spawn clearance, lifecycle.
 *  2. Coverage: every `playerBody.<x>(` / `physicsWorld.<x>(` call in the files
 *     that run on the character path has a counterpart on the wrappers, or the
 *     file gates it with `isPlaneLockedPhysics()`. A missing member would
 *     otherwise surface only in a browser, as a named throw from `lockSurface`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import RAPIER2D from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { initRapier2D } from 'engine/physics/RapierPhysics2D.js';
import { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import {
    PlaneLockedBody,
    PlaneLockedCollider,
    PlaneLockedCharacterController,
    PlaneLockedPhysics,
    createPlaneLockedPhysics,
    isPlaneLockedBody,
    isPlaneLockedPhysics,
    queryPhysicsFor,
    asPlayerPhysics,
} from 'engine/physics/PlaneLockedPhysics.js';
import type { ContactInfo, PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

jest.setTimeout(30_000);

beforeAll(async () => {
    await initRapier2D();
});

const PLANE_Z = 0;

function makeLane(planeZ: number = PLANE_Z): { world2D: PhysicsWorld2D; facade: PlaneLockedPhysics } {
    const world2D = new PhysicsWorld2D({ x: 0, y: -30 });
    return { world2D, facade: createPlaneLockedPhysics(world2D, planeZ) };
}

/** A TERRAIN slab whose top surface is at `topY`. */
function addGround(world2D: PhysicsWorld2D, topY: number = 0, halfWidth: number = 50): RAPIER2D.RigidBody {
    const body = world2D.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, topY - 0.5));
    const groups = makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN);
    world2D.createCollider(RAPIER2D.ColliderDesc.cuboid(halfWidth, 0.5).setCollisionGroups(groups), body);
    return body;
}

function capsuleAt(facade: PlaneLockedPhysics, x: number, y: number): PlaneLockedBody {
    return facade.createCharacterCapsule({
        x, y, radius: 0.3, halfHeight: 0.5,
        collisionGroup: CollisionGroup.PLAYER, collisionMask: CollisionMask.PLAYER, friction: 0.4,
    });
}

const GROUND = CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT;

describe('character capsule', () => {
    it('is a kinematic position-based body whose 3D translation carries the plane Z', () => {
        const { world2D, facade } = makeLane(2.5);
        const body = capsuleAt(facade, 1, 3);
        expect(isPlaneLockedBody(body)).toBe(true);
        expect(body.isKinematic()).toBe(true);
        expect(body.translation()).toEqual({ x: 1, y: 3, z: 2.5 });
        expect(body.numColliders()).toBe(1);
        const collider = body.collider(0);
        expect(collider).toBeInstanceOf(PlaneLockedCollider);
        expect(collider.radius()).toBeCloseTo(0.3);
        expect(collider.halfHeight()).toBeCloseTo(0.5);
        expect(typeof body.handle).toBe('number');

        // The mover's contract: setNextKinematicTranslation lands EXACTLY there
        // after the step; whatever Z the 3D caller passes is projected away.
        body.setNextKinematicTranslation({ x: 4, y: 3.25, z: 99 });
        world2D.step(1 / 60);
        const t = body.translation();
        expect(t.x).toBeCloseTo(4);
        expect(t.y).toBeCloseTo(3.25);
        expect(t.z).toBe(2.5);
        expect(body.linvel().z).toBe(0);
        expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('rotation is a Z-axis quaternion built from the 2D angle', () => {
        const { facade } = makeLane();
        const body = capsuleAt(facade, 0, 1);
        body.lockRotations(false, true);
        body.setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) }, true);
        const q = body.rotation();
        expect(q.x).toBe(0);
        expect(q.y).toBe(0);
        expect(2 * Math.atan2(q.z, q.w)).toBeCloseTo(Math.PI / 2);
    });
});

describe('raycast', () => {
    it('projects a vertical 3D ray onto the plane and reports the plane Z on the hit', () => {
        const { world2D, facade } = makeLane(1.5);
        addGround(world2D, 0);
        world2D.step(1 / 60);
        const hit = facade.raycast(new THREE.Vector3(3, 5, 1.5), new THREE.Vector3(0, -1, 0), 100, GROUND);
        expect(hit.hasHit).toBe(true);
        expect(hit.hitDistance).toBeCloseTo(5);
        expect(hit.hitPoint.x).toBeCloseTo(3);
        expect(hit.hitPoint.y).toBeCloseTo(0);
        expect(hit.hitPoint.z).toBe(1.5);
        expect(hit.hitNormal.z).toBe(0);
        expect(hit.hitNormal.y).toBeCloseTo(1);
    });

    it('keeps the 3D ray parametrisation for a direction that carries Z', () => {
        // The spawn-enclosure probe sweeps horizontal rays with Z components;
        // origin + direction * hitDistance must still land on the hit.
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        world2D.step(1 / 60);
        const dir = new THREE.Vector3(0, -0.6, 0.8); // unit; planar length 0.6
        const origin = new THREE.Vector3(0, 3, 0);
        const hit = facade.raycast(origin, dir, 100, GROUND);
        expect(hit.hasHit).toBe(true);
        expect(hit.hitDistance).toBeCloseTo(3 / 0.6);
        const landed = origin.clone().addScaledVector(dir, hit.hitDistance);
        expect(landed.y).toBeCloseTo(0);
        // maxDistance is a 3D parameter too: a ray too short in 3D misses even
        // though its planar projection would reach.
        expect(facade.raycast(origin, dir, 4, GROUND).hasHit).toBe(false);
        expect(facade.raycast(origin, dir, 5.1, GROUND).hasHit).toBe(true);
    });

    it('a ray along Z can hit nothing on the plane', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        world2D.step(1 / 60);
        const hit = facade.raycast(new THREE.Vector3(0, -0.2, -5), new THREE.Vector3(0, 0, 1), 100, GROUND);
        expect(hit.hasHit).toBe(false);
        expect(hit.hitDistance).toBe(Infinity);
    });

    it('reuses a caller-supplied result object and resets it on a miss', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        world2D.step(1 / 60);
        const out = {
            hasHit: true, hitPoint: new THREE.Vector3(9, 9, 9), hitNormal: new THREE.Vector3(),
            hitDistance: 1, hitCollider: null, hitRigidBody: null,
        } as ReturnType<PlaneLockedPhysics['raycast']>;
        const same = facade.raycast(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 1, 0), 10, GROUND, out);
        expect(same).toBe(out);
        expect(out.hasHit).toBe(false);
        expect(out.hitRigidBody).toBeNull();
    });

    it('returns the SAME wrapper for a body across queries, and the player capsule itself', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const player = capsuleAt(facade, 0, 5);
        world2D.step(1 / 60);
        const a = facade.raycast(new THREE.Vector3(10, 5, 0), new THREE.Vector3(0, -1, 0), 100, GROUND);
        const b = facade.raycast(new THREE.Vector3(-10, 5, 0), new THREE.Vector3(0, -1, 0), 100, GROUND);
        expect(a.hitRigidBody).toBe(b.hitRigidBody);
        expect(isPlaneLockedBody(a.hitRigidBody)).toBe(true);
        expect(a.hitRigidBody!.translation().z).toBe(PLANE_Z);
        // The mover excludes its own capsule by handle; identity holds too.
        const self = facade.raycast(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0), 100, CollisionGroup.PLAYER);
        expect(self.hasHit).toBe(true);
        expect(self.hitRigidBody).toBe(player);
        expect(self.hitRigidBody!.handle).toBe(player.handle);
    });
});

describe('spawn clearance', () => {
    it('capsuleOverlaps sees solid terrain and ignores sensors', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const sensorBody = world2D.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(20, 5));
        world2D.createCollider(RAPIER2D.ColliderDesc.ball(3).setSensor(true), sensorBody);
        world2D.step(1 / 60);
        expect(facade.capsuleOverlaps({ x: 0, y: 0.2, z: 0 }, 0.3, 0.5, CollisionMask.PLAYER)).toBe(true);
        expect(facade.capsuleOverlaps({ x: 0, y: 2, z: 0 }, 0.3, 0.5, CollisionMask.PLAYER)).toBe(false);
        expect(facade.capsuleOverlaps({ x: 20, y: 5, z: 0 }, 0.3, 0.5, CollisionMask.PLAYER)).toBe(false);
    });
});

describe('environment bodies and triggers', () => {
    const ENV_GROUPS = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);
    /** A 2×2×2 block whose local origin is its base centre. */
    const BLOCK = [{ cx: 0, cy: 1, cz: 0, hx: 1, hy: 1, hz: 1 }];
    const at = (x: number, y: number, z: number = 0) => ({
        translation: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 },
    });

    it('a placed object collides on the plane exactly where its boxes are', () => {
        const { world2D, facade } = makeLane();
        const built = facade.createEnvironmentBody({
            boxes: BLOCK, transform: at(10, 3), kind: 'fixed', collisionGroups: ENV_GROUPS, friction: 0.7, restitution: 0,
            userData: { tag: 'crate' },
        });
        expect(built.colliders).toHaveLength(1);
        expect(built.body.isFixed()).toBe(true);
        expect(facade.getUserData(built.body)).toEqual({ tag: 'crate' });
        world2D.step(1 / 60);
        const hit = facade.raycast(new THREE.Vector3(10, 20, 0), new THREE.Vector3(0, -1, 0), 100, GROUND);
        expect(hit.hasHit).toBe(true);
        expect(hit.hitPoint.y).toBeCloseTo(5); // base at 3, two metres tall
        expect(hit.hitRigidBody).toBe(built.body);
        expect(hit.hitCollider!.friction()).toBeCloseTo(0.7, 5);
    });

    it('an object placed behind the plane has no collider at all', () => {
        const { facade } = makeLane();
        const built = facade.createEnvironmentBody({
            boxes: BLOCK, transform: at(0, 0, -4), kind: 'fixed', collisionGroups: ENV_GROUPS, friction: 0.7, restitution: 0,
        });
        expect(built.colliders).toHaveLength(0);
    });

    it('a dynamic prop carries its authored mass and falls onto the ground', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const built = facade.createEnvironmentBody({
            boxes: BLOCK, transform: at(0, 5), kind: { dynamic: { mass: 40 } },
            collisionGroups: makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP), friction: 0.5, restitution: 0,
        });
        expect(built.body.isDynamic()).toBe(true);
        expect(built.body.mass()).toBeCloseTo(40, 3);
        for (let i = 0; i < 240; i++) world2D.step(1 / 60);
        // Base centre rests on the ground top (y = 0), within Rapier's contact slop.
        expect(built.body.translation().y).toBeCloseTo(0, 1);
        expect(built.body.translation().z).toBe(PLANE_Z);
    });

    it('attachSensorBall rides an existing body — the NPC interaction radius that needs no sync', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const events: Array<[number, number]> = [];
        world2D.addSensorListener({ onIntersectionStart: (a, b) => events.push([a, b]), onIntersectionEnd: () => {} });
        const npc = capsuleAt(facade, 0, 0.9);
        const radius = facade.attachSensorBall(npc, {
            radius: 3, collisionGroups: makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER),
        });
        expect(radius).toBeInstanceOf(PlaneLockedCollider);
        expect(radius.isSensor()).toBe(true);
        expect(radius.parent()).toBe(npc);
        expect(npc.numColliders()).toBe(2); // its own capsule plus the trigger

        const player = capsuleAt(facade, 8, 0.9);
        player.setNextKinematicTranslation({ x: 1, y: 0.9, z: 0 });
        for (let i = 0; i < 3; i++) { world2D.step(1 / 60); world2D.flushCollisionCallbacks(); }
        expect(events.some(([a, b]) => a === radius.handle || b === radius.handle)).toBe(true);
    });

    it('a sensor ball reports the kinematic character entering it through the 2D sensor listener', () => {
        const { world2D, facade } = makeLane();
        const sensor = facade.createSensorBall({
            x: 5, y: 1, radius: 1.5, collisionGroups: makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER),
        });
        expect(sensor.collider.isSensor()).toBe(true);
        const started: Array<[number, number]> = [];
        world2D.addSensorListener({
            onIntersectionStart: (a, b) => started.push([a, b]),
            onIntersectionEnd: () => { /* not asserted */ },
        });
        const player = capsuleAt(facade, 0, 1);
        world2D.step(1 / 60);
        expect(started).toHaveLength(0);
        player.setNextKinematicTranslation({ x: 5, y: 1, z: 0 });
        // A kinematic move lands on step N; Rapier reports the new overlap on the
        // step after it, so a game sees the pickup one frame later. Step a few.
        for (let i = 0; i < 3; i++) { world2D.step(1 / 60); world2D.flushCollisionCallbacks(); }
        expect(started).toHaveLength(1);
        expect(started[0]).toContain(sensor.collider.handle);
        expect(started[0]).toContain(player.collider(0).handle);
    });
});

describe('character helpers (the shared movers and the NPC stack)', () => {
    const ENV = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);
    /** A fixed ENVIRONMENT block spanning x ∈ [x0, x1], y ∈ [y0, y1]. */
    function addBlock(world2D: PhysicsWorld2D, x0: number, x1: number, y0: number, y1: number, kinematic: boolean = false): RAPIER2D.RigidBody {
        const desc = (kinematic ? RAPIER2D.RigidBodyDesc.kinematicPositionBased() : RAPIER2D.RigidBodyDesc.fixed())
            .setTranslation((x0 + x1) / 2, (y0 + y1) / 2);
        const body = world2D.createRigidBody(desc);
        world2D.createCollider(RAPIER2D.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2).setCollisionGroups(ENV), body);
        return body;
    }

    it('the character controller wrapper slides a capsule along the ground and reports contacts', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const player = capsuleAt(facade, 0, 0.9); // feet 0.1 above the ground
        world2D.step(1 / 60);
        const controller = facade.getCharacterController();
        expect(controller).toBeInstanceOf(PlaneLockedCharacterController);
        expect(facade.getCharacterController()).toBe(controller);
        const collider = player.collider(0);
        controller.disableAutostep();
        controller.computeColliderMovement(collider, { x: 0.5, y: -1, z: 3 }, undefined, undefined, (other) => other.handle !== collider.handle);
        const mv = controller.computedMovement();
        expect(mv.x).toBeCloseTo(0.5, 2);
        expect(mv.y).toBeGreaterThan(-1); // clamped by the ground
        expect(mv.z).toBe(0);
        expect(controller.computedGrounded()).toBe(true);
        expect(controller.numComputedCollisions()).toBeGreaterThan(0);
        const hit = controller.computedCollision(0)!;
        expect(hit.normal1.z).toBe(0);
        expect(Math.abs(hit.normal1.y)).toBeCloseTo(1, 1);
        expect(hit.collider).toBeInstanceOf(PlaneLockedCollider);
        controller.enableAutostep(0.65, 0.3, false);
    });

    it('groundDistBelowCenter and capsuleOverlapsStatic measure against the static world', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const player = capsuleAt(facade, 0, 2);
        world2D.step(1 / 60);
        const collider = player.collider(0);
        expect(facade.groundDistBelowCenter(collider, 10)).toBeCloseTo(2, 3);
        expect(facade.groundDistBelowCenter(collider, 1)).toBe(Infinity);
        expect(facade.capsuleOverlapsStatic(collider, { x: 0, y: 0.2, z: 0 })).toBe(true);
        expect(facade.capsuleOverlapsStatic(collider, { x: 0, y: 2, z: 0 })).toBe(false);
    });

    it('detectStepUp finds a standable step ahead and ignores a wall', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        // The probes sample up to capsuleRadius + 0.2 ahead of the centre (0.5 m
        // here), so the step must start within that reach, like a real kerb underfoot.
        addBlock(world2D, 0.35, 3, 0, 0.4);  // step, 0.4 high
        addBlock(world2D, -3, -0.35, 0, 3);  // wall behind
        const player = capsuleAt(facade, 0, 0.8); // feet on the ground
        world2D.step(1 / 60);
        const collider = player.collider(0);
        expect(facade.detectStepUp(collider, 1, 0, 0.65)).toBeCloseTo(0.4, 2);
        expect(facade.detectStepUp(collider, -1, 0, 0.65)).toBe(0);
        expect(facade.detectStepUp(collider, 0, 1, 0.65)).toBe(0); // no planar direction
    });

    it('ledgeForMantle reports a grabbable ledge top ahead', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        addBlock(world2D, 0.6, 4, 0, 1.2);
        const player = capsuleAt(facade, 0, 0.8);
        world2D.step(1 / 60);
        const collider = player.collider(0);
        expect(facade.ledgeForMantle(collider, 1, 0, -1.0, 0)).toBeCloseTo(1.2, 3);
        expect(facade.ledgeForMantle(collider, -1, 0, -1.0, 0)).toBeNull();
    });

    it('groundSlopeUnder is flat on flat ground and always downZ = 0', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const player = capsuleAt(facade, 0, 0.8);
        world2D.step(1 / 60);
        expect(facade.groundSlopeUnder(player.collider(0))).toEqual({ tan: 0, downX: 0, downZ: 0 });
    });

    it('kinematicBodyBelowCenter / kinematicBodyOverlapping see a kinematic platform', () => {
        const { world2D, facade } = makeLane();
        const platform = addBlock(world2D, -2, 2, 0, 0.5, true);
        const player = capsuleAt(facade, 0, 1.5); // 1 m above the platform top
        world2D.step(1 / 60);
        const below = facade.kinematicBodyBelowCenter(player.collider(0), 5);
        expect(below).not.toBeNull();
        expect(below!.handle).toBe(platform.handle);
        expect(facade.kinematicBodyBelowCenter(player.collider(0), 0.5)).toBeNull();
        player.setTranslation({ x: 0, y: 0.6, z: 0 }, true);
        world2D.step(1 / 60);
        expect(facade.kinematicBodyOverlapping(player.collider(0), null)!.handle).toBe(platform.handle);
        expect(facade.kinematicBodyOverlapping(player.collider(0), facade.wrapBody(platform))).toBeNull();
    });

    it('queryEntitiesInRadius and getBodyLinvel drive agent avoidance on the plane', () => {
        const { world2D, facade } = makeLane();
        const a = capsuleAt(facade, 0, 1);
        const b = capsuleAt(facade, 1.5, 1);
        const far = capsuleAt(facade, 20, 1);
        facade.setUserData(a, { __type: 'npc', agentRadius: 0.3 });
        facade.setUserData(b, { __type: 'npc', agentRadius: 0.3 });
        facade.setUserData(far, { __type: 'npc', agentRadius: 0.3 });
        b.setLinvel({ x: -2, y: 0, z: 0 }, true);
        world2D.step(1 / 60);
        const found = facade.queryEntitiesInRadius({ x: 0, y: 1, z: 0 }, 3);
        expect(found.map((e) => e.handle).sort()).toEqual([a.handle, b.handle].sort());
        const bEntry = found.find((e) => e.handle === b.handle)!;
        expect(bEntry.position.z).toBe(PLANE_Z);
        expect(bEntry.userData).toEqual({ __type: 'npc', agentRadius: 0.3 });
        expect(facade.getBodyLinvel(b.handle)!.z).toBe(0);
        expect(facade.getBodyLinvel(999999)).toBeNull();
    });

    it('computeGroupAvoidance steps away from an overlapping prop along X', () => {
        const { world2D, facade } = makeLane();
        const prop = world2D.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0.6, 1));
        world2D.createCollider(
            RAPIER2D.ColliderDesc.cuboid(0.4, 0.4).setCollisionGroups(makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP)),
            prop,
        );
        world2D.step(1 / 60);
        const away = facade.computeGroupAvoidance({ x: 0, y: 1, z: 0 }, 0.3, 0.5, 0.2, CollisionGroup.DYNAMIC_PROP | CollisionGroup.VEHICLE);
        expect(away).toEqual({ x: -1, z: 0 });
        expect(facade.computeGroupAvoidance({ x: 5, y: 1, z: 0 }, 0.3, 0.5, 0.2, CollisionGroup.DYNAMIC_PROP)).toBeNull();
        // A stationary obstacle is not a threat when a minimum speed is required.
        expect(facade.computeGroupAvoidance({ x: 0, y: 1, z: 0 }, 0.3, 0.5, 0.2, CollisionGroup.DYNAMIC_PROP, 0.5)).toBeNull();
    });
});

describe('lifecycle and bookkeeping', () => {
    it('removeRigidBody accepts the wrapper and the body is gone after the next step', () => {
        const { world2D, facade } = makeLane();
        const body = capsuleAt(facade, 0, 1);
        const before = facade.getStats().rigidBodyCount;
        facade.removeRigidBody(body);
        world2D.step(1 / 60);
        expect(facade.getStats().rigidBodyCount).toBe(before - 1);
        expect(body.isValid()).toBe(false);
    });

    it('user data round-trips through the wrapper', () => {
        const { facade } = makeLane();
        const body = capsuleAt(facade, 0, 1);
        facade.setUserData(body, { __type: 'player', agentRadius: 0.3 });
        expect(facade.getUserData(body)).toEqual({ __type: 'player', agentRadius: 0.3 });
        expect(facade.getUserDataFromHandle(body.handle)).toEqual({ __type: 'player', agentRadius: 0.3 });
    });

    it('post-step callbacks reach the 2D world (terrain readiness depends on it)', () => {
        const { world2D, facade } = makeLane();
        let fired = 0;
        const cb = (): void => { fired++; };
        facade.registerPostStepCallback(cb);
        world2D.step(1 / 60);
        facade.unregisterPostStepCallback(cb);
        world2D.step(1 / 60);
        expect(fired).toBe(1);
    });

    it('carries the 3D world\'s frame-loop parity members (engine.physicsWorld IS the facade on the 2D lane)', () => {
        const { world2D, facade } = makeLane();
        expect(facade.getFixedTimestep()).toBeCloseTo(1 / 60);
        expect(facade.getInterpolationAlpha()).toBe(1);
        facade.lastStepSubstepCount = 1; // GameEngine writes this each idle frame
        expect(facade.lastStepSubstepCount).toBe(1);
        facade.setSimulationActive(false);
        facade.quarantineBody(capsuleAt(facade, 0, 1));
        // Contact callbacks reach the raw 2D world: a dynamic crate landing on the
        // ground reports a contact for its body.
        addGround(world2D, 0);
        const crate = facade.createEnvironmentBody({
            boxes: [{ cx: 0, cy: 0.5, cz: 0, hx: 0.5, hy: 0.5, hz: 0.5 }],
            transform: { translation: { x: 5, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            kind: { dynamic: { mass: 5 } },
            collisionGroups: makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP), friction: 0.5, restitution: 0,
        });
        let contacts = 0;
        const onContact = (): void => { contacts++; };
        facade.registerCollisionCallback(crate.body, onContact);
        for (let i = 0; i < 120; i++) { world2D.step(1 / 60); world2D.flushCollisionCallbacks(); }
        expect(contacts).toBeGreaterThan(0);
        facade.unregisterCollisionCallback(crate.body, onContact);
        // Collider user data has its own registry.
        facade.setColliderUserData(crate.colliders[0]!, { tag: 'lid' });
        expect(facade.getColliderUserData(crate.colliders[0]!)).toEqual({ tag: 'lid' });
        expect(facade.getColliderUserDataFromHandle(crate.colliders[0]!.handle)).toEqual({ tag: 'lid' });
        // dispose() clears the registries; the 2D world (which owns the WASM) is disposed by GameEngine separately.
        facade.dispose();
        expect(facade.getColliderUserData(crate.colliders[0]!)).toBeUndefined();
        expect(facade.isDisposed()).toBe(false);
    });

    it('counts steps and lists the collider handles a capsule overlaps', () => {
        const { world2D, facade } = makeLane();
        expect(facade.getStepsTaken()).toBe(0);
        addGround(world2D, 0);
        const player = capsuleAt(facade, 0, 0.8);
        const prop = world2D.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0.4, 0.8));
        const propCollider = world2D.createCollider(
            RAPIER2D.ColliderDesc.cuboid(0.3, 0.3).setCollisionGroups(makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP)),
            prop,
        );
        world2D.step(1 / 60);
        expect(facade.getStepsTaken()).toBe(1);
        const out = new Set<number>([999]);
        facade.overlappingColliderHandles(player.translation(), 0.3, 0.5, CollisionGroup.DYNAMIC_PROP | CollisionGroup.ENEMY, out);
        expect([...out]).toEqual([propCollider.handle]); // cleared first, terrain filtered by the mask
        facade.overlappingColliderHandles({ x: 10, y: 0.8, z: 0 }, 0.3, 0.5, CollisionGroup.DYNAMIC_PROP, out);
        expect(out.size).toBe(0);
    });

    it('intersectsBox and raycastWithFilter follow the 3D contracts on the plane', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const player = capsuleAt(facade, 0, 1);
        world2D.step(1 / 60);
        expect(facade.intersectsBox({ x: 0, y: 0.2, z: 0 }, { x: 0.5, y: 0.5, z: 9 }, CollisionGroup.TERRAIN)).toBe(true);
        expect(facade.intersectsBox({ x: 0, y: 3, z: 0 }, { x: 0.5, y: 0.5, z: 9 }, CollisionGroup.TERRAIN)).toBe(false);
        // Excluding the player body: a ray through the capsule reaches the ground behind it.
        const through = facade.raycastWithFilter(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0), 20, 0xFFFF, CollisionGroup.PLAYER | CollisionGroup.TERRAIN);
        expect(through.hitRigidBody).toBe(player);
        const past = facade.raycastWithFilter(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0), 20, 0xFFFF, CollisionGroup.PLAYER | CollisionGroup.TERRAIN, [player]);
        expect(past.hasHit).toBe(true);
        expect(past.hitPoint.y).toBeCloseTo(0);
        expect(past.hitPoint.z).toBe(PLANE_Z);
        expect(past.hitRigidBody).not.toBe(player);
    });

    it('is disposed with its world', () => {
        const { world2D, facade } = makeLane();
        expect(facade.isDisposed()).toBe(false);
        expect(facade.isHalted()).toBe(false);
        world2D.dispose();
        expect(facade.isDisposed()).toBe(true);
    });
});

describe('surface locking', () => {
    it('an unimplemented member throws a NAMED error instead of returning undefined', () => {
        const { facade } = makeLane();
        const body = capsuleAt(facade, 0, 1);
        const loose = body as unknown as Record<string, unknown>;
        expect(() => loose.applyTorqueImpulse).toThrow(/RigidBody\.applyTorqueImpulse is not implemented on the 2D lane/);
        const looseWorld = facade as unknown as Record<string, unknown>;
        expect(() => looseWorld.teleportDynamicBody).toThrow(/PhysicsWorld\.teleportDynamicBody is not implemented/);
        expect(() => facade.getRapierWorld()).toThrow(/3D-only/);
    });

    it('runtime probes (await, jest matchers) see undefined, not a throw', () => {
        const { facade } = makeLane();
        const body = capsuleAt(facade, 0, 1);
        const loose = body as unknown as Record<string, unknown>;
        expect(loose.then).toBeUndefined();
        expect(loose.asymmetricMatch).toBeUndefined();
        expect(loose[Symbol.toStringTag as unknown as string]).toBeUndefined();
    });

    it('type guards and the engine query helper', () => {
        const { facade } = makeLane();
        expect(isPlaneLockedPhysics(facade)).toBe(true);
        expect(isPlaneLockedPhysics({ raycast: () => null })).toBe(false);
        expect(isPlaneLockedPhysics(null)).toBe(false);
        const asWorld = asPlayerPhysics(facade);
        expect(isPlaneLockedPhysics(asWorld)).toBe(true);
        expect(queryPhysicsFor({ physicsWorld: null, getPlaneLockedPhysics: () => facade })).toBe(asWorld);
        const threeD = { raycast: () => null } as unknown as PhysicsWorld;
        expect(queryPhysicsFor({ physicsWorld: threeD, getPlaneLockedPhysics: () => facade })).toBe(threeD);
        expect(queryPhysicsFor({ physicsWorld: null })).toBeNull();
        expect(queryPhysicsFor(null)).toBeNull();
    });
});

/**
 * Coverage: the character path's Rapier calls versus the wrappers.
 *
 * Add a member to the wrappers when this fails, or gate the new call with
 * `isPlaneLockedPhysics()` in the file that makes it — never widen the scan.
 */
describe('every character-path call has a wrapper member', () => {
    const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
    const GAME_SRC = path.resolve(__dirname, '..', '..');
    const FILES = [
        path.join(GAME_SRC, 'engine', 'PlayerController.ts'),
        path.join(GAME_SRC, 'engine', 'loaders', 'PlayerLoader.ts'),
        path.join(GAME_SRC, 'engine', 'loaders', 'CharacterLoader.ts'),
        path.join(GAME_SRC, 'engine', 'PostureActions.ts'),
        path.join(GAME_SRC, 'engine', 'PlayerPosture.ts'),
        path.join(GAME_SRC, 'engine', 'character', 'RagdollComponent.ts'),
        path.join(GAME_SRC, 'genres', 'voxel', 'VoxelPlayerController.ts'),
        // The environment-object path: placed props, collectibles, teardown.
        path.join(GAME_SRC, 'engine', 'EnvironmentObjectSystem.ts'),
        path.join(GAME_SRC, 'engine', 'VoxelObject.ts'),
        path.join(GAME_SRC, 'engine', 'VoxelObjectColliderOps.ts'),
        path.join(GAME_SRC, 'engine', 'CollectibleComponent.ts'),
        path.join(GAME_SRC, 'engine', 'levels', 'envObjectTeardown.ts'),
        path.join(GAME_SRC, 'genres', 'voxel', 'WorldGenerator.ts'),
        // The NPC / animal stack and the shared movers.
        path.join(GAME_SRC, 'engine', 'npc', 'core', 'NpcController.ts'),
        path.join(GAME_SRC, 'engine', 'npc', 'core', 'NpcManager.ts'),
        path.join(GAME_SRC, 'engine', 'WalkingAndJumpingMovement.ts'),
        path.join(GAME_SRC, 'engine', 'AgentAvoidance.ts'),
        path.join(GAME_SRC, 'engine', 'PathConflictAvoidance.ts'),
        path.join(GAME_SRC, 'engine', 'animal', 'AnimalController.ts'),
        path.join(GAME_SRC, 'engine', 'animal', 'AnimalRegistry.ts'),
        path.join(GAME_SRC, 'engine', 'animal', 'AnimalLocomotion3D.ts'),
        path.join(GAME_SRC, 'engine', 'animal', 'SnakeController.ts'),
        path.join(GAME_SRC, 'engine', 'character', 'BlockExplosionComponent.ts'),
        // The trigger family the NPC/player path constructs: an NPC's interaction
        // radius, a drop zone, a weapon pickup — all ball sensors, all ported.
        // A door system is here as the gate that keeps 3D-only mechanisms out.
        path.join(GAME_SRC, 'engine', 'InteractableComponent.ts'),
        path.join(GAME_SRC, 'engine', 'DropZoneComponent.ts'),
        path.join(GAME_SRC, 'engine', 'WeaponPickup.ts'),
        path.join(GAME_SRC, 'engine', 'doors', 'DoorSystem.ts'),
        // The shooting path: a shot's body, the component that spawns it, the
        // weapon system that aims it.
        path.join(GAME_SRC, 'engine', 'Projectile.ts'),
        path.join(GAME_SRC, 'engine', 'ShootableComponent.ts'),
        path.join(GAME_SRC, 'engine', 'RangedWeaponSystem.ts'),
        path.join(REPO_ROOT, 'templates', 'sidescroller', 'source', 'Game.ts'),
        path.join(REPO_ROOT, 'templates', 'sidescroller', 'source', 'SidescrollerMovement.ts'),
        path.join(REPO_ROOT, 'templates', 'sidescroller', 'source', 'SidescrollerCamera.ts'),
        path.join(REPO_ROOT, 'templates', 'sidescroller', 'source', 'SidescrollerPlayerController.ts'),
        path.join(REPO_ROOT, 'templates', 'top-down', 'source', 'Game.ts'),
    ];
    /**
     * 3D-only world members. A file that calls one must gate it behind
     * `isPlaneLockedPhysics()` (the 2D lane never reaches the call).
     */
    const GATED_WORLD_MEMBERS = new Set(['getRapierWorld', 'createRigidBody', 'createCollider', 'createImpulseJoint', 'removeImpulseJoint']);

    const CONTROLLER_FILES = new Set([
        path.join(GAME_SRC, 'engine', 'WalkingAndJumpingMovement.ts'),
        path.join(GAME_SRC, 'engine', 'animal', 'AnimalLocomotion3D.ts'),
    ]);
    const members = (proto: object): Set<string> => new Set(Object.getOwnPropertyNames(proto));
    const bodyMembers = members(PlaneLockedBody.prototype);
    const worldMembers = members(PlaneLockedPhysics.prototype);
    const controllerMembers = members(PlaneLockedCharacterController.prototype);

    it.each(FILES.map((f) => [path.relative(REPO_ROOT, f), f]))('%s', (_label, file) => {
        const src = fs.readFileSync(file, 'utf8');
        const missingBody = new Set<string>();
        const missingWorld = new Set<string>();
        for (const m of src.matchAll(/\b(?:this\.)?(?:playerBody|physicsBody|characterBody|carryBody)[!?]?\.(\w+)\(/g)) {
            if (!bodyMembers.has(m[1]!)) missingBody.add(m[1]!);
        }
        // The shared movers drive the character controller by this local name
        // (other files use `controller.` for NPC/camera controllers, so only they are scanned).
        if (CONTROLLER_FILES.has(file)) {
            for (const m of src.matchAll(/\bcontroller\.(\w+)\(/g)) {
                if (!controllerMembers.has(m[1]!)) missingWorld.add(`getCharacterController().${m[1]!}`);
            }
        }
        for (const m of src.matchAll(/\bphysicsWorld[!?]?\.(\w+)\(/g)) {
            const name = m[1]!;
            if (worldMembers.has(name)) continue;
            if (GATED_WORLD_MEMBERS.has(name)) {
                if (!src.includes('isPlaneLockedPhysics(')) missingWorld.add(`${name} (3D-only, and the file has no isPlaneLockedPhysics() gate)`);
                continue;
            }
            missingWorld.add(name);
        }
        expect([...missingBody]).toEqual([]);
        expect([...missingWorld]).toEqual([]);
    });
});

describe('ground plane (top-down): the 2D world is X/Z and world Y is virtual', () => {
    const PLANE_XZ = { orientation: 'xz' as const, planeZ: 0 };
    const ENV = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);
    const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };
    const UNIT = { x: 1, y: 1, z: 1 };
    /** KCC offset (PhysicsWorld2D creates the controller with 0.08) + the test capsule's half-height + radius. */
    const REST = 0.08 + 0.5 + 0.3;

    /**
     * Grid origin (0, −20, 0), half-metre voxels: a chunk spans 8 m and cy = 2
     * spans world y ∈ [−4, 4). Terrain over [0, 16)²: the street tops at y = 0,
     * a kerb (top 0.5) over x ∈ [6, 8), a cliff (top 1) over x ∈ [0, 2).
     */
    function makeGroundLane(): { world2D: PhysicsWorld2D; facade: PlaneLockedPhysics } {
        const world2D = new PhysicsWorld2D({ x: 0, y: 0 });
        const facade = createPlaneLockedPhysics(world2D, PLANE_XZ);
        const ground = facade.ground!;
        ground.setGrid(0, -20, 0, 0.5);
        for (const cx of [0, 1]) {
            for (const cz of [0, 1]) {
                const boxes = [{ x: 0, y: 0, z: 0, w: 16, h: 8, d: 16 }];
                if (cx === 0 && cz === 0) {
                    boxes.push({ x: 12, y: 8, z: 0, w: 4, h: 1, d: 16 }); // kerb: x ∈ [6, 8), top 0.5
                    boxes.push({ x: 0, y: 8, z: 0, w: 4, h: 2, d: 16 });  // cliff: x ∈ [0, 2), top 1
                }
                ground.setChunkTops(`${cx},2,${cz}`, cx, 2, cz, boxes);
            }
        }
        world2D.step(1 / 60);
        return { world2D, facade };
    }

    function characterAt(facade: PlaneLockedPhysics, x: number, y: number, z: number): PlaneLockedBody {
        return facade.createCharacterCapsule({
            x, y, z, radius: 0.3, halfHeight: 0.5,
            collisionGroup: CollisionGroup.PLAYER, collisionMask: CollisionMask.PLAYER, friction: 0.4,
        });
    }

    /** One mover frame: solve, apply exactly, step. Returns the computed movement and grounded flag. */
    function frame(world2D: PhysicsWorld2D, facade: PlaneLockedPhysics, body: PlaneLockedBody, desired: { x: number; y: number; z: number }): { mv: { x: number; y: number; z: number }; grounded: boolean } {
        const controller = facade.getCharacterController();
        const collider = body.collider(0);
        controller.computeColliderMovement(collider, desired, undefined, undefined, (other) => other.handle !== collider.handle);
        const mv = controller.computedMovement();
        const grounded = controller.computedGrounded();
        const t = body.translation();
        body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
        world2D.step(1 / 60);
        return { mv, grounded };
    }

    it('a character body carries its own Y while the 2D world sees X/Z; kinematic moves land exactly', () => {
        const { world2D, facade } = makeGroundLane();
        expect(facade.orientation).toBe('xz');
        expect(facade.ground).not.toBeNull();
        const body = characterAt(facade, 8, 2.5, 8);
        expect(body.translation()).toEqual({ x: 8, y: 2.5, z: 8 });
        expect(body.raw.translation()).toEqual({ x: 8, y: 8 });
        body.setNextKinematicTranslation({ x: 9, y: 1.25, z: 7 });
        world2D.step(1 / 60);
        const t = body.translation();
        expect(t.x).toBeCloseTo(9);
        expect(t.y).toBe(1.25);
        expect(t.z).toBeCloseTo(7);
        expect(facade.getBodyTranslation(body.handle)).toEqual({ x: t.x, y: 1.25, z: t.z });
        // The collider reports the capsule the movers read, not the ball the plane holds.
        const collider = body.collider(0);
        expect(collider.radius()).toBeCloseTo(0.3);
        expect(collider.halfHeight()).toBeCloseTo(0.5);
        expect((collider.shape as { halfHeight?: number }).halfHeight).toBeCloseTo(0.5);
        expect(collider.translation().y).toBe(1.25);
        collider.setHalfHeight(0.2);
        expect(collider.halfHeight()).toBeCloseTo(0.2);
        expect(collider.raw.radius()).toBeCloseTo(0.3);
    });

    it('rotation and spin are about world Y; velocities lose their Y', () => {
        const { world2D, facade } = makeGroundLane();
        const built = facade.createEnvironmentBody({
            boxes: [{ cx: 0, cy: 1, cz: 0, hx: 0.5, hy: 1, hz: 0.5 }],
            transform: { translation: { x: 10, y: 0, z: 10 }, rotation: IDENTITY_ROT, scale: UNIT },
            kind: { dynamic: { mass: 2 } }, collisionGroups: ENV, friction: 0.5, restitution: 0,
        });
        const body = built.body;
        const half = Math.PI / 4;
        body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
        const q = body.rotation();
        expect(q.x).toBe(0);
        expect(q.z).toBe(0);
        expect(2 * Math.atan2(q.y, q.w)).toBeCloseTo(Math.PI / 2);
        body.setAngvel({ x: 0, y: 3, z: 0 }, true);
        expect(body.angvel().y).toBeCloseTo(3);
        expect(body.angvel().z).toBe(0);
        body.setLinvel({ x: 2, y: -5, z: 1 }, true);
        const v = body.linvel();
        expect(v.x).toBeCloseTo(2);
        expect(v.y).toBe(0);
        expect(v.z).toBeCloseTo(1);
        // No 2D gravity: after stepping the prop is still at its authored height, sliding in the plane.
        for (let i = 0; i < 10; i++) world2D.step(1 / 60);
        expect(body.translation().y).toBe(0);
        expect(body.translation().x).toBeGreaterThan(10);
        expect(facade.getGravity().y).toBeCloseTo(-9.81);
        expect(world2D.getGravity()).toEqual({ x: 0, y: 0 });
    });

    it('the controller keeps a character on the terrain: falls, lands, walks up a kerb, snaps down it', () => {
        const { world2D, facade } = makeGroundLane();
        const body = characterAt(facade, 4, 2.5, 4);
        // Fall under the mover's integrated gravity until grounded.
        let grounded = false;
        for (let i = 0; i < 20 && !grounded; i++) ({ grounded } = frame(world2D, facade, body, { x: 0, y: -0.3, z: 0 }));
        expect(grounded).toBe(true);
        expect(body.translation().y).toBeCloseTo(REST);
        expect(facade.groundDistBelowCenter(body.collider(0), 2)).toBeCloseTo(REST);
        expect(facade.groundSlopeUnder(body.collider(0))).toEqual({ tan: 0, downX: 0, downZ: 0 });
        expect(facade.kinematicBodyBelowCenter(body.collider(0), 1.6)).toBeNull();
        expect(facade.ledgeForMantle(body.collider(0), 1, 0, 0.2, 1.2)).toBeNull();
        // Walk +X onto the kerb at x = 6: the step is reported ahead, then the centre pops up 0.5 and stays grounded.
        let stepSeen = 0;
        for (let i = 0; i < 30; i++) {
            if (body.translation().x < 6) {
                const step = facade.detectStepUp(body.collider(0), 1, 0, 0.65);
                if (step > 0) stepSeen = step;
            }
            const { grounded: g } = frame(world2D, facade, body, { x: 0.1, y: 0, z: 0 });
            expect(g).toBe(true);
        }
        expect(stepSeen).toBeCloseTo(0.5);
        expect(body.translation().x).toBeGreaterThan(6.5);
        expect(body.translation().y).toBeCloseTo(REST + 0.5);
        // A step too tall to mount is not reported.
        expect(facade.detectStepUp(body.collider(0), 1, 0, 0.3)).toBe(0);
        // Walk back down: a grounded character snaps to the lower floor in one frame.
        let dropped = false;
        for (let i = 0; i < 30; i++) {
            const { grounded: g, mv } = frame(world2D, facade, body, { x: -0.1, y: 0, z: 0 });
            expect(g).toBe(true);
            if (mv.y < -0.4) dropped = true;
        }
        expect(dropped).toBe(true);
        expect(body.translation().y).toBeCloseTo(REST);
    });

    it('a cliff blocks the character from below and drops it from above', () => {
        const { world2D, facade } = makeGroundLane();
        // The cliff's +X face, and its +Z face against the flat chunk north of the seam at z = 8.
        expect(facade.ground!.wallCount()).toBe(2);
        // From the street, walking into the cliff at x = 2: stopped short of the wall.
        const low = characterAt(facade, 3, REST, 4);
        low.grounded = true;
        const { mv } = frame(world2D, facade, low, { x: -1, y: 0, z: 0 });
        expect(mv.x).toBeGreaterThan(-0.7);
        expect(low.translation().x).toBeGreaterThan(2.3);
        // From the top, walking off (on another row, clear of the first character): the wall is
        // passable, the floor drops away, gravity lands the character.
        const high = characterAt(facade, 1, REST + 1, 6);
        high.grounded = true;
        const off = frame(world2D, facade, high, { x: 1.5, y: 0, z: 0 });
        expect(off.mv.x).toBeCloseTo(1.5, 2);
        expect(off.grounded).toBe(false);
        let grounded = false;
        for (let i = 0; i < 30 && !grounded; i++) ({ grounded } = frame(world2D, facade, high, { x: 0, y: -0.2, z: 0 }));
        expect(grounded).toBe(true);
        expect(high.translation().y).toBeCloseTo(REST);
        // Overlap queries agree with the one-way rule.
        expect(facade.capsuleOverlaps({ x: 2.2, y: REST, z: 6 }, 0.3, 0.5, CollisionGroup.TERRAIN)).toBe(true);
        expect(facade.capsuleOverlaps({ x: 2.2, y: REST + 1, z: 6 }, 0.3, 0.5, CollisionGroup.TERRAIN)).toBe(false);
        expect(facade.capsuleOverlapsStatic(high.collider(0), { x: 2.2, y: REST, z: 6 })).toBe(true);
        expect(facade.capsuleOverlapsStatic(high.collider(0), { x: 2.2, y: REST + 1, z: 6 })).toBe(false);
    });

    it('vertical rays meet the heightmap and the tops of placed objects; horizontal rays pass over ledges', () => {
        const { world2D, facade } = makeGroundLane();
        facade.createEnvironmentBody({
            boxes: [{ cx: 0, cy: 1, cz: 0, hx: 0.5, hy: 1, hz: 0.5 }], // 2 m tall, standing on the street
            transform: { translation: { x: 10, y: 0, z: 10 }, rotation: IDENTITY_ROT, scale: UNIT },
            kind: 'fixed', collisionGroups: ENV, friction: 0.5, restitution: 0,
        });
        world2D.step(1 / 60);
        const down = new THREE.Vector3(0, -1, 0);
        const street = facade.raycast(new THREE.Vector3(4, 10, 4), down, 100, GROUND);
        expect(street.hasHit).toBe(true);
        expect(street.hitDistance).toBeCloseTo(10);
        expect(street.hitPoint.y).toBeCloseTo(0);
        expect(street.hitNormal.y).toBe(1);
        expect(facade.raycast(new THREE.Vector3(7, 10, 4), down, 100, GROUND).hitPoint.y).toBeCloseTo(0.5);
        expect(facade.raycast(new THREE.Vector3(30, 10, 30), down, 100, GROUND).hasHit).toBe(false);
        // Over the object: the roof for a TERRAIN|ENVIRONMENT probe, the street for TERRAIN only.
        const roof = facade.raycast(new THREE.Vector3(10, 10, 10), down, 100, GROUND);
        expect(roof.hitPoint.y).toBeCloseTo(2);
        expect(roof.hitCollider).not.toBeNull();
        expect(facade.raycast(new THREE.Vector3(10, 10, 10), down, 100, CollisionGroup.TERRAIN).hitPoint.y).toBeCloseTo(0);
        // A horizontal ray hits the object's side, in 3D coordinates.
        const side = facade.raycast(new THREE.Vector3(10, 1.5, 5), new THREE.Vector3(0, 0, 1), 20, GROUND);
        expect(side.hasHit).toBe(true);
        expect(side.hitPoint.z).toBeCloseTo(9.5);
        expect(side.hitPoint.y).toBeCloseTo(1.5);
        expect(side.hitNormal.z).toBeCloseTo(-1);
        // Straight up: nothing above.
        expect(facade.raycast(new THREE.Vector3(4, 0.5, 4), new THREE.Vector3(0, 1, 0), 10, GROUND).hasHit).toBe(false);
        // The cliff wall at x = 2 (top 1): a ray above its top passes, one below hits it.
        expect(facade.raycast(new THREE.Vector3(5, 1.5, 4), new THREE.Vector3(-1, 0, 0), 10, CollisionGroup.TERRAIN).hasHit).toBe(false);
        const wall = facade.raycast(new THREE.Vector3(5, 0.5, 4), new THREE.Vector3(-1, 0, 0), 10, CollisionGroup.TERRAIN);
        expect(wall.hasHit).toBe(true);
        expect(wall.hitPoint.x).toBeCloseTo(2.05);
        // raycastWithFilter follows the same geometry.
        const filtered = facade.raycastWithFilter(new THREE.Vector3(4, 10, 4), down, 100, 0xFFFF, GROUND);
        expect(filtered.hitPoint.y).toBeCloseTo(0);
    });

    it('placed objects collide by their footprint band: kerbs are stepped over, arches walked under', () => {
        const { world2D, facade } = makeGroundLane();
        const build = (cy: number, hy: number): number => facade.createEnvironmentBody({
            boxes: [{ cx: 0, cy, cz: 0, hx: 1, hy, hz: 1 }],
            transform: { translation: { x: 12, y: 0, z: 12 }, rotation: IDENTITY_ROT, scale: UNIT },
            kind: 'fixed', collisionGroups: ENV, friction: 0.5, restitution: 0,
        }).colliders.length;
        expect(build(0.2, 0.2)).toBe(0);  // a 0.4 m kerb
        expect(build(2.6, 0.5)).toBe(0);  // an overhead beam at 2.1–3.1 m
        expect(build(1, 1)).toBe(1);      // a 2 m wall
        world2D.step(1 / 60);
        expect(facade.intersectsBox({ x: 12, y: 0, z: 12 }, { x: 0.2, y: 5, z: 0.2 }, CollisionGroup.ENVIRONMENT)).toBe(true);
        expect(facade.intersectsBox({ x: 15, y: 0, z: 15 }, { x: 0.2, y: 5, z: 0.2 }, CollisionGroup.ENVIRONMENT)).toBe(false);
    });

    it('agent queries report 3D positions and in-plane avoidance', () => {
        const { world2D, facade } = makeGroundLane();
        facade.createEnvironmentBody({
            boxes: [{ cx: 0, cy: 1, cz: 0, hx: 0.5, hy: 1, hz: 0.5 }],
            transform: { translation: { x: 4, y: 0, z: 4 }, rotation: IDENTITY_ROT, scale: UNIT },
            kind: { dynamic: { mass: 1 } }, collisionGroups: makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP),
            friction: 0.5, restitution: 0, userData: { kind: 'crate' },
        });
        world2D.step(1 / 60);
        const found = facade.queryEntitiesInRadius({ x: 4, y: 0, z: 4 }, 2);
        expect(found).toHaveLength(1);
        expect(found[0]!.position).toEqual({ x: 4, y: 0, z: 4 });
        expect(found[0]!.userData).toEqual({ kind: 'crate' });
        expect(facade.getBodyLinvel(found[0]!.handle)).toEqual({ x: 0, y: 0, z: 0 });
        const away = facade.computeGroupAvoidance({ x: 4.2, y: 0.9, z: 4 }, 0.3, 0.5, 0.1, CollisionGroup.DYNAMIC_PROP);
        expect(away).not.toBeNull();
        expect(away!.x).toBeCloseTo(1);
        expect(away!.z).toBeCloseTo(0);
        const diagonal = facade.computeGroupAvoidance({ x: 4.2, y: 0.9, z: 4.2 }, 0.3, 0.5, 0.1, CollisionGroup.DYNAMIC_PROP);
        expect(diagonal!.x).toBeCloseTo(Math.SQRT1_2);
        expect(diagonal!.z).toBeCloseTo(Math.SQRT1_2);
        expect(facade.computeGroupAvoidance({ x: 12, y: 0.9, z: 12 }, 0.3, 0.5, 0.1, CollisionGroup.DYNAMIC_PROP)).toBeNull();
    });

    it('a sensor ball at a 3D position reports the character on the ground plane', () => {
        const { world2D, facade } = makeGroundLane();
        const events: Array<[number, number]> = [];
        world2D.addSensorListener({ onIntersectionStart: (a, b) => events.push([a, b]), onIntersectionEnd: () => {} });
        const sensor = facade.createSensorBall({ x: 10, y: 0.5, z: 10, radius: 1, collisionGroups: makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER) });
        expect(sensor.body.translation()).toEqual({ x: 10, y: 0.5, z: 10 });
        const body = characterAt(facade, 6, REST, 10);
        body.setNextKinematicTranslation({ x: 10, y: REST, z: 10 });
        for (let i = 0; i < 3; i++) { world2D.step(1 / 60); world2D.flushCollisionCallbacks(); }
        expect(events.some(([a, b]) => a === sensor.collider.handle || b === sensor.collider.handle)).toBe(true);
    });

    it.each([30, 60, 120])('a shot flies flat and hits the near obstacle surface at %i Hz', fps => {
        const { world2D, facade } = makeGroundLane();
        facade.createEnvironmentBody({
            boxes: [{ cx: 0, cy: 1, cz: 0, hx: 0.5, hy: 1, hz: 0.5 }],   // a 2 m post
            transform: { translation: { x: 8, y: 0, z: 12 }, rotation: IDENTITY_ROT, scale: UNIT },
            kind: 'fixed', collisionGroups: ENV, friction: 0.5, restitution: 0,
        });
        const shot = facade.createProjectileBody({
            x: 8, y: 1.2, z: 8, velocity: { x: 0, y: -6, z: 30 }, radius: 0.05,
            collisionGroups: makeCollisionGroups(CollisionGroup.PROJECTILE, CollisionMask.PROJECTILE), gravityScale: 0,
        });
        // The aim's downward component is projected away: a top-down shot holds
        // its muzzle height, and its 2D velocity is the in-plane part alone.
        expect(shot.linvel()).toEqual({ x: 0, y: 0, z: 30 });
        const contacts: ContactInfo[] = [];
        facade.registerCollisionCallback(shot, (c) => { contacts.push(c); });
        for (let i = 0; i < fps && contacts.length === 0; i++) { world2D.step(1 / fps); world2D.flushCollisionCallbacks(); }
        expect(contacts).toHaveLength(1);
        const hit = contacts[0]!;
        expect(hit.bodyA.handle).toBe(shot.handle);
        expect(hit.bodyB.isFixed()).toBe(true);
        expect(hit.contactPoint.y).toBeCloseTo(1.2);        // the height the shot flew at
        expect(hit.contactPoint.z).toBeCloseTo(11.5, 2);
        expect(hit.contactNormal.y).toBe(0);
        expect(hit.contactNormal.z).toBeCloseTo(1);   // bodyA -> bodyB: into the surface
        expect(shot.translation().y).toBe(1.2);
        for (let i = 0; i < fps; i++) { world2D.step(1 / fps); world2D.flushCollisionCallbacks(); }
        expect(shot.translation().z).toBeLessThan(11.6); // cannot tunnel out of the far side
    });

    it('a shot passes over a cliff wall lower than its flight height, and is stopped by a higher one', () => {
        const { world2D, facade } = makeGroundLane();
        expect(facade.ground!.wallCount()).toBeGreaterThan(0);   // the street/cliff step at x = 2
        const GROUPS = makeCollisionGroups(CollisionGroup.PROJECTILE, CollisionMask.PROJECTILE);
        const fire = (y: number): { body: PlaneLockedBody; contacts: ContactInfo[] } => {
            const body = facade.createProjectileBody({
                x: 5, y, z: 8, velocity: { x: -30, y: 0, z: 0 }, radius: 0.05, collisionGroups: GROUPS, gravityScale: 0,
            });
            const contacts: ContactInfo[] = [];
            facade.registerCollisionCallback(body, (c) => { contacts.push(c); });
            return { body, contacts };
        };
        const over = fire(1.5);      // above the wall's top (1) — a ledge under it
        const into = fire(0.5);      // below it — a wall in its way
        for (let i = 0; i < 20; i++) { world2D.step(1 / 60); world2D.flushCollisionCallbacks(); }
        expect(over.contacts).toHaveLength(0);
        expect(over.body.translation().x).toBeLessThan(2);       // it flew past
        expect(over.body.linvel().x).toBeCloseTo(-30);           // and stayed on its line
        expect(into.contacts.length).toBeGreaterThan(0);
        expect(into.contacts[0]!.contactPoint.x).toBeCloseTo(2, 1);
    });

    it('a bare plane Z still means the side-on lane', () => {
        const { facade } = makeLane(1.5);
        expect(facade.orientation).toBe('xy');
        expect(facade.planeZ).toBe(1.5);
        expect(facade.ground).toBeNull();
    });
});

describe('ground plane: terrain-registered objects feed the heightmap', () => {
    it('a terrain object is floor, not an obstacle band, and leaves with its body', () => {
        const world2D = new PhysicsWorld2D({ x: 0, y: 0 });
        const facade = createPlaneLockedPhysics(world2D, { orientation: 'xz', planeZ: 0 });
        const ground = facade.ground!;
        ground.setGrid(0, 0, 0, 0.5);
        const built = facade.createEnvironmentBody({
            boxes: [
                { cx: 0, cy: 1, cz: 0, hx: 4, hy: 1, hz: 4 },          // an 8×8 slab, y ∈ [0, 2]
                { cx: 2, cy: 2.25, cz: 2, hx: 1, hy: 0.25, hz: 1 },    // a kerb on it, y ∈ [2, 2.5]
            ],
            transform: { translation: { x: 4, y: 0, z: 4 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            kind: 'fixed', collisionGroups: makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN),
            friction: 0.5, restitution: 0, terrain: true,
        });
        expect(built.colliders).toHaveLength(0);
        expect(ground.heightAt(1, 1)).toBe(2);
        expect(ground.heightAt(6, 6)).toBe(2.5);
        expect(ground.wallCount()).toBe(0);
        world2D.step(1 / 60);
        const hit = facade.raycast(new THREE.Vector3(6, 10, 6), new THREE.Vector3(0, -1, 0), 100, CollisionGroup.TERRAIN);
        expect(hit.hitPoint.y).toBeCloseTo(2.5);
        // Side-on stays what it was: the same object is sliced into obstacle cuboids.
        const side = createPlaneLockedPhysics(new PhysicsWorld2D({ x: 0, y: -30 }), 0);
        expect(side.createEnvironmentBody({
            boxes: [{ cx: 0, cy: 1, cz: 0, hx: 4, hy: 1, hz: 4 }],
            transform: { translation: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            kind: 'fixed', collisionGroups: makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN),
            friction: 0.5, restitution: 0, terrain: true,
        }).colliders).toHaveLength(1);
        facade.removeRigidBody(built.body);
        expect(ground.heightAt(1, 1)).toBeNull();
    });
});

describe('side-on: a shot arcs under the plane\'s gravity and reports a 3D contact', () => {
    const GROUPS = makeCollisionGroups(CollisionGroup.PROJECTILE, CollisionMask.PROJECTILE);

    it('flies along the plane, keeps its Z, and hits a wall', () => {
        const { world2D, facade } = makeLane(1.5);
        addGround(world2D, 0);
        facade.createEnvironmentBody({
            boxes: [{ cx: 0, cy: 1.5, cz: 0, hx: 0.25, hy: 1.5, hz: 0.5 }],
            transform: { translation: { x: 6, y: 0, z: 1.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            kind: 'fixed', collisionGroups: makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT),
            friction: 0.5, restitution: 0,
        });
        const shot = facade.createProjectileBody({
            x: 0, y: 2, z: 99, velocity: { x: 40, y: 0, z: 7 }, radius: 0.05, collisionGroups: GROUPS, gravityScale: 0,
        });
        expect(shot.translation()).toEqual({ x: 0, y: 2, z: 1.5 });   // the lane's Z, not the caller's
        expect(shot.linvel()).toEqual({ x: 40, y: 0, z: 0 });
        const contacts: ContactInfo[] = [];
        facade.registerCollisionCallback(shot, (c) => { contacts.push(c); });
        for (let i = 0; i < 30 && contacts.length === 0; i++) { world2D.step(1 / 60); world2D.flushCollisionCallbacks(); }
        expect(contacts).toHaveLength(1);
        const hit = contacts[0]!;
        expect(hit.bodyA.handle).toBe(shot.handle);
        expect(hit.contactPoint.x).toBeCloseTo(5.75, 1);
        expect(hit.contactPoint.y).toBeCloseTo(2, 1);
        expect(hit.contactPoint.z).toBe(1.5);
        expect(hit.contactNormal.x).toBeCloseTo(1);   // bodyA -> bodyB: into the surface
        expect(hit.contactNormal.z).toBe(0);
        // gravityScale 0 held it flat all the way to the wall.
        expect(shot.translation().y).toBeCloseTo(2, 1);
    });

    it('gravityScale arcs the shot under the world\'s gravity', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        const flat = facade.createProjectileBody({
            x: 0, y: 5, z: 0, velocity: { x: 10, y: 0, z: 0 }, radius: 0.05, collisionGroups: GROUPS, gravityScale: 0,
        });
        const lobbed = facade.createProjectileBody({
            x: 0, y: 5, z: 0, velocity: { x: 10, y: 0, z: 0 }, radius: 0.05, collisionGroups: GROUPS, gravityScale: 1,
        });
        for (let i = 0; i < 20; i++) world2D.step(1 / 60);
        expect(flat.translation().y).toBeCloseTo(5, 5);
        expect(lobbed.translation().y).toBeLessThan(4.9);
        expect(lobbed.translation().x).toBeCloseTo(flat.translation().x, 5);
    });

    it('unregisters the translated callback, and forgets a removed shot\'s callbacks', () => {
        const { world2D, facade } = makeLane();
        addGround(world2D, 0);
        // A weapon registers one callback per shot fired, so the wrappers must
        // not outlive the bodies: the registry is keyed by body and emptied with it.
        const registry = (facade as unknown as { planeContactCallbacks: Map<number, unknown> }).planeContactCallbacks;
        const fire = (): PlaneLockedBody => facade.createProjectileBody({
            x: 0, y: 0.2, z: 0, velocity: { x: 0, y: -20, z: 0 }, radius: 0.05, collisionGroups: GROUPS, gravityScale: 0,
        });
        const shot = fire();
        let seen = 0;
        const onContact = (): void => { seen++; };
        facade.registerCollisionCallback(shot, onContact);
        expect(registry.size).toBe(1);
        facade.unregisterCollisionCallback(shot, onContact);
        expect(registry.size).toBe(0);
        for (let i = 0; i < 10; i++) { world2D.step(1 / 60); world2D.flushCollisionCallbacks(); }
        expect(seen).toBe(0);

        for (let i = 0; i < 5; i++) {
            const spent = fire();
            facade.registerCollisionCallback(spent, () => {});
            facade.removeRigidBody(spent);
        }
        expect(registry.size).toBe(0);
    });
});
