/**
 * Built-in channel templates.
 *
 * These are the "just works" defaults a game gets without thinking about
 * quantization. Games append their own channels rather than editing these —
 * a template change alters the meaning of every run already recorded against
 * it, and old runs stay decodable only because the encoded form carries its own
 * channel definitions (see ReplayTypes).
 *
 * Bit widths are chosen against what is VISIBLE on a ghost, not against what is
 * measurable. A ghost is translucent, usually distant, and interpolated; sub-
 * centimetre position and sub-degree rotation are already past the point of
 * diminishing returns.
 */

import type { ReplayChannel } from 'engine/replay/ReplayTypes.js';

/** Position component. Range is the run's own bounding box, so precision scales with the level. */
function positionChannel(key: string): ReplayChannel {
    return { kind: 'scalar', key, bits: 18, min: 0, max: 0, autoRange: true };
}

/**
 * Vehicle motion — what a ghost car needs to be drawn.
 *
 * Suspension compression is deliberately absent: the renderer pins wheels at
 * rest length, so per-wheel travel would be bits nothing consumes. Body squat,
 * dive, and roll are NOT lost by omitting it — the chassis rigid body genuinely
 * rotates under suspension forces, so all of it is already in the quaternion.
 *
 * Wheel spin IS stored, and as ANGULAR VELOCITY rather than phase. Two reasons:
 *
 * - It is not derivable from speed. Wheels outrun the car under acceleration,
 *   lock under braking, and spin (or stop) independently while airborne. A
 *   launch burnout whose ghost has perfectly tracking wheels reads as wrong.
 * - Phase cannot survive the sample rate. A wheel at 100 rad/s turns most of a
 *   revolution between 15 Hz samples, so stored phase would be aliased beyond
 *   reconstruction. Angular velocity is smooth, compresses well, and playback
 *   integrates it back into phase — and nobody can tell what absolute angle a
 *   wheel started at.
 *
 * Four wheel slots is the template's fixed shape; vehicles with fewer leave the
 * remainder at zero, and the rare vehicle with more needs its own channel list.
 *
 * 136 bits per sample, stored as 20 bytes after byte-plane padding.
 */
export const VEHICLE_MOTION_CHANNELS: readonly ReplayChannel[] = [
    positionChannel('posX'),
    positionChannel('posY'),
    positionChannel('posZ'),
    { kind: 'quat', key: 'rot', componentBits: 10 },
    { kind: 'scalar', key: 'steer', bits: 8, min: -0.8, max: 0.8, autoRange: false },
    // SIGNED, from getForwardSpeed(). Used for HUD and validation, not for
    // wheel spin — see the wheel channels below.
    { kind: 'scalar', key: 'speed', bits: 10, min: -30, max: 120, autoRange: false },
    // Per-wheel angular velocity in rad/s. +/-250 covers a 0.35 m wheel well
    // past any real ground speed, which is the point: wheelspin is exactly the
    // case where the wheel outruns the car.
    { kind: 'scalar', key: 'wheelW0', bits: 8, min: -250, max: 250, autoRange: false },
    { kind: 'scalar', key: 'wheelW1', bits: 8, min: -250, max: 250, autoRange: false },
    { kind: 'scalar', key: 'wheelW2', bits: 8, min: -250, max: 250, autoRange: false },
    { kind: 'scalar', key: 'wheelW3', bits: 8, min: -250, max: 250, autoRange: false },
];

/** Wheel slots the vehicle motion template carries. */
export const VEHICLE_WHEEL_SLOTS = 4;

/**
 * Character motion — the same machinery for platformers and speedruns, where a
 * ghost is a runner rather than a car.
 *
 * `animId` is an index into a table the game owns; the replay layer neither
 * knows nor cares what it means, it just round-trips it exactly.
 */
export const CHARACTER_MOTION_CHANNELS: readonly ReplayChannel[] = [
    positionChannel('posX'),
    positionChannel('posY'),
    positionChannel('posZ'),
    { kind: 'scalar', key: 'yaw', bits: 12, min: -Math.PI, max: Math.PI, autoRange: false },
    { kind: 'scalar', key: 'speed', bits: 10, min: 0, max: 30, autoRange: false },
    { kind: 'bits', key: 'animId', bits: 6 },
];

/**
 * Input — recorded for validation, not for playback (design §8).
 *
 * Analog and digital coexist: a keyboard drives `steer` to exactly -1, 0, or +1
 * while a pad sweeps it continuously, and both encode the same way. `buttons`
 * is a `bits` channel rather than a scalar precisely because a bitfield must
 * survive the round trip exactly — a rounding error there is a phantom
 * handbrake, not a slightly-off number.
 *
 * 32 bits per transition, and input is piecewise constant, so the recorder
 * stores transitions rather than samples.
 */
export const INPUT_CHANNELS: readonly ReplayChannel[] = [
    { kind: 'scalar', key: 'steer', bits: 8, min: -1, max: 1, autoRange: false },
    { kind: 'scalar', key: 'throttle', bits: 8, min: 0, max: 1, autoRange: false },
    { kind: 'scalar', key: 'brake', bits: 8, min: 0, max: 1, autoRange: false },
    { kind: 'bits', key: 'buttons', bits: 8 },
];

/** Track names the built-in templates use. Games adding tracks pick their own. */
export const MOTION_TRACK = 'motion';
export const INPUT_TRACK = 'input';

/** Default motion sample rate. Smooth enough to interpolate, cheap enough to ignore. */
export const DEFAULT_MOTION_HZ = 15;
