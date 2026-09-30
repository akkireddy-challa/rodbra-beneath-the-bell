/**
 * What the URL asked for when this game was opened.
 *
 * A published game is reached through a link as often as through the portal's
 * Play button, and those links carry intent: race THIS lap, on THIS track. The
 * portal forwards a small allowlist of parameters into the bundle
 * (`portal/src/play-forward-params.ts`) and this is the engine's side of that
 * contract — one reader, so game code, the level resolver and the ghost
 * subsystem cannot disagree about what the link said.
 *
 * ⚠ Values here are UNTRUSTED. They come from a URL anyone can type, so each is
 * shape-checked on the way in and every consumer must still treat a value as a
 * request rather than a fact — an id that names nothing must degrade to normal
 * behaviour, never to a failed load.
 */

/** `?ghost=<entryId>` — a specific recorded run to race against. */
export const GHOST_PARAM = 'ghost';

/** `?track=<levelId>` — the level to start on, normally the one that run was set on. */
export const TRACK_PARAM = 'track';

/**
 * Ids are opaque (Firestore entry ids, authored level ids). Keep the accepted
 * shape tight and URL-safe rather than trying to validate meaning.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface LaunchParams {
    /**
     * Entry id of a run to race, or null.
     *
     * Only meaningful together with the level it was set on: boards are stored
     * one category per level, so an entry id alone cannot be located.
     */
    ghostEntryId: string | null;

    /** Level the link asked to start on, or null for the game's own start level. */
    trackLevelId: string | null;
}

export const NO_LAUNCH_PARAMS: LaunchParams = { ghostEntryId: null, trackLevelId: null };

function read(name: string): string | null {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location.search).get(name);
    return raw && ID_RE.test(raw) ? raw : null;
}

/**
 * Read the launch parameters.
 *
 * Deliberately re-read rather than cached at module load: a game can be started
 * more than once in one document (the Creator reloads games in place), and a
 * value frozen at import would describe the previous load.
 */
export function getLaunchParams(): LaunchParams {
    return {
        ghostEntryId: read(GHOST_PARAM),
        trackLevelId: read(TRACK_PARAM),
    };
}
