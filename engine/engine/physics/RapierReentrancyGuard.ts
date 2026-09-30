/**
 * Names the call that re-enters rapier, at the moment it happens — `?physicsguard=1`.
 *
 * Rapier's own error tells you nothing useful. Calling into the WASM world while it is
 * already borrowed throws "recursive use of an object detected which would lead to unsafe
 * aliasing in rust", and because that unwinds out through WASM the borrow is never
 * released. From then on EVERY rapier call in the session throws the same message. What
 * you see in a log is the wreckage — six vehicles disabling themselves, then `world.step()`
 * halting physics — all of it downstream of one call that logged nothing.
 *
 * Three rounds of reading code found two real instances of this (`contactPair` reading
 * `collider.shape`, and the pristine-dynamic wake sweep creating a collider inside
 * `forEachActiveRigidBody`) and still did not find the one that kills a race. Reading is
 * the wrong tool: the offending call may be in game code, in a genre template, or in a
 * callback three frames removed from where the error finally surfaces.
 *
 * So this wraps rapier's own methods and watches the nesting. When a rapier call begins
 * while another is still on the stack, it logs the OUTER call, the INNER call and a full
 * stack — before making the call that would poison the world. The first line of that
 * report is the bug.
 *
 * Off unless asked for: every wrapped call costs a counter increment, which is not free on
 * a physics step that runs hundreds of them per frame.
 */
import RAPIER from '@dimforge/rapier3d-compat';

// Guessing which rapier methods hold a WASM borrow across a JS callback does not work.
// Two guesses produced two false reports: `World.removeVehicleController()` calling
// `controller.free()` is rapier composing its own JS, and `forEachRigidBody` iterates a
// JS-side coarena and borrows nothing. Both looked exactly like the real thing.
//
// So the borrow is MEASURED instead. After every top-level rapier call a probe runs: if it
// throws "recursive use", the borrow is now wedged and the call that just returned is what
// wedged it. No list, no assumptions — the first failing probe names the culprit.
let depth = 0;
let outerCall = '';
let reported = false;
let installed = false;
/** A live world to probe, captured the first time any World method runs. */
let probeTarget: unknown = null;
/** `World.castRay`, captured BEFORE wrapping so the probe is not itself instrumented. */
let rawCastRay: ((...args: unknown[]) => unknown) | null = null;
let probeRay: unknown = null;
/**
 * A live vehicle controller and its UNWRAPPED `numWheels`, probed alongside the raycast.
 *
 * Borrow checking is per object, and the evidence points here: `updateVehicle` throws first
 * — in a pre-step callback, before `step()` runs — while a castRay probe covering the query
 * pipeline, body set and collider set passes. The one object `updateVehicle` borrows that
 * castRay does not is the vehicle controller set. (`step()` failing afterwards needs no
 * separate cause: six `disableVehicle` calls mutate the world in between.)
 *
 * `numWheels()` is `{ return this.raw.num_wheels() }` — a genuine crossing, unlike the
 * JS-side lookups that made two earlier probes blind.
 */
let probeVehicle: unknown = null;
let rawNumWheels: ((this: unknown) => unknown) | null = null;
/** Stops the probe probing itself — a raycast is a rapier call like any other. */
let probing = false;

/**
 * The last N rapier calls, newest last. Dumped when the borrow is found wedged.
 *
 * This is the diagnostic that does not depend on guessing right. A probe only sees a wedge
 * in the objects it happens to borrow, and three probes in a row were blind to this one for
 * three different reasons. The trail is indifferent: whatever sequence preceded the damage
 * is in it, including calls on types whose borrow state no probe can reach.
 *
 * A pre-filled array overwritten in place — no allocation per call, because this runs on
 * every rapier call in a physics step.
 */
const TRAIL_SIZE = 64;
const trail: string[] = new Array<string>(TRAIL_SIZE).fill('');
let trailAt = 0;

function recordCall(label: string, nesting: number): void {
    trail[trailAt] = nesting > 0 ? `  ${'·'.repeat(nesting)} ${label}` : label;
    trailAt = (trailAt + 1) % TRAIL_SIZE;
}

/** The trail in chronological order, oldest first. */
function trailLines(): string {
    const out: string[] = [];
    for (let i = 0; i < TRAIL_SIZE; i++) {
        const entry = trail[(trailAt + i) % TRAIL_SIZE];
        if (entry) out.push(entry);
    }
    return out.join('\n');
}

/** `?physicsguard=1` — read once; re-parsing per call would swamp what it measures. */
export function guardEnabled(): boolean {
    try {
        return new URLSearchParams(window.location.search).get('physicsguard') === '1';
    } catch {
        return false; // no window (tests, workers)
    }
}

/**
 * Wrap every function on `proto`, tracking nesting depth.
 *
 * `label` names the class in the report. Methods are wrapped in place, so this must run
 * before any world is built — the prototypes are shared by every instance.
 */
function wrapPrototype(proto: object, label: string): void {
    for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        // Getters are accessors over WASM memory and count as calls too, but wrapping them
        // changes property semantics; only methods are wrapped here.
        if (!desc || typeof desc.value !== 'function' || desc.get) continue;
        const original = desc.value as (...args: unknown[]) => unknown;
        Object.defineProperty(proto, name, {
            ...desc,
            value: function guarded(this: unknown, ...args: unknown[]): unknown {
                const here = `${label}.${name}()`;
                if (label === 'World' && probeTarget === null) probeTarget = this;
                if (label === 'DynamicRayCastVehicleController' && probeVehicle === null) {
                    probeVehicle = this;
                }
                if (!probing) recordCall(here, depth);
                const previousOuter = outerCall;
                if (depth === 0) outerCall = here;
                depth++;
                try {
                    return original.apply(this, args);
                } finally {
                    depth--;
                    outerCall = previousOuter;
                    // Probe only at the OUTERMOST level: a nested call cannot have released
                    // a borrow its caller still holds, so probing there blames the caller.
                    if (depth === 0 && !reported) checkBorrow(here);
                }
            },
        });
    }
}

/**
 * Is the borrow still usable? The first call after which it is not IS the bug.
 *
 * The probe is a zero-length raycast, and getting there took three attempts. wasm-bindgen's
 * borrow check is PER OBJECT, so a probe only sees a wedge in the objects it borrows:
 *
 *  - `world.getRigidBody(h)` is `{ return this.bodies.get(h) }` — a JS-side coarena lookup
 *    that never enters WASM at all. It reported nothing while physics died in front of it.
 *  - `colliders.len()` does cross into WASM (`rawcolliderset_len`) but borrows only the
 *    ColliderSet, which stayed healthy while something else was wedged. Silent again, for a
 *    completely different reason.
 *  - `castRay` resolves to `queryPipeline.castRay(bodies, colliders, …)` and borrows all
 *    three — the same objects `updateVehicle` and `world.step()` use, which are the calls
 *    that report the damage.
 */
function checkBorrow(justFinished: string): void {
    if (!rawCastRay || probeTarget === null || probing) return;
    probing = true;
    try {
        rawCastRay.call(probeTarget, probeRay, 0.001, true);
        // Second object, separately borrowed — see probeVehicle. A pass on the raycast says
        // nothing about this one.
        if (rawNumWheels && probeVehicle !== null) rawNumWheels.call(probeVehicle);
    } catch (err) {
        reported = true;
        console.error(
            `[RapierReentrancyGuard] THE BORROW IS NOW WEDGED — this call did it.\n` +
            `  culprit: ${justFinished}\n` +
            `  probe says: ${err instanceof Error ? err.message : String(err)}\n` +
            `Everything after this point throws the same error and is only a consequence.\n` +
            `\nLast ${TRAIL_SIZE} rapier calls (oldest first, indented = nested):\n${trailLines()}`,
            new Error('borrow wedged here').stack,
        );
    } finally {
        probing = false;
    }
}

/**
 * Install the guard. Safe to call repeatedly; only the first call wraps.
 *
 * Covers the world (every query, mutation and the step itself) and the vehicle controller,
 * because `updateVehicle` is where the poisoned borrow usually surfaces — it runs early in
 * a substep and touches the query pipeline, so it is the first call to notice damage done
 * by something else entirely.
 */
/**
 * Re-arm after a recovery, so a second wedge in the same race is reported too. Several
 * samples from one session is the whole reason recovering beats halting.
 */
export function rearmBorrowReporting(): void {
    reported = false;
}

export function installRapierReentrancyGuard(): void {
    if (installed || !guardEnabled()) return;
    installed = true;
    // Every type whose methods reach WASM. Colliders and bodies matter most: reading
    // `collider.shape` inside a `contactPair` callback was a real instance of this bug, and
    // wrapping only World would never have seen it.
    // Captured before wrapping: the probe must not be instrumented, or every probe would
    // probe itself on the way out.
    rawCastRay = (RAPIER.World.prototype as unknown as Record<string, unknown>).castRay as
        (...args: unknown[]) => unknown;
    probeRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const vehicleProto = (RAPIER as unknown as Record<string, { prototype?: Record<string, unknown> } | undefined>)
        .DynamicRayCastVehicleController?.prototype;
    rawNumWheels = (vehicleProto?.numWheels as ((this: unknown) => unknown) | undefined) ?? null;

    const byName = RAPIER as unknown as Record<string, { prototype?: object } | undefined>;
    for (const name of [
        'World', 'Collider', 'RigidBody', 'QueryPipeline', 'EventQueue',
        'RigidBodySet', 'ColliderSet', 'IslandManager', 'NarrowPhase', 'BroadPhase',
        'DynamicRayCastVehicleController', 'KinematicCharacterController',
    ]) {
        const proto = byName[name]?.prototype;
        if (proto) wrapPrototype(proto, name);
    }
    console.warn('[RapierReentrancyGuard] armed — the first re-entrant rapier call will be reported');
}
