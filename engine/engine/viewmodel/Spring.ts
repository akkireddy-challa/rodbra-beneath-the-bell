/**
 * Damped springs for view-model motion — the integrator every procedural
 * contribution (sway, recoil, landing punch, camera punch) is built on.
 *
 * These are solved ANALYTICALLY, not stepped numerically. Over a single frame
 * the target is constant (we only receive one per frame), and for a constant
 * target the damped-oscillator ODE has a closed form in all three damping
 * regimes. Evaluating it costs one `exp` — plus a `sin`/`cos` when underdamped
 * — and is exact at any delta.
 *
 * The alternative, semi-implicit Euler sub-stepped at some fixed rate, is the
 * usual game-dev answer and it is a trap at these stiffnesses. It is STABLE
 * well before it is ACCURATE, and only the first property is easy to test for.
 * A recoil channel at ω = 50 stepped at 1/120 has h·ω = 0.42 — no divergence,
 * looks fine in a stability sweep — yet each sub-step multiplies velocity by
 * (1 − 2ζωh) ≈ 0.17 before it moves the position, so the kick lands about 80%
 * short of its authored size and snaps back far too fast. Getting h·ω low
 * enough to fix that needs ~500 Hz sub-stepping, which is strictly more work
 * than the exact solution. Hence: closed form, no sub-steps, no stability
 * bound, and no frame-rate dependence to regression-test for.
 *
 * Impulses are authored as PEAK DISPLACEMENT. A spring impulse is physically a
 * velocity injection, but "how far does it actually kick?" is the only question
 * a designer asks, and the answer depends on both ω and ζ. So the API takes the
 * peak (metres or radians) and converts. Retune a weapon's stiffness and its
 * kick keeps the size it was authored with.
 *
 * Pure (no three.js / engine imports) so the response curve is unit-testable.
 */

/**
 * Displacement below which a spring counts as settled (metres or radians).
 *
 * Velocity is compared against `REST_EPSILON · ω` rather than against the same
 * number: a spring's velocity scale is ω times its displacement scale, so one
 * shared threshold would call a slow channel settled while it was still moving
 * and a stiff one restless while it was visually still.
 */
const REST_EPSILON = 1e-4;

/** Damping ratios within this of 1 use the critically damped closed form. */
const CRITICAL_EPSILON = 1e-4;

/**
 * Advance one scalar channel of a damped oscillator by `dt`, exactly.
 *
 * Solves `u'' + 2ζω·u' + ω²·u = 0` for `u = x − target`, then adds the target
 * back. Results are written into the shared `_step` scratch pair to keep this
 * allocation-free on a per-frame path.
 */
const _step = { x: 0, v: 0 };

function analyticStep(
    x: number, v: number, target: number, omega: number, damping: number, dt: number,
): void {
    const u0 = x - target;

    if (omega <= 0) {
        _step.x = x;
        _step.v = v;
        return;
    }

    if (Math.abs(damping - 1) < CRITICAL_EPSILON) {
        // u(t) = (u₀ + (v₀ + ω·u₀)·t)·e^(−ωt)
        const decay = Math.exp(-omega * dt);
        const c = v + omega * u0;
        _step.x = target + (u0 + c * dt) * decay;
        _step.v = (v - c * omega * dt) * decay;
        return;
    }

    if (damping < 1) {
        // u(t) = e^(−βt)·[u₀·cos(ω_d·t) + ((v₀ + β·u₀)/ω_d)·sin(ω_d·t)]
        const beta = damping * omega;
        const omegaD = omega * Math.sqrt(1 - damping * damping);
        const decay = Math.exp(-beta * dt);
        const c = Math.cos(omegaD * dt);
        const s = Math.sin(omegaD * dt);
        _step.x = target + decay * (u0 * c + ((v + beta * u0) / omegaD) * s);
        _step.v = decay * (v * c - ((omega * omega * u0 + beta * v) / omegaD) * s);
        return;
    }

    // Overdamped: u(t) = A·e^(−b₁t) + B·e^(−b₂t)
    const root = omega * Math.sqrt(damping * damping - 1);
    const b1 = damping * omega - root;
    const b2 = damping * omega + root;
    const a = (v + b2 * u0) / (b2 - b1);
    const b = u0 - a;
    const e1 = Math.exp(-b1 * dt);
    const e2 = Math.exp(-b2 * dt);
    _step.x = target + a * e1 + b * e2;
    _step.v = -b1 * a * e1 - b2 * b * e2;
}

/**
 * Peak displacement produced by injecting unit velocity into a spring at rest.
 *
 * Released from rest at u = 0 with velocity v₀, the peak displacement is
 * `v₀ · impulseGain(ω, ζ)`. Inverting that is what lets an impulse be authored
 * as the distance it visibly travels. All three regimes are solved exactly
 * rather than assuming ζ = 1, so a deliberately snappy underdamped channel
 * still kicks the distance it was told to.
 */
function impulseGain(omega: number, damping: number): number {
    if (omega <= 0) return 0;

    // Critically damped: u(t) = v₀·t·e^(−ωt), peak at t = 1/ω.
    if (Math.abs(damping - 1) < CRITICAL_EPSILON) {
        return 1 / (omega * Math.E);
    }

    if (damping < 1) {
        const beta = damping * omega;
        const omegaD = omega * Math.sqrt(1 - damping * damping);
        const tPeak = Math.atan2(omegaD, beta) / omegaD;
        return Math.exp(-beta * tPeak) * Math.sin(omegaD * tPeak) / omegaD;
    }

    const root = omega * Math.sqrt(damping * damping - 1);
    const b1 = damping * omega - root;
    const b2 = damping * omega + root;
    const tPeak = Math.log(b2 / b1) / (b2 - b1);
    return (Math.exp(-b1 * tPeak) - Math.exp(-b2 * tPeak)) / (b2 - b1);
}

/** A single scalar channel. */
export class Spring1 {
    private x = 0;
    private v = 0;

    constructor(private omega: number, private damping: number) {}

    /** Retune in place. Displacement and velocity are preserved. */
    setResponse(omega: number, damping: number): void {
        this.omega = omega;
        this.damping = damping;
    }

    getValue(): number { return this.x; }
    getVelocity(): number { return this.v; }

    /** Displacement and velocity are both negligible. */
    isAtRest(): boolean {
        return Math.abs(this.x) < REST_EPSILON && Math.abs(this.v) < REST_EPSILON * this.omega;
    }

    /** Snap to zero, discarding all motion. */
    reset(): void {
        this.x = 0;
        this.v = 0;
    }

    /**
     * Kick the spring so that, released from rest, it travels `peak` before
     * turning back. Impulses accumulate: firing again mid-recovery stacks, which
     * is what makes sustained fire climb.
     */
    addImpulsePeak(peak: number): void {
        const gain = impulseGain(this.omega, this.damping);
        if (gain > 0) this.v += peak / gain;
    }

    /** Advance toward `target` (default 0 — recoil and sway both spring to rest). */
    integrate(deltaTime: number, target = 0): number {
        if (!(deltaTime > 0)) return this.x;
        analyticStep(this.x, this.v, target, this.omega, this.damping, deltaTime);
        this.x = _step.x;
        this.v = _step.v;
        return this.x;
    }
}

/**
 * Three scalar channels sharing one response.
 *
 * Used for both position (metres) and euler rotation (radians) — view-model
 * angles are all small, so treating rotation as three independent scalars is
 * exact enough and avoids quaternion work in a per-frame path.
 */
export class Spring3 {
    private px = 0; private py = 0; private pz = 0;
    private vx = 0; private vy = 0; private vz = 0;

    constructor(private omega: number, private damping: number) {}

    setResponse(omega: number, damping: number): void {
        this.omega = omega;
        this.damping = damping;
    }

    getX(): number { return this.px; }
    getY(): number { return this.py; }
    getZ(): number { return this.pz; }

    isAtRest(): boolean {
        const vEps = REST_EPSILON * this.omega;
        return Math.abs(this.px) < REST_EPSILON && Math.abs(this.vx) < vEps
            && Math.abs(this.py) < REST_EPSILON && Math.abs(this.vy) < vEps
            && Math.abs(this.pz) < REST_EPSILON && Math.abs(this.vz) < vEps;
    }

    reset(): void {
        this.px = 0; this.py = 0; this.pz = 0;
        this.vx = 0; this.vy = 0; this.vz = 0;
    }

    /** Per-axis peak-authored impulse. See `Spring1.addImpulsePeak`. */
    addImpulsePeak(peakX: number, peakY: number, peakZ: number): void {
        const gain = impulseGain(this.omega, this.damping);
        if (gain <= 0) return;
        this.vx += peakX / gain;
        this.vy += peakY / gain;
        this.vz += peakZ / gain;
    }

    /** Advance all three axes toward the given target (default the origin). */
    integrate(deltaTime: number, targetX = 0, targetY = 0, targetZ = 0): void {
        if (!(deltaTime > 0)) return;
        analyticStep(this.px, this.vx, targetX, this.omega, this.damping, deltaTime);
        this.px = _step.x; this.vx = _step.v;
        analyticStep(this.py, this.vy, targetY, this.omega, this.damping, deltaTime);
        this.py = _step.x; this.vy = _step.v;
        analyticStep(this.pz, this.vz, targetZ, this.omega, this.damping, deltaTime);
        this.pz = _step.x; this.vz = _step.v;
    }
}

/**
 * Frame-rate-independent exponential approach: the fraction of the remaining
 * gap closed depends only on elapsed time, not on how many frames it took.
 *
 * The naive `lerp(a, b, dt * rate)` form converges at different speeds on a
 * 30 Hz and a 144 Hz display and overshoots outright once `dt * rate > 1`.
 * Every smoothing term in the view model uses this instead.
 */
export function expApproach(current: number, target: number, halfLife: number, deltaTime: number): number {
    if (!(deltaTime > 0) || halfLife <= 0) return target;
    return target + (current - target) * Math.pow(2, -deltaTime / halfLife);
}

/** Peak displacement per unit of injected velocity. Exposed for tests. */
export { impulseGain };
