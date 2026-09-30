# engine-api-character-anim

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/AnimatedGlbCharacter.ts
interface AnimatedGlbCharacterOptions — Stand-alone, self-animating skinned-GLB character.
AnimatedGlbCharacterOptions.url: string
AnimatedGlbCharacterOptions.position: { x: number; y: number; z: number }
AnimatedGlbCharacterOptions.rotationY: number
AnimatedGlbCharacterOptions.targetHeight: number | null
AnimatedGlbCharacterOptions.autoPlayClip: string | null
AnimatedGlbCharacterOptions.idleClipName: string | null
AnimatedGlbCharacterOptions.castShadow: boolean
AnimatedGlbCharacterOptions.receiveShadow: boolean
AnimatedGlbCharacterOptions.autoTick: boolean
AnimatedGlbCharacterOptions.rootMotion: boolean
AnimatedGlbCharacterOptions.rootMotionYaw: boolean
AnimatedGlbCharacterOptions.rootMotionMode: 'commit' | 'hold'
const DEFAULT_ANIMATED_GLB_CHARACTER_OPTIONS: AnimatedGlbCharacterOptions
interface PlayClipOptions
PlayClipOptions.loop: boolean
PlayClipOptions.crossfadeDuration: number
PlayClipOptions.timeScale: number
PlayClipOptions.rootMotion?: boolean
PlayClipOptions.rootMotionYaw?: boolean
const DEFAULT_PLAY_CLIP_OPTIONS: PlayClipOptions
class AnimatedGlbCharacter
AnimatedGlbCharacter.constructor(engine: EngineLike, options: AnimatedGlbCharacterOptions)
AnimatedGlbCharacter.whenReady(): Promise<void>
AnimatedGlbCharacter.play(name: string, opts: Partial<PlayClipOptions>): boolean
AnimatedGlbCharacter.update(deltaTime: number): void
AnimatedGlbCharacter.getPosition(): THREE.Vector3
AnimatedGlbCharacter.getRotationY(): number
AnimatedGlbCharacter.recenter(durationSeconds: number): void
AnimatedGlbCharacter.setPosition(x: number, y: number, z: number): void
AnimatedGlbCharacter.setRotationY(yaw: number): void
AnimatedGlbCharacter.getObject(): THREE.Object3D
AnimatedGlbCharacter.getClipNames(): string[]
AnimatedGlbCharacter.loadAnimation(url: string, name?: string): Promise<string[]>
AnimatedGlbCharacter.getCurrentClip(): string | null
AnimatedGlbCharacter.getClipDuration(name: string): number
AnimatedGlbCharacter.dispose(): void
function installAnimatedGlbDevTools(engine: EngineLike): void

## engine/AnimationAssets.ts
const LOCOMOTION_DIRECTIONS = [ 'Forward', 'Forward_Left', 'Left', 'Backward_Left', 'Backw
const capturedDirectionId = (style: 'neutral' | 'rifle', direction: string): string => `
type AnimationLibraryId = 'cdn' | 'generated'
const animationAssets: AnimationAssetsData
function isDefaultCharacterUrl(url: string): boolean

## engine/AnimationClipUtils.ts
function filterRootMotion(originalClip: THREE.AnimationClip, options?: { removeAllAxes?: boolean }, characterName?: string): THREE.AnimationClip
function measureRootMotionSpeed(clip: THREE.AnimationClip, characterName?: string, uniformScale: number = 1): number
function normalizeIdleRootMotion(originalClip: THREE.AnimationClip, characterName?: string): THREE.AnimationClip
function normalizeCustomAnimationRootMotion(originalClip: THREE.AnimationClip): THREE.AnimationClip
function retargetAnimationToCharacterSkeleton(originalClip: THREE.AnimationClip, characterBoneNames: Set<string>): THREE.AnimationClip
function findRootMotionBone(root: THREE.Object3D): THREE.Object3D | null
function collectRootMotionTargets(root: THREE.Object3D, clips: THREE.AnimationClip[]): THREE.Object3D[]
function logPositionTrackDeltas(clip: THREE.AnimationClip): void
function logAnimationDiagnostics(clip: THREE.AnimationClip, character: THREE.Object3D, mixer: THREE.AnimationMixer): void
function suppressThreeJSWarnings(): void
function scaleClipPositions(originalClip: THREE.AnimationClip, scale: number): THREE.AnimationClip
function detectClipUnitScale(clip: THREE.AnimationClip): number
function makeClipLoopable(originalClip: THREE.AnimationClip, blendDuration: number = 0.5): THREE.AnimationClip

## engine/AnimationPacks.ts
type AnimationPackType = 'core' | 'weapon' | 'ranged'
const CORE_ANIMATIONS: BaseAnimationDefinition[]
const ALL_BUILTIN_MOTION_IDS: string[]
const REQUIRED_ANIMATIONS: BaseAnimationDefinition[]
const OPTIONAL_BUILTIN_ANIMATIONS: BaseAnimationDefinition[]
const UNARMED_COMBAT_ANIMATIONS: BaseAnimationDefinition[]
const UNARMED_MOVES = { cross: 'mGenPunching01', jab: 'mGenPunchJab01', hook: 'mGe
const MINING_ANIMATIONS: BaseAnimationDefinition[]
function getBuiltinAnimationDef(motionId: string): BaseAnimationDefinition | undefined
const MELEE_WEAPON_ANIMATIONS: BaseAnimationDefinition[]
const RANGED_WEAPON_ANIMATIONS: BaseAnimationDefinition[]
const DIRECTIONAL_LOCOMOTION_ANIMATIONS: BaseAnimationDefinition[]
const DIRECTIONAL_MOVES = { backpedal: 'mGenBackpedal01', backpedalFast: 'mGenBackpeda
const POSTURE_ANIMATIONS: BaseAnimationDefinition[]
const POSTURE_MOVES = { crouch: { hold: 'mGenCrouchHold01', move: 'mGenCrouchStep0
const POSTURE_ACTIONS = { slide: 'mGenSlide01', ledgeMantle: 'mGenLedgeMantle01', ge
type Posture = 'stand' | keyof typeof POSTURE_MOVES
const RANGED_MOVES = { aimPistol: 'mGenAimPistol01', firePistol: 'mGenFirePistol0
interface RangedMoveSet — One hold style's aim loop + fire clip. `fireLoops` marks sustained fire.
RangedMoveSet.aim: string
RangedMoveSet.fire: string
RangedMoveSet.fireLoops: boolean
function rangedMovesFor(weaponTypeId: string): RangedMoveSet
const WEAPON_MOVES = { slashDown: 'mGenSlashDown01', slashSide: 'mGenSlashSide01'
function getAnimationPack(packType: AnimationPackType): BaseAnimationDefinition[]
function buildAnimationList(): BaseAnimationDefinition[]

## engine/CharacterAnimationController.ts
class CharacterAnimationController — Character Animation Controller - Skeleton Animator
CharacterAnimationController.constructor(config: CharacterAnimationConfig = {})
CharacterAnimationController.initializeWithCharacter(character: THREE.Object3D, gltf: any, loader: any, baseAnimations: BaseAnimationDefinition[], gameDataProvider?: () => { assets?: unknown[]; scene?: THREE.Scene | null } | null): Promise<void>
CharacterAnimationController.poseCharacterAtFirstIdleFrame(): boolean
CharacterAnimationController.updateAnimation(isMoving: boolean, movementSpeed: number, isGrounded: boolean, isJumpPressed: boolean, hasMovementInput: boolean = isMoving): void
CharacterAnimationController.getPoseGrounded(): boolean
CharacterAnimationController.getProceduralPoseLayers(): ProceduralPoseLayers
CharacterAnimationController.setProceduralPoseLayer(name: string, spec: ProceduralPoseLayer): void
CharacterAnimationController.updateProceduralPoseLayer(name: string, rotations: ReadonlyMap<string, THREE.Quaternion>): boolean
CharacterAnimationController.removeProceduralPoseLayer(name: string): void
CharacterAnimationController.getPoseDeltaSeconds(): number
CharacterAnimationController.update(deltaTime: number): void
CharacterAnimationController.setPosture(posture: string): void
CharacterAnimationController.getPosture(): string
CharacterAnimationController.setLocomotionDirection(localX: number, localZ: number): void
CharacterAnimationController.setDirectionalLocomotionStyle(style: DirectionalLocomotionStyle): void
CharacterAnimationController.setDirectionalLocomotionEnabled(enabled: boolean): void
CharacterAnimationController.getCurrentState(): AnimationState
CharacterAnimationController.getIsJumping(): boolean
CharacterAnimationController.getMixer(): THREE.AnimationMixer | null
CharacterAnimationController.getIsAttacking(): boolean
CharacterAnimationController.getIsPlayingCustomAnimation(): boolean
CharacterAnimationController.setHasObjectAttachedToHandCallback(callback: (() => boolean) | null): void
CharacterAnimationController.setIdleAnimations(motionIds: string[]): Promise<void>
CharacterAnimationController.startAttack(): AttackResult
CharacterAnimationController.endAttack(): void
CharacterAnimationController.hasAttackAnimations(): boolean
CharacterAnimationController.registerCustomAttack(move: CustomAttackMove): boolean
CharacterAnimationController.unregisterCustomAttack(name: string): boolean
CharacterAnimationController.getRegisteredAttackMoves(): string[]
CharacterAnimationController.getAttackMoveConfig(moveName: string): CustomAttackMove | null
CharacterAnimationController.startNamedAttack(moveName: string): AttackResult
CharacterAnimationController.setAttackStartedListener(listener: ((info: { moveName: string; duration: number }) => void) | null): void
CharacterAnimationController.setEngineAttackStartedListener(listener: ((info: { moveName: string; duration: number }) => void) | null): void
CharacterAnimationController.loadCustomAttackMoves(customMoves: CustomAttackMove[]): Promise<void>
CharacterAnimationController.loadCustomAnimation(motionId: string, options?: { normalizeRootMotion?: boolean; loop?: boolean }): Promise<void>
CharacterAnimationController.loadAllAnimationAssets(options?: { normalizeRootMotion?: boolean; loop?: boolean }): Promise<void>
CharacterAnimationController.playCustomAnimation(motionId: string, options?: { loop?: boolean; fadeInDuration?: number; fadeOutDuration?: number; speed?: number; onFinished?: () => void; applyRootMotion?: boolean; onRootMotionDisplacement?: (displacement: THREE.Vector3) => void; holdLastFrame?: boolean; filterRootMotion?: boolean; splitBodyOnRun?: boolean; interruptOnMovement?: boolean; onImpact?: () => void; impactTime?: number; }): { success: boolean; duration: number }
CharacterAnimationController.isPlayingCustom(): boolean
CharacterAnimationController.getCustomMotionId(): string | null
CharacterAnimationController.getCustomAnimationProgress(): number
CharacterAnimationController.getAvailableCustomAnimations(): string[]
CharacterAnimationController.stopCustomAnimation(): void
CharacterAnimationController.setAnimationSpeed(speed: number): void
CharacterAnimationController.getAnimationSpeed(): number
CharacterAnimationController.setAnimationTime(time: number): void
CharacterAnimationController.getAnimationTime(): number
CharacterAnimationController.getActiveMixamoPlayer(): MixamoAnimationPlayer | null
CharacterAnimationController.getTrackAMixamoPlayer(): MixamoAnimationPlayer | null
CharacterAnimationController.getTrackBMixamoPlayer(): MixamoAnimationPlayer | null
CharacterAnimationController.getAttackContactCheckPhases(fallback: readonly number[]): readonly number[]
CharacterAnimationController.getAttackPlaybackToken(): string
CharacterAnimationController.getFadingOutTrackAPlayer(): MixamoAnimationPlayer | null
CharacterAnimationController.getFadingOutCrossfadeProgress(): number
CharacterAnimationController.updateMixamoPlayer(deltaTime: number): void
CharacterAnimationController.setAnimationOverride(state: AnimationState, source: string): boolean
CharacterAnimationController.clearAnimationOverride(state: AnimationState): void
CharacterAnimationController.clearAnimationOverrides(): void
CharacterAnimationController.getAnimationOverrides(): Map<string, string>
CharacterAnimationController.loadDeferredMixamoAnimations(): Promise<void>
CharacterAnimationController.loadAnimationPack(animations: BaseAnimationDefinition[], options?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean }): Promise<void>
CharacterAnimationController.playActionAnimation(clip: THREE.AnimationClip, options?: { loop?: boolean; blendIn?: number }): { success: boolean; duration: number }
CharacterAnimationController.playActionAnimationByMotionId(motionId: string, options?: { loop?: boolean; blendIn?: number }): { success: boolean; duration: number }
CharacterAnimationController.stopActionAnimation(fadeOut: number = 0.2): void
CharacterAnimationController.setActionBlend(weights: { upperBody: number; lowerBody: number }): void
CharacterAnimationController.getActionBlend(): { upperBody: number; lowerBody: number }
CharacterAnimationController.isActionAnimationPlaying(): boolean
CharacterAnimationController.getActionBoneMap(): Map<string, THREE.Bone> | null
CharacterAnimationController.getActionSkeletonRoot(): THREE.Object3D | null
CharacterAnimationController.setManualBoneOffsets(offsets: Map<string, THREE.Quaternion> | null): void
CharacterAnimationController.getManualBoneOffsets(): Map<string, THREE.Quaternion> | null
CharacterAnimationController.setFootIkTargets(targets: import('engine/loaders/LegIK.js').LegIkTargets | null): void
CharacterAnimationController.getFootIkTargets(): import('engine/loaders/LegIK.js').LegIkTargets | null
CharacterAnimationController.playPriorityAnimation(animationName: string, options?: { fadeInDuration?: number; fadeOutDuration?: number; speed?: number; loop?: boolean; onFinished?: () => void; }): { success: boolean; duration: number }
CharacterAnimationController.isPriorityAnimationPlaying(): boolean
CharacterAnimationController.setCustomAnimationBodyBlend(blend: { upperBody: number; lowerBody: number } | null): void
CharacterAnimationController.getCustomAnimationBodyBlend(): { upperBody: number; lowerBody: number } | null
CharacterAnimationController.setCharacterHeight(height: number): void
CharacterAnimationController.setRetainFullSkeleton(retain: boolean): void
CharacterAnimationController.setGameDataProvider(provider: () => { assets?: unknown[]; scene?: THREE.Scene | null } | null): void
CharacterAnimationController.dispose(): void

## engine/FBXAnimationProcessor.ts
interface FBXValidationResult
FBXValidationResult.valid: boolean
FBXValidationResult.errors: string[]
FBXValidationResult.warnings: string[]
FBXValidationResult.boneCount: number
FBXValidationResult.animationCount: number
FBXValidationResult.animationNames: string[]
FBXValidationResult.duration: number
FBXValidationResult.skeletonHeight: number
FBXValidationResult.unitScale: number
interface FBXConversionResult
FBXConversionResult.success: boolean
FBXConversionResult.error?: string
FBXConversionResult.glbBlob?: Blob
FBXConversionResult.validation?: FBXValidationResult
function loadAndValidateFBX(file: File): Promise<{ scene: THREE.Group; validation: FBXValidationResult }>
function convertFBXToGLB(scene: THREE.Group, animationName?: string): Promise<Blob>
function processFBXAnimation(file: File): Promise<FBXConversionResult>
function testFBXWithSkin(file: File, scene: THREE.Scene, position: THREE.Vector3 = new THREE.Vector3(0, 0, 0)): Promise<{ mixer: THREE.AnimationMixer; cleanup: () => void } | null>

## engine/ICharacterAnimationController.ts
interface AttackResult — Result returned when starting an attack, includes move configuration for hit detection
AttackResult.success: boolean
AttackResult.duration: number
AttackResult.animationName: string
AttackResult.moveConfig?: CustomAttackMove
interface ICharacterAnimationController — Interface for character animation controllers
ICharacterAnimationController.setProceduralPoseLayer?(name: string, spec: import('engine/animation/ProceduralPoseLayers.js').ProceduralPoseLayer): void
ICharacterAnimationController.updateProceduralPoseLayer?(name: string, rotations: ReadonlyMap<string, THREE.Quaternion>): boolean
ICharacterAnimationController.removeProceduralPoseLayer?(name: string): void
ICharacterAnimationController.getAttackContactCheckPhases?(fallback: readonly number[]): readonly number[]
ICharacterAnimationController.getAttackPlaybackToken?(): string
ICharacterAnimationController.initializeWithCharacter( character: THREE.Object3D, gltf: any, loader?: any, baseAnimations?: BaseAnimationDefinition[], gameDataProvider?: () => { assets?: unknown[]; scene?: THREE.Scene | null } | null ): Promise<void>
ICharacterAnimationController.updateAnimation(isMoving: boolean, speed: number, isGrounded: boolean, isJumping: boolean, hasMovementInput?: boolean): void
ICharacterAnimationController.setLocomotionDirection?(localX: number, localZ: number): void
ICharacterAnimationController.setDirectionalLocomotionStyle?(style: 'neutral' | 'rifle'): void
ICharacterAnimationController.setDirectionalLocomotionEnabled?(enabled: boolean): void
ICharacterAnimationController.setPosture?(posture: string): void
ICharacterAnimationController.update(deltaTime: number): void
ICharacterAnimationController.startAttack(): AttackResult
ICharacterAnimationController.getCurrentState(): string
ICharacterAnimationController.getIsAttacking(): boolean
ICharacterAnimationController.getIsPlayingCustomAnimation?(): boolean
ICharacterAnimationController.dispose(): void
ICharacterAnimationController.getMixer(): THREE.AnimationMixer | null
ICharacterAnimationController.setGameDataProvider?(provider: () => { assets?: unknown[]; scene?: THREE.Scene | null } | null): void
ICharacterAnimationController.loadCustomAnimation?( motionId: string, options?: { normalizeRootMotion?: boolean; loop?: boolean; } ): Promise<void>
ICharacterAnimationController.loadAllAnimationAssets?(options?: { normalizeRootMotion?: boolean; loop?: boolean }): Promise<void>
ICharacterAnimationController.playCustomAnimation?( motionId: string, options?: { fadeInDuration?: number; fadeOutDuration?: number; speed?: number; onFinished?: () => void; applyRootMotion?: boolean; onRootMotionDisplacement?: (displacement: THREE.Vector3) => void; /** When true, the animation stays clamped on its last frame instead of * transitioning back to idle. The state machine is blocked until the * next playCustomAnimation / playAnimation call. */ holdLastFrame?: boolean; /** When true (Mixamo path only), the hips position track is locked * to the first frame on all axes — animation rotates in place and * the character's translation is owned by physics. */ filterRootMotion?: boolean; /** When true and the player is currently running, set an * upper-body-only blend so legs keep the run cycle while the * custom clip plays on the upper body — same behaviour as * WeaponMeleeSystem's melee strike. Has no effect outside RUN. */ splitBodyOnRun?: boolean; /** When true, the custom animation is stopped the moment the * player has movement input and the locomotion state machine * resumes. Use for short one-shot moves (kicks, dodges) that * should yield to player control. */ interruptOnMovement?: boolean; /** Fired once when playback crosses the clip's auto-detected * contact frame. Use to apply a physical effect (ball impulse, * hit) at the moment of contact instead of at frame 0. No-ops if * the clip has no detectable strike and no impactTime is given. */ onImpact?: () => void; /** Override (clip-local seconds) of the contact frame; beats the * auto-detected value. */ impactTime?: number; } ): { success: boolean; duration: number }
ICharacterAnimationController.isPlayingCustom?(): boolean
ICharacterAnimationController.getCustomMotionId?(): string | null
ICharacterAnimationController.getCustomAnimationProgress?(): number
ICharacterAnimationController.getAvailableCustomAnimations?(): string[]
ICharacterAnimationController.stopCustomAnimation?(): void
ICharacterAnimationController.setAnimationSpeed?(speed: number): void
ICharacterAnimationController.getAnimationSpeed?(): number
ICharacterAnimationController.setAnimationTime?(time: number): void
ICharacterAnimationController.getAnimationTime?(): number
ICharacterAnimationController.playPriorityAnimation?( animationName: string, options?: { fadeInDuration?: number; fadeOutDuration?: number; speed?: number; loop?: boolean; onFinished?: () => void; } ): { success: boolean; duration: number }
ICharacterAnimationController.isPriorityAnimationPlaying?(): boolean
ICharacterAnimationController.setHasObjectAttachedToHandCallback?(callback: (() => boolean) | null): void
ICharacterAnimationController.loadAnimationPack?( animations: BaseAnimationDefinition[], options?: { addToAttackCollection?: boolean; replaceLocomotion?: boolean } ): Promise<void>
ICharacterAnimationController.loadDeferredMixamoAnimations?(): Promise<void>
ICharacterAnimationController.hasAttackAnimations?(): boolean
ICharacterAnimationController.registerCustomAttack?(move: CustomAttackMove): boolean
ICharacterAnimationController.unregisterCustomAttack?(name: string): boolean
ICharacterAnimationController.loadCustomAttackMoves?( customMoves: CustomAttackMove[] ): Promise<void>
ICharacterAnimationController.getRegisteredAttackMoves?(): string[]
ICharacterAnimationController.getAttackMoveConfig?(moveName: string): CustomAttackMove | null
ICharacterAnimationController.startNamedAttack?(moveName: string): AttackResult
ICharacterAnimationController.setAttackStartedListener?( listener: ((info: { moveName: string; duration: number }) => void) | null, ): void
ICharacterAnimationController.setAnimationOverride?(state: string, source: string): boolean
ICharacterAnimationController.clearAnimationOverride?(state: string): void
ICharacterAnimationController.clearAnimationOverrides?(): void
ICharacterAnimationController.getAnimationOverrides?(): Map<string, string>
ICharacterAnimationController.setCustomAnimationBodyBlend?(blend: { upperBody: number; lowerBody: number } | null): void
ICharacterAnimationController.getCustomAnimationBodyBlend?(): { upperBody: number; lowerBody: number } | null
ICharacterAnimationController.setManualBoneOffsets?(offsets: Map<string, import('three').Quaternion> | null): void
ICharacterAnimationController.getManualBoneOffsets?(): Map<string, import('three').Quaternion> | null
ICharacterAnimationController.setRetainFullSkeleton?(retain: boolean): void
ICharacterAnimationController.setFootIkTargets?(targets: import('engine/loaders/LegIK.js').LegIkTargets | null): void
ICharacterAnimationController.getFootIkTargets?(): import('engine/loaders/LegIK.js').LegIkTargets | null
ICharacterAnimationController.getTrackAMixamoPlayer?(): import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null
ICharacterAnimationController.getTrackBMixamoPlayer?(): import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null
ICharacterAnimationController.getFadingOutTrackAPlayer?(): import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer | null
ICharacterAnimationController.getFadingOutCrossfadeProgress?(): number

## engine/MixamoAnimationPlayer.ts
interface MixamoAnimationState
MixamoAnimationState.isPlaying: boolean
MixamoAnimationState.progress: number
MixamoAnimationState.duration: number
interface MixamoPlayerLoadOptions — Per-load options. Every member is optional so existing callers are unchanged.
MixamoPlayerLoadOptions.retainFullSkeleton?: boolean
class MixamoAnimationPlayer
MixamoAnimationPlayer.getContactCheckPhases(fallback: readonly number[]): readonly number[]
MixamoAnimationPlayer.load(url: string, loader: GLTFLoader, scene: THREE.Scene, playerPositionRef: THREE.Object3D, targetHeight: number = MIXAMO_DEFAULT_HEIGHT, options?: MixamoPlayerLoadOptions): Promise<boolean>
MixamoAnimationPlayer.loadFromGLTF(cachedScene: THREE.Group, cachedAnimations: THREE.AnimationClip[], scene: THREE.Scene, playerPositionRef: THREE.Object3D, targetHeight: number = MIXAMO_DEFAULT_HEIGHT, options?: MixamoPlayerLoadOptions): boolean
MixamoAnimationPlayer.getPlayRevision(): number
MixamoAnimationPlayer.play(onComplete?: () => void, blendInDuration?: number, blendOutDuration?: number): void
MixamoAnimationPlayer.stop(): void
MixamoAnimationPlayer.syncSkeletonToPlayer(): void
MixamoAnimationPlayer.update(deltaTime: number): void
MixamoAnimationPlayer.enableRootMotion(callback: (displacement: THREE.Vector3) => void): void
MixamoAnimationPlayer.disableRootMotion(): void
MixamoAnimationPlayer.getBlendWeight(): number
MixamoAnimationPlayer.isBlending(): boolean
MixamoAnimationPlayer.getBoneWorldPosition(partName: string, target: THREE.Vector3): boolean
MixamoAnimationPlayer.getImpactFraction(): number | null
MixamoAnimationPlayer.getImpactPart(): string | null
MixamoAnimationPlayer.getBoneWorldQuaternion(partName: string, target: THREE.Quaternion): boolean
MixamoAnimationPlayer.getSkeletonRoot(): THREE.Object3D | null
MixamoAnimationPlayer.getBoneMap(): Map<string, THREE.Bone>
MixamoAnimationPlayer.getAnimatedBoneNames(): Set<string>
MixamoAnimationPlayer.getPosedBoneNames(): ReadonlySet<string>
MixamoAnimationPlayer.isPlaying(): boolean
MixamoAnimationPlayer.setLocomotionMode(enabled: boolean): void
MixamoAnimationPlayer.setHoldLastFrame(hold: boolean): void
MixamoAnimationPlayer.getNativeLocomotionSpeed(): number
MixamoAnimationPlayer.setDesignSpeed(speed: number): void
MixamoAnimationPlayer.filterAllRootMotion(): void
MixamoAnimationPlayer.restoreRootMotion(): void
MixamoAnimationPlayer.synchronizeLocomotionFrom(other: MixamoAnimationPlayer): void
MixamoAnimationPlayer.getLocomotionContactPhase(): number | null
MixamoAnimationPlayer.setLoop(loop: boolean): void
MixamoAnimationPlayer.setSpeed(speed: number): void
MixamoAnimationPlayer.getSpeed(): number
MixamoAnimationPlayer.setTime(time: number): void
MixamoAnimationPlayer.getTime(): number
MixamoAnimationPlayer.getDuration(): number
MixamoAnimationPlayer.setAnimationName(name: string): void
MixamoAnimationPlayer.getAnimationName(): string
MixamoAnimationPlayer.getRestHipsOffset(): THREE.Vector3 | null
MixamoAnimationPlayer.getRestRotations(): ReadonlyMap<string, THREE.Quaternion>
MixamoAnimationPlayer.getAuthoredFootLift(): number | null
MixamoAnimationPlayer.dispose(): void

## engine/SkeletonAliases.ts
const CANONICAL_BONE_NAMES: Record<string, string[]>
function findBoneByCandidates(root: THREE.Object3D, candidates: readonly string[]): THREE.Object3D | null
function applyCanonicalBoneAliases(playerRoot: THREE.Object3D): number
