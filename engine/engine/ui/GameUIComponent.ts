// Plug-in surface for per-game UI overrides. The default Start / Pause /
// End templates ship with the engine, but a genre or per-game `work/` file
// can replace any slot via `engine.setUIComponent(slot, component)`.

import type { IGameHUD } from 'engine/IGameHUD.js';
import type { EndGameOptions } from 'engine/ui/EndScreen.js';

export type UISlot = 'start' | 'pause' | 'end';

/**
 * Marker interface for any UI component installed in a slot. The runtime
 * calls `dispose()` when the slot is replaced or cleared; other lifecycle
 * methods are defined per-slot below.
 */
export interface GameUIComponent {
    dispose?(): void;
}

/**
 * End-slot contract. Called instead of the default `showEndOverlay` when an
 * override is installed. Receives the same options the engine would have
 * passed to the default overlay.
 */
export interface EndScreenComponent extends GameUIComponent {
    render(hud: IGameHUD, opts: EndGameOptions): void;
}

/**
 * Helper for testing if a slot's component handles end-game rendering.
 */
export function isEndScreenComponent(value: GameUIComponent | null): value is EndScreenComponent {
    return value !== null && typeof (value as EndScreenComponent).render === 'function';
}
