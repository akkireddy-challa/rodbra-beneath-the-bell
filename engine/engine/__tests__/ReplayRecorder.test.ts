/**
 * Recorder tests.
 *
 * Driven by fake samplers and a hand-stepped clock — no physics world, no
 * engine. The behaviours worth pinning are the ones that are easy to get subtly
 * wrong: sample-zero anchoring, rate independence from frame pacing, and input
 * transitions firing on QUANTIZED change rather than raw float change.
 */

import {
    DEFAULT_REPLAY_RECORDER_OPTIONS,
    ReplayRecorder,
    type ReplayRecorderOptions,
    type ReplaySampleFn,
} from 'engine/replay/ReplayRecorder.js';
import {
    createInputSampler,
    createVehicleMotionSampler,
    type ReplayInputSnapshot,
    type ReplayVehicleSubject,
} from 'engine/replay/ReplaySubjects.js';
import {
    INPUT_CHANNELS,
    INPUT_TRACK,
    MOTION_TRACK,
    VEHICLE_MOTION_CHANNELS,
} from 'engine/replay/ReplayChannels.js';
import { ReplayFormatError, trackStride } from 'engine/replay/ReplayTypes.js';
import { decodeRun, encodeRun } from 'engine/replay/ReplayCodec.js';

function options(overrides: Partial<ReplayRecorderOptions> = {}): ReplayRecorderOptions {
    return { ...DEFAULT_REPLAY_RECORDER_OPTIONS, ...overrides };
}

/** Motion sampler that writes a monotonically increasing counter into every slot. */
function countingSampler(state: { tick: number }): ReplaySampleFn {
    return (out: number[]): void => {
        for (let i = 0; i < out.length; i++) out[i] = state.tick;
        state.tick++;
    };
}

function trackNamed(record: { tracks: { name: string }[] }, name: string): number {
    const index = record.tracks.findIndex((t) => t.name === name);
    if (index < 0) throw new Error(`no '${name}' track`);
    return index;
}

describe('ReplayRecorder motion sampling', () => {
    test('sample zero is captured at start, before any update', () => {
        const state = { tick: 0 };
        const recorder = new ReplayRecorder(options({ inputChannels: null }), countingSampler(state), null);
        recorder.start();
        expect(recorder.getMotionSampleCount()).toBe(1);
        expect(recorder.stop().tracks[0]?.sampleCount).toBe(1);
    });

    test('sample count follows elapsed time, not frame count', () => {
        // Same two seconds, wildly different frame pacing: 120 tiny steps
        // versus 8 chunky ones. A ghost must not depend on the recorder's
        // frame rate.
        const runAt = (steps: number): number => {
            const state = { tick: 0 };
            const recorder = new ReplayRecorder(options({ inputChannels: null }), countingSampler(state), null);
            recorder.start();
            for (let i = 0; i < steps; i++) recorder.update(2 / steps);
            return recorder.getMotionSampleCount();
        };
        // 15 Hz over 2 s: sample zero plus 30.
        expect(runAt(120)).toBe(31);
        expect(runAt(8)).toBe(31);
    });

    test('a single oversized step emits every sample it spans', () => {
        // A 1 s hitch at 15 Hz owes 15 samples; dropping them would leave a
        // hole the player would have to interpolate across.
        const state = { tick: 0 };
        const recorder = new ReplayRecorder(options({ inputChannels: null }), countingSampler(state), null);
        recorder.start();
        recorder.update(1.0);
        expect(recorder.getMotionSampleCount()).toBe(16);
    });

    test('duration reflects the clock, and values land in channel order', () => {
        const state = { tick: 0 };
        const recorder = new ReplayRecorder(options({ inputChannels: null }), countingSampler(state), null);
        recorder.start();
        for (let i = 0; i < 30; i++) recorder.update(1 / 30);
        const run = recorder.stop();

        expect(run.durationMs).toBe(1000);
        const motion = run.tracks[trackNamed(run, MOTION_TRACK)];
        expect(motion?.frames).toBeNull();
        // posX holds one number per sample; rot holds four.
        expect(motion?.values[0]).toHaveLength(motion?.sampleCount ?? 0);
        expect(motion?.values[3]).toHaveLength((motion?.sampleCount ?? 0) * 4);
    });

    test('update before start records nothing', () => {
        const state = { tick: 0 };
        const recorder = new ReplayRecorder(options({ inputChannels: null }), countingSampler(state), null);
        recorder.update(5);
        expect(recorder.getMotionSampleCount()).toBe(0);
        expect(recorder.isRecording()).toBe(false);
    });

    test('start discards a previous run', () => {
        const state = { tick: 0 };
        const recorder = new ReplayRecorder(options({ inputChannels: null }), countingSampler(state), null);
        recorder.start();
        for (let i = 0; i < 30; i++) recorder.update(1 / 30);
        recorder.start();
        expect(recorder.getMotionSampleCount()).toBe(1);
        expect(recorder.getElapsedMs()).toBe(0);
    });

    test('a negative or non-finite step is ignored rather than rewinding the clock', () => {
        const state = { tick: 0 };
        const recorder = new ReplayRecorder(options({ inputChannels: null }), countingSampler(state), null);
        recorder.start();
        recorder.update(1);
        const elapsed = recorder.getElapsedMs();
        recorder.update(-5);
        recorder.update(Number.NaN);
        expect(recorder.getElapsedMs()).toBe(elapsed);
    });
});

describe('ReplayRecorder truncation', () => {
    test('hitting the cap stops sampling and says so out loud', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const state = { tick: 0 };
        const recorder = new ReplayRecorder(
            options({ inputChannels: null, maxDurationMs: 1000 }),
            countingSampler(state),
            null,
        );
        recorder.start();
        for (let i = 0; i < 60; i++) recorder.update(1 / 30);

        expect(recorder.isTruncated()).toBe(true);
        expect(recorder.isRecording()).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
        warn.mockRestore();
    });
});

describe('ReplayRecorder input transitions', () => {
    function inputRecorder(read: () => ReplayInputSnapshot): ReplayRecorder {
        return new ReplayRecorder(
            options({ inputHz: 60 }),
            () => { /* motion not under test */ },
            createInputSampler(read),
        );
    }

    test('held input records one transition, not one per poll', () => {
        const held: ReplayInputSnapshot = { steer: 0, throttle: 1, brake: 0, buttons: 0 };
        const recorder = inputRecorder(() => held);
        recorder.start();
        for (let i = 0; i < 120; i++) recorder.update(1 / 60);
        // Two seconds of unchanged input is a single stored sample.
        expect(recorder.getInputTransitionCount()).toBe(1);
    });

    test('each change records exactly one transition', () => {
        const state: ReplayInputSnapshot = { steer: 0, throttle: 0, brake: 0, buttons: 0 };
        const recorder = inputRecorder(() => state);
        recorder.start();
        for (let i = 0; i < 60; i++) {
            if (i === 10) state.throttle = 1;
            if (i === 20) state.steer = -1;
            if (i === 30) state.buttons = 0b101;
            if (i === 40) state.throttle = 0;
            recorder.update(1 / 60);
        }
        // Sample zero plus four changes.
        expect(recorder.getInputTransitionCount()).toBe(5);
    });

    test('analog jitter below the quantization step records nothing', () => {
        // The reason change detection compares QUANTIZED values: an 8-bit
        // steer channel over [-1,1] has a step of ~0.0078, so drift far below
        // that is not a transition. Comparing raw floats would store 120.
        let steer = 0.5;
        const recorder = inputRecorder(() => ({ steer, throttle: 0, brake: 0, buttons: 0 }));
        recorder.start();
        for (let i = 0; i < 120; i++) {
            steer += 1e-6;
            recorder.update(1 / 60);
        }
        expect(recorder.getInputTransitionCount()).toBe(1);
    });

    test('analog movement above the step does record', () => {
        let steer = -1;
        const recorder = inputRecorder(() => ({ steer, throttle: 0, brake: 0, buttons: 0 }));
        recorder.start();
        for (let i = 0; i < 60; i++) {
            steer += 2 / 60;
            recorder.update(1 / 60);
        }
        expect(recorder.getInputTransitionCount()).toBeGreaterThan(50);
    });

    test('frame indices are strictly increasing and match the input rate', () => {
        const state: ReplayInputSnapshot = { steer: 0, throttle: 0, brake: 0, buttons: 0 };
        const recorder = inputRecorder(() => state);
        recorder.start();
        for (let i = 0; i < 60; i++) {
            state.buttons = i;
            recorder.update(1 / 60);
        }
        const run = recorder.stop();
        const frames = run.tracks[trackNamed(run, INPUT_TRACK)]?.frames ?? [];
        expect(frames.length).toBeGreaterThan(1);
        for (let i = 1; i < frames.length; i++) {
            expect(frames[i] ?? 0).toBeGreaterThan(frames[i - 1] ?? 0);
        }
        expect(frames[frames.length - 1]).toBeLessThanOrEqual(60);
    });

    test('an input track is omitted entirely when not configured', () => {
        const recorder = new ReplayRecorder(options({ inputChannels: null }), () => { /* noop */ }, null);
        recorder.start();
        recorder.update(1);
        const run = recorder.stop();
        expect(run.tracks.map((t) => t.name)).toEqual([MOTION_TRACK]);
    });

    test('an autoRange input channel is rejected at construction', () => {
        expect(() => new ReplayRecorder(
            options({
                inputChannels: [{ kind: 'scalar', key: 'bad', bits: 8, min: 0, max: 0, autoRange: true }],
            }),
            () => { /* noop */ },
            () => { /* noop */ },
        )).toThrow(ReplayFormatError);
    });
});

describe('vehicle subject adapter', () => {
    function fakeVehicle(): ReplayVehicleSubject & { pos: { x: number; y: number; z: number } } {
        const pos = { x: 1, y: 2, z: 3 };
        return {
            pos,
            getPosition: () => ({ x: pos.x, y: pos.y, z: pos.z }) as unknown as THREE.Vector3,
            getChassisObject: () => ({ quaternion: { x: 0, y: 0, z: 0, w: 1 } }) as unknown as THREE.Object3D,
            getForwardSpeed: () => 12.5,
            getSteeringAngle: () => -0.25,
            getWheelCount: () => 4,
            getWheelRotation: () => 0,
        };
    }

    test('fills exactly the slots the channel template declares', () => {
        const out = new Array<number>(trackStride(VEHICLE_MOTION_CHANNELS)).fill(NaN);
        createVehicleMotionSampler(fakeVehicle())(out, 1 / 60);
        expect(out).toHaveLength(13);
        expect(out.every((v) => Number.isFinite(v))).toBe(true);
        expect(out.slice(0, 3)).toEqual([1, 2, 3]);
        expect(out.slice(3, 7)).toEqual([0, 0, 0, 1]);
        expect(out[7]).toBe(-0.25);
        expect(out[8]).toBe(12.5);
        // First poll has no previous angle to differentiate against.
        expect(out.slice(9)).toEqual([0, 0, 0, 0]);
    });

    test('the input adapter fills the slots its template declares', () => {
        const out = new Array<number>(trackStride(INPUT_CHANNELS)).fill(NaN);
        createInputSampler(() => ({ steer: -1, throttle: 0.5, brake: 0, buttons: 0b1010 }))(out, 0);
        expect(out).toEqual([-1, 0.5, 0, 0b1010]);
    });
});

describe('recorder output survives the codec', () => {
    test('a recorded run encodes, decodes, and keeps its motion path', async () => {
        const vehicle = {
            t: 0,
            getPosition(): THREE.Vector3 {
                return { x: Math.cos(this.t) * 50, y: 1, z: Math.sin(this.t) * 50 } as unknown as THREE.Vector3;
            },
            getChassisObject: (): THREE.Object3D =>
                ({ quaternion: { x: 0, y: 0, z: 0, w: 1 } }) as unknown as THREE.Object3D,
            getForwardSpeed: (): number => 25,
            getSteeringAngle: (): number => 0.1,
            getWheelCount: (): number => 4,
            getWheelRotation: function (): number { return this.t * 71.4; },
        };
        const recorder = new ReplayRecorder(
            options({ inputChannels: null }),
            createVehicleMotionSampler(vehicle),
            null,
        );
        recorder.start();
        for (let i = 0; i < 300; i++) {
            vehicle.t += 0.02;
            recorder.update(1 / 60);
        }
        const run = recorder.stop();
        const decoded = await decodeRun(await encodeRun(run));

        expect(decoded.durationMs).toBe(run.durationMs);
        const before = run.tracks[0]?.values[0] ?? [];
        const after = decoded.tracks[0]?.values[0] ?? [];
        expect(after).toHaveLength(before.length);
        for (let i = 0; i < before.length; i++) {
            expect(Math.abs((after[i] ?? 0) - (before[i] ?? 0))).toBeLessThan(0.01);
        }
    });
});
