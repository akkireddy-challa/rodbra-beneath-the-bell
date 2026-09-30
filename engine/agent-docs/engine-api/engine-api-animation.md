# engine-api-animation

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/animation/ActionLayerSystem.ts
class ActionLayerSystem — Manages the action animation layer - plays action animations (attacks, etc.)
ActionLayerSystem.constructor(ctx: AnimationContext)
ActionLayerSystem.initActionLayer(character: THREE.Object3D): void
ActionLayerSystem.update(deltaTime: number): void
ActionLayerSystem.playActionAnimation(clip: THREE.AnimationClip, options?: { loop?: boolean; blendIn?: number }): { success: boolean; duration: number }
ActionLayerSystem.playActionAnimationByMotionId(motionId: string, options?: { loop?: boolean; blendIn?: number }): { success: boolean; duration: number }
ActionLayerSystem.stopActionAnimation(fadeOut: number = 0.2): void
ActionLayerSystem.setActionBlend(weights: { upperBody: number; lowerBody: number }): void
ActionLayerSystem.getActionBlend(): { upperBody: number; lowerBody: number }
ActionLayerSystem.isActionAnimationPlaying(): boolean
ActionLayerSystem.getActionBoneMap(): Map<string, THREE.Bone> | null
ActionLayerSystem.getActionSkeletonRoot(): THREE.Object3D | null
ActionLayerSystem.dispose(): void

## engine/animation/AnimationContext.ts
interface CachedGLTF — Cached GLTF data structure shared across animation systems.
CachedGLTF.scene: THREE.Group
CachedGLTF.animations: THREE.AnimationClip[]
function cachedGLTFLoad(loader: { loadAsync: (url: string) => Promise<CachedGLTF> }, url: string): Promise<CachedGLTF>
interface CharacterAnimationConfig
CharacterAnimationConfig.idleAnimationName?: string
CharacterAnimationConfig.walkAnimationName?: string
CharacterAnimationConfig.runAnimationName?: string
CharacterAnimationConfig.jumpAnimationName?: string
CharacterAnimationConfig.runSpeed?: number
CharacterAnimationConfig.walkToRunThreshold?: number
CharacterAnimationConfig.transitionDuration?: number
enum AnimationState { IDLE, WALK, RUN, JUMP, ATTACK }
type MixamoAnimationPlayer = import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer
interface AnimationContext — Shared mutable context passed to all animation subsystems.
AnimationContext.mixer: THREE.AnimationMixer | null
AnimationContext.character: THREE.Object3D | null
AnimationContext.config: CharacterAnimationConfig
AnimationContext.loader: { loadAsync: (url: string) => Promise<CachedGLTF> } | null
AnimationContext.isInitialized: boolean
AnimationContext.currentAction: THREE.AnimationAction | null
AnimationContext.currentState: AnimationState
AnimationContext.previousState: AnimationState
AnimationContext.animations: Map<AnimationState, THREE.AnimationAction>
AnimationContext.nativeSpeedByState: Map<AnimationState, number>
AnimationContext.rootMotionBone: THREE.Object3D | null
AnimationContext.rootMotionTargets: THREE.Object3D[]
AnimationContext.isJumping: boolean
AnimationContext.jumpStartTime: number
AnimationContext.jumpDuration: number
AnimationContext.isAttacking: boolean
AnimationContext.attackStartTime: number
AnimationContext.isPlayingCustomAnimation: boolean
AnimationContext.customAnimationHeld: boolean
AnimationContext.currentCustomMotionId: string | null
AnimationContext.customAnimationInterruptOnMovement: boolean
AnimationContext.customAnimationSplitOnMove: boolean
AnimationContext.customAnimationSplitApplied: boolean
AnimationContext.priorityAnimationPlaying: boolean
AnimationContext.trackAMixamoPlayer: MixamoAnimationPlayer | null
AnimationContext.trackBMixamoPlayer: MixamoAnimationPlayer | null
AnimationContext.fadingOutTrackAPlayer: MixamoAnimationPlayer | null
AnimationContext.fadingOutCrossfadeProgress: number
AnimationContext.fadingOutCrossfadeDuration: number
AnimationContext.mixamoAnimationPlayers: Map<string, MixamoAnimationPlayer>
AnimationContext.stateOverrides: Map<AnimationState, THREE.AnimationAction>
AnimationContext.mixamoStateOverrides: Map<AnimationState, string>
AnimationContext.pendingMixamoBaseAnimations: BaseAnimationDefinition[]
AnimationContext.locomotionDirection: 'forward' | 'back' | 'left' | 'right'
AnimationContext.locomotionAngle?: number
AnimationContext.directionalLocomotionStyle?: import('engine/animation/DirectionalLocomotion.js').DirectionalLocomotionStyle
AnimationContext.directionalLocomotionEnabled?: boolean
AnimationContext.playingLocomotionBucket: 'forward' | 'back' | 'left' | 'right'
AnimationContext.posture: string
AnimationContext.playingPosture: string
AnimationContext.trackBlend: { upperBody: number; lowerBody: number } | null
AnimationContext.attackResumeState: AnimationState | null
AnimationContext.attackTrackAState: AnimationState | null
AnimationContext.customAnimations: Map<string, THREE.AnimationAction>
AnimationContext.characterHeight: number
AnimationContext.retainFullSkeleton: boolean
AnimationContext.gameDataProvider: (() => { assets?: unknown[]; scene?: THREE.Scene | null } | null) | null
function keepCurrentActionAlive(ctx: AnimationContext): void
function fadeOutAllOtherActions(mixer: THREE.AnimationMixer, keep: THREE.AnimationAction, duration: number): void
function totalOtherActiveWeight(mixer: THREE.AnimationMixer, keep: THREE.AnimationAction): number
function fadeInFromWeight(action: THREE.AnimationAction, duration: number, startWeight: number): void
function ensureMixerWeightCovered(ctx: AnimationContext): void
function crossFadeToAction(ctx: AnimationContext, newAction: THREE.AnimationAction, duration: number): void
function findAnimationAsset(ctx: AnimationContext, motionId: string): Record<string, unknown> | null
function findAnimationAssetIdByName(ctx: AnimationContext, name: string): string | null
function getActionClip(action: THREE.AnimationAction): THREE.AnimationClip | null
function getCharacterUniformWorldScale(ctx: AnimationContext): number

## engine/animation/AnimationOverrideSystem.ts
class AnimationOverrideSystem — Manages animation state overrides - allows templates to swap individual
AnimationOverrideSystem.constructor(ctx: AnimationContext, idleSystem: IdleAnimationSystem, attackSystem: AttackAnimationSystem)
AnimationOverrideSystem.setAnimationOverride(state: AnimationState, source: string): boolean
AnimationOverrideSystem.clearAnimationOverride(state: AnimationState): void
AnimationOverrideSystem.clearAnimationOverrides(): void
AnimationOverrideSystem.getAnimationOverrides(): Map<string, string>
AnimationOverrideSystem.activateMixamoOverride(state: AnimationState): void
AnimationOverrideSystem.loadDeferredMixamoAnimations(loadAnimationPack: (animations: BaseAnimationDefinition[]) => Promise<void>): Promise<void>
AnimationOverrideSystem.loadAnimationPack(animations: BaseAnimationDefinition[], options?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean }): Promise<void>
AnimationOverrideSystem.dispose(): void
function resolveLocomotionMotionId(ctx: AnimationContext, state: AnimationState): string | undefined

## engine/animation/AnimationTiming.ts
interface AnimationTiming — Clip-local phase markers. Generated exports carry these on scene extras;
AnimationTiming.startTime: number
AnimationTiming.impactPhase: number | null
AnimationTiming.contactStart: number | null
AnimationTiming.contactEnd: number | null
function readAnimationTiming(value: unknown): AnimationTiming
function contactCheckPhases(timing: AnimationTiming, fallback: readonly number[]): readonly number[]

## engine/animation/AttackAnimationSystem.ts
class AttackAnimationSystem — Manages attack animations: random attacks, named custom attacks, and
AttackAnimationSystem.customAttackMoves: Map<string, CustomAttackMove>
AttackAnimationSystem.currentAttackMove: CustomAttackMove | null
AttackAnimationSystem.onAttackStarted: ((info: { moveName: string; duration: number }) => void) | null
AttackAnimationSystem.onAttackStartedEngine: ((info: { moveName: string; duration: number }) => void) | null
AttackAnimationSystem.constructor(ctx: AnimationContext, playAnimation: (state: AnimationState) => void, playMixamoAnimation: PlayMixamoAnimation)
AttackAnimationSystem.startAttack(): AttackResult
AttackAnimationSystem.endAttack(): void
AttackAnimationSystem.hasAttackAnimations(): boolean
AttackAnimationSystem.registerCustomAttack(move: CustomAttackMove): boolean
AttackAnimationSystem.unregisterCustomAttack(name: string): boolean
AttackAnimationSystem.loadCustomAttackMoves(customMoves: CustomAttackMove[], loadCustomAnimation: (motionId: string, options?: { normalizeRootMotion?: boolean; loop?: boolean }) => Promise<void>): Promise<void>
AttackAnimationSystem.getRegisteredAttackMoves(): string[]
AttackAnimationSystem.getAttackMoveConfig(moveName: string): CustomAttackMove | null
AttackAnimationSystem.startNamedAttack(moveName: string): AttackResult
AttackAnimationSystem.dispose(): void

## engine/animation/ContinuousQuaternionBlend.ts
class ContinuousQuaternionBlend — A quaternion's shortest arc is not temporally continuous when two moving
ContinuousQuaternionBlend.begin(key: string): void
ContinuousQuaternionBlend.reset(): void
ContinuousQuaternionBlend.sample(name: string, target: THREE.Quaternion, a: THREE.Quaternion, b: THREE.Quaternion, weight: number): void

## engine/animation/CustomAnimationSystem.ts
class CustomAnimationSystem — Manages custom animation loading and playback (both standard mixer
CustomAnimationSystem.constructor(ctx: AnimationContext, playAnimation: (state: AnimationState) => void)
CustomAnimationSystem.loadCustomAnimation(motionId: string, options?: { normalizeRootMotion?: boolean; loop?: boolean }): Promise<void>
CustomAnimationSystem.loadAllAnimationAssets(options?: { normalizeRootMotion?: boolean; loop?: boolean }): Promise<void>
CustomAnimationSystem.playCustomAnimation(motionId: string, options?: CustomPlayOptions): { success: boolean; duration: number }
CustomAnimationSystem.playMixamoAnimation(motionId: string, player: import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer, options?: CustomPlayOptions): { success: boolean; duration: number }
CustomAnimationSystem.updatePendingImpact(): void
CustomAnimationSystem.isPlayingCustom(): boolean
CustomAnimationSystem.getCustomMotionId(): string | null
CustomAnimationSystem.getAvailableCustomAnimations(): string[]
CustomAnimationSystem.stopCustomAnimation(): void
CustomAnimationSystem.setAnimationSpeed(speed: number): void
CustomAnimationSystem.getAnimationSpeed(): number
CustomAnimationSystem.setAnimationTime(time: number): void
CustomAnimationSystem.getAnimationTime(): number
CustomAnimationSystem.getCustomAnimationProgress(): number
CustomAnimationSystem.dispose(): void

## engine/animation/DirectionalLocomotion.ts
type DirectionalLocomotionStyle = 'neutral' | 'rifle'
const DIRECTIONAL_BLEND_IDS = { neutral: 'mCapturedJogBlend01', rifle: 'mCapturedRifleBlen
function directionalWeights(angle: number, result: number[]): void

## engine/animation/DirectionalLocomotionPlayer.ts
class DirectionalLocomotionPlayer extends MixamoAnimationPlayer — One composite Track A with a normal player lifecycle. Captures are sampled
DirectionalLocomotionPlayer.configure(samplers: MixamoAnimationPlayer[]): void
DirectionalLocomotionPlayer.setDirection(angle: number): void
DirectionalLocomotionPlayer.update(deltaTime: number): void
DirectionalLocomotionPlayer.setTime(time: number): void
DirectionalLocomotionPlayer.getNativeLocomotionSpeed(): number
DirectionalLocomotionPlayer.getDirectionWeights(): readonly number[]
DirectionalLocomotionPlayer.dispose(): void

## engine/animation/IdleAnimationSystem.ts
class IdleAnimationSystem — Manages idle animation cycling, including hand-attachment filtering
IdleAnimationSystem.idleAnimations: THREE.AnimationAction[]
IdleAnimationSystem.idleAnimationMetadata: Map<THREE.AnimationAction, { name: string; worksWithAttachedObjects: boolean }>
IdleAnimationSystem.usingCustomIdles: boolean
IdleAnimationSystem.constructor(ctx: AnimationContext)
IdleAnimationSystem.get idleTransitionDuration(): number
IdleAnimationSystem.setHasObjectAttachedToHandCallback(callback: (() => boolean) | null): void
IdleAnimationSystem.getAvailableIdleAnimations(): THREE.AnimationAction[]
IdleAnimationSystem.checkAndSwitchToCompatibleIdleAnimation(): void
IdleAnimationSystem.playNextIdleAnimation(): void
IdleAnimationSystem.playIdleAnimation(): void
IdleAnimationSystem.update(deltaTime: number): void
IdleAnimationSystem.setIdleAnimations(motionIds: string[]): Promise<void>
IdleAnimationSystem.poseCharacterAtFirstIdleFrame(): boolean
IdleAnimationSystem.dispose(): void

## engine/animation/ImpactFrameDetector.ts
interface ImpactGateOptions — Pure heuristic that estimates an action animation's contact ("impact") frame
ImpactGateOptions.minPeakToMeanRatio: number
ImpactGateOptions.prominentPeakThreshold: number
const DEFAULT_IMPACT_GATE: ImpactGateOptions
interface ImpactStrike — A detected strike: the contact-frame fraction plus which end-effector struck.
ImpactStrike.fraction: number
ImpactStrike.part: string
function pickImpactStrike(speedSeries: Map<string, number[]>, options: ImpactGateOptions = DEFAULT_IMPACT_GATE): ImpactStrike | null
function pickImpactFraction(speedSeries: Map<string, number[]>, options: ImpactGateOptions = DEFAULT_IMPACT_GATE): number | null

## engine/animation/LimbContact.ts
type LimbPart = 'leftFoot' | 'rightFoot' | 'leftHand' | 'rightHand'
interface LimbContactOptions
LimbContactOptions.parts: LimbPart[]
LimbContactOptions.slack: number
const DEFAULT_LIMB_CONTACT_OPTIONS: LimbContactOptions
interface LimbContactResult
LimbContactResult.part: LimbPart
LimbContactResult.point: THREE.Vector3
LimbContactResult.distance: number
function detectLimbContact(animController: ICharacterAnimationController | null, targetCenter: { x: number; y: number; z: number }, targetRadius: number, options?: Partial<LimbContactOptions>): LimbContactResult | null

## engine/animation/LocomotionRootMotion.ts
function removeLinearRootTravel(track: VectorKeyframeTrack): number

## engine/animation/PoseTransition.ts
interface PoseTransform
PoseTransform.position: THREE.Vector3
PoseTransform.rotation: THREE.Quaternion
type AnimationPose = Map<string, PoseTransform>
class PoseBuffer — A separate pool: never retain a renderer's frame-local pose map.
PoseBuffer.pose: AnimationPose
PoseBuffer.copy(source: AnimationPose): AnimationPose
class PoseTransition — Short action handoffs in CHARACTER space, so a saved pose follows movement/yaw.
PoseTransition.apply(pose: AnimationPose, key: string, frame: THREE.Object3D | null, deltaSeconds: number, lift: number, duration = 0.12): number
PoseTransition.reset(): void

## engine/animation/PriorityAnimationSystem.ts
class PriorityAnimationSystem — Manages priority animations that lock out idle/movement animations.
PriorityAnimationSystem.constructor(ctx: AnimationContext, playAnimation: (state: AnimationState) => void, playMixamoAnimation: PlayMixamoAnimation)
PriorityAnimationSystem.playPriorityAnimation(animationName: string, options?: { fadeInDuration?: number; fadeOutDuration?: number; speed?: number; loop?: boolean; onFinished?: () => void; }): { success: boolean; duration: number }
PriorityAnimationSystem.isPriorityAnimationPlaying(): boolean
PriorityAnimationSystem.dispose(): void

## engine/animation/ProceduralPoseLayers.ts
interface ProceduralPoseLayer — Bounded LOCAL rotation deltas relative to the evaluated pose, not bind.
ProceduralPoseLayer.rotations: ReadonlyMap<string, THREE.Quaternion>
ProceduralPoseLayer.weight: number
ProceduralPoseLayer.fadeIn: number
ProceduralPoseLayer.fadeOut: number
ProceduralPoseLayer.duration: number | null
class ProceduralPoseLayers
ProceduralPoseLayers.set(name: string, spec: ProceduralPoseLayer): void
ProceduralPoseLayers.updateTargets(name: string, rotations: ReadonlyMap<string, THREE.Quaternion>): boolean
ProceduralPoseLayers.remove(name: string): void
ProceduralPoseLayers.update(deltaTime: number): void
ProceduralPoseLayers.apply(pose: AnimationPose, bones: Map<string, THREE.Bone>, resolve: (name: string) => string | null): void
ProceduralPoseLayers.applyLocalRotations(pose: AnimationPose, bones: Map<string, THREE.Bone>, rotations: ReadonlyMap<string, THREE.Quaternion>, weight: number, resolve: (name: string) => string | null): void
ProceduralPoseLayers.clear(): void
ProceduralPoseLayers.get size(): number

## engine/animation/RootMotion.ts
function captureRootMotionBaseline(skeletonRoot: THREE.Object3D, hipsWorld: THREE.Vector3): THREE.Vector3
function rootMotionWorldTravelXZ(skeletonRoot: THREE.Object3D, hipsWorld: THREE.Vector3, baselineLocal: THREE.Vector3, out: THREE.Vector3): THREE.Vector3

## engine/animation/locomotionOverrides.ts
type LocomotionOverrideState = 'idle' | 'walk' | 'run'
function collectLocomotionOverrides(assets: readonly unknown[]): Map<AnimationState, string>
