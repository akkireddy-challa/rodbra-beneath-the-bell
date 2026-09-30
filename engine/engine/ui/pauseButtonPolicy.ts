import { isMobileRuntime } from 'engine/isMobileRuntime.js';

/**
 * Whether the engine's touch pause button (`ui/PauseButton.ts`) is on screen for
 * the game currently loaded — the one fact two unrelated places need:
 *
 *   - `GameRuntimeController.ensurePauseButton()`, which creates it;
 *   - `MobileButtonLayout`, which must not hand a game's action button the
 *     top-right slot the pause button sits in.
 *
 * A module-level flag rather than a constructor argument because those two read
 * it at different moments of a load: the layout assigns slots while the genre's
 * game object is being constructed, and the pause button is created later, once
 * that game has a HUD. The load path sets the flag from game data before either
 * runs (`GameRuntimeController.setCurrentGame`), so both see the same answer.
 */
let hiddenByGame = false;

/**
 * Hide or show the engine's touch pause button for the current game. Set from
 * `worldProfileData.hud.pauseButton` on every load, so it does not leak from one
 * game to the next.
 *
 * Hiding it removes the ONLY built-in way a phone reaches the pause card, and
 * with it Resume, the mute toggle and the graphics-quality row — so hide it only
 * in a game that opens the card itself with
 * `getGameStateManager().setPaused(true, 'manual')`.
 */
export function setPauseButtonHidden(hidden: boolean): void {
    hiddenByGame = hidden;
}

/** Whether the pause button is on screen: a touch device, and not hidden by the game. */
export function isPauseButtonShown(): boolean {
    return isMobileRuntime() && !hiddenByGame;
}
