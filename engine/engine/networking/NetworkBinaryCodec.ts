/**
 * MsgPack-based binary codec for the NetworkManager binary protocol.
 * Encodes/decodes NetworkMessage arrays to/from Uint8Array.
 * Enabled by default in the NetworkManager constructor.
 *
 * Note: MsgPack maps `undefined` to `null`. Optional fields on NetworkMessage
 * (e.g. playerName, animState) will be `null` instead of `undefined` after decode.
 * This is safe because all checks use truthiness, not strict `=== undefined`.
 */
import { encode, decode } from '@msgpack/msgpack';
import type { NetworkMessage } from 'engine/networking/NetworkTypes.js';

/** Encode an array of NetworkMessages into a single MsgPack Uint8Array. */
export function msgpackEncoder(msgs: NetworkMessage[]): Uint8Array {
    return encode(msgs);
}

/** Decode a MsgPack Uint8Array back into an array of NetworkMessages. */
export function msgpackDecoder(data: Uint8Array): NetworkMessage[] {
    const result = decode(data);
    if (!Array.isArray(result)) return [];
    return result as NetworkMessage[];
}
