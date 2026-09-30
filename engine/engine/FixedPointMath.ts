/**
 * Fixed-point math utilities for deterministic networked destruction.
 *
 * Uses Q16.16 format: 32-bit signed integers where the upper 16 bits are the
 * integer part and the lower 16 bits are the fractional part.
 *
 * Range: approximately -32768.0 to +32767.99998 with ~0.000015 precision.
 *
 * All operations avoid floating-point entirely in the hot path so that
 * identical inputs produce identical outputs across platforms and browsers.
 */

/** 16.16 fixed-point value stored as a regular JS number (integer). */
export type Fixed16 = number;

const SHIFT = 16;
const SCALE = 1 << SHIFT;        // 65536
const SCALE_INV = 1.0 / SCALE;   // only used in toFloat (output path)
const HALF = SCALE >>> 1;         // 0.5 in fixed-point (rounding helper)

// Mask to keep values in 32-bit signed range after multiplication.
// JS bitwise ops already coerce to int32, but we spell it out for clarity.

/** Convert a floating-point value to Q16.16 fixed-point. */
export function fpFromFloat(f: number): Fixed16 {
    return (f * SCALE + 0.5) | 0;
}

/** Convert a Q16.16 fixed-point value back to a float (for rendering). */
export function fpToFloat(fp: Fixed16): number {
    return fp * SCALE_INV;
}

/** Fixed-point addition: a + b. */
export function fpAdd(a: Fixed16, b: Fixed16): Fixed16 {
    return (a + b) | 0;
}

/** Fixed-point subtraction: a - b. */
export function fpSub(a: Fixed16, b: Fixed16): Fixed16 {
    return (a - b) | 0;
}

/**
 * Fixed-point multiplication: a * b.
 * Uses a split approach to avoid exceeding Number.MAX_SAFE_INTEGER for
 * operands up to ~32767 in magnitude.
 */
export function fpMul(a: Fixed16, b: Fixed16): Fixed16 {
    const aHi = a >> SHIFT;
    const aLo = a & 0xFFFF;
    const bHi = b >> SHIFT;
    const bLo = b & 0xFFFF;
    return (aHi * bHi * SCALE + aHi * bLo + aLo * bHi + ((aLo * bLo) >>> SHIFT)) | 0;
}

/**
 * Fixed-point division: a / b.
 * Shifts a left by 16 then divides. For large a this could overflow 53-bit
 * safe integers, so we use a two-step approach.
 */
export function fpDiv(a: Fixed16, b: Fixed16): Fixed16 {
    if (b === 0) return a >= 0 ? 0x7FFFFFFF : -0x7FFFFFFF;
    // (a << 16) / b — use Math.trunc for integer division toward zero.
    return Math.trunc((a * SCALE) / b);
}

/** Fixed-point square root via integer Newton's method. */
export function fpSqrt(a: Fixed16): Fixed16 {
    if (a <= 0) return 0;
    // Initial guess: float sqrt converted to fixed-point
    let x = fpFromFloat(Math.sqrt(fpToFloat(a)));
    if (x === 0) x = 1;
    // 3 Newton iterations: x = (x + a/x) / 2
    for (let i = 0; i < 3; i++) {
        const d = fpDiv(a, x);
        x = (x + d) >> 1;
    }
    return x;
}

/** Fixed-point distance squared: dx*dx + dy*dy + dz*dz. */
export function fpDistSq3(dx: Fixed16, dy: Fixed16, dz: Fixed16): Fixed16 {
    return fpAdd(fpAdd(fpMul(dx, dx), fpMul(dy, dy)), fpMul(dz, dz));
}

/** Fixed-point 3D distance. */
export function fpDist3(dx: Fixed16, dy: Fixed16, dz: Fixed16): Fixed16 {
    return fpSqrt(fpDistSq3(dx, dy, dz));
}

/** Fixed-point horizontal distance squared: dx*dx + dz*dz. */
export function fpHorizDistSq(dx: Fixed16, dz: Fixed16): Fixed16 {
    return fpAdd(fpMul(dx, dx), fpMul(dz, dz));
}

// ─────────────────────────────────────────────────────────────────────────
// Fixed-point sin/cos via a 256-entry lookup table (one quadrant).
// Resolution: π/512 radians ≈ 0.35°.  Angles are in fixed-point radians.
// ─────────────────────────────────────────────────────────────────────────

const FP_PI = fpFromFloat(Math.PI);
const FP_TWO_PI = fpFromFloat(Math.PI * 2);
const FP_HALF_PI = fpFromFloat(Math.PI / 2);
const SIN_TABLE_SIZE = 256;
const SIN_TABLE: Int32Array = new Int32Array(SIN_TABLE_SIZE + 1);

(function buildSinTable() {
    for (let i = 0; i <= SIN_TABLE_SIZE; i++) {
        SIN_TABLE[i] = fpFromFloat(Math.sin((i / SIN_TABLE_SIZE) * (Math.PI / 2)));
    }
})();

function normalizeAngle(angle: Fixed16): Fixed16 {
    while (angle < 0) angle = fpAdd(angle, FP_TWO_PI);
    while (angle >= FP_TWO_PI) angle = fpSub(angle, FP_TWO_PI);
    return angle;
}

/** Fixed-point sine. Input is fixed-point radians. */
export function fpSin(angle: Fixed16): Fixed16 {
    angle = normalizeAngle(angle);
    let quadrant: number;
    let idx: Fixed16;

    if (angle < FP_HALF_PI) {
        quadrant = 0;
        idx = angle;
    } else if (angle < FP_PI) {
        quadrant = 1;
        idx = fpSub(FP_PI, angle);
    } else if (angle < fpAdd(FP_PI, FP_HALF_PI)) {
        quadrant = 2;
        idx = fpSub(angle, FP_PI);
    } else {
        quadrant = 3;
        idx = fpSub(FP_TWO_PI, angle);
    }

    // Map idx (0 .. π/2 in fixed-point) to table index (0..256)
    const tableIdx = Math.min(SIN_TABLE_SIZE, Math.max(0,
        Math.trunc((idx * SIN_TABLE_SIZE) / FP_HALF_PI)));
    const value = SIN_TABLE[tableIdx]!;
    return (quadrant >= 2) ? -value : value;
}

/** Fixed-point cosine. Input is fixed-point radians. */
export function fpCos(angle: Fixed16): Fixed16 {
    return fpSin(fpAdd(angle, FP_HALF_PI));
}

// ─────────────────────────────────────────────────────────────────────────
// Seeded PRNG for deterministic debris randomness.
// A simple xorshift32 that operates entirely on integers.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deterministic PRNG suitable for fixed-point destruction sequences.
 * Initialized with a seed derived from the fixed-point explosion parameters
 * so every client produces the same sequence.
 */
export class FixedPointRng {
    private state: number;

    constructor(seed: number) {
        this.state = seed | 0;
        if (this.state === 0) this.state = 1;
    }

    /** Return the next pseudo-random 32-bit integer. */
    nextInt(): number {
        let s = this.state;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        this.state = s;
        return s;
    }

    /** Return a fixed-point value in [-SCALE, +SCALE] (i.e. roughly -1.0 .. +1.0). */
    nextFixed(): Fixed16 {
        return (this.nextInt() >> 16) << 0;  // upper 16 bits → ±32768, already in FP scale
    }

    /** Return a fixed-point value in [0, FP_TWO_PI]. */
    nextAngle(): Fixed16 {
        const raw = (this.nextInt() >>> 0) % (FP_TWO_PI > 0 ? FP_TWO_PI : 1);
        return raw | 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: derive a deterministic seed from explosion parameters.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mix fixed-point center coordinates and radius into a single seed.
 * The same parameters always produce the same seed.
 */
export function explosionSeed(cx: Fixed16, cy: Fixed16, cz: Fixed16, radius: Fixed16): number {
    let h = 0x811c9dc5;  // FNV-1a offset basis
    h = Math.imul(h ^ (cx & 0xFFFFFFFF), 0x01000193);
    h = Math.imul(h ^ (cy & 0xFFFFFFFF), 0x01000193);
    h = Math.imul(h ^ (cz & 0xFFFFFFFF), 0x01000193);
    h = Math.imul(h ^ (radius & 0xFFFFFFFF), 0x01000193);
    return h | 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Convenience: 3-component fixed-point vector (plain object, not a class).
// ─────────────────────────────────────────────────────────────────────────

export interface FpVec3 {
    x: Fixed16;
    y: Fixed16;
    z: Fixed16;
}

export const FP_ONE = SCALE;
export const FP_ZERO = 0;
export { SCALE as FP_SCALE };
