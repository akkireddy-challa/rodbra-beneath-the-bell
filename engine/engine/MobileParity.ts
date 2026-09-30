/**
 * Mobile-parity check: ensures every custom desktop key has a matching mobile
 * button and vice versa, so games built for desktop are fully playable on
 * mobile (and orphan mobile buttons don't silently do nothing).
 *
 * Also home to the movement half of that parity — whether the game has a
 * player for the joystick to drive at all (`computeMovementControlsAvailable`).
 *
 * This file has no dependencies — it is a pure helper, so tests can exercise
 * the logic without constructing a full PlayerController.
 */

/** The slice of `worldProfileData` the movement-availability decision reads. */
export interface MovementAvailabilityProfile {
    hasPlayerCharacter?: boolean;
    cameraMode?: string;
}

/**
 * Whether this game has a player for the movement keys and the mobile joystick
 * (+ jump/crouch) to drive.
 *
 * This is the one fact behind a POINTER-DRIVEN game — a board game, a city
 * builder, a top-down strategy game played by tapping the scene. Such a game
 * declares `hasPlayerCharacter: false` in `worldProfileData`; the engine then
 * hides the joystick (nothing to drive), and `bitmagic verify --platform mobile`
 * reads the same answer back through `PlayerController.getMobileMovementControlsAvailable()`
 * to treat a phone run with no touch controls as the declared state rather than
 * as a parity gap. Keep both consumers on this one predicate: a second answer
 * to "is there a player to move" would drift from the first.
 *
 * Auto-detection says false only when the game has no player character AND is
 * not first-person AND the player is not driving a vehicle — first-person and
 * vehicle games move something even without a character. An explicit override
 * (`setMobileMovementControlsAvailable(true|false)`) wins outright; `null`
 * restores auto-detection.
 */
export function computeMovementControlsAvailable(
    profile: MovementAvailabilityProfile | null | undefined,
    driving: boolean,
    override: boolean | null,
): boolean {
    if (override !== null) return override;
    if (!profile || profile.hasPlayerCharacter !== false) return true;
    if (profile.cameraMode === 'first-person') return true;
    return driving;
}

/** Result of a mobile-parity check: desktop custom keys vs. mobile custom actions. */
export interface MobileParityResult {
    ok: boolean;
    /** Desktop custom keys that have no paired mobile action. */
    unpairedDesktopKeys: string[];
    /** Mobile custom actions that have no paired desktop key. */
    unpairedMobileActions: string[];
}

/**
 * Pure helper that computes mobile-parity given the raw data.
 *
 * A desktop key is "paired" iff at least one registered custom action
 * references it AND that action has a mobile button. This direction is strict —
 * a desktop-only capability strands mobile players and is always a gap.
 *
 * A mobile action is "paired" iff at least one registered custom action has that
 * name. It is deliberately NOT required to have a desktop key: an action
 * registered with an empty key list is a mobile-only action
 * (`PlayerController.registerCustomAction` allows this and warns), and reporting
 * it here would turn an intentional choice into a permanent parity error. Do not
 * "fix" this asymmetry by also requiring a desktop key — mobile-only actions
 * depend on it.
 */
export function computeMobileParity(
    desktopKeys: Iterable<string>,
    mobileActions: Iterable<string>,
    customActionToKeys: Iterable<[string, string[]]>,
): MobileParityResult {
    const desktopKeySet = new Set(desktopKeys);
    const mobileActionSet = new Set(mobileActions);

    const pairedKeys = new Set<string>();
    const pairedActions = new Set<string>();
    for (const [action, keys] of customActionToKeys) {
        if (mobileActionSet.has(action)) pairedActions.add(action);
        for (const k of keys) if (desktopKeySet.has(k)) pairedKeys.add(k);
    }

    const unpairedDesktopKeys = [...desktopKeySet].filter((k) => !pairedKeys.has(k));
    const unpairedMobileActions = [...mobileActionSet].filter((a) => !pairedActions.has(a));

    return {
        ok: unpairedDesktopKeys.length === 0 && unpairedMobileActions.length === 0,
        unpairedDesktopKeys,
        unpairedMobileActions,
    };
}
