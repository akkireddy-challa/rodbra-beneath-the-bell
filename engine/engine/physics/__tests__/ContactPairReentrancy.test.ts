/**
 * Nothing may call back into rapier from inside a `contactPair` callback.
 *
 * `world.contactPair(a, b, cb)` holds a borrow of the rapier world for the whole of `cb`.
 * Any rapier accessor used in there — `collider.shape` was the one — takes that borrow a
 * second time, and rapier's guard aborts with "recursive use of an object detected which
 * would lead to unsafe aliasing in rust". That is a panic=abort: the RefCell guard's Drop
 * never runs, so the borrow stays locked and EVERY later rapier call in the session
 * throws. There is no recovery short of a page reload.
 *
 * Observed in the field: six vehicles disabling themselves within one frame, then
 * `world.step()` halting physics permanently, 26 seconds into a race. None of those
 * messages named the cause — they were all downstream of a panic that logged nothing.
 *
 * It hid for so long because the offending branch needs a near-zero contact normal, which
 * in practice means a trimesh edge hit. Common enough to occur in a race, rare enough to
 * look random. The trimesh is the terrain, so every game on a baked world was exposed.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '..', 'PhysicsWorld.ts'), 'utf8');

/** The body of the `contactPair` callback, which is the borrow-held window. */
function contactPairCallbackBody(): string {
    const start = source.indexOf('this.world.contactPair(');
    expect(start).toBeGreaterThan(-1);
    // Balance braces from the callback's opening `{` to its close.
    const open = source.indexOf('{', source.indexOf('=>', start));
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error('unbalanced contactPair callback');
}

describe('contactPair callback re-entrancy', () => {
    it('reads no rapier collider/world state inside the borrow', () => {
        const body = contactPairCallbackBody();
        // `manifold` is handed to the callback by rapier and is safe to read; anything
        // reaching back through a collider, a body or the world is not.
        const forbidden = [
            'collider1.', 'collider2.', '.shape', 'this.world.',
            'body1.', 'body2.', '.parent()', 'getCollider', 'getRigidBody',
        ];
        const found = forbidden.filter((f) => body.includes(f));
        expect(found).toEqual([]);
    });

    it('still computes the fallback normal, just outside the callback', () => {
        // The guard must not be satisfiable by deleting the feature: the degenerate-normal
        // path exists because a trimesh edge hit reports no usable normal, and without it
        // vehicles take contact responses in an arbitrary direction.
        expect(source).toContain('degenerateNormal');
        const after = source.slice(source.indexOf('this.world.contactPair('));
        expect(after).toContain('isGeometricNormal = true');
        // The shape read must live after the callback closes, not within it.
        expect(contactPairCallbackBody()).not.toContain('isGeometricNormal');
    });

    it('captures the subshape indices, which are only available from the manifold', () => {
        // These come off the manifold and are the reason the fallback cannot simply be
        // moved wholesale — the indices must be read inside, the geometry outside.
        const body = contactPairCallbackBody();
        expect(body).toContain('subshape1()');
        expect(body).toContain('subshape2()');
    });
});

/**
 * The same hazard through the other rapier callback that game code actually uses.
 *
 * `forEachActiveRigidBody` holds a borrow for its whole iteration. The pristine-dynamic
 * wake sweep called `promote()` from inside it, which creates a collider — a mutation of
 * the world being iterated. That poisoned the borrow permanently: every later rapier call
 * threw, all six vehicles disabled themselves, and physics halted. It fired only when a
 * prop was struck hard enough to wake, so it surfaced a minute into a race and looked
 * random.
 *
 * The fix is in the WRAPPER rather than the caller, because a caller cannot reasonably
 * know which of its transitive calls reach rapier.
 */
describe('forEachActiveRigidBody re-entrancy', () => {
    const physicsWorld = readFileSync(join(__dirname, '..', 'PhysicsWorld.ts'), 'utf8');

    it('iterates a snapshot, so a caller may mutate the world from its callback', () => {
        const start = physicsWorld.indexOf('forEachActiveRigidBody(f:');
        expect(start).toBeGreaterThan(-1);
        const body = physicsWorld.slice(start, physicsWorld.indexOf('\n    }', start));
        // The rapier callback must do nothing but collect.
        expect(body).toContain('active.push(body)');
        // And the caller's function must run outside it.
        expect(body).toMatch(/for \(const body of active\) f\(body\)/);
    });

    it('does not hand the caller function straight to rapier', () => {
        // The original one-liner — passing `f` through — is what made every caller a
        // potential session-ender.
        const start = physicsWorld.indexOf('forEachActiveRigidBody(f:');
        const body = physicsWorld.slice(start, physicsWorld.indexOf('\n    }', start));
        expect(body).not.toContain('this.world.forEachActiveRigidBody(f)');
    });
});

/**
 * Bodies are made finite before anything raycasts them.
 *
 * The sanitize scan used to run AFTER the pre-step callbacks. Those callbacks include each
 * vehicle's `updateVehicle`, which raycasts the world — and a raycast meeting a body whose
 * AABB went non-finite on the previous step aborts inside WASM. `panic=abort` means the
 * borrow guard's Drop never runs, so the borrow stays locked, every later rapier call
 * throws "recursive use of an object detected", and physics halts for the session.
 *
 * No JS re-entrancy is involved, which is why a guard watching call nesting reported
 * nothing before it — and why this ordering has to be asserted rather than assumed.
 */
describe('substep ordering', () => {
    const src = readFileSync(join(__dirname, '..', 'PhysicsWorld.ts'), 'utf8');
    const substep = src.slice(src.indexOf('private runSubstep('), src.indexOf('quarantineNonFiniteBodies(): void'));

    it('sanitizes before running pre-step callbacks', () => {
        const sanitize = substep.indexOf('this.quarantineSanitizePass()');
        const callbacks = substep.indexOf('for (const callback of this.preStepCallbacks)');
        expect(sanitize).toBeGreaterThan(-1);
        expect(callbacks).toBeGreaterThan(-1);
        expect(sanitize).toBeLessThan(callbacks);
    });

    it('still removes quarantined bodies after those callbacks, not before', () => {
        // Removal invalidates the QueryPipeline that the wheel raycasts query, so this half
        // must NOT be hoisted along with the sanitize half.
        const callbacks = substep.indexOf('for (const callback of this.preStepCallbacks)');
        const remove = substep.indexOf('this.quarantineRemovePending()');
        expect(remove).toBeGreaterThan(callbacks);
        expect(remove).toBeLessThan(substep.indexOf('this.world.step('));
    });
});

/**
 * Colliders are only ever created immediately before a step.
 *
 * Rapier 0.19 maintains its query BVH inside `world.step()` and exposes no way to rebuild
 * it — 0.12's `queryPipeline` / `updateSceneQueries()` are gone, so "just refresh it after
 * changing colliders" is not available. The only remedy is to leave no gap: a collider
 * created between two steps is invisible to scene queries until the next one, and a raycast
 * in that window walks a BVH that no longer matches the collider set and panics INSIDE
 * WASM. `panic=abort` leaves the borrow locked, so every rapier call afterwards throws and
 * physics is finished for the session.
 *
 * Found by clipping a traffic cone: the cone is a pristine dynamic prop, the contact wakes
 * it, the sweep promotes it (swapping its coarse box for an exact cuboid set), and the next
 * thing to raycast is `updateVehicle` in the following substep. Two or three times a lap.
 */
describe('collider creation window', () => {
    const src = readFileSync(join(__dirname, '..', 'PhysicsWorld.ts'), 'utf8');
    const substep = src.slice(src.indexOf('private runSubstep('), src.indexOf('quarantineNonFiniteBodies(): void'));

    it('runs pre-solve callbacks immediately before the step', () => {
        const preSolve = substep.indexOf('this.preSolveCallbacks');
        const step = substep.indexOf('this.world.step(');
        expect(preSolve).toBeGreaterThan(-1);
        expect(preSolve).toBeLessThan(step);
        // Nothing may query the world between them.
        expect(substep.slice(preSolve, step)).not.toContain('castRay');
    });

    it('keeps pre-solve AFTER the pre-step callbacks that raycast', () => {
        // Wheel raycasts live in the pre-step callbacks. A collider created before them
        // would sit in exactly the window this exists to close.
        expect(substep.indexOf('for (const callback of this.preStepCallbacks)'))
            .toBeLessThan(substep.indexOf('this.preSolveCallbacks'));
    });

    it('still flushes queued removals after the raycasting callbacks', () => {
        // Removals were always safe — queued, then flushed once nothing is mid-query. An
        // earlier attempt hoisted this above the callbacks, which reopened the same window
        // from the other side.
        const removals = substep.indexOf('this.processPendingRemovals()');
        expect(removals).toBeGreaterThan(substep.indexOf('for (const callback of this.preStepCallbacks)'));
        expect(removals).toBeLessThan(substep.indexOf('this.world.step('));
    });
});
