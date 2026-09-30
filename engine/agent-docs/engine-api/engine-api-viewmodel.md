# engine-api-viewmodel

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/viewmodel/MuzzleFlash.ts
interface MuzzleFlashOptions — The flash at the end of the barrel — a burst of emissive blocks plus a real
MuzzleFlashOptions.intensity: number
MuzzleFlashOptions.scale: number
MuzzleFlashOptions.color: number | null
MuzzleFlashOptions.durationSeconds: number
const DEFAULT_MUZZLE_FLASH_OPTIONS: MuzzleFlashOptions
class MuzzleFlash
MuzzleFlash.constructor(options: MuzzleFlashOptions = DEFAULT_MUZZLE_FLASH_OPTIONS, light: THREE.PointLight | null = null)
MuzzleFlash.attachTo(parent: THREE.Object3D, muzzleOffset: THREE.Vector3): void
MuzzleFlash.setMuzzleOffset(muzzleOffset: THREE.Vector3): void
MuzzleFlash.detach(): void
MuzzleFlash.setColor(color: number): void
MuzzleFlash.trigger(): void
MuzzleFlash.update(deltaTime: number): void
MuzzleFlash.dispose(): void

## engine/viewmodel/PoseCurve.ts
interface ViewModelPose — A view-model transform: offset and euler rotation, both relative to the camera.
ViewModelPose.position: THREE.Vector3
ViewModelPose.rotation: THREE.Vector3
type EaseFn = (t: number) => number
const linear: EaseFn
const easeInQuad: EaseFn
const easeOutQuad: EaseFn
const easeInCubic: EaseFn
const easeOutCubic: EaseFn
const easeInOutCubic: EaseFn
const smoothstep: EaseFn
const easeOutBack: EaseFn
interface PoseCurveKey — One keyframe of a `PoseCurve`.
PoseCurveKey.t: number
PoseCurveKey.pose: ViewModelPose
PoseCurveKey.ease: EaseFn
type PoseCurve = readonly PoseCurveKey[]
function createPose(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0): ViewModelPose
function zeroPose(): ViewModelPose
function copyPose(target: ViewModelPose, source: ViewModelPose): ViewModelPose
function resetPose(target: ViewModelPose): ViewModelPose
function addScaledPose(target: ViewModelPose, source: ViewModelPose, scale: number): ViewModelPose
function mixPose(target: ViewModelPose, source: ViewModelPose, t: number): ViewModelPose
function evaluatePoseCurve(curve: PoseCurve, t: number, out: ViewModelPose): ViewModelPose
function createSwingCurve(windup: ViewModelPose, strike: ViewModelPose, windupEnd: number, strikeEnd: number): PoseCurve

## engine/viewmodel/RecoilProfiles.ts
type RecoilClass = 'pistol' | 'rifle' | 'heavy' | 'energy'
interface RecoilProfile
RecoilProfile.riseY: number
RecoilProfile.kickZ: number
RecoilProfile.pitch: number
RecoilProfile.yaw: number
RecoilProfile.roll: number
RecoilProfile.positionOmega: number
RecoilProfile.rotationOmega: number
RecoilProfile.damping: number
RecoilProfile.cameraPitch: number
RecoilProfile.cameraYaw: number
RecoilProfile.recenter: number
RecoilProfile.bloomPerShot: number
RecoilProfile.climbShots: number
const RECOIL_PROFILES: Record<RecoilClass, RecoilProfile>
const DEFAULT_RECOIL_PROFILE: RecoilProfile
const RECOIL_SHOT_CHAIN_TIMEOUT = 0.35
interface RecoilImpulse — A single shot's resolved kick, in peak displacement.
RecoilImpulse.positionY: number
RecoilImpulse.positionZ: number
RecoilImpulse.rotationX: number
RecoilImpulse.rotationY: number
RecoilImpulse.rotationZ: number
RecoilImpulse.cameraPitch: number
RecoilImpulse.cameraYaw: number
function resolveRecoilImpulse(profile: RecoilProfile, shotIndex: number, random: () => number): RecoilImpulse

## engine/viewmodel/RigInput.ts
class RigInputReader — Tracks what has to be derived across frames rather than read.
RigInputReader.reset(): void
RigInputReader.read(controller: PlayerController | null, deltaTime: number, adsHeld: boolean): RigFrameInput

## engine/viewmodel/ShellEjector.ts
interface ShellEjectionOptions — Spent casings tumbling out of the ejection port.
ShellEjectionOptions.poolSize: number
ShellEjectionOptions.lifetimeSeconds: number
ShellEjectionOptions.color: number
ShellEjectionOptions.scale: number
const DEFAULT_SHELL_EJECTION_OPTIONS: ShellEjectionOptions
class ShellEjector
ShellEjector.constructor(options: ShellEjectionOptions = DEFAULT_SHELL_EJECTION_OPTIONS)
ShellEjector.attachTo(viewRoot: THREE.Object3D): void
ShellEjector.detach(): void
ShellEjector.eject(fromViewSpace: THREE.Vector3): void
ShellEjector.update(deltaTime: number): void
ShellEjector.dispose(): void

## engine/viewmodel/Spring.ts
class Spring1 — A single scalar channel.
Spring1.constructor(private omega: number, private damping: number)
Spring1.setResponse(omega: number, damping: number): void
Spring1.getValue(): number
Spring1.getVelocity(): number
Spring1.isAtRest(): boolean
Spring1.reset(): void
Spring1.addImpulsePeak(peak: number): void
Spring1.integrate(deltaTime: number, target = 0): number
class Spring3 — Three scalar channels sharing one response.
Spring3.constructor(private omega: number, private damping: number)
Spring3.setResponse(omega: number, damping: number): void
Spring3.getX(): number
Spring3.getY(): number
Spring3.getZ(): number
Spring3.isAtRest(): boolean
Spring3.reset(): void
Spring3.addImpulsePeak(peakX: number, peakY: number, peakZ: number): void
Spring3.integrate(deltaTime: number, targetX = 0, targetY = 0, targetZ = 0): void
function expApproach(current: number, target: number, halfLife: number, deltaTime: number): number

## engine/viewmodel/ViewModelRig.ts
interface SwayOptions
SwayOptions.inputHalfLife: number
SwayOptions.positionPerYawRate: number
SwayOptions.positionPerPitchRate: number
SwayOptions.pullPerYawRate: number
SwayOptions.rotationPerYawRate: number
SwayOptions.rotationPerPitchRate: number
SwayOptions.rollPerYawRate: number
SwayOptions.positionPerStrafeSpeed: number
SwayOptions.positionMax: number
SwayOptions.pullMax: number
SwayOptions.rotationMax: number
SwayOptions.rollMax: number
SwayOptions.strafeMax: number
SwayOptions.omega: number
SwayOptions.damping: number
interface BobOptions
BobOptions.strideHzMin: number
BobOptions.strideHzMax: number
BobOptions.amplitudeX: number
BobOptions.amplitudeY: number
BobOptions.amplitudeZ: number
BobOptions.footfallAmplitude: number
BobOptions.rollAmplitude: number
BobOptions.pitchAmplitude: number
BobOptions.yawAmplitude: number
BobOptions.idlePositionX: number
BobOptions.idlePositionY: number
BobOptions.idleRoll: number
BobOptions.landingOmega: number
BobOptions.landingDamping: number
BobOptions.landingFullImpactSpeed: number
interface AdsOptions
AdsOptions.inSeconds: number
AdsOptions.outSeconds: number
AdsOptions.swayScale: number
AdsOptions.bobScale: number
AdsOptions.landingScale: number
AdsOptions.recoilScale: number
AdsOptions.cameraPunchScale: number
interface AccuracyOptions
AccuracyOptions.base: number
AccuracyOptions.movement: number
AccuracyOptions.airborne: number
AccuracyOptions.adsBonus: number
AccuracyOptions.bloomMax: number
AccuracyOptions.bloomHoldSeconds: number
AccuracyOptions.bloomHalfLife: number
interface ViewModelRigOptions
ViewModelRigOptions.restPose: ViewModelPose
ViewModelRigOptions.sightsPose: ViewModelPose
ViewModelRigOptions.sprintPose: ViewModelPose
ViewModelRigOptions.airbornePose: ViewModelPose
ViewModelRigOptions.sway: SwayOptions
ViewModelRigOptions.bob: BobOptions
ViewModelRigOptions.ads: AdsOptions
ViewModelRigOptions.accuracy: AccuracyOptions
ViewModelRigOptions.recoil: RecoilProfile
ViewModelRigOptions.seed: number
const DEFAULT_SWAY_OPTIONS: SwayOptions
const DEFAULT_BOB_OPTIONS: BobOptions
const DEFAULT_ADS_OPTIONS: AdsOptions
const DEFAULT_ACCURACY_OPTIONS: AccuracyOptions
const DEFAULT_VIEW_MODEL_RIG_OPTIONS: ViewModelRigOptions
interface RigFrameInput — Per-frame state the rig derives all of its motion from.
RigFrameInput.yaw: number
RigFrameInput.pitch: number
RigFrameInput.speed: number
RigFrameInput.referenceSpeed: number
RigFrameInput.lateralVelocity: number
RigFrameInput.verticalVelocity: number
RigFrameInput.grounded: boolean
RigFrameInput.adsHeld: boolean
class ViewModelRig
ViewModelRig.constructor(options: ViewModelRigOptions = DEFAULT_VIEW_MODEL_RIG_OPTIONS)
ViewModelRig.getPosition(): THREE.Vector3
ViewModelRig.getRotation(): THREE.Vector3
ViewModelRig.getAdsBlend(): number
ViewModelRig.getAccuracy(): number
ViewModelRig.getShotIndex(): number
ViewModelRig.getRecoilProfile(): RecoilProfile
ViewModelRig.getState(): ViewModelState
ViewModelRig.isSettled(): boolean
ViewModelRig.addRecoilShot(): RecoilImpulse
ViewModelRig.startAction(state: ViewModelActionState, durationSeconds?: number): void
ViewModelRig.cancelAction(): void
ViewModelRig.getActionProgress(): number
ViewModelRig.setRestPose(pose: ViewModelPose): void
ViewModelRig.setBobScale(scale: number): void
ViewModelRig.setSightsPose(pose: ViewModelPose): void
ViewModelRig.setRecoilProfile(profile: RecoilProfile): void
ViewModelRig.reset(): void
ViewModelRig.update(deltaTime: number, input: RigFrameInput): void
ViewModelRig.applyTo(target: THREE.Object3D): void
ViewModelRig.consumeLandingImpact(): number

## engine/viewmodel/ViewModelStates.ts
type ViewModelLocomotionState = 'idle' | 'walk' | 'sprint' | 'airborne'
type ViewModelActionState = 'equip' | 'holster' | 'reload' | 'inspect'
type ViewModelState = ViewModelLocomotionState | ViewModelActionState
const SPRINT_POSE: ViewModelPose
const AIRBORNE_POSE: ViewModelPose
const AIRBORNE_PITCH_PER_VY = 0.006
const AIRBORNE_PITCH_MAX = 0.05
const EQUIP_CURVE: PoseCurve
const HOLSTER_CURVE: PoseCurve
const RELOAD_CURVE: PoseCurve
const INSPECT_CURVE: PoseCurve
const ACTION_CURVES: Record<ViewModelActionState, PoseCurve>
const ACTION_DEFAULT_DURATIONS: Record<ViewModelActionState, number>
const ACTION_FADE_SECONDS = 0.12
const SPRINT_BLEND_LOW = 0.82
const SPRINT_BLEND_HIGH = 1.0
const BOB_GATE_LOW = 0.05
const BOB_GATE_HIGH = 0.25
const SPRINT_WEIGHT_HALF_LIFE = 0.09
const AIRBORNE_WEIGHT_HALF_LIFE = 0.10
function resolveSprintWeight(normalizedSpeed: number, grounded: boolean): number
function resolveBobGate(normalizedSpeed: number): number
const ADS_BLOCKING_ACTIONS: ReadonlySet<ViewModelActionState>
