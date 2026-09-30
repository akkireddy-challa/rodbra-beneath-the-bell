# engine-api-ui

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/ui/EndScreen.ts
type EndGameOutcome = 'win' | 'lose' | 'draw' | 'neutral'
interface EndGameStat
EndGameStat.label: string
EndGameStat.value: string | number
interface EndGameOptions
EndGameOptions.outcome: EndGameOutcome
EndGameOptions.title: string
EndGameOptions.message: string | null
EndGameOptions.stats: EndGameStat[]
EndGameOptions.replayLabel: string
const DEFAULT_END_GAME_OPTIONS: EndGameOptions
function showEndOverlay(hud: IGameHUD, opts: EndGameOptions): void

## engine/ui/GameUIComponent.ts
type UISlot = 'start' | 'pause' | 'end'
interface GameUIComponent — Marker interface for any UI component installed in a slot. The runtime
GameUIComponent.dispose?(): void
interface EndScreenComponent — End-slot contract. Called instead of the default `showEndOverlay` when an
EndScreenComponent.render(hud: IGameHUD, opts: EndGameOptions): void
function isEndScreenComponent(value: GameUIComponent | null): value is EndScreenComponent

## engine/ui/MuteControl.ts
interface MuteControlOptions — Options for MuteControl.
MuteControlOptions.anchor: HUDAnchor
const DEFAULT_MUTE_CONTROL_OPTIONS: MuteControlOptions
class MuteControl — MuteControl — opt-in HUD mute button.
MuteControl.constructor(hud: IGameHUD, engine: EngineLike, _gameData: GameData | null, options: MuteControlOptions = DEFAULT_MUTE_CONTROL_OPTIONS)
MuteControl.toggle(): void
MuteControl.getMuted(): boolean
MuteControl.setMuted(muted: boolean): void
MuteControl.dispose(): void

## engine/ui/PauseButton.ts
class PauseButton
PauseButton.constructor(private readonly hud: IGameHUD, private readonly onPause: () => void)
PauseButton.dispose(): void

## engine/ui/PauseScreen.ts
interface PauseScreenOptions
PauseScreenOptions.pausedLabel: string
PauseScreenOptions.resumeLabel: string
const DEFAULT_PAUSE_SCREEN_OPTIONS: PauseScreenOptions
class PauseScreen
PauseScreen.constructor(params: { gameStateManager: GameStateManager; getHud: () => IGameHUD | null; onResume: () => void; // Resolved lazily at mount time: the PauseScreen is constructed during // `resetForLoad` (before `attachEngine`), so capturing the engine by // value here would freeze it to the null it was at construction. getEngine?: () => EngineLike | null; options?: Partial<PauseScreenOptions>; })
PauseScreen.attachListener(): void
PauseScreen.refresh(): void
PauseScreen.dispose(): void

## engine/ui/QualityControl.ts
function qualityControlHtml(): string
function qualityNote(pending: PendingQualityChange[]): string
function wireQualityControl(container: HTMLElement, getEngine: () => GameEngine | null): void

## engine/ui/SelectionSteps.ts
interface SelectionStepOption
SelectionStepOption.id: string
SelectionStepOption.label: string
SelectionStepOption.imageUrl?: string
interface SelectionResolution — How a presented step resolved. `userPicked` distinguishes a real tap from a
SelectionResolution.optionId: string
SelectionResolution.userPicked: boolean
interface SelectionStepSpec — A validated, presentable selection step (always ≥ 2 options).
SelectionStepSpec.id: string
SelectionStepSpec.kind: 'level' | 'choice'
SelectionStepSpec.title: string
SelectionStepSpec.options: SelectionStepOption[]
interface ResolvedSelections
ResolvedSelections.levelStep: SelectionStepSpec | null
ResolvedSelections.choiceSteps: SelectionStepSpec[]
function resolveStartScreenSelections(gameData: GameData | null | undefined): ResolvedSelections
function defaultPick(step: SelectionStepSpec): string
function buildSelectionStepElement(step: SelectionStepSpec, onPick: (optionId: string) => void): HTMLElement

## engine/ui/StartScreen.ts
type PlayButtonClickListener = () => void
interface StartScreenOptions
StartScreenOptions.title: string
StartScreenOptions.imageUrl: string | null
StartScreenOptions.playLabel: string
StartScreenOptions.hideTitle: boolean
StartScreenOptions.cardPlacement: 'center' | 'start' | 'end'
const DEFAULT_START_SCREEN_OPTIONS: StartScreenOptions
class StartScreen
StartScreen.constructor(container: HTMLElement, gameStateManager: GameStateManager, options?: Partial<StartScreenOptions>)
StartScreen.show(): void
StartScreen.hide(): void
StartScreen.addPlayClickListener(listener: PlayButtonClickListener): void
StartScreen.removePlayClickListener(listener: PlayButtonClickListener): void
StartScreen.presentSelection(step: SelectionStepSpec): Promise<SelectionResolution | null>
StartScreen.cancelActiveSelection(): void
StartScreen.showLoadingIndicator(): void
StartScreen.hideLoadingIndicator(): void
StartScreen.setPlayButtonVisible(visible: boolean): void
StartScreen.setStartupUiMode(mode: StartupUiMode): void
StartScreen.updateLoadingMessage(message: string): void
StartScreen.dispose(): void

## engine/ui/VoiceIndicator.ts
interface VoiceIndicatorOptions — Options for VoiceIndicator.
VoiceIndicatorOptions.anchor: HUDAnchor
const DEFAULT_VOICE_INDICATOR_OPTIONS: VoiceIndicatorOptions
class VoiceIndicator — VoiceIndicator — recording-state HUD element for voice input.
VoiceIndicator.constructor(voiceInput: VoiceInput, hud: IGameHUD | null, container: HTMLElement, options: VoiceIndicatorOptions = DEFAULT_VOICE_INDICATOR_OPTIONS)
VoiceIndicator.dispose(): void

## engine/ui/WorldSpaceHealthBar.ts
interface WorldSpaceHealthBarConfig — Configuration for WorldSpaceHealthBar
WorldSpaceHealthBarConfig.target: THREE.Object3D
WorldSpaceHealthBarConfig.getHealth: () => number
WorldSpaceHealthBarConfig.getMaxHealth: () => number
WorldSpaceHealthBarConfig.offset?: THREE.Vector3
WorldSpaceHealthBarConfig.width?: number
WorldSpaceHealthBarConfig.height?: number
WorldSpaceHealthBarConfig.backgroundColor?: string
WorldSpaceHealthBarConfig.borderColor?: string
WorldSpaceHealthBarConfig.healthyColor?: string
WorldSpaceHealthBarConfig.warningColor?: string
WorldSpaceHealthBarConfig.criticalColor?: string
WorldSpaceHealthBarConfig.warningThreshold?: number
WorldSpaceHealthBarConfig.criticalThreshold?: number
WorldSpaceHealthBarConfig.hideWhenFull?: boolean
WorldSpaceHealthBarConfig.alwaysVisible?: boolean
WorldSpaceHealthBarConfig.onHealthChanged?: (currentHealth: number, maxHealth: number, previousHealth: number) => void
class WorldSpaceHealthBar
WorldSpaceHealthBar.constructor(engine: EngineLike, config: WorldSpaceHealthBarConfig)
WorldSpaceHealthBar.update(): void
WorldSpaceHealthBar.setVisible(visible: boolean): void
WorldSpaceHealthBar.getVisible(): boolean
WorldSpaceHealthBar.setStyle(style: Partial<Pick<WorldSpaceHealthBarConfig, 'healthyColor' | 'warningColor' | 'criticalColor' | 'warningThreshold' | 'criticalThreshold' | 'hideWhenFull' | 'alwaysVisible' >>): void
WorldSpaceHealthBar.dispose(): void

## engine/ui/bitmagicBranding.ts
const BITMAGIC_URL = 'https://bitmagic.ai/'
function getBitmagicLogoUrl(): string | null

## engine/ui/buttonContent.ts
interface ButtonContent — What a button shows. `label` is always the accessible name, visible or not.
ButtonContent.label?: string
ButtonContent.imageUrl?: string | null
ButtonContent.imageOnly?: boolean
function renderButtonContent(button: HTMLButtonElement, block: string, content: ButtonContent): void

## engine/ui/modalCard.ts
const MODAL_STYLE_ID = 'ui-modal-card-styles'
type ScreenTransitionStyle = 'fade-rise' | 'fade' | 'none'
interface ScreenTransitionOptions
ScreenTransitionOptions.style: ScreenTransitionStyle
ScreenTransitionOptions.enterMs: number
ScreenTransitionOptions.leaveMs: number
const DEFAULT_SCREEN_TRANSITION: ScreenTransitionOptions
function setScreenTransition(options: ScreenTransitionOptions): void
function getScreenTransition(): ScreenTransitionOptions
function screenLeaveDelayMs(): number
class ScreenLeave — One screen's leave animation. `start` marks the overlay so the CSS plays the fade-out,
ScreenLeave.start(overlay: HTMLElement | null, finish: () => void): void
ScreenLeave.cancel(): void
function escapeHtml(value: string): string
function injectModalCardStyles(): void

## engine/ui/pauseButtonPolicy.ts
function setPauseButtonHidden(hidden: boolean): void
function isPauseButtonShown(): boolean

## engine/ui/screenOverlayLayer.ts
const SCREEN_OVERLAY_LAYER_Z_INDEX = 9000
const CUTSCENE_OVERLAY_Z_INDEX = 10010
const SCREEN_OVERLAY_LAYER_CLASS = 'ui-screen-overlay-layer'
const SCREEN_OVERLAY_LAYER_STYLE_ID = 'ui-screen-overlay-layer-styles'
function getScreenOverlayLayer(): HTMLElement
function resetScreenOverlayLayerForTests(): void

## engine/ui/speakerIcons.ts
const speakerOnSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
const speakerOffSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
