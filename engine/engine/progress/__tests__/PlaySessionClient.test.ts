import {
    heartbeatPayload,
    classifyHeartbeatStatus,
    SessionUnlockDedup,
    buildAchievementDefMap,
    PlayProgressClient,
    EARLY_MEASURE_AT_MS,
    type PlayProgressDeps,
} from 'engine/progress/PlaySessionClient.js';
import { isActive, gamepadSignature, IDLE_AFTER_MS } from 'engine/progress/ActivityTracker.js';

/**
 * Unit tests for the PURE, stateless pieces of the play-progress subsystem. The
 * live session/heartbeat loop and fetch calls are runtime-verified (they need a
 * real game runtime + api-server); here we pin the decision logic the loop
 * depends on.
 */
describe('heartbeatPayload', () => {
    it('reports visible only when the tab is not hidden', () => {
        expect(heartbeatPayload(false)).toMatchObject({ visible: true });
        expect(heartbeatPayload(true)).toMatchObject({ visible: false });
    });
});

describe('classifyHeartbeatStatus', () => {
    it('maps 2xx to ok', () => {
        expect(classifyHeartbeatStatus(200)).toBe('ok');
        expect(classifyHeartbeatStatus(204)).toBe('ok');
    });
    it('maps 410 to restart (session expired)', () => {
        expect(classifyHeartbeatStatus(410)).toBe('restart');
    });
    it('maps 429 to skip (too soon)', () => {
        expect(classifyHeartbeatStatus(429)).toBe('skip');
    });
    it('maps everything else to error', () => {
        expect(classifyHeartbeatStatus(403)).toBe('error');
        expect(classifyHeartbeatStatus(404)).toBe('error');
        expect(classifyHeartbeatStatus(500)).toBe('error');
    });
});

describe('SessionUnlockDedup', () => {
    it('claims an id once, then ignores repeats', () => {
        const dedup = new SessionUnlockDedup();
        expect(dedup.claim('first_blood')).toBe(true);
        expect(dedup.claim('first_blood')).toBe(false);
        expect(dedup.claim('first_blood')).toBe(false);
    });

    it('tracks distinct ids independently', () => {
        const dedup = new SessionUnlockDedup();
        expect(dedup.claim('a')).toBe(true);
        expect(dedup.claim('b')).toBe(true);
        expect(dedup.claim('a')).toBe(false);
    });

    it('reset() re-allows a previously claimed id (new session)', () => {
        const dedup = new SessionUnlockDedup();
        expect(dedup.claim('a')).toBe(true);
        dedup.reset();
        expect(dedup.claim('a')).toBe(true);
    });
});

describe('buildAchievementDefMap', () => {
    it('indexes id → name, art and xp for the unlock toast', () => {
        const map = buildAchievementDefMap([
            { achievementId: 'first_blood', name: 'First Blood' },
            { achievementId: 'speed_run', name: 'Speed Run', imageUrl: 'https://cdn/sr.webp', xp: 100, hidden: true },
        ]);
        expect(map.get('first_blood')).toEqual({ name: 'First Blood', imageUrl: null, xp: 0 });
        expect(map.get('speed_run')).toEqual({ name: 'Speed Run', imageUrl: 'https://cdn/sr.webp', xp: 100 });
        expect(map.size).toBe(2);
    });

    it('returns an empty map for undefined/null', () => {
        expect(buildAchievementDefMap(undefined).size).toBe(0);
        expect(buildAchievementDefMap(null).size).toBe(0);
    });

    it('skips malformed entries (missing or empty id/name)', () => {
        const map = buildAchievementDefMap([
            { achievementId: 'ok', name: 'Ok' },
            { achievementId: '', name: 'NoId' },
            { achievementId: 'noName' },
            { name: 'NoId2' },
            { achievementId: 'blankName', name: '' },
            null as unknown as { achievementId?: unknown; name?: unknown },
        ]);
        expect(map.size).toBe(1);
        expect(map.get('ok')).toMatchObject({ name: 'Ok' });
    });
});

describe('PlayProgressClient session loop', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.useRealTimers();
    });

    /** A fetch stub that answers session-create with an id and anything else 200. */
    function stubFetch(): jest.Mock {
        const mock = jest.fn(async (url: string) => ({
            ok: true,
            status: 200,
            json: async () => (String(url).endsWith('/api/play/sessions') ? { sessionId: 's1' } : {}),
        }));
        globalThis.fetch = mock as unknown as typeof fetch;
        return mock;
    }

    function sessionCreateCalls(mock: jest.Mock): number {
        return mock.mock.calls.filter(([url]) => String(url).endsWith('/api/play/sessions')).length;
    }

    /**
     * A client wired to a signed-in player and no-op sinks; each test overrides
     * only the dep it exercises. Keeps a new dep from having to be stubbed in
     * every test below.
     */
    function makeClient(overrides: Partial<PlayProgressDeps> = {}): PlayProgressClient {
        return new PlayProgressClient({
            getPlayerToken: async () => 'play-token',
            showUnlock: () => {},
            reportGuestUnlock: () => {},
            sendGuestHeartbeat: () => {},
            ...overrides,
        });
    }

    interface BeatBody { visibleMs: number; measureOnly?: boolean }

    /** Every POST to a heartbeat URL, as its parsed body, in order. */
    function heartbeatBodies(mock: jest.Mock): BeatBody[] {
        return mock.mock.calls
            .filter(([url]) => String(url).endsWith('/heartbeat'))
            .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as BeatBody);
    }

    /** The visibleMs each CREDITING heartbeat carried, in order — the 60 s loop, not the first-minute readings. */
    function heartbeatVisibleMs(mock: jest.Mock): number[] {
        return heartbeatBodies(mock).filter((b) => b.measureOnly !== true).map((b) => b.visibleMs);
    }

    /** The visibleMs each duration-only measurement beat carried, in order. */
    function measurementVisibleMs(mock: jest.Mock): number[] {
        return heartbeatBodies(mock).filter((b) => b.measureOnly === true).map((b) => b.visibleMs);
    }

    it('opens the session on a later tick when the first token attempt returns guest', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();
        let token: string | null = null;

        const client = makeClient({ getPlayerToken: async () => token });
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(0);

        // Guest at start: nothing reported yet, but the loop must still be armed.
        expect(sessionCreateCalls(mock)).toBe(0);

        // The player signs in (or the token bridge recovers) mid-session.
        token = 'play-token';
        await jest.advanceTimersByTimeAsync(60_000);

        expect(sessionCreateCalls(mock)).toBe(1);
        client.stop();
    });

    it('keeps heartbeating after the session opens', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();

        const client = makeClient();
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(0);
        expect(sessionCreateCalls(mock)).toBe(1);

        await jest.advanceTimersByTimeAsync(60_000);
        expect(heartbeatVisibleMs(mock)).toHaveLength(1);
        client.stop();
    });

    it('writes the duration down twice inside the first minute, before any crediting beat can land', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();

        const client = makeClient();
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(EARLY_MEASURE_AT_MS[EARLY_MEASURE_AT_MS.length - 1]);

        // A player who leaves now, with the exit flush lost, still has a time.
        const measured = measurementVisibleMs(mock);
        expect(measured).toHaveLength(EARLY_MEASURE_AT_MS.length);
        measured.forEach((ms, i) => {
            expect(ms).toBeGreaterThanOrEqual(EARLY_MEASURE_AT_MS[i]);
            expect(ms).toBeLessThan(EARLY_MEASURE_AT_MS[i] + 1_000);
        });
        expect(heartbeatVisibleMs(mock)).toHaveLength(0);
        client.stop();
    });

    it('leaves a guest\'s first minute to the portal bridge, and drops pending readings on stop()', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();

        const guest = makeClient({ getPlayerToken: async () => null });
        guest.configure('GAME12345678', new Map());
        guest.startSession();
        await jest.advanceTimersByTimeAsync(45_000);
        expect(heartbeatBodies(mock)).toHaveLength(0);
        guest.stop();

        const signedIn = makeClient();
        signedIn.configure('GAME12345678', new Map());
        signedIn.startSession();
        await jest.advanceTimersByTimeAsync(0);
        signedIn.stop();
        await jest.advanceTimersByTimeAsync(45_000);
        expect(heartbeatBodies(mock)).toHaveLength(0);
    });

    it('stop() ends the loop', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();

        const client = makeClient();
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(0);
        client.stop();

        const before = mock.mock.calls.length;
        await jest.advanceTimersByTimeAsync(180_000);
        expect(mock.mock.calls.length).toBe(before);
    });

    it('stop() during the in-flight open leaves the loop dead (no timer resurrection)', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();
        let releaseToken: (t: string | null) => void = () => {};
        const gate = new Promise<string | null>((res) => { releaseToken = res; });

        // The portal handshake can take many seconds.
        const client = makeClient({ getPlayerToken: () => gate });
        client.configure('GAME12345678', new Map());
        client.startSession();
        client.stop(); // engine disposed while the token request is still pending

        releaseToken('play-token');
        await jest.advanceTimersByTimeAsync(180_000);
        expect(mock.mock.calls.length).toBe(0);
    });

    function unlockCalls(mock: jest.Mock): number {
        return mock.mock.calls.filter(([url]) => String(url).endsWith('/api/play/achievements/unlock')).length;
    }

    it('queues an unlock fired before the session opens and posts it once it does', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();
        const toasts: string[] = [];

        const client = makeClient({ showUnlock: (e) => toasts.push(e.name) });
        client.configure('GAME12345678', new Map([['early_bird', { name: 'Early Bird', imageUrl: null, xp: 25 }]]));
        client.startSession();
        // Game code unlocks immediately at boot — before the async session open lands.
        client.unlockAchievement('early_bird');
        expect(toasts).toEqual(['Early Bird']); // toast is instant regardless

        await jest.advanceTimersByTimeAsync(0);
        expect(sessionCreateCalls(mock)).toBe(1);
        expect(unlockCalls(mock)).toBe(1);
        client.stop();
    });

    it('a guest beats through the bridge — immediately at start, then every tick', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();
        const guestBeats: Array<{ visible: boolean; active: boolean; visibleMs: number }> = [];

        const client = makeClient({
            getPlayerToken: async () => null,
            sendGuestHeartbeat: (beat) => guestBeats.push(beat),
        });
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(0);

        // The opening beat goes out at once, so the bridge can claim the session
        // inside the portal fallback's grace window rather than 60 s later.
        expect(guestBeats).toHaveLength(1);
        expect(guestBeats[0]).toMatchObject({ visible: true, active: true });
        expect(sessionCreateCalls(mock)).toBe(0); // never the signed-in lane

        await jest.advanceTimersByTimeAsync(120_000);
        expect(guestBeats).toHaveLength(3);
        // The running total is the PLAY's visible time, monotonic across beats.
        expect(guestBeats[2].visibleMs).toBeGreaterThanOrEqual(guestBeats[1].visibleMs);
        expect(guestBeats[2].visibleMs).toBeGreaterThanOrEqual(120_000);
        client.stop();
    });

    it('signing in mid-play moves to the signed-in lane with a fresh clock', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();
        const guestBeats: number[] = [];
        let token: string | null = null;

        const client = makeClient({
            getPlayerToken: async () => token,
            sendGuestHeartbeat: (beat) => guestBeats.push(beat.visibleMs),
        });
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(120_000); // two guest ticks after the opener
        expect(guestBeats).toHaveLength(3);

        token = 'play-token'; // signed in on the portal at t=120 s
        await jest.advanceTimersByTimeAsync(60_000); // t=180 s: signed-in session opens
        expect(sessionCreateCalls(mock)).toBe(1);
        expect(guestBeats).toHaveLength(3); // no further guest beats

        await jest.advanceTimersByTimeAsync(60_000); // t=240 s: first signed-in heartbeat
        const [first] = heartbeatVisibleMs(mock);
        // The guest row already holds the first 180 s. Handing the same total to
        // the signed-in row would count it twice, so the clock restarted at 180 s.
        expect(first).toBeGreaterThanOrEqual(60_000);
        expect(first).toBeLessThan(120_000);
        client.stop();
    });

    it('a 410 restart opens a new session with a fresh clock', async () => {
        jest.useFakeTimers();
        let beats = 0;
        const mock = jest.fn(async (url: string, init?: RequestInit) => {
            const u = String(url);
            if (u.endsWith('/api/play/sessions')) return { ok: true, status: 200, json: async () => ({ sessionId: 's1' }) };
            // Only the 60 s loop is counted: a first-minute reading is answered 200 and ignored.
            if (u.endsWith('/heartbeat') && (JSON.parse(String(init?.body)) as BeatBody).measureOnly !== true) {
                beats++;
                // The second heartbeat finds the session expired.
                return beats === 2 ? { ok: false, status: 410, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });
        globalThis.fetch = mock as unknown as typeof fetch;

        const client = makeClient();
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(60_000); // beat 1: 200, ~60 s
        await jest.advanceTimersByTimeAsync(60_000); // beat 2: 410 -> restart at ~120 s
        expect(sessionCreateCalls(mock)).toBe(2);
        await jest.advanceTimersByTimeAsync(60_000); // beat 3 on the new session at ~180 s
        const ms = heartbeatVisibleMs(mock);
        expect(ms).toHaveLength(3);
        expect(ms[0]).toBeGreaterThanOrEqual(60_000);
        // The finished row keeps its 120 s; the new row counts only from the restart.
        expect(ms[2]).toBeGreaterThanOrEqual(60_000);
        expect(ms[2]).toBeLessThan(120_000);
        client.stop();
    });

    it('reports a guest unlock to the anonymous lane instead of dropping it', async () => {
        jest.useFakeTimers();
        stubFetch();
        const guestReported: string[] = [];

        const client = makeClient({
            getPlayerToken: async () => null, // stays signed out
            reportGuestUnlock: (id) => guestReported.push(id),
        });
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(0);
        client.unlockAchievement('guest_goal');

        // Held while we waited for a token; the next tick confirms guest and flushes.
        await jest.advanceTimersByTimeAsync(60_000);
        expect(guestReported).toEqual(['guest_goal']);
        client.stop();
    });

    it('flushes a guest unlock when the player signs in mid-session', async () => {
        jest.useFakeTimers();
        const mock = stubFetch();
        let token: string | null = null;

        const client = makeClient({ getPlayerToken: async () => token });
        client.configure('GAME12345678', new Map());
        client.startSession();
        await jest.advanceTimersByTimeAsync(0);
        client.unlockAchievement('guest_goal'); // guest: toast only, held pending
        expect(unlockCalls(mock)).toBe(0);

        token = 'play-token'; // player signs in on the portal mid-play
        await jest.advanceTimersByTimeAsync(60_000);
        expect(unlockCalls(mock)).toBe(1);
        client.stop();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Idle detection — a visible tab with nobody there must stop counting as play.
// ════════════════════════════════════════════════════════════════════════════

describe('heartbeatPayload with activity', () => {
    it('reports both visibility and activity', () => {
        expect(heartbeatPayload(false, true)).toEqual({ visible: true, active: true });
        expect(heartbeatPayload(false, false)).toEqual({ visible: true, active: false });
        expect(heartbeatPayload(true, true)).toEqual({ visible: false, active: true });
    });

    it('defaults active to true — a caller that cannot see input must not report idle', () => {
        expect(heartbeatPayload(false)).toEqual({ visible: true, active: true });
    });
});

describe('isActive', () => {
    const NOW = 1_000_000;

    it('counts input inside the window and not outside it', () => {
        expect(isActive(NOW, NOW)).toBe(true);
        expect(isActive(NOW - (IDLE_AFTER_MS - 1), NOW)).toBe(true);
        expect(isActive(NOW - IDLE_AFTER_MS, NOW)).toBe(false);
        expect(isActive(NOW - 8 * 60 * 60_000, NOW)).toBe(false); // abandoned overnight
    });

    it('takes an explicit window', () => {
        expect(isActive(NOW - 5_000, NOW, 10_000)).toBe(true);
        expect(isActive(NOW - 15_000, NOW, 10_000)).toBe(false);
    });
});

describe('gamepadSignature', () => {
    const pad = (over: Partial<Gamepad>): Gamepad => ({
        index: 0, id: 'pad', connected: true, mapping: 'standard', timestamp: 0,
        axes: [0, 0], buttons: [{ pressed: false, touched: false, value: 0 }],
        ...over,
    } as Gamepad);

    it('changes when a button goes down — pad input fires no DOM events', () => {
        const up = gamepadSignature([pad({})]);
        const down = gamepadSignature([pad({ buttons: [{ pressed: true, touched: true, value: 1 }] as unknown as readonly GamepadButton[] })]);
        expect(down).not.toBe(up);
    });

    it('changes when a stick moves', () => {
        expect(gamepadSignature([pad({ axes: [0.8, 0] })])).not.toBe(gamepadSignature([pad({ axes: [0, 0] })]));
    });

    it('ignores resting-stick jitter, which never settles at exactly zero', () => {
        expect(gamepadSignature([pad({ axes: [0.01, -0.02] })])).toBe(gamepadSignature([pad({ axes: [0, 0] })]));
    });

    it('is stable with no pads, and skips empty slots', () => {
        expect(gamepadSignature([])).toBe('');
        expect(gamepadSignature([null, null])).toBe('');
    });

    it('distinguishes two pads from one', () => {
        expect(gamepadSignature([pad({}), pad({ index: 1 })])).not.toBe(gamepadSignature([pad({})]));
    });
});
