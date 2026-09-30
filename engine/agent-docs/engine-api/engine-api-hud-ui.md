# engine-api-hud-ui

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/Analytics.ts
interface AnalyticsEvent
AnalyticsEvent.eventName: string
AnalyticsEvent.parameters: Record<string, string | number | boolean | undefined>
class Analytics
Analytics.constructor()
Analytics.trackEvent(eventName: string, parameters: Record<string, string | number | boolean | undefined> = {}): void
Analytics.trackPlayButtonClick(gameGenre?: string, gameId?: string, gameTitle?: string): void
Analytics.trackCreationPromptSubmitted(gameId?: string): void
function getAnalytics(): Analytics

## engine/ConsolePanel.ts
class ConsolePanel — Console panel UI component that shows captured warnings and errors.
ConsolePanel.constructor()
ConsolePanel.dispose(): void

## engine/FadeOverlay.ts
class FadeOverlay
FadeOverlay.constructor()
FadeOverlay.fadeOut(): Promise<void>
FadeOverlay.fadeIn(): Promise<void>
FadeOverlay.setProgress(fraction: number | null, label?: string): void
FadeOverlay.setBusy(busy: boolean): void
FadeOverlay.dispose(): void

## engine/GameHUD.ts
class GameHUD implements IGameHUD — GameHUD — token-driven, class-based implementation of IGameHUD.
GameHUD.constructor()
GameHUD.setTheme(theme: ThemeTokens): void
GameHUD.getTheme(): ThemeTokens | null
GameHUD.getElement(id: string): HUDElement | undefined
GameHUD.showElement(id: string): void
GameHUD.hideElement(id: string): void
GameHUD.removeElement(id: string): void
GameHUD.createProgressBar(id: string, options: ProgressBarOptions = {}): void
GameHUD.updateProgressBar(id: string, current: number, max?: number): void
GameHUD.createCounter(id: string, options: CounterOptions = {}): void
GameHUD.updateCounter(id: string, value: number): void
GameHUD.createIconText(id: string, options: IconTextOptions = {}): void
GameHUD.updateIconText(id: string, options: { icon?: string; text?: string }): void
GameHUD.createTimer(id: string, options: TimerOptions = {}): void
GameHUD.startTimer(id: string): void
GameHUD.pauseTimer(id: string): void
GameHUD.resetTimer(id: string, seconds?: number): void
GameHUD.createCustomElement(id: string, options: CustomElementOptions): void
GameHUD.updateCustomElement(id: string, value: unknown): void
GameHUD.createActionRow(id: string, options: HUDActionRowOptions): void
GameHUD.updateActionControl(rowId: string, controlId: string, update: HUDActionControlUpdate): void
GameHUD.setActionRowVisible(rowId: string, visible: boolean): void
GameHUD.removeActionRow(rowId: string): void
GameHUD.getActionControlValue(rowId: string, controlId: string): string | null
GameHUD.setPlayerController(playerController: PlayerController): void
GameHUD.updateHealth(current: number, max: number): void
GameHUD.showHealth(options?: { width?: number }): void
GameHUD.hideHealth(): void
GameHUD.isHealthEnabled(): boolean
GameHUD.toggleControls(): void
GameHUD.showControlsTemporarily(): void
GameHUD.showControlsPermanently(): void
GameHUD.hideControls(): void
GameHUD.setControlsGuideEnabled(enabled: boolean): void
GameHUD.setCustomControls(controls: ControlEntry[]): void
GameHUD.clearCustomControls(): void
GameHUD.updateControlsDisplay(): void
GameHUD.setFreeMouseMode(enabled: boolean): void
GameHUD.setGameplayUIVisible(visible: boolean): void
GameHUD.showReticle(): void
GameHUD.hideReticle(): void
GameHUD.setReticleOffset(offsetPercent: number): void
GameHUD.setReticleVerticalOffset(offsetPercent: number): void
GameHUD.setReticleBlocked(blocked: boolean): void
GameHUD.setReticleSpread(spread: number): void
GameHUD.spawnComicBubble(): void
GameHUD.showToast(message: string, options?: ToastOptions): void
GameHUD.setMouseUnlockCallback(callback: MouseUnlockCallback): void
GameHUD.hasInteractiveElements(): boolean
GameHUD.requestMouseUnlock(elementId: string): void
GameHUD.requestMouseLock(elementId: string): void
GameHUD.setupMuteControl(engine: EngineLike, gameData: GameData | null): void
GameHUD.getMuteControl(): MuteControl | null
GameHUD.removeMuteControl(): void
GameHUD.getScale(): Readonly<HUDScaleFactors>
GameHUD.snapshotForRecording(): void
GameHUD.show(): void
GameHUD.hide(): void
GameHUD.dispose(): void

## engine/IGameHUD.ts
interface ControlEntry — A single control entry for the controls display.
ControlEntry.key: string
ControlEntry.action: string
const HUD_ANCHORS = [ 'top-left', 'top-center', 'top-right', 'middle-left', 'mid
type HUDAnchor = typeof HUD_ANCHORS[number]
type HUDElementType = 'progress' | 'counter' | 'icon-text' | 'timer' | 'custom'
interface HUDElement — Represents a registered HUD element with its type, container, and lifecycle methods.
HUDElement.id: string
HUDElement.type: HUDElementType
HUDElement.container: HTMLDivElement
HUDElement.anchor: HUDAnchor
HUDElement.update: (value: unknown) => void
HUDElement.dispose: () => void
HUDElement.interactive?: boolean
interface ProgressBarOptions — Options for creating a progress bar element.
ProgressBarOptions.anchor?: HUDAnchor
ProgressBarOptions.label?: string
ProgressBarOptions.color?: string
ProgressBarOptions.width?: number
ProgressBarOptions.showText?: boolean
ProgressBarOptions.initialValue?: number
ProgressBarOptions.maxValue?: number
ProgressBarOptions.format?: (current: number, max: number) => string
interface CounterOptions — Options for creating a counter element.
CounterOptions.anchor?: HUDAnchor
CounterOptions.label?: string
CounterOptions.icon?: string
CounterOptions.initialValue?: number
CounterOptions.format?: (value: number) => string
interface IconTextOptions — Options for creating an icon+text element.
IconTextOptions.anchor?: HUDAnchor
IconTextOptions.icon?: string
IconTextOptions.text?: string
IconTextOptions.iconSize?: number
interface TimerOptions — Options for creating a timer element.
TimerOptions.anchor?: HUDAnchor
TimerOptions.label?: string
TimerOptions.countDown?: boolean
TimerOptions.startSeconds?: number
TimerOptions.format?: 'mm:ss' | 'hh:mm:ss' | 'seconds'
TimerOptions.onComplete?: () => void
type ToastVariant = 'info' | 'success' | 'warning' | 'error'
interface ToastOptions — Options for `IGameHUD.showToast`.
ToastOptions.duration?: number
ToastOptions.variant?: ToastVariant
ToastOptions.anchor?: HUDAnchor
interface CustomElementOptions — Options for creating a fully custom element.
CustomElementOptions.anchor?: HUDAnchor
CustomElementOptions.html: string
CustomElementOptions.css?: string
CustomElementOptions.onCreate?: (container: HTMLDivElement) => void
CustomElementOptions.onUpdate?: (container: HTMLDivElement, value: unknown) => void
CustomElementOptions.interactive?: boolean
type HUDActionVariant = 'primary' | 'danger' | 'warning' | 'neutral'
type HUDActionControlKind = 'button' | 'text-input'
interface HUDActionControlOptions — A single control inside a managed action row.
HUDActionControlOptions.id: string
HUDActionControlOptions.kind?: HUDActionControlKind
HUDActionControlOptions.label?: string
HUDActionControlOptions.imageUrl?: string
HUDActionControlOptions.imageOnly?: boolean
HUDActionControlOptions.variant?: HUDActionVariant
HUDActionControlOptions.size?: 'normal' | 'large'
HUDActionControlOptions.disabled?: boolean
HUDActionControlOptions.onSelect?: (value: string) => void
HUDActionControlOptions.placeholder?: string
HUDActionControlOptions.value?: string
HUDActionControlOptions.onInput?: (value: string) => void
interface HUDActionRowOptions — Options for `IGameHUD.createActionRow`.
HUDActionRowOptions.anchor?: HUDAnchor
HUDActionRowOptions.controls: HUDActionControlOptions[]
HUDActionRowOptions.layout?: 'row' | 'column'
HUDActionRowOptions.wrap?: boolean
HUDActionRowOptions.interactive?: boolean
HUDActionRowOptions.label?: string
interface HUDActionControlUpdate — Mutations accepted by `IGameHUD.updateActionControl`. Omitted fields are
HUDActionControlUpdate.label?: string
HUDActionControlUpdate.imageUrl?: string | null
HUDActionControlUpdate.imageOnly?: boolean
HUDActionControlUpdate.variant?: HUDActionVariant
HUDActionControlUpdate.disabled?: boolean
HUDActionControlUpdate.visible?: boolean
HUDActionControlUpdate.value?: string
type MouseUnlockCallback = (unlock: boolean) => void
interface HUDScaleFactors — Responsive scale factors for HUD element sizing.
HUDScaleFactors.fontXs: number
HUDScaleFactors.fontSm: number
HUDScaleFactors.fontMd: number
HUDScaleFactors.fontLg: number
HUDScaleFactors.fontXl: number
HUDScaleFactors.font2xl: number
HUDScaleFactors.font3xl: number
HUDScaleFactors.font4xl: number
HUDScaleFactors.paddingSm: number
HUDScaleFactors.paddingMd: number
HUDScaleFactors.paddingLg: number
HUDScaleFactors.gap: number
HUDScaleFactors.margin: number
HUDScaleFactors.barWidth: number
HUDScaleFactors.barHeight: number
HUDScaleFactors.iconSize: number
HUDScaleFactors.borderRadius: number
HUDScaleFactors.borderWidth: number
interface IGameHUD — Interface for the game HUD system.
IGameHUD.getElement(id: string): HUDElement | undefined
IGameHUD.showElement(id: string): void
IGameHUD.hideElement(id: string): void
IGameHUD.removeElement(id: string): void
IGameHUD.snapshotForRecording?(): void
IGameHUD.createCounter(id: string, options?: CounterOptions): void
IGameHUD.updateCounter(id: string, value: number): void
IGameHUD.createProgressBar(id: string, options?: ProgressBarOptions): void
IGameHUD.updateProgressBar(id: string, current: number, max?: number): void
IGameHUD.createIconText(id: string, options?: IconTextOptions): void
IGameHUD.updateIconText(id: string, options: { icon?: string; text?: string }): void
IGameHUD.createTimer(id: string, options?: TimerOptions): void
IGameHUD.startTimer(id: string): void
IGameHUD.pauseTimer(id: string): void
IGameHUD.resetTimer(id: string, seconds?: number): void
IGameHUD.createCustomElement(id: string, options: CustomElementOptions): void
IGameHUD.updateCustomElement(id: string, value: unknown): void
IGameHUD.createActionRow?(id: string, options: HUDActionRowOptions): void
IGameHUD.updateActionControl?(rowId: string, controlId: string, update: HUDActionControlUpdate): void
IGameHUD.setActionRowVisible?(rowId: string, visible: boolean): void
IGameHUD.removeActionRow?(rowId: string): void
IGameHUD.getActionControlValue?(rowId: string, controlId: string): string | null
IGameHUD.showReticle(): void
IGameHUD.hideReticle(): void
IGameHUD.setReticleOffset(offsetPercent: number): void
IGameHUD.setReticleVerticalOffset(offsetPercent: number): void
IGameHUD.setReticleBlocked(blocked: boolean): void
IGameHUD.setReticleSpread(spread: number): void
IGameHUD.spawnComicBubble(): void
IGameHUD.showToast(message: string, options?: ToastOptions): void
IGameHUD.updateHealth(current: number, max: number): void
IGameHUD.showHealth(options?: { width?: number }): void
IGameHUD.hideHealth(): void
IGameHUD.isHealthEnabled(): boolean
IGameHUD.showControlsTemporarily(): void
IGameHUD.showControlsPermanently(): void
IGameHUD.hideControls(): void
IGameHUD.toggleControls(): void
IGameHUD.updateControlsDisplay(): void
IGameHUD.setControlsGuideEnabled(enabled: boolean): void
IGameHUD.setCustomControls(controls: ControlEntry[]): void
IGameHUD.clearCustomControls(): void
IGameHUD.setMouseUnlockCallback(callback: MouseUnlockCallback): void
IGameHUD.hasInteractiveElements(): boolean
IGameHUD.requestMouseUnlock(elementId: string): void
IGameHUD.requestMouseLock(elementId: string): void
IGameHUD.setupMuteControl?(engine: import('types/game.js').EngineLike, gameData: import('types/game.js').GameData | null): void
IGameHUD.removeMuteControl(): void
IGameHUD.getScale(): Readonly<HUDScaleFactors>
IGameHUD.show(): void
IGameHUD.hide(): void
IGameHUD.dispose(): void
IGameHUD.setGameplayUIVisible(visible: boolean): void
IGameHUD.setFreeMouseMode?(enabled: boolean): void
IGameHUD.setTheme(theme: import('engine/hud/ThemeTokens.js').ThemeTokens): void
IGameHUD.getTheme(): import('engine/hud/ThemeTokens.js').ThemeTokens | null

## engine/InGameNotification.ts
class InGameNotification — In-game notification system for displaying messages to players.
InGameNotification.constructor()
InGameNotification.show(message: string, durationMs: number = 3000): void
InGameNotification.hide(): void
InGameNotification.dispose(): void

## engine/InteractionPromptUI.ts
interface InteractionPromptUIOptions
InteractionPromptUIOptions.getCamera: () => THREE.PerspectiveCamera | null
InteractionPromptUIOptions.mobileControls: MobileControls
InteractionPromptUIOptions.getInputLabel: () => string
InteractionPromptUIOptions.onMobileTap: () => void
class InteractionPromptUI
InteractionPromptUI.constructor(opts: InteractionPromptUIOptions)
InteractionPromptUI.show(displayName: string, worldPosition?: THREE.Vector3, actionable: boolean = true, worldYOffset: number = InteractionPromptUI.DEFAULT_WORLD_Y_OFFSET): void
InteractionPromptUI.hide(): void
InteractionPromptUI.updateScreenPosition(): void
InteractionPromptUI.dispose(): void

## engine/PokiIntegration.ts
type CameraGetter = () => THREE.Camera | null
class PokiIntegration
PokiIntegration.constructor()
PokiIntegration.setCameraGetter(getter: CameraGetter): void
PokiIntegration.init(): Promise<void>
PokiIntegration.beforePlaying(resume: () => void): void
PokiIntegration.createStateListener(): GameStateChangeListener

## engine/ScreenshotService.ts
type CameraSpec = | TopdownSpec | IsometricSpec | OrbitSpec | { kind: 'custom'; camera: THREE.Camera }
interface ScreenshotUploadOptions
ScreenshotUploadOptions.filename: string | null
ScreenshotUploadOptions.camera: CameraSpec | null
ScreenshotUploadOptions.width: number | null
ScreenshotUploadOptions.height: number | null
const DEFAULT_SCREENSHOT_UPLOAD_OPTIONS: ScreenshotUploadOptions
interface ScreenshotUploadResult
ScreenshotUploadResult.url: string
ScreenshotUploadResult.key: string
function resolveOutputSize(opts: ScreenshotUploadOptions, canvasSize: { x: number; y: number }, worldAspect: number | null): { width: number; height: number }
class ScreenshotService
static ScreenshotService.getInstance(): ScreenshotService
ScreenshotService.configure(engine: GameEngine, gameId: string): void
ScreenshotService.captureAndUpload(opts?: Partial<ScreenshotUploadOptions>): Promise<ScreenshotUploadResult>
ScreenshotService.capture(opts?: Partial<ScreenshotUploadOptions>): Promise<Blob>
ScreenshotService.upload(blob: Blob, filename: string | null): Promise<ScreenshotUploadResult>

## engine/SplatExportGlbOverlay.ts
interface SplatExportGlbOverlay
SplatExportGlbOverlay.instanceCount: number
SplatExportGlbOverlay.typeCount: number
SplatExportGlbOverlay.restore: () => void
function buildSplatExportGlbOverlay(scene: THREE.Scene, gameData: GameData | null, envSystem: EnvironmentObjectSystem | null): Promise<SplatExportGlbOverlay>

## engine/TextureTextWriter.ts
interface TextureQuadPoint — Draw player-supplied text (names, jersey numbers, decals) into an arbitrary
TextureQuadPoint.x: number
TextureQuadPoint.y: number
interface TextureTextQuad
TextureTextQuad.topLeft: TextureQuadPoint
TextureTextQuad.topRight: TextureQuadPoint
TextureTextQuad.bottomRight: TextureQuadPoint
TextureTextQuad.bottomLeft: TextureQuadPoint
interface TextureTextStyle
TextureTextStyle.fontColor?: string
TextureTextStyle.backgroundColor?: string | null
TextureTextStyle.fontFamily?: string
TextureTextStyle.fontWeight?: string
TextureTextStyle.paddingFraction?: number
function writeTextInTextureQuad(canvas: HTMLCanvasElement, quad: TextureTextQuad, text: string, style?: TextureTextStyle): void
function fillTextureQuad(canvas: HTMLCanvasElement, quad: TextureTextQuad, color: string): void
interface TextureTextEdit
TextureTextEdit.quad: TextureTextQuad
TextureTextEdit.text: string
TextureTextEdit.style?: TextureTextStyle
function createTextEditedTexture(baseTexture: THREE.Texture, edits: TextureTextEdit[]): THREE.CanvasTexture

## engine/VideoPlayer.ts
interface VideoPlayOptions — Options for {@link VideoPlayer.play}; every field falls back to an engine default.
VideoPlayOptions.skippable?: boolean
VideoPlayOptions.fadeIn?: number
VideoPlayOptions.fadeOut?: number
class VideoPlayer — Handles fullscreen video overlay playback for cutscenes.
VideoPlayer.play(videoUrl: string, options?: VideoPlayOptions): Promise<void>
VideoPlayer.dispose(): void
