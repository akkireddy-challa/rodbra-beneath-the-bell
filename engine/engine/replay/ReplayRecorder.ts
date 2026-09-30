/**
 * Records a run: regular motion samples plus transition-encoded input.
 *
 * The recorder knows nothing about vehicles, characters, or the engine. It
 * takes SAMPLER functions that fill a flat array in channel order, which keeps
 * it unit-testable without a physics world and lets a game record anything it
 * can read. Adapters for the built-in templates live in ReplaySubjects.
 *
 * Two rates, one clock (design §4): motion is emitted at a fixed interval for
 * playback, while input is polled at simulation rate and stored only when it
 * CHANGES, because digital input is piecewise constant and per-sample storage
 * would be almost entirely repeats.
 */

import {
    channelStride,
    trackStride,
    type ReplayChannel,
    type ReplayTrack,
    type RunRecord,
    REPLAY_FORMAT_VERSION,
    ReplayFormatError,
} from 'engine/replay/ReplayTypes.js';
import { quantize } from 'engine/replay/ReplayCodec.js';
import {
    DEFAULT_MOTION_HZ,
    INPUT_CHANNELS,
    INPUT_TRACK,
    MOTION_TRACK,
    VEHICLE_MOTION_CHANNELS,
} from 'engine/replay/ReplayChannels.js';

/**
 * Fills `out` with one sample's worth of values, in channel order.
 *
 * `deltaTime` (seconds) is the interval since the previous poll, for samplers
 * that must DIFFERENTIATE to produce their value — wheel angular velocity from
 * an accumulated rotation angle being the motivating case. It is 0 on the very
 * first poll, where no interval exists yet.
 */
export type ReplaySampleFn = (out: number[], deltaTime: number) => void;

export interface ReplayRecorderOptions {
    motionChannels: readonly ReplayChannel[];
    motionHz: number;
    /** `null` records no input track — playback still works, validation does not. */
    inputChannels: readonly ReplayChannel[] | null;
    /** Poll rate for input. Transitions are timestamped against this. */
    inputHz: number;
    /**
     * Hard cap on run length. A recorder left running by a game that never
     * calls `stop()` must not grow without bound; hitting the cap stops
     * sampling and is reported by `isTruncated()` rather than passing silently.
     */
    maxDurationMs: number;
}

export const DEFAULT_REPLAY_RECORDER_OPTIONS: ReplayRecorderOptions = {
    motionChannels: VEHICLE_MOTION_CHANNELS,
    motionHz: DEFAULT_MOTION_HZ,
    inputChannels: INPUT_CHANNELS,
    inputHz: 60,
    maxDurationMs: 15 * 60 * 1000,
};

/**
 * Quantized form of a sample, used only to decide whether input CHANGED.
 *
 * Comparing raw floats would make an analog stick emit a transition every
 * single poll, defeating the encoding. Comparing quantized values means a
 * transition is recorded exactly when the stored data would differ.
 */
function quantizedKey(channels: readonly ReplayChannel[], values: number[]): string {
    const parts: number[] = [];
    let offset = 0;
    for (const channel of channels) {
        if (channel.kind === 'quat') {
            // Quaternions in an input track are unusual; compare coarsely.
            for (let i = 0; i < 4; i++) parts.push(Math.round((values[offset + i] ?? 0) * 1000));
            offset += 4;
        } else if (channel.kind === 'bits') {
            parts.push((values[offset] ?? 0) >>> 0);
            offset += 1;
        } else {
            parts.push(quantize(values[offset] ?? 0, channel.min, channel.max, channel.bits));
            offset += 1;
        }
    }
    return parts.join(',');
}

/**
 * Blend two polled states toward a scheduled sample time.
 *
 * Quaternion channels are hemisphere-corrected before blending: `q` and `-q`
 * are the same rotation, so a component-wise blend across the sign boundary
 * would swing through zero. Adjacent frames are close enough that a normalized
 * linear blend matches slerp to well under the quantization step, and the codec
 * normalizes on pack anyway.
 */
function blendStates(
    channels: readonly ReplayChannel[],
    from: number[],
    to: number[],
    alpha: number,
    out: number[],
): void {
    let offset = 0;
    for (const channel of channels) {
        const stride = channelStride(channel);
        if (channel.kind === 'quat') {
            let dot = 0;
            for (let i = 0; i < 4; i++) dot += (from[offset + i] ?? 0) * (to[offset + i] ?? 0);
            const sign = dot < 0 ? -1 : 1;
            for (let i = 0; i < 4; i++) {
                const a = from[offset + i] ?? 0;
                const b = (to[offset + i] ?? 0) * sign;
                out[offset + i] = a + (b - a) * alpha;
            }
        } else {
            const a = from[offset] ?? 0;
            const b = to[offset] ?? 0;
            out[offset] = a + (b - a) * alpha;
        }
        offset += stride;
    }
}

interface TrackBuffer {
    channels: readonly ReplayChannel[];
    values: number[][];
    frames: number[] | null;
    sampleCount: number;
}

function makeBuffer(channels: readonly ReplayChannel[], transitionEncoded: boolean): TrackBuffer {
    return {
        channels,
        values: channels.map(() => []),
        frames: transitionEncoded ? [] : null,
        sampleCount: 0,
    };
}

function appendSample(buffer: TrackBuffer, values: number[], frame: number | null): void {
    let offset = 0;
    for (let i = 0; i < buffer.channels.length; i++) {
        const channel = buffer.channels[i];
        if (channel === undefined) continue;
        const target = buffer.values[i];
        if (target === undefined) continue;
        const stride = channelStride(channel);
        for (let s = 0; s < stride; s++) target.push(values[offset + s] ?? 0);
        offset += stride;
    }
    if (buffer.frames !== null && frame !== null) buffer.frames.push(frame);
    buffer.sampleCount++;
}

function toTrack(name: string, sampleRateHz: number, buffer: TrackBuffer): ReplayTrack {
    return {
        name,
        sampleRateHz,
        channels: [...buffer.channels],
        frames: buffer.frames,
        values: buffer.values,
        sampleCount: buffer.sampleCount,
    };
}

export class ReplayRecorder {
    private readonly options: ReplayRecorderOptions;
    private readonly motionSampler: ReplaySampleFn;
    private readonly inputSampler: ReplaySampleFn | null;

    private readonly motionScratch: number[];
    private readonly inputScratch: number[];
    /** Motion state polled at the previous update, and the time it was polled. */
    private readonly previousMotion: number[];
    private readonly blendScratch: number[];
    private previousMotionMs = 0;

    private motion: TrackBuffer;
    private input: TrackBuffer | null;

    private recording = false;
    private truncated = false;
    private elapsedMs = 0;
    private inputFrame = 0;
    private lastInputKey: string | null = null;

    constructor(
        options: ReplayRecorderOptions,
        motionSampler: ReplaySampleFn,
        inputSampler: ReplaySampleFn | null,
    ) {
        if (options.motionHz <= 0 || options.inputHz <= 0) {
            throw new ReplayFormatError('ReplayRecorder: sample rates must be positive');
        }
        if (options.inputChannels) {
            for (const channel of options.inputChannels) {
                if (channel.kind === 'scalar' && channel.autoRange) {
                    // Change detection quantizes against the channel range, and
                    // an autoRange channel has none until pack time — every poll
                    // would look identical and no transition would ever record.
                    throw new ReplayFormatError(
                        `ReplayRecorder: input channel '${channel.key}' cannot use autoRange`,
                    );
                }
            }
        }

        this.options = options;
        this.motionSampler = motionSampler;
        this.inputSampler = options.inputChannels ? inputSampler : null;

        const motionStride = trackStride(options.motionChannels);
        this.motionScratch = new Array<number>(motionStride).fill(0);
        this.previousMotion = new Array<number>(motionStride).fill(0);
        this.blendScratch = new Array<number>(motionStride).fill(0);
        this.inputScratch = new Array<number>(
            options.inputChannels ? trackStride(options.inputChannels) : 0,
        ).fill(0);

        this.motion = makeBuffer(options.motionChannels, false);
        this.input = options.inputChannels ? makeBuffer(options.inputChannels, true) : null;
    }

    /** Begin a run, discarding anything previously recorded. */
    start(): void {
        this.motion = makeBuffer(this.options.motionChannels, false);
        this.input = this.options.inputChannels ? makeBuffer(this.options.inputChannels, true) : null;
        this.recording = true;
        this.truncated = false;
        this.elapsedMs = 0;
        this.inputFrame = 0;
        this.lastInputKey = null;

        // Sample zero anchors playback: a ghost must have a pose at t=0 rather
        // than popping into existence one interval later.
        this.motionSampler(this.motionScratch, 0);
        appendSample(this.motion, this.motionScratch, null);
        for (let i = 0; i < this.motionScratch.length; i++) {
            this.previousMotion[i] = this.motionScratch[i] ?? 0;
        }
        this.previousMotionMs = 0;
        this.captureInput();
    }

    /** Advance the run clock. `deltaTime` is in SECONDS, matching the engine loop. */
    update(deltaTime: number): void {
        if (!this.recording) return;
        const deltaMs = deltaTime * 1000;
        if (!Number.isFinite(deltaMs) || deltaMs < 0) return;

        if (this.elapsedMs + deltaMs > this.options.maxDurationMs) {
            if (!this.truncated) {
                this.truncated = true;
                console.warn(
                    `[ReplayRecorder] run exceeded ${this.options.maxDurationMs} ms — sampling stopped, `
                    + 'the recorded run is truncated',
                );
            }
            this.recording = false;
            return;
        }

        this.elapsedMs += deltaMs;

        // The subject is polled EVERY update, not only when a sample is due.
        //
        // Sampling only on due-frames looks cheaper but is wrong: the pose read
        // at the first update past the deadline gets stamped as if it happened
        // ON the deadline, skewing the whole track by up to one frame. At
        // racing speeds that measured as half a metre of ghost displacement,
        // and the size of the error depended on the recorder's frame rate.
        // Polling every frame lets each sample be interpolated to the exact
        // time it claims to represent.
        this.motionSampler(this.motionScratch, deltaTime);

        // Sample counts are derived from ABSOLUTE elapsed time, never from a
        // subtractive accumulator. Two reasons, both load-bearing:
        //
        // - An accumulator drifts. The same two seconds delivered as 8 chunky
        //   frames versus 120 small ones produced a different sample count,
        //   because the repeated `-= interval` accumulates float error.
        // - Playback addresses motion samples as `sample i is at i / motionHz`.
        //   That mapping has to be exact, not approximately maintained.
        //
        // The count is computed as `elapsed * hz / 1000` rather than
        // `elapsed / (1000 / hz)`: the former keeps whole-second boundaries on
        // exact integers, while the latter lands on 29.999999999999996 and
        // silently drops the sample.
        const motionTarget = Math.floor((this.elapsedMs * this.options.motionHz) / 1000) + 1;
        const span = this.elapsedMs - this.previousMotionMs;
        while (this.motion.sampleCount < motionTarget) {
            const sampleTimeMs = (this.motion.sampleCount * 1000) / this.options.motionHz;
            const raw = span > 0 ? (sampleTimeMs - this.previousMotionMs) / span : 1;
            const alpha = raw < 0 ? 0 : raw > 1 ? 1 : raw;
            blendStates(
                this.options.motionChannels,
                this.previousMotion,
                this.motionScratch,
                alpha,
                this.blendScratch,
            );
            appendSample(this.motion, this.blendScratch, null);
        }
        for (let i = 0; i < this.motionScratch.length; i++) {
            this.previousMotion[i] = this.motionScratch[i] ?? 0;
        }
        this.previousMotionMs = this.elapsedMs;

        const inputTarget = Math.floor((this.elapsedMs * this.options.inputHz) / 1000);
        while (this.inputFrame < inputTarget) {
            this.inputFrame++;
            this.captureInput();
        }
    }

    /** End the run and hand back the record. Safe to call when not recording. */
    stop(): RunRecord {
        this.recording = false;
        const tracks: ReplayTrack[] = [toTrack(MOTION_TRACK, this.options.motionHz, this.motion)];
        if (this.input) tracks.push(toTrack(INPUT_TRACK, this.options.inputHz, this.input));
        return {
            formatVersion: REPLAY_FORMAT_VERSION,
            durationMs: Math.round(this.elapsedMs),
            tracks,
        };
    }

    isRecording(): boolean {
        return this.recording;
    }

    /** True when the run hit `maxDurationMs` and stopped early. */
    isTruncated(): boolean {
        return this.truncated;
    }

    getElapsedMs(): number {
        return this.elapsedMs;
    }

    getMotionSampleCount(): number {
        return this.motion.sampleCount;
    }

    getInputTransitionCount(): number {
        return this.input?.sampleCount ?? 0;
    }

    private captureInput(): void {
        if (!this.input || !this.inputSampler) return;
        this.inputSampler(this.inputScratch, 0);
        const key = quantizedKey(this.input.channels, this.inputScratch);
        if (key === this.lastInputKey) return;
        this.lastInputKey = key;
        appendSample(this.input, this.inputScratch, this.inputFrame);
    }
}
