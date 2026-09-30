// Centralized detection of whether the game is running inside the Aitopia creator.
// The creator passes ?creatorId=xxx when loading the game iframe.
// Third-party embedders (e.g., Poki) do not set this parameter.

// Guard for non-browser module loading (node-environment unit tests import
// engine modules that transitively reach this file); browsers are unchanged.
const urlParams = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

/** True when running inside the Aitopia creator iframe */
export const isCreatorMode: boolean = urlParams.get('source') === 'creator';

/** True when running as a standalone game (not in creator) — covers both top-level and third-party iframes like Poki */
export const isStandaloneMode: boolean = !isCreatorMode;

/**
 * True when the embedder asked to skip the StartScreen and enter gameplay as soon
 * as the world is loaded and warmed (?autostart=1 — the portal's instant-play path).
 * Honoured on DESKTOP only: on mobile, gameplay start requires fullscreen, and the
 * fullscreen request needs a user gesture INSIDE this frame (activation cannot be
 * delegated cross-origin), so the StartScreen tap remains the start gesture there.
 */
/**
 * True when the Creator loaded this page as a hidden automatic play test after an
 * AI edit (?playtest=1). The page plays itself with no input, reports what it saw
 * to the parent (engine/playtest/PlaytestProbe), and must not touch anything the
 * user owns — engine/playtest/PlaytestGuard cuts it off from storage, network
 * writes, pointer lock and audio. See game/docs/playtest-mode.md.
 */
export const isPlaytestMode: boolean = isStandaloneMode && urlParams.get('playtest') === '1';

export const isAutostartRequested: boolean = isStandaloneMode && (urlParams.get('autostart') === '1' || isPlaytestMode);

/**
 * Safely post a message to the creator parent window.
 * No-ops when not in creator mode.
 */
export function safePostMessageToCreator(message: any): void {
    if (isCreatorMode) {
        try {
            window.parent.postMessage(message, '*');
        } catch (error) {
            console.warn('Failed to send message to creator parent:', error);
        }
    }
}
