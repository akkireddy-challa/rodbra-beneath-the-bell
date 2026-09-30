/**
 * Shared interface for input control systems (Desktop and Mobile).
 * Both DesktopControls and MobileControls implement this interface,
 * allowing PlayerController to read input from either source uniformly.
 */
export interface IInputControls {
    // Movement (analog -1 to 1 for mobile joystick, digital -1/0/1 for desktop keys)
    moveX: number;
    moveY: number;

    // Button states (one-shot flags, reset after reading)
    ascendPressed: boolean;
    descendPressed: boolean;
    actionPressed: boolean;
    secondaryActionPressed: boolean;
    interactPressed: boolean;
    exitPressed: boolean;

    /**
     * Check if this control system is active.
     * For mobile: true only on mobile devices.
     * For desktop: true only on non-mobile devices.
     */
    isEnabled(): boolean;

    /**
     * Called each frame to update internal state.
     * For mobile: resets camera deltas.
     * For desktop: computes moveX/moveY from key states.
     */
    update(): void;

    /**
     * Clean up event listeners and DOM elements.
     */
    dispose(): void;

    // Reset methods for one-shot button states
    resetActionPressed(): void;
    resetSecondaryActionPressed(): void;
    resetInteractPressed(): void;
    resetAscendPressed(): void;
    resetDescendPressed(): void;
    resetExitPressed(): void;

    /**
     * Temporarily enable/disable input processing.
     * Used for dialogs, menus, editor modes, etc.
     */
    setControlsEnabled(enabled: boolean): void;
    getControlsEnabled(): boolean;
}
