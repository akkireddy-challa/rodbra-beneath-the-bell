/**
 * UI Components
 *
 * Screen-space templates (StartScreen, PauseScreen, EndScreen) and
 * world-space widgets (WorldSpaceHealthBar) that game code can mount on
 * top of the engine's HUD.
 */

export { StartScreen, DEFAULT_START_SCREEN_OPTIONS } from 'engine/ui/StartScreen.js';
export type { StartScreenOptions, PlayButtonClickListener } from 'engine/ui/StartScreen.js';

export { PauseScreen, DEFAULT_PAUSE_SCREEN_OPTIONS } from 'engine/ui/PauseScreen.js';
export type { PauseScreenOptions } from 'engine/ui/PauseScreen.js';

export { showEndOverlay, DEFAULT_END_GAME_OPTIONS } from 'engine/ui/EndScreen.js';
export type { EndGameOptions, EndGameOutcome, EndGameStat } from 'engine/ui/EndScreen.js';

export { injectModalCardStyles } from 'engine/ui/modalCard.js';

export { BITMAGIC_URL, getBitmagicLogoUrl } from 'engine/ui/bitmagicBranding.js';

export { isEndScreenComponent } from 'engine/ui/GameUIComponent.js';
export type { UISlot, GameUIComponent, EndScreenComponent } from 'engine/ui/GameUIComponent.js';

export { WorldSpaceHealthBar, type WorldSpaceHealthBarConfig } from 'engine/ui/WorldSpaceHealthBar.js';

export { MuteControl, DEFAULT_MUTE_CONTROL_OPTIONS } from 'engine/ui/MuteControl.js';
export type { MuteControlOptions } from 'engine/ui/MuteControl.js';

export { resolveStartScreenSelections, buildSelectionStepElement, defaultPick } from 'engine/ui/SelectionSteps.js';
export type { SelectionStepSpec, SelectionStepOption, ResolvedSelections } from 'engine/ui/SelectionSteps.js';
