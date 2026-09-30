import type { IInputControls } from 'engine/IInputControls.js';

/**
 * Gamepad (Xbox/PlayStation/etc.) input handling via the Gamepad API.
 * Implements IInputControls for consistent input polling alongside DesktopControls and MobileControls.
 *
 * Standard Gamepad button layout (mapping === "standard"):
 *   0: A (South)    1: B (East)    2: X (West)    3: Y (North)
 *   4: LB           5: RB          6: LT           7: RT
 *   8: Back/Select  9: Start      10: L3          11: R3
 *  12: D-Up        13: D-Down     14: D-Left      15: D-Right
 *  16: Home/Guide
 *
 * Axes: 0: Left X, 1: Left Y, 2: Right X, 3: Right Y
 */

export interface GamepadControlsConfig {
    /** Radial deadzone for combined stick magnitude (default 0.15) */
    stickDeadzone?: number;
    /** Per-axis deadzone applied independently to X and Y before the radial check (default 0.12) */
    axisDeadzone?: number;
    /** Camera look sensitivity multiplier for right stick (default 3.0) */
    cameraSensitivity?: number;
}

// Xbox-style labels (also used for generic controllers)
const XBOX_BUTTON_LABELS: Record<number, string> = {
    0: 'A', 1: 'B', 2: 'X', 3: 'Y',
    4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
    8: 'Back', 9: 'Start', 10: 'L3', 11: 'R3',
    12: 'D-Up', 13: 'D-Down', 14: 'D-Left', 15: 'D-Right',
};

// PlayStation-style labels
const PS_BUTTON_LABELS: Record<number, string> = {
    0: 'Cross', 1: 'Circle', 2: 'Square', 3: 'Triangle',
    4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2',
    8: 'Share', 9: 'Options', 10: 'L3', 11: 'R3',
    12: 'D-Up', 13: 'D-Down', 14: 'D-Left', 15: 'D-Right',
};

/**
 * 'standard': the browser's Standard Gamepad layout. 'generic': a pad the browser reported with
 * an empty mapping — left stick on axes 0/1, right stick on 2/3, or 2/5 on a six-axis pad
 * (DirectInput's usual order puts the triggers on 3/4), buttons by index as reported.
 */
export type GamepadLayout = 'standard' | 'generic';

/** An action a pad button can trigger. Each is bound to one primary button plus any aliases. */
type GamepadAction = 'ascend' | 'exit' | 'interact' | 'action' | 'secondary' | 'descend';

export class GamepadControls implements IInputControls {
    private controlsEnabled: boolean = true;
    private gamepadIndex: number | null = null;
    private gamepadId: string = '';
    private gamepadMapping: string = '';
    /** How the held pad's axes are read — see scanForGamepad. */
    private layout: GamepadLayout = 'standard';

    // Deadzones
    private stickDeadzone: number;
    private axisDeadzone: number;
    private cameraSensitivity: number;
    private moveYEnabled: boolean = true;

    // IInputControls properties - movement (left stick)
    public moveX: number = 0;
    public moveY: number = 0;

    // IInputControls properties - button states
    public ascendPressed: boolean = false;
    public descendPressed: boolean = false;
    public actionPressed: boolean = false;
    public secondaryActionPressed: boolean = false;
    public interactPressed: boolean = false;
    public exitPressed: boolean = false;

    // Camera look output (right stick)
    public cameraX: number = 0;
    public cameraY: number = 0;

    // True when any button or stick produced input this frame (used for input-source detection)
    public hadInputThisFrame: boolean = false;

    // Configurable button mapping — primary button (used for labels) + optional aliases.
    // Defaults are the standard-layout positions noted against each action.
    private bindings: Record<GamepadAction, { primary: number; aliases: number[] }> = {
        ascend: { primary: 0, aliases: [] },     // A
        exit: { primary: 1, aliases: [] },       // B
        interact: { primary: 2, aliases: [] },   // X
        action: { primary: 7, aliases: [] },     // RT
        secondary: { primary: 6, aliases: [] },  // LT
        descend: { primary: 4, aliases: [] },    // LB
    };

    // Previous frame button states for edge detection
    private prevButtons: boolean[] = [];

    // Re-scan throttle
    private scanCounter: number = 0;
    private static readonly SCAN_INTERVAL: number = 60;

    // Bound event handlers
    private boundOnConnected: (e: GamepadEvent) => void;
    private boundOnDisconnected: (e: GamepadEvent) => void;

    constructor(config: GamepadControlsConfig = {}) {
        this.stickDeadzone = config.stickDeadzone ?? 0.15;
        this.axisDeadzone = config.axisDeadzone ?? 0.12;
        this.cameraSensitivity = config.cameraSensitivity ?? 3.0;

        this.boundOnConnected = this.onGamepadConnected.bind(this);
        this.boundOnDisconnected = this.onGamepadDisconnected.bind(this);

        window.addEventListener('gamepadconnected', this.boundOnConnected);
        window.addEventListener('gamepaddisconnected', this.boundOnDisconnected);

        this.scanForGamepad();
    }

    // ==================== Gamepad detection ====================

    /**
     * A "standard"-mapped pad is taken first. Failing that, any connected pad with two axes is
     * taken with the generic layout — a pad the browser could not map is still a pad. On a Mac
     * Chrome reports almost every controller as standard; on Windows only XInput (Xbox-class)
     * pads are, and a DirectInput one — a PlayStation pad without its driver, most third-party
     * pads — reports an empty mapping. Ignoring it, as this used to, left those players with a
     * controller the game never saw and no message saying so.
     */
    private scanForGamepad(): void {
        const gamepads = navigator.getGamepads();
        let fallback: Gamepad | null = null;
        for (let i = 0; i < gamepads.length; i++) {
            const gp = gamepads[i];
            if (!gp || !gp.connected) continue;
            if (gp.mapping === 'standard') {
                this.adopt(gp, 'standard', 'Found gamepad');
                return;
            }
            if (!fallback && gp.axes.length >= 2) fallback = gp;
        }
        if (fallback) this.adopt(fallback, 'generic', 'Found gamepad');
    }

    private onGamepadConnected(event: GamepadEvent): void {
        const gp = event.gamepad;
        if (this.gamepadIndex !== null) {
            // Holding a generic pad and a standard one arrives: prefer the standard one.
            if (this.layout === 'generic' && gp.mapping === 'standard') this.adopt(gp, 'standard', 'Gamepad connected');
            return;
        }
        if (gp.mapping === 'standard') this.adopt(gp, 'standard', 'Gamepad connected');
        else if (gp.axes.length >= 2) this.adopt(gp, 'generic', 'Gamepad connected');
    }

    private adopt(gp: Gamepad, layout: GamepadLayout, verb: string): void {
        this.gamepadIndex = gp.index;
        this.gamepadId = gp.id;
        this.gamepadMapping = gp.mapping;
        this.layout = layout;
        this.prevButtons = [];
        const note = layout === 'generic' ? ` — mapping "${gp.mapping}", ${gp.axes.length} axes, ${gp.buttons.length} buttons, using the generic layout` : '';
        console.log(`[GamepadControls] ${verb}: "${gp.id}" (index ${gp.index})${note}`);
    }

    private onGamepadDisconnected(event: GamepadEvent): void {
        if (event.gamepad.index === this.gamepadIndex) {
            console.log(`[GamepadControls] Gamepad disconnected: "${event.gamepad.id}"`);
            this.clearGamepad();
        }
    }

    /** Forget the held pad and zero everything it was driving. */
    private clearGamepad(): void {
        this.gamepadIndex = null;
        this.gamepadId = '';
        this.gamepadMapping = '';
        this.layout = 'standard';
        this.resetAll();
    }

    /** What is driving the input right now, for a game that wants to tell the player. */
    public getGamepadInfo(): { id: string; index: number; mapping: string; layout: GamepadLayout } | null {
        if (this.gamepadIndex === null) return null;
        return { id: this.gamepadId, index: this.gamepadIndex, mapping: this.gamepadMapping, layout: this.layout };
    }

    // ==================== Deadzone ====================

    /**
     * Apply per-axis deadzone then radial deadzone to a 2D stick input.
     * Per-axis deadzone zeroes out each axis independently (prevents slight drift
     * when pushing straight forward/sideways). Radial deadzone then filters the
     * combined vector.
     */
    private applyDeadzone(rawX: number, rawY: number): [number, number] {
        const x = this.applyAxisDeadzone(rawX);
        const y = this.applyAxisDeadzone(rawY);

        // Radial deadzone on the post-axis-filtered values
        const magnitude = Math.sqrt(x * x + y * y);
        if (magnitude < this.stickDeadzone) {
            return [0, 0];
        }
        const scale = (magnitude - this.stickDeadzone) / (1 - this.stickDeadzone) / magnitude;
        return [clampUnit(x * scale), clampUnit(y * scale)];
    }

    /** Zero one axis inside its deadzone, and rescale what is left so it still reaches 1. */
    private applyAxisDeadzone(raw: number): number {
        const magnitude = Math.abs(raw);
        if (magnitude < this.axisDeadzone) return 0;
        return Math.sign(raw) * (magnitude - this.axisDeadzone) / (1 - this.axisDeadzone);
    }

    // ==================== Internal helpers ====================

    private getGamepad(): Gamepad | null {
        if (this.gamepadIndex === null) return null;
        const gamepads = navigator.getGamepads();
        if (!gamepads) return null;
        return gamepads[this.gamepadIndex] ?? null;
    }

    private isButtonPressed(gp: Gamepad, index: number): boolean {
        const button = gp.buttons[index];
        return button !== undefined && button.pressed;
    }

    private isButtonJustPressed(gp: Gamepad, index: number): boolean {
        const current = this.isButtonPressed(gp, index);
        const previous = this.prevButtons[index] ?? false;
        return current && !previous;
    }

    /** True while any button bound to `action` — primary or alias — is held. */
    private isActionPressed(gp: Gamepad, action: GamepadAction): boolean {
        const { primary, aliases } = this.bindings[action];
        return this.isButtonPressed(gp, primary) || aliases.some(i => this.isButtonPressed(gp, i));
    }

    /** True on the single frame any button bound to `action` goes down. */
    private isActionJustPressed(gp: Gamepad, action: GamepadAction): boolean {
        const { primary, aliases } = this.bindings[action];
        return this.isButtonJustPressed(gp, primary) || aliases.some(i => this.isButtonJustPressed(gp, i));
    }

    private savePrevButtons(gp: Gamepad): void {
        this.prevButtons = gp.buttons.map(b => b.pressed);
    }

    /**
     * Mark every currently-held button as "already seen" so `isButtonJustPressed`
     * returns false for it until it is physically released and pressed again.
     * Released buttons are left untouched. Movement axes and camera state are
     * unaffected. Intended for teleport-style relocations where a held button
     * must not re-fire as a fresh edge on the frame after the player moves.
     */
    public consumeCurrentPresses(): void {
        const gp = this.getGamepad();
        if (!gp) return;
        gp.buttons.forEach((button, i) => {
            if (button.pressed) this.prevButtons[i] = true;
        });
    }

    private resetAll(): void {
        this.moveX = 0;
        this.moveY = 0;
        this.cameraX = 0;
        this.cameraY = 0;
        this.ascendPressed = false;
        this.descendPressed = false;
        this.actionPressed = false;
        this.secondaryActionPressed = false;
        this.interactPressed = false;
        this.exitPressed = false;
        this.hadInputThisFrame = false;
        this.prevButtons = [];
    }

    // ==================== Button mapping setters ====================
    // set*Button replaces the primary mapping (used for labels) and clears aliases.
    // add*Button adds an extra button that also triggers the same action.

    public setAscendButton(index: number): void { this.bindings.ascend = { primary: index, aliases: [] }; }
    public setExitButton(index: number): void { this.bindings.exit = { primary: index, aliases: [] }; }
    public setInteractButton(index: number): void { this.bindings.interact = { primary: index, aliases: [] }; }
    public setActionButton(index: number): void { this.bindings.action = { primary: index, aliases: [] }; }
    public setSecondaryActionButton(index: number): void { this.bindings.secondary = { primary: index, aliases: [] }; }
    public setDescendButton(index: number): void { this.bindings.descend = { primary: index, aliases: [] }; }

    public addAscendButton(index: number): void { this.bindings.ascend.aliases.push(index); }
    public addExitButton(index: number): void { this.bindings.exit.aliases.push(index); }
    public addInteractButton(index: number): void { this.bindings.interact.aliases.push(index); }
    public addActionButton(index: number): void { this.bindings.action.aliases.push(index); }
    public addSecondaryActionButton(index: number): void { this.bindings.secondary.aliases.push(index); }
    public addDescendButton(index: number): void { this.bindings.descend.aliases.push(index); }

    // ==================== Deadzone/sensitivity setters ====================

    public setStickDeadzone(value: number): void { this.stickDeadzone = value; }
    public setAxisDeadzone(value: number): void { this.axisDeadzone = value; }
    public setCameraSensitivity(value: number): void { this.cameraSensitivity = value; }

    /**
     * Enable or disable the left stick Y-axis contribution to moveY.
     * When false, moveY is always 0 — useful for racing games where the stick
     * should only steer (left/right) while triggers handle acceleration/braking.
     */
    public setMoveYEnabled(enabled: boolean): void { this.moveYEnabled = enabled; }

    // ==================== Label methods ====================

    /**
     * Detect if the connected gamepad is a PlayStation controller
     * based on its id string (vendor ID 054c = Sony, or name keywords).
     */
    public isPlayStation(): boolean {
        const id = this.gamepadId.toLowerCase();
        return id.includes('054c') || id.includes('dualsense') || id.includes('dualshock') || id.includes('playstation');
    }

    /** Get the label for a standard-mapping button index using the correct label set */
    public getButtonLabel(index: number): string {
        const labels = this.isPlayStation() ? PS_BUTTON_LABELS : XBOX_BUTTON_LABELS;
        return labels[index] ?? `B${index}`;
    }

    public getAscendButtonLabel(): string { return this.getButtonLabel(this.bindings.ascend.primary); }
    public getExitButtonLabel(): string { return this.getButtonLabel(this.bindings.exit.primary); }
    public getInteractButtonLabel(): string { return this.getButtonLabel(this.bindings.interact.primary); }
    public getActionButtonLabel(): string { return this.getButtonLabel(this.bindings.action.primary); }
    public getSecondaryActionButtonLabel(): string { return this.getButtonLabel(this.bindings.secondary.primary); }
    public getDescendButtonLabel(): string { return this.getButtonLabel(this.bindings.descend.primary); }

    // ==================== IInputControls Implementation ====================

    public isEnabled(): boolean {
        return this.gamepadIndex !== null && this.controlsEnabled;
    }

    public update(): void {
        this.hadInputThisFrame = false;

        // Periodically re-scan when no gamepad is connected
        if (this.gamepadIndex === null) {
            this.scanCounter++;
            if (this.scanCounter >= GamepadControls.SCAN_INTERVAL) {
                this.scanCounter = 0;
                this.scanForGamepad();
            }
        }

        const gp = this.getGamepad();
        if (!gp) {
            if (this.gamepadIndex !== null) this.clearGamepad();
            return;
        }

        // Left stick -> movement (Y-axis inverted: -1 = up/forward, +1 = down/backward)
        const [lx, ly] = this.applyDeadzone(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
        this.moveX = lx;
        this.moveY = this.moveYEnabled ? -ly : 0;

        // Right stick -> camera look (a generic six-axis pad usually has its triggers on 3/4)
        const rightY = this.layout === 'generic' && gp.axes.length >= 6 ? 5 : 3;
        const [rx, ry] = this.applyDeadzone(gp.axes[2] ?? 0, gp.axes[rightY] ?? 0);
        this.cameraX = rx * this.cameraSensitivity;
        this.cameraY = ry * this.cameraSensitivity;

        // Edge-detected (one-shot) buttons — latched until the game resets them
        if (this.isActionJustPressed(gp, 'ascend')) this.ascendPressed = true;
        if (this.isActionJustPressed(gp, 'exit')) this.exitPressed = true;
        if (this.isActionJustPressed(gp, 'interact')) this.interactPressed = true;

        // Continuous (held) buttons
        this.actionPressed = this.isActionPressed(gp, 'action');
        this.secondaryActionPressed = this.isActionPressed(gp, 'secondary');
        this.descendPressed = this.isActionPressed(gp, 'descend');

        // D-pad digital movement overlay
        if (this.isButtonPressed(gp, 12)) this.moveY = 1;
        if (this.isButtonPressed(gp, 13)) this.moveY = -1;
        if (this.isButtonPressed(gp, 14)) this.moveX = -1;
        if (this.isButtonPressed(gp, 15)) this.moveX = 1;

        // Track whether any input happened this frame (for input-source detection)
        const anyStick = Math.abs(this.moveX) > 0 || Math.abs(this.moveY) > 0
            || Math.abs(this.cameraX) > 0 || Math.abs(this.cameraY) > 0;
        const anyButton = gp.buttons.some((b, i) => b.pressed && !(this.prevButtons[i] ?? false))
            || this.actionPressed || this.secondaryActionPressed || this.descendPressed;
        this.hadInputThisFrame = anyStick || anyButton;

        this.savePrevButtons(gp);
    }

    public dispose(): void {
        window.removeEventListener('gamepadconnected', this.boundOnConnected);
        window.removeEventListener('gamepaddisconnected', this.boundOnDisconnected);
        this.clearGamepad();
    }

    public resetActionPressed(): void { this.actionPressed = false; }
    public resetSecondaryActionPressed(): void { this.secondaryActionPressed = false; }
    public resetInteractPressed(): void { this.interactPressed = false; }
    public resetAscendPressed(): void { this.ascendPressed = false; }
    public resetDescendPressed(): void { this.descendPressed = false; }
    public resetExitPressed(): void { this.exitPressed = false; }

    public setControlsEnabled(enabled: boolean): void {
        this.controlsEnabled = enabled;
        if (!enabled) {
            this.resetAll();
        }
    }

    public getControlsEnabled(): boolean {
        return this.controlsEnabled;
    }
}

/** Clamp a stick value to the [-1, 1] range the rest of the engine expects. */
function clampUnit(value: number): number {
    return Math.max(-1, Math.min(1, value));
}
