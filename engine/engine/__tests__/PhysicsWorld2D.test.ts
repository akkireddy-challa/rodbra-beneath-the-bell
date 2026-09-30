/**
 * `PhysicsWorld2D` against the REAL rapier2d — the 2D runtime had no test
 * coverage at all, against thirteen files for the 3D world.
 *
 * Everything pinned here was a defect found by review, or the load-bearing
 * detail that a defect's fix rests on, and all of it is the kind a type-check
 * and a green build cannot see: a trigger that never fires scores zero
 * silently, a ground probe that aborts on a sensor reports "airborne" over
 * solid floor, and a mis-strided event batch pairs the wrong two colliders
 * without ever throwing. They are covered by driving a real world rather than
 * a mock, because the bug in each case was in what Rapier actually reports,
 * not in our arithmetic.
 */
import RAPIER2D from '@dimforge/rapier2d-compat';
import { initRapier2D } from 'engine/physics/RapierPhysics2D.js';
import { PhysicsWorld2D, type SensorIntersectionListener2D } from 'engine/physics/PhysicsWorld2D.js';

jest.setTimeout(30_000);

beforeAll(async () => {
    await initRapier2D();
});

/** Bodies go through the wrapper's own createRigidBody/createCollider, which is
 *  how every real caller builds them. */
function newWorld(): PhysicsWorld2D {
    return new PhysicsWorld2D({ x: 0, y: -30 });
}

const EVENTS = () => RAPIER2D.ActiveEvents.COLLISION_EVENTS;

/** A fixed sensor slab at (x, y) plus a ball dropped straight through it. */
function sensorPair(
    world: PhysicsWorld2D,
    x: number,
    opts: { activeEvents?: 'both' | 'sensor' | 'body' | 'none' } = {},
): { sensor: RAPIER2D.Collider; faller: RAPIER2D.Collider; fallerBody: RAPIER2D.RigidBody; sensorBody: RAPIER2D.RigidBody } {
    const which = opts.activeEvents ?? 'both';
    const sensorBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(x, 0));
    const sensorDesc = RAPIER2D.ColliderDesc.cuboid(0.8, 0.5).setSensor(true);
    if (which === 'both' || which === 'sensor') sensorDesc.setActiveEvents(EVENTS());
    const sensor = world.createCollider(sensorDesc, sensorBody);

    const fallerBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.dynamic().setTranslation(x, 3));
    const fallerDesc = RAPIER2D.ColliderDesc.ball(0.2);
    if (which === 'both' || which === 'body') fallerDesc.setActiveEvents(EVENTS());
    const faller = world.createCollider(fallerDesc, fallerBody);

    return { sensor, faller, fallerBody, sensorBody };
}

describe('sensor (trigger) overlaps', () => {
    it('reports BOTH entry and exit — a start-only stream latches every trigger on first contact', () => {
        const world = newWorld();

        // A static sensor, and a body that falls through it.
        const sensorBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 0));
        const sensor = world.createCollider(
            RAPIER2D.ColliderDesc.cuboid(2, 0.5).setSensor(true)
                .setActiveEvents(RAPIER2D.ActiveEvents.COLLISION_EVENTS),
            sensorBody,
        );
        const fallingBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.dynamic().setTranslation(0, 6));
        world.createCollider(
            RAPIER2D.ColliderDesc.ball(0.25).setActiveEvents(RAPIER2D.ActiveEvents.COLLISION_EVENTS),
            fallingBody,
        );

        const events: string[] = [];
        const listener: SensorIntersectionListener2D = {
            onIntersectionStart: (h1, h2) => {
                if (h1 === sensor.handle || h2 === sensor.handle) events.push('start');
            },
            onIntersectionEnd: (h1, h2) => {
                if (h1 === sensor.handle || h2 === sensor.handle) events.push('end');
            },
        };
        world.addSensorListener(listener);

        for (let i = 0; i < 240; i++) {
            world.step(1 / 60);
            world.flushCollisionCallbacks();
        }

        expect(events).toContain('start');
        expect(events).toContain('end');
        expect(events.indexOf('start')).toBeLessThan(events.indexOf('end'));

        world.removeSensorListener(listener);
    });

    it('delivers nothing once the listener is removed', () => {
        const world = newWorld();
        const sensorBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 0));
        world.createCollider(
            RAPIER2D.ColliderDesc.cuboid(2, 0.5).setSensor(true)
                .setActiveEvents(RAPIER2D.ActiveEvents.COLLISION_EVENTS),
            sensorBody,
        );
        const body = world.createRigidBody(RAPIER2D.RigidBodyDesc.dynamic().setTranslation(0, 3));
        world.createCollider(
            RAPIER2D.ColliderDesc.ball(0.25).setActiveEvents(RAPIER2D.ActiveEvents.COLLISION_EVENTS), body);

        let count = 0;
        const listener: SensorIntersectionListener2D = {
            onIntersectionStart: () => { count++; },
            onIntersectionEnd: () => { count++; },
        };
        world.addSensorListener(listener);
        world.removeSensorListener(listener);
        for (let i = 0; i < 120; i++) world.step(1 / 60);
        expect(count).toBe(0);
    });

    it('pairs the right two colliders when two sensors fire in the SAME step', () => {
        // `collectCollisionEvents` packs the drained queue as TRIPLES
        // (handle1, handle2, started). Every reader of that array must advance by
        // 3. A stride of 2 still runs, still type-checks and still fires the right
        // NUMBER of events — it just reads (started, nextHandle1) as a collider
        // pair, so a coin credits the wrong player and a checkpoint fires from a
        // trigger on the far side of the level. Two identical pickups at
        // ±10 metres cross their sensors on the very same step, which is the only
        // arrangement where the mispairing is observable.
        const world = newWorld();
        const left = sensorPair(world, -10);
        const right = sensorPair(world, 10);

        const started: Array<[number, number]> = [];
        let maxEventsInOneStep = 0;
        let eventsThisStep = 0;
        world.addSensorListener({
            onIntersectionStart: (h1, h2) => { started.push([h1, h2]); eventsThisStep++; },
            onIntersectionEnd: () => {},
        });

        for (let i = 0; i < 200; i++) {
            eventsThisStep = 0;
            world.step(1 / 60);
            maxEventsInOneStep = Math.max(maxEventsInOneStep, eventsThisStep);
        }

        // The premise of the test: both pairs really did report in one batch.
        expect(maxEventsInOneStep).toBe(2);
        expect(started).toHaveLength(2);

        // Each event must name one sensor and its OWN faller — never a handle
        // borrowed from the other pair, and never the `started` flag itself.
        const asSet = started.map(([a, b]) => new Set([a, b]));
        expect(asSet).toContainEqual(new Set([left.sensor.handle, left.faller.handle]));
        expect(asSet).toContainEqual(new Set([right.sensor.handle, right.faller.handle]));
    });

    it('never reports a pair where neither collider is a sensor', () => {
        // Solid-vs-solid contacts go to registerCollisionCallback, not here. If
        // they leaked into the sensor stream every landing would look like a
        // pickup.
        const world = newWorld();
        sensorPair(world, 0); // guarantees the stream is not simply empty

        const groundBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(20, 0));
        const ground = world.createCollider(
            RAPIER2D.ColliderDesc.cuboid(3, 0.5).setActiveEvents(EVENTS()), groundBody);
        const crateBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.dynamic().setTranslation(20, 3));
        const crate = world.createCollider(
            RAPIER2D.ColliderDesc.cuboid(0.3, 0.3).setActiveEvents(EVENTS()), crateBody);

        const seen: number[] = [];
        let sensorEvents = 0;
        world.addSensorListener({
            onIntersectionStart: (h1, h2) => { seen.push(h1, h2); sensorEvents++; },
            onIntersectionEnd: (h1, h2) => { seen.push(h1, h2); },
        });
        for (let i = 0; i < 200; i++) world.step(1 / 60);

        expect(sensorEvents).toBeGreaterThan(0);
        expect(seen).not.toContain(ground.handle);
        expect(seen).not.toContain(crate.handle);
    });

    it('needs COLLISION_EVENTS on at least one collider of the pair — a bare setSensor(true) is silent', () => {
        // Rapier emits an intersection event only when the OR of both colliders'
        // activeEvents carries COLLISION_EVENTS. Dispatching them correctly buys
        // nothing if the thing that builds the sensor never opts in, so the
        // requirement is pinned on the producer side too: see
        // PhysicsBodyFactory2D.createColliderDesc, which sets `isSensor` but no
        // activeEvents at all.
        const silent = newWorld();
        let silentCount = 0;
        sensorPair(silent, 0, { activeEvents: 'none' });
        silent.addSensorListener({
            onIntersectionStart: () => { silentCount++; }, onIntersectionEnd: () => { silentCount++; },
        });
        for (let i = 0; i < 240; i++) silent.step(1 / 60);
        expect(silentCount).toBe(0);

        // One side is enough — and it does not have to be the sensor.
        const loud = newWorld();
        let loudCount = 0;
        sensorPair(loud, 0, { activeEvents: 'body' });
        loud.addSensorListener({
            onIntersectionStart: () => { loudCount++; }, onIntersectionEnd: () => { loudCount++; },
        });
        for (let i = 0; i < 240; i++) loud.step(1 / 60);
        expect(loudCount).toBeGreaterThan(0);
    });
});

describe('sensor dispatch re-entrancy', () => {
    it('lets a listener unsubscribe itself without starving the listeners behind it', () => {
        // The collected-coin pattern: the trigger fires once, then removes its
        // own listener. The dispatch loop iterates a Set that is being mutated —
        // JS Set iteration skips an entry deleted before it is reached and keeps
        // going, which is exactly what is wanted. An Array + splice in the same
        // place would skip the NEXT listener instead, silently dropping one
        // pickup per frame in a level with several.
        const world = newWorld();
        sensorPair(world, 0);

        let selfCalls = 0;
        let neighbourCalls = 0;
        const selfRemoving: SensorIntersectionListener2D = {
            onIntersectionStart: () => { selfCalls++; world.removeSensorListener(selfRemoving); },
            onIntersectionEnd: () => { selfCalls++; },
        };
        const neighbour: SensorIntersectionListener2D = {
            onIntersectionStart: () => { neighbourCalls++; },
            onIntersectionEnd: () => { neighbourCalls++; },
        };
        world.addSensorListener(selfRemoving);
        world.addSensorListener(neighbour);

        for (let i = 0; i < 240; i++) world.step(1 / 60);

        // The self-remover saw its one entry and nothing after it...
        expect(selfCalls).toBe(1);
        // ...and the listener registered behind it still saw both phases.
        expect(neighbourCalls).toBe(2);
    });

    it('defers an *Immediate removal made from inside a listener to the next step', () => {
        // "trigger fires → entity dies → delete its body" is the standard
        // collectible shape. The dispatch runs with the deferred-removal guard
        // raised so the delete lands on the pending queue instead of mutating the
        // collider set that the contact loop immediately below is about to read.
        const world = newWorld();
        const { sensorBody } = sensorPair(world, 0);

        let validDuringDispatch: boolean | null = null;
        const listener: SensorIntersectionListener2D = {
            onIntersectionStart: () => {
                world.removeRigidBodyImmediate(sensorBody);
                validDuringDispatch = sensorBody.isValid();
                world.removeSensorListener(listener);
            },
            onIntersectionEnd: () => {},
        };
        world.addSensorListener(listener);

        expect(() => { for (let i = 0; i < 240; i++) world.step(1 / 60); }).not.toThrow();

        expect(validDuringDispatch).toBe(true);   // deferred, not applied mid-dispatch
        expect(sensorBody.isValid()).toBe(false); // and really gone by the end
    });

    it('lowers the deferred-removal guard again even when a listener throws', () => {
        // Without the try/finally the guard latches ON for the lifetime of the
        // world, and every later removeRigidBodyImmediate silently becomes a
        // deferred removal — bodies that game code expects to be gone survive a
        // whole extra frame, and if the loop is not stepping again they never go
        // at all.
        const world = newWorld();
        sensorPair(world, 0);
        world.addSensorListener({
            onIntersectionStart: () => { throw new Error('listener blew up'); },
            onIntersectionEnd: () => {},
        });

        for (let i = 0; i < 240; i++) {
            // NOTE: the throw escapes step() — PhysicsWorld2D has no equivalent of
            // the 3D world's halt latch, so it reaches GameEngine.update(). The
            // point of this test is what the guard looks like afterwards.
            try { world.step(1 / 60); } catch { /* swallowed on purpose */ }
        }

        const probe = world.createRigidBody(RAPIER2D.RigidBodyDesc.dynamic().setTranslation(50, 50));
        world.removeRigidBodyImmediate(probe);
        expect(probe.isValid()).toBe(false); // guard is down: the removal was immediate
    });
});

describe('contact callbacks', () => {
    it('fire on START only — a separation must not re-fire them', () => {
        // Both phases are collected now, so the contact loop is the one reader
        // that must still discard `started === false`. Drop that filter and every
        // collision handler in a 2D game runs twice: damage applied on landing AND
        // again on take-off.
        const world = newWorld();
        const groundBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 0));
        world.createCollider(RAPIER2D.ColliderDesc.cuboid(10, 0.5).setActiveEvents(EVENTS()), groundBody);
        const ballBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.dynamic().setTranslation(0, 1.5));
        world.createCollider(
            RAPIER2D.ColliderDesc.ball(0.3).setRestitution(0).setActiveEvents(EVENTS()), ballBody);

        let hits = 0;
        world.registerCollisionCallback(ballBody, (info) => {
            hits++;
            expect(info.bodyA.handle).toBe(ballBody.handle);
            expect(info.bodyB.handle).toBe(groundBody.handle);
        });

        for (let i = 0; i < 120; i++) { world.step(1 / 60); world.flushCollisionCallbacks(); }
        expect(hits).toBe(1); // landed once

        // Teleport clear of the floor: rapier reports an ENDED event next step.
        ballBody.setTranslation({ x: 0, y: 50 }, true);
        for (let i = 0; i < 5; i++) { world.step(1 / 60); world.flushCollisionCallbacks(); }
        expect(hits).toBe(1); // still once — the separation was not a contact
    });
});

describe('raycast', () => {
    it('sees solid ground THROUGH a sensor instead of reporting nothing', () => {
        // The shipped failure: a ground probe whose nearest hit was a trigger
        // (water is a sensor whose collider is a member of every group, so even a
        // narrow GROUND_CHECK mask does not filter it) returned "no hit" — the
        // character read as airborne over solid floor, sank, and could not
        // auto-step out because auto-step requires `grounded`.
        const world = newWorld();

        const groundBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 0));
        const ground = world.createCollider(RAPIER2D.ColliderDesc.cuboid(10, 0.5), groundBody);

        // A sensor slab hanging ABOVE the ground, directly in the probe's path.
        const waterBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 1.5));
        world.createCollider(RAPIER2D.ColliderDesc.cuboid(10, 0.5).setSensor(true), waterBody);

        world.step(1 / 60); // the query pipeline is populated by stepping, as for every real caller
        const hit = world.raycast({ x: 0, y: 4 }, { x: 0, y: -1 }, 10);

        expect(hit.hasHit).toBe(true);
        // It must be the FLOOR (top face at y = 0.5), not the sensor at y = 2.0.
        expect(hit.hitPoint.y).toBeCloseTo(0.5, 1);
        expect(hit.hitCollider).toBe(ground);
        expect(hit.hitRigidBody?.handle).toBe(groundBody.handle);
        expect(hit.hitNormal.y).toBeCloseTo(1, 1); // upward floor normal
    });

    it('is blind to a sensor even when the sensor is the ONLY thing in the ray path', () => {
        // The other half of EXCLUDE_SENSORS. The replaced code rejected a sensor
        // hit after the fact, so this case looked identical; only the test above
        // separates them. Both are kept because a future "optimisation" that drops
        // the flag and restores the post-hoc check would pass one of them.
        const world = newWorld();
        const waterBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 1.5));
        world.createCollider(RAPIER2D.ColliderDesc.cuboid(10, 0.5).setSensor(true), waterBody);
        world.step(1 / 60);

        expect(world.raycast({ x: 0, y: 4 }, { x: 0, y: -1 }, 10).hasHit).toBe(false);
    });

    it('still honours the collision mask alongside the sensor flag', () => {
        // `filterFlags` and `filterGroups` are ADJACENT positional arguments of
        // castRayAndGetNormal(ray, maxToi, solid, filterFlags, filterGroups). Swap
        // them and nothing throws: the flags value (8) is read as an interaction
        // group with an empty filter half, so EVERY cast misses, and the sensor
        // exclusion is silently off. Exercising both a matching and a
        // non-matching mask against real geometry is what separates the two.
        const world = newWorld();
        const TERRAIN = 512;
        const PLAYER = 1;
        const groundBody = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 0));
        world.createCollider(
            // memberOf = TERRAIN, collidesWith = everything
            RAPIER2D.ColliderDesc.cuboid(10, 0.5).setCollisionGroups((0xFFFF << 16) | TERRAIN),
            groundBody,
        );
        world.step(1 / 60);

        const origin = { x: 0, y: 4 };
        const down = { x: 0, y: -1 };
        expect(world.raycast(origin, down, 10).hasHit).toBe(true);            // default mask 0xFFFF
        expect(world.raycast(origin, down, 10, TERRAIN).hasHit).toBe(true);   // mask names the group
        expect(world.raycast(origin, down, 10, PLAYER).hasHit).toBe(false);   // mask excludes it
    });
});

describe('getCharacterController', () => {
    it('is shared, and configured for voxel geometry without the 3D trimesh nudge', () => {
        const world = newWorld();
        const a = world.getCharacterController();
        const b = world.getCharacterController();
        expect(a).toBe(b); // one controller per world, as in the 3D twin
        expect(typeof a.computeColliderMovement).toBe('function');
        expect(typeof a.computedGrounded).toBe('function');
    });

    it('holds the capsule one skin width (0.08 m) off a wall', () => {
        // The controller's construction argument is its collide-and-slide offset,
        // and it is the only one of its settings that shows up as a measurable
        // distance. A future edit that "tidies" createCharacterController(0.08)
        // to the rapier default (0.01) or to the 3D-era 0.05 changes where every
        // 2D character stands relative to every wall — and that is what makes a
        // character look embedded in, or floating off, voxel geometry.
        const world = newWorld();
        const floor = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 0));
        world.createCollider(RAPIER2D.ColliderDesc.cuboid(20, 0.5), floor);
        const wall = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(8, 3));
        world.createCollider(RAPIER2D.ColliderDesc.cuboid(3, 3), wall); // left face at x = 5

        const body = world.createRigidBody(
            RAPIER2D.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1.1));
        const capsuleRadius = 0.2;
        const collider = world.createCollider(
            RAPIER2D.ColliderDesc.capsule(0.4, capsuleRadius), body);
        world.step(1 / 60);

        const controller = world.getCharacterController();
        for (let i = 0; i < 400; i++) {
            controller.computeColliderMovement(collider, { x: 0.05, y: -0.02 });
            const move = controller.computedMovement();
            const at = body.translation();
            body.setNextKinematicTranslation({ x: at.x + move.x, y: at.y + move.y });
            world.step(1 / 60);
        }

        const gap = 5 - (body.translation().x + capsuleRadius);
        expect(gap).toBeCloseTo(0.08, 2);
    });

    it('snaps a walker to the ground over a small down-step instead of leaving it airborne', () => {
        // enableSnapToGround(0.5). Rapier requires a downward component to
        // request ground adhesion (the movement system supplies gravity).
        // without the snap the controller reports NOT grounded on the far side, and
        // a platformer that gates jumping on `grounded` refuses to jump after every
        // curb until gravity catches up.
        const world = newWorld();
        const upper = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 0));
        world.createCollider(RAPIER2D.ColliderDesc.cuboid(4, 0.5), upper);   // top at y = 0.5, ends x = 4
        const lower = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(10, -0.3));
        world.createCollider(RAPIER2D.ColliderDesc.cuboid(6, 0.5), lower);   // top at y = 0.2

        const body = world.createRigidBody(
            RAPIER2D.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1.1));
        const collider = world.createCollider(RAPIER2D.ColliderDesc.capsule(0.4, 0.2), body);
        world.step(1 / 60);

        const controller = world.getCharacterController();
        let airborneFramesPastTheLip = 0;
        for (let i = 0; i < 200; i++) {
            controller.computeColliderMovement(collider, { x: 0.05, y: -0.001 });
            const move = controller.computedMovement();
            const at = body.translation();
            body.setNextKinematicTranslation({ x: at.x + move.x, y: at.y + move.y });
            world.step(1 / 60);
            if (body.translation().x > 5 && !controller.computedGrounded()) airborneFramesPastTheLip++;
        }

        expect(body.translation().x).toBeGreaterThan(5);   // it really did cross the step
        expect(airborneFramesPastTheLip).toBe(0);
        expect(body.translation().y).toBeLessThan(1.05);   // and it descended onto the lower slab
    });

    it('overwrites its results on every compute — the shared controller has no per-character memory', () => {
        // One controller serves every 2D character, exactly as in the 3D twin.
        // That is only safe because `computedMovement()` / `computedGrounded()`
        // describe the LAST compute and nothing else. A caller that computes for
        // character A, computes for B, then reads A's grounded flag gets B's
        // answer — so this pins the contract the sharing depends on.
        const world = newWorld();
        const floor = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(0, 0));
        world.createCollider(RAPIER2D.ColliderDesc.cuboid(20, 0.5), floor);

        const standingBody = world.createRigidBody(
            RAPIER2D.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1.1));
        const standing = world.createCollider(RAPIER2D.ColliderDesc.capsule(0.4, 0.2), standingBody);
        const airborneBody = world.createRigidBody(
            RAPIER2D.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 30));
        const airborne = world.createCollider(RAPIER2D.ColliderDesc.capsule(0.4, 0.2), airborneBody);
        world.step(1 / 60);

        const controller = world.getCharacterController();

        controller.computeColliderMovement(standing, { x: 0, y: -0.5 });
        expect(controller.computedGrounded()).toBe(true);
        expect(controller.computedMovement().y).toBeGreaterThan(-0.5); // blocked by the floor

        controller.computeColliderMovement(airborne, { x: 0, y: -0.5 });
        expect(controller.computedGrounded()).toBe(false);
        expect(controller.computedMovement().y).toBeCloseTo(-0.5, 5);  // nothing in the way

        // Re-computing for the first character restores its answer verbatim: no
        // state carried over from the second.
        controller.computeColliderMovement(standing, { x: 0, y: -0.5 });
        expect(controller.computedGrounded()).toBe(true);
    });
});
