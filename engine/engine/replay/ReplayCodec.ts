/**
 * Run codec — quantize, pack, compress, and the exact inverse.
 *
 * The pipeline is quantize → structure-of-arrays → gzip → base64, and each
 * stage exists for a measured reason (design §5):
 *
 * - Quantization is where the bytes actually go. Everything downstream is
 *   squeezing air out of an already-small payload.
 * - SoA is what makes gzip work. Writing all of one channel's samples together
 *   gives DEFLATE a strongly autocorrelated stream; interleaving hands it noise.
 * - base64 is not optional. The transport is JSON and the 1 MB entry cap is
 *   measured on `JSON.stringify(data)`, so the 4/3 inflation counts against it.
 *   Firestore's native Bytes type is unreachable through that route.
 *
 * `packRun`/`unpackRun` are synchronous and pure — all the interesting logic is
 * there, and it is testable without touching the compression stack.
 * `encodeRun`/`decodeRun` add gzip and base64, which are async by API.
 */

import { gunzip, gzip } from 'engine/gzip.js';
import { BitReader, BitWriter } from 'engine/replay/ReplayBits.js';
import {
    REPLAY_FORMAT_VERSION,
    REPLAY_MAGIC,
    ReplayFormatError,
    channelBits,
    channelStride,
    trackBitsPerSample,
    type ReplayChannel,
    type ReplayTrack,
    type RunRecord,
} from 'engine/replay/ReplayTypes.js';

const INV_SQRT2 = Math.SQRT1_2;

/**
 * Indexed read that fails loudly instead of yielding `undefined`.
 *
 * `noUncheckedIndexedAccess` makes every index a possible miss. Inside the
 * codec a miss is a bug in this file rather than bad input, so throwing beats
 * substituting a zero and silently writing a corrupt sample.
 */
function at(values: ArrayLike<number>, index: number): number {
    const value = values[index];
    if (value === undefined) {
        throw new ReplayFormatError(`internal: sample index ${index} out of range`);
    }
    return value;
}

const KIND_SCALAR = 0;
const KIND_BITS = 1;
const KIND_QUAT = 2;

/** Wire tag per channel kind. `readChannel` maps back the other way. */
const CHANNEL_KIND: Record<ReplayChannel['kind'], number> = {
    scalar: KIND_SCALAR,
    bits: KIND_BITS,
    quat: KIND_QUAT,
};

// === Quantization ===

/**
 * Map a value in `[min, max]` onto `bits` bits.
 *
 * Non-finite input maps to 0 rather than throwing: a NaN slipping in mid-race
 * is an upstream bug, and losing one sample beats losing the run. The recorder
 * is responsible for not producing them.
 */
export function quantize(value: number, min: number, max: number, bits: number): number {
    const levels = Math.pow(2, bits) - 1;
    if (!Number.isFinite(value) || !(max > min) || levels <= 0) return 0;
    const t = (value - min) / (max - min);
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.round(clamped * levels);
}

export function dequantize(quantized: number, min: number, max: number, bits: number): number {
    const levels = Math.pow(2, bits) - 1;
    if (!(max > min) || levels <= 0) return min;
    return min + (quantized / levels) * (max - min);
}

// === Quaternions (smallest-three) ===

export interface PackedQuat {
    /** Index of the dropped (largest-magnitude) component. */
    index: number;
    /** The three retained components, quantized. */
    components: [number, number, number];
}

/**
 * Drop the largest component and quantize the rest.
 *
 * The sign flip matters: `q` and `-q` are the same rotation, so forcing the
 * dropped component positive lets decode recover it as a plain square root
 * with no sign bit.
 */
export function packQuat(x: number, y: number, z: number, w: number, componentBits: number): PackedQuat {
    const length = Math.hypot(x, y, z, w);
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let nw = 1;
    if (length > 0) {
        nx = x / length;
        ny = y / length;
        nz = z / length;
        nw = w / length;
    }

    let index = 0;
    let largest = Math.abs(nx);
    if (Math.abs(ny) > largest) {
        largest = Math.abs(ny);
        index = 1;
    }
    if (Math.abs(nz) > largest) {
        largest = Math.abs(nz);
        index = 2;
    }
    if (Math.abs(nw) > largest) {
        index = 3;
    }

    const dropped = index === 0 ? nx : index === 1 ? ny : index === 2 ? nz : nw;
    if (dropped < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
        nw = -nw;
    }

    // Mirrors the switch in unpackQuat — keep the two in step.
    let a: number;
    let b: number;
    let c: number;
    switch (index) {
        case 0:
            [a, b, c] = [ny, nz, nw];
            break;
        case 1:
            [a, b, c] = [nx, nz, nw];
            break;
        case 2:
            [a, b, c] = [nx, ny, nw];
            break;
        default:
            [a, b, c] = [nx, ny, nz];
            break;
    }

    return {
        index,
        components: [
            quantize(a, -INV_SQRT2, INV_SQRT2, componentBits),
            quantize(b, -INV_SQRT2, INV_SQRT2, componentBits),
            quantize(c, -INV_SQRT2, INV_SQRT2, componentBits),
        ],
    };
}

/** Rebuild x, y, z, w from a packed quaternion. */
export function unpackQuat(packed: PackedQuat, componentBits: number): [number, number, number, number] {
    const a = dequantize(packed.components[0], -INV_SQRT2, INV_SQRT2, componentBits);
    const b = dequantize(packed.components[1], -INV_SQRT2, INV_SQRT2, componentBits);
    const c = dequantize(packed.components[2], -INV_SQRT2, INV_SQRT2, componentBits);
    const dropped = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));

    switch (packed.index) {
        case 0:
            return [dropped, a, b, c];
        case 1:
            return [a, dropped, b, c];
        case 2:
            return [a, b, dropped, c];
        default:
            return [a, b, c, dropped];
    }
}

// === Channel range resolution ===

/**
 * Replace `autoRange` channels with concrete ranges taken from the samples.
 *
 * The encoded run stores resolved ranges only — the file has no reason to know
 * how a range was chosen, so a decoded record always reports `autoRange: false`.
 */
function resolveChannels(track: ReplayTrack): ReplayChannel[] {
    return track.channels.map((channel, channelIndex) => {
        if (channel.kind !== 'scalar' || !channel.autoRange) return channel;
        const samples = track.values[channelIndex] ?? [];
        let min = Infinity;
        let max = -Infinity;
        for (const value of samples) {
            if (!Number.isFinite(value)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            min = 0;
            max = 0;
        }
        // A degenerate range is legal — a stationary axis quantizes to a
        // constant and dequantizes back to it exactly.
        return { kind: 'scalar', key: channel.key, bits: channel.bits, min, max, autoRange: false };
    });
}

// === Pack ===

function writeChannel(writer: BitWriter, channel: ReplayChannel): void {
    // Kind and key are the shared header every kind carries — readChannel reads
    // them the same way round, so keep the two mirrored.
    writer.writeUint8(CHANNEL_KIND[channel.kind]);
    writer.writeString(channel.key);
    if (channel.kind === 'quat') {
        writer.writeUint8(channel.componentBits);
        return;
    }
    writer.writeUint8(channel.bits);
    if (channel.kind === 'scalar') {
        writer.writeFloat32(channel.min);
        writer.writeFloat32(channel.max);
    }
}

function readChannel(reader: BitReader): ReplayChannel {
    const kind = reader.readUint8();
    const key = reader.readString();
    if (kind === KIND_SCALAR) {
        const bits = reader.readUint8();
        const min = reader.readFloat32();
        const max = reader.readFloat32();
        return { kind: 'scalar', key, bits, min, max, autoRange: false };
    }
    if (kind === KIND_BITS) {
        return { kind: 'bits', key, bits: reader.readUint8() };
    }
    if (kind === KIND_QUAT) {
        return { kind: 'quat', key, componentBits: reader.readUint8() };
    }
    throw new ReplayFormatError(`unknown channel kind ${kind}`);
}

/**
 * Frame indices are strictly increasing, so they are stored as deltas at a
 * width derived from the largest gap. A transition-encoded input track spends
 * a handful of bits per entry rather than a full uint32.
 */
function writeFrames(writer: BitWriter, frames: number[]): void {
    let maxDelta = 0;
    let previous = 0;
    for (const frame of frames) {
        const delta = frame - previous;
        if (delta < 0) throw new ReplayFormatError('frames must be non-decreasing');
        if (delta > maxDelta) maxDelta = delta;
        previous = frame;
    }
    const width = maxDelta === 0 ? 1 : Math.ceil(Math.log2(maxDelta + 1));
    writer.writeUint8(width);
    previous = 0;
    for (const frame of frames) {
        writer.writeBits(frame - previous, width);
        previous = frame;
    }
}

function readFrames(reader: BitReader, count: number): number[] {
    const width = reader.readUint8();
    const frames: number[] = [];
    let previous = 0;
    for (let i = 0; i < count; i++) {
        previous += reader.readBits(width);
        frames.push(previous);
    }
    return frames;
}

/**
 * Collapse one sample of a channel into a single non-negative integer.
 *
 * Assembly uses multiplication rather than shifts: a 32-bit quaternion payload
 * overflows the sign bit under `<<`, while integer arithmetic stays exact well
 * past 2^32 (Number holds integers exactly to 2^53).
 */
function sampleToInteger(channel: ReplayChannel, samples: number[], base: number): number {
    if (channel.kind === 'quat') {
        const packed = packQuat(
            samples[base] ?? 0,
            samples[base + 1] ?? 0,
            samples[base + 2] ?? 0,
            samples[base + 3] ?? 1,
            channel.componentBits,
        );
        const radix = Math.pow(2, channel.componentBits);
        const components = packed.components[0] + radix * (packed.components[1] + radix * packed.components[2]);
        return packed.index + 4 * components;
    }
    if (channel.kind === 'bits') {
        return (samples[base] ?? 0) >>> 0;
    }
    return quantize(samples[base] ?? 0, channel.min, channel.max, channel.bits);
}

/** Inverse of `sampleToInteger`, writing into `out` at `base`. */
function integerToSample(channel: ReplayChannel, value: number, out: number[], base: number): void {
    if (channel.kind === 'quat') {
        const radix = Math.pow(2, channel.componentBits);
        const index = value % 4;
        let rest = (value - index) / 4;
        const c0 = rest % radix;
        rest = (rest - c0) / radix;
        const c1 = rest % radix;
        const c2 = (rest - c1) / radix;
        const [x, y, z, w] = unpackQuat({ index, components: [c0, c1, c2] }, channel.componentBits);
        out[base] = x;
        out[base + 1] = y;
        out[base + 2] = z;
        out[base + 3] = w;
        return;
    }
    out[base] = channel.kind === 'bits' ? value : dequantize(value, channel.min, channel.max, channel.bits);
}

/** Whole bytes each sample of a channel occupies on the wire. */
function channelStoredBytes(channel: ReplayChannel): number {
    return Math.ceil(channelBits(channel) / 8);
}

/**
 * Write a track channel-major and BYTE-PLANE-major within each channel: every
 * sample's byte 0, then every sample's byte 1, and so on.
 *
 * Channel-major alone is not enough — that was measured. DEFLATE matches on
 * byte patterns, so tightly bit-packing at arbitrary boundaries smears the
 * near-constant high bits of a smooth signal across byte edges and leaves
 * nothing to match. Splitting into planes puts those high bytes next to each
 * other, where they collapse to almost nothing, and isolates the genuinely
 * noisy low byte into a run of its own.
 *
 * The cost is padding each channel up to a byte boundary — 25% more raw bytes
 * for the vehicle template. Compression more than repays it.
 */
function writeTrackValues(writer: BitWriter, channels: readonly ReplayChannel[], track: ReplayTrack): void {
    for (const [channelIndex, channel] of channels.entries()) {
        const samples = track.values[channelIndex] ?? [];
        const stride = channelStride(channel);
        const planes = channelStoredBytes(channel);

        const packed = new Float64Array(track.sampleCount);
        for (let sample = 0; sample < track.sampleCount; sample++) {
            packed[sample] = sampleToInteger(channel, samples, sample * stride);
        }
        for (let plane = 0; plane < planes; plane++) {
            const divisor = Math.pow(256, plane);
            for (let sample = 0; sample < track.sampleCount; sample++) {
                writer.writeUint8(Math.floor(at(packed, sample) / divisor) % 256);
            }
        }
    }
}

function readTrackValues(reader: BitReader, channels: readonly ReplayChannel[], sampleCount: number): number[][] {
    const values: number[][] = [];
    for (const channel of channels) {
        const stride = channelStride(channel);
        const planes = channelStoredBytes(channel);

        const packed = new Float64Array(sampleCount);
        for (let plane = 0; plane < planes; plane++) {
            const multiplier = Math.pow(256, plane);
            for (let sample = 0; sample < sampleCount; sample++) {
                packed[sample] = at(packed, sample) + reader.readUint8() * multiplier;
            }
        }
        const samples = new Array<number>(sampleCount * stride).fill(0);
        for (let sample = 0; sample < sampleCount; sample++) {
            integerToSample(channel, at(packed, sample), samples, sample * stride);
        }
        values.push(samples);
    }
    return values;
}

/** Pack a run into its binary form. Synchronous and pure. */
export function packRun(run: RunRecord): Uint8Array {
    const writer = new BitWriter();
    writer.writeUint32(REPLAY_MAGIC);
    writer.writeUint16(REPLAY_FORMAT_VERSION);
    writer.writeUint32(Math.max(0, Math.round(run.durationMs)));
    writer.writeUint8(run.tracks.length);

    for (const track of run.tracks) {
        const channels = resolveChannels(track);
        writer.writeString(track.name);
        writer.writeUint16(track.sampleRateHz);
        writer.writeUint32(track.sampleCount);
        writer.writeUint8(track.frames ? 1 : 0);
        writer.writeUint8(channels.length);
        for (const channel of channels) writeChannel(writer, channel);
        if (track.frames) {
            if (track.frames.length !== track.sampleCount) {
                throw new ReplayFormatError(
                    `track '${track.name}': ${track.frames.length} frames for ${track.sampleCount} samples`,
                );
            }
            writeFrames(writer, track.frames);
        }
        writeTrackValues(writer, channels, track);
    }
    return writer.toUint8Array();
}

/** Inverse of `packRun`. Throws `ReplayFormatError` on anything malformed. */
export function unpackRun(bytes: Uint8Array): RunRecord {
    const reader = new BitReader(bytes);
    if (reader.readUint32() !== REPLAY_MAGIC) {
        throw new ReplayFormatError('not a replay payload (bad magic)');
    }
    const formatVersion = reader.readUint16();
    if (formatVersion !== REPLAY_FORMAT_VERSION) {
        // Refuse rather than guess. A ghost that plays back subtly wrong is
        // worse than a ghost that does not appear.
        throw new ReplayFormatError(
            `unsupported replay format ${formatVersion} (expected ${REPLAY_FORMAT_VERSION})`,
        );
    }
    const durationMs = reader.readUint32();
    const trackCount = reader.readUint8();

    const tracks: ReplayTrack[] = [];
    for (let t = 0; t < trackCount; t++) {
        const name = reader.readString();
        const sampleRateHz = reader.readUint16();
        const sampleCount = reader.readUint32();
        const hasFrames = reader.readUint8() === 1;
        const channelCount = reader.readUint8();
        const channels: ReplayChannel[] = [];
        for (let c = 0; c < channelCount; c++) channels.push(readChannel(reader));
        const frames = hasFrames ? readFrames(reader, sampleCount) : null;
        const values = readTrackValues(reader, channels, sampleCount);
        tracks.push({ name, sampleRateHz, channels, frames, values, sampleCount });
    }
    return { formatVersion, durationMs, tracks };
}

/**
 * Logical bits per sample — the sum of the channel widths, before the
 * byte-plane padding that buys compressibility. This is the number a channel
 * template is designed against.
 */
export function trackPayloadBits(track: ReplayTrack): number {
    return trackBitsPerSample(track.channels);
}

/**
 * Bytes per sample actually written, after each channel is padded to a whole
 * number of bytes. Always >= `trackPayloadBits / 8`; the gap is the padding
 * that `writeTrackValues` trades for compression.
 */
export function trackStoredBytes(track: ReplayTrack): number {
    let bytes = 0;
    for (const channel of track.channels) bytes += channelStoredBytes(channel);
    return bytes;
}

/** Exact uncompressed size of a run, headers included. */
export function packedSizeBytes(run: RunRecord): number {
    return packRun(run).length;
}

// === Compression and transport ===

/**
 * Compression goes through `engine/gzip.ts`, which feature-detects
 * `CompressionStream` and falls back to bundled fflate.
 *
 * ⚠ Do NOT reach for `CompressionStream` directly here. It shipped in WebKit
 * 16.4, and published games must run on older iOS — an earlier version of this
 * file threw on those devices, which turned crossing the finish line into an
 * exception thrown at the game's own finish handler. The shared helper exists
 * because this exact API already broke VXL/VWLD loading on a real player's
 * phone.
 *
 * Both directions are wrapped so a failure arrives as `ReplayFormatError`:
 * callers skip a ghost they cannot decode, and that decision keys off the type.
 */
async function runCodec(step: () => Promise<Uint8Array>, what: string): Promise<Uint8Array> {
    try {
        return await step();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ReplayFormatError(`${what} failed: ${detail || 'corrupt or truncated data'}`);
    }
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * Encode a run to its stored BYTES: pack, then gzip.
 *
 * This is the real payload. `encodeRun` below adds base64 on top, which is a
 * transport tax rather than part of the format — a run uploaded as an object
 * skips it and is a quarter smaller for it.
 */
export async function encodeRunBytes(run: RunRecord): Promise<Uint8Array> {
    const packed = packRun(run);
    return runCodec(() => gzip(packed), 'compression');
}

/** Decode stored bytes. Throws `ReplayFormatError` on anything malformed. */
export async function decodeRunBytes(bytes: Uint8Array): Promise<RunRecord> {
    return unpackRun(await runCodec(() => gunzip(bytes), 'decompression'));
}

/**
 * Encode a run as text: pack, gzip, base64.
 *
 * The form used where the transport is JSON or `localStorage` — a run kept on
 * the device, and the inline fallback for a deployment with no object storage.
 */
export async function encodeRun(run: RunRecord): Promise<string> {
    return bytesToBase64(await encodeRunBytes(run));
}

/** Decode a stored run. Throws `ReplayFormatError` on anything malformed. */
export async function decodeRun(encoded: string): Promise<RunRecord> {
    return decodeRunBytes(base64ToBytes(encoded));
}
