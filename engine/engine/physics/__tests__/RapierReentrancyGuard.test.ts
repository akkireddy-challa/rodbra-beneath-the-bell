/** @jest-environment jsdom */
/**
 * The guard that names a re-entrant rapier call before it poisons the world.
 *
 * Reading code found two real instances of this hazard and still missed the one that ends
 * a race, because the offending call can live in game code, a genre template, or a
 * callback frames away from where rapier finally complains. The error rapier gives is
 * identical for the call that caused the damage and for the hundreds that follow it, so a
 * log shows only wreckage.
 *
 * What is pinned here is the part that would quietly stop working: reporting exactly ONCE
 * (the first re-entrant call is the bug; the rest are consequences), restoring depth when
 * the wrapped call throws (or one exception would leave the guard convinced it is forever
 * inside a call), and staying off by default.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { guardEnabled } from 'engine/physics/RapierReentrancyGuard.js';

/**
 * The guard's probe logic, mirrored here so it can be tested without a WASM world.
 * `installRapierReentrancyGuard` applies exactly this to rapier's prototypes.
 *
 * `borrowOk` stands in for the real probe: rapier throws "recursive use" from every call
 * once the borrow is wedged.
 */
function makeGuard(borrowOk: () => boolean) {
    let depth = 0;
    let reported = 0;
    let culprit = '';
    const wrap = <T>(label: string, fn: () => T) => (): T => {
        depth++;
        try {
            return fn();
        } finally {
            depth--;
            if (depth === 0 && reported === 0 && !borrowOk()) { reported = 1; culprit = label; }
        }
    };
    return { wrap, depth: () => depth, reports: () => reported, culprit: () => culprit };
}

describe('the probe crosses into WASM', () => {
    // The guard is only as good as its probe. A first attempt used
    // `world.getRigidBody(h)`, which rapier implements as `{ return this.bodies.get(h) }` —
    // a lookup in its JS-side coarena that never enters WASM. It reported nothing while
    // physics died in front of it, because a wedged borrow is invisible to code that never
    // takes one. `colliders.len()` compiles to `rawcolliderset_len(this.__wbg_ptr)`.
    const src = readFileSync(join(__dirname, '..', 'RapierReentrancyGuard.ts'), 'utf8');
    const probeFn = src.slice(src.indexOf('function checkBorrow'), src.indexOf('\n}', src.indexOf('function checkBorrow')));

    it('probes through a call that borrows the same objects the failures report', () => {
        // castRay resolves to queryPipeline.castRay(bodies, colliders, …) — the trio that
        // updateVehicle and world.step() also borrow. A probe touching fewer objects cannot
        // see a wedge in the ones it skips: borrow checking is PER OBJECT.
        expect(probeFn).toContain('rawCastRay.call');
    });

    it('does not probe with a JS-side coarena lookup', () => {
        // `world.getRigidBody(h)` is `{ return this.bodies.get(h) }` — never enters WASM.
        expect(probeFn).not.toContain('getRigidBody');
        expect(probeFn).not.toContain('bodies.get');
    });

    it('does not probe with a call that borrows only one set', () => {
        // colliders.len() crosses into WASM but borrows just the ColliderSet, which stayed
        // healthy through a wedge — a true WASM call and still blind to it.
        expect(probeFn).not.toContain('colliders.len()');
    });

    it('uses the UNWRAPPED castRay and cannot probe itself', () => {
        // The probe is a rapier call, so without both of these each probe would trigger a
        // probe on its own way out.
        const install = src.slice(src.indexOf('export function installRapierReentrancyGuard'));
        expect(install).toContain('rawCastRay =');
        expect(probeFn).toContain('probing');
    });
});

describe('rapier re-entrancy guard', () => {
    it('is off unless explicitly asked for', () => {
        // It costs a counter on every rapier call, and a physics step makes hundreds per
        // frame. Nobody should pay that by default.
        expect(guardEnabled()).toBe(false);
    });

    it('stays quiet while the borrow is healthy, however deeply calls nest', () => {
        // Nesting alone means nothing: two guesses about which rapier methods hold a
        // borrow across a callback produced two false reports on perfectly safe code
        // (removeVehicleController -> free, and forEachRigidBody -> isFixed).
        let ok = true;
        const g = makeGuard(() => ok);
        const inner = g.wrap('World.createCollider', () => 1);
        const outer = g.wrap('World.forEachRigidBody', () => { inner(); inner(); });
        outer();
        expect(g.reports()).toBe(0);
        expect(ok).toBe(true);
    });

    it('names the call after which the borrow stopped working', () => {
        let ok = true;
        const g = makeGuard(() => ok);
        g.wrap('World.castRay', () => 1)();
        g.wrap('World.contactPair', () => { ok = false; })();
        expect(g.reports()).toBe(1);
        expect(g.culprit()).toBe('World.contactPair');
    });

    it('probes only at the outermost level', () => {
        // A nested call cannot have released a borrow its caller still holds, so probing
        // inside one would blame whichever inner call happened to run first.
        let ok = true;
        const g = makeGuard(() => ok);
        const inner = g.wrap('Collider.shape', () => { ok = false; });
        g.wrap('World.contactPair', () => inner())();
        expect(g.culprit()).toBe('World.contactPair');
    });

    it('reports only once', () => {
        // Once wedged, every later call fails the probe too. Reporting each would bury the
        // one line that matters under the flood it caused.
        let ok = true;
        const g = makeGuard(() => ok);
        g.wrap('World.step', () => { ok = false; })();
        g.wrap('World.castRay', () => 1)();
        g.wrap('World.castRay', () => 1)();
        expect(g.reports()).toBe(1);
    });

    it('restores depth when a wrapped call throws', () => {
        // Without the finally, one thrown physics error would leave depth above zero and
        // the probe would never run again — the guard would go silent exactly when needed.
        let ok = true;
        const g = makeGuard(() => ok);
        const boom = g.wrap('World.step', () => { throw new Error('step failed'); });
        expect(() => boom()).toThrow('step failed');
        expect(g.depth()).toBe(0);
        g.wrap('World.castRay', () => { ok = false; })();
        expect(g.reports()).toBe(1);
    });
});
