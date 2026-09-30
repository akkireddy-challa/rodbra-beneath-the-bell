import type { Vehicle } from 'engine/Vehicle.js';
import {
    boxFootprint,
    footprintSeparation,
    verticalOverlap,
    type BoxFootprint,
} from 'engine/physics/chassisFootprint.js';

/**
 * Configuration for {@link VehicleUnstuckSystem}.
 *
 * The absolute values are tuned for a ~3.4 m car and scaled per pair by actual
 * chassis size, so karts and trucks behave the same.
 */
export interface VehicleUnstuckOptions {
    /**
     * BROAD-PHASE ONLY: extra margin (m) added to the two chassis radii before
     * the exact box-vs-box test runs. Pairs farther apart than that are skipped
     * outright. It is NOT a contact threshold — contact is decided by real
     * chassis geometry (see `contactSlop`), never by centre distance.
     */
    contactDistance: number;
    /**
     * Required growth in the real chassis-to-chassis gap over the contact
     * window (m). If two touching cars have not opened up by at least this
     * much after `contactDuration`, they are not working themselves free.
     */
    minSeparationGain: number;
    /** How long the pair must stay in continuous contact before intervening (seconds). */
    contactDuration: number;
    /**
     * @deprecated Ignored since the sensor trick was removed. Flipping a chassis
     * to sensor mode disabled ALL of its contacts, not just car-to-car: for the
     * duration a car could pass through walls and track furniture.
     */
    disableDuration: number;
    /**
     * Cap on the RELATIVE separation speed after a nudge (m/s). The system tops
     * the pair up to this and no further — a pair already moving apart faster
     * gets no impulse at all, so a nudge can never add energy to a race. Each
     * car takes half of any shortfall, mass-scaled, so a 1700 kg sedan and a
     * 300 kg kart part at the same rate.
     */
    bumpSpeed: number;
    /**
     * Cap on the de-penetration teleport per car (m). The cars are only ever
     * moved by the depth they actually overlap (split between them, plus a
     * millimetre), so a light touch resolves with a millimetre of correction;
     * this only bounds the pathological case.
     */
    bumpTeleport: number;
    /** Per-pair throttle: don't nudge the same pair again until this many ms have elapsed. */
    cooldownMs: number;
    /** Log to console.warn when a nudge fires. Useful while tuning; turn off in production. */
    debugLog: boolean;
    /**
     * @deprecated Ignored. Gating on ABSOLUTE speed was wrong: a welded pair
     * moving at racing speed in lockstep — precisely the case players report as
     * "AI cars driving around stuck in pairs" — never dropped below the gate,
     * so the one system meant to split them refused to look at them. Stuckness
     * is a property of the pair's RELATIVE motion; see `maxLockstepSpeed`.
     */
    maxStuckSpeed?: number;
    /**
     * Cars in contact whose RELATIVE XZ velocity stays below this (m/s) are
     * moving in lockstep — welded, whatever their absolute speed. Cars
     * genuinely racing each other always have relative motion: a pass opens
     * the gap, an approach closes it. Size-scaled like the other thresholds.
     */
    maxLockstepSpeed?: number;
    /** Chassis gap at or below which the pair counts as touching (m). */
    contactSlop?: number;
    /**
     * Fired after a stuck pair is separated (detected or via `bumpPair`).
     * `RacingSetup` uses it to tell the ramming car's AI to lift for a moment
     * so the pair doesn't immediately re-weld; game code can add effects
     * (sparks, a scrape sound) or scoring.
     */
    onSeparated?: (event: VehicleSeparationEvent) => void;
}

/** Payload of {@link VehicleUnstuckOptions.onSeparated}. */
export interface VehicleSeparationEvent {
    vehicleA: Vehicle;
    vehicleB: Vehicle;
    /** Unit XZ direction `vehicleA` was pushed (B got the opposite). */
    nx: number;
    nz: number;
}

export const DEFAULT_VEHICLE_UNSTUCK_OPTIONS: VehicleUnstuckOptions = {
    contactDistance: 1.0,
    minSeparationGain: 0.15,
    contactDuration: 1.2,
    disableDuration: 0,
    bumpSpeed: 1.5,
    bumpTeleport: 0.15,
    cooldownMs: 1000,
    debugLog: false,
    maxLockstepSpeed: 1.5,
    contactSlop: 0.05,
};

/** Applied on top of the measured overlap so the boxes end up strictly apart. */
const DEPENETRATION_EPSILON = 0.002;

interface PairState {
    contactTime: number;        // seconds in current contact window
    cooldownRemainingMs: number;
    /** Real chassis gap at the start of the current contact window (m). */
    gapAtWindowStart: number;
    /** False until the first tick of a window has snapshotted the gap. */
    windowOpen: boolean;
}

/**
 * Frees vehicles that have genuinely locked together — the race-start grid
 * stacking up, or one car wedged under another's bumper after a low-speed
 * shunt. The Rapier solver can leave two boxes pressed into each other for
 * tens of seconds, which players read as cars being "glued".
 *
 * Detection is deliberately narrow, because a false positive is far worse than
 * a missed jam. All four must hold:
 *   1. the chassis boxes are genuinely touching (exact oriented-box test in XZ
 *      plus a vertical-span overlap — never a centre-distance guess),
 *   2. the pair is moving in LOCKSTEP (`maxLockstepSpeed`) — near-zero relative
 *      velocity, whatever the absolute speed. A rear-end shunt welds two cars
 *      into a train that can be doing full racing speed; cars genuinely racing
 *      each other always have relative motion,
 *   3. at least one of them is on the throttle, so there is something to free,
 *   4. it has stayed that way for `contactDuration` without the gap opening by
 *      `minSeparationGain`.
 *
 * The response is the smallest thing that works: de-penetrate by the depth
 * they actually overlap along the true contact normal, then top the pair up to
 * `bumpSpeed` of relative separation — and only if they aren't already parting
 * that fast. Nothing here can launch a car; the correction is centimetres and
 * the velocity change is a walking pace.
 *
 * @example
 *     const unstuck = new VehicleUnstuckSystem({ ...DEFAULT_VEHICLE_UNSTUCK_OPTIONS });
 *     for (const vehicle of allRacers) unstuck.register(vehicle);
 *     // in update loop:
 *     unstuck.update(deltaTime);
 */
export class VehicleUnstuckSystem {
    /** Car length the absolute defaults in DEFAULT_VEHICLE_UNSTUCK_OPTIONS are tuned for (m). */
    private static readonly REFERENCE_FOOTPRINT = 3.4;
    private options: VehicleUnstuckOptions;
    private vehicles: Set<Vehicle> = new Set();
    private pairs: Map<string, PairState> = new Map();
    private enabled = true;

    constructor(options: VehicleUnstuckOptions) {
        this.options = options;
    }

    register(vehicle: Vehicle): void {
        this.vehicles.add(vehicle);
    }

    unregister(vehicle: Vehicle): void {
        this.vehicles.delete(vehicle);
        // Drop any pair state involving this vehicle so re-registering a fresh
        // vehicle doesn't inherit stale contact times.
        const handle = vehicle.getChassisBody()?.handle;
        if (handle === undefined) return;
        const stale: string[] = [];
        for (const key of this.pairs.keys()) {
            if (key.startsWith(`${handle}-`) || key.endsWith(`-${handle}`)) {
                stale.push(key);
            }
        }
        for (const k of stale) this.pairs.delete(k);
    }

    /**
     * Suspend intervention while the game deliberately holds cars against each
     * other — above all a start-line countdown on a tight grid. Contact windows
     * are dropped so the clock starts fresh on re-enable.
     */
    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        this.pairs.clear();
    }

    update(deltaTime: number): void {
        // Decay per-pair cooldowns even while disabled, so a pair whose cooldown
        // expired during a countdown is eligible the moment racing resumes.
        const decayMs = deltaTime * 1000;
        for (const state of this.pairs.values()) {
            if (state.cooldownRemainingMs > 0) {
                state.cooldownRemainingMs = Math.max(0, state.cooldownRemainingMs - decayMs);
            }
        }

        if (!this.enabled) return;
        if (this.vehicles.size < 2) return;
        const arr = Array.from(this.vehicles);
        for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
                this.processPair(arr[i]!, arr[j]!, deltaTime);
            }
        }
    }

    /**
     * Force-separate a specific pair right now, for manual recovery triggers
     * (a "reset" button). Skips detection and the cooldown; the correction
     * itself is the same gentle one the detector uses.
     */
    public bumpPair(a: Vehicle, b: Vehicle): void {
        const fa = this.footprintOf(a);
        const fb = this.footprintOf(b);
        if (!fa || !fb) return;
        this.separate(a, b, footprintSeparation(fa, fb), this.pairScale(a, b));
        const key = this.pairKey(a, b);
        const state = this.pairs.get(key) ?? this.freshState();
        this.resetWindow(state);
        state.cooldownRemainingMs = this.options.cooldownMs;
        this.pairs.set(key, state);
    }

    private freshState(): PairState {
        return { contactTime: 0, cooldownRemainingMs: 0, gapAtWindowStart: 0, windowOpen: false };
    }

    private resetWindow(state: PairState): void {
        state.contactTime = 0;
        state.windowOpen = false;
    }

    /** Size factor relative to the ~3.4 m reference car; scales thresholds so tiny cars aren't shoved around. */
    private vehicleScale(v: Vehicle): number {
        const he = this.halfExtentsOf(v);
        if (!he) return 1;
        const footprint = Math.max(he.x, he.z) * 2; // largest horizontal extent
        return footprint > 0 ? footprint / VehicleUnstuckSystem.REFERENCE_FOOTPRINT : 1;
    }

    /**
     * Half extents to measure a car by — the chassis slab WIDENED to enclose
     * the wheel guards. The bare chassis collider is cut from the
     * wheel-excluded body, so on anything with proud wheels (every `exposed`
     * axle: buggies, monster trucks) two cars locked tyre-to-tyre would report
     * their bodies most of a metre apart and never enter a contact window.
     */
    private halfExtentsOf(v: Vehicle): { x: number; y: number; z: number } | null {
        return v.getCollisionHalfExtents() ?? v.getChassisCollider()?.halfExtents() ?? null;
    }

    /** Geometric-mean scale of a pair, used to scale shared thresholds. */
    private pairScale(a: Vehicle, b: Vehicle): number {
        return Math.sqrt(this.vehicleScale(a) * this.vehicleScale(b));
    }

    /** World-space footprint of a vehicle's chassis + wheel guards, or null if it has no collider. */
    private footprintOf(v: Vehicle): BoxFootprint | null {
        const collider = v.getChassisCollider();
        if (!collider) return null;
        const he = this.halfExtentsOf(v);
        if (!he) return null;
        return boxFootprint(collider.translation(), collider.rotation(), he);
    }

    private processPair(a: Vehicle, b: Vehicle, deltaTime: number): void {
        const key = this.pairKey(a, b);
        let state = this.pairs.get(key);
        if (state && state.cooldownRemainingMs > 0) return;

        const scale = this.pairScale(a, b);

        const fa = this.footprintOf(a);
        const fb = this.footprintOf(b);
        if (!fa || !fb) return;

        // Cheap reject first: outside the two chassis radii plus a margin,
        // the boxes cannot possibly be in contact.
        const centreDist = Math.hypot(fa.cx - fb.cx, fa.cz - fb.cz);
        if (centreDist > fa.radius + fb.radius + this.options.contactDistance * scale) {
            if (state) this.resetWindow(state);
            return;
        }

        // Exact geometry: are these two boxes actually touching?
        const separation = footprintSeparation(fa, fb);
        const slop = (this.options.contactSlop ?? 0.05) * scale;
        const touching = separation.gap <= slop && verticalOverlap(fa, fb) > 0;
        if (!touching) {
            if (state) this.resetWindow(state);
            return;
        }

        // Welded cars move in LOCKSTEP — near-zero velocity relative to each
        // other, at ANY absolute speed. A rear-end shunt makes a train doing
        // full racing speed, and that train is exactly as stuck as two cars
        // jammed on the grid. Cars genuinely racing always have relative
        // motion (a pass opens the gap, an approach closes it), so relative
        // velocity is the discriminator — never absolute speed, which blinded
        // this system to every at-speed weld.
        const va = a.getLinearVelocity();
        const vb = b.getLinearVelocity();
        const relSpeed = Math.hypot(va.x - vb.x, va.z - vb.z);
        if (relSpeed > (this.options.maxLockstepSpeed ?? 1.5) * scale) {
            if (state) this.resetWindow(state);
            return;
        }

        // Nobody is trying to go anywhere (parked cars, cars held on the grid):
        // there is nothing to free, so leave them be.
        if (a.getEngineForce() === 0 && b.getEngineForce() === 0) {
            if (state) this.resetWindow(state);
            return;
        }

        if (!state) {
            state = this.freshState();
            this.pairs.set(key, state);
        }
        if (!state.windowOpen) {
            state.gapAtWindowStart = separation.gap;
            state.windowOpen = true;
        }

        state.contactTime += deltaTime;
        if (state.contactTime < this.options.contactDuration) return;

        // Window full — has the real gap between the two chassis opened up?
        const separationGain = separation.gap - state.gapAtWindowStart;
        if (separationGain < this.options.minSeparationGain * scale) {
            this.separate(a, b, separation, scale);
            state.cooldownRemainingMs = this.options.cooldownMs;
        }
        // Always restart the window — either we just nudged them (the cooldown
        // takes over) or they're working free slowly and we want a fresh
        // baseline rather than measuring against a stale snapshot.
        this.resetWindow(state);
    }

    /**
     * De-penetrate along the true contact normal and top the pair up to
     * `bumpSpeed` of relative separation. Both halves are deliberately small:
     * the correction is the measured overlap, and the impulse only makes up the
     * shortfall against the target, so cars already parting are left untouched.
     */
    private separate(
        a: Vehicle,
        b: Vehicle,
        separation: { gap: number; nx: number; nz: number },
        scale: number,
    ): void {
        const { nx, nz } = separation;

        // STEP 1 — push each chassis out by half the depth they actually
        // overlap. The solver can leave two boxes penetrating for a long time
        // once wedged; a direct correction of exactly that depth breaks the
        // contact without displacing either car noticeably.
        const overlap = Math.max(0, -separation.gap);
        const push = Math.min(overlap * 0.5 + DEPENETRATION_EPSILON, this.options.bumpTeleport * scale);
        const bodyA = a.getChassisBody();
        const bodyB = b.getChassisBody();
        if (bodyA) {
            const t = bodyA.translation();
            bodyA.setTranslation({ x: t.x + nx * push, y: t.y, z: t.z + nz * push }, true);
        }
        if (bodyB) {
            const t = bodyB.translation();
            bodyB.setTranslation({ x: t.x - nx * push, y: t.y, z: t.z - nz * push }, true);
        }

        // STEP 2 — top up the separation rate, never exceed it. `closing` is the
        // rate they are already parting at along the contact normal; only the
        // shortfall is applied, split evenly and mass-scaled.
        const va = a.getLinearVelocity();
        const vb = b.getLinearVelocity();
        const parting = (va.x - vb.x) * nx + (va.z - vb.z) * nz;
        const target = this.options.bumpSpeed * scale;
        const deficit = target - parting;
        if (deficit > 0) {
            const dv = deficit * 0.5;
            a.applyImpulse(nx * dv * a.getMass(), 0, nz * dv * a.getMass());
            b.applyImpulse(-nx * dv * b.getMass(), 0, -nz * dv * b.getMass());
        }

        if (this.options.debugLog) {
            console.warn(`[VehicleUnstuckSystem] separated a stuck pair: overlap=${overlap.toFixed(3)}m, correction=${push.toFixed(3)}m/car, Δv=${Math.max(0, target - parting).toFixed(2)}m/s relative, normal=(${nx.toFixed(2)}, ${nz.toFixed(2)})`);
        }

        this.options.onSeparated?.({ vehicleA: a, vehicleB: b, nx, nz });
    }

    private pairKey(a: Vehicle, b: Vehicle): string {
        const ha = a.getChassisBody()?.handle ?? 0;
        const hb = b.getChassisBody()?.handle ?? 0;
        return ha < hb ? `${ha}-${hb}` : `${hb}-${ha}`;
    }
}
