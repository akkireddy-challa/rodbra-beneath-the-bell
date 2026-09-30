/**
 * Bit-level and byte-level writers over a growable buffer.
 *
 * The run header is byte-aligned (it is read once and readability beats a
 * handful of bytes); the sample payload is bit-packed, because that is where
 * the size actually lives. Both live in one writer so a run is a single
 * contiguous buffer with no splicing.
 *
 * Bits are written least-significant-first within each byte. The only
 * requirement is that the reader agrees, which it does by construction.
 */

import { ReplayFormatError } from 'engine/replay/ReplayTypes.js';

const scratch = new DataView(new ArrayBuffer(4));
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export class BitWriter {
    private readonly bytes: number[] = [];
    private current = 0;
    private used = 0;

    /** Write the low `bits` bits of `value`. `bits` must be 0..32. */
    writeBits(value: number, bits: number): void {
        if (bits < 0 || bits > 32) {
            throw new ReplayFormatError(`writeBits: bit width out of range (${bits})`);
        }
        let remaining = bits;
        let rest = value >>> 0;
        while (remaining > 0) {
            const take = Math.min(8 - this.used, remaining);
            const chunk = rest & ((1 << take) - 1);
            this.current |= chunk << this.used;
            this.used += take;
            rest = rest >>> take;
            remaining -= take;
            if (this.used === 8) {
                this.bytes.push(this.current & 0xff);
                this.current = 0;
                this.used = 0;
            }
        }
    }

    /** Pad to the next byte boundary so a byte-aligned field can follow. */
    align(): void {
        if (this.used > 0) {
            this.bytes.push(this.current & 0xff);
            this.current = 0;
            this.used = 0;
        }
    }

    writeUint8(value: number): void {
        this.align();
        this.bytes.push(value & 0xff);
    }

    writeUint16(value: number): void {
        this.align();
        this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    }

    writeUint32(value: number): void {
        this.align();
        const v = value >>> 0;
        this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    }

    writeFloat32(value: number): void {
        this.align();
        scratch.setFloat32(0, value, true);
        this.bytes.push(scratch.getUint8(0), scratch.getUint8(1), scratch.getUint8(2), scratch.getUint8(3));
    }

    /** UTF-8, length-prefixed with a uint16. */
    writeString(value: string): void {
        const encoded = utf8Encoder.encode(value);
        if (encoded.length > 0xffff) {
            throw new ReplayFormatError('writeString: string too long');
        }
        this.writeUint16(encoded.length);
        for (const byte of encoded) this.bytes.push(byte);
    }

    toUint8Array(): Uint8Array {
        this.align();
        return Uint8Array.from(this.bytes);
    }
}

export class BitReader {
    private byteIndex = 0;
    private used = 0;

    constructor(private readonly bytes: Uint8Array) {}

    readBits(bits: number): number {
        if (bits < 0 || bits > 32) {
            throw new ReplayFormatError(`readBits: bit width out of range (${bits})`);
        }
        let result = 0;
        let filled = 0;
        let remaining = bits;
        while (remaining > 0) {
            const byte = this.bytes[this.byteIndex];
            if (byte === undefined) {
                throw new ReplayFormatError('readBits: ran past end of buffer');
            }
            const take = Math.min(8 - this.used, remaining);
            const chunk = (byte >>> this.used) & ((1 << take) - 1);
            result |= chunk << filled;
            filled += take;
            this.used += take;
            remaining -= take;
            if (this.used === 8) {
                this.used = 0;
                this.byteIndex++;
            }
        }
        return result >>> 0;
    }

    align(): void {
        if (this.used > 0) {
            this.used = 0;
            this.byteIndex++;
        }
    }

    private takeBytes(count: number): Uint8Array {
        this.align();
        if (this.byteIndex + count > this.bytes.length) {
            throw new ReplayFormatError('read: ran past end of buffer');
        }
        const slice = this.bytes.subarray(this.byteIndex, this.byteIndex + count);
        this.byteIndex += count;
        return slice;
    }

    /** Byte-aligned scalar reads go through a DataView, whose getters are total. */
    private takeView(count: number): DataView {
        const slice = this.takeBytes(count);
        return new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
    }

    readUint8(): number {
        return this.takeView(1).getUint8(0);
    }

    readUint16(): number {
        return this.takeView(2).getUint16(0, true);
    }

    readUint32(): number {
        return this.takeView(4).getUint32(0, true);
    }

    readFloat32(): number {
        return this.takeView(4).getFloat32(0, true);
    }

    readString(): string {
        const length = this.readUint16();
        return utf8Decoder.decode(this.takeBytes(length));
    }
}
