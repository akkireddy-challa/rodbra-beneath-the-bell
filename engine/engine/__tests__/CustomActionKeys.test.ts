import { mergeCustomActionKeys, type CustomActionState } from 'engine/CustomActionKeys.js';

/**
 * One PlayerController.update() worth of the custom-action merge, over the
 * actions given as `[name, behavior]` pairs.
 *
 * `press`/`release` write the `pressed` flag exactly as the touch handlers do
 * in MobileControls' customActions map: true from touchstart to touchend for a
 * 'continuous' button, true on press for a 'tap' one until the merge consumes
 * it. `keyboardHeld` holds the actions whose desktop key is down — live
 * alongside the buttons in the creator's mobile preview, never on a phone.
 */
function harness(...defs: Array<[action: string, behavior: CustomActionState['behavior']]>) {
    const actions = new Map<string, CustomActionState>(
        defs.map(([action, behavior]): [string, CustomActionState] => [action, { pressed: false, behavior }]),
    );
    const slot = (action: string): CustomActionState => {
        const state = actions.get(action);
        if (!state) throw new Error(`harness: '${action}' was not declared`);
        return state;
    };
    const keys: Record<string, boolean> = {};
    const held = new Set<string>();
    const keyboardHeld = new Set<string>();
    return {
        /** `PlayerController.keys` */
        keys,
        /** The caller-owned set of continuous actions held via their button. */
        held,
        keyboardHeld,
        press: (action: string): void => { slot(action).pressed = true; },
        release: (action: string): void => { slot(action).pressed = false; },
        /** The raw `pressed` slot, to assert a tap was consumed. */
        isPressed: (action: string): boolean => slot(action).pressed,
        frame: (): void => {
            mergeCustomActionKeys(keys, actions.entries(), held, (action) => keyboardHeld.has(action));
        },
    };
}

describe('continuous custom actions driven by their mobile button', () => {
    it('stays true while held and returns to false on release', () => {
        const h = harness(['thrust', 'continuous']);

        h.frame();
        expect(h.keys.thrust).toBeUndefined();

        // touchstart — held across several frames
        h.press('thrust');
        h.frame();
        expect(h.keys.thrust).toBe(true);
        h.frame();
        expect(h.keys.thrust).toBe(true);

        // touchend. Without the release pass the OR-merge could only ever raise
        // the key, so the action latched true forever after the first press.
        h.release('thrust');
        h.frame();
        expect(h.keys.thrust).toBe(false);
        expect(h.held.size).toBe(0);
    });

    it('lets two opposed hold-buttons alternate instead of both latching true', () => {
        // The symptom that reads as "the controls died": with both keys stuck
        // true, a game that subtracts one from the other nets to zero forever.
        const h = harness(['turnLeft', 'continuous'], ['turnRight', 'continuous']);

        h.press('turnLeft');
        h.frame();
        expect([h.keys.turnLeft, h.keys.turnRight]).toEqual([true, undefined]);

        h.release('turnLeft');
        h.press('turnRight');
        h.frame();
        expect([h.keys.turnLeft, h.keys.turnRight]).toEqual([false, true]);

        h.release('turnRight');
        h.frame();
        expect([h.keys.turnLeft, h.keys.turnRight]).toEqual([false, false]);
    });

    it('releases when MobileControls resets its state (controls disabled mid-hold)', () => {
        const h = harness(['thrust', 'continuous']);
        h.press('thrust');
        h.frame();
        expect(h.keys.thrust).toBe(true);

        // resetInputState() clears every custom slot without a touchend.
        h.release('thrust');
        h.frame();
        expect(h.keys.thrust).toBe(false);
    });
});

describe('custom actions on a keyboard', () => {
    it('never lowers a key the merge did not raise', () => {
        // On desktop the keydown/keyup handlers bound by registerCustomAction
        // own the key; the merge must leave it alone. Same for a key game code
        // sets itself.
        const h = harness(['thrust', 'continuous']);

        h.keys.thrust = true;           // keydown
        h.frame();
        expect(h.keys.thrust).toBe(true);
        h.frame();
        expect(h.keys.thrust).toBe(true);

        h.keys.thrust = false;          // keyup
        h.frame();
        expect(h.keys.thrust).toBe(false);
    });

    it('does not steal a still-held keyboard key when the mobile button comes up', () => {
        // Creator mobile preview runs the touch buttons and the keyboard at once.
        const h = harness(['thrust', 'continuous']);
        h.press('thrust');
        h.frame();
        expect(h.keys.thrust).toBe(true);

        // Player grabs the keyboard key too, then lifts the button.
        h.keyboardHeld.add('thrust');   // keydown handler
        h.keys.thrust = true;
        h.release('thrust');
        h.frame();
        expect(h.keys.thrust).toBe(true);

        h.keyboardHeld.delete('thrust'); // keyup handler
        h.keys.thrust = false;
        h.frame();
        expect(h.keys.thrust).toBe(false);
    });
});

describe('tap custom actions', () => {
    it('is consumed after the one frame it is visible', () => {
        const h = harness(['reload', 'tap']);

        h.press('reload');
        h.frame();
        expect(h.keys.reload).toBe(true);
        expect(h.isPressed('reload')).toBe(false);
        expect(h.held.size).toBe(0);    // taps are never tracked for release

        // Game code reads the tap and clears it; the merge leaves it alone.
        h.keys.reload = false;
        h.frame();
        expect(h.keys.reload).toBe(false);
    });
});
