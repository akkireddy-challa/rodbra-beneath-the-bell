import type { LevelManager } from 'engine/levels/LevelManager.js';

/**
 * Engine-wide active-LevelManager accessor (installed once by GameEngine at
 * loadGame, never from game code — mirrors setEnvironmentObjectSystemEngine).
 *
 * Lives in its own module with a TYPE-ONLY import (erased at runtime) so
 * dependency-trivial modules (e.g. template/EnvObjectRecord.ts) can read the
 * active level without pulling in the LevelManager implementation.
 */

let activeLevelManager: LevelManager | null = null;

/** Installed once by GameEngine at loadGame (null for legacy games). */
export function setActiveLevelManager(lm: LevelManager | null): void {
    activeLevelManager = lm;
}

export function getActiveLevelManager(): LevelManager | null {
    return activeLevelManager;
}

/** Convenience for filtering call sites: null = legacy single-world mode. */
export function getActiveLevelIdOrNull(): string | null {
    return activeLevelManager?.getActiveLevelId() ?? null;
}
