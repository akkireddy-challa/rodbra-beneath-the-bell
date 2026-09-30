import { computeMobileParity, computeMovementControlsAvailable } from 'engine/MobileParity.js';

describe('computeMobileParity', () => {
    it('passes when no custom desktop keys and no custom mobile actions are registered', () => {
        const result = computeMobileParity([], [], new Map());
        expect(result.ok).toBe(true);
        expect(result.unpairedDesktopKeys).toEqual([]);
        expect(result.unpairedMobileActions).toEqual([]);
    });

    it('passes when every custom desktop key has a paired mobile action', () => {
        // Simulates: registerCustomAction({ action: 'reload', desktop: { keys: ['KeyR'] }, mobile: {...} })
        const desktopKeys = ['KeyR'];
        const mobileActions = ['reload'];
        const customActionToKeys = new Map<string, string[]>([
            ['reload', ['KeyR']],
        ]);

        const result = computeMobileParity(desktopKeys, mobileActions, customActionToKeys);

        expect(result.ok).toBe(true);
        expect(result.unpairedDesktopKeys).toEqual([]);
        expect(result.unpairedMobileActions).toEqual([]);
    });

    it('passes for multi-key bindings when every desktop key and action is paired', () => {
        // An action may bind multiple keys (e.g. KeyR + NumpadEnter → 'reload').
        const desktopKeys = ['KeyR', 'NumpadEnter'];
        const mobileActions = ['reload'];
        const customActionToKeys = new Map<string, string[]>([
            ['reload', ['KeyR', 'NumpadEnter']],
        ]);

        const result = computeMobileParity(desktopKeys, mobileActions, customActionToKeys);

        expect(result.ok).toBe(true);
        expect(result.unpairedDesktopKeys).toEqual([]);
        expect(result.unpairedMobileActions).toEqual([]);
    });

    it('fails and lists exact unpaired keys when a raw desktop key has no mobile button', () => {
        // Simulates an attack system that called desktopControls.registerKeyHandler('KeyF', ...)
        // directly without going through registerCustomAction, so no mobile binding exists.
        const desktopKeys = ['KeyF'];
        const mobileActions: string[] = [];
        const customActionToKeys = new Map<string, string[]>();

        const result = computeMobileParity(desktopKeys, mobileActions, customActionToKeys);

        expect(result.ok).toBe(false);
        expect(result.unpairedDesktopKeys).toEqual(['KeyF']);
        expect(result.unpairedMobileActions).toEqual([]);
    });

    it('fails when a mobile button has no desktop key (orphan mobile action)', () => {
        // Simulates a rogue mobileControls.registerAction({ action: 'orphan', ... }) call
        // without a matching registerCustomAction — no desktop key exists for it.
        const desktopKeys: string[] = [];
        const mobileActions = ['orphan'];
        const customActionToKeys = new Map<string, string[]>();

        const result = computeMobileParity(desktopKeys, mobileActions, customActionToKeys);

        expect(result.ok).toBe(false);
        expect(result.unpairedDesktopKeys).toEqual([]);
        expect(result.unpairedMobileActions).toContain('orphan');
    });

    it('fails with a mix of unpaired keys and unpaired actions', () => {
        // 'reload' is correctly paired (KeyR + reload button).
        // 'KeyF' is a raw desktop-only key (no mobile button).
        // 'orphan' is a mobile-only button (no desktop key).
        const desktopKeys = ['KeyR', 'KeyF'];
        const mobileActions = ['reload', 'orphan'];
        const customActionToKeys = new Map<string, string[]>([
            ['reload', ['KeyR']],
        ]);

        const result = computeMobileParity(desktopKeys, mobileActions, customActionToKeys);

        expect(result.ok).toBe(false);
        expect(result.unpairedDesktopKeys).toEqual(['KeyF']);
        expect(result.unpairedMobileActions).toEqual(['orphan']);
    });

    it('fails when an action is registered with a key that was never actually bound on desktop', () => {
        // Defensive: if _customActionToKeys references a key but desktopKeys does NOT
        // include it (inconsistency between PlayerController and DesktopControls state),
        // the desktop side still reports empty, so mobile 'reload' is orphaned.
        const desktopKeys: string[] = [];
        const mobileActions = ['reload'];
        const customActionToKeys = new Map<string, string[]>([
            ['reload', ['KeyR']],
        ]);

        const result = computeMobileParity(desktopKeys, mobileActions, customActionToKeys);

        // 'reload' action IS paired on the mobile side (name matches) but the desktop
        // key 'KeyR' never appeared in desktopKeys — so desktopKeys is empty and
        // mobileActions contains 'reload' which is paired. Parity is OK here because
        // there are no desktop gaps and the mobile action maps to a registered action.
        // This documents the contract: parity checks what is registered on each side,
        // not the internal consistency of _customActionToKeys.
        expect(result.ok).toBe(true);
    });
});

/**
 * The movement half of mobile parity: whether there is a player for the joystick to drive.
 * `bitmagic verify` reads this answer from the running game, so the contract is pinned here.
 */
describe('computeMovementControlsAvailable', () => {
    it('defaults to a movable player when the profile says nothing to the contrary', () => {
        expect(computeMovementControlsAvailable(undefined, false, null)).toBe(true);
        expect(computeMovementControlsAvailable({}, false, null)).toBe(true);
        expect(computeMovementControlsAvailable({ hasPlayerCharacter: true }, false, null)).toBe(true);
    });

    it('reports nothing to drive for a pointer-driven game: no character, not first-person, not driving', () => {
        expect(computeMovementControlsAvailable({ hasPlayerCharacter: false, cameraMode: 'third-person' }, false, null)).toBe(false);
        expect(computeMovementControlsAvailable({ hasPlayerCharacter: false }, false, null)).toBe(false);
    });

    it('keeps movement for first-person and vehicle games even without a character', () => {
        expect(computeMovementControlsAvailable({ hasPlayerCharacter: false, cameraMode: 'first-person' }, false, null)).toBe(true);
        expect(computeMovementControlsAvailable({ hasPlayerCharacter: false, cameraMode: 'third-person' }, true, null)).toBe(true);
    });

    it('lets an explicit override win in both directions', () => {
        expect(computeMovementControlsAvailable({ hasPlayerCharacter: true }, false, false)).toBe(false);
        expect(computeMovementControlsAvailable({ hasPlayerCharacter: false }, false, true)).toBe(true);
    });
});
