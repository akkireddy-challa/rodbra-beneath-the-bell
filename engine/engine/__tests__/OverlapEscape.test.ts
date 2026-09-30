/**
 * A body already inside the player's capsule must never keep the player in.
 *
 * The collide-and-slide motor treats NPCs as solid; NPCs are not blocked by the
 * player, so one can walk INTO the capsule. Rapier's KCC then refuses movement
 * in every direction (proved below) — the motor excludes overlapping bodies
 * from its solve, and this test proves that exclusion frees the move.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { movesAwayFrom } from 'engine/physics/TrappedBodies.js';

const RADIUS = 0.4;
const HALF = 0.5;

function capsule(pw: PhysicsWorld, x: number, group: number, mask: number): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const body = pw.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 1, 0));
    const collider = pw.createCollider(
        RAPIER.ColliderDesc.capsule(HALF, RADIUS).setCollisionGroups(makeCollisionGroups(group, mask)),
        body,
    );
    return { body, collider };
}

describe('overlap escape', () => {
    let pw: PhysicsWorld;
    beforeAll(async () => { await initRapier(); });
    beforeEach(() => { pw = new PhysicsWorld(); });

    it('reports the bodies overlapping the capsule, and only those', () => {
        const player = capsule(pw, 0, CollisionGroup.PLAYER, CollisionMask.PLAYER);
        const inside = capsule(pw, 0.3, CollisionGroup.ENEMY, CollisionMask.ENEMY);     // 0.3 m apart: 0.8 m of capsule
        const clear = capsule(pw, 3, CollisionGroup.ENEMY, CollisionMask.ENEMY);
        pw.step(1 / 60);
        const t = player.body.translation();
        const out = pw.overlappingColliderHandles(t, RADIUS, HALF, CollisionGroup.ENEMY | CollisionGroup.ANIMAL, new Set());
        expect(out.has(inside.collider.handle)).toBe(true);
        expect(out.has(clear.collider.handle)).toBe(false);
        expect(out.has(player.collider.handle)).toBe(false);     // the mask never includes the player itself
    });

    it('an enemy inside the capsule stays solid for a move into it, and is ignored for a move away', () => {
        const player = capsule(pw, 0, CollisionGroup.PLAYER, CollisionMask.PLAYER);
        const enemy = capsule(pw, 0.3, CollisionGroup.ENEMY, CollisionMask.ENEMY);
        pw.step(1 / 60);
        const kcc = pw.getCharacterController();
        const kccFilter = player.collider.collisionGroups()
            | ((CollisionGroup.DYNAMIC_PROP | CollisionGroup.ENEMY | CollisionGroup.ANIMAL) << 16);
        const solve = (pred: (c: RAPIER.Collider) => boolean): { x: number; z: number } => {
            kcc.computeColliderMovement(player.collider, { x: 0.08, y: 0, z: 0 }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, kccFilter, pred);
            const m = kcc.computedMovement();
            return { x: m.x, z: m.z };
        };
        // Walking deeper into the overlapping enemy (+X): the solver refuses. Away
        // from ONE body it would allow — but a ring of attackers makes every
        // direction "deeper into someone", which is the trap this fixes.
        const stuck = solve((c) => c.handle !== player.collider.handle);
        expect(Math.abs(stuck.x)).toBeLessThan(0.02);
        // The motor's rule: a body already inside the capsule is ignored for a move AWAY from it.
        const trapped = pw.overlappingColliderHandles(player.body.translation(), RADIUS, HALF, CollisionGroup.ENEMY | CollisionGroup.ANIMAL, new Set());
        expect(trapped.has(enemy.collider.handle)).toBe(true);
        const self = player.body.translation();
        const rule = (move: { x: number; z: number }) => (c: RAPIER.Collider) =>
            c.handle !== player.collider.handle && !(trapped.has(c.handle) && movesAwayFrom(move, self, c.translation()));
        // Into it: still solid, even though it is inside the capsule.
        kcc.computeColliderMovement(player.collider, { x: 0.08, y: 0, z: 0 }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, kccFilter, rule({ x: 0.08, z: 0 }));
        expect(Math.abs(kcc.computedMovement().x)).toBeLessThan(0.02);
        // Away from it: the move goes through in full.
        kcc.computeColliderMovement(player.collider, { x: -0.08, y: 0, z: 0 }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, kccFilter, rule({ x: -0.08, z: 0 }));
        expect(kcc.computedMovement().x).toBeCloseTo(-0.08, 3);
    });
});
