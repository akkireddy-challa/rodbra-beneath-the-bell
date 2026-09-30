/**
 * Replay format types — the wire contract for a recorded run ("ghost").
 *
 * A run is a set of TRACKS. Each track carries its own sample rate and its own
 * list of CHANNELS, because motion and input want different rates: motion is
 * sampled regularly and only needs enough resolution to look right, while input
 * is transition-encoded at simulation rate so it stays useful for validating a
 * suspiciously good lap.
 *
 * The encoded form is SELF-DESCRIBING — channel definitions travel with the
 * data. Ghosts are permanent and publicly readable, so a client must be able to
 * decode a run recorded by a build whose channel set has since changed.
 * Per-channel overhead is a few bytes once per run, against a payload measured
 * in kilobytes.
 *
 * See docs/ghost-racing-design.md §4-5.
 */

/** Bumped on any change that makes existing encoded runs undecodable. */
export const REPLAY_FORMAT_VERSION = 1;

/** 'BMRP' — leading bytes of every encoded run, so a wrong blob fails loudly. */
export const REPLAY_MAGIC = 0x424d5250;

/**
 * A continuous value, quantized into `bits` across `[min, max]`.
 *
 * `autoRange` defers the range to pack time, where it is computed from the
 * samples themselves and stored in the run header. Use it whenever the range is
 * a property of the level rather than of the quantity — position above all.
 * Absolute quantization against a per-run bounding box beats delta encoding
 * here: no escape code for teleports and respawns, no error accumulation, and
 * structure-of-arrays plus gzip recovers most of what deltas would have saved,
 * because the high bits of neighbouring samples are near-constant.
 */
export interface ReplayScalarChannel {
    kind: 'scalar';
    key: string;
    bits: number;
    /** Ignored when `autoRange` is true. */
    min: number;
    /** Ignored when `autoRange` is true. */
    max: number;
    autoRange: boolean;
}

/**
 * An unsigned integer stored verbatim in `bits`, with no quantization.
 *
 * For values where the float round-trip would be a footgun rather than a
 * convenience: button bitfields, enum indices, anything where an off-by-one
 * from rounding is a bug rather than imprecision.
 */
export interface ReplayBitsChannel {
    kind: 'bits';
    key: string;
    bits: number;
}

/**
 * A unit quaternion, stored smallest-three: the largest-magnitude component is
 * dropped and rebuilt on decode, since a unit quaternion has only three degrees
 * of freedom. Costs `2 + 3 * componentBits`.
 *
 * At 10 bits per component the worst-case rotation error is about 0.19 degrees
 * (measured; see ReplayCodec.test.ts for the derivation). That is far below
 * what reads on a translucent, interpolated ghost — the extra 3 bits per sample
 * for 11-bit components would buy precision nobody can see.
 */
export interface ReplayQuatChannel {
    kind: 'quat';
    key: string;
    componentBits: number;
}

export type ReplayChannel = ReplayScalarChannel | ReplayBitsChannel | ReplayQuatChannel;

/** Numbers occupied per sample by one channel. Quaternions decode to x,y,z,w. */
export function channelStride(channel: ReplayChannel): number {
    return channel.kind === 'quat' ? 4 : 1;
}

/** Bits occupied per sample by one channel. */
export function channelBits(channel: ReplayChannel): number {
    return channel.kind === 'quat' ? 2 + 3 * channel.componentBits : channel.bits;
}

/** Bits occupied per sample by a whole channel list — the per-sample budget. */
export function trackBitsPerSample(channels: readonly ReplayChannel[]): number {
    let total = 0;
    for (const channel of channels) total += channelBits(channel);
    return total;
}

/**
 * Numbers occupied per sample by a whole channel list.
 *
 * This is the length of the flat array a sampler fills: one slot per scalar or
 * bits channel, four per quaternion, in channel order.
 */
export function trackStride(channels: readonly ReplayChannel[]): number {
    let total = 0;
    for (const channel of channels) total += channelStride(channel);
    return total;
}

export interface ReplayTrack {
    /** Identifies the track to consumers, e.g. 'motion' or 'input'. */
    name: string;
    /**
     * Nominal rate. For a regularly sampled track this is the playback rate.
     * For a transition-encoded track it is the rate `frames` counts against.
     */
    sampleRateHz: number;
    channels: ReplayChannel[];
    /**
     * Frame index per sample, for transition-encoded tracks. `null` means
     * regular sampling, where sample i sits at frame i.
     */
    frames: number[] | null;
    /**
     * Sample values, one array per channel — structure-of-arrays, which is what
     * makes the payload compress. Each array holds
     * `sampleCount * channelStride(channel)` numbers.
     */
    values: number[][];
    sampleCount: number;
}

export interface RunRecord {
    formatVersion: number;
    /** Wall-clock length of the run. Playback is addressed against this. */
    durationMs: number;
    tracks: ReplayTrack[];
}

/** Thrown for any malformed or unsupported encoded run. */
export class ReplayFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReplayFormatError';
    }
}
