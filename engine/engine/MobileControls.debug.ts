import { MobileControls, type MobileControlsConfig } from 'engine/MobileControls.js';

/**
 * Desktop-preview-only sidecar for {@link MobileControls}.
 *
 * Implements mouse-to-touch emulation (left-half drag = joystick,
 * right-half drag = camera) plus keyboard visual feedback (WASD drives the
 * joystick visual + moveX/moveY; Space/Shift/E/Q/F give press feedback on
 * the matching mobile buttons). Keyboard events are NOT intercepted —
 * DesktopControls still sees them and handles real input processing.
 *
 * This class is ONLY instantiated from the creator mobile-preview path
 * ({@link PlayerController.setMobilePreviewMode}). It must never be loaded
 * on real mobile devices or in published games; it exists purely as a dev
 * affordance for previewing the mobile layout with a mouse + keyboard.
 */
export class MobileControlsDebug {
    private readonly controls: MobileControls;

    /**
     * Restores game-window focus when a preview interaction begins. Needed
     * because this sidecar's capture-phase preventDefault()+stopPropagation()
     * on mousedown blocks both native focus-on-click and GameEngine's container
     * focus-restore handler — without it, `isWindowFocused` stays false after
     * the iframe blurs to the surrounding creator UI and camera input dies.
     */
    private readonly restoreFocus: (() => void) | null;

    private enabled: boolean = false;
    private mouseIsDown: boolean = false;
    private mouseRegion: 'joystick' | 'camera' | null = null;
    private mouseJoystickCenter: { x: number; y: number } | null = null;
    /** Last pointer position during a camera drag — used to compute per-move deltas. */
    private lastMousePos: { x: number; y: number } | null = null;
    /** Camera-region press start (position + time) — used to detect a tap-to-jump on release. */
    private cameraDownPos: { x: number; y: number } | null = null;
    private cameraDownTime: number = 0;
    private activeMouseButton: { action: string; element: HTMLButtonElement } | null = null;
    /**
     * True between a button release handled on pointerup and the compatibility
     * mouseup that may follow it — lets onEmulatedMouseUp swallow that mouseup
     * (preserving the old "button presses never leak to other mouse handlers"
     * contract). Cleared on the next pointerdown because the mouseup never
     * arrives at all when the game preventDefault()ed the pointerdown.
     */
    private justReleasedButton: boolean = false;
    private emulatedKeys: Set<string> = new Set();

    private readonly boundOnPointerDown: (e: PointerEvent) => void;
    private readonly boundOnPointerUp: (e: PointerEvent) => void;
    private readonly boundOnMouseDown: (e: MouseEvent) => void;
    private readonly boundOnMouseMove: (e: MouseEvent) => void;
    private readonly boundOnMouseUp: (e: MouseEvent) => void;
    private readonly boundOnEmulatedKeyDown: (e: KeyboardEvent) => void;
    private readonly boundOnEmulatedKeyUp: (e: KeyboardEvent) => void;

    constructor(controls: MobileControls, restoreFocus?: () => void) {
        this.controls = controls;
        this.restoreFocus = restoreFocus ?? null;
        this.boundOnPointerDown = this.onEmulatedPointerDown.bind(this);
        this.boundOnPointerUp = this.onEmulatedPointerUp.bind(this);
        this.boundOnMouseDown = this.onEmulatedMouseDown.bind(this);
        this.boundOnMouseMove = this.onEmulatedMouseMove.bind(this);
        this.boundOnMouseUp = this.onEmulatedMouseUp.bind(this);
        this.boundOnEmulatedKeyDown = this.onEmulatedKeyDown.bind(this);
        this.boundOnEmulatedKeyUp = this.onEmulatedKeyUp.bind(this);
    }

    /**
     * Force-enable the underlying {@link MobileControls} (bypassing
     * isMobileDevice() detection) and attach mouse+keyboard emulation so a
     * desktop mouse can drive the virtual joystick/buttons and WASD gives
     * visual feedback on the joystick.
     *
     * Safe to call repeatedly — subsequent calls just re-apply config and
     * ensure listeners are attached.
     */
    public forceEnable(config?: Partial<MobileControlsConfig>): void {
        if (config) {
            this.controls._debug_applyConfig(config);
        }
        this.controls._debug_enableUIIfNeeded();
        if (config?.buttons && config.buttons.length > 0) {
            this.controls._debug_applyButtons(config.buttons);
        }
        // Register the tear-down hook so MobileControls.forceDisable() /
        // dispose() can detach our document-level listeners symmetrically.
        this.controls._debug_setDisableHook(() => this.disableMouseEmulation());
        this.enableMouseEmulation();
    }

    /**
     * Detach mouse+keyboard emulation listeners. Used by
     * {@link MobileControls.forceDisable} via a callback so the dispose path
     * stays symmetric with setup.
     */
    public disable(): void {
        this.disableMouseEmulation();
    }

    // ── Mouse+keyboard emulation for desktop mobile preview ──
    //
    // Design: preview must behave exactly like a real mobile device.
    // Mouse = finger. Keyboard shortcuts simulate taps on the DOM button
    // elements — if a button is `display:none` or its containing joystick
    // is hidden, the shortcut does nothing (matching real mobile). This
    // prevents bugs where a game hides a mobile button but the jump/fire
    // works in preview because the keyboard bypassed the UI. Button-mapped
    // keys stopPropagation so DesktopControls does NOT also fire them.

    private enableMouseEmulation(): void {
        if (this.enabled) return;
        this.enabled = true;
        // Button presses are detected on pointer events, not mouse events: a
        // game's own pointerdown handler on a button may call preventDefault(),
        // which suppresses the compatibility mousedown/mouseup entirely —
        // pointer events are the only press signal that always fires.
        document.addEventListener('pointerdown', this.boundOnPointerDown, { capture: true });
        document.addEventListener('pointerup', this.boundOnPointerUp, { capture: true });
        document.addEventListener('pointercancel', this.boundOnPointerUp, { capture: true });
        document.addEventListener('mousedown', this.boundOnMouseDown, { capture: true });
        document.addEventListener('mousemove', this.boundOnMouseMove, { capture: true });
        document.addEventListener('mouseup', this.boundOnMouseUp, { capture: true });
        // Button-mapped keys (Space/Shift/E/Q/F) dispatch to the DOM button
        // and stopPropagation so DesktopControls doesn't also see them —
        // preview behavior must match real mobile (hidden buttons stay inert).
        // WASD still flows through to DesktopControls since the joystick is
        // a drag zone, not a button; WASD emulation is a dev ergonomic only
        // and is suppressed when the joystick is hidden.
        document.addEventListener('keydown', this.boundOnEmulatedKeyDown, { capture: true });
        document.addEventListener('keyup', this.boundOnEmulatedKeyUp, { capture: true });
    }

    private disableMouseEmulation(): void {
        if (!this.enabled) return;
        this.enabled = false;
        this.mouseIsDown = false;
        this.mouseRegion = null;
        this.mouseJoystickCenter = null;
        this.lastMousePos = null;
        this.cameraDownPos = null;
        this.cameraDownTime = 0;
        this.activeMouseButton = null;
        this.justReleasedButton = false;
        this.emulatedKeys.clear();
        this.controls.moveX = 0;
        this.controls.moveY = 0;
        document.removeEventListener('pointerdown', this.boundOnPointerDown, { capture: true });
        document.removeEventListener('pointerup', this.boundOnPointerUp, { capture: true });
        document.removeEventListener('pointercancel', this.boundOnPointerUp, { capture: true });
        document.removeEventListener('mousedown', this.boundOnMouseDown, { capture: true });
        document.removeEventListener('mousemove', this.boundOnMouseMove, { capture: true });
        document.removeEventListener('mouseup', this.boundOnMouseUp, { capture: true });
        document.removeEventListener('keydown', this.boundOnEmulatedKeyDown, { capture: true });
        document.removeEventListener('keyup', this.boundOnEmulatedKeyUp, { capture: true });
    }

    // ── Mouse: simulates touch (left half = joystick, right half = camera) ──
    //
    // Button presses ride on pointer events (onEmulatedPointerDown/Up below);
    // the mouse handlers own the joystick/camera drag regions and swallow the
    // compatibility mouse events of an in-flight button press so other mouse
    // handlers (DesktopControls etc.) never see them.

    private onEmulatedPointerDown(event: PointerEvent): void {
        this.justReleasedButton = false;
        if (!this.controls._debug_isActive()) return;
        // Only emulate for the mouse pointer — real touch input already drives
        // the buttons through MobileControls' own touchstart handlers.
        if (event.pointerType !== 'mouse' || event.button !== 0) return;

        // Detect button presses in capture phase — more reliable than
        // delegating to per-button handlers which may not fire in iframe contexts.
        // Hidden buttons (display:none) naturally don't receive pointer hits,
        // but we also skip explicitly to be defensive.
        //
        // Deliberately NO preventDefault/stopPropagation here: the game may have
        // its own pointerdown handlers on the button (pointer capture, custom
        // press state) and they must keep working. The compatibility mousedown —
        // if the game doesn't cancel it — is swallowed in onEmulatedMouseDown.
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const buttons = this.controls._debug_getButtons();
        for (const [action, entry] of buttons) {
            if (entry.element === target || entry.element.contains(target)) {
                if (!MobileControlsDebug.isElementVisible(entry.element)) return;
                // Re-focus the game window — without it, focus never returns
                // after the iframe blurred to the creator UI and camera input
                // stays gated off by isWindowFocused.
                this.restoreFocus?.();
                this.activeMouseButton = { action, element: entry.element };
                this.controls._debug_simulateButtonDown(action, entry.element);
                return;
            }
        }
    }

    /** Releases an in-flight button press. Registered for pointerup AND pointercancel. */
    private onEmulatedPointerUp(event: PointerEvent): void {
        if (event.pointerType !== 'mouse') return;
        if (event.type === 'pointerup' && event.button !== 0) return;
        // Release fires even if the pointer moved off the button.
        if (this.activeMouseButton) {
            this.controls._debug_simulateButtonUp(this.activeMouseButton.action, this.activeMouseButton.element);
            this.activeMouseButton = null;
            this.justReleasedButton = true;
        }
    }

    private onEmulatedMouseDown(event: MouseEvent): void {
        if (!this.controls._debug_isActive()) return;
        if (event.button !== 0) return;

        // A button press is in flight (handled on pointerdown) — swallow the
        // compatibility mousedown so no other mouse handler double-acts on it.
        if (this.activeMouseButton) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        // Re-focus the game window before we preventDefault/stopPropagation
        // below — otherwise focus never returns after the iframe blurred to the
        // creator UI, leaving camera input gated off by isWindowFocused.
        this.restoreFocus?.();

        const screenWidth = window.innerWidth;
        const isLeftSide = event.clientX < screenWidth / 2;

        // Match real mobile: if the joystick isn't visible, left-half drag
        // does nothing. Camera drag on the right half still works since a
        // real phone's right half is a drag zone regardless of joystick state.
        if (isLeftSide && !this.controls._debug_isJoystickVisible()) return;

        this.mouseIsDown = true;

        if (isLeftSide) {
            // Left half → joystick (like first touch finger)
            this.mouseRegion = 'joystick';
            this.mouseJoystickCenter = { x: event.clientX, y: event.clientY };
            // Move joystick visual to mouse position
            this.controls._debug_repositionJoystickContainer(event.clientX, event.clientY);
        } else {
            // Right half → camera (like second touch finger)
            this.mouseRegion = 'camera';
            this.lastMousePos = { x: event.clientX, y: event.clientY };
            this.cameraDownPos = { x: event.clientX, y: event.clientY };
            this.cameraDownTime = Date.now();
            this.controls._debug_beginCameraDrag();
        }

        event.preventDefault();
        event.stopPropagation();
    }

    private onEmulatedMouseMove(event: MouseEvent): void {
        if (!this.mouseIsDown || !this.controls._debug_isActive()) return;

        if (this.mouseRegion === 'camera') {
            if (this.lastMousePos) {
                const dx = event.clientX - this.lastMousePos.x;
                const dy = event.clientY - this.lastMousePos.y;
                this.controls._debug_applyCameraDelta(dx, dy);
                this.lastMousePos = { x: event.clientX, y: event.clientY };
            }
        } else if (this.mouseRegion === 'joystick' && this.mouseJoystickCenter) {
            const { size, deadzone } = this.controls._debug_getJoystickGeometry();
            // Calculate joystick input from mouse position relative to center
            const deltaX = event.clientX - this.mouseJoystickCenter.x;
            const deltaY = event.clientY - this.mouseJoystickCenter.y;
            const maxDistance = size / 2;
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

            let normalizedX = deltaX / maxDistance;
            let normalizedY = deltaY / maxDistance;
            let normalizedDistance = distance / maxDistance;

            if (distance > maxDistance) {
                normalizedX = deltaX / distance;
                normalizedY = deltaY / distance;
                normalizedDistance = 1.0;
            }

            if (normalizedDistance < deadzone) {
                this.controls.moveX = 0;
                this.controls.moveY = 0;
            } else {
                const remappedDistance = (normalizedDistance - deadzone) / (1.0 - deadzone);
                const scale = Math.min(1.0, remappedDistance);
                const dirX = normalizedX / normalizedDistance;
                const dirY = normalizedY / normalizedDistance;
                this.controls.moveX = dirX * scale;
                this.controls.moveY = -dirY * scale; // Invert Y
            }

            // Update joystick visual — clamp matches pre-refactor behavior
            // (clamp the pre-circle-normalization fractions to [-1, 1]).
            this.controls._debug_setJoystickKnobFraction(normalizedX, normalizedY);
        }

        event.preventDefault();
        event.stopPropagation();
    }

    private onEmulatedMouseUp(event: MouseEvent): void {
        if (event.button !== 0) return;

        // Compatibility mouseup of a button release already handled on
        // pointerup — swallow it, mirroring the mousedown suppression.
        if (this.justReleasedButton) {
            this.justReleasedButton = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (!this.mouseIsDown) return;

        if (this.mouseRegion === 'joystick') {
            // Reset joystick
            this.controls._debug_endJoystickDrag();
            this.mouseJoystickCenter = null;
        } else if (this.mouseRegion === 'camera') {
            // A quick right-half click with minimal movement is a tap → jump,
            // matching real mobile (MobileControls.onTouchEnd).
            const tap = this.cameraDownPos
                ? {
                    durationMs: Date.now() - this.cameraDownTime,
                    distancePx: Math.hypot(event.clientX - this.cameraDownPos.x, event.clientY - this.cameraDownPos.y),
                }
                : undefined;
            this.controls._debug_endCameraDrag(tap);
            this.lastMousePos = null;
            this.cameraDownPos = null;
        }

        this.mouseIsDown = false;
        this.mouseRegion = null;

        event.preventDefault();
        event.stopPropagation();
    }

    // ── Keyboard: dispatch to DOM button (preview matches mobile) ──
    // Button-mapped keys stopPropagation so DesktopControls doesn't also
    // fire them. If the matching mobile button is hidden (display:none),
    // the shortcut is inert — exactly what a real phone would do.
    // WASD is a dev-only joystick ergonomic; it propagates to DesktopControls
    // AND drives the joystick visual, but is gated on joystick visibility.

    private static readonly WASD_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);

    private onEmulatedKeyDown(event: KeyboardEvent): void {
        if (!this.controls._debug_isActive()) return;
        const key = event.code;
        if (this.emulatedKeys.has(key)) return;
        this.emulatedKeys.add(key);
        this.dispatchEmulatedKey(event, key, 'down');
    }

    private onEmulatedKeyUp(event: KeyboardEvent): void {
        if (!this.controls._debug_isActive()) return;
        const key = event.code;
        if (!this.emulatedKeys.has(key)) return;
        this.emulatedKeys.delete(key);
        this.dispatchEmulatedKey(event, key, 'up');
    }

    private dispatchEmulatedKey(event: KeyboardEvent, key: string, phase: 'down' | 'up'): void {
        // WASD: gated on joystick visibility, then propagates to DesktopControls.
        if (MobileControlsDebug.WASD_KEYS.has(key)) {
            if (this.controls._debug_isJoystickVisible()) {
                this.updateJoystickFromKeys();
            }
            return;
        }

        // Button keys: route through the mobile button (visible-only) and
        // block propagation so desktop handlers don't double-trigger.
        const action = MobileControlsDebug.keyToAction(key);
        if (!action) return;
        const btn = this.controls.getButton(action);
        if (!btn || !MobileControlsDebug.isElementVisible(btn)) return;
        if (phase === 'down') {
            this.controls._debug_simulateButtonDown(action, btn);
        } else {
            this.controls._debug_simulateButtonUp(action, btn);
        }
        event.preventDefault();
        event.stopPropagation();
    }

    /**
     * Hidden elements shouldn't receive simulated taps — matches real mobile
     * where a hidden button can't be touched. Buttons are hidden through three
     * inline-style channels: `display:'none'` (engine `setVisible(false)`) and
     * `opacity:'0'` + `pointerEvents:'none'` (engine `setButtonVisible(false)`
     * and game code hiding buttons directly), so all three must be checked —
     * e.g. a game-hidden button can be `display:block` yet fully invisible.
     * Buttons use `position:fixed`, so `offsetParent` is unreliable here.
     */
    private static isElementVisible(el: HTMLElement): boolean {
        if (!el.isConnected) return false;
        return el.style.display !== 'none' && el.style.opacity !== '0' && el.style.pointerEvents !== 'none';
    }

    /** Map keyboard codes to button action names for visual feedback */
    private static keyToAction(key: string): string | null {
        switch (key) {
            case 'Space': return 'ascend';
            case 'ShiftLeft': case 'ShiftRight': return 'descend';
            case 'KeyE': return 'action';
            case 'KeyQ': return 'secondaryAction';
            case 'KeyF': return 'interact';
            default: return null;
        }
    }

    /** Convert currently held WASD keys into joystick moveX/moveY + visual */
    private updateJoystickFromKeys(): void {
        let x = 0;
        let y = 0;
        if (this.emulatedKeys.has('KeyW')) y += 1;
        if (this.emulatedKeys.has('KeyS')) y -= 1;
        if (this.emulatedKeys.has('KeyA')) x -= 1;
        if (this.emulatedKeys.has('KeyD')) x += 1;

        // Normalize diagonal
        if (x !== 0 && y !== 0) {
            const inv = 1 / Math.sqrt(2);
            x *= inv;
            y *= inv;
        }

        // Skip when the mouse is actively dragging the joystick — its
        // moveX/moveY and visual take precedence.
        // Y is inverted for the visual since +y (forward) moves the knob up.
        if (this.mouseRegion === 'joystick') return;
        this.controls.moveX = x;
        this.controls.moveY = y;
        this.controls._debug_setJoystickKnobFraction(x, -y);
    }
}
