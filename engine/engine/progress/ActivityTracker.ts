/**
 * ActivityTracker — "is a human actually playing right now?"
 *
 * The play-session heartbeat already discards time while the tab is hidden, but
 * a tab left OPEN AND VISIBLE reports play forever. A game abandoned on a second
 * monitor overnight would log eight hours, and on a game whose real sessions run
 * a few minutes that single outlier drags every average with it.
 *
 * So the heartbeat also reports whether any input arrived recently. Idle time is
 * discarded exactly like hidden time, and counting resumes the moment the player
 * touches anything — this measures ACTIVE play, not tab uptime.
 *
 * Gamepads are why this is not four lines of addEventListener: pad input fires NO
 * DOM events, so a controller player would look idle and lose their whole
 * session. Pad state is therefore sampled on a timer and compared.
 *
 * Known trade-off: a genuinely idle game (watch-the-numbers-go-up) records at
 * most IDLE_AFTER_MS of untouched play per stretch. Bounding an abandoned tab is
 * worth more than perfectly measuring a player who is deliberately doing nothing.
 *
 * The pure parts are exported and unit-tested; the listener wiring is runtime.
 */

/**
 * Input silence after which a session stops counting. Long enough to read a
 * menu, watch a cutscene or think about a puzzle; short enough that an abandoned
 * tab contributes minutes rather than hours.
 */
export const IDLE_AFTER_MS = 3 * 60_000;

/** How often pad state is sampled. Cheap: an array read and a shallow compare. */
export const GAMEPAD_POLL_MS = 2_000;

/** Whether input this recent still counts as playing. */
export function isActive(lastInputMs: number, nowMs: number, idleAfterMs: number = IDLE_AFTER_MS): boolean {
    return nowMs - lastInputMs < idleAfterMs;
}

/**
 * A compact signature of every connected pad's buttons and sticks. Compared
 * between samples to detect input; the exact value is meaningless on its own.
 *
 * Sticks are rounded to one decimal so resting-stick jitter — which never
 * settles at exactly 0 on worn hardware — does not read as a player who is
 * still there.
 */
export function gamepadSignature(pads: ReadonlyArray<Gamepad | null>): string {
    const parts: string[] = [];
    for (const pad of pads) {
        if (!pad) continue;
        let buttons = '';
        for (const button of pad.buttons) buttons += button.pressed ? '1' : '0';
        let axes = '';
        for (const axis of pad.axes) axes += `${Math.round(axis * 10) / 10},`;
        parts.push(`${pad.index}:${buttons}:${axes}`);
    }
    return parts.join('|');
}

/** DOM events that mean a person is present. Pointer MOVE counts: reading a HUD is playing. */
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

export class ActivityTracker {
    private lastInputMs: number;
    private padSignature = '';
    private padTimer: ReturnType<typeof setInterval> | null = null;
    private readonly onInput = (): void => { this.lastInputMs = Date.now(); };
    private started = false;

    constructor(private readonly idleAfterMs: number = IDLE_AFTER_MS) {
        // Start "active": a session opens because someone pressed Play.
        this.lastInputMs = Date.now();
    }

    start(): void {
        if (this.started || typeof window === 'undefined') return;
        this.started = true;
        for (const type of INPUT_EVENTS) {
            window.addEventListener(type, this.onInput, { passive: true, capture: true });
        }
        // Returning to the tab is itself a sign of presence, and without this a
        // player who alt-tabbed for longer than the idle window would come back
        // to a session that ignores them until they click.
        document.addEventListener('visibilitychange', this.onVisibility, { passive: true } as AddEventListenerOptions);
        this.padSignature = gamepadSignature(this.readPads());
        this.padTimer = setInterval(() => this.pollGamepads(), GAMEPAD_POLL_MS);
    }

    stop(): void {
        if (!this.started) return;
        this.started = false;
        for (const type of INPUT_EVENTS) {
            window.removeEventListener(type, this.onInput, { capture: true } as EventListenerOptions);
        }
        document.removeEventListener('visibilitychange', this.onVisibility);
        if (this.padTimer !== null) { clearInterval(this.padTimer); this.padTimer = null; }
    }

    /** Whether the player has been active recently enough for this beat to count. */
    isActive(nowMs: number = Date.now()): boolean {
        return isActive(this.lastInputMs, nowMs, this.idleAfterMs);
    }

    private readonly onVisibility = (): void => {
        if (typeof document !== 'undefined' && !document.hidden) this.onInput();
    };

    private readPads(): ReadonlyArray<Gamepad | null> {
        if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
        try {
            return navigator.getGamepads();
        } catch {
            return []; // some browsers throw when the API is gated
        }
    }

    private pollGamepads(): void {
        const signature = gamepadSignature(this.readPads());
        if (signature !== this.padSignature) {
            this.padSignature = signature;
            this.onInput();
        }
    }
}
