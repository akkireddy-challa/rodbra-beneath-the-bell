/**
 * Wires the play-progress subsystem to the engine's own identity + toast.
 *
 * Lives here rather than inline in GameEngine so the three collaborators
 * (PlayerIdentity, AchievementToast, PlayProgressClient) are bound together in
 * the module that owns them — and so GameEngine stays under its line budget.
 */

import { installPlayProgress } from 'engine/progress/PlaySessionClient.js';
import { getPlayerIdentity } from 'engine/identity/PlayerIdentity.js';
import type { AchievementToast } from 'engine/progress/AchievementToast.js';

/**
 * Install the subsystem once per engine. `configure()` / `startSession()` are
 * driven per game load from GameEngine.loadGame().
 */
export function installEngineProgress(toast: AchievementToast): void {
    installPlayProgress({
        getPlayerToken: () => getPlayerIdentity().getPlayerToken(),
        // The ENGINE renders unlocks, not the genre HUD: `hud` is optional on
        // GenreGameInterface, so routing through it made unlocks invisible in
        // every genre that does not expose one.
        showUnlock: (entry) => toast.show(entry),
        // Signed-out unlocks go through the portal bridge, which owns the browser
        // session id the anonymous XP lane is keyed on.
        reportGuestUnlock: (achievementId) => getPlayerIdentity().reportGuestUnlock(achievementId),
        // And so do signed-out play sessions: the bridge opens and keeps the
        // anonymous session this bundle cannot open itself.
        sendGuestHeartbeat: (beat) => getPlayerIdentity().sendGuestHeartbeat(beat),
    });
}
