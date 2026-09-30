/**
 * Custom (dynamically registered) action keys — the merge that keeps
 * `PlayerController.keys[<action>]` honest for actions registered via
 * `registerCustomAction()` / `declareMobileActions()`.
 *
 * Built-in keys get their "release clears to false" from the desktop-controls
 * assignment each frame (or, where desktop input is disabled, from
 * `clearBuiltInKeys()`). A custom key gets its release from the keyup handler
 * `registerCustomAction()` binds — which only ever fires for the KEYBOARD.
 * Press a custom action's MOBILE button and nothing clears the key again: the
 * merge only ORs `true` in, and a 'continuous' action is not consumed after a
 * frame the way a 'tap' one is. So the merge tracks which continuous actions it
 * raised from mobile and lowers them itself on release — otherwise a hold-button
 * latches true forever after the first press (a lone button reads as "stuck on",
 * two opposed buttons cancel out and the controls look dead).
 *
 * This file has no dependencies — it is a pure helper, so tests can exercise the
 * press → hold → release cycle without constructing a full PlayerController.
 */

/** The per-action state slot `MobileControls.customActionEntries()` yields. */
export interface CustomActionState {
    pressed: boolean;
    behavior: 'tap' | 'continuous';
}

/**
 * OR-merge each custom action's mobile button state into `keys[<action>]` so
 * game code can read `this.keys.<action>` identically to a built-in key, and
 * release the continuous ones this merge itself raised.
 *
 * @param keys              `PlayerController.keys`, mutated in place.
 * @param entries           `mobileControls.customActionEntries()`.
 * @param mobileHeld        Caller-owned set of continuous actions currently held
 *                          via their mobile button. Persist it across frames —
 *                          it is what distinguishes "mobile let go" from "the
 *                          game or the keyboard set this key".
 * @param isKeyboardHeld    Whether the keyboard key(s) bound to this action are
 *                          down. A mobile release must not steal a key the
 *                          player is still holding on a keyboard (creator mobile
 *                          preview runs both at once); on a real mobile runtime
 *                          desktop controls are disabled and this is always false.
 */
export function mergeCustomActionKeys(
    keys: Record<string, boolean>,
    entries: Iterable<[string, CustomActionState]>,
    mobileHeld: Set<string>,
    isKeyboardHeld: (action: string) => boolean = () => false,
): void {
    for (const [action, state] of entries) {
        if (state.pressed) {
            keys[action] = true;
            if (state.behavior === 'tap') {
                state.pressed = false; // consume tap after one frame
            } else {
                mobileHeld.add(action);
            }
        } else if (mobileHeld.delete(action) && !isKeyboardHeld(action)) {
            // The button came up (or MobileControls reset its state on disable)
            // and no keyboard key is holding the action down.
            keys[action] = false;
        }
    }
}
