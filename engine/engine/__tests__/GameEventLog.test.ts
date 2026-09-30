import { GameEventLog, type TimelineSession, MAX_HUD_BYTES_PER_SESSION } from 'engine/recording/GameEventLog.js';

/**
 * The log's contract is "always callable, free when idle": call sites fire
 * permanently from hot engine paths, so logging outside a session must store
 * nothing, and a session must collect exactly what fired while it was active.
 * Debounce keeps auto-fire/damage ticks from flooding the timeline without
 * suppressing distinct actors. Sessions are owner-gated: the last starter wins
 * and only the current owner can end one.
 */

function makeLog(frameRef: { frame: number }): GameEventLog {
    const log = new GameEventLog();
    log.startSession(() => frameRef.frame, 'recorder');
    return log;
}

/** End the session as its owner; these tests always end what they started. */
function endSession(log: GameEventLog): TimelineSession {
    const session = log.endSession('recorder');
    if (session === null) throw new Error('expected the owner to be able to end its own session');
    return session;
}

describe('GameEventLog', () => {
    it('ignores everything when no session is active', () => {
        const log = new GameEventLog();
        log.logEvent({ type: 'explosion' });
        log.logAssetSound('boom', 'https://x/boom.opus', 0.8);
        log.logSynthSound('coin');
        log.logMusic('play', { assetId: 'm' });
        log.startSession(() => 0, 'recorder');
        const session = endSession(log);
        expect(session.events).toHaveLength(0);
        expect(session.sounds).toHaveLength(0);
        expect(session.music).toHaveLength(0);
    });

    it('stamps entries with the provider frame and clears on endSession', () => {
        const frameRef = { frame: 120 };
        const log = makeLog(frameRef);
        log.logEvent({ type: 'explosion', position: { x: 1.234, y: 0, z: -2.567 } });
        frameRef.frame = 180;
        log.logAssetSound('boom', 'https://x/boom.opus');
        const session = endSession(log);
        expect(session.events).toEqual([
            { frame: 120, type: 'explosion', intensity: 0.9, position: [1.23, 0, -2.57] },
        ]);
        expect(session.sounds).toEqual([
            { frame: 180, kind: 'asset', assetId: 'boom', url: 'https://x/boom.opus' },
        ]);
        // A second session starts empty.
        log.startSession(() => 0, 'recorder');
        expect(endSession(log).events).toHaveLength(0);
    });

    it('defaults intensity per type and clamps explicit values', () => {
        const log = makeLog({ frame: 0 });
        log.logEvent({ type: 'pickup' });
        log.logEvent({ type: 'never-heard-of-it' });
        log.logEvent({ type: 'damage', intensity: 7 });
        const [pickup, unknown, damage] = endSession(log).events;
        expect(pickup.intensity).toBeCloseTo(0.3);
        expect(unknown.intensity).toBeCloseTo(0.7);
        expect(damage.intensity).toBe(1);
    });

    it('debounces per type+actor without suppressing other actors', () => {
        const frameRef = { frame: 0 };
        const log = makeLog(frameRef);
        log.logEvent({ type: 'shot', actor: 'player' });
        frameRef.frame = 4; // inside the 10-frame shot cooldown
        log.logEvent({ type: 'shot', actor: 'player' });
        log.logEvent({ type: 'shot', actor: 'npc:turret' });
        frameRef.frame = 12; // cooldown elapsed
        log.logEvent({ type: 'shot', actor: 'player' });
        const shots = endSession(log).events;
        expect(shots.map((e) => [e.frame, e.actor])).toEqual([
            [0, 'player'],
            [4, 'npc:turret'],
            [12, 'player'],
        ]);
    });

    it('never debounces types without a cooldown', () => {
        const log = makeLog({ frame: 5 });
        log.logEvent({ type: 'explosion' });
        log.logEvent({ type: 'explosion' });
        expect(endSession(log).events).toHaveLength(2);
    });

    it('drops non-finite positions instead of writing NaN into the timeline', () => {
        const log = makeLog({ frame: 0 });
        log.logEvent({ type: 'explosion', position: { x: Number.NaN, y: 0, z: 0 } });
        const [event] = endSession(log).events;
        expect(event.position).toBeUndefined();
    });

    it('records synth recipes and music transitions', () => {
        const frameRef = { frame: 30 };
        const log = makeLog(frameRef);
        log.logSynthSound('coin', { dur: 0.2, layers: [{ wave: 'square', freq: [880, 1320], gain: [0.3, 0] }] });
        log.logMusic('play', { assetId: 'theme', url: 'https://x/theme.opus', volume: 0.6, loop: true });
        frameRef.frame = 300;
        log.logMusic('stop', { fadeOut: 0.5 });
        const session = endSession(log);
        expect(session.sounds).toEqual([
            {
                frame: 30, kind: 'synth', name: 'coin',
                recipe: { dur: 0.2, layers: [{ wave: 'square', freq: [880, 1320], gain: [0.3, 0] }] },
            },
        ]);
        expect(session.music).toEqual([
            { frame: 30, action: 'play', assetId: 'theme', url: 'https://x/theme.opus', volume: 0.6, loop: true },
            { frame: 300, action: 'stop', fadeOut: 0.5 },
        ]);
    });

    it('records HUD ops with frames and drops visually identical repeats', () => {
        const frameRef = { frame: 10 };
        const log = makeLog(frameRef);
        log.logHud({ op: 'create', id: 'score', elType: 'counter', params: { anchor: 'top-right', text: '0' } });
        frameRef.frame = 20;
        log.logHud({ op: 'update', id: 'score', text: '100' });
        frameRef.frame = 21;
        log.logHud({ op: 'update', id: 'score', text: '100' }); // unchanged — dropped
        frameRef.frame = 30;
        log.logHud({ op: 'update', id: 'score', text: '250' });
        const hud = endSession(log).hud;
        expect(hud).toEqual([
            { frame: 10, op: 'create', id: 'score', elType: 'counter', params: { anchor: 'top-right', text: '0' } },
            { frame: 20, op: 'update', id: 'score', text: '100' },
            { frame: 30, op: 'update', id: 'score', text: '250' },
        ]);
    });

    it('distinguishes payload fields that share their characters', () => {
        // The dedupe compares payload strings rather than JSON.stringify(op),
        // so the encoding has to keep field boundaries: these two ops differ.
        const log = makeLog({ frame: 0 });
        log.logHud({ op: 'custom-html', id: 'w', html: 'a b', css: '' });
        log.logHud({ op: 'custom-html', id: 'w', html: 'a', css: 'b' });
        expect(endSession(log).hud).toHaveLength(2);
    });

    it('drops an absent optional distinctly from an empty one', () => {
        const log = makeLog({ frame: 0 });
        log.logHud({ op: 'custom-html', id: 'w', html: 'x' });
        log.logHud({ op: 'custom-html', id: 'w', html: 'x', css: '' });
        expect(endSession(log).hud).toHaveLength(2);
    });

    it('dedupes theme ops and snapshots the theme at log time', () => {
        const log = makeLog({ frame: 0 });
        // Games hold one live theme object and mutate it; without a snapshot
        // every logged op would alias it and serialize the FINAL values.
        const theme: { name: string; decorations: Record<string, unknown> } = { name: 'brass', decorations: {} };
        log.logHud({ op: 'theme', theme });
        log.logHud({ op: 'theme', theme }); // identical — dropped
        theme.name = 'copper';
        log.logHud({ op: 'theme', theme }); // genuinely changed — kept
        const hud = endSession(log).hud;
        expect(hud).toHaveLength(2);
        expect(hud[0]).toEqual({ frame: 0, op: 'theme', theme: { name: 'brass', decorations: {} } });
        expect(hud[1]).toEqual({ frame: 0, op: 'theme', theme: { name: 'copper', decorations: {} } });
    });

    it('does not suppress a post-recreate update that matches the pre-remove value', () => {
        const log = makeLog({ frame: 0 });
        log.logHud({ op: 'create', id: 'x', elType: 'counter', params: { text: '1' } });
        log.logHud({ op: 'update', id: 'x', text: '2' });
        log.logHud({ op: 'remove', id: 'x' });
        log.logHud({ op: 'create', id: 'x', elType: 'counter', params: { text: '1' } });
        log.logHud({ op: 'update', id: 'x', text: '2' }); // real change again after recreate
        const ops = endSession(log).hud.map((o) => o.op);
        expect(ops).toEqual(['create', 'update', 'remove', 'create', 'update']);
    });

    it('keeps per-element dedupe independent and ignores HUD ops outside a session', () => {
        const log = makeLog({ frame: 5 });
        log.logHud({ op: 'update', id: 'a', text: 'same' });
        log.logHud({ op: 'update', id: 'b', text: 'same' }); // different element — kept
        log.logHud({ op: 'timer', id: 't', action: 'start', seconds: 90 });
        log.logHud({ op: 'toast', message: 'Go!', variant: 'success', durationMs: 2000 });
        expect(endSession(log).hud).toHaveLength(4);
        log.logHud({ op: 'update', id: 'a', text: 'ignored' });
        log.startSession(() => 0, 'recorder');
        expect(endSession(log).hud).toHaveLength(0);
    });

    // The snapshot is __bmDebug's read path: an external observer (bitmagic
    // verify) must be able to look at the timeline mid-run without ending it.
    describe('getSnapshot', () => {
        it('returns everything so far without ending the session, and keeps growing', () => {
            const log = makeLog({ frame: 0 });
            log.logEvent({ type: 'player-death' });
            const first = log.getSnapshot();
            expect(first.events).toHaveLength(1);
            expect(log.isActive()).toBe(true);
            log.logEvent({ type: 'pickup' });
            expect(log.getSnapshot().events).toHaveLength(2);
            // endSession still hands over the full session afterwards.
            expect(endSession(log).events).toHaveLength(2);
        });

        it('returns four empty arrays on an idle log', () => {
            expect(new GameEventLog().getSnapshot()).toEqual({
                events: [], sounds: [], music: [], hud: [],
            });
        });

        it('hands out copies — mutating a snapshot cannot touch the live session', () => {
            const log = makeLog({ frame: 0 });
            log.logEvent({ type: 'explosion' });
            const snapshot = log.getSnapshot();
            snapshot.events.push({ frame: 999, type: 'fake', intensity: 1 });
            expect(log.getSnapshot().events).toHaveLength(1);
        });
    });

    // Owner gating exists so the recorder's stop/dispose paths cannot silently
    // kill a passive ?eventlog=1 session — and so F9 can still take over.
    describe('session ownership', () => {
        it('refuses to end a session for a non-owner and keeps it running', () => {
            const log = new GameEventLog();
            log.startSession(() => 0, 'eventlog');
            log.logEvent({ type: 'player-death' });
            expect(log.endSession('recorder')).toBeNull();
            expect(log.isActive()).toBe(true);
            expect(log.getOwner()).toBe('eventlog');
            expect(log.getSnapshot().events).toHaveLength(1);
        });

        it('lets the last starter take over, after which the old owner cannot end it', () => {
            const log = new GameEventLog();
            log.startSession(() => 0, 'eventlog');
            log.logEvent({ type: 'pickup' });
            log.startSession(() => 60, 'recorder'); // F9 during an eventlog session
            expect(log.getOwner()).toBe('recorder');
            expect(log.getSnapshot().events).toHaveLength(0); // takeover discards
            expect(log.endSession('eventlog')).toBeNull();
            expect(log.isActive()).toBe(true);
            const session = log.endSession('recorder');
            expect(session).not.toBeNull();
            expect(log.getOwner()).toBeNull();
        });
    });

    it('budgets HUD bytes per session — refuses what no longer fits, not what does', () => {
        const log = makeLog({ frame: 0 });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            // 5 MiB ops: six fit a 32 MiB budget, the seventh does not, and the
            // remainder still admits a small op — per-op admission, not a shutter.
            const chunk = 5 * 1024 * 1024;
            const fits = Math.floor(MAX_HUD_BYTES_PER_SESSION / chunk);
            const body = 'x'.repeat(chunk - 64);
            for (let i = 0; i <= fits; i++) {
                log.logHud({ op: 'custom-html', id: 'w', html: body + String(i).padStart(8, '0') });
            }
            log.logHud({ op: 'update', id: 'score', text: '42' });
            const hud = endSession(log).hud;
            expect(hud.filter((o) => o.op === 'custom-html')).toHaveLength(fits);
            expect(hud[hud.length - 1]).toEqual({ frame: 0, op: 'update', id: 'score', text: '42' });
            expect(warn).toHaveBeenCalledTimes(1);
            // A new session starts with a fresh budget.
            log.startSession(() => 0, 'recorder');
            log.logHud({ op: 'custom-html', id: 'w', html: body + 'fresh000' });
            expect(endSession(log).hud).toHaveLength(1);
        } finally {
            warn.mockRestore();
        }
    });

    it('caps entries per kind instead of growing unbounded', () => {
        const log = makeLog({ frame: 0 });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        for (let i = 0; i < 20050; i++) {
            log.logEvent({ type: 'explosion' });
        }
        expect(endSession(log).events).toHaveLength(20000);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
