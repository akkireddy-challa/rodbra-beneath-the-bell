/**
 * Time-addressed playback of a recorded run.
 *
 * Everything is addressed by ELAPSED RUN TIME, never by frame count or wall
 * clock. That single decision is what makes countdowns, pauses, restarts, and
 * differing frame rates fall out correctly instead of needing a special case
 * each: the caller advances its own race clock and asks the player where the
 * ghost was at that moment.
 *
 * Interpolation depends on how a track was recorded:
 *
 * - Regular tracks (motion) are Catmull-Rom for scalars and slerp for
 *   quaternions. Catmull-Rom uses four neighbouring samples and needs nothing
 *   extra stored, which is what lets 15 Hz motion look smooth through a corner
 *   where linear interpolation would visibly cut it.
 * - Transition-encoded tracks (input) are STEP. A button that was pressed at
 *   frame 40 was not half-pressed at frame 39, and interpolating a bitfield
 *   would be meaningless.
 */

import * as THREE from 'three';
import {
    channelStride,
    type ReplayTrack,
    type RunRecord,
} from 'engine/replay/ReplayTypes.js';

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/** Uniform Catmull-Rom through p1 and p2, with p0 and p3 as tangent context. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
        2 * p1
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
}

export class ReplayTrackReader {
    private readonly stridePerChannel: number[];
    /** Sample index at or before the playhead. */
    private index = 0;
    /** Fraction between `index` and `index + 1`. Always 0 for step tracks. */
    private fraction = 0;

    constructor(readonly track: ReplayTrack) {
        this.stridePerChannel = track.channels.map(channelStride);
    }

    /** Channel index for a key, or -1 when the track has no such channel. */
    indexOf(key: string): number {
        return this.track.channels.findIndex((channel) => channel.key === key);
    }

    get sampleCount(): number {
        return this.track.sampleCount;
    }

    /** True once the playhead is past the final sample. */
    isExhausted(): boolean {
        return this.track.sampleCount === 0 || this.index >= this.track.sampleCount - 1;
    }

    seek(elapsedMs: number): void {
        const count = this.track.sampleCount;
        if (count === 0) {
            this.index = 0;
            this.fraction = 0;
            return;
        }

        // Same form as the recorder's sample scheduling, so sample i lands back
        // on exactly the time it was captured at.
        const position = (Math.max(0, elapsedMs) * this.track.sampleRateHz) / 1000;

        if (this.track.frames === null) {
            const whole = Math.floor(position);
            if (whole >= count - 1) {
                this.index = count - 1;
                this.fraction = 0;
            } else {
                this.index = whole;
                this.fraction = position - whole;
            }
            return;
        }

        // Transition-encoded: hold the last transition at or before this frame.
        this.index = this.lastTransitionAtOrBefore(Math.floor(position));
        this.fraction = 0;
    }

    private lastTransitionAtOrBefore(frame: number): number {
        const frames = this.track.frames;
        if (!frames || frames.length === 0) return 0;
        let low = 0;
        let high = frames.length - 1;
        let best = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if ((frames[mid] ?? 0) <= frame) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return best;
    }

    private raw(channelIndex: number, sample: number, offset: number): number {
        const values = this.track.values[channelIndex];
        if (!values) return 0;
        const stride = this.stridePerChannel[channelIndex] ?? 1;
        const clamped = Math.min(Math.max(sample, 0), this.track.sampleCount - 1);
        return values[clamped * stride + offset] ?? 0;
    }

    /**
     * Scalar read for Catmull-Rom, EXTRAPOLATING past either end.
     *
     * Catmull-Rom needs a sample on each side of the segment it is drawing, and
     * the first and last segments have none. Duplicating the endpoint is the
     * obvious answer and a measurably bad one: the tangent at p1 is
     * `(p2 - p0) / 2`, so setting `p0 = p1` halves it and the curve leaves the
     * start too slowly. On a 50 m circle sampled at 15 Hz that single segment
     * carried 0.115 m of error while every other point in a nine-second run
     * stayed under 0.02 m.
     *
     * Reflecting instead — `p0 = 2*p1 - p2` — preserves the tangent and makes
     * the end segments behave like the interior.
     */
    private rawExtrapolated(channelIndex: number, sample: number): number {
        const last = this.track.sampleCount - 1;
        if (sample < 0) {
            return 2 * this.raw(channelIndex, 0, 0) - this.raw(channelIndex, 1, 0);
        }
        if (sample > last) {
            return 2 * this.raw(channelIndex, last, 0) - this.raw(channelIndex, last - 1, 0);
        }
        return this.raw(channelIndex, sample, 0);
    }

    /** Interpolated scalar value for a channel at the current playhead. */
    scalar(channelIndex: number): number {
        if (this.track.sampleCount === 0) return 0;
        if (this.fraction === 0) return this.raw(channelIndex, this.index, 0);
        // Below three samples there is no curve to fit; fall back to linear.
        if (this.track.sampleCount < 3) {
            const a = this.raw(channelIndex, this.index, 0);
            const b = this.raw(channelIndex, this.index + 1, 0);
            return a + (b - a) * this.fraction;
        }
        return catmullRom(
            this.rawExtrapolated(channelIndex, this.index - 1),
            this.rawExtrapolated(channelIndex, this.index),
            this.rawExtrapolated(channelIndex, this.index + 1),
            this.rawExtrapolated(channelIndex, this.index + 2),
            this.fraction,
        );
    }

    /** Raw stored value with no interpolation — for bitfields and enum indices. */
    exact(channelIndex: number): number {
        return this.raw(channelIndex, this.index, 0);
    }

    /** Slerped quaternion for a quat channel at the current playhead. */
    quaternion(channelIndex: number, out: THREE.Quaternion): THREE.Quaternion {
        if (this.track.sampleCount === 0) return out.identity();
        _qa.set(
            this.raw(channelIndex, this.index, 0),
            this.raw(channelIndex, this.index, 1),
            this.raw(channelIndex, this.index, 2),
            this.raw(channelIndex, this.index, 3),
        );
        if (this.fraction === 0) return out.copy(_qa);
        _qb.set(
            this.raw(channelIndex, this.index + 1, 0),
            this.raw(channelIndex, this.index + 1, 1),
            this.raw(channelIndex, this.index + 1, 2),
            this.raw(channelIndex, this.index + 1, 3),
        );
        return out.copy(_qa).slerp(_qb, this.fraction);
    }

    /** Three consecutive scalar channels read as a vector. */
    vector3(xIndex: number, yIndex: number, zIndex: number, out: THREE.Vector3): THREE.Vector3 {
        return out.set(this.scalar(xIndex), this.scalar(yIndex), this.scalar(zIndex));
    }
}

export class ReplayPlayer {
    private readonly readers = new Map<string, ReplayTrackReader>();

    constructor(private readonly run: RunRecord) {
        for (const track of run.tracks) {
            this.readers.set(track.name, new ReplayTrackReader(track));
        }
    }

    getTrack(name: string): ReplayTrackReader | null {
        return this.readers.get(name) ?? null;
    }

    /** Position every track at the same moment in the run. */
    seek(elapsedMs: number): void {
        for (const reader of this.readers.values()) reader.seek(elapsedMs);
    }

    /** True once the run clock has passed the recorded duration. */
    isFinished(elapsedMs: number): boolean {
        return elapsedMs >= this.run.durationMs;
    }
}
