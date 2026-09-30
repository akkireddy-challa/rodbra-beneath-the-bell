import { t } from 'engine/i18n/index.js';
import type { IInputControls } from 'engine/IInputControls.js';
import { MobileIconRegistry } from 'engine/MobileActionSpec.js';
import type { MobileButtonPosition } from 'engine/MobileButtonLayout.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';
import { renderButtonContent } from 'engine/ui/buttonContent.js';

// Mobile buttons are colored entirely by the active UI theme. Every button gets
// a semantic role (primary / danger / warning) whose `.hud-mobile-button--<role>`
// CSS class reads the matching `--hud-color-*` token, so the touch UI recolors
// when the theme changes. Per-action-type colors are intentionally NOT modelled
// here — the role of the button's slot decides the color, and the icon (looked
// up in MobileIconRegistry) distinguishes one action from another.

/** Semantic role → theme color token used to paint a mobile button. */
export type MobileButtonRole = 'primary' | 'danger' | 'warning';

/** Clamp `value` into [-limit, limit]. */
function clampSymmetric(value: number, limit: number): number {
    return Math.max(-limit, Math.min(limit, value));
}

/**
 * Built-in press flags, kept in one record so the state accessors, the
 * button-press dispatch, and the bulk reset all key off the same list.
 * 'actionHeld' is a pseudo-action: it has no button of its own, it is the
 * held (continuous) state of the 'action' button.
 */
const BUILTIN_FLAGS = ['ascend', 'descend', 'action', 'actionHeld', 'secondaryAction', 'interact', 'exit'] as const;
type BuiltinFlag = (typeof BUILTIN_FLAGS)[number];
const BUILTIN_FLAG_SET: ReadonlySet<string> = new Set(BUILTIN_FLAGS);
function isBuiltinFlag(action: string): action is BuiltinFlag {
    return BUILTIN_FLAG_SET.has(action);
}

export interface MobileControlsConfig {
    joystickSize?: number;
    joystickDeadzone?: number;
    cameraSensitivity?: number;
    autoFollowCamera?: boolean;
    autoFollowSpeed?: number;
    buttons?: MobileButtonDef[];
}

/**
 * Definition for a dynamically created mobile button.
 * Used to configure which buttons appear and how they behave.
 */
export interface MobileButtonDef {
    /** Action name — must match a known action: 'ascend', 'descend', 'action', 'secondaryAction', 'interact', 'exit' */
    action: string;
    /** Display label for the button (the accessible name when `imageUrl` is set) */
    label: string;
    /**
     * Image URL (PNG/SVG/WebP) drawn instead of the text label; the label stays
     * the accessible name. A `{ kind: 'url' }` MobileIconRegistry entry sets this.
     */
    imageUrl?: string;
    /**
     * Semantic role selecting which theme color paints the button. Built-in
     * actions derive their role automatically (see BUILTIN_ACTION_ROLES);
     * custom actions default to 'primary' when omitted.
     */
    role?: MobileButtonRole;
    /**
     * @deprecated Mobile buttons now follow the UI theme — colors come from the
     * button's semantic `role`, not per-button overrides. Kept (optional) only so
     * existing genre code that still passes a color keeps type-checking; the value
     * is ignored.
     */
    baseColor?: string;
    /** @deprecated See `baseColor` — ignored, the theme drives the pressed color. */
    pressedColor?: string;
    /** 'tap' fires on release, 'continuous' fires while held */
    behavior: 'tap' | 'continuous';
}

export class MobileControls implements IInputControls {
    private enabled: boolean = false;
    private controlsEnabled: boolean = true; // Controls can be temporarily disabled
    // When false, the joystick and ascend/descend buttons stay hidden even while the
    // rest of the UI is visible — games with no movable player (strategy/board games)
    // have nothing for them to drive. Set via setMovementControlsAvailable().
    private movementControlsAvailable: boolean = true;
    // Tracks the last setVisible() state so setMovementControlsAvailable() can re-apply
    // joystick visibility without the caller re-issuing setVisible().
    private uiVisible: boolean = false;
    // Last movement-button params from updateMovementButtons(), replayed when
    // movementControlsAvailable toggles so ascend/descend re-show per supportedKeys.
    private lastMovementButtons: { ascendName: string; descendName: string; supportedKeys: { ascend: boolean; descend: boolean } } | null = null;
    private joystickContainer: HTMLDivElement | null = null;
    private joystickOuter: HTMLDivElement | null = null;
    private joystickInner: HTMLDivElement | null = null;

    private joystickTouch: Touch | null = null;
    private cameraTouch: Touch | null = null;

    private joystickCenter: { x: number; y: number } = { x: 0, y: 0 };
    private joystickSize: number;
    private joystickDeadzone: number;
    private cameraSensitivity: number;

    // Driving mode (active while the player is in a vehicle — see
    // PlayerVehicleController): a classic 2-axis joystick is unusable for cars
    // because steering and throttle fight on one thumb. Instead the left stick
    // becomes a horizontal STEERING slider (moveX only) and the whole
    // bottom-right of the screen is a held GAS pedal (moveY = 1 → keys.forward)
    // so the player finds the throttle without looking. Action buttons re-anchor
    // above the gas zone. There is no default brake — a game that wants one adds
    // it as an action button (e.g. { action: 'ascend', behavior: 'continuous' }).
    private drivingMode: boolean = false;
    private gasTouch: Touch | null = null;
    private gasPedal: HTMLDivElement | null = null;
    private reverseTouch: Touch | null = null;
    private reversePedal: HTMLDivElement | null = null;
    /** Bottom fraction of the viewport (right half) that acts as the gas pedal. */
    private static readonly GAS_ZONE_FRACTION = 0.35;
    /** Bottom-right corner rect (px from the edges) that reverses instead —
     *  the smaller ▼ pedal below the gas pedal. Reverse doubles as the brake
     *  while rolling forward (keys.backward → signed drive gate). */
    private static readonly REVERSE_ZONE_WIDTH = 124;
    private static readonly REVERSE_ZONE_HEIGHT = 72;

    /** moveY is owned by the pedals while driving: reverse (also the brake) wins. */
    private updateDriveAxis(): void {
        this.moveY = this.reverseTouch ? -1 : (this.gasTouch ? 1 : 0);
        this.gasPedal?.classList.toggle('is-pressed', !!this.gasTouch);
        this.reversePedal?.classList.toggle('is-pressed', !!this.reverseTouch);
    }

    private isInReverseZone(x: number, y: number): boolean {
        return x >= window.innerWidth - MobileControls.REVERSE_ZONE_WIDTH
            && y >= window.innerHeight - MobileControls.REVERSE_ZONE_HEIGHT;
    }

    /** Gas is the whole bottom band of the right half — only the y axis matters. */
    private isInGasZone(y: number): boolean {
        return y >= window.innerHeight * (1 - MobileControls.GAS_ZONE_FRACTION);
    }

    // Movement state (normalized -1 to 1)
    public moveX: number = 0;
    public moveY: number = 0;

    // Camera delta
    public cameraDeltaX: number = 0;
    public cameraDeltaY: number = 0;

    private lastCameraPosition: { x: number; y: number } | null = null;

    // Auto-follow camera settings
    private autoFollowCamera: boolean;
    private autoFollowSpeed: number;
    public isManualCameraControl: boolean = false;

    private cameraTouchStartTime: number = 0;
    private cameraTouchStartPos: { x: number; y: number } | null = null;
    private readonly TAP_MAX_DURATION = 200; // milliseconds
    private readonly TAP_MAX_DISTANCE = 20; // pixels

    // Dynamic buttons map: action name → { element, behavior }
    private buttons: Map<string, { element: HTMLButtonElement; behavior: 'tap' | 'continuous' }> = new Map();

    // Button pressed states — externally READ-ONLY. Writes from outside MobileControls
    // are silently ignored by the setters below. Internal code writes to the private
    // `flags` record directly. The engine consumes state only via resetAscendPressed()
    // / resetDescendPressed() / resetActionPressed() / resetSecondaryActionPressed().
    //
    // Why: subclasses (e.g. a PlayerController override) used to do
    //     `this.mobileControls.jumpPressed = false`
    // which consumed the one-shot flag BEFORE the engine's applyMobileControlsToKeys()
    // had a chance to OR-merge it into keys.ascend. That silently dropped jumps.
    // Making the setters no-op eliminates that entire bug class.
    private flags: Record<BuiltinFlag, boolean> = {
        ascend: false, descend: false, action: false, actionHeld: false,
        secondaryAction: false, interact: false, exit: false,
    };

    public get ascendPressed(): boolean { return this.flags.ascend; }
    public set ascendPressed(_: boolean) { /* write-protected; use resetAscendPressed() to clear */ }
    public get descendPressed(): boolean { return this.flags.descend; }
    public set descendPressed(_: boolean) { /* write-protected; use resetDescendPressed() to clear */ }
    public get interactPressed(): boolean { return this.flags.interact; }
    public set interactPressed(value: boolean) {
        // Writes to interactPressed are allowed (PlayerController uses this for interaction
        // prompt triggering via external code paths). Only button-press one-shots are locked.
        this.flags.interact = value;
    }
    public get exitPressed(): boolean { return this.flags.exit; }
    public set exitPressed(_: boolean) { /* write-protected */ }
    public get actionPressed(): boolean { return this.flags.action; }
    public set actionPressed(_: boolean) { /* write-protected; use resetActionPressed() to clear */ }
    public get actionHeld(): boolean { return this.flags.actionHeld; }
    public set actionHeld(_: boolean) { /* write-protected */ }
    public get secondaryActionPressed(): boolean { return this.flags.secondaryAction; }
    public set secondaryActionPressed(_: boolean) { /* write-protected; use resetSecondaryActionPressed() to clear */ }

    // Legacy alias: jumpPressed → ascendPressed, both read-only externally
    public get jumpPressed(): boolean { return this.flags.ascend; }
    public set jumpPressed(_: boolean) { /* write-protected; external consumption is a bug — the engine handles it */ }

    // Per-action behavior (tap fires on release, continuous fires while held)
    private buttonBehaviors: Map<string, 'tap' | 'continuous'> = new Map();

    // Custom (registered) action states. The 6 built-in actions (ascend, descend, action,
    // secondaryAction, interact, exit) use dedicated private fields above for backward
    // compatibility. Any action registered via registerAction() gets a slot here.
    // PlayerController.applyMobileControlsToKeys() reads and OR-merges these into `keys`.
    private customActions: Map<string, { pressed: boolean; behavior: 'tap' | 'continuous' }> = new Map();

    // Bound event handlers for proper add/remove pairing
    private boundOnTouchStart: (e: TouchEvent) => void;
    private boundOnTouchMove: (e: TouchEvent) => void;
    private boundOnTouchEnd: (e: TouchEvent) => void;

    /**
     * Callback invoked by {@link forceDisable} to let an attached
     * {@link MobileControlsDebug} tear down its mouse/keyboard listeners.
     * Null on real mobile devices; populated only when a debug sidecar
     * wires itself up via {@link _debug_setDisableHook}.
     *
     * @internal — do not set from outside the debug sidecar.
     */
    private debugDisableHook: (() => void) | null = null;

    constructor(config: MobileControlsConfig = {}) {
        this.joystickSize = config.joystickSize ?? 80;
        this.joystickDeadzone = config.joystickDeadzone ?? 0.15;
        this.cameraSensitivity = config.cameraSensitivity ?? 0.002;
        this.autoFollowCamera = config.autoFollowCamera ?? true;
        this.autoFollowSpeed = config.autoFollowSpeed ?? 2.0;

        // Store bound refs so add/remove use the same function reference
        this.boundOnTouchStart = this.onTouchStart.bind(this);
        this.boundOnTouchMove = this.onTouchMove.bind(this);
        this.boundOnTouchEnd = this.onTouchEnd.bind(this);

        // Only enable on mobile devices
        if (isMobileRuntime()) {
            this.createUI();
            this.setupEventListeners();
            this.enabled = true;
            // Start hidden — PlayerController.setControlsEnabled(true), called
            // from handleGameStart() on Play-button click (and from the editor
            // 'prompt' tab handler in creator mode), shows the UI. Without this,
            // the joystick and action buttons render over the loading indicator
            // and Play menu before gameplay has actually begun. The creator's
            // desktop mobile-preview path goes through _debug_enableUIIfNeeded()
            // and is left default-visible — the creator user opted in explicitly.
            this.setVisible(false);
        }
    }

    private createUI(): void {
        // Create joystick container (starts at bottom-left, re-centers on touch)
        this.joystickContainer = document.createElement('div');
        // The theme's element-class hook. These nodes attach to document.body
        // rather than being built by GameHUD's factory, so per-element theme
        // overrides (elements.mobileControls) reach them as a scoped CSS rule on
        // this class — see ThemeManager.applyDecorations.
        this.joystickContainer.classList.add('hud-mobile-controls');
        this.joystickContainer.style.position = 'fixed';
        this.joystickContainer.style.left = '30px';
        this.joystickContainer.style.bottom = '30px';
        this.joystickContainer.style.width = `${this.joystickSize}px`;
        this.joystickContainer.style.height = `${this.joystickSize}px`;
        this.joystickContainer.style.zIndex = '1000';
        this.joystickContainer.style.touchAction = 'none';
        this.joystickContainer.style.opacity = '1';
        this.joystickContainer.style.transition = 'left 0.2s ease-out, top 0.2s ease-out, bottom 0.2s ease-out';
        this.joystickContainer.style.pointerEvents = 'none';

        // Joystick outer circle — color tinted via .hud-mobile-joystick-outer
        // so the joystick recolors when the theme changes.
        this.joystickOuter = document.createElement('div');
        this.joystickOuter.className = 'hud-mobile-joystick-outer';
        this.joystickOuter.style.width = '100%';
        this.joystickOuter.style.height = '100%';
        this.joystickOuter.style.borderRadius = '50%';
        // Border color is theme-driven via .hud-mobile-joystick-outer (uses
        // --hud-color-text), not a hardcoded white.
        this.joystickOuter.style.position = 'relative';

        // Joystick inner circle (knob)
        this.joystickInner = document.createElement('div');
        this.joystickInner.className = 'hud-mobile-joystick-inner';
        this.joystickInner.style.width = '40%';
        this.joystickInner.style.height = '40%';
        this.joystickInner.style.borderRadius = '50%';
        this.joystickInner.style.position = 'absolute';
        this.joystickInner.style.left = '30%';
        this.joystickInner.style.top = '30%';
        this.joystickInner.style.transition = 'none';

        this.joystickOuter.appendChild(this.joystickInner);
        this.joystickContainer.appendChild(this.joystickOuter);
        document.body.appendChild(this.joystickContainer);

        // Create default buttons
        this.createDefaultButtons();
    }

    /**
     * Built-in actions → semantic role class. Drives which `--hud-color-*` token
     * paints the button so the mobile UI recolors with the active theme.
     *   primary = Jump/Crouch/Interact (movement + benign verbs)
     *   danger  = Attack/Exit (destructive or "main" combat verb)
     *   warning = Secondary action (block/aim/reload — alt-action)
     * Custom genre-registered actions default to the `primary` role (unless the
     * def names another role), so they also follow the theme.
     */
    private static readonly BUILTIN_ACTION_ROLES: Readonly<Record<string, MobileButtonRole>> = {
        ascend: 'primary',
        descend: 'primary',
        interact: 'primary',
        action: 'danger',
        exit: 'danger',
        secondaryAction: 'warning',
    };

    /**
     * Default button layout. Colors come from each action's theme role (see
     * BUILTIN_ACTION_ROLES); labels are filled in later — the movement/contextual
     * buttons (ascend/descend/interact/exit) by `createDefaultButtons` from i18n,
     * and the action/secondaryAction buttons by `setActionType` /
     * `setSecondaryActionType`. Fallback labels render in the theme font (never emojis).
     */
    private static readonly DEFAULT_BUTTONS: MobileButtonDef[] = [
        { action: 'exit', label: '', behavior: 'tap' },
        { action: 'action', label: 'ACT', behavior: 'tap' },
        { action: 'secondaryAction', label: 'ALT', behavior: 'tap' },
        { action: 'ascend', label: '', behavior: 'tap' },
        { action: 'descend', label: '', behavior: 'tap' },
        { action: 'interact', label: '', behavior: 'tap' },
    ];

    /** Position config per action — bottom/right (or left/top) offsets for the button */
    private static readonly BUTTON_POSITIONS: Record<string, MobileButtonPosition> = {
        exit:            { bottom: '30px',             right: '30px',  width: 'auto',  height: 'auto', borderRadius: '12px', fontSize: '18px' },
        action:          { bottom: 'min(130px, 28vh)', right: '20px',  width: '70px',  height: '70px', borderRadius: '50%',  fontSize: '24px' },
        secondaryAction: { bottom: 'min(130px, 28vh)', right: '100px', width: '70px',  height: '70px', borderRadius: '50%',  fontSize: '24px' },
        ascend:          { bottom: 'min(210px, 45vh)', right: '60px',  width: '70px',  height: '70px', borderRadius: '50%',  fontSize: '14px' },
        descend:         { bottom: 'min(50px, 10vh)',  right: '60px',  width: '70px',  height: '70px', borderRadius: '50%',  fontSize: '14px' },
        interact:        { bottom: '30px',             right: '30px',  width: 'auto',  height: 'auto', borderRadius: '12px', fontSize: '18px' },
    };

    /** Initially hidden buttons — shown later by game systems */
    private static readonly INITIALLY_HIDDEN = new Set(['exit', 'action', 'secondaryAction', 'interact']);

    private createDefaultButtons(): void {
        // Use translated labels for default buttons
        const labels: Record<string, string> = {
            exit: t('game.controls.exit'),
            ascend: t('game.controls.jump'),
            descend: t('game.controls.crouch'),
            interact: t('game.controls.interact'),
        };
        for (const def of MobileControls.DEFAULT_BUTTONS) {
            const label = labels[def.action] || def.label;
            this.createButton({ ...def, label });
        }
    }

    /**
     * Create a single button from a definition and add it to the buttons map.
     * Attaches touch event handlers for press/release.
     */
    private createButton(def: MobileButtonDef): HTMLButtonElement {
        const btn = document.createElement('button');
        const pos = MobileControls.BUTTON_POSITIONS[def.action];

        // Theme-aware coloring. Every button gets a semantic role class whose
        // `--hud-color-*` token paints it, so the whole touch UI recolors with the
        // active theme. Built-in actions derive their role; custom genre actions use
        // their declared `role` or fall back to 'primary'. No inline color is set —
        // the theme is the single source of truth.
        btn.className = 'hud-mobile-controls hud-mobile-button';
        const role = MobileControls.BUILTIN_ACTION_ROLES[def.action] ?? def.role ?? 'primary';
        btn.classList.add(`hud-mobile-button--${role}`);

        // Position
        btn.style.position = 'fixed';
        this.applyPositionToButton(btn, pos);
        btn.style.zIndex = '1000';
        renderButtonContent(btn, 'hud-mobile-button', { label: def.label, imageUrl: def.imageUrl, imageOnly: true });

        // Press feedback is the theme-driven `.is-pressed` CSS (brightness + scale),
        // so no per-button colors need storing here.
        btn.dataset.action = def.action;

        // Initially hidden buttons — an engine-owned hide, so register it in
        // engineHiddenButtons; otherwise showInteractButton & co. would treat
        // the initial state as a game-side hide and refuse to show the button.
        if (MobileControls.INITIALLY_HIDDEN.has(def.action)) {
            btn.style.opacity = '0';
            btn.style.pointerEvents = 'none';
            this.engineHiddenButtons.add(def.action);
        } else {
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
        }

        // Touch handlers
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleButtonDown(def.action, btn);
        });
        btn.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleButtonUp(def.action, btn);
        });
        btn.addEventListener('touchcancel', () => {
            this.handleButtonUp(def.action, btn);
        });

        document.body.appendChild(btn);
        this.buttons.set(def.action, { element: btn, behavior: def.behavior });
        this.buttonBehaviors.set(def.action, def.behavior);
        // A button created while driving joins the driving ladder — reflow so
        // every button keeps a distinct slot.
        if (this.drivingMode) this.applyDrivingLayout();
        return btn;
    }

    /**
     * Apply a position spec's anchor/shape/size styles to a button. Shared by
     * createButton and the driving-mode layout swap (setDrivingMode), which
     * re-anchors every existing button without recreating it.
     */
    private applyPositionToButton(btn: HTMLButtonElement, pos: MobileButtonPosition | undefined): void {
        btn.style.bottom = pos?.bottom || '30px';
        btn.style.top = pos?.top !== undefined ? pos.top : 'auto';
        if (pos?.right !== undefined) {
            btn.style.right = pos.right;
        } else if (pos?.left === undefined) {
            // No horizontal anchor specified — fall back to right side (legacy default).
            btn.style.right = '30px';
        } else {
            btn.style.right = 'auto';
        }
        btn.style.left = pos?.left !== undefined ? pos.left : 'auto';
        // Shape / size — these vary per button slot, stay inline.
        btn.style.borderRadius = pos?.borderRadius || '50%';
        btn.style.fontSize = pos?.fontSize || '14px';
        if (pos?.width === 'auto') {
            btn.style.width = 'auto';
            btn.style.height = 'auto';
            btn.style.padding = '16px 24px';
        } else {
            btn.style.width = pos?.width || '70px';
            btn.style.height = pos?.height || '70px';
        }
    }

    /** Get a button element by action name */
    public getButton(action: string): HTMLButtonElement | null {
        return this.buttons.get(action)?.element || null;
    }

    /**
     * List every CUSTOM mobile action name registered via `registerAction()`.
     *
     * Built-in actions (exit, action, secondaryAction, ascend, descend,
     * interact) are intentionally excluded — they have no corresponding
     * "custom desktop key" and would otherwise be flagged as unpaired.
     *
     * Used by `PlayerController.verifyMobileParity()` to cross-check
     * custom desktop-key registrations against custom mobile buttons.
     */
    public getRegisteredActionNames(): string[] {
        return Array.from(this.customActions.keys());
    }

    /**
     * Replace all buttons with a new set of definitions.
     * Removes existing buttons and creates new ones.
     */
    public setButtons(defs: MobileButtonDef[]): void {
        this.removeAllButtons();
        for (const def of defs) {
            this.createButton(def);
        }
    }

    /**
     * Driving layout: every right-side button — built-in or game-registered —
     * gets a DISTINCT slot in a ladder above the gas zone, assigned in button
     * creation order. Never derived from each button's walking position: the
     * first version raised each button to a fixed bottom, which piled a game's
     * custom buttons onto the same spot as the action button.
     */
    private applyDrivingLayout(): void {
        // Row floors clear the pedal stack (reverse 72px + gap + gas ~110px) on
        // short landscape screens where 38vh alone would land inside the pedals.
        const ROWS = [
            'max(190px, min(270px, 38vh))',
            'max(266px, min(350px, 52vh))',
            'max(342px, min(430px, 66vh))',
            'max(418px, min(510px, 80vh))',
        ];
        // Two columns; row 2 col 20px is reserved for the exit/interact pill.
        const SLOTS: Array<[number, string]> = [[0, '20px'], [0, '100px'], [1, '20px'], [1, '100px'], [2, '100px'], [3, '20px'], [3, '100px']];
        let slot = 0;
        // VISIBLE buttons claim the low (thumb-reachable) slots first — hidden
        // ones take the leftovers. Otherwise the four hidden built-ins shove a
        // game's only visible buttons into the top-right HUD on short landscape
        // screens. Every visibility toggle re-runs this layout.
        const entries = [...this.buttons.entries()];
        const hidden = ([, e]: (typeof entries)[number]): boolean =>
            e.element.style.opacity === '0' || e.element.style.display === 'none';
        const ordered = [...entries.filter((x) => !hidden(x)), ...entries.filter(hidden)];
        for (const [action, entry] of ordered) {
            const base = MobileControls.BUTTON_POSITIONS[action];
            if (action === 'exit' || action === 'interact') {
                this.applyPositionToButton(entry.element, {
                    bottom: ROWS[2]!, right: '20px', width: 'auto', height: 'auto', borderRadius: '12px', fontSize: '18px',
                });
                continue;
            }
            // Left/top-anchored buttons stay put — the gas zone is right-side only.
            if (base && (base.left !== undefined || base.top !== undefined)) {
                this.applyPositionToButton(entry.element, base);
                continue;
            }
            const [row, right] = SLOTS[Math.min(slot, SLOTS.length - 1)]!;
            slot++;
            // Slot marker for tests/debugging (jsdom drops min() CSS lengths,
            // so the applied styles alone can't prove slot distinctness there).
            entry.element.dataset.drivingSlot = `${row},${right}`;
            this.applyPositionToButton(entry.element, {
                bottom: ROWS[row]!,
                right,
                width: base?.width && base.width !== 'auto' ? base.width : '70px',
                height: base?.height && base.height !== 'auto' ? base.height : '70px',
                borderRadius: base?.borderRadius ?? '50%',
                fontSize: base?.fontSize ?? '20px',
            });
        }
    }

    /** Steering slider (driving mode) geometry, derived from joystickSize. */
    private steerGeometry(): { width: number; height: number; knob: number } {
        const height = Math.max(48, Math.round(this.joystickSize * 0.75));
        return { width: Math.round(this.joystickSize * 2.2), height, knob: Math.round(height * 0.72) };
    }

    /**
     * Remap a normalized stick magnitude (0..1) so the deadzone maps to 0 and the
     * remaining travel spans the full 0..1 range again. Shared by the walking
     * joystick's radial deadzone and the driving steering slider's horizontal one.
     */
    private applyDeadzone(magnitude: number): number {
        if (magnitude < this.joystickDeadzone) return 0;
        return Math.min(1.0, (magnitude - this.joystickDeadzone) / (1.0 - this.joystickDeadzone));
    }

    public isDrivingMode(): boolean {
        return this.drivingMode;
    }

    /**
     * Switch between the walking layout (2-axis joystick, tap-to-jump) and the
     * DRIVING layout (horizontal steering slider + bottom-right gas zone +
     * raised action buttons). Called by PlayerVehicleController on vehicle
     * enter/exit — game code normally never calls this directly.
     */
    public setDrivingMode(enabled: boolean): void {
        if (this.drivingMode === enabled) return;
        this.drivingMode = enabled;
        // Neutralize in-flight touches so no axis or pedal sticks across the switch.
        this.joystickTouch = null;
        this.gasTouch = null;
        this.reverseTouch = null;
        this.moveX = 0;
        this.moveY = 0;
        // On non-touch runtimes the touch UI was never built — record the mode
        // (so a later creator mobile-preview enable can catch up) but create
        // NOTHING: the pedals otherwise leak onto the desktop screen, where the
        // vehicle-enter path calls this too.
        if (!this.enabled) return;
        this.applyJoystickModeStyles();
        this.resetJoystickVisualPosition();
        if (enabled) this.createGasPedal(); else this.destroyGasPedal();
        // Re-anchor every existing button for the active layout.
        if (enabled) {
            this.applyDrivingLayout();
        } else {
            for (const [action, entry] of this.buttons) {
                this.applyPositionToButton(entry.element, MobileControls.BUTTON_POSITIONS[action]);
            }
        }
    }

    /** Restyle the joystick elements for the active mode (circle vs. steering pill). */
    private applyJoystickModeStyles(): void {
        if (!this.joystickContainer || !this.joystickOuter || !this.joystickInner) return;
        if (this.drivingMode) {
            const { width, height, knob } = this.steerGeometry();
            this.joystickContainer.style.width = `${width}px`;
            this.joystickContainer.style.height = `${height}px`;
            this.joystickOuter.style.borderRadius = `${height / 2}px`;
            this.joystickInner.style.width = `${knob}px`;
            this.joystickInner.style.height = `${knob}px`;
        } else {
            this.joystickContainer.style.width = `${this.joystickSize}px`;
            this.joystickContainer.style.height = `${this.joystickSize}px`;
            this.joystickOuter.style.borderRadius = '50%';
            this.joystickInner.style.width = '40%';
            this.joystickInner.style.height = '40%';
        }
    }

    /** The gas + reverse pedal HINTS — the zones do the work (gas = the whole
     *  bottom-right, reverse = the small corner rect), so these are
     *  pointer-events-none visuals that light up while their zone is held. */
    private createGasPedal(): void {
        if (this.gasPedal || !this.enabled) return;
        const mk = (glyph: string, bottom: string, height: string, fontSize: string): HTMLDivElement => {
            const pedal = document.createElement('div');
            pedal.className = 'hud-mobile-controls hud-mobile-button hud-mobile-button--primary';
            pedal.style.position = 'fixed';
            pedal.style.right = '20px';
            pedal.style.bottom = bottom;
            pedal.style.width = '84px';
            pedal.style.height = height;
            pedal.style.borderRadius = '20px';
            pedal.style.zIndex = '999';
            pedal.style.display = this.movementUiVisible() ? 'flex' : 'none';
            pedal.style.alignItems = 'center';
            pedal.style.justifyContent = 'center';
            pedal.style.fontSize = fontSize;
            pedal.style.pointerEvents = 'none';
            pedal.textContent = glyph;
            document.body.appendChild(pedal);
            return pedal;
        };
        // Gas sits above the reverse strip; the smaller ▼ below it backs up (and brakes).
        this.gasPedal = mk('▲', `${MobileControls.REVERSE_ZONE_HEIGHT + 16}px`, 'min(110px, 22vh)', '30px');
        this.reversePedal = mk('▼', '12px', `${MobileControls.REVERSE_ZONE_HEIGHT - 24}px`, '20px');
    }

    private destroyGasPedal(): void {
        this.gasPedal?.remove();
        this.gasPedal = null;
        this.reversePedal?.remove();
        this.reversePedal = null;
    }

    private setupEventListeners(): void {
        document.addEventListener('touchstart', this.boundOnTouchStart, { passive: false });
        document.addEventListener('touchmove', this.boundOnTouchMove, { passive: false });
        document.addEventListener('touchend', this.boundOnTouchEnd, { passive: false });
    }

    /**
     * True when a touch landed on interactive overlay DOM (a button, link, form
     * control, or ARIA button) rather than on the game surface.
     *
     * Such taps must be left untouched so the browser can synthesize the `click`
     * they rely on — calling `preventDefault()` on the touch (as the handlers
     * below otherwise do, to suppress scroll/zoom) cancels that synthetic click
     * and the tap is lost. The engine's own mobile buttons `stopPropagation()` so
     * they never reach this document-level handler; arbitrary template / overlay
     * UI (the multiplayer lobby, the appearance picker, custom HUD buttons) can't
     * be expected to, so we detect it by target instead. Interactive HUD custom
     * elements (often plain <div>s) carry `data-hud-interactive` for this — set by
     * GameHUD.createCustomElement({ interactive: true }).
     */
    private static isInteractiveUiTarget(target: EventTarget | null): boolean {
        if (!(target instanceof Element)) return false;
        return target.closest(
            'button, a[href], input, select, textarea, [role="button"], [contenteditable="true"], [data-hud-interactive]'
        ) !== null;
    }

    private onTouchStart(event: TouchEvent): void {
        // Don't process touch input if controls are disabled
        if (!this.controlsEnabled) return;

        // Let taps on overlay DOM UI through untouched so their synthetic click
        // fires — see isInteractiveUiTarget().
        if (MobileControls.isInteractiveUiTarget(event.target)) return;

        // Prevent browser default touch behavior (zoom, scroll) immediately
        event.preventDefault();

        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            if (!touch) continue;

            // Check if touch is on left half (joystick area)
            const screenWidth = window.innerWidth;
            const isLeftSide = touch.clientX < screenWidth / 2;

            if (isLeftSide && !this.joystickTouch) {
                // Handle as joystick input - re-center joystick at touch point
                this.joystickTouch = touch;
                if (this.joystickContainer) {
                    // Position joystick center at the touch point
                    this.joystickCenter = {
                        x: touch.clientX,
                        y: touch.clientY
                    };

                    // Move the container so its center is at the touch point
                    // (driving mode: the steering pill is wider than it is tall)
                    const geo = this.drivingMode ? this.steerGeometry() : null;
                    const halfW = (geo?.width ?? this.joystickSize) / 2;
                    const halfH = (geo?.height ?? this.joystickSize) / 2;
                    this.joystickContainer.style.left = `${touch.clientX - halfW}px`;
                    this.joystickContainer.style.top = `${touch.clientY - halfH}px`;
                    this.joystickContainer.style.bottom = 'auto'; // Override bottom positioning
                }
                continue;
            }

            // Driving mode: the small bottom-right corner rect is REVERSE (also
            // the brake), the rest of the bottom-right zone is the held GAS
            // pedal. Both claimed BEFORE the camera so the pedals always win
            // there; a claimed touch keeps its pedal until release even if the
            // finger drifts out.
            if (!isLeftSide && this.drivingMode) {
                if (!this.reverseTouch && this.isInReverseZone(touch.clientX, touch.clientY)) {
                    this.reverseTouch = touch;
                    this.updateDriveAxis();
                    continue;
                }
                if (!this.gasTouch && this.isInGasZone(touch.clientY)) {
                    this.gasTouch = touch;
                    this.updateDriveAxis();
                    continue;
                }
            }

            // Check if touch is on right side (camera/jump area)
            if (!isLeftSide && !this.cameraTouch) {
                this.cameraTouch = touch;
                this.lastCameraPosition = { x: touch.clientX, y: touch.clientY };
                this.cameraTouchStartTime = Date.now();
                this.cameraTouchStartPos = { x: touch.clientX, y: touch.clientY };
                this.isManualCameraControl = true;
                continue;
            }
        }
    }

    private onTouchMove(event: TouchEvent): void {
        // Don't process touch input if controls are disabled
        if (!this.controlsEnabled) return;

        // Leave touches on overlay DOM UI alone — see isInteractiveUiTarget().
        if (MobileControls.isInteractiveUiTarget(event.target)) return;

        // Prevent browser default touch behavior (zoom, scroll) immediately
        event.preventDefault();

        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            if (!touch) continue;

            // Update joystick
            if (this.joystickTouch && touch.identifier === this.joystickTouch.identifier) {
                const deltaX = touch.clientX - this.joystickCenter.x;
                const deltaY = touch.clientY - this.joystickCenter.y;

                if (this.drivingMode) {
                    // Steering slider: horizontal axis only. moveY belongs to the
                    // gas pedal — never write it from the stick in driving mode.
                    const { width, height, knob } = this.steerGeometry();
                    const travel = (width - knob) / 2 - 4;

                    // Follow the finger past full lock: without this, dragging 200px
                    // beyond the end of the pill leaves 200px of dead travel before
                    // steering responds to a reversal. Re-anchoring the centre keeps
                    // the finger exactly `travel` from it, so the instant the finger
                    // moves back the other way the wheel moves with it. The pill
                    // slides along so the knob stays under the thumb.
                    if (Math.abs(deltaX) > travel) {
                        this.joystickCenter.x = touch.clientX - Math.sign(deltaX) * travel;
                        if (this.joystickContainer) {
                            this.joystickContainer.style.left = `${this.joystickCenter.x - width / 2}px`;
                        }
                    }

                    const clampedDeltaX = clampSymmetric(touch.clientX - this.joystickCenter.x, travel);
                    const normalized = clampSymmetric(clampedDeltaX / travel, 1);
                    const scale = this.applyDeadzone(Math.abs(normalized));
                    // Guard the zero case explicitly: Math.sign(-0.05) * 0 is -0.
                    this.moveX = scale === 0 ? 0 : Math.sign(normalized) * scale;
                    if (this.joystickInner) {
                        this.joystickInner.style.left = `${(width - knob) / 2 + clampedDeltaX}px`;
                        this.joystickInner.style.top = `${(height - knob) / 2}px`;
                    }
                    continue;
                }

                const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                const maxDistance = this.joystickSize / 2;

                // Radial deadzone: based on distance from center, not per-axis.
                const scale = this.applyDeadzone(Math.min(distance / maxDistance, 1.0));
                if (scale === 0) {
                    this.moveX = 0;
                    this.moveY = 0;
                } else {
                    // Unit direction (distance > 0 here, since the magnitude cleared the
                    // deadzone), scaled by the remapped magnitude.
                    this.moveX = (deltaX / distance) * scale;
                    this.moveY = -(deltaY / distance) * scale; // Invert Y for forward/backward
                }

                // Update joystick inner position
                if (this.joystickInner) {
                    const percentX = ((clampSymmetric(deltaX, maxDistance) / maxDistance) * 30) + 30;
                    const percentY = ((clampSymmetric(deltaY, maxDistance) / maxDistance) * 30) + 30;
                    this.joystickInner.style.left = `${percentX}%`;
                    this.joystickInner.style.top = `${percentY}%`;
                }
            }

            // Update camera
            if (this.cameraTouch && touch.identifier === this.cameraTouch.identifier) {
                if (this.lastCameraPosition) {
                    this.cameraDeltaX = (touch.clientX - this.lastCameraPosition.x) * this.cameraSensitivity;
                    this.cameraDeltaY = (touch.clientY - this.lastCameraPosition.y) * this.cameraSensitivity;
                    this.lastCameraPosition = { x: touch.clientX, y: touch.clientY };
                }
            }
        }
    }

    private onTouchEnd(event: TouchEvent): void {
        // Don't process touch input if controls are disabled — also skip
        // preventDefault so synthetic `click` events still fire on overlay UI
        // (e.g. the end-screen replay button).
        if (!this.controlsEnabled) return;

        // Same reason while controls ARE enabled: don't swallow taps that land on
        // overlay DOM UI (lobby / appearance-picker buttons) — see
        // isInteractiveUiTarget().
        if (MobileControls.isInteractiveUiTarget(event.target)) return;

        // Prevent browser default touch behavior immediately
        event.preventDefault();

        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            if (!touch) continue;

            // Reset joystick
            if (this.joystickTouch && touch.identifier === this.joystickTouch.identifier) {
                this.joystickTouch = null;
                this.moveX = 0;
                // Driving mode: moveY is the gas pedal's axis — leave it alone.
                if (!this.drivingMode) this.moveY = 0;
                this.resetJoystickVisualPosition();
            }

            // Release the gas / reverse pedals
            if (this.gasTouch && touch.identifier === this.gasTouch.identifier) {
                this.gasTouch = null;
                this.updateDriveAxis();
            }
            if (this.reverseTouch && touch.identifier === this.reverseTouch.identifier) {
                this.reverseTouch = null;
                this.updateDriveAxis();
            }

            // Reset camera
            if (this.cameraTouch && touch.identifier === this.cameraTouch.identifier) {
                // Check if this was a tap (for jump) or a drag (for camera)
                const touchDuration = Date.now() - this.cameraTouchStartTime;
                let touchDistance = Infinity;
                if (this.cameraTouchStartPos) {
                    const dx = touch.clientX - this.cameraTouchStartPos.x;
                    const dy = touch.clientY - this.cameraTouchStartPos.y;
                    touchDistance = Math.sqrt(dx * dx + dy * dy);
                }

                // If it was a quick tap with minimal movement, trigger ascend (legacy
                // jump behavior). Not while driving — a stray tap on the camera area
                // would stab the default brake (Space/ascend) mid-corner.
                if (!this.drivingMode && touchDuration <= this.TAP_MAX_DURATION && touchDistance <= this.TAP_MAX_DISTANCE) {
                    this.flags.ascend = true;
                }

                this.cameraTouch = null;
                this.lastCameraPosition = null;
                this.cameraTouchStartTime = 0;
                this.cameraTouchStartPos = null;
                this.isManualCameraControl = false;
            }
        }
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public update(): void {
        // Always reset camera delta each frame after it's been applied
        // The delta is calculated fresh in onTouchMove
        this.cameraDeltaX = 0;
        this.cameraDeltaY = 0;
    }

    public getAutoFollowEnabled(): boolean {
        return this.autoFollowCamera;
    }

    public getAutoFollowSpeed(): number {
        return this.autoFollowSpeed;
    }

    public setAutoFollowEnabled(enabled: boolean): void {
        this.autoFollowCamera = enabled;
    }

    /**
     * Buttons currently hidden BY THE ENGINE (initially-hidden defaults,
     * setButtonVisible(false) calls). Game code may also hide buttons by
     * writing display/opacity/pointerEvents directly on the element — the
     * engine must never undo those hides, or a hidden button resurrects in
     * flows the game can't see (e.g. the creator's mobile preview re-applying
     * movement-button visibility). setButtonVisible(true) only restores
     * buttons whose hide the engine owns.
     */
    private engineHiddenButtons: Set<string> = new Set();

    /** True when the element's inline styles hide it (any of the three hide channels). */
    private static isButtonStyleHidden(btn: HTMLElement): boolean {
        return btn.style.display === 'none' || btn.style.opacity === '0' || btn.style.pointerEvents === 'none';
    }

    /** Set a button's visibility (opacity + pointer-events). Optionally updates its label. */
    private setButtonVisible(action: string, visible: boolean, text?: string): void {
        const btn = this.getButton(action);
        if (!btn) return;
        if (text !== undefined) renderButtonContent(btn, 'hud-mobile-button', { label: text });
        if (visible) {
            // A hidden button the engine didn't hide was hidden by game code —
            // leave it alone (label update above still applies).
            if (!this.engineHiddenButtons.has(action) && MobileControls.isButtonStyleHidden(btn)) return;
            this.engineHiddenButtons.delete(action);
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
        } else {
            // Claim ownership only if the button isn't already hidden by game
            // code, so a later engine show can't resurrect a game-side hide.
            if (!MobileControls.isButtonStyleHidden(btn)) {
                this.engineHiddenButtons.add(action);
            }
            btn.style.opacity = '0';
            btn.style.pointerEvents = 'none';
        }
        // Visibility feeds the driving ladder's visible-first slot order.
        if (this.drivingMode) this.applyDrivingLayout();
    }

    public showInteractButton(text: string): void {
        // Hide exit button when showing interact button (mutually exclusive)
        this.hideExitButton();
        this.setButtonVisible('interact', true, text);
    }

    public hideInteractButton(): void {
        this.setButtonVisible('interact', false);
    }

    public showExitButton(text: string): void {
        // Hide interact button when showing exit button (mutually exclusive)
        this.hideInteractButton();
        this.setButtonVisible('exit', true, text);
    }

    public hideExitButton(): void {
        this.setButtonVisible('exit', false);
    }

    public resetInteractPressed(): void {
        this.interactPressed = false;
    }

    public resetExitPressed(): void {
        this.flags.exit = false;
    }

    public resetActionPressed(): void {
        this.flags.action = false;
    }

    public resetSecondaryActionPressed(): void {
        this.flags.secondaryAction = false;
    }

    public setActionBehavior(behavior: 'tap' | 'continuous'): void {
        this.buttonBehaviors.set('action', behavior);
        this.flags.actionHeld = false;
    }

    /**
     * Update the primary action button's label based on action type.
     * Label lookup delegates to MobileIconRegistry (text, not emoji) so new action
     * types can be registered without editing this file. The button's color is the
     * theme's `danger` token (its role) and is never overridden here. Unknown types
     * fall back to a neutral 'ACT' label.
     */
    public setActionType(actionType: string | null): void {
        this.applyActionAppearance('action', actionType, 'ACT');
    }

    /**
     * Set just the primary action button's label. Kept for backward compatibility;
     * the optional color args are ignored because mobile buttons now follow the UI
     * theme (the button keeps its `danger` role color).
     */
    public setActionButtonAppearance(icon: string, _baseColor?: string, _pressedColor?: string): void {
        this.showActionButton('action', icon);
    }

    public setSecondaryActionType(actionType: string | null): void {
        this.applyActionAppearance('secondaryAction', actionType, 'ALT');
    }

    /**
     * Shared label/visibility update for the primary/secondary action buttons.
     * Colors are theme-driven via the button's role class \u2014 only the label and
     * visibility change here.
     */
    private applyActionAppearance(
        action: 'action' | 'secondaryAction',
        actionType: string | null,
        fallbackLabel: string,
    ): void {
        if (!actionType) {
            this.setButtonVisible(action, false);
            return;
        }

        const icon = MobileIconRegistry.get(actionType);
        if (icon?.kind === 'url') {
            this.showActionButton(action, actionType.toUpperCase(), icon.value);
        } else {
            this.showActionButton(action, icon?.kind === 'text' ? icon.value : fallbackLabel);
        }
    }

    /**
     * Label + unconditionally show an action button. Unlike setButtonVisible()
     * this deliberately ignores the engine/game hide ownership tracking: naming
     * an action type IS the game asking for the button, so it always appears.
     */
    private showActionButton(action: 'action' | 'secondaryAction', label: string, imageUrl?: string): void {
        const btn = this.getButton(action);
        if (!btn) return;
        renderButtonContent(btn, 'hud-mobile-button', { label, imageUrl, imageOnly: true });
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
        if (this.drivingMode) this.applyDrivingLayout();
    }

    /**
     * Enable or disable mobile controls (touch input)
     */
    public setControlsEnabled(enabled: boolean): void {
        this.controlsEnabled = enabled;

        // Reset all input states when disabling controls
        if (!enabled) {
            this.resetInputState();
            this.joystickTouch = null;
            this.cameraTouch = null;
            this.gasTouch = null;
            this.reverseTouch = null;
            // Both pedal touches are gone — re-derive moveY and drop the press highlight.
            this.updateDriveAxis();
            this.lastCameraPosition = null;
            this.resetJoystickVisualPosition();
        }
    }

    /**
     * Reset every pressed/held flag, movement axis, and camera delta to neutral.
     * Shared by setControlsEnabled() and forceDisable() to prevent stuck inputs.
     * Does NOT touch active touch tracking or joystick visual position.
     */
    private resetInputState(): void {
        this.moveX = 0;
        this.moveY = 0;
        this.cameraDeltaX = 0;
        this.cameraDeltaY = 0;
        for (const flag of BUILTIN_FLAGS) this.flags[flag] = false;
        for (const state of this.customActions.values()) state.pressed = false;
        this.isManualCameraControl = false;
    }

    /**
     * Check if controls are currently enabled
     */
    public getControlsEnabled(): boolean {
        return this.controlsEnabled;
    }

    /**
     * Show or hide mobile controls UI
     */
    public setVisible(visible: boolean): void {
        this.uiVisible = visible;
        this.applyMovementUiVisibility();
        const display = visible ? 'block' : 'none';
        for (const entry of this.buttons.values()) {
            entry.element.style.display = display;
        }
    }

    /**
     * True when the movement controls (joystick + pedals) should be on screen:
     * the UI is visible AND this game actually has a player to move.
     */
    private movementUiVisible(): boolean {
        return this.uiVisible && this.movementControlsAvailable;
    }

    /** Push {@link movementUiVisible} onto the joystick and the driving pedals. */
    private applyMovementUiVisibility(): void {
        const shown = this.movementUiVisible();
        if (this.joystickContainer) {
            this.joystickContainer.style.display = shown ? 'block' : 'none';
        }
        for (const pedal of [this.gasPedal, this.reversePedal]) {
            if (pedal) pedal.style.display = shown ? 'flex' : 'none';
        }
    }

    /**
     * Enable or disable the movement controls (joystick + ascend/descend buttons)
     * independently of overall UI visibility. Disable for games where the player
     * has nothing to move (strategy/board games with `hasPlayerCharacter: false`).
     * Game-specific buttons (action/interact/exit) are unaffected.
     */
    public setMovementControlsAvailable(available: boolean): void {
        if (this.movementControlsAvailable === available) return;
        this.movementControlsAvailable = available;
        this.applyMovementUiVisibility();
        this.applyMovementButtonVisibility();
    }

    /** Apply ascend/descend visibility from the last movement-button params, gated by movementControlsAvailable. */
    private applyMovementButtonVisibility(): void {
        if (!this.lastMovementButtons) {
            // No movement system reported yet — if movement is unavailable, still hide
            // the default-visible ascend/descend buttons.
            if (!this.movementControlsAvailable) {
                this.setButtonVisible('ascend', false);
                this.setButtonVisible('descend', false);
            }
            return;
        }
        const { ascendName, descendName, supportedKeys } = this.lastMovementButtons;
        this.setButtonVisible('ascend', supportedKeys.ascend && this.movementControlsAvailable, ascendName);
        this.setButtonVisible('descend', supportedKeys.descend && this.movementControlsAvailable, descendName);
    }

    /**
     * Update ascend and descend button labels, visibility, and behavior from movement system
     */
    public updateMovementButtons(
        ascendDisplayName: string,
        descendDisplayName: string,
        supportedKeys: { ascend: boolean; descend: boolean },
        keyBehavior: { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }
    ): void {
        this.buttonBehaviors.set('ascend', keyBehavior.ascend);
        this.buttonBehaviors.set('descend', keyBehavior.descend);
        this.lastMovementButtons = { ascendName: ascendDisplayName, descendName: descendDisplayName, supportedKeys };
        this.applyMovementButtonVisibility();
    }

    /**
     * Reset ascend pressed state
     */
    public resetAscendPressed(): void {
        this.flags.ascend = false;
    }

    /**
     * Reset descend pressed state
     */
    public resetDescendPressed(): void {
        this.flags.descend = false;
    }

    /**
     * Force-disable mobile controls from the creator preview.
     * Removes UI and listeners, restoring normal detection behavior.
     * If a {@link MobileControlsDebug} is attached, its mouse/keyboard
     * listeners are torn down first via the registered hook.
     */
    public forceDisable(): void {
        if (this.debugDisableHook) {
            this.debugDisableHook();
        }
        // Reset all button/input states to prevent stuck inputs
        this.resetInputState();
        if (this.enabled) {
            this.dispose();
            this.enabled = false;
        }
    }

    private handleButtonDown(action: string, btn: HTMLButtonElement | null): void {
        if (btn) {
            // Press feedback (scale + brightness filter) lives in CSS under
            // .hud-mobile-button.is-pressed — the brightness shift works against
            // whatever theme color the button's role class applies.
            btn.classList.add('is-pressed');
        }
        // For both tap and continuous: set pressed state immediately on press.
        // Tap buttons: set pressed on down so the game reads it next frame.
        // Continuous buttons: held state set here, released on up.
        this.setButtonState(action, true, false);
    }

    private handleButtonUp(action: string, btn: HTMLButtonElement | null): void {
        if (btn) {
            btn.classList.remove('is-pressed');
        }
        const behavior = this.buttonBehaviors.get(action) || 'tap';
        if (behavior === 'tap') {
            // Tap buttons: re-assert pressed state on release in case handleButtonDown's
            // state was already consumed (resetAscendPressed etc.) before this frame.
            // This ensures the game reads at least one frame of pressed=true.
            this.setButtonState(action, true, true);
        } else {
            // For continuous, release
            this.setButtonState(action, false, false);
        }
    }

    /** Set the pressed/held state for a button action */
    private setButtonState(action: string, value: boolean, isTap: boolean): void {
        // The action button is the only one with two flags: a tap sets the
        // one-shot `action`, a press/release sets the held `actionHeld`.
        if (action === 'action') {
            this.flags[isTap ? 'action' : 'actionHeld'] = value;
            return;
        }
        if (isBuiltinFlag(action)) {
            this.flags[action] = value;
            return;
        }
        // Custom registered action — store in the map
        const custom = this.customActions.get(action);
        if (custom) {
            custom.pressed = value;
        }
    }

    // ─── Dynamic action registration ──────────────────────────────────────
    //
    // The 6 built-in actions (ascend, descend, action, secondaryAction,
    // interact, exit) are always available. Call registerAction() to add
    // your own (e.g. 'reload', 'aim', 'dodge'). The engine will then:
    //   1. Render the button in the mobile UI
    //   2. Track pressed/held state in `customActions`
    //   3. OR-merge the state into PlayerController.keys[action] each frame
    //      (see PlayerController.applyMobileControlsToKeys)
    //
    // Read the state in your game code as `this.keys.<action>` — exactly
    // like the built-in keys. For 'tap' behavior, the flag is auto-reset
    // after the frame it's read.
    //
    // RULE: every desktop keyboard shortcut MUST have a corresponding
    // mobile button. See `control-system.md`.

    /**
     * Register a new mobile button + action slot. Safe to call multiple times
     * with the same action (subsequent calls update the visual / behavior).
     *
     * @param def    Button definition (action name, label, colors, behavior)
     * @param position Optional CSS position / size for the button element.
     *                 If omitted, falls back to the default (bottom-right corner).
     *                 Tip: stack multiple buttons by giving each a unique `bottom` value.
     * @param initiallyHidden If true, the button is created invisible and not
     *                        interactive. Call getButton(action).style.opacity='1'
     *                        and .pointerEvents='auto' to show it (e.g. when near
     *                        an interactable). Matches how 'interact' works.
     */
    public registerAction(
        def: MobileButtonDef,
        position?: MobileButtonPosition,
        initiallyHidden: boolean = false,
    ): void {
        // 1. Register the state slot (creates an entry in customActions)
        const existing = this.customActions.get(def.action);
        if (existing) {
            existing.behavior = def.behavior;
        } else {
            this.customActions.set(def.action, { pressed: false, behavior: def.behavior });
        }
        // 2. Register the position if provided (mutates the BUTTON_POSITIONS map)
        if (position) {
            (MobileControls.BUTTON_POSITIONS as Record<string, MobileButtonPosition>)[def.action] = position;
        }
        // 3. Remove existing button if we're re-registering
        const prev = this.buttons.get(def.action);
        if (prev) {
            prev.element.remove();
            this.buttons.delete(def.action);
            this.buttonBehaviors.delete(def.action);
            this.engineHiddenButtons.delete(def.action);
        }
        // 4. Create the button UI (only if MobileControls is already enabled —
        //    otherwise it'll be created when forceEnable/createDefaultButtons runs
        //    and you'll need to call setButtons or re-register once visible).
        if (this.enabled) {
            this.createButton(def);
            if (initiallyHidden) {
                const btn = this.buttons.get(def.action)?.element;
                if (btn) {
                    btn.style.opacity = '0';
                    btn.style.pointerEvents = 'none';
                }
                if (this.drivingMode) this.applyDrivingLayout();
            }
        }
    }

    /**
     * Check whether a registered action is currently pressed. Works for both
     * built-in and custom actions. Use PlayerController's `keys.<action>`
     * in game code — this is mainly for direct polling or testing.
     */
    public isPressed(action: string): boolean {
        if (isBuiltinFlag(action)) return this.flags[action];
        return this.customActions.get(action)?.pressed ?? false;
    }

    /**
     * Clear a registered action's pressed flag. The engine calls this for
     * 'tap' actions after OR-merging the press into `keys` for one frame.
     * External callers shouldn't normally need this — the engine handles it.
     */
    public resetPressed(action: string): void {
        if (isBuiltinFlag(action)) {
            this.flags[action] = false;
            return;
        }
        const state = this.customActions.get(action);
        if (state) state.pressed = false;
    }

    /**
     * Iterate over every custom action registered via registerAction().
     * Used by PlayerController.applyMobileControlsToKeys() to OR-merge
     * custom button state into `keys`. Returns [action, { pressed, behavior }].
     */
    public customActionEntries(): IterableIterator<[string, { pressed: boolean; behavior: 'tap' | 'continuous' }]> {
        return this.customActions.entries();
    }

    // ── Debug-only surface for MobileControlsDebug (desktop mobile preview) ──
    //
    // The methods below are tagged `@internal` and exist solely so that
    // `MobileControls.debug.ts` can implement mouse-to-touch + WASD emulation
    // without pulling that code into the production hot path.
    // DO NOT call them from game code, templates, or anywhere else — they
    // will not remain stable as the debug sidecar evolves.

    /**
     * @internal — used by MobileControlsDebug during `forceEnable(config)`.
     * Applies the subset of `MobileControlsConfig` that tunes joystick +
     * camera feel. Button definitions go through `_debug_applyButtons`.
     */
    public _debug_applyConfig(config: Partial<MobileControlsConfig>): void {
        if (config.joystickSize !== undefined) this.joystickSize = config.joystickSize;
        if (config.joystickDeadzone !== undefined) this.joystickDeadzone = config.joystickDeadzone;
        if (config.cameraSensitivity !== undefined) this.cameraSensitivity = config.cameraSensitivity;
        if (config.autoFollowCamera !== undefined) this.autoFollowCamera = config.autoFollowCamera;
        if (config.autoFollowSpeed !== undefined) this.autoFollowSpeed = config.autoFollowSpeed;
    }

    /**
     * @internal — used by MobileControlsDebug to realise the UI in creator
     * preview mode when `isMobileDevice()` returned false at construction
     * time. Idempotent: no-op if already enabled.
     */
    public _debug_enableUIIfNeeded(): void {
        if (this.enabled) return;
        this.createUI();
        this.setupEventListeners();
        this.enabled = true;
        // If driving mode was requested before the UI existed (player already in
        // a vehicle when preview mode turned on), realise the driving layout now.
        if (this.drivingMode) {
            this.applyJoystickModeStyles();
            this.resetJoystickVisualPosition();
            this.createGasPedal();
            this.applyDrivingLayout();
        }
        // Match the real-mobile constructor path: start hidden so the joystick
        // and buttons don't render over the loading indicator and Play menu in
        // the creator's desktop mobile-preview. PlayerController.setControlsEnabled(true)
        // reveals them when gameplay begins (Play button), exactly as on device.
        this.setVisible(false);
    }

    /**
     * @internal — used by MobileControlsDebug to apply the caller's custom
     * `MobileButtonDef[]`. Thin wrapper around `setButtons` that lives here
     * so the debug class doesn't need to reach across the public API.
     */
    public _debug_applyButtons(defs: MobileButtonDef[]): void {
        this.setButtons(defs);
    }

    /**
     * @internal — used by MobileControlsDebug to register/clear its
     * tear-down hook so `forceDisable()` can detach mouse+keyboard
     * listeners before disposing the UI.
     */
    public _debug_setDisableHook(hook: (() => void) | null): void {
        this.debugDisableHook = hook;
    }

    /**
     * @internal — true while mobile controls are active AND not suspended.
     * MobileControlsDebug uses this to gate every emulated mouse/key event.
     */
    public _debug_isActive(): boolean {
        return this.enabled && this.controlsEnabled;
    }

    /**
     * @internal — read-only numeric snapshot for MobileControlsDebug's math.
     * Returns just the joystick geometry — no DOM handles, no unrelated
     * camera-sensitivity field.
     */
    public _debug_getJoystickGeometry(): { size: number; deadzone: number } {
        return { size: this.joystickSize, deadzone: this.joystickDeadzone };
    }

    /**
     * @internal — MobileControlsDebug calls this to move the visual knob.
     * `fx` / `fy` are normalized joystick fractions in [-1, 1]. Values
     * outside that range are clamped. Matches the resting convention
     * (knob base at 30%, ±30% travel within the outer ring).
     */
    public _debug_setJoystickKnobFraction(fx: number, fy: number): void {
        if (!this.joystickInner) return;
        this.joystickInner.style.left = `${30 + clampSymmetric(fx, 1) * 30}%`;
        this.joystickInner.style.top = `${30 + clampSymmetric(fy, 1) * 30}%`;
    }

    /**
     * @internal — MobileControlsDebug calls this with raw pixel deltas from
     * a mouse move during a camera drag. MobileControls owns the sensitivity
     * scaling and the manual-control flag.
     */
    public _debug_applyCameraDelta(dxPx: number, dyPx: number): void {
        this.cameraDeltaX = dxPx * this.cameraSensitivity;
        this.cameraDeltaY = dyPx * this.cameraSensitivity;
        this.isManualCameraControl = true;
    }

    /**
     * @internal — MobileControlsDebug calls this when a camera drag begins.
     */
    public _debug_beginCameraDrag(): void {
        this.isManualCameraControl = true;
    }

    /**
     * @internal — MobileControlsDebug calls this when a camera drag ends.
     * When `tap` is supplied (a right-half press+release in the creator
     * preview), a quick click with minimal movement triggers ascend (jump),
     * mirroring the right-side tap-to-jump in {@link onTouchEnd}. The tap
     * thresholds live here so preview and real mobile stay in lockstep.
     */
    public _debug_endCameraDrag(tap?: { durationMs: number; distancePx: number }): void {
        this.isManualCameraControl = false;
        if (tap && tap.durationMs <= this.TAP_MAX_DURATION && tap.distancePx <= this.TAP_MAX_DISTANCE) {
            this.flags.ascend = true;
        }
    }

    /**
     * @internal — the live buttons map keyed by action name.
     * MobileControlsDebug iterates this during mousedown to detect clicks
     * on mobile buttons (more reliable than per-button listeners in
     * iframe contexts).
     */
    public _debug_getButtons(): ReadonlyMap<string, { element: HTMLButtonElement; behavior: 'tap' | 'continuous' }> {
        return this.buttons;
    }

    /**
     * @internal — simulate a press on a mobile button from the debug layer.
     * Runs the same press path the real touch handlers use: visual press
     * feedback + `setButtonState(action, true, false)`.
     */
    public _debug_simulateButtonDown(action: string, btn: HTMLButtonElement): void {
        this.handleButtonDown(action, btn);
    }

    /**
     * @internal — simulate a release on a mobile button from the debug
     * layer. Runs the same release path the real touch handlers use,
     * honouring the tap-vs-continuous behavior registered for the action.
     */
    public _debug_simulateButtonUp(action: string, btn: HTMLButtonElement): void {
        this.handleButtonUp(action, btn);
    }

    /**
     * @internal — MobileControlsDebug calls this on mouse-up to reset the
     * joystick pressed state + visual to its resting configuration (knob
     * centred, container parked at the bottom-left).
     */
    public _debug_endJoystickDrag(): void {
        this.moveX = 0;
        this.moveY = 0;
        this.resetJoystickVisualPosition();
    }

    /** Restore joystick container and knob to their resting positions (bottom-left, knob centered). */
    private resetJoystickVisualPosition(): void {
        if (this.joystickInner) {
            if (this.drivingMode) {
                const { width, height, knob } = this.steerGeometry();
                this.joystickInner.style.left = `${(width - knob) / 2}px`;
                this.joystickInner.style.top = `${(height - knob) / 2}px`;
            } else {
                this.joystickInner.style.left = '30%';
                this.joystickInner.style.top = '30%';
            }
        }
        if (this.joystickContainer) {
            this.joystickContainer.style.left = '30px';
            this.joystickContainer.style.top = 'auto';
            this.joystickContainer.style.bottom = '30px';
        }
    }

    /**
     * @internal — move the joystick container so its centre sits at the
     * given client-space coordinates. Used by the debug layer when a
     * mouse-joystick drag starts to match the real touch-start behavior.
     */
    public _debug_repositionJoystickContainer(centerX: number, centerY: number): void {
        if (!this.joystickContainer) return;
        const halfSize = this.joystickSize / 2;
        this.joystickContainer.style.left = `${centerX - halfSize}px`;
        this.joystickContainer.style.top = `${centerY - halfSize}px`;
        this.joystickContainer.style.bottom = 'auto';
    }

    /**
     * @internal — MobileControlsDebug queries this to suppress mouse/keyboard
     * joystick emulation when the joystick is hidden via `setVisible(false)`.
     * Matches real mobile: no visible joystick → no input.
     */
    public _debug_isJoystickVisible(): boolean {
        return !!this.joystickContainer && this.joystickContainer.style.display !== 'none';
    }

    /** Remove all dynamic buttons from DOM and clear the map */
    private removeAllButtons(): void {
        for (const entry of this.buttons.values()) {
            entry.element.remove();
        }
        this.buttons.clear();
        this.buttonBehaviors.clear();
        this.engineHiddenButtons.clear();
    }

    public dispose(): void {
        this.joystickContainer?.remove();
        this.destroyGasPedal();

        this.removeAllButtons();

        document.removeEventListener('touchstart', this.boundOnTouchStart);
        document.removeEventListener('touchmove', this.boundOnTouchMove);
        document.removeEventListener('touchend', this.boundOnTouchEnd);

        // If a MobileControlsDebug was attached (creator preview), let it
        // tear down its own document-level mouse/keyboard listeners. On real
        // mobile devices the hook is null and this is a no-op.
        if (this.debugDisableHook) {
            this.debugDisableHook();
        }
    }
}
