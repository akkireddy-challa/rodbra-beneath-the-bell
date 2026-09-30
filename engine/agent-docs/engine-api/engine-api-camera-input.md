# engine-api-camera-input

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/CameraFit.ts
const DEFAULT_FIT_LEVEL_MARGIN = 1.0
function fitHeight(sizeX: number, sizeZ: number, aspect: number, margin: number, fovYDeg: number): number
interface ViewportInsetsPx — Pixel insets reserved on each edge of the viewport (e.g. for UI panels).
ViewportInsetsPx.left: number
ViewportInsetsPx.right: number
ViewportInsetsPx.top: number
ViewportInsetsPx.bottom: number
function computeOrthoFrustumForRegion(sizeX: number, sizeZ: number, viewportWidthPx: number, viewportHeightPx: number, insetsPx: ViewportInsetsPx, margin: number): { left: number; right: number; top: number; bottom: number }

## engine/CameraManager.ts
class CameraManager
CameraManager.constructor(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null, target: THREE.Object3D, domElement: HTMLElement, engine: EngineLike, initialMode: CameraMode = 'third-person')
CameraManager.setMode(mode: CameraMode): void
CameraManager.getMode(): CameraMode
CameraManager.getActiveController(): ICameraController | null
CameraManager.getThirdPersonCamera(): ThirdPersonCamera
CameraManager.getFirstPersonCamera(): FirstPersonCamera
CameraManager.getTopDownCamera(): TopDownCamera
CameraManager.setTarget(target: THREE.Object3D): void
CameraManager.update(deltaTime: number): void
CameraManager.setPointerLocked(locked: boolean): void
CameraManager.setEditorModeCamera(enabled: boolean): void
CameraManager.onModeChange(callback: (mode: CameraMode) => void): void
CameraManager.offModeChange(callback: (mode: CameraMode) => void): void
CameraManager.dispose(): void

## engine/DesktopControls.ts
class DesktopControls implements IInputControls — Desktop keyboard input handling.
DesktopControls.moveX: number
DesktopControls.moveY: number
DesktopControls.ascendPressed: boolean
DesktopControls.descendPressed: boolean
DesktopControls.actionPressed: boolean
DesktopControls.secondaryActionPressed: boolean
DesktopControls.interactPressed: boolean
DesktopControls.exitPressed: boolean
DesktopControls.ctrlPressed: boolean
DesktopControls.disableMouseActions: boolean
DesktopControls.disableKeyboardMovement: boolean
DesktopControls.constructor()
DesktopControls.isEnabled(): boolean
DesktopControls.isAnyKeyDown(codes: string[]): boolean
DesktopControls.update(): void
DesktopControls.dispose(): void
DesktopControls.resetActionPressed(): void
DesktopControls.resetSecondaryActionPressed(): void
DesktopControls.resetInteractPressed(): void
DesktopControls.resetAscendPressed(): void
DesktopControls.resetDescendPressed(): void
DesktopControls.resetExitPressed(): void
DesktopControls.setControlsEnabled(enabled: boolean): void
DesktopControls.getControlsEnabled(): boolean
DesktopControls.setInputGate(gate: () => boolean): void
DesktopControls.registerKeyHandler(keyCode: string, handler: (pressed: boolean) => void, opts: { source: string; pairedWithMobile: boolean } = { source: '(anonymous)', pairedWithMobile: false }): void
DesktopControls.unregisterKeyHandler(keyCode: string): void
DesktopControls.getRegisteredCustomKeys(): string[]
DesktopControls.getUnpairedRawKeys(): Array<{ key: string; source: string }>
DesktopControls.setActionKeys(keys: string[]): void
DesktopControls.setSecondaryActionKeys(keys: string[]): void
DesktopControls.setInteractKeys(keys: string[]): void
DesktopControls.setAscendKeys(keys: string[]): void
DesktopControls.setDescendKeys(keys: string[]): void
static DesktopControls.keyCodeToLabel(code: string): string
DesktopControls.getSecondaryActionKeyLabel(): string
DesktopControls.getInteractKeyLabel(): string
DesktopControls.getActionKeyLabel(): string
DesktopControls.getAscendKeyLabel(): string
DesktopControls.getDescendKeyLabel(): string
DesktopControls.getKeyStates(): { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; descend: boolean; interact: boolean; action: boolean; secondaryAction: boolean; }

## engine/FirstPersonCamera.ts
interface ViewPunchOptions — How a weapon's kick is felt in the view. See applyViewPunch.
ViewPunchOptions.recenter: number
ViewPunchOptions.omega: number
ViewPunchOptions.damping: number
const DEFAULT_VIEW_PUNCH_OPTIONS: ViewPunchOptions
interface ViewPunchTarget — Anything that can receive a weapon's view punch.
ViewPunchTarget.applyViewPunch(pitchRad: number, yawRad: number, options?: ViewPunchOptions): void
class FirstPersonCamera implements ICameraController — First-person camera controller.
FirstPersonCamera.camera: THREE.PerspectiveCamera
FirstPersonCamera.target: THREE.Object3D
FirstPersonCamera.domElement: HTMLElement
FirstPersonCamera.engine: EngineLike
FirstPersonCamera.enabled: boolean
FirstPersonCamera.disableBuiltInTouchControls: boolean
FirstPersonCamera.constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, engine: EngineLike, options?: { eyeHeight?: number; rotationSpeed?: number; headBobEnabled?: boolean; headBobAmplitude?: number; headBobSwayAmplitude?: number; headBobFrequency?: number; })
FirstPersonCamera.setLookSensitivityScale(scale: number): void
FirstPersonCamera.getLookSensitivityScale(): number
FirstPersonCamera.applyViewPunch(pitchRad: number, yawRad: number, options: ViewPunchOptions = DEFAULT_VIEW_PUNCH_OPTIONS): void
FirstPersonCamera.setFovOffset(deltaDeg: number): void
FirstPersonCamera.clearFovOffset(): void
FirstPersonCamera.applyExternalDelta(deltaX: number, deltaY: number): void
FirstPersonCamera.update(deltaTime: number): void
FirstPersonCamera.getForwardVector(): THREE.Vector3
FirstPersonCamera.getRightVector(): THREE.Vector3
FirstPersonCamera.getCamera(): THREE.PerspectiveCamera
FirstPersonCamera.setTarget(newTarget: THREE.Object3D): void
FirstPersonCamera.setEnabled(enabled: boolean): void
FirstPersonCamera.setPointerLocked(locked: boolean): void
FirstPersonCamera.getPointerLocked(): boolean
FirstPersonCamera.setEditorModeCamera(enabled: boolean): void
FirstPersonCamera.getHorizontalAngle(): number
FirstPersonCamera.getTargetHorizontalAngle(): number
FirstPersonCamera.getMode(): CameraMode
FirstPersonCamera.setHorizontalAngle(angle: number): void
FirstPersonCamera.setVerticalAngle(angle: number): void
FirstPersonCamera.getVerticalAngle(): number
FirstPersonCamera.getPitchAngle(): number
FirstPersonCamera.setEyeHeight(height: number): void
FirstPersonCamera.getEyeHeight(): number
FirstPersonCamera.setHeadBobEnabled(enabled: boolean): void
FirstPersonCamera.setHeadBobAmplitude(amplitude: number): void
FirstPersonCamera.setHeadBobSwayAmplitude(amplitude: number): void
FirstPersonCamera.setHeadBobFrequency(frequency: number): void
FirstPersonCamera.applyShake(intensity: number = 0.03): void
FirstPersonCamera.dispose(): void

## engine/GamepadControls.ts
interface GamepadControlsConfig — Gamepad (Xbox/PlayStation/etc.) input handling via the Gamepad API.
GamepadControlsConfig.stickDeadzone?: number
GamepadControlsConfig.axisDeadzone?: number
GamepadControlsConfig.cameraSensitivity?: number
type GamepadLayout = 'standard' | 'generic'
class GamepadControls implements IInputControls
GamepadControls.moveX: number
GamepadControls.moveY: number
GamepadControls.ascendPressed: boolean
GamepadControls.descendPressed: boolean
GamepadControls.actionPressed: boolean
GamepadControls.secondaryActionPressed: boolean
GamepadControls.interactPressed: boolean
GamepadControls.exitPressed: boolean
GamepadControls.cameraX: number
GamepadControls.cameraY: number
GamepadControls.hadInputThisFrame: boolean
GamepadControls.constructor(config: GamepadControlsConfig = {})
GamepadControls.getGamepadInfo(): { id: string; index: number; mapping: string; layout: GamepadLayout } | null
GamepadControls.consumeCurrentPresses(): void
GamepadControls.setAscendButton(index: number): void
GamepadControls.setExitButton(index: number): void
GamepadControls.setInteractButton(index: number): void
GamepadControls.setActionButton(index: number): void
GamepadControls.setSecondaryActionButton(index: number): void
GamepadControls.setDescendButton(index: number): void
GamepadControls.addAscendButton(index: number): void
GamepadControls.addExitButton(index: number): void
GamepadControls.addInteractButton(index: number): void
GamepadControls.addActionButton(index: number): void
GamepadControls.addSecondaryActionButton(index: number): void
GamepadControls.addDescendButton(index: number): void
GamepadControls.setStickDeadzone(value: number): void
GamepadControls.setAxisDeadzone(value: number): void
GamepadControls.setCameraSensitivity(value: number): void
GamepadControls.setMoveYEnabled(enabled: boolean): void
GamepadControls.isPlayStation(): boolean
GamepadControls.getButtonLabel(index: number): string
GamepadControls.getAscendButtonLabel(): string
GamepadControls.getExitButtonLabel(): string
GamepadControls.getInteractButtonLabel(): string
GamepadControls.getActionButtonLabel(): string
GamepadControls.getSecondaryActionButtonLabel(): string
GamepadControls.getDescendButtonLabel(): string
GamepadControls.isEnabled(): boolean
GamepadControls.update(): void
GamepadControls.dispose(): void
GamepadControls.resetActionPressed(): void
GamepadControls.resetSecondaryActionPressed(): void
GamepadControls.resetInteractPressed(): void
GamepadControls.resetAscendPressed(): void
GamepadControls.resetDescendPressed(): void
GamepadControls.resetExitPressed(): void
GamepadControls.setControlsEnabled(enabled: boolean): void
GamepadControls.getControlsEnabled(): boolean

## engine/ICameraController.ts
interface ICameraController — Camera controller interface that both FirstPersonCamera and ThirdPersonCamera implement.
ICameraController.camera: THREE.PerspectiveCamera
ICameraController.target: THREE.Object3D
ICameraController.enabled: boolean
ICameraController.update(deltaTime: number): void
ICameraController.getForwardVector(): THREE.Vector3
ICameraController.getRightVector(): THREE.Vector3
ICameraController.getCamera(): THREE.PerspectiveCamera
ICameraController.setTarget(target: THREE.Object3D): void
ICameraController.setEnabled(enabled: boolean): void
ICameraController.setPointerLocked(locked: boolean): void
ICameraController.getPointerLocked(): boolean
ICameraController.setEditorModeCamera(enabled: boolean): void
ICameraController.applyExternalDelta(deltaX: number, deltaY: number): void
ICameraController.getHorizontalAngle(): number
ICameraController.getVerticalAngle(): number
ICameraController.getPitchAngle(): number
ICameraController.getMode(): CameraMode
ICameraController.applyShake(intensity?: number): void
ICameraController.dispose(): void
type CameraMode = 'first-person' | 'third-person' | 'top-down'
type VehicleCameraMode = 'auto' | 'chase' | 'cockpit' | 'keep'

## engine/IInputControls.ts
interface IInputControls — Shared interface for input control systems (Desktop and Mobile).
IInputControls.moveX: number
IInputControls.moveY: number
IInputControls.ascendPressed: boolean
IInputControls.descendPressed: boolean
IInputControls.actionPressed: boolean
IInputControls.secondaryActionPressed: boolean
IInputControls.interactPressed: boolean
IInputControls.exitPressed: boolean
IInputControls.isEnabled(): boolean
IInputControls.update(): void
IInputControls.dispose(): void
IInputControls.resetActionPressed(): void
IInputControls.resetSecondaryActionPressed(): void
IInputControls.resetInteractPressed(): void
IInputControls.resetAscendPressed(): void
IInputControls.resetDescendPressed(): void
IInputControls.resetExitPressed(): void
IInputControls.setControlsEnabled(enabled: boolean): void
IInputControls.getControlsEnabled(): boolean

## engine/LidSensorControls.ts
interface LidSensorOptions
LidSensorOptions.streamUrl: string
LidSensorOptions.angleDeltaThreshold: number
LidSensorOptions.angleNoiseFloor: number
LidSensorOptions.idleResetMs: number
const DEFAULT_LID_SENSOR_OPTIONS: LidSensorOptions
class LidSensorControls implements IInputControls
LidSensorControls.moveX
LidSensorControls.moveY
LidSensorControls.ascendPressed
LidSensorControls.descendPressed
LidSensorControls.actionPressed
LidSensorControls.secondaryActionPressed
LidSensorControls.interactPressed
LidSensorControls.exitPressed
LidSensorControls.constructor(options: LidSensorOptions = DEFAULT_LID_SENSOR_OPTIONS)
LidSensorControls.setEnabled(enabled: boolean): void
LidSensorControls.isEnabled(): boolean
LidSensorControls.update(): void
LidSensorControls.dispose(): void
LidSensorControls.resetActionPressed(): void
LidSensorControls.resetSecondaryActionPressed(): void
LidSensorControls.resetInteractPressed(): void
LidSensorControls.resetAscendPressed(): void
LidSensorControls.resetDescendPressed(): void
LidSensorControls.resetExitPressed(): void
LidSensorControls.setControlsEnabled(enabled: boolean): void
LidSensorControls.getControlsEnabled(): boolean

## engine/MobileActionSpec.ts
interface MobileActionSpec — A declarative spec for a mobile button, used by genres to declare
MobileActionSpec.action: string
MobileActionSpec.desktopKeys: string[]
MobileActionSpec.iconKey: string
MobileActionSpec.label: string
MobileActionSpec.initiallyVisible?: boolean
MobileActionSpec.behavior: 'tap' | 'continuous'
MobileActionSpec.preferredSlot?: MobileSlot
type MobileSlot = | 'primary' // biggest action button, bottom-right inner | 'secondary' // bottom-right outer | 'ascend' // right column, above primary | 'descend' // right column, below primary | 'left-1' | 'left-2' | 'left-3' // left-side auxiliary stack | 'top-left' | 'top-right'
type MobileIcon = { kind: 'text'; value: string } | { kind: 'url'; value: string }
class MobileIconRegistry
static MobileIconRegistry.register(key: string, icon: MobileIcon): void
static MobileIconRegistry.get(key: string): MobileIcon | undefined

## engine/MobileButtonLayout.ts
interface MobileButtonPosition
MobileButtonPosition.bottom: string
MobileButtonPosition.right?: string
MobileButtonPosition.left?: string
MobileButtonPosition.top?: string
MobileButtonPosition.width: string
MobileButtonPosition.height: string
MobileButtonPosition.borderRadius: string
MobileButtonPosition.fontSize: string
class MobileButtonLayout
MobileButtonLayout.constructor(private readonly isReservedByEngine: (slot: MobileSlot) => boolean = isEngineChromeSlot)
MobileButtonLayout.assign(action: string, preferred: MobileSlot): MobileButtonPosition
MobileButtonLayout.positionFor(slot: MobileSlot): MobileButtonPosition
MobileButtonLayout.reset(): void

## engine/MobileControls.debug.ts
class MobileControlsDebug — Desktop-preview-only sidecar for {@link MobileControls}.
MobileControlsDebug.constructor(controls: MobileControls, restoreFocus?: () => void)
MobileControlsDebug.forceEnable(config?: Partial<MobileControlsConfig>): void
MobileControlsDebug.disable(): void

## engine/MobileControls.ts
type MobileButtonRole = 'primary' | 'danger' | 'warning'
interface MobileControlsConfig
MobileControlsConfig.joystickSize?: number
MobileControlsConfig.joystickDeadzone?: number
MobileControlsConfig.cameraSensitivity?: number
MobileControlsConfig.autoFollowCamera?: boolean
MobileControlsConfig.autoFollowSpeed?: number
MobileControlsConfig.buttons?: MobileButtonDef[]
interface MobileButtonDef — Definition for a dynamically created mobile button.
MobileButtonDef.action: string
MobileButtonDef.label: string
MobileButtonDef.imageUrl?: string
MobileButtonDef.role?: MobileButtonRole
MobileButtonDef.baseColor?: string
MobileButtonDef.pressedColor?: string
MobileButtonDef.behavior: 'tap' | 'continuous'
class MobileControls implements IInputControls
MobileControls.moveX: number
MobileControls.moveY: number
MobileControls.cameraDeltaX: number
MobileControls.cameraDeltaY: number
MobileControls.isManualCameraControl: boolean
MobileControls.get ascendPressed(): boolean
MobileControls.set ascendPressed(_: boolean)
MobileControls.get descendPressed(): boolean
MobileControls.set descendPressed(_: boolean)
MobileControls.get interactPressed(): boolean
MobileControls.set interactPressed(value: boolean)
MobileControls.get exitPressed(): boolean
MobileControls.set exitPressed(_: boolean)
MobileControls.get actionPressed(): boolean
MobileControls.set actionPressed(_: boolean)
MobileControls.get actionHeld(): boolean
MobileControls.set actionHeld(_: boolean)
MobileControls.get secondaryActionPressed(): boolean
MobileControls.set secondaryActionPressed(_: boolean)
MobileControls.get jumpPressed(): boolean
MobileControls.set jumpPressed(_: boolean)
MobileControls.constructor(config: MobileControlsConfig = {})
MobileControls.getButton(action: string): HTMLButtonElement | null
MobileControls.getRegisteredActionNames(): string[]
MobileControls.setButtons(defs: MobileButtonDef[]): void
MobileControls.isDrivingMode(): boolean
MobileControls.setDrivingMode(enabled: boolean): void
MobileControls.isEnabled(): boolean
MobileControls.update(): void
MobileControls.getAutoFollowEnabled(): boolean
MobileControls.getAutoFollowSpeed(): number
MobileControls.setAutoFollowEnabled(enabled: boolean): void
MobileControls.showInteractButton(text: string): void
MobileControls.hideInteractButton(): void
MobileControls.showExitButton(text: string): void
MobileControls.hideExitButton(): void
MobileControls.resetInteractPressed(): void
MobileControls.resetExitPressed(): void
MobileControls.resetActionPressed(): void
MobileControls.resetSecondaryActionPressed(): void
MobileControls.setActionBehavior(behavior: 'tap' | 'continuous'): void
MobileControls.setActionType(actionType: string | null): void
MobileControls.setActionButtonAppearance(icon: string, _baseColor?: string, _pressedColor?: string): void
MobileControls.setSecondaryActionType(actionType: string | null): void
MobileControls.setControlsEnabled(enabled: boolean): void
MobileControls.getControlsEnabled(): boolean
MobileControls.setVisible(visible: boolean): void
MobileControls.setMovementControlsAvailable(available: boolean): void
MobileControls.updateMovementButtons(ascendDisplayName: string, descendDisplayName: string, supportedKeys: { ascend: boolean; descend: boolean }, keyBehavior: { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' }): void
MobileControls.resetAscendPressed(): void
MobileControls.resetDescendPressed(): void
MobileControls.forceDisable(): void
MobileControls.registerAction(def: MobileButtonDef, position?: MobileButtonPosition, initiallyHidden: boolean = false): void
MobileControls.isPressed(action: string): boolean
MobileControls.resetPressed(action: string): void
MobileControls.customActionEntries(): IterableIterator<[string, { pressed: boolean; behavior: 'tap' | 'continuous' }]>
MobileControls._debug_applyConfig(config: Partial<MobileControlsConfig>): void
MobileControls._debug_enableUIIfNeeded(): void
MobileControls._debug_applyButtons(defs: MobileButtonDef[]): void
MobileControls._debug_setDisableHook(hook: (() => void) | null): void
MobileControls._debug_isActive(): boolean
MobileControls._debug_getJoystickGeometry(): { size: number; deadzone: number }
MobileControls._debug_setJoystickKnobFraction(fx: number, fy: number): void
MobileControls._debug_applyCameraDelta(dxPx: number, dyPx: number): void
MobileControls._debug_beginCameraDrag(): void
MobileControls._debug_endCameraDrag(tap?: { durationMs: number; distancePx: number }): void
MobileControls._debug_getButtons(): ReadonlyMap<string, { element: HTMLButtonElement; behavior: 'tap' | 'continuous' }>
MobileControls._debug_simulateButtonDown(action: string, btn: HTMLButtonElement): void
MobileControls._debug_simulateButtonUp(action: string, btn: HTMLButtonElement): void
MobileControls._debug_endJoystickDrag(): void
MobileControls._debug_repositionJoystickContainer(centerX: number, centerY: number): void
MobileControls._debug_isJoystickVisible(): boolean
MobileControls.dispose(): void

## engine/MobileParity.ts
interface MovementAvailabilityProfile — The slice of `worldProfileData` the movement-availability decision reads.
MovementAvailabilityProfile.hasPlayerCharacter?: boolean
MovementAvailabilityProfile.cameraMode?: string
function computeMovementControlsAvailable(profile: MovementAvailabilityProfile | null | undefined, driving: boolean, override: boolean | null): boolean
interface MobileParityResult — Result of a mobile-parity check: desktop custom keys vs. mobile custom actions.
MobileParityResult.ok: boolean
MobileParityResult.unpairedDesktopKeys: string[]
MobileParityResult.unpairedMobileActions: string[]
function computeMobileParity(desktopKeys: Iterable<string>, mobileActions: Iterable<string>, customActionToKeys: Iterable<[string, string[]]>): MobileParityResult

## engine/PointerLockManager.ts
type PointerLockChangeListener = (isLocked: boolean) => void
class PointerLockManager
PointerLockManager.constructor(element: HTMLElement, claimClickPrompt: () => boolean)
PointerLockManager.requestLockWithRetry(): void
PointerLockManager.cancelLockRequest(): void
PointerLockManager.requestLock(): void
PointerLockManager.exitLock(): void
PointerLockManager.getIsLocked(): boolean
PointerLockManager.getIsSupported(): boolean
PointerLockManager.getIsMobile(): boolean
PointerLockManager.addListener(listener: PointerLockChangeListener): void
PointerLockManager.removeListener(listener: PointerLockChangeListener): void
PointerLockManager.showOverlay(): void
PointerLockManager.isOverlayVisible(): boolean
PointerLockManager.hideOverlay(): void
PointerLockManager.setEditorMode(enabled: boolean): void
PointerLockManager.getEditorMode(): boolean
PointerLockManager.setInteractiveUIMode(enabled: boolean): void
PointerLockManager.getInteractiveUIMode(): boolean
PointerLockManager.setFreeMouseMode(enabled: boolean): void
PointerLockManager.getFreeMouseMode(): boolean
PointerLockManager.dispose(): void

## engine/ScreenshotCameras.ts
interface TopdownSpec
TopdownSpec.kind: 'topdown'
TopdownSpec.fitLevel: boolean
TopdownSpec.height: number | null
TopdownSpec.tilt: number
TopdownSpec.margin: number | null
interface IsometricSpec
IsometricSpec.kind: 'isometric'
IsometricSpec.fitLevel: boolean
IsometricSpec.distance: number | null
IsometricSpec.azimuth: number
IsometricSpec.margin: number | null
interface OrbitSpec
OrbitSpec.kind: 'orbit'
OrbitSpec.target: THREE.Object3D | null
OrbitSpec.distance: number
OrbitSpec.azimuth: number
OrbitSpec.pitch: number
function buildTopdownCamera(gameData: GameData, spec: TopdownSpec, aspect: number): THREE.PerspectiveCamera
function buildIsometricCamera(gameData: GameData, spec: IsometricSpec, aspect: number): THREE.PerspectiveCamera
function buildOrbitCamera(resolvedTarget: THREE.Object3D | null, spec: OrbitSpec, aspect: number): THREE.PerspectiveCamera

## engine/ShadowCamera.ts
interface ShadowConfig
ShadowConfig.mapSize: number
ShadowConfig.mapSizeOverride?: number
ShadowConfig.bias: number
ShadowConfig.normalBias: number
ShadowConfig.shadowBlurRadius: number
ShadowConfig.shadowDistance: number
const DEFAULT_SHADOW_DISTANCE = 200
const SHADOW_MAP_MAX_SIZE_DESKTOP = 4096
const SHADOW_MAP_MAX_SIZE_MOBILE = 2048
function resolveShadowDistance(explicitDistance: number | undefined, bounds: TerrainBounds | null): number
function resolveShadowMapSize(shadowDistance: number, cap: number, explicitSize?: number): number
function configureDirectionalShadow(renderer: THREE.WebGLRenderer, directionalLight: THREE.DirectionalLight, config: ShadowConfig): number
function updateShadowCameraPosition(directionalLight: THREE.DirectionalLight, playerPosition: THREE.Vector3, config: ShadowConfig, unitsPerTexel: number, lastSnappedCenter: THREE.Vector3 | null, isGaussianSplatMode: boolean): THREE.Vector3 | null

## engine/ThirdPersonCamera.ts
class ThirdPersonCamera implements ICameraController
ThirdPersonCamera.camera: THREE.PerspectiveCamera
ThirdPersonCamera.target: THREE.Object3D
ThirdPersonCamera.domElement: HTMLElement
ThirdPersonCamera.engine: EngineLike
ThirdPersonCamera.distance: number
ThirdPersonCamera.minDistance: number
ThirdPersonCamera.maxDistance: number
ThirdPersonCamera.height: number
ThirdPersonCamera.lookAtHeight: number
ThirdPersonCamera.rotationSpeed: number
ThirdPersonCamera.smoothness: number
ThirdPersonCamera.spherical: THREE.Spherical
ThirdPersonCamera.targetSpherical: THREE.Spherical
ThirdPersonCamera.isMouseDown: boolean
ThirdPersonCamera.mouseX: number
ThirdPersonCamera.mouseY: number
ThirdPersonCamera.enabled: boolean
ThirdPersonCamera.offset: THREE.Vector3
ThirdPersonCamera.lookAtPosition: THREE.Vector3
ThirdPersonCamera.shoulderOffsetRight: number
ThirdPersonCamera.shoulderOffsetUp: number
ThirdPersonCamera.disableBuiltInTouchControls: boolean
ThirdPersonCamera.disableBuiltInMouseControls: boolean
ThirdPersonCamera.constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, engine: any = null)
ThirdPersonCamera.setupEventListeners(): void
ThirdPersonCamera.shouldProcessInput(): boolean
ThirdPersonCamera.onMouseDown(event: MouseEvent): void
ThirdPersonCamera.onMouseUp(event: MouseEvent): void
ThirdPersonCamera.onMouseMove(event: MouseEvent): void
ThirdPersonCamera.onDocumentMouseMove(event: MouseEvent): void
ThirdPersonCamera.onTouchStart(event: TouchEvent): void
ThirdPersonCamera.onTouchEnd(_event: TouchEvent): void
ThirdPersonCamera.onTouchMove(event: TouchEvent): void
ThirdPersonCamera.onWheel(event: WheelEvent): void
ThirdPersonCamera.applyExternalDelta(deltaX: number, deltaY: number): void
ThirdPersonCamera.setAutoFollow(enabled: boolean, speed?: number): void
ThirdPersonCamera.setExternalOrbitDrive(enabled: boolean): void
ThirdPersonCamera.driveOrbit(theta: number, phi: number, radius?: number, snap: boolean = false): void
ThirdPersonCamera.setTargetForwardDirection(direction: THREE.Vector3 | null): void
ThirdPersonCamera.update(deltaTime: number): void
ThirdPersonCamera.setShoulderOffset(right: number, up: number): void
ThirdPersonCamera.setChaseDamping(opts: { horizontal: number; vertical: number; orbit: number } | null): void
ThirdPersonCamera.setCollideWithEnvironment(enabled: boolean): void
ThirdPersonCamera.setFovOffset(deltaDeg: number): void
ThirdPersonCamera.clearFovOffset(): void
ThirdPersonCamera.getForwardVector(): THREE.Vector3
ThirdPersonCamera.getRightVector(): THREE.Vector3
ThirdPersonCamera.setTarget(newTarget: THREE.Object3D): void
ThirdPersonCamera.resetFollow(): void
ThirdPersonCamera.setEnabled(enabled: boolean): void
ThirdPersonCamera.setPointerLocked(locked: boolean): void
ThirdPersonCamera.setEditorModeCamera(enabled: boolean): void
ThirdPersonCamera.setMobilePreviewMode(enabled: boolean): void
ThirdPersonCamera.setCombatMode(enabled: boolean): void
ThirdPersonCamera.getPointerLocked(): boolean
ThirdPersonCamera.getCamera(): THREE.PerspectiveCamera
ThirdPersonCamera.getHorizontalAngle(): number
ThirdPersonCamera.getTargetHorizontalAngle(): number
ThirdPersonCamera.getMode(): CameraMode
ThirdPersonCamera.setHorizontalAngle(angle: number): void
ThirdPersonCamera.setVerticalAngle(angle: number): void
ThirdPersonCamera.getVerticalAngle(): number
ThirdPersonCamera.getPitchAngle(): number
ThirdPersonCamera.applyShake(intensity: number = 0.03): void
ThirdPersonCamera.dispose(): void

## engine/TopDownCamera.ts
interface TopDownFitWorldOptions — Configuration for the top-down "fit whole world" mode. When active the camera
TopDownFitWorldOptions.sizeX: number
TopDownFitWorldOptions.sizeZ: number
TopDownFitWorldOptions.centerX: number
TopDownFitWorldOptions.centerZ: number
TopDownFitWorldOptions.margin: number
TopDownFitWorldOptions.height: number
TopDownFitWorldOptions.region: FitWorldRegion
TopDownFitWorldOptions.background: string
const DEFAULT_TOPDOWN_FIT_WORLD_OPTIONS: TopDownFitWorldOptions
class TopDownCamera implements ICameraController
TopDownCamera.camera: THREE.PerspectiveCamera
TopDownCamera.target: THREE.Object3D
TopDownCamera.domElement: HTMLElement
TopDownCamera.engine: EngineLike
TopDownCamera.enabled: boolean
TopDownCamera.constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, engine: EngineLike)
TopDownCamera.setFitWorld(options: (Partial<TopDownFitWorldOptions> & { sizeX: number; sizeZ: number }) | null): void
TopDownCamera.update(deltaTime: number): void
TopDownCamera.getForwardVector(): THREE.Vector3
TopDownCamera.getRightVector(): THREE.Vector3
TopDownCamera.getCamera(): THREE.PerspectiveCamera
TopDownCamera.setTarget(target: THREE.Object3D): void
TopDownCamera.setEnabled(enabled: boolean): void
TopDownCamera.setPointerLocked(locked: boolean): void
TopDownCamera.getPointerLocked(): boolean
TopDownCamera.setEditorModeCamera(enabled: boolean): void
TopDownCamera.applyExternalDelta(deltaX: number, deltaY: number): void
TopDownCamera.setRotationEnabled(enabled: boolean): void
TopDownCamera.getRotationEnabled(): boolean
TopDownCamera.getHorizontalAngle(): number
TopDownCamera.getMode(): CameraMode
TopDownCamera.getVerticalAngle(): number
TopDownCamera.getPitchAngle(): number
TopDownCamera.setHorizontalAngle(angle: number): void
TopDownCamera.setVerticalAngle(angle: number): void
TopDownCamera.applyShake(intensity: number = 0.5): void
TopDownCamera.setHeight(height: number): void
TopDownCamera.getHeight(): number
TopDownCamera.setDistance(distance: number): void
TopDownCamera.getDistance(): number
TopDownCamera.setHeightRange(min: number, max: number): void
TopDownCamera.setPitchRange(min: number, max: number): void
TopDownCamera.setLookAhead(distance: number, direction?: THREE.Vector3): void
TopDownCamera.panBy(deltaX: number, deltaZ: number): void
TopDownCamera.setPanOffset(x: number, z: number): void
TopDownCamera.getPanOffset(): THREE.Vector3
TopDownCamera.resetPan(): void
TopDownCamera.setPanLimits(minX: number, maxX: number, minZ: number, maxZ: number): void
TopDownCamera.setPanGroundHeight(y: number): void
TopDownCamera.beginPan(clientX: number, clientY: number): void
TopDownCamera.panTo(clientX: number, clientY: number): void
TopDownCamera.endPan(): void
TopDownCamera.dispose(): void

## engine/isMobileRuntime.ts
function isMobileRuntime(): boolean
function installForcedMobileTouchShim(): void
