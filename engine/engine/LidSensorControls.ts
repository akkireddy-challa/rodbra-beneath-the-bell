import type { IInputControls } from 'engine/IInputControls.js';
import { isProduction } from 'engine/environment.js';
import { isCreatorMode } from 'engine/CreatorMode.js';
import { LID_SENSOR_STREAM_URL } from 'engine/config.js';

/**
 * EXPERIMENTAL, LOCALHOST-ONLY input source: a MacBook lid open/close sensor.
 *
 * A local helper server streams the lid angle over SSE
 * (`data: {"angle":126.0,"velocity":4.2,"ts":...}`). This class turns the
 * physical motion of *rocking the lid back and forth* into ALTERNATING left/right
 * taps — the input the rhythmic-sprint movement system rewards ("pump to sprint").
 *
 * It implements {@link IInputControls} and is OR-merged into PlayerController like
 * the desktop/mobile/gamepad sources: each lid swing flips the emitted `moveX`
 * sign, which PlayerController converts into a `keys.left` / `keys.right` rising
 * edge. One full open-close rock = two swings = two alternating taps.
 *
 * The EventSource is only ever opened when the feature is explicitly enabled AND
 * the page is NOT production — so it works on localhost and on dev/published-to-beta
 * games (played from a machine running the local sensor server), but never in prod,
 * and never while disabled (so there is no connection-error spam when the sensor
 * server isn't running).
 *
 * Enable it via the creator DevTools toggle (postMessage → game-origin localStorage)
 * or, on a standalone published game where there's no DevTools tab, by appending
 * `?lidControl=1` to the game URL.
 */

const LID_CONTROL_FLAG_KEY = 'bmLidControl';

export interface LidSensorOptions {
    /** SSE endpoint emitting `{angle, velocity, ts}` lines. */
    streamUrl: string;
    /** Minimum degrees the lid must travel in one direction to count as one "pump". */
    angleDeltaThreshold: number;
    /** Per-sample jitter floor (deg) — movements smaller than this are ignored. */
    angleNoiseFloor: number;
    /** If no sample arrives for this long (ms), `moveX` decays to 0 (runner coasts). */
    idleResetMs: number;
}

export const DEFAULT_LID_SENSOR_OPTIONS: LidSensorOptions = {
    streamUrl: LID_SENSOR_STREAM_URL,
    angleDeltaThreshold: 2.0,
    angleNoiseFloor: 0.1,
    idleResetMs: 400,
};

/** Shape of one parsed SSE payload. `velocity`/`ts` are unused but documented. */
interface LidSensorSample {
    angle: number;
    velocity?: number;
    ts?: number;
}

export class LidSensorControls implements IInputControls {
    // IInputControls movement state. Only moveX is driven (left/right taps); the
    // sprinter ignores moveY and the action buttons.
    moveX = 0;
    moveY = 0;

    // No buttons are produced by the lid sensor.
    ascendPressed = false;
    descendPressed = false;
    actionPressed = false;
    secondaryActionPressed = false;
    interactPressed = false;
    exitPressed = false;

    private readonly options: LidSensorOptions;
    private eventSource: EventSource | null = null;
    private controlsEnabled = true;
    private loggedError = false;

    // Pump detection state.
    private lastAngle: number | null = null;
    private swingDir = 0;        // direction of the swing currently being accumulated (+1 / -1)
    private swingAccum = 0;      // degrees accumulated in the current swing
    private swingFired = false;  // whether the current swing has already produced a tap
    private lastSampleMs = 0;

    constructor(options: LidSensorOptions = DEFAULT_LID_SENSOR_OPTIONS) {
        this.options = options;
        // Auto-connect on startup if enabled via ?lidControl=1 (standalone published
        // games) or the game-origin localStorage flag (creator DevTools toggle).
        if (!isProduction() && this.readStartupEnabled()) {
            this.connect();
        }
    }

    /**
     * Enable/disable the feature. Persists the game-origin flag and opens or closes
     * the SSE connection. Driven by the creator DevTools toggle via postMessage.
     */
    setEnabled(enabled: boolean): void {
        this.writeFlag(enabled);
        if (enabled) {
            this.connect();
        } else {
            this.disconnect();
        }
    }

    /** Active = connected to the sensor AND not suppressed (dialog/menu/editor). */
    isEnabled(): boolean {
        return this.eventSource !== null && this.controlsEnabled;
    }

    update(): void {
        // No samples for a while → stop asserting a direction so the runner coasts
        // (the movement system's rhythm decay does the actual slowdown).
        if (this.eventSource && this.lastSampleMs > 0 && performance.now() - this.lastSampleMs > this.options.idleResetMs) {
            this.moveX = 0;
            this.resetSwing();
        }
    }

    dispose(): void {
        this.disconnect();
    }

    // One-shot button resets are no-ops — the lid sensor never sets buttons.
    resetActionPressed(): void { /* no-op */ }
    resetSecondaryActionPressed(): void { /* no-op */ }
    resetInteractPressed(): void { /* no-op */ }
    resetAscendPressed(): void { /* no-op */ }
    resetDescendPressed(): void { /* no-op */ }
    resetExitPressed(): void { /* no-op */ }

    setControlsEnabled(enabled: boolean): void {
        this.controlsEnabled = enabled;
        if (!enabled) {
            this.moveX = 0;
        }
    }

    getControlsEnabled(): boolean {
        return this.controlsEnabled;
    }

    // ── Connection lifecycle ─────────────────────────────────────────

    private connect(): void {
        if (isProduction() || this.eventSource) return;
        try {
            const source = new EventSource(this.options.streamUrl);
            source.addEventListener('message', (event) => this.handleSample((event as MessageEvent).data));
            source.addEventListener('error', () => {
                // EventSource auto-reconnects; log once per connection so a missing
                // sensor server doesn't spam the console every retry.
                if (!this.loggedError) {
                    console.warn(`[LidSensorControls] stream error (${this.options.streamUrl}); will retry if the server comes up`);
                    this.loggedError = true;
                }
            });
            this.eventSource = source;
        } catch (err) {
            console.warn('[LidSensorControls] failed to open stream', err);
            this.eventSource = null;
        }
    }

    private disconnect(): void {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        this.moveX = 0;
        this.loggedError = false;
        this.lastSampleMs = 0;
        this.lastAngle = null;
        this.resetSwing();
    }

    // ── Pump detection ───────────────────────────────────────────────

    private handleSample(raw: unknown): void {
        const sample = this.parseSample(raw);
        if (!sample) return;

        this.loggedError = false;
        this.lastSampleMs = performance.now();

        if (this.lastAngle === null) {
            this.lastAngle = sample.angle;
            return;
        }

        const delta = sample.angle - this.lastAngle;
        this.lastAngle = sample.angle;
        if (Math.abs(delta) < this.options.angleNoiseFloor) return;

        const dir = Math.sign(delta);
        if (dir === this.swingDir) {
            // Continuing the same swing.
            this.swingAccum += Math.abs(delta);
        } else {
            // Lid reversed direction → start a fresh swing that can fire its own tap.
            this.swingDir = dir;
            this.swingAccum = Math.abs(delta);
            this.swingFired = false;
        }

        // A swing that travels past the threshold produces exactly one tap, flipping
        // the emitted direction — this is what drives the left/right alternation.
        if (!this.swingFired && this.swingAccum >= this.options.angleDeltaThreshold) {
            this.moveX = this.moveX > 0 ? -1 : 1;
            this.swingFired = true;
        }
    }

    private parseSample(raw: unknown): LidSensorSample | null {
        if (typeof raw !== 'string') return null;
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (typeof parsed === 'object' && parsed !== null && typeof (parsed as LidSensorSample).angle === 'number') {
                return parsed as LidSensorSample;
            }
        } catch {
            // Malformed line — ignore.
        }
        return null;
    }

    private resetSwing(): void {
        this.swingDir = 0;
        this.swingAccum = 0;
        this.swingFired = false;
    }

    // ── Game-origin flag persistence ─────────────────────────────────

    /**
     * Startup opt-in: a `?lidControl=1|0` URL param wins (the only way to enable on a
     * standalone published game, which has no DevTools toggle), otherwise fall back to
     * the persisted game-origin flag set by the creator toggle.
     */
    private readStartupEnabled(): boolean {
        try {
            const param = new URLSearchParams(window.location.search).get('lidControl');
            if (param === '1' || param === 'true') return true;
            if (param === '0' || param === 'false') return false;
        } catch {
            // window/URL unavailable — fall through
        }
        // In creator mode the creator is the source of truth: it re-pushes the
        // authoritative state via SET_LID_CONTROL on every GAME_LOADED. Auto-
        // connecting from the game-origin persisted flag here too would let a stale
        // flag outlive the DevTools toggle — connecting (and spamming
        // ERR_CONNECTION_REFUSED) even though the UI shows Off. Standalone published
        // games have no creator to push, so they still honour the persisted flag.
        if (isCreatorMode) return false;
        return this.readFlag();
    }

    private readFlag(): boolean {
        try {
            return globalThis.localStorage?.getItem(LID_CONTROL_FLAG_KEY) === '1';
        } catch {
            return false;
        }
    }

    private writeFlag(enabled: boolean): void {
        try {
            if (enabled) {
                globalThis.localStorage?.setItem(LID_CONTROL_FLAG_KEY, '1');
            } else {
                globalThis.localStorage?.removeItem(LID_CONTROL_FLAG_KEY);
            }
        } catch {
            // localStorage unavailable — the in-memory connection state still applies.
        }
    }
}
