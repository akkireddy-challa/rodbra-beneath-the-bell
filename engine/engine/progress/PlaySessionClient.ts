/**
 * PlaySessionClient — the engine's play-session + achievement-unlock subsystem
 * (umbrella P6). Engine-template-level, not genre code: games cannot forget or
 * spoof-friendly-code it, and the api-server is authoritative for all XP + unlock
 * accounting anyway (this client just reports).
 *
 * Responsibilities:
 *   - Start a play session at game load (POST /api/play/sessions) and send a
 *     60 s heartbeat (POST .../heartbeat) carrying the tab-visible flag, so the
 *     server can credit visible minutes within its caps.
 *   - Report how long the session has lasted, unfloored: on every beat, on the
 *     exit flush, and twice inside the first minute (EARLY_MEASURE_AT_MS) so a
 *     short visit has a duration even when that flush is lost.
 *   - `unlockAchievement(id)`: dedup per session, always show a HUD toast (guests
 *     included), and — with a play token — post the unlock fire-and-forget.
 *
 * Every network path swallows its errors: play progress must NEVER disrupt
 * gameplay. Guests (no play token) cannot reach the anonymous lane from here —
 * it is keyed on a portal-origin session id and gated by a token a published
 * bundle cannot carry — so their heartbeats are relayed through the portal
 * bridge, which owns the anonymous session on the game's behalf. The tick keeps
 * re-asking for a token, so signing in mid-session moves to the signed-in lane
 * without a reload.
 *
 * The wall-clock cache/expiry decisions and the small stateless helpers are split
 * out as PURE, unit-tested functions/classes; the live session loop + fetch calls
 * are runtime-verified. All auth/session validation is server-side.
 */

import { API_SERVER_BASE_URL, API_SERVER_TOKEN } from 'engine/config.js';
import { ActivityTracker } from 'engine/progress/ActivityTracker.js';
import { VisibleClock } from 'engine/progress/VisibleClock.js';

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * When, after a session opens, its duration is first written down. Crediting
 * beats start at 60 s and the exit flush does not always outlive the page, so
 * without these a player who left inside the first minute had no time at all —
 * and an unmeasured session is left out of every play-time figure. Ten seconds
 * is the first moment worth calling a play; thirty is the edge of the shortest
 * duration bucket the creator's chart draws. Signed-in lane only: a guest's
 * session belongs to the portal bridge, which takes the same two readings
 * itself (portal guest-session-relay.ts).
 */
export const EARLY_MEASURE_AT_MS: readonly number[] = [10_000, 30_000];

/** Fallback toast text when a game unlocks an id with no authored definition. */
export const DEFAULT_ACHIEVEMENT_TOAST = 'Achievement unlocked';

// ════════════════════════════════════════════════════════════════════════════
// Pure helpers (unit-tested)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the heartbeat body. The server credits only time that was both VISIBLE
 * and ACTIVE, so we report the inverse of `document.hidden` plus whether any
 * input arrived recently (ActivityTracker). `active` defaults true so a caller
 * that cannot observe input never reports a present player as idle.
 */
export function heartbeatPayload(documentHidden: boolean, active: boolean = true): { visible: boolean; active: boolean } {
    return { visible: !documentHidden, active };
}

/** What the client should do next after a heartbeat POST, keyed off its status. */
export type HeartbeatAction = 'ok' | 'restart' | 'skip' | 'error';

/**
 * Classify a heartbeat response status:
 *   - 2xx → `ok` (credited or benignly not)
 *   - 410 → `restart` (session expired server-side; open a fresh one)
 *   - 429 → `skip` (too soon; the interval will try again next tick)
 *   - anything else → `error` (swallowed)
 * Mirrors the 401→re-auth shape of GameDataService, but for 410→re-session.
 */
export function classifyHeartbeatStatus(status: number): HeartbeatAction {
    if (status >= 200 && status < 300) return 'ok';
    if (status === 410) return 'restart';
    if (status === 429) return 'skip';
    return 'error';
}

/**
 * Per-session unlock dedup. `claim(id)` returns true the first time an id is seen
 * this session (act on it: toast + post) and false on repeats (ignore entirely).
 */
export class SessionUnlockDedup {
    private readonly unlocked = new Set<string>();

    claim(id: string): boolean {
        if (this.unlocked.has(id)) return false;
        this.unlocked.add(id);
        return true;
    }

    reset(): void {
        this.unlocked.clear();
    }
}

/** What the unlock toast needs about an achievement, indexed from game data. */
export interface AchievementToastDef {
    name: string;
    imageUrl: string | null;
    xp: number;
}

/**
 * Index authored achievement definitions by id → {name, art, xp} for the unlock
 * toast. Malformed entries (missing id or name) are skipped; a missing array
 * yields an empty map (every unlock then uses the generic toast text).
 */
export function buildAchievementDefMap(
    defs: ReadonlyArray<{ achievementId?: unknown; name?: unknown; imageUrl?: unknown; xp?: unknown }> | undefined | null,
): Map<string, AchievementToastDef> {
    const map = new Map<string, AchievementToastDef>();
    if (!defs) return map;
    for (const def of defs) {
        if (
            def && typeof def.achievementId === 'string' && def.achievementId !== '' &&
            typeof def.name === 'string' && def.name !== ''
        ) {
            map.set(def.achievementId, {
                name: def.name,
                imageUrl: typeof def.imageUrl === 'string' && def.imageUrl !== '' ? def.imageUrl : null,
                xp: typeof def.xp === 'number' && Number.isFinite(def.xp) ? def.xp : 0,
            });
        }
    }
    return map;
}

function isDocumentHidden(): boolean {
    return typeof document !== 'undefined' && document.hidden === true;
}

/**
 * Attach/detach the page-lifecycle listeners the visible-ms clock rides on.
 * Guarded like isDocumentHidden: the engine's unit tests run under node, where
 * neither global exists, and the session loop must still work there.
 */
function bindPageLifecycle(bind: boolean, onVisibility: () => void, onPageHide: () => void): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (bind) {
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', onPageHide);
        return;
    }
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
}

// ════════════════════════════════════════════════════════════════════════════
// Subsystem (runtime-verified)
// ════════════════════════════════════════════════════════════════════════════

export interface PlayProgressDeps {
    /** Resolve the scoped play token, or null for a guest (from PlayerIdentity). */
    getPlayerToken: () => Promise<string | null>;
    /**
     * Render the unlock notification. Bound by GameEngine to the ENGINE's own
     * achievement toast — never a genre HUD hook, because `hud` is optional on
     * GenreGameInterface and unlocks were silently invisible in genres without one.
     */
    showUnlock: (entry: { name: string; imageUrl: string | null; xp: number }) => void;
    /**
     * Report a GUEST's unlock through the portal bridge (PlayerIdentity), which
     * credits it against the browser session id and claims it onto the account at
     * sign-up. Without this a signed-out player saw the popup and earned nothing.
     */
    reportGuestUnlock: (achievementId: string) => void;
    /**
     * Relay a GUEST heartbeat through the portal bridge (PlayerIdentity), which
     * opens and keeps the anonymous play session this game cannot open itself.
     * Without this a signed-out player on the phone path — where no portal page
     * exists to run its fallback session — earned no XP and measured as no play.
     */
    sendGuestHeartbeat: (beat: { visible: boolean; active: boolean; visibleMs: number }) => void;
}

/**
 * Owns the live session lifecycle and the unlock path. Constructed once and
 * reconfigured per game load via `configure()`.
 */
export class PlayProgressClient {
    private readonly baseUrl = API_SERVER_BASE_URL;
    private readonly apiToken = API_SERVER_TOKEN;
    private readonly dedup = new SessionUnlockDedup();
    private defs = new Map<string, AchievementToastDef>();
    private gameId: string | null = null;
    private sessionId: string | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private earlyMeasureTimers: Array<ReturnType<typeof setTimeout>> = [];
    /** Input-presence, so an abandoned-but-visible tab stops counting as play. */
    private readonly activity = new ActivityTracker();
    /**
     * Unfloored visible time for this session, reported on every beat and
     * flushed on pagehide. The server records the LARGER value it has seen, so
     * repeats are harmless and a lost flush costs precision, not the session.
     */
    private clock: VisibleClock | null = null;
    /**
     * True once this play has reported through the guest lane. The bridge keeps a
     * guest session row for it, and that row keeps the visible time it has been
     * told about — so a later switch to the signed-in lane must start a fresh
     * clock rather than hand the same total to a second row.
     */
    private guestLane = false;
    private readonly onVisibility = (): void => {
        if (!this.clock) return;
        if (isDocumentHidden()) {
            // Bank BEFORE the flush: a tab hidden for an hour must not count it.
            this.clock.hide(Date.now());
            void this.sendHeartbeat();
            return;
        }
        this.clock.show(Date.now());
    };
    // pagehide, not unload: unload never fires on iOS and is ignored where
    // bfcache is enabled. This is the beat that sees a visit shorter than the
    // 60 s tick — without it the whole sub-minute band is invisible.
    private readonly onPageHide = (): void => { void this.sendHeartbeat(); };
    private started = false;
    /**
     * Unlock ids claimed (toasted) before a session existed — fired during the
     * startup handshake window, or while the player was still a guest. Flushed
     * the moment a session opens, so early/guest unlocks are credited once the
     * player is (or becomes) signed in during this play session.
     */
    private pendingUnlocks: string[] = [];

    constructor(private readonly deps: PlayProgressDeps) {}

    /**
     * Bind to a freshly loaded game. Stops any prior session/heartbeat and clears
     * the per-session unlock dedup. `defs` maps achievement id → its toast data.
     */
    configure(gameId: string, defs: Map<string, AchievementToastDef>): void {
        this.stop();
        this.gameId = gameId;
        this.defs = defs;
        this.dedup.reset();
        this.pendingUnlocks = [];
    }

    /**
     * Start the play session + heartbeat loop. Idempotent per load. Guests get
     * the loop too, so a player who signs in mid-session starts being credited
     * at the next tick; unlock toasts work with or without a session.
     */
    startSession(): void {
        if (!this.gameId || this.started) return;
        this.started = true;
        this.clock = new VisibleClock(Date.now(), !isDocumentHidden());
        bindPageLifecycle(true, this.onVisibility, this.onPageHide);
        void this.openAndSchedule();
    }

    /**
     * Unlock an achievement (game-code entry point via `engine.unlockAchievement`).
     * Dedups per session, always toasts, and posts only when a live session +
     * play token exist. Never throws.
     */
    unlockAchievement(id: string): void {
        if (!id || !this.dedup.claim(id)) return;
        const def = this.defs.get(id);
        // Guarded: a rendering failure must not propagate into game code (this is
        // called straight from gameplay) nor skip the XP post below.
        try {
            this.deps.showUnlock({
                name: def?.name ?? DEFAULT_ACHIEVEMENT_TOAST,
                imageUrl: def?.imageUrl ?? null,
                xp: def?.xp ?? 0,
            });
        } catch {
            // ignored — the unlock still counts server-side
        }
        void this.postUnlock(id);
    }

    /** Stop the heartbeat loop and drop the session. Idempotent. */
    stop(): void {
        this.activity.stop();
        bindPageLifecycle(false, this.onVisibility, this.onPageHide);
        this.clock = null;
        this.guestLane = false;
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.clearEarlyMeasurements();
        this.sessionId = null;
        this.started = false;
    }

    private async openAndSchedule(): Promise<void> {
        const token = await this.deps.getPlayerToken();
        // stop() may have run while the token request was in flight (engine
        // disposed mid-handshake) — resuming here would resurrect the interval
        // on a dead client and keep crediting playtime while nobody plays.
        if (!this.started) return;
        // A missing token here is NOT final: the player may be a guest who signs
        // in later, or the token bridge may have failed this once. Schedule the
        // loop either way — sendHeartbeat() re-asks and opens the session as
        // soon as one is available. Giving up here instead used to cost the
        // player the entire page load.
        if (token) await this.createSession(token);
        // A guest opens their session immediately too. The desktop portal page
        // runs its own guest session unless the game claims one within its
        // grace window; waiting for the first 60 s tick would let both run and
        // credit one visit twice.
        //
        // Unlike createSession() above this cannot be awaited — the beat is a
        // postMessage, and the row is created a round trip later by the bridge
        // — so the timer below is armed BEFORE the guest's row exists, and a
        // tick forwarded as it arrives finds a row 59.9 s old and earns nothing.
        // That is put right where the row's age is known: the bridge holds a
        // tick until its minute is up (portal guest-session-relay.ts). Do not
        // add an acknowledgement here to wait on; published bundles are frozen,
        // and the hold already covers them and this one alike.
        else this.sendGuestBeat();
        if (this.started && this.heartbeatTimer === null) {
            this.activity.start();
            this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
        }
    }

    private async createSession(token: string): Promise<void> {
        const res = await this.postJson('/api/play/sessions', {}, token);
        if (!res || !res.ok || !this.started) return;
        const data = await res.json().catch(() => null) as { sessionId?: unknown } | null;
        if (data && (typeof data.sessionId === 'string' || typeof data.sessionId === 'number')) {
            this.sessionId = String(data.sessionId);
            this.scheduleEarlyMeasurements();
            void this.flushPendingUnlocks();
        }
    }

    /** Arm the first-minute readings for the row that just opened. */
    private scheduleEarlyMeasurements(): void {
        this.clearEarlyMeasurements();
        this.earlyMeasureTimers = EARLY_MEASURE_AT_MS.map((at) => setTimeout(() => void this.sendMeasurement(), at));
    }

    private clearEarlyMeasurements(): void {
        for (const timer of this.earlyMeasureTimers) clearTimeout(timer);
        this.earlyMeasureTimers = [];
    }

    /**
     * A measurement beat: this session's visible time so far and nothing else.
     * The server writes it down without crediting or touching the heartbeat
     * cadence. Its response is ignored — an expired row is the next tick's to
     * restart.
     */
    private async sendMeasurement(): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const token = await this.deps.getPlayerToken();
        if (!token || this.sessionId !== sessionId) return;
        await this.postJson(
            `/api/play/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
            { ...this.currentBeat(), measureOnly: true },
            token,
        );
    }

    /** One guest-lane beat: the same payload as a signed-in one, relayed via the bridge. */
    private sendGuestBeat(): void {
        this.guestLane = true;
        this.deps.sendGuestHeartbeat(this.currentBeat());
    }

    /**
     * A fresh clock for a fresh session ROW. visible_ms is stored per row and
     * folded per person, so carrying a finished row's total onto a new one would
     * count that time twice. The finished row keeps what it last recorded.
     */
    private restartClock(): void {
        this.clock = new VisibleClock(Date.now(), !isDocumentHidden());
    }

    /**
     * What every beat reports, whichever lane it goes down: the visible/active
     * flags and this session's visible time so far. Read at send time — a beat
     * describes the moment it leaves, not the moment it was scheduled.
     */
    private currentBeat(): { visible: boolean; active: boolean; visibleMs: number } {
        return {
            ...heartbeatPayload(isDocumentHidden(), this.activity.isActive()),
            visibleMs: this.clock?.elapsed(Date.now()) ?? 0,
        };
    }

    /**
     * Take the held unlock ids, emptying the queue. Clearing BEFORE the caller
     * acts on them is what keeps a re-entrant postUnlock() from re-queuing an id
     * that is already being flushed.
     */
    private takePendingUnlocks(): string[] {
        const pending = this.pendingUnlocks;
        this.pendingUnlocks = [];
        return pending;
    }

    /**
     * Hand any held unlocks to the guest lane. Called once we know the player is
     * staying signed out, so nothing sits in the queue forever.
     */
    private flushGuestUnlocks(): void {
        for (const id of this.takePendingUnlocks()) this.deps.reportGuestUnlock(id);
    }

    /** Post every unlock that was claimed before the session existed. */
    private async flushPendingUnlocks(): Promise<void> {
        for (const id of this.takePendingUnlocks()) {
            await this.postUnlock(id);
        }
    }

    private async sendHeartbeat(): Promise<void> {
        const token = await this.deps.getPlayerToken();
        if (!token) {
            // Still a guest: flush anything held while we waited for a token, so a
            // signed-out player's unlocks are credited to their session id, and
            // beat through the bridge that keeps their session.
            this.flushGuestUnlocks();
            this.sendGuestBeat();
            return;
        }
        if (!this.sessionId) {
            if (this.guestLane) {
                // Signed in mid-play. The bridge's guest row keeps the time it was
                // told about (and is claimed onto this account at sign-up); the
                // signed-in row starts counting from here.
                this.guestLane = false;
                this.restartClock();
            }
            await this.createSession(token);
            return;
        }
        const res = await this.postJson(
            `/api/play/sessions/${encodeURIComponent(this.sessionId)}/heartbeat`,
            this.currentBeat(),
            token,
        );
        if (!res) return;
        if (classifyHeartbeatStatus(res.status) === 'restart') {
            this.sessionId = null;
            this.restartClock();
            await this.createSession(token);
        }
    }

    private async postUnlock(id: string): Promise<void> {
        if (!this.sessionId) {
            // No session yet (startup handshake still in flight, or a guest who
            // may sign in later) — hold the unlock; createSession() flushes it.
            this.pendingUnlocks.push(id);
            return;
        }
        const token = await this.deps.getPlayerToken();
        if (!token) {
            // Signed out: the anonymous lane is keyed on a portal-origin session
            // id we cannot read, so relay through the bridge instead of dropping.
            this.deps.reportGuestUnlock(id);
            return;
        }
        await this.postJson('/api/play/achievements/unlock', { achievementId: id, sessionId: this.sessionId }, token);
    }

    /**
     * POST JSON to the api-server with both required credentials: the shared
     * X-API-Token (gates all /api/*) and the play Bearer. Returns the Response,
     * or null when the request throws — callers swallow both.
     */
    private async postJson(path: string, body: Record<string, unknown>, token: string): Promise<Response | null> {
        try {
            return await fetch(`${this.baseUrl}${path}`, {
                method: 'POST',
                // keepalive: the pagehide beat has to outlive the page it fires from.
                keepalive: true,
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Token': this.apiToken,
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
            });
        } catch {
            return null;
        }
    }
}

// Module-level singleton installed once by GameEngine's constructor via the
// @internal setter below — mirrors the setVoxelObjectEngine install pattern
// (no public engine.setX()). Game code reaches it only through
// engine.unlockAchievement(); the engine drives configure()/startSession().
let _playProgress: PlayProgressClient | null = null;

/** @internal Install the play-progress subsystem. Called by GameEngine. */
export function installPlayProgress(deps: PlayProgressDeps): PlayProgressClient {
    _playProgress = new PlayProgressClient(deps);
    return _playProgress;
}

/** The installed play-progress subsystem, or null before GameEngine installs it. */
export function getPlayProgress(): PlayProgressClient | null {
    return _playProgress;
}
