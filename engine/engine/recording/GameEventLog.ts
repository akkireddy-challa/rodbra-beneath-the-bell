/**
 * GameEventLog — always-on gameplay timeline log.
 *
 * Engine systems and game code call the log unconditionally at the moment
 * something happens (a shot, an explosion, a lap, a sound). When no recording
 * session is active every call is a single boolean check and returns — no
 * allocation, no storage.
 *
 * Two session owners exist:
 *  - `'recorder'` — the F9 ScreenRecorder's frame-by-frame trailer session:
 *    entries are stamped with the recorder's frame index (frame N is exactly
 *    N/60 s of output video) and collected into timeline.json at stop. See
 *    trailer-tool-design.md at the repo root for the full pipeline.
 *  - `'eventlog'` — the passive `?eventlog=1` session GameTemplate starts for
 *    `bitmagic verify`, clocked in gameplay-time pseudo-frames (elapsed
 *    gameplay seconds × 60) and read non-destructively via `getSnapshot()`.
 *
 * There is one session slot; the last starter wins (an F9 recording takes over
 * a passive eventlog session), and only the current owner can end it.
 */

export type TimelinePosition = [number, number, number];

/** Input accepted by logEvent — position may be a THREE.Vector3-like object. */
export interface GameEventInput {
    type: string;
    /** 0..1 how exciting this instance is; defaulted per type when omitted. */
    intensity?: number;
    position?: { x: number; y: number; z: number } | TimelinePosition;
    /** e.g. 'player', 'npc:guard', 'vehicle:2' — also the default debounce key. */
    actor?: string;
    data?: Record<string, unknown>;
}

export interface TimelineGameEvent {
    frame: number;
    type: string;
    intensity: number;
    position?: TimelinePosition;
    actor?: string;
    data?: Record<string, unknown>;
}

export interface SynthSoundRecipeLayer {
    wave: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise';
    /** Hz; [start, end] ramps linearly over the duration. Ignored for noise. */
    freq?: number | [number, number];
    /** 0..1; [start, end] ramps linearly over the duration. */
    gain?: number | [number, number];
}

/** Deterministic description of a synthesized SFX so it can be re-rendered offline. */
export interface SynthSoundRecipe {
    /** Duration in seconds. */
    dur: number;
    layers: SynthSoundRecipeLayer[];
}

export type TimelineSoundEvent =
    | { frame: number; kind: 'asset'; assetId: string; url: string; volume?: number }
    | { frame: number; kind: 'synth'; name: string; recipe?: SynthSoundRecipe };

export interface TimelineMusicEvent {
    frame: number;
    action: 'play' | 'stop';
    assetId?: string;
    url?: string;
    volume?: number;
    loop?: boolean;
    fadeIn?: number;
    fadeOut?: number;
}

/**
 * HUD state changes, recorded so the trailer compositor can rebuild the UI as
 * a transparent overlay (captured frames are UI-less — the HUD is DOM, not
 * WebGL). We record semantic state, never pixels: sparse deltas instead of
 * 60 fps rasterization, and timers replay from FRAME time, which is more
 * correct than their wall-clock ticking under a dilated recording.
 *
 * `update` carries the already-rendered text so the replay never has to apply
 * a game's `format` callback.
 */
export type TimelineHudOp =
    | { frame: number; op: 'create'; id: string; elType: HudElementKind; params: Record<string, unknown> }
    | { frame: number; op: 'update'; id: string; text?: string; icon?: string; percent?: number }
    | { frame: number; op: 'custom-html'; id: string; html: string; css?: string }
    | { frame: number; op: 'timer'; id: string; action: 'start' | 'pause' | 'reset'; seconds?: number }
    | { frame: number; op: 'show' | 'hide' | 'remove'; id: string }
    | { frame: number; op: 'health'; current: number; max: number }
    | { frame: number; op: 'health-visible'; visible: boolean; width?: number }
    | { frame: number; op: 'toast'; message: string; variant?: string; durationMs?: number; anchor?: string }
    | { frame: number; op: 'hud-visible'; visible: boolean }
    | { frame: number; op: 'theme'; theme: unknown }
    // A game-authored head stylesheet, captured so the replay harness can style
    // custom-element markup. `id` is the <style> element's own id; last write
    // per id wins on replay, and an empty `css` is a tombstone meaning the game
    // removed that sheet (without it a skin swapped by removal replays with
    // both skins applied at once).
    | { frame: number; op: 'stylesheet'; id: string; css: string };

export type HudElementKind = 'counter' | 'progress' | 'icon-text' | 'timer' | 'custom';

/**
 * The payload fields of a deduplicable HUD op, length-prefixed so no pair of
 * values can be confused for a different pair spelling the same characters
 * (`{html:'a b'}` must not match `{html:'a', css:'b'}`), and an absent
 * optional is encoded distinctly from an empty one.
 */
function joinFields(...values: Array<string | number | undefined>): string {
    let signature = '';
    for (const value of values) {
        if (value === undefined) {
            signature += '-|';
            continue;
        }
        const text = String(value);
        signature += `${text.length}|${text}`;
    }
    return signature;
}

function hudValueSignature(op: HudOpInput): string {
    switch (op.op) {
        case 'stylesheet':
            // The one field, compared in place: the map key already pins op
            // and id, and wrapping it in a length prefix would build a cons
            // string that V8 must flatten (copy up to 32 KB) to compare.
            return op.css;
        case 'custom-html':
            return joinFields(op.html, op.css);
        case 'update':
            return joinFields(op.text, op.icon, op.percent);
        default:
            return JSON.stringify(op);
    }
}

/**
 * A HUD op as call sites pass it — same union, minus the frame the log stamps.
 * Distributes over the union: a plain `Omit` would collapse it to the keys all
 * members share (i.e. none of the useful ones).
 */
export type HudOpInput = TimelineHudOp extends infer T
    ? T extends { frame: number } ? Omit<T, 'frame'> : never
    : never;

export interface TimelineSession {
    events: TimelineGameEvent[];
    sounds: TimelineSoundEvent[];
    music: TimelineMusicEvent[];
    hud: TimelineHudOp[];
}

/** Default intensity per event type when the call site doesn't pass one. */
const DEFAULT_INTENSITY: Record<string, number> = {
    'explosion': 0.9,
    'match-end': 1.0,
    'player-death': 0.9,
    'vehicle-collision': 0.7,
    'vehicle-hits-character': 0.8,
    'death': 0.8,
    'destruction': 0.6,
    'projectile-hit': 0.5,
    'damage': 0.3,
    'pickup': 0.3,
    'shot': 0.2,
    'state': 0.0,
};
const DEFAULT_INTENSITY_UNKNOWN = 0.7;

/**
 * Per-type debounce cooldown in frames, keyed by `type:actor`. Keeps
 * high-frequency sources (auto-fire, damage ticks) from flooding the timeline
 * while preserving enough density for the excitement curve. Types not listed
 * are never debounced.
 */
const DEBOUNCE_FRAMES: Record<string, number> = {
    'shot': 10,
    'damage': 20,
    'projectile-hit': 6,
    'destruction': 15,
};

/** Safety cap so a runaway caller can't grow the arrays unbounded mid-session. */
const MAX_ENTRIES_PER_KIND = 20000;

/**
 * Byte budget for one session's HUD track. The entry cap bounds COUNT, but
 * HUD ops carry free text — markup up to 16 KB, stylesheets up to 32 KB — so
 * 20000 of them can be hundreds of MB, past the 64 MiB body limit of the
 * `bitmagic dev` recording sink (cli/src/editor/recording-sink.ts), where the
 * whole timeline POST is refused and the recording has no timeline.json at
 * all. Half that limit: the other tracks are small (a 65 s real recording:
 * 3.4 MB hud, 39 KB everything else) and JSON escaping adds under 10% to what
 * is measured here. A real widget changing every few frames (~3.8 KB/op)
 * fills it in ~11 min, past `trailer record`'s 600 s maximum; a game
 * rewriting a 32 KB sheet every frame fills it in seconds and is warned then,
 * while the developer can see which widget is churning, not at stop.
 */
export const MAX_HUD_BYTES_PER_SESSION = 32 * 1024 * 1024;

/** Who is running the current session. See the file header for the two owners. */
export type EventLogOwner = 'recorder' | 'eventlog';

export class GameEventLog {
    private active = false;
    private owner: EventLogOwner | null = null;
    private frameProvider: (() => number) | null = null;
    private events: TimelineGameEvent[] = [];
    private sounds: TimelineSoundEvent[] = [];
    private music: TimelineMusicEvent[] = [];
    private hud: TimelineHudOp[] = [];
    private lastLoggedFrame = new Map<string, number>();
    private lastHudValue = new Map<string, string>();
    /** Theme ops carry no id, so they dedupe against this rather than the map. */
    private lastThemeValue: string | null = null;
    private sessionSerial = 0;
    private overflowWarned = false;
    private hudBytes = 0;
    private hudBytesWarned = false;

    isActive(): boolean {
        return this.active;
    }

    /** Who owns the current session, or null when idle. */
    getOwner(): EventLogOwner | null {
        return this.owner;
    }

    /**
     * Begin collecting. frameProvider returns the session's current clock value
     * (the recorder's frame index, or gameplay-time pseudo-frames — see the
     * file header). The last starter wins: starting over an active session
     * discards it, so an F9 recording takes over a passive eventlog session,
     * and a reloaded game re-takes its own with a provider bound to the new
     * engine.
     */
    startSession(frameProvider: () => number, owner: EventLogOwner): void {
        this.frameProvider = frameProvider;
        this.owner = owner;
        this.events = [];
        this.sounds = [];
        this.music = [];
        this.hud = [];
        this.lastLoggedFrame.clear();
        this.lastHudValue.clear();
        this.lastThemeValue = null;
        this.overflowWarned = false;
        this.hudBytes = 0;
        this.hudBytesWarned = false;
        this.sessionSerial++;
        this.active = true;
    }

    /**
     * Bumped once per session. Capture-side warn-once diagnostics key off this
     * so they are per RECORDING rather than per page load: without it a second
     * F9 drops the same oversized widget or stylesheet in silence, and the
     * unstyled trailer looks like a new bug rather than the one already
     * explained. Read it rather than importing a reset — the warn owners are
     * GameHUD and stylesheetCapture, both of which this module cannot import
     * without a cycle.
     */
    getSessionSerial(): number {
        return this.sessionSerial;
    }

    /**
     * Stop collecting and hand over everything gathered this session — but only
     * to the session's owner. A non-owner gets null and the session survives:
     * without the gate, the recorder's stop/dispose paths would silently kill a
     * passive eventlog session that happened to be running.
     */
    endSession(owner: EventLogOwner): TimelineSession | null {
        if (this.owner !== owner) return null;
        this.active = false;
        this.owner = null;
        this.frameProvider = null;
        const session: TimelineSession = {
            events: this.events, sounds: this.sounds, music: this.music, hud: this.hud,
        };
        this.events = [];
        this.sounds = [];
        this.music = [];
        this.hud = [];
        this.lastLoggedFrame.clear();
        this.lastHudValue.clear();
        this.lastThemeValue = null;
        this.hudBytes = 0;
        return session;
    }

    /**
     * Everything gathered so far, without ending the session. Shallow array
     * copies: a caller cannot grow or truncate the live session, and entries
     * themselves are write-once. Empty arrays when idle. This is the read path
     * for `window.__bmDebug` — an external observer must be able to look at
     * the timeline mid-run without destroying it.
     */
    getSnapshot(): TimelineSession {
        return {
            events: [...this.events],
            sounds: [...this.sounds],
            music: [...this.music],
            hud: [...this.hud],
        };
    }

    logEvent(event: GameEventInput): void {
        if (!this.active) return;
        const frame = this.currentFrame();
        const cooldown = DEBOUNCE_FRAMES[event.type];
        if (cooldown !== undefined) {
            const key = `${event.type}:${event.actor ?? ''}`;
            const last = this.lastLoggedFrame.get(key);
            if (last !== undefined && frame - last < cooldown) return;
            this.lastLoggedFrame.set(key, frame);
        }
        if (!this.checkCapacity(this.events)) return;
        const entry: TimelineGameEvent = {
            frame,
            type: event.type,
            intensity: clamp01(event.intensity ?? DEFAULT_INTENSITY[event.type] ?? DEFAULT_INTENSITY_UNKNOWN),
        };
        const position = normalizePosition(event.position);
        if (position) entry.position = position;
        if (event.actor !== undefined) entry.actor = event.actor;
        if (event.data !== undefined) entry.data = event.data;
        this.events.push(entry);
    }

    logAssetSound(assetId: string, url: string, volume?: number): void {
        if (!this.active) return;
        if (!this.checkCapacity(this.sounds)) return;
        const entry: TimelineSoundEvent = { frame: this.currentFrame(), kind: 'asset', assetId, url };
        if (volume !== undefined) entry.volume = volume;
        this.sounds.push(entry);
    }

    logSynthSound(name: string, recipe?: SynthSoundRecipe): void {
        if (!this.active) return;
        if (!this.checkCapacity(this.sounds)) return;
        const entry: TimelineSoundEvent = { frame: this.currentFrame(), kind: 'synth', name };
        if (recipe !== undefined) entry.recipe = recipe;
        this.sounds.push(entry);
    }

    logMusic(action: 'play' | 'stop', info: Omit<TimelineMusicEvent, 'frame' | 'action'> = {}): void {
        if (!this.active) return;
        if (!this.checkCapacity(this.music)) return;
        this.music.push({ frame: this.currentFrame(), action, ...info });
    }

    /**
     * Record a HUD state change. Called from GameHUD's mutating methods; free
     * when no session is active. Repeated `update`/`custom-html` ops that
     * produce the same visual result are dropped — a per-frame counter refresh
     * showing an unchanged value must not fill the timeline.
     */
    logHud(op: HudOpInput): void {
        if (!this.active) return;
        // Stylesheets join the repeat check so callers can re-log the whole
        // collection on every custom-element op: an unchanged sheet costs one
        // string compare, and only a real edit reaches the timeline.
        if ((op.op === 'update' || op.op === 'custom-html' || op.op === 'stylesheet') && this.isRepeatHudValue(op)) return;
        // Themes are logged whole and have no id, so they miss the check above.
        // A game re-applying a theme on a timer would otherwise append a
        // multi-KB op per call until the cap silently swallowed the whole HUD
        // track, and the ops all alias one live ThemeManager object — so the
        // snapshot is taken here, at log time, not at save time.
        if (op.op === 'theme') {
            const theme = JSON.stringify(op.theme);
            if (this.lastThemeValue === theme) return;
            this.lastThemeValue = theme;
            if (!this.checkCapacity(this.hud) || !this.checkHudBytes(theme.length)) return;
            this.hud.push({ frame: this.currentFrame(), op: 'theme', theme: JSON.parse(theme) as unknown });
            return;
        }
        // A create/remove resets the element's visual baseline: an update that
        // matches the pre-recreation value is a real change again.
        if ((op.op === 'create' || op.op === 'remove') && 'id' in op) {
            this.lastHudValue.delete(`update:${op.id}`);
            this.lastHudValue.delete(`custom-html:${op.id}`);
        }
        if (!this.checkCapacity(this.hud)) return;
        const entry = { frame: this.currentFrame(), ...op } as TimelineHudOp;
        // Measured post-dedupe only, so this serialization is bounded by the
        // budget itself; the same string is what timeline.json carries.
        if (!this.checkHudBytes(JSON.stringify(entry).length)) return;
        this.hud.push(entry);
    }

    /**
     * Admit `bytes` more HUD payload, or refuse and warn once. Per op, not a
     * shutter: a 40-byte counter update still lands after a 16 KB widget
     * refresh is refused, so the replay keeps its small elements moving and
     * freezes only what no longer fits — the shape of GameHUD's markup cap.
     */
    private checkHudBytes(bytes: number): boolean {
        if (this.hudBytes + bytes <= MAX_HUD_BYTES_PER_SESSION) {
            this.hudBytes += bytes;
            return true;
        }
        if (!this.hudBytesWarned) {
            this.hudBytesWarned = true;
            console.warn(
                `[GameEventLog] HUD track byte budget (${MAX_HUD_BYTES_PER_SESSION}) spent — ` +
                    'oversized HUD ops are dropped from here and the trailer HUD freezes on them; ' +
                    'a custom element or head stylesheet is changing every frame'
            );
        }
        return false;
    }

    /**
     * True when this op leaves the element looking exactly as the last one did.
     *
     * The compared value is the op's own payload strings joined, not
     * `JSON.stringify(op)`: `op` and `id` are already pinned by the map key, and
     * the payloads are the large fields — a widget updating every frame made
     * this serialize (and escape) its whole markup plus every captured
     * stylesheet, per frame, inside the recorded gameplay loop.
     */
    private isRepeatHudValue(op: HudOpInput): boolean {
        if (!('id' in op)) return false;
        const key = `${op.op}:${op.id}`;
        const value = hudValueSignature(op);
        if (this.lastHudValue.get(key) === value) return true;
        this.lastHudValue.set(key, value);
        return false;
    }

    private currentFrame(): number {
        return this.frameProvider ? this.frameProvider() : 0;
    }

    private checkCapacity(list: unknown[]): boolean {
        if (list.length < MAX_ENTRIES_PER_KIND) return true;
        if (!this.overflowWarned) {
            this.overflowWarned = true;
            console.warn(`[GameEventLog] timeline entry cap (${MAX_ENTRIES_PER_KIND}) reached — further entries dropped`);
        }
        return false;
    }
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function normalizePosition(
    position: GameEventInput['position'],
): TimelinePosition | undefined {
    if (!position) return undefined;
    const [x, y, z] = Array.isArray(position) ? position : [position.x, position.y, position.z];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    // Two decimals keeps timeline.json compact; trailer framing needs no more.
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(z * 100) / 100];
}

let instance: GameEventLog | null = null;

/** Engine-wide singleton — safe to call from any system or game code at any time. */
export function getGameEventLog(): GameEventLog {
    if (!instance) {
        instance = new GameEventLog();
    }
    return instance;
}
