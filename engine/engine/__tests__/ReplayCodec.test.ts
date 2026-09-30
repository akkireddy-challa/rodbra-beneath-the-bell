/**
 * Codec round-trip tests.
 *
 * The bar here is not "it runs" but "the error it introduces is the error we
 * chose". Quantization is lossy by design, so every assertion below states the
 * tolerance the channel template is claiming, and a template change that
 * silently costs precision should fail these.
 */

import { BitReader, BitWriter } from 'engine/replay/ReplayBits.js';
import {
    dequantize,
    decodeRun,
    decodeRunBytes,
    encodeRun,
    encodeRunBytes,
    packQuat,
    packRun,
    packedSizeBytes,
    quantize,
    trackPayloadBits,
    trackStoredBytes,
    unpackQuat,
    unpackRun,
} from 'engine/replay/ReplayCodec.js';
import {
    DEFAULT_MOTION_HZ,
    INPUT_CHANNELS,
    INPUT_TRACK,
    MOTION_TRACK,
    VEHICLE_MOTION_CHANNELS,
} from 'engine/replay/ReplayChannels.js';
import {
    REPLAY_FORMAT_VERSION,
    ReplayFormatError,
    channelStride,
    type ReplayTrack,
    type RunRecord,
} from 'engine/replay/ReplayTypes.js';

// === Helpers ===

/** A deterministic pseudo-random source — reproducible failures matter more than entropy. */
function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

/** Appends to one channel's array, past the index guard `noUncheckedIndexedAccess` demands. */
function pusher(values: number[][]): (index: number, ...v: number[]) => void {
    return (index, ...v) => { values[index]?.push(...v); };
}

/** A plausible lap: a car driving a loop with body motion, not random noise. */
function syntheticVehicleTrack(sampleCount: number): ReplayTrack {
    const values: number[][] = VEHICLE_MOTION_CHANNELS.map(() => []);
    const push = pusher(values);
    for (let i = 0; i < sampleCount; i++) {
        const angle = (i / sampleCount) * Math.PI * 2;
        push(0, Math.cos(angle) * 220);
        push(1, 4 + Math.sin(angle * 3) * 1.5);
        push(2, Math.sin(angle) * 180);
        const half = angle / 2;
        push(3, 0, Math.sin(half), 0, Math.cos(half));
        push(4, Math.sin(angle * 4) * 0.5);
        push(5, 30 + Math.sin(angle * 2) * 15);
        for (let w = 0; w < 4; w++) push(6 + w, 90 + Math.sin(angle * 5 + w) * 40);
    }
    return {
        name: MOTION_TRACK,
        sampleRateHz: DEFAULT_MOTION_HZ,
        channels: [...VEHICLE_MOTION_CHANNELS],
        frames: null,
        values,
        sampleCount,
    };
}

/** Transition-encoded input: sparse, irregular frames, mixed analog and digital. */
function syntheticInputTrack(transitions: number, frameSpacing: number): ReplayTrack {
    const random = makeRandom(999);
    const frames: number[] = [];
    const values: number[][] = INPUT_CHANNELS.map(() => []);
    const push = pusher(values);
    let frame = 0;
    for (let i = 0; i < transitions; i++) {
        frame += 1 + Math.floor(random() * frameSpacing);
        frames.push(frame);
        push(0, random() * 2 - 1);
        push(1, random());
        push(2, random() < 0.2 ? 1 : 0);
        push(3, Math.floor(random() * 256));
    }
    return {
        name: INPUT_TRACK,
        sampleRateHz: 60,
        channels: [...INPUT_CHANNELS],
        frames,
        values,
        sampleCount: transitions,
    };
}

function makeRun(tracks: ReplayTrack[], durationMs: number): RunRecord {
    return { formatVersion: REPLAY_FORMAT_VERSION, durationMs, tracks };
}

function channelIndex(track: ReplayTrack, key: string): number {
    const index = track.channels.findIndex((c) => c.key === key);
    if (index < 0) throw new Error(`no channel '${key}'`);
    return index;
}

/** Largest absolute error between two sample arrays. */
function maxError(a: number[] | undefined, b: number[] | undefined): number {
    const left = a ?? [];
    const right = b ?? [];
    let worst = 0;
    for (let i = 0; i < left.length; i++) {
        worst = Math.max(worst, Math.abs((left[i] ?? 0) - (right[i] ?? 0)));
    }
    return worst;
}

// === Bit plumbing ===

describe('BitWriter / BitReader', () => {
    test('round-trips arbitrary bit widths in order', () => {
        const widths = [1, 2, 3, 5, 7, 8, 11, 13, 16, 17, 24, 31, 32];
        const random = makeRandom(7);
        const written = widths.map((bits) => Math.floor(random() * Math.pow(2, bits)));

        const writer = new BitWriter();
        widths.forEach((bits, i) => writer.writeBits(written[i], bits));
        const reader = new BitReader(writer.toUint8Array());

        widths.forEach((bits, i) => expect(reader.readBits(bits)).toBe(written[i]));
    });

    test('32-bit values survive the sign boundary', () => {
        const writer = new BitWriter();
        writer.writeBits(0xffffffff, 32);
        writer.writeBits(0x80000000, 32);
        const reader = new BitReader(writer.toUint8Array());
        expect(reader.readBits(32)).toBe(0xffffffff);
        expect(reader.readBits(32)).toBe(0x80000000);
    });

    test('byte-aligned fields interleave with bit fields', () => {
        const writer = new BitWriter();
        writer.writeBits(0b101, 3);
        writer.writeUint32(0xdeadbeef);
        writer.writeBits(0b11, 2);
        writer.writeFloat32(1234.5);
        writer.writeString('sunset-ridge');
        writer.writeBits(0b1001, 4);

        const reader = new BitReader(writer.toUint8Array());
        expect(reader.readBits(3)).toBe(0b101);
        expect(reader.readUint32()).toBe(0xdeadbeef);
        expect(reader.readBits(2)).toBe(0b11);
        expect(reader.readFloat32()).toBe(1234.5);
        expect(reader.readString()).toBe('sunset-ridge');
        expect(reader.readBits(4)).toBe(0b1001);
    });

    test('reading past the end throws rather than returning zeros', () => {
        const reader = new BitReader(new Uint8Array([0xff]));
        reader.readBits(8);
        expect(() => reader.readBits(1)).toThrow(ReplayFormatError);
    });
});

// === Quantization ===

describe('quantize / dequantize', () => {
    test('error stays within half a step', () => {
        const bits = 10;
        const min = -50;
        const max = 50;
        const step = (max - min) / (Math.pow(2, bits) - 1);
        const random = makeRandom(3);
        for (let i = 0; i < 2000; i++) {
            const value = min + random() * (max - min);
            const recovered = dequantize(quantize(value, min, max, bits), min, max, bits);
            expect(Math.abs(recovered - value)).toBeLessThanOrEqual(step / 2 + 1e-9);
        }
    });

    test('endpoints are exact', () => {
        expect(dequantize(quantize(-7, -7, 19, 12), -7, 19, 12)).toBeCloseTo(-7, 6);
        expect(dequantize(quantize(19, -7, 19, 12), -7, 19, 12)).toBeCloseTo(19, 6);
    });

    test('out-of-range values clamp instead of wrapping', () => {
        expect(dequantize(quantize(1000, 0, 10, 8), 0, 10, 8)).toBeCloseTo(10, 6);
        expect(dequantize(quantize(-1000, 0, 10, 8), 0, 10, 8)).toBeCloseTo(0, 6);
    });

    test('a degenerate range collapses to its single value', () => {
        expect(quantize(5, 5, 5, 8)).toBe(0);
        expect(dequantize(0, 5, 5, 8)).toBe(5);
    });

    test('non-finite input does not corrupt the stream', () => {
        expect(quantize(NaN, 0, 1, 8)).toBe(0);
        expect(quantize(Infinity, 0, 1, 8)).toBe(0);
    });
});

// === Quaternions ===

describe('smallest-three quaternions', () => {
    // Analytic worst case at 10 bits: step = sqrt(2)/1023, so each stored
    // component carries up to step/2 of error, giving |dq| <= sqrt(3)*step/2 and
    // an angle of ~2|dq| = 0.137 deg — plus a smaller term from rebuilding the
    // dropped component. Measured worst is ~0.19 deg. The bound below sits just
    // above that, tight enough that dropping to 9 bits (~0.38 deg) fails.
    test('10 bits per component holds rotation error under a quarter degree', () => {
        const random = makeRandom(42);
        let worstDegrees = 0;
        for (let i = 0; i < 3000; i++) {
            // Uniform random rotations, so the test covers all four dropped-component cases.
            const u1 = random();
            const u2 = random() * Math.PI * 2;
            const u3 = random() * Math.PI * 2;
            const a = Math.sqrt(1 - u1);
            const b = Math.sqrt(u1);
            const q: [number, number, number, number] = [
                a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3),
            ];

            const [x, y, z, w] = unpackQuat(packQuat(q[0], q[1], q[2], q[3], 10), 10);
            // q and -q are the same rotation, so compare on |dot|.
            const dot = Math.abs(x * q[0] + y * q[1] + z * q[2] + w * q[3]);
            const degrees = 2 * Math.acos(Math.min(1, dot)) * (180 / Math.PI);
            worstDegrees = Math.max(worstDegrees, degrees);
        }
        expect(worstDegrees).toBeLessThan(0.25);
    });

    test('the reconstructed quaternion stays unit length', () => {
        const random = makeRandom(8);
        for (let i = 0; i < 500; i++) {
            const raw: [number, number, number, number] = [
                random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1,
            ];
            const [x, y, z, w] = unpackQuat(packQuat(...raw, 10), 10);
            expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 4);
        }
    });

    test('an unnormalized input is normalized rather than rejected', () => {
        const [x, y, z, w] = unpackQuat(packQuat(0, 0, 0, 5, 10), 10);
        expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 4);
        expect(Math.abs(w)).toBeCloseTo(1, 4);
    });

    test('a zero quaternion degrades to identity instead of NaN', () => {
        const [x, y, z, w] = unpackQuat(packQuat(0, 0, 0, 0, 10), 10);
        expect(Number.isFinite(x + y + z + w)).toBe(true);
        expect(w).toBeCloseTo(1, 4);
    });
});

// === Run round-trip ===

describe('packRun / unpackRun', () => {
    test('a vehicle motion track round-trips within its stated precision', () => {
        const track = syntheticVehicleTrack(600);
        const decoded = unpackRun(packRun(makeRun([track], 40_000)));
        const out = decoded.tracks[0];

        expect(out.name).toBe(MOTION_TRACK);
        expect(out.sampleCount).toBe(600);
        expect(out.sampleRateHz).toBe(DEFAULT_MOTION_HZ);
        expect(out.frames).toBeNull();

        // Position: 18 bits across a ~440 m span is well under a centimetre.
        for (const key of ['posX', 'posY', 'posZ']) {
            const index = channelIndex(track, key);
            expect(maxError(track.values[index], out.values[index])).toBeLessThan(0.01);
        }
        // Speed: 10 bits across the signed -30..120 m/s range.
        const speed = channelIndex(track, 'speed');
        expect(maxError(track.values[speed], out.values[speed])).toBeLessThan(0.15);
        // Steering: 8 bits across +/-0.8 rad.
        const steer = channelIndex(track, 'steer');
        expect(maxError(track.values[steer], out.values[steer])).toBeLessThan(0.004);
    });

    test('autoRange adapts precision to the level, and resolves in the output', () => {
        const small = syntheticVehicleTrack(200);
        const posX = channelIndex(small, 'posX');
        // Squeeze the course into a 2 m box; the same 18 bits now buy far more precision.
        small.values[posX] = small.values[posX].map((v) => v / 200);

        const decoded = unpackRun(packRun(makeRun([small], 10_000)));
        const channel = decoded.tracks[0].channels[posX];
        if (channel.kind !== 'scalar') throw new Error('expected a scalar channel');

        expect(channel.autoRange).toBe(false);
        expect(channel.min).toBeCloseTo(Math.min(...small.values[posX]), 3);
        expect(channel.max).toBeCloseTo(Math.max(...small.values[posX]), 3);
        expect(maxError(small.values[posX], decoded.tracks[0].values[posX])).toBeLessThan(0.0001);
    });

    test('a stationary axis survives its degenerate range', () => {
        const track = syntheticVehicleTrack(50);
        const posY = channelIndex(track, 'posY');
        track.values[posY] = new Array<number>(50).fill(7.25);

        const decoded = unpackRun(packRun(makeRun([track], 3_000)));
        for (const value of decoded.tracks[0].values[posY]) expect(value).toBeCloseTo(7.25, 6);
    });

    test('bits channels are exact — a button bitfield must not round', () => {
        const track = syntheticInputTrack(400, 20);
        const buttons = channelIndex(track, 'buttons');
        const decoded = unpackRun(packRun(makeRun([track], 30_000)));
        expect(decoded.tracks[0].values[buttons]).toEqual(track.values[buttons]);
    });

    test('transition frames round-trip exactly', () => {
        const track = syntheticInputTrack(500, 37);
        const decoded = unpackRun(packRun(makeRun([track], 30_000)));
        expect(decoded.tracks[0].frames).toEqual(track.frames);
    });

    test('multiple tracks with different rates and shapes coexist', () => {
        const motion = syntheticVehicleTrack(300);
        const input = syntheticInputTrack(250, 12);
        const decoded = unpackRun(packRun(makeRun([motion, input], 20_000)));

        expect(decoded.tracks).toHaveLength(2);
        expect(decoded.tracks[0].name).toBe(MOTION_TRACK);
        expect(decoded.tracks[1].name).toBe(INPUT_TRACK);
        expect(decoded.tracks[0].sampleRateHz).toBe(DEFAULT_MOTION_HZ);
        expect(decoded.tracks[1].sampleRateHz).toBe(60);
        expect(decoded.tracks[1].frames).toEqual(input.frames);
        expect(decoded.durationMs).toBe(20_000);
    });

    test('the channel schema travels with the data', () => {
        const track = syntheticVehicleTrack(10);
        const decoded = unpackRun(packRun(makeRun([track], 1000)));
        expect(decoded.tracks[0].channels.map((c) => c.key)).toEqual(
            VEHICLE_MOTION_CHANNELS.map((c) => c.key),
        );
        expect(decoded.tracks[0].channels.map((c) => c.kind)).toEqual(
            VEHICLE_MOTION_CHANNELS.map((c) => c.kind),
        );
        for (const channel of decoded.tracks[0].channels) {
            expect(channelStride(channel)).toBe(channel.kind === 'quat' ? 4 : 1);
        }
    });

    test('an empty run is legal', () => {
        const decoded = unpackRun(packRun(makeRun([], 0)));
        expect(decoded.tracks).toEqual([]);
        expect(decoded.durationMs).toBe(0);
    });

    test('a zero-sample track is legal', () => {
        const empty: ReplayTrack = {
            name: MOTION_TRACK,
            sampleRateHz: DEFAULT_MOTION_HZ,
            channels: [...VEHICLE_MOTION_CHANNELS],
            frames: null,
            values: VEHICLE_MOTION_CHANNELS.map(() => []),
            sampleCount: 0,
        };
        expect(unpackRun(packRun(makeRun([empty], 0))).tracks[0].sampleCount).toBe(0);
    });
});

// === Rejection ===

describe('malformed payloads', () => {
    test('a non-replay blob is rejected on magic', () => {
        expect(() => unpackRun(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(ReplayFormatError);
    });

    test('a future format version is refused rather than guessed at', () => {
        const bytes = packRun(makeRun([syntheticVehicleTrack(5)], 1000));
        bytes[4] = REPLAY_FORMAT_VERSION + 1;
        expect(() => unpackRun(bytes)).toThrow(/unsupported replay format/);
    });

    test('a truncated payload throws instead of yielding a short track', () => {
        const bytes = packRun(makeRun([syntheticVehicleTrack(200)], 10_000));
        expect(() => unpackRun(bytes.subarray(0, bytes.length - 40))).toThrow(ReplayFormatError);
    });

    test('a frame count that disagrees with the sample count is rejected', () => {
        const track = syntheticInputTrack(20, 5);
        track.frames = track.frames!.slice(0, 10);
        expect(() => packRun(makeRun([track], 1000))).toThrow(/frames for/);
    });
});

// === Budget ===

describe('size budget', () => {
    test('the vehicle template costs the 136 logical bits per sample it claims', () => {
        expect(trackPayloadBits(syntheticVehicleTrack(1))).toBe(136);
    });

    test('byte-plane padding costs a known amount, not an open-ended one', () => {
        // 18-bit positions round to 3 bytes each, the 32-bit quaternion to 4,
        // 8-bit steer to 1, 10-bit speed to 2. Deliberate: the padding is what
        // makes gzip work (see writeTrackValues).
        expect(trackStoredBytes(syntheticVehicleTrack(1))).toBe(20);
        expect(trackPayloadBits(syntheticVehicleTrack(1)) / 8).toBe(17);
    });

    test('a two-minute lap fits comfortably inside one 1 MB entry', async () => {
        const seconds = 120;
        const motion = syntheticVehicleTrack(seconds * DEFAULT_MOTION_HZ);
        // A busy lap: ~8 input transitions per second.
        const input = syntheticInputTrack(seconds * 8, 14);
        const run = makeRun([motion, input], seconds * 1000);

        const raw = packedSizeBytes(run);
        const encoded = await encodeRun(run);

        // Measured at the time of writing: raw 40,585 B, encoded 22,020 B.
        expect(raw).toBeLessThan(45_000);
        // The number that actually counts is base64 length against MAX_DATA_BYTES.
        expect(encoded.length).toBeLessThan(1_048_576 * 0.03);
    });

    test('compression beats the 4/3 tax base64 charges', async () => {
        // The whole reason values are written in byte planes. Tight bit-packing
        // measured 1.00x here — gzip exactly cancelling base64 and no more.
        const run = makeRun(
            [syntheticVehicleTrack(120 * DEFAULT_MOTION_HZ), syntheticInputTrack(120 * 8, 14)],
            120_000,
        );
        const ratio = packedSizeBytes(run) / (await encodeRun(run)).length;
        expect(ratio).toBeGreaterThan(1.5);
    });
});

// === Transport ===

describe('encodeRun / decodeRun', () => {
    test('the full pipeline round-trips', async () => {
        const run = makeRun([syntheticVehicleTrack(400), syntheticInputTrack(300, 15)], 26_666);
        const decoded = await decodeRun(await encodeRun(run));

        expect(decoded.durationMs).toBe(26_666);
        expect(decoded.tracks).toHaveLength(2);
        expect(decoded.tracks[1].frames).toEqual(run.tracks[1].frames);
        expect(maxError(run.tracks[0].values[0], decoded.tracks[0].values[0])).toBeLessThan(0.01);
    });

    test('the encoded form is base64 with no JSON-escaping surprises', async () => {
        const encoded = await encodeRun(makeRun([syntheticVehicleTrack(120)], 8000));
        expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        // Exactly 4/3 inflation means no character needed escaping.
        expect(JSON.stringify({ d: encoded }).length).toBe(encoded.length + 8);
    });

    test('the object-storage form skips base64 and is a quarter smaller for it', async () => {
        // Runs go to object storage as bytes; base64 is a transport tax the
        // entry used to pay and an uploaded object does not. If this ever
        // stops holding, storing runs inline costs nothing and the split
        // between the two encoders has no reason to exist.
        const run = makeRun([syntheticVehicleTrack(120 * 15), syntheticInputTrack(120 * 8, 14)], 120_000);
        const bytes = await encodeRunBytes(run);
        const encoded = await encodeRun(run);

        expect(bytes.byteLength).toBe(Math.floor(encoded.replace(/=+$/, '').length * 3 / 4));
        expect(bytes.byteLength).toBeLessThan(encoded.length * 0.8);
    });

    test('bytes and base64 decode to the same run', async () => {
        // The two encoders must stay one format. A device's own runs are stored
        // base64 in localStorage and everyone else's arrive as bytes from the
        // bucket, so the SAME lap is read back both ways.
        const run = makeRun([syntheticVehicleTrack(400), syntheticInputTrack(300, 15)], 26_666);
        const fromBytes = await decodeRunBytes(await encodeRunBytes(run));
        const fromText = await decodeRun(await encodeRun(run));

        expect(fromBytes).toEqual(fromText);
    });

    test('a corrupted payload is rejected rather than decoded into noise', async () => {
        const encoded = await encodeRun(makeRun([syntheticVehicleTrack(100)], 6000));
        const corrupted = `${encoded.slice(0, 20)}AAAA${encoded.slice(24)}`;
        await expect(decodeRun(corrupted)).rejects.toThrow();
    });

    /**
     * Published games must run on iOS WebKit older than 16.4, where the
     * Compression Streams API does not exist. An earlier version of the codec
     * threw there, which turned crossing the finish line into an exception in
     * the game's own handler. `engine/gzip.ts` feature-detects and falls back to
     * bundled fflate; these tests pin that the codec goes through it.
     */
    describe('without the Compression Streams API', () => {
        const globals = globalThis as Record<string, unknown>;
        let savedCompression: unknown;
        let savedDecompression: unknown;

        beforeEach(() => {
            savedCompression = globals.CompressionStream;
            savedDecompression = globals.DecompressionStream;
            delete globals.CompressionStream;
            delete globals.DecompressionStream;
        });

        afterEach(() => {
            globals.CompressionStream = savedCompression;
            globals.DecompressionStream = savedDecompression;
        });

        test('still round-trips', async () => {
            const run = makeRun([syntheticVehicleTrack(200), syntheticInputTrack(150, 15)], 13_333);
            const decoded = await decodeRun(await encodeRun(run));

            expect(decoded.durationMs).toBe(13_333);
            expect(decoded.tracks[1].frames).toEqual(run.tracks[1].frames);
            expect(maxError(run.tracks[0].values[0], decoded.tracks[0].values[0])).toBeLessThan(0.01);
        });

        test('produces a payload the native path can read, and vice versa', async () => {
            // Both codecs write gzip, so a run recorded on an old iPhone must
            // replay on a desktop — otherwise the format forks by device.
            const run = makeRun([syntheticVehicleTrack(100)], 6666);
            const fallbackEncoded = await encodeRun(run);

            globals.CompressionStream = savedCompression;
            globals.DecompressionStream = savedDecompression;
            const decoded = await decodeRun(fallbackEncoded);
            expect(decoded.durationMs).toBe(6666);
        });

        test('still rejects a corrupted payload as a format error', async () => {
            // spawnGhost skips a ghost it cannot decode by catching this type;
            // the fallback path must not surface a raw fflate error instead.
            const encoded = await encodeRun(makeRun([syntheticVehicleTrack(100)], 6000));
            const corrupted = `${encoded.slice(0, 20)}AAAA${encoded.slice(24)}`;
            await expect(decodeRun(corrupted)).rejects.toThrow(ReplayFormatError);
        });
    });
});
