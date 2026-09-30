/**
 * Where a run's BYTES live.
 *
 * A leaderboard entry holds at most 1 MB and a game holds 1 MB across every
 * entry it will ever write, while one recorded lap is 12–43 KB. Runs stored
 * inside their entries therefore cap a board at a few dozen laps — and a board
 * that has to forget times is one no ordinary player can ever appear on, which
 * is exactly the failure this module exists to remove.
 *
 * So the run goes to the same bucket the game's own assets already load from,
 * and the entry keeps a URL. An entry drops from ~20 KB to ~150 bytes, which
 * is the difference between tens of stored runs and thousands.
 *
 * Two shapes have to be readable forever, and neither is a legacy wart:
 *
 * - `url` — the normal path.
 * - `inline` — base64 in the entry. Every run recorded before this existed, and
 *   every run recorded on a deployment with no bucket configured (localhost).
 *   The device's own runs are inline too, because `localStorage` holds strings.
 */

import { GameDataError, type RunUploadTarget } from 'engine/gamedata/types.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';
import { decodeRun, decodeRunBytes } from 'engine/replay/ReplayCodec.js';
import { ReplayFormatError, type RunRecord } from 'engine/replay/ReplayTypes.js';

/** A stored run, however it was stored. */
export type RunSource =
    | { kind: 'url'; url: string }
    | { kind: 'inline'; encoded: string };

/**
 * Upload a run and return its public URL, or null when it could not be stored
 * as an object and belongs in the entry instead.
 *
 * Never throws. Every failure here — no bucket configured, a rate limit, an
 * upload that did not land — has the same correct answer: fall back to storing
 * the run inline, which is what every run did before object storage existed.
 * A player must not lose their place on the board over where the bytes went.
 */
export async function uploadRun(
    service: GameDataService,
    category: string,
    bytes: Uint8Array,
): Promise<string | null> {
    let target: RunUploadTarget;
    try {
        target = await service.createRunUploadUrl(category, bytes.byteLength);
    } catch (error) {
        // Two ordinary states, neither worth a warning:
        //
        // - `storage_unavailable` — the deployment has no bucket (localhost).
        // - a 404 — the game-server predates this route. A published game is a
        //   FROZEN bundle, so a game published today will outlive some
        //   deployments and outrun others; it must degrade quietly rather than
        //   log on every lap a player drives.
        //
        // Anything else means object storage exists and refused, which IS worth
        // knowing: it is what silently pushes runs back into the game's quota.
        if (!isExpectedStorageAbsence(error)) {
            console.warn('[GhostRunStorage] could not mint a run upload — storing it in the entry:', error);
        }
        return null;
    }

    try {
        const response = await fetch(target.uploadUrl, {
            method: 'PUT',
            // Both headers are SIGNED into the URL. Sending anything else, or
            // omitting one, fails the signature check with a 403 that says
            // nothing about which header was wrong — so they are echoed from
            // the mint response rather than spelled again here.
            headers: {
                'Content-Type': target.contentType,
                'Cache-Control': target.cacheControl,
            },
            // `Uint8Array<ArrayBufferLike>` is a valid body but does not satisfy
            // `BodyInit` under the current lib typings — the same gap `gzip.ts`
            // casts across for `BlobPart`.
            body: bytes as BodyInit,
        });
        if (!response.ok) {
            console.warn(
                `[GhostRunStorage] run upload failed (${response.status}) — storing it in the entry instead`,
            );
            return null;
        }
        return target.publicUrl;
    } catch (error) {
        console.warn('[GhostRunStorage] run upload failed — storing it in the entry instead:', error);
        return null;
    }
}

function isExpectedStorageAbsence(error: unknown): boolean {
    if (!(error instanceof GameDataError)) return false;
    return error.code === 'storage_unavailable' || error.status === 404;
}

/**
 * Read a stored run back.
 *
 * Throws `ReplayFormatError` for anything unreadable, whichever shape it came
 * in as — callers skip a ghost they cannot decode and that decision keys off
 * the type, so a network failure must arrive as one too rather than as a bare
 * `TypeError` from `fetch`.
 */
export async function loadRun(source: RunSource): Promise<RunRecord> {
    if (source.kind === 'inline') return decodeRun(source.encoded);

    let response: Response;
    try {
        response = await fetch(source.url);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ReplayFormatError(`fetching the run failed: ${detail}`);
    }
    if (!response.ok) {
        throw new ReplayFormatError(`fetching the run failed: HTTP ${response.status}`);
    }
    return decodeRunBytes(new Uint8Array(await response.arrayBuffer()));
}
