/**
 * A ball authored above the pitch must FALL onto it.
 *
 * A `dynamic` env instance is placed with its rigid body asleep, so a level of
 * resting props pays no settle wave on load (PristineDynamic.ts). Rapier never
 * integrates a sleeping body — gravity included — and the soccer/rugby
 * archetypes spawn the ball at y = 1.5 over the pitch. The ball therefore hung
 * in mid-air for the whole session: a metre above the kicking foot, so the
 * contact gate could never connect and the kick did nothing at all.
 *
 * These use a REAL Rapier world, because the bug is Rapier's sleeping
 * semantics — a mock body would have "fallen" either way.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { sphereColliderDesc } from 'engine/physics/BallPhysics.js';
import { BallSportsSystem } from 'engine/BallSportsSystem.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { VoxelObject } from 'engine/VoxelObject.js';

const BALL_SPAWN_Y = 1.5;
const BALL_RADIUS = 0.2;

beforeAll(async () => {
    await initRapier();
});

/** A pitch at y = 0 plus the ball body exactly as the pristine dynamic path builds it: asleep. */
function pitchWithSleepingBall(): { physicsWorld: PhysicsWorld; body: RAPIER.RigidBody } {
    const physicsWorld = new PhysicsWorld();
    const ground = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50), ground);

    const body = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(0, BALL_SPAWN_Y, 0).setLinearDamping(0.1),
    );
    physicsWorld.createCollider(sphereColliderDesc(BALL_RADIUS), body);
    body.sleep(); // initPristineDynamicBody's last line
    return { physicsWorld, body };
}

/** The ball env object: only the members BallSportsSystem reads. */
function registerBall(name: string, body: RAPIER.RigidBody): void {
    const ball = {
        name,
        getRigidBody: () => body,
        getColliders: () => [],
        setAlwaysActive: () => undefined,
    } as unknown as VoxelObject;
    VoxelObjectBuilder.registerExternalObject(`${name}_0`, ball);
}

function playerController(): PlayerController {
    return {
        player: { position: { x: 0, y: 0, z: 0 } },
        rotation: 0,
        animationController: null,
        setActionHandler: () => undefined,
        addExternalDisplacement: () => undefined,
    } as unknown as PlayerController;
}

/** Run the world for `seconds` of fixed 60 Hz steps. */
function simulate(physicsWorld: PhysicsWorld, seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 60); i++) physicsWorld.step(1 / 60);
}

describe('a ball spawned above the pitch', () => {
    beforeEach(() => {
        VoxelObjectBuilder.getAllObjects().clear();
    });

    test('hangs in mid-air while its body is left asleep', () => {
        // The pre-fix behaviour, pinned so the cause stays legible: nothing but
        // a wake makes a slept body fall, so this is NOT something a spawn
        // height or a gravity setting could have fixed.
        const { physicsWorld, body } = pitchWithSleepingBall();
        simulate(physicsWorld, 3);
        expect(body.translation().y).toBeCloseTo(BALL_SPAWN_Y, 3);
    });

    test('drops onto the pitch once BallSportsSystem takes it over', () => {
        const { physicsWorld, body } = pitchWithSleepingBall();
        registerBall('soccer_ball', body);

        new BallSportsSystem(playerController(), { ballName: 'soccer_ball' });
        simulate(physicsWorld, 3);

        // Resting on the pitch, within reach of the kicking foot — not floating
        // at the spawn height where the contact gate could never reach it.
        const restY = body.translation().y;
        expect(restY).toBeLessThan(BALL_SPAWN_Y);
        expect(restY).toBeCloseTo(BALL_RADIUS, 1);
    });
});
