/**
 * Where a run's bytes go, and what happens when they cannot get there.
 *
 * The whole point of moving runs out of their entries is capacity — an entry
 * with a URL is ~150 bytes against ~20 KB for one holding a lap, which is the
 * difference between a board that fills after a few dozen times and one that
 * holds every player's. So the property worth pinning is not that uploading
 * works, it is that FAILING to upload never costs the player their run: every
 * failure falls back to storing it inline, silently and without throwing.
 */

import { loadRun, uploadRun } from 'engine/replay/GhostRunStorage.js';
import { GameDataError, type RunUploadTarget } from 'engine/gamedata/types.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';
import { encodeRun, encodeRunBytes } from 'engine/replay/ReplayCodec.js';
import { ReplayFormatError, type RunRecord } from 'engine/replay/ReplayTypes.js';

const TARGET: RunUploadTarget = {
    uploadUrl: 'https://storage.example/signed?sig=abc',
    publicUrl: 'https://cdn.example/games/G/runs/ghosts-a/deadbeef.bin',
    key: 'games/G/runs/ghosts-a/deadbeef.bin',
    contentType: 'application/octet-stream',
    cacheControl: 'public, max-age=31536000, immutable',
    expiresIn: 300,
};

function run(): RunRecord {
    return {
        formatVersion: 1,
        durationMs: 2000,
        tracks: [{
            name: 'vehicle',
            sampleRateHz: 15,
            sampleCount: 3,
            frames: null,
            channels: [{ key: 'x', kind: 'scalar', bits: 16, min: -10, max: 10, autoRange: false }],
            values: [[0, 1, 2]],
        }],
    };
}

function serviceReturning(target: RunUploadTarget | Error): GameDataService {
    return {
        createRunUploadUrl: async () => {
            if (target instanceof Error) throw target;
            return target;
        },
    } as unknown as GameDataService;
}

const REAL_FETCH = global.fetch;
let warn: jest.SpyInstance;

beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    global.fetch = REAL_FETCH;
    warn.mockRestore();
});

describe('uploadRun', () => {
    test('PUTs the bytes and returns the URL the entry should store', async () => {
        const seen: Array<{ url: string; init: RequestInit }> = [];
        global.fetch = (async (url: string, init: RequestInit) => {
            seen.push({ url, init });
            return { ok: true, status: 200 } as Response;
        }) as unknown as typeof fetch;

        const bytes = await encodeRunBytes(run());
        const url = await uploadRun(serviceReturning(TARGET), 'ghosts-a', bytes);

        expect(url).toBe(TARGET.publicUrl);
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe(TARGET.uploadUrl);
        expect(seen[0].init.method).toBe('PUT');
        // Both headers are signed INTO the url, so they must be echoed from the
        // mint response rather than spelled again — a mismatch is a 403 that
        // says nothing about which header was wrong.
        expect(seen[0].init.headers).toEqual({
            'Content-Type': TARGET.contentType,
            'Cache-Control': TARGET.cacheControl,
        });
    });

    test('a deployment with no bucket falls back QUIETLY', async () => {
        // localhost has no bucket. This is the ordinary state there, not a
        // fault, and warning about it on every lap would be noise.
        const error = new GameDataError(503, 'storage_unavailable', 'no bucket', null);
        const url = await uploadRun(serviceReturning(error), 'ghosts-a', new Uint8Array([1, 2]));

        expect(url).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });

    test('a game-server without the route falls back QUIETLY too', async () => {
        // A published game is a frozen bundle: it will outlive some deployments
        // and outrun others, so meeting a game-server that predates this route
        // is ordinary, not a fault worth logging on every lap.
        const error = new GameDataError(404, 'http_404', 'Not Found', null);
        const url = await uploadRun(serviceReturning(error), 'ghosts-a', new Uint8Array([1, 2]));

        expect(url).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });

    test('any OTHER mint failure falls back but says so', async () => {
        // Storage exists and refused. Worth knowing, because this is what
        // silently pushes runs back into the game's 1 MB entry quota.
        const error = new GameDataError(429, 'too_many_requests', 'slow down', null);
        const url = await uploadRun(serviceReturning(error), 'ghosts-a', new Uint8Array([1, 2]));

        expect(url).toBeNull();
        expect(warn).toHaveBeenCalled();
    });

    test('a rejected PUT falls back rather than losing the run', async () => {
        global.fetch = (async () => ({ ok: false, status: 403 } as Response)) as unknown as typeof fetch;
        expect(await uploadRun(serviceReturning(TARGET), 'ghosts-a', new Uint8Array([1]))).toBeNull();
    });

    test('a network failure mid-PUT falls back rather than throwing', async () => {
        // `finishRun` calls this from a game's finish-line handler. A throw here
        // takes the results screen down over a failure that only costs a ghost.
        global.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
        expect(await uploadRun(serviceReturning(TARGET), 'ghosts-a', new Uint8Array([1]))).toBeNull();
    });
});

describe('loadRun', () => {
    test('reads an inline run — the device\'s own, and every pre-storage entry', async () => {
        const record = run();
        const loaded = await loadRun({ kind: 'inline', encoded: await encodeRun(record) });
        expect(loaded.durationMs).toBe(record.durationMs);
    });

    test('fetches a stored object and decodes its bytes', async () => {
        const bytes = await encodeRunBytes(run());
        global.fetch = (async (url: string) => {
            expect(url).toBe(TARGET.publicUrl);
            return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as unknown as Response;
        }) as unknown as typeof fetch;

        expect((await loadRun({ kind: 'url', url: TARGET.publicUrl })).durationMs).toBe(2000);
    });

    test('an unreachable object arrives as a FORMAT error, not a bare TypeError', async () => {
        // Callers skip a ghost they cannot read and that decision keys off the
        // type, so a network failure has to arrive as one too.
        global.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
        await expect(loadRun({ kind: 'url', url: TARGET.publicUrl })).rejects.toThrow(ReplayFormatError);
    });

    test('a 404 object arrives as a format error too', async () => {
        global.fetch = (async () => ({ ok: false, status: 404 } as Response)) as unknown as typeof fetch;
        await expect(loadRun({ kind: 'url', url: TARGET.publicUrl })).rejects.toThrow(ReplayFormatError);
    });
});
