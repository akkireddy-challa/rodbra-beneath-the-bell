import type { IInputControls } from 'engine/IInputControls.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';

/**
 * Key codes whose display label differs from the code itself. Anything absent
 * is shown as-is (`Space` → "Space"), or with its `Key*`/`Digit*` prefix
 * stripped — see {@link DesktopControls.keyCodeToLabel}.
 */
const SPECIAL_KEY_LABELS: Record<string, string> = {
    'Escape': 'Esc',
    'ShiftLeft': 'Shift', 'ShiftRight': 'Shift',
    'ControlLeft': 'Ctrl', 'ControlRight': 'Ctrl',
    'AltLeft': 'Alt', 'AltRight': 'Alt',
};

/**
 * Desktop keyboard input handling.
 * Implements IInputControls interface for consistent input polling.
 */
export class DesktopControls implements IInputControls {
    private enabled: boolean = false;
    private controlsEnabled: boolean = true;
    private inputGate: (() => boolean) | null = null;

    // Key codes currently held down (updated by the keydown/keyup handlers)
    private heldKeys: Set<string> = new Set();

    // Custom key handlers for subclass-specific keys.
    // Stores handler plus registration-site metadata (source, pairedWithMobile)
    // so verifyMobileParity() can point the engineer at the exact call site.
    private customHandlers: Map<string, {
        handler: (pressed: boolean) => void;
        opts: { source: string; pairedWithMobile: boolean };
    }> = new Map();

    // Bound event handlers for cleanup
    private boundOnKeyDown: (e: KeyboardEvent) => void;
    private boundOnKeyUp: (e: KeyboardEvent) => void;
    private boundOnMouseDown: (e: MouseEvent) => void;
    private boundOnMouseUp: (e: MouseEvent) => void;
    private boundOnFocusLost: () => void;
    private boundOnVisibilityChange: () => void;

    // IInputControls properties - movement
    public moveX: number = 0;
    public moveY: number = 0;

    // IInputControls properties - button states
    public ascendPressed: boolean = false;
    public descendPressed: boolean = false;
    public actionPressed: boolean = false;
    public secondaryActionPressed: boolean = false;
    public interactPressed: boolean = false;
    public exitPressed: boolean = false;

    // Additional state (matches PlayerController's ctrlPressed)
    public ctrlPressed: boolean = false;

    // Disable mouse button actions (left-click → actionPressed, right-click → secondaryActionPressed)
    public disableMouseActions: boolean = false;

    // Disable WASD/arrow keyboard movement (keeps action keys like Enter, E, Space working)
    public disableKeyboardMovement: boolean = false;

    // Key mappings (can be customized via setter methods)
    private KEY_FORWARD: string[] = ['KeyW', 'ArrowUp'];
    private KEY_BACKWARD: string[] = ['KeyS', 'ArrowDown'];
    private KEY_LEFT: string[] = ['KeyA', 'ArrowLeft'];
    private KEY_RIGHT: string[] = ['KeyD', 'ArrowRight'];
    private KEY_ASCEND: string[] = ['Space'];
    private KEY_DESCEND: string[] = ['ControlLeft', 'ControlRight'];
    private KEY_ACTION: string[] = ['Enter'];
    private KEY_SECONDARY_ACTION: string[] = ['KeyQ'];
    private KEY_INTERACT: string[] = ['KeyE'];

    constructor() {
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        this.boundOnKeyUp = this.onKeyUp.bind(this);
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnFocusLost = this.releaseAllKeys.bind(this);
        this.boundOnVisibilityChange = () => { if (document.hidden) this.releaseAllKeys(); };

        // Only enable on non-mobile devices
        if (!isMobileRuntime()) {
            this.setupEventListeners();
            this.enabled = true;
        }
    }

    private setupEventListeners(): void {
        document.addEventListener('keydown', this.boundOnKeyDown);
        document.addEventListener('keyup', this.boundOnKeyUp);
        document.addEventListener('mousedown', this.boundOnMouseDown);
        document.addEventListener('mouseup', this.boundOnMouseUp);
        // A key held while the window/tab loses focus NEVER gets its keyup: the
        // browser delivers it to whatever took focus. Without this the key latches
        // down forever — the "stuck S / car reverses on its own" bug.
        window.addEventListener('blur', this.boundOnFocusLost);
        document.addEventListener('visibilitychange', this.boundOnVisibilityChange);
    }

    /**
     * Release every held key and button. Called whenever focus leaves, because
     * from that moment we can no longer observe the release ourselves.
     * Custom handlers get their `false` edge so game code unlatches too.
     */
    private releaseAllKeys(): void {
        for (const code of this.heldKeys) {
            this.customHandlers.get(code)?.handler(false);
        }
        this.heldKeys.clear();
        this.clearButtonStates();
    }

    /** Zero every derived movement/button flag. Leaves the raw `heldKeys` set alone. */
    private clearButtonStates(): void {
        this.moveX = 0;
        this.moveY = 0;
        this.ascendPressed = false;
        this.descendPressed = false;
        this.actionPressed = false;
        this.secondaryActionPressed = false;
        this.interactPressed = false;
        this.ctrlPressed = false;
    }

    /**
     * Check if input should be processed (respects input gate)
     */
    private shouldProcessInput(): boolean {
        // If pointer lock is active, always allow input - most reliable check
        if (document.pointerLockElement) return true;
        
        if (!this.controlsEnabled) return false;
        if (this.inputGate && !this.inputGate()) return false;
        return true;
    }

    private onKeyDown(event: KeyboardEvent): void {
        if (!this.shouldProcessInput()) return;
        this.applyKeyState(event, true);
    }

    private onKeyUp(event: KeyboardEvent): void {
        // NO input gate here, deliberately. A release must always be honoured:
        // gating it the same way as the press means any gate that closes while a
        // key is held (window unfocused, editor opened, controls disabled) swallows
        // the keyup and latches that key down — which is how a tap of S turned into
        // a car reversing until it hit something.
        this.applyKeyState(event, false);
    }

    /**
     * Apply one key transition (press or release) to the raw key map, the mapped
     * button flags and any custom handler. Press and release differ only in the
     * gate their caller applies, so they share this body — a flag updated on one
     * edge can never be forgotten on the other.
     */
    private applyKeyState(event: KeyboardEvent, pressed: boolean): void {
        const code = event.code;
        if (pressed) this.heldKeys.add(code);
        else this.heldKeys.delete(code);

        // Interact is handled specially: it swallows the event and skips the rest.
        if (this.KEY_INTERACT.includes(code)) {
            this.interactPressed = pressed;
            event.preventDefault();
            return;
        }

        let consumed = this.customHandlers.has(code);
        if (this.KEY_ASCEND.includes(code)) {
            this.ascendPressed = pressed;
            consumed = true;
        }
        if (this.KEY_DESCEND.includes(code)) {
            this.descendPressed = pressed;
            this.ctrlPressed = pressed;
            consumed = true;
        }
        if (this.KEY_ACTION.includes(code)) {
            this.actionPressed = pressed;
            consumed = true;
        }
        if (this.KEY_SECONDARY_ACTION.includes(code)) {
            this.secondaryActionPressed = pressed;
            consumed = true;
        }
        if (!this.disableKeyboardMovement && this.isMovementKey(code)) {
            consumed = true;
        }

        // A key the game consumes must not also do what the browser does with it. The arrows
        // scroll and Space pages down — invisible in a standalone tab, but when the game runs in
        // bitmagic.ai's /play/ iframe every arrow press scrolls the whole portal page. Two
        // exceptions: a focused text field keeps its keys, and a Ctrl/Alt/Meta chord stays the
        // browser's (Alt+Left is "back", Cmd+Space is Spotlight).
        if (consumed && !event.ctrlKey && !event.altKey && !event.metaKey && !isEditableTarget(event.target)) {
            event.preventDefault();
        }

        this.customHandlers.get(code)?.handler(pressed);
    }

    private isMovementKey(code: string): boolean {
        return this.KEY_FORWARD.includes(code) || this.KEY_BACKWARD.includes(code)
            || this.KEY_LEFT.includes(code) || this.KEY_RIGHT.includes(code);
    }

    private onMouseDown(event: MouseEvent): void {
        if (!this.shouldProcessInput()) return;
        this.applyMouseButtonState(event, true);
    }

    private onMouseUp(event: MouseEvent): void {
        // Ungated for the same reason as onKeyUp — a release must always land, or
        // the button latches. (Right-click maps to secondaryAction, which drives a
        // vehicle backwards.)
        this.applyMouseButtonState(event, false);
    }

    /** Apply one mouse-button transition: left (0) → action, right (2) → secondary action. */
    private applyMouseButtonState(event: MouseEvent, pressed: boolean): void {
        if (this.disableMouseActions) return;

        if (event.button === 0) {
            this.actionPressed = pressed;
        } else if (event.button === 2) {
            this.secondaryActionPressed = pressed;
        }
    }

    /** Whether any of these key codes is currently held down. */
    private isKeyDown(keys: string[]): boolean {
        return keys.some(key => this.heldKeys.has(key));
    }

    /** One movement axis: +1 while a positive key is held, -1 for a negative one, 0 for neither or both. */
    private keyAxis(positive: string[], negative: string[]): number {
        return (this.isKeyDown(positive) ? 1 : 0) - (this.isKeyDown(negative) ? 1 : 0);
    }

    // ==================== IInputControls Implementation ====================

    public isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Whether any of these key codes is currently held. Public because the
     * custom-action merge must not release a key on mobile-button release while
     * the player still holds the keyboard key bound to the same action — the
     * creator's mobile preview keeps the keyboard live alongside touch buttons.
     * Always false while disabled (mobile runtime): no listeners, no key state.
     */
    public isAnyKeyDown(codes: string[]): boolean {
        return this.enabled && this.isKeyDown(codes);
    }

    public update(): void {
        if (this.disableKeyboardMovement) {
            this.moveX = 0;
            this.moveY = 0;
            this.ascendPressed = false;
            this.descendPressed = false;
            return;
        }

        // Compute moveX/moveY from key states each frame
        this.moveX = this.keyAxis(this.KEY_RIGHT, this.KEY_LEFT);
        this.moveY = this.keyAxis(this.KEY_FORWARD, this.KEY_BACKWARD);
    }

    public dispose(): void {
        document.removeEventListener('keydown', this.boundOnKeyDown);
        document.removeEventListener('keyup', this.boundOnKeyUp);
        document.removeEventListener('mousedown', this.boundOnMouseDown);
        document.removeEventListener('mouseup', this.boundOnMouseUp);
        window.removeEventListener('blur', this.boundOnFocusLost);
        document.removeEventListener('visibilitychange', this.boundOnVisibilityChange);
        this.heldKeys.clear();
        this.customHandlers.clear();
    }

    public resetActionPressed(): void {
        this.actionPressed = false;
    }

    public resetSecondaryActionPressed(): void {
        this.secondaryActionPressed = false;
    }

    public resetInteractPressed(): void {
        this.interactPressed = false;
    }

    public resetAscendPressed(): void {
        this.ascendPressed = false;
    }

    public resetDescendPressed(): void {
        this.descendPressed = false;
    }

    public resetExitPressed(): void {
        this.exitPressed = false;
    }

    public setControlsEnabled(enabled: boolean): void {
        this.controlsEnabled = enabled;

        // Reset all states when disabling
        if (!enabled) {
            this.heldKeys.clear();
            this.clearButtonStates();
            this.exitPressed = false;
        }
    }

    public getControlsEnabled(): boolean {
        return this.controlsEnabled;
    }

    // ==================== Desktop-specific API ====================

    /**
     * Set a callback that determines if input should be processed.
     * Used by PlayerController to pass shouldProcessInput() logic.
     */
    public setInputGate(gate: () => boolean): void {
        this.inputGate = gate;
    }

    /**
     * Register a custom key handler for subclass-specific keys.
     *
     * ⚠️ Prefer `PlayerController.registerCustomAction()` instead — that binds the
     * desktop key AND the mobile button in a single call, keeping feature parity.
     * Calling registerKeyHandler() alone creates a desktop-only action, which
     * will trigger a console warning from `PlayerController.verifyMobileParity()`
     * on game start because mobile players won't be able to perform the action.
     *
     * @param keyCode The key code (e.g., 'KeyX', 'F8')
     * @param handler Callback receiving pressed state (true on keydown, false on keyup)
     * @param opts    Registration-site metadata. `source` identifies WHICH system
     *                registered this key (surfaces in the parity error message so
     *                you know where the stray key came from). `pairedWithMobile`
     *                must be true iff the caller has also registered a matching
     *                mobile button — `registerCustomAction` sets this to true;
     *                anonymous raw callers default to false and will be flagged
     *                as mobile-parity gaps.
     */
    public registerKeyHandler(
        keyCode: string,
        handler: (pressed: boolean) => void,
        opts: { source: string; pairedWithMobile: boolean } = { source: '(anonymous)', pairedWithMobile: false },
    ): void {
        this.customHandlers.set(keyCode, { handler, opts });
    }

    /**
     * Unregister a custom key handler.
     */
    public unregisterKeyHandler(keyCode: string): void {
        this.customHandlers.delete(keyCode);
    }

    /**
     * List all custom key codes registered via registerKeyHandler().
     * Used by PlayerController.verifyMobileParity() to check each custom
     * key has a matching mobile button.
     */
    public getRegisteredCustomKeys(): string[] {
        return Array.from(this.customHandlers.keys());
    }

    /**
     * List every registered key whose registration site declared
     * `pairedWithMobile: false` (i.e. raw, desktop-only registrations that
     * did NOT go through `PlayerController.registerCustomAction`). These are
     * the keys that the parity check should flag — the registering caller
     * itself admitted there is no matching mobile button.
     *
     * Each entry carries the `source` string from the opts so the parity
     * error can tell the engineer exactly which system to look at.
     */
    public getUnpairedRawKeys(): Array<{ key: string; source: string }> {
        const out: Array<{ key: string; source: string }> = [];
        for (const [key, entry] of this.customHandlers) {
            if (!entry.opts.pairedWithMobile) {
                out.push({ key, source: entry.opts.source });
            }
        }
        return out;
    }

    // ==================== Key Mapping Customization ====================
    // These methods allow developers to customize which keys trigger which actions.
    // This keeps desktop and mobile controls in sync - mobile buttons use the same
    // actionPressed/secondaryActionPressed/etc. flags that these keys control.
    //
    // Example: To use R for reload (as secondary action):
    //   desktopControls.setSecondaryActionKeys(['KeyR']);
    //   // Mobile will still show secondary action button
    //   // Both trigger secondaryActionPressed
    //
    // Example: To add R as an additional action key (alongside Enter):
    //   desktopControls.setActionKeys(['Enter', 'KeyR']);

    /**
     * Set which keys trigger the primary action (default: Enter).
     * Use this for shooting, attacking, confirming, etc.
     * Mobile equivalent: Action button (shows contextual icon)
     */
    public setActionKeys(keys: string[]): void {
        this.KEY_ACTION = [...keys];
    }

    /**
     * Set which keys trigger the secondary action (default: Q).
     * Use this for reload, aim-down-sights, block, alternate fire, etc.
     * Mobile equivalent: Secondary action button (shows contextual icon)
     */
    public setSecondaryActionKeys(keys: string[]): void {
        this.KEY_SECONDARY_ACTION = [...keys];
    }

    /**
     * Set which keys trigger interact (default: E).
     * Use this for picking up items, talking to NPCs, entering vehicles, etc.
     * Mobile equivalent: Interact button (shows contextual text)
     */
    public setInteractKeys(keys: string[]): void {
        this.KEY_INTERACT = [...keys];
    }

    /**
     * Set which keys trigger ascend/jump (default: Space).
     * Mobile equivalent: Ascend/Jump button
     */
    public setAscendKeys(keys: string[]): void {
        this.KEY_ASCEND = [...keys];
    }

    /**
     * Set which keys trigger descend/crouch (default: Ctrl).
     * Mobile equivalent: Descend button
     */
    public setDescendKeys(keys: string[]): void {
        this.KEY_DESCEND = [...keys];
    }

    /**
     * Convert a KeyboardEvent.code to a human-readable display label.
     * E.g., 'KeyQ' → 'Q', 'Space' → 'Space', 'Enter' → 'Enter'
     */
    static keyCodeToLabel(code: string): string {
        if (code.startsWith('Key')) return code.slice(3); // KeyQ → Q
        if (code.startsWith('Digit')) return code.slice(5); // Digit1 → 1
        return SPECIAL_KEY_LABELS[code] || code;
    }

    /** Label of the first key in a mapping, or `fallback` if the mapping was emptied. */
    private firstKeyLabel(keys: string[], fallback: string): string {
        const key = keys[0];
        return key ? DesktopControls.keyCodeToLabel(key) : fallback;
    }

    /**
     * Get display label for the secondary action key (e.g., "Q").
     * Returns the first configured key's label.
     */
    public getSecondaryActionKeyLabel(): string {
        return this.firstKeyLabel(this.KEY_SECONDARY_ACTION, 'Q');
    }

    public getInteractKeyLabel(): string {
        return this.firstKeyLabel(this.KEY_INTERACT, 'E');
    }

    public getActionKeyLabel(): string {
        return this.firstKeyLabel(this.KEY_ACTION, 'Enter');
    }

    public getAscendKeyLabel(): string {
        return this.firstKeyLabel(this.KEY_ASCEND, 'Space');
    }

    public getDescendKeyLabel(): string {
        return this.firstKeyLabel(this.KEY_DESCEND, 'Ctrl');
    }

    /**
     * Get raw key states for direct access (used for movement keys in PlayerController).
     * Returns object matching PlayerController's keys format.
     */
    public getKeyStates(): {
        forward: boolean;
        backward: boolean;
        left: boolean;
        right: boolean;
        ascend: boolean;
        descend: boolean;
        interact: boolean;
        action: boolean;
        secondaryAction: boolean;
    } {
        const movementKey = (keys: string[]): boolean => !this.disableKeyboardMovement && this.isKeyDown(keys);
        return {
            forward: movementKey(this.KEY_FORWARD),
            backward: movementKey(this.KEY_BACKWARD),
            left: movementKey(this.KEY_LEFT),
            right: movementKey(this.KEY_RIGHT),
            ascend: movementKey(this.KEY_ASCEND),
            descend: movementKey(this.KEY_DESCEND),
            interact: this.isKeyDown(this.KEY_INTERACT),
            // Action/secondaryAction combine keyboard AND mouse input
            action: this.actionPressed || this.isKeyDown(this.KEY_ACTION),
            secondaryAction: this.secondaryActionPressed || this.isKeyDown(this.KEY_SECONDARY_ACTION)
        };
    }
}

/** True when a keystroke belongs to a text field the player is typing in, not to the game. */
function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
