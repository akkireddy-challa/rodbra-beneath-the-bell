import type { Vehicle, VehicleControls } from 'engine/Vehicle.js';

/**
 * Interface for pluggable vehicle AI driving behavior.
 *
 * The engine ships BasicDrivingComponent which handles steering, reversing,
 * and stuck recovery. Game code can implement this interface to provide
 * custom driving logic (aggressive ramming, formation driving, etc.)
 * and swap it in via vehicle.setDrivingComponent().
 */
export interface IVehicleDrivingComponent {
    /** Called each frame. Read vehicle state, call vehicle.setAIControls(). */
    update(deltaTime: number, vehicle: Vehicle): void;

    /**
     * Set the current drive target.
     *
     * @param isFinal Whether this point IS the destination, as opposed to an
     * intermediate waypoint on the way there. Optional and defaults to `true`
     * (a bare two-argument call behaves exactly as before this parameter
     * existed). `BasicDrivingComponent`'s arrival easing (`slowRadius` /
     * `crawlSpeed` in `BasicDrivingOptions`) only ramps down when heading for
     * a final target — a waypoint follower that passes each intermediate
     * waypoint as `setTarget(x, z, false)` gets full cruise speed on every
     * leg but the last, instead of permanently riding the crawl band because
     * the next waypoint is always inside `slowRadius`. The arrival RADIUS
     * check (braking and holding once close enough) is unaffected either way
     * — only the easing ramp is gated on this flag.
     */
    setTarget(x: number, z: number, isFinal?: boolean): void;

    /** Clear target and brake. */
    stop(): void;

    /** Check if the vehicle is within radius of a point (XZ distance). */
    isNear(x: number, z: number, radius: number): boolean;

    /**
     * Ask the driver to coast (no throttle, keep steering) for `seconds`.
     * `RacingSetup` calls this on the ramming car right after
     * `VehicleUnstuckSystem` splits a welded pair — an AI that keeps the
     * throttle pinned just re-welds within a second; a human lifts, so the AI
     * must too. Optional: shipped game code implements this interface, so the
     * member can only be added as optional. Ignoring it merely re-welds sooner.
     */
    yieldThrottle?(seconds: number): void;
}

/**
 * Stuck-recovery tuning. The defaults are the values that were hardcoded
 * before this became configurable: they suit racing, where any car under
 * 1.5 m/s really is in trouble. A game whose cars deliberately drive slowly
 * needs `speedFractionOfTarget` and `requireThrottle` (see
 * SMOOTH_DRIVING_OPTIONS) or the recovery fires during normal driving and the
 * car shuffles forward and back forever.
 */
export interface BasicDrivingRecoveryOptions {
    /** Master switch for the reverse-burst recovery. */
    enabled: boolean;
    /** Absolute speed (m/s) below which the vehicle may count as stuck. */
    speedThreshold: number;
    /**
     * Also cap the effective threshold at this fraction of the speed the
     * driver is currently asking for, so a deliberate crawl never reads as
     * stuck. 0 disables the cap and leaves `speedThreshold` absolute.
     */
    speedFractionOfTarget: number;
    /**
     * Only accumulate stuck time while the driver is actually asking for
     * throttle. A car coasting under a speed limit, yielding after a shunt, or
     * braking on its final approach is not stuck.
     */
    requireThrottle: boolean;
    /** Seconds the stuck condition must hold before a reverse burst. */
    timeThreshold: number;
    /** Length (s) of the first reverse burst. */
    burstDuration: number;
    /** Each consecutive failed recovery lengthens the next burst by this factor. */
    burstEscalation: number;
    /** Cap (s) on the escalated burst, so the AI never reverses forever. */
    burstMaxDuration: number;
    /**
     * A recovery recurring within this window (s) of the previous burst ENDING
     * means the last burst failed — same wall, same wedge — so the next one
     * escalates.
     */
    escalationWindow: number;
}

/**
 * What the driver can tell game code about its own progress.
 *
 * `BasicDrivingComponent` never gives up on its own: recovery escalates the
 * reverse burst to `burstMaxDuration` and then repeats indefinitely, re-aiming
 * at the identical point with the identical steering law. Without this, a car
 * wedged against a kerb it cannot climb is indistinguishable from a car merely
 * driving slowly, and the game grinds forever. Poll this to notice.
 */
export interface VehicleDrivingStatus {
    /** True once the driver has failed to get closer for `noProgressTimeout` seconds. */
    unreachable: boolean;
    /** Seconds since the driver last got meaningfully closer to its target. */
    secondsWithoutProgress: number;
    /** Closest XZ distance to the current target achieved so far; Infinity with no target. */
    bestDistance: number;
    /** Consecutive reverse bursts that failed to clear the obstacle. */
    failedRecoveries: number;
}

export interface BasicDrivingOptions {
    /**
     * Use analog throttle/brake to HOLD a speed, instead of the boolean
     * coast-above-a-ceiling model. Off by default: shipped games may be tuned
     * around bang-bang throttle.
     */
    analogThrottle: boolean;
    /**
     * Speed (m/s) the driver holds when far from its target. 0 falls back to
     * the `maxSpeed` field, which is what pre-options games set. If both are
     * 0, `maxSpeed`'s "0 = unlimited" convention would otherwise invert to
     * "0 = never move" under analog throttle, so `targetSpeedFor` treats
     * that as an uncapped target (Infinity) rather than a held speed of 0 —
     * the driver commands full throttle indefinitely instead of settling to
     * zero throttle and eventually reading as stuck.
     */
    cruiseSpeed: number;
    /** Distance (m) from the target at which the driver starts easing off. 0 = no easing. */
    slowRadius: number;
    /** Floor speed (m/s) on the final approach, so the stop is smooth rather than abrupt. */
    crawlSpeed: number;
    /** Distance (m) inside which the driver brakes and holds. */
    arriveRadius: number;
    /**
     * Ignore heading errors below this (radians): no steering at all below
     * the deadzone. Above it and up to `steerFullLockAngle`, steering ramps
     * up linearly with the heading error, so a gentle course correction
     * stays gentle instead of slamming full lock — full lock on every small
     * correction would make the vehicle carve a circle far tighter than the
     * path it is meant to be following.
     */
    steerDeadzoneAngle: number;
    /**
     * Heading error (radians) at which steering reaches full lock. Between
     * `steerDeadzoneAngle` and this angle, steer magnitude is a linear ramp
     * of the heading error — see `steerDeadzoneAngle` for why.
     */
    steerFullLockAngle: number;
    /** A target behind the vehicle and closer than this (m) is reversed toward. */
    reverseDistanceThreshold: number;
    /**
     * Seconds without getting meaningfully closer to the target before
     * `getDrivingStatus()` reports `unreachable`. `0` disables the watchdog.
     *
     * Optional, and an ABSENT value means the 8 s default rather than off:
     * this interface has shipped and published game code constructs it, so it
     * may only gain optional members — and a game spreading an older literal
     * should still get the signal.
     */
    noProgressTimeout?: number;
    recovery: BasicDrivingRecoveryOptions;
}

/**
 * Exactly the behaviour `BasicDrivingComponent` had before it took options:
 * boolean throttle, a `maxSpeed` ceiling rather than a held speed, no arrival
 * easing, and recovery that arms on any second under 1.5 m/s.
 */
export const DEFAULT_BASIC_DRIVING_OPTIONS: BasicDrivingOptions = {
    analogThrottle: false,
    cruiseSpeed: 0,
    slowRadius: 0,
    crawlSpeed: 0,
    arriveRadius: 0.5,
    steerDeadzoneAngle: 0.05,   // ~3°
    steerFullLockAngle: 0.6,    // ~34°
    reverseDistanceThreshold: 8,
    noProgressTimeout: 8,
    recovery: {
        enabled: true,
        speedThreshold: 1.5,
        speedFractionOfTarget: 0,
        requireThrottle: false,
        timeThreshold: 1.0,
        burstDuration: 1.0,
        burstEscalation: 1.6,
        burstMaxDuration: 3.0,
        escalationWindow: 4.0,
    },
};

/**
 * The preset for "an NPC drives to a destination and parks" — a chauffeur, a
 * taxi, an escort, a cutscene car. Analog throttle holds a town speed instead
 * of surging; the driver eases to a crawl over the last 26 m and stops inside
 * 4.5 m; and recovery only arms when the car is genuinely wedged (throttle
 * asked for, going nowhere) rather than merely driving slowly.
 *
 * Pass to the constructor: `new BasicDrivingComponent(SMOOTH_DRIVING_OPTIONS)`.
 * Spread it to adjust one field:
 * `{ ...SMOOTH_DRIVING_OPTIONS, cruiseSpeed: 14 }`.
 */
export const SMOOTH_DRIVING_OPTIONS: BasicDrivingOptions = {
    ...DEFAULT_BASIC_DRIVING_OPTIONS,
    analogThrottle: true,
    cruiseSpeed: 9,      // ~32 km/h, a comfortable town cruise
    slowRadius: 26,
    crawlSpeed: 2.5,
    arriveRadius: 4.5,
    // Kept close to arriveRadius on purpose: the reverse branch is a full-
    // power boolean manoeuvre, not routed through the analog controller (see
    // BEHIND_DOT_THRESHOLD / the `targetBehind` branch in `update`), so the
    // annulus between arriveRadius and this value is the one un-smoothed
    // corner of an otherwise analog preset. Left at the base default of 8 it
    // is a reachable 3.5 m band (any overshoot past the destination lands in
    // it); 6 shrinks that to 1.5 m while still covering the immediate-
    // overshoot case.
    reverseDistanceThreshold: 6,
    recovery: {
        ...DEFAULT_BASIC_DRIVING_OPTIONS.recovery,
        speedFractionOfTarget: 0.35,
        requireThrottle: true,
        timeThreshold: 2.5,
    },
};

const BEHIND_DOT_THRESHOLD = -0.3;

/** Throttle per m/s of shortfall. 1.0 = full throttle when 1 m/s slow. */
const THROTTLE_GAIN = 1.0;
/** Overspeed (m/s) tolerated before the brake is touched at all. */
const BRAKE_TOLERANCE = 0.5;
/** Brake per m/s of overspeed beyond the tolerance. */
const BRAKE_GAIN = 0.25;

/**
 * Metres of improvement that count as real progress. Coarse on purpose: a
 * wedged car observed oscillating across an 8 m band still crept its best
 * distance from 27.3 m to 27.2 m over ten seconds, and any epsilon finer than
 * that creep reads it as progress and resets the timer forever.
 */
const PROGRESS_EPSILON = 0.5;

/** Seconds without progress before the driver reports `unreachable`. */
const DEFAULT_NO_PROGRESS_TIMEOUT = 8;

const BRAKE_CONTROLS: VehicleControls = { forward: false, backward: false, left: false, right: false, brake: true };

/**
 * Default driving component that steers a vehicle toward a target point.
 *
 * Handles:
 * - Correct cross-product steering (left/right)
 * - U-turns when target is behind and far
 * - Reversing when target is behind and close
 * - Stuck detection with reverse-burst recovery
 */
export class BasicDrivingComponent implements IVehicleDrivingComponent {
    private readonly options: BasicDrivingOptions;

    constructor(options: BasicDrivingOptions = DEFAULT_BASIC_DRIVING_OPTIONS) {
        this.options = options;
    }

    private targetX: number | null = null;
    private targetZ: number | null = null;
    /**
     * Whether the current target IS the destination, not an intermediate
     * waypoint — gates arrival easing in `targetSpeedFor`. Defaults to `true`
     * so a caller that never passes `isFinal` to `setTarget` (every existing
     * caller before this field existed) keeps easing exactly as before.
     */
    private isFinalTarget = true;
    private stuckTimer = 0;
    private reverseTimer = 0;
    private yieldTimer = 0;
    /** Seconds since the last reverse burst ENDED. Large = driving normally. */
    private sinceRecovery = Infinity;
    /** Consecutive recoveries that failed to clear the obstacle (0 = none). */
    private escalation = 0;
    private lastCross = 0;
    private lastVehicle: Vehicle | null = null;
    /**
     * External cap on the speed `targetSpeedFor` resolves to, applied via
     * `Math.min`. `null` (the default) means no cap. Set by
     * `setCruiseOverride` — see that method's doc for why this exists.
     */
    private cruiseOverride: number | null = null;
    /**
     * Throttle commanded on the PREVIOUS frame, in [0, 1]. The stuck check runs
     * before this frame's controls are computed, so `requireThrottle` reads
     * this; one frame of lag is nothing against a multi-second threshold.
     */
    private lastThrottleCommanded = 0;

    /** Closest XZ distance to the current target achieved so far. */
    private bestDistance = Infinity;
    /** Seconds since `bestDistance` last improved by more than PROGRESS_EPSILON. */
    private secondsWithoutProgress = 0;

    /**
     * Maximum speed in m/s. 0 = unlimited. The vehicle coasts when above this
     * speed — but that is only true when `options.analogThrottle` is false.
     * In analog mode, `maxSpeed` is not a ceiling: with `cruiseSpeed > 0` it
     * is ignored entirely (`cruiseSpeed` is the held speed and nothing caps
     * above it); with `cruiseSpeed === 0` it silently becomes the speed
     * HELD, not a limit. A game that sets `maxSpeed` directly the way
     * `racing-setup.ts` does (a plausible mistake, since that field still
     * exists and still compiles under analog options) and separately turns on
     * `analogThrottle` gets no speed ceiling at all — use `cruiseSpeed` for
     * the analog case instead.
     */
    maxSpeed = 0;

    setTarget(x: number, z: number, isFinal = true): void {
        // Only a DIFFERENT target restarts the watchdog. Waypoint followers
        // call this with the same coordinates every frame; resetting on every
        // call would mean the timer never accumulates and the watchdog never
        // fires. Comparing coordinates also handles waypoint advance, where the
        // distance to the new target is larger than the best distance to the
        // old one and would otherwise read as instant failure.
        if (x !== this.targetX || z !== this.targetZ) {
            this.resetProgressWatchdog();
        }
        this.targetX = x;
        this.targetZ = z;
        this.isFinalTarget = isFinal;
    }

    /**
     * Cap the speed the driver holds, from outside `options` and without
     * touching it. `null` (the default) clears the cap.
     *
     * Concrete-class-only: `IVehicleDrivingComponent` is implemented by
     * shipped game code and may only gain OPTIONAL interface members, so this
     * cannot live there. `VehiclePathDrivingComponent` is the reason it
     * exists — corner slowdown needs to cap the speed a path follower's inner
     * `BasicDrivingComponent` holds on a frame-by-frame basis, something
     * `BasicDrivingOptions.cruiseSpeed` cannot do since it is fixed at
     * construction.
     *
     * Applied inside `targetSpeedFor` via `Math.min(resolved, override)`,
     * which gives both halves of the contract for free: it caps the
     * `Infinity` `targetSpeedFor` returns when `cruiseSpeed`/`maxSpeed` are
     * both 0 (an uncapped straightaway becomes exactly as fast as the
     * override allows — the whole point of a corner-speed cap), and it never
     * lowers a value that is already below the override (the arrival easing
     * toward `crawlSpeed` is never undercut, since `min` only picks the
     * override when the override is the SMALLER of the two).
     */
    setCruiseOverride(speed: number | null): void {
        this.cruiseOverride = speed;
    }

    stop(): void {
        this.targetX = null;
        this.targetZ = null;
        this.isFinalTarget = true;
        this.stuckTimer = 0;
        this.reverseTimer = 0;
        this.yieldTimer = 0;
        this.sinceRecovery = Infinity;
        this.escalation = 0;
        this.lastThrottleCommanded = 0;
        this.resetProgressWatchdog();
        this.lastVehicle?.setAIControls(BRAKE_CONTROLS);
    }

    yieldThrottle(seconds: number): void {
        this.yieldTimer = Math.max(this.yieldTimer, seconds);
    }

    isNear(x: number, z: number, radius: number): boolean {
        if (!this.lastVehicle) return false;
        const pos = this.lastVehicle.getPosition();
        const dx = x - pos.x;
        const dz = z - pos.z;
        return dx * dx + dz * dz < radius * radius;
    }

    /**
     * Forget the progress history. Called whenever "closer than before" stops
     * being a meaningful question: no target, a diverged physics body, or the
     * car parked at its destination.
     */
    private resetProgressWatchdog(): void {
        this.bestDistance = Infinity;
        this.secondsWithoutProgress = 0;
    }

    /**
     * How the driver is getting on. Report-only — nothing here changes what the
     * car does, so a game that never polls behaves exactly as before.
     */
    getDrivingStatus(): VehicleDrivingStatus {
        const timeout = this.options.noProgressTimeout ?? DEFAULT_NO_PROGRESS_TIMEOUT;
        return {
            unreachable: timeout > 0 && this.secondsWithoutProgress > timeout,
            secondsWithoutProgress: this.secondsWithoutProgress,
            bestDistance: this.bestDistance,
            failedRecoveries: this.escalation,
        };
    }

    /**
     * Speed the driver should be doing right now: `cruiseSpeed` in the open,
     * easing linearly to `crawlSpeed` across the last `slowRadius` metres of
     * the FINAL leg. This is what makes an NPC arrive smoothly rather than
     * braking from full speed.
     *
     * `distanceToDestination` is misleading when the caller is a waypoint
     * follower: `setTarget` only ever knows the single point it was last
     * given, which for every waypoint follower is the NEXT waypoint, not the
     * actual destination. Easing off that distance means the target is
     * permanently inside `slowRadius` and cruise is never reached for the
     * whole trip. `isFinalTarget` (set by `setTarget`'s `isFinal` param) gates
     * the ramp: only ease when the current target really is the destination —
     * an intermediate leg gets full cruise regardless of how close the next
     * waypoint is.
     */
    private targetSpeedFor(distanceToDestination: number): number {
        const cruise = this.options.cruiseSpeed > 0 ? this.options.cruiseSpeed : this.maxSpeed;
        // cruiseSpeed 0 falling back to an also-0 maxSpeed means "unlimited"
        // in the boolean model's vocabulary, not "held at zero". Infinity
        // keeps that meaning under analog throttle: the throttle computation
        // clamps it to full send via Math.min(1, ...), never NaN (see F1).
        let resolved: number;
        if (cruise <= 0) {
            resolved = Infinity;
        } else if (!this.isFinalTarget || this.options.slowRadius <= 0 || distanceToDestination >= this.options.slowRadius) {
            resolved = cruise;
        } else {
            const eased = cruise * (distanceToDestination / this.options.slowRadius);
            resolved = Math.max(this.options.crawlSpeed, eased);
        }
        // See setCruiseOverride's doc: Math.min caps the Infinity case AND
        // leaves an already-lower easing value alone, in one expression.
        return this.cruiseOverride !== null ? Math.min(resolved, this.cruiseOverride) : resolved;
    }

    update(deltaTime: number, vehicle: Vehicle): void {
        this.lastVehicle = vehicle;

        if (this.targetX === null || this.targetZ === null) {
            this.lastThrottleCommanded = 0;
            this.resetProgressWatchdog();
            vehicle.setAIControls(BRAKE_CONTROLS);
            return;
        }

        const pos = vehicle.getPosition();
        const dx = this.targetX - pos.x;
        const dz = this.targetZ - pos.z;
        const dist = Math.hypot(dx, dz);
        const speed = vehicle.getSpeed();

        // A diverged physics body (NaN position/velocity) or a NaN target
        // (e.g. game code normalizing a zero-length vector) must brake, not
        // feed NaN downstream: `NaN < arriveRadius` and `NaN >= slowRadius`
        // are both false, so neither early-return nor the easing guard would
        // catch it, and Math.max/Math.min pass NaN straight through to
        // throttle and on into engineForce, permanently poisoning the body's
        // velocity.
        if (!Number.isFinite(dist) || !Number.isFinite(speed)) {
            this.lastThrottleCommanded = 0;
            this.resetProgressWatchdog();
            vehicle.setAIControls(BRAKE_CONTROLS);
            return;
        }

        // Math.max(..., 1e-6) closes a dist===0 / arriveRadius===0 hole: `dx /
        // dist` below would be `0 / 0` = NaN, which reaches the steer command
        // sent to `vehicle.setAIControls` and poisons the physics body. The
        // finite guard above only catches NaN/Infinity, not an exact zero, so
        // this needs its own floor.
        if (dist < Math.max(this.options.arriveRadius, 1e-6)) {
            this.lastThrottleCommanded = 0;
            this.resetProgressWatchdog();
            vehicle.setAIControls(BRAKE_CONTROLS);
            return;
        }

        // Progress watchdog. Placed after the arrival guard so a parked car
        // never accumulates "no progress" — it stopped improving because it
        // got there. Placed before the reverse-burst branch so time spent in
        // recovery still counts as time spent not arriving.
        if (dist < this.bestDistance - PROGRESS_EPSILON) {
            this.bestDistance = dist;
            this.secondsWithoutProgress = 0;
        } else {
            this.secondsWithoutProgress += deltaTime;
        }

        const toTargetX = dx / dist;
        const toTargetZ = dz / dist;

        const fwd = vehicle.getForwardDirection();
        const fwdLen = Math.hypot(fwd.x, fwd.z);
        const fwdX = fwdLen > 0.001 ? fwd.x / fwdLen : 0;
        const fwdZ = fwdLen > 0.001 ? fwd.z / fwdLen : 1;

        const dot = fwdX * toTargetX + fwdZ * toTargetZ;
        const cross = fwdZ * toTargetX - fwdX * toTargetZ;

        // Stuck detection
        const recovery = this.options.recovery;
        // The threshold drops with the speed being asked for RIGHT NOW — the
        // eased crawl target on final approach, not just the configured
        // cruise — so neither a deliberate crawl nor an arrival glide reads
        // as a wedge. Sharing targetSpeedFor(dist) with the analog throttle
        // branch below (rather than recomputing cruise/maxSpeed here) keeps
        // the two in agreement by construction: a preset like
        // `{ ...SMOOTH_DRIVING_OPTIONS, crawlSpeed: 0.8 }` lowers the actual
        // approach speed, so the stuck bar must follow it down too. `min` is
        // deliberate: the cap may only LOWER the bar, never raise it above
        // the absolute floor.
        const targetSpeed = this.targetSpeedFor(dist);
        const stuckSpeed = recovery.speedFractionOfTarget > 0 && targetSpeed > 0
            ? Math.min(recovery.speedThreshold, targetSpeed * recovery.speedFractionOfTarget)
            : recovery.speedThreshold;
        const askingForThrottle = !recovery.requireThrottle || this.lastThrottleCommanded > 0;

        if (recovery.enabled && askingForThrottle && speed < stuckSpeed && this.reverseTimer <= 0) {
            this.stuckTimer += deltaTime;
        } else {
            this.stuckTimer = 0;
        }
        if (this.reverseTimer <= 0) {
            this.sinceRecovery += deltaTime;
        }

        if (recovery.enabled && this.stuckTimer > recovery.timeThreshold && this.reverseTimer <= 0) {
            // Getting stuck again right after a recovery means the last burst
            // didn't clear the obstacle — one second of reverse from a wall the
            // path leads straight back into just loops forever. Back out
            // further each consecutive time; any stretch of normal driving
            // resets the escalation.
            this.escalation = this.sinceRecovery < recovery.escalationWindow
                ? this.escalation + 1
                : 0;
            this.reverseTimer = Math.min(
                recovery.burstDuration * Math.pow(recovery.burstEscalation, this.escalation),
                recovery.burstMaxDuration,
            );
            this.lastCross = cross;
            this.stuckTimer = 0;
        }

        // Reverse burst (from stuck recovery)
        if (this.reverseTimer > 0) {
            this.reverseTimer -= deltaTime;
            if (this.reverseTimer <= 0) this.sinceRecovery = 0;
            const steerLeft = this.lastCross > 0;
            // Asking for power, just backwards — a burst that achieves nothing
            // must keep the stuck escalation running, not read as idle.
            this.lastThrottleCommanded = 1;
            vehicle.setAIControls({
                forward: false,
                backward: true,
                left: !steerLeft,
                right: steerLeft,
                brake: false,
            });
            return;
        }

        const targetBehind = dot <= BEHIND_DOT_THRESHOLD;

        // Proportional steering. `headingError` is the signed angle (radians)
        // from the vehicle's forward to the target; +ve means the target is to
        // the steer-left side (matches setAIControls `steer` > 0). atan2 keeps
        // it correct through the full ±π range, so a target directly behind
        // produces near-full lock and the U-turn / reverse logic still works.
        const headingError = Math.atan2(cross, dot);
        const steerMagnitude = Math.abs(headingError) < this.options.steerDeadzoneAngle
            ? 0
            : Math.max(-1, Math.min(1, headingError / this.options.steerFullLockAngle));

        // Yielding (asked to lift after ramming another car): coast with the
        // steering still live so the car keeps tracking its path while the gap
        // ahead opens. Recovery bursts above take priority — a yielding car
        // that is also wedged must still back out.
        if (this.yieldTimer > 0) {
            this.yieldTimer -= deltaTime;
            this.lastThrottleCommanded = 0;
            vehicle.setAIControls({
                forward: false,
                backward: false,
                left: false,
                right: false,
                brake: false,
                steer: steerMagnitude,
            });
            return;
        }

        // Speed limiting: coast when above maxSpeed, brake gently when well over
        const overSpeed = this.maxSpeed > 0 && speed > this.maxSpeed;
        const wayOverSpeed = this.maxSpeed > 0 && speed > this.maxSpeed * 1.2;

        if (targetBehind && dist <= this.options.reverseDistanceThreshold) {
            // Backing up: invert the steer so the rear of the vehicle tracks
            // toward the target. This is a deliberate power request (in
            // reverse), so it counts as throttle for the stuck gate.
            this.lastThrottleCommanded = 1;
            vehicle.setAIControls({
                forward: false,
                backward: true,
                left: false,
                right: false,
                brake: false,
                steer: -steerMagnitude,
            });
        } else if (this.options.analogThrottle) {
            // Analog speed control: hold targetSpeedFor(dist) with a
            // proportional throttle/brake instead of the boolean coast-above-
            // a-ceiling model above. A proportional term alone is deliberate:
            // drag supplies the steady-state offset, and an NPC driver does
            // not need exact speed holding — do not add an integral term.
            const desired = this.targetSpeedFor(dist);
            const error = desired - speed;
            const throttle = Math.max(0, Math.min(1, error * THROTTLE_GAIN));
            const brakeAmount = error < -BRAKE_TOLERANCE
                ? Math.max(0, Math.min(1, (-error - BRAKE_TOLERANCE) * BRAKE_GAIN))
                : 0;
            this.lastThrottleCommanded = throttle;
            vehicle.setAIControls({
                forward: false,
                backward: false,
                left: false,
                right: false,
                brake: false,
                throttle,
                brakeAmount,
                steer: steerMagnitude,
            });
        } else {
            // Coasting above maxSpeed asks for no power at all; otherwise this
            // commands forward drive.
            this.lastThrottleCommanded = overSpeed ? 0 : 1;
            vehicle.setAIControls({
                forward: !overSpeed,
                backward: false,
                left: false,
                right: false,
                brake: wayOverSpeed,
                steer: steerMagnitude,
            });
        }
    }
}
