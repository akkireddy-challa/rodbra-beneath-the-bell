# engine-api-loaders

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/loaders/ArmGripIK.ts
interface ArmGrip — Two-bone arm IK for skinned characters gripping a weapon.
ArmGrip.target: THREE.Object3D
ArmGrip.offset: THREE.Vector3
ArmGrip.rotation: THREE.Euler
function resolveArmBones(root: THREE.Object3D, side: 'left' | 'right'): ArmBones | null
function solveArmGrip(root: THREE.Object3D, side: 'left' | 'right', bones: ArmBones, grip: ArmGrip): void

## engine/loaders/AuthoredHipsHeight.ts
function authoredHipsHeight(pose: AnimationPose | null, source: MixamoAnimationPlayer | null | undefined, frame: THREE.Object3D, hipsName: string | undefined, restHips: THREE.Vector3 | null = source?.getRestHipsOffset() ?? null): { position: number; offset: number } | null

## engine/loaders/BlockGrounding.ts
class BlockGrounding — Stable rest-height calibration for boxes. Posed bounds may correct a leg's
BlockGrounding.hips: THREE.Object3D | null
BlockGrounding.constructor(private readonly renderer: BlockCharacterRenderer, private readonly skeleton: THREE.Object3D)
BlockGrounding.measureSoles(): number
BlockGrounding.shift(groundY: number, authored: { position: number; offset: number } | null): number | null
BlockGrounding.clearFeet(groundY: number): void

## engine/loaders/BmCharacterPosture.ts
function applyBmCharacterPosture(sceneRoot: THREE.Object3D, controller: { setManualBoneOffsets?(offsets: Map<string, THREE.Quaternion> | null): void }): boolean

## engine/loaders/CharacterClassedMaterials.ts
function applyClassedCharacterMaterials(root: THREE.Object3D, quality: MaterialQuality): number

## engine/loaders/CharacterLoader.ts
class CharacterLoader — CharacterLoader - Base class for loading and managing animated block characters
CharacterLoader.constructor(engine: EngineLike)
CharacterLoader.setAnimationController(controller: CharacterAnimationController): void
CharacterLoader.setCapsuleDimensions(height: number, radius: number): void
CharacterLoader.setFeetOffset(offset: number): void
CharacterLoader.adjustSkeletonPosition(skeleton: THREE.Object3D): void
CharacterLoader.createBlockCharacter(skeleton: THREE.Object3D, factory: IBlockCharacterFactory, armatureRotation?: THREE.Quaternion | null, modelForward?: THREE.Vector3, sizeCapsuleFromBlock: boolean = true): void
CharacterLoader.applyBlockPartMaterial(child: THREE.Object3D): void
CharacterLoader.recomputeBlockFeetOffset(): boolean
static CharacterLoader.detectArmatureRotation(skeleton: THREE.Object3D): THREE.Quaternion | null
CharacterLoader.updateBlockCharacter(characterWorldPos: THREE.Vector3): void
static CharacterLoader.FOOT_BONE_NAMES: readonly string[]
CharacterLoader.updateSkinnedCharacter(characterWorldPos: THREE.Vector3): void
static CharacterLoader.applyPoseRotations(root: THREE.Object3D, pose: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>, retargetDeltas: ReadonlyMap<string, THREE.Quaternion> | null = null): void
CharacterLoader.createPhysicsBody(position: THREE.Vector3, physicsWorld: PhysicsWorld, gravity: number = -35.0, collisionGroup: number = CollisionGroup.PLAYER, collisionMask: number = CollisionMask.PLAYER): RAPIER.RigidBody
CharacterLoader.enableGravity(body: RAPIER.RigidBody): void
CharacterLoader.getTargetGravityScale(): number
CharacterLoader.syncCharacterWithPhysics(characterGroup: THREE.Group, physicsBody: RAPIER.RigidBody, positionOverride?: RenderSyncPosition): void
CharacterLoader.getBlockCharacterRenderer(): BlockCharacterRenderer | null
CharacterLoader.getCapsuleHeight(): number
CharacterLoader.getCapsuleRadius(): number
CharacterLoader.getBlockFeetOffset(): number
CharacterLoader.getPhysicsCenterYForFeet(feetWorldY: number): number
CharacterLoader.getFeetWorldYFromPhysicsTranslation(translationY: number): number
CharacterLoader.setCharacterGroup(group: THREE.Group): void
CharacterLoader.setSkinnedSkeletonRoot(root: THREE.Object3D): void
CharacterLoader.getSkinnedSkeletonRoot(): THREE.Object3D | null
CharacterLoader.setSkinnedArmGrip(side: 'left' | 'right', target: THREE.Object3D, offset: THREE.Vector3, rotation: THREE.Euler): void
CharacterLoader.clearSkinnedArmGrip(side: 'left' | 'right'): void
static CharacterLoader.resolveMixamoBone(standardBoneName: string, mixamoBoneMap: Map<string, THREE.Bone>): THREE.Bone | null
CharacterLoader.dispose(): void
class BlockCharacterWardrobe — The looks one character can wear — a wardrobe over a single
BlockCharacterWardrobe.constructor(private readonly loader: CharacterLoader, private readonly logPrefix: string, private readonly hiddenBodyNote: () => string | null)
BlockCharacterWardrobe.getActiveIndex(): number
BlockCharacterWardrobe.has(index: number): boolean
BlockCharacterWardrobe.load(index: number, factory: IBlockCharacterFactory): boolean
BlockCharacterWardrobe.activate(index: number): boolean
BlockCharacterWardrobe.redress(factory: IBlockCharacterFactory): boolean
BlockCharacterWardrobe.dispose(index: number): void
BlockCharacterWardrobe.disposeAll(): void

## engine/loaders/CharacterModelLoader.ts
interface LoadedCharacterModel — What a character load hands back. Deliberately the subset of GLTF the
LoadedCharacterModel.scene: THREE.Object3D
LoadedCharacterModel.animations: THREE.AnimationClip[]
interface LoadCharacterModelOptions
LoadCharacterModelOptions.rigidJointMeshes?: boolean
LoadCharacterModelOptions.bodyLod?: number
function loadCharacterModel(loader: GLTFLoader, url: string, options: LoadCharacterModelOptions = {}): Promise<LoadedCharacterModel>

## engine/loaders/FootPlant.ts
class FootPlant — Conservative stance lock. It never raises the body or copies a terrain normal
FootPlant.solve(bones: LegBones, facing: THREE.Quaternion, hit: RaycastResult, groundY: number, contactY: number, grounded: boolean, height: number, dt: number, contactWeight = 1): void
FootPlant.reset(): void
FootPlant.get isPlanted(): boolean

## engine/loaders/GltfLoaderSupport.ts
function setGltfTranscoderPath(path: string): void
function gltfTranscoderPath(): string
interface KtxCapableRenderer — Minimal shape of the renderers `KTX2Loader.detectSupport` accepts.
KtxCapableRenderer.readonly isWebGPURenderer?: boolean
KtxCapableRenderer.dispose(): void
function initGltfLoaderSupport(renderer: KtxCapableRenderer): void
function createGltfLoader(): GLTFLoader
function gltfLoaderSupportsKtx2(): boolean
function gltfLoadersAwaitingKtx2(): number
function disposeGltfLoaderSupport(): void

## engine/loaders/LegIK.ts
interface LegBones — Two-bone leg IK: plant a foot at a target (e.g. a snowboard binding) and bend
LegBones.thigh: THREE.Object3D
LegBones.shin: THREE.Object3D
LegBones.foot: THREE.Object3D
function resolveSkinnedLegBones(root: THREE.Object3D, side: 'left' | 'right'): LegBones | null
interface FootTarget
FootTarget.position: THREE.Vector3
FootTarget.quaternion: THREE.Quaternion
interface LegIkTargets — Both foot targets plus the character facing (biases the knee pole forward).
LegIkTargets.left: FootTarget
LegIkTargets.right: FootTarget
LegIkTargets.facing: THREE.Quaternion
function solveLegIK(facingQuat: THREE.Quaternion, bones: LegBones, target: FootTarget, preserveKneePlane = false): void
function solveLegIKMap(map: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>, keys: { thigh: string; shin: string; foot: string }, facingQuat: THREE.Quaternion, target: FootTarget, preserveKneePlane = false): void

## engine/loaders/PlayerLoader.ts
const PLAYER_REST_CLEARANCE_M = 0.1
const VISUAL_GROUND_SINK_M = 0.06
interface LoadPlayerOptions — Options for loadPlayer() / loadHeadlessPlayer(). All fields optional;
LoadPlayerOptions.customPhysicsBody?: RAPIER.RigidBody
class PlayerLoader extends CharacterLoader — PlayerLoader - Loads character mesh, skeleton, and animations from GLB files
PlayerLoader.constructor(engine: EngineLike, worldProfileData: WorldProfileData)
PlayerLoader.loadPlayer(options?: LoadPlayerOptions): Promise<THREE.Object3D>
PlayerLoader.loadHeadlessPlayer(options?: LoadPlayerOptions): Promise<THREE.Object3D>
PlayerLoader.prefetchPlayerAnimations(): void
PlayerLoader.isRenderingSkinnedMesh(): boolean
PlayerLoader.isHeadlessPlayer(): boolean
PlayerLoader.getPlayerBody(): RAPIER.RigidBody | null
PlayerLoader.enablePlayerGravity(): void
PlayerLoader.getCapsuleHalfHeight(): number
PlayerLoader.getFeetOffsetY(): number
PlayerLoader.getLoadedGLTF(): any
PlayerLoader.updateCapsuleDimensions(height: number, radius: number): void
PlayerLoader.recreatePhysicsBody(player: THREE.Object3D): void
PlayerLoader.getAnimationController(): CharacterAnimationController | null
PlayerLoader.applyCharacterModifications(player: THREE.Object3D, playerController: any): void
PlayerLoader.updateBlockCharacter(): void
PlayerLoader.onAfterBlockCharacterUpdate(callback: () => void): () => void
PlayerLoader.loadBlockCharacterVariant(variantIndex: number, factory: IBlockCharacterFactory): boolean
PlayerLoader.setActiveBlockCharacterVariant(variantIndex: number): boolean
PlayerLoader.redressBlockCharacter(factory: IBlockCharacterFactory): boolean
PlayerLoader.getActiveBlockCharacterVariant(): number
PlayerLoader.hasBlockCharacterVariant(variantIndex: number): boolean
PlayerLoader.dispose(): void

## engine/loaders/SkinnedCharacterMeasure.ts
function isArmBoneName(name: string): boolean
function measureSkinnedBodyWidthRatio(root: THREE.Object3D): number | null

## engine/loaders/SkinnedGrounding.ts
class SkinnedHeightFilter — A render-only, ground-relative height filter. Physics steps/teleports are
SkinnedHeightFilter.sample(target: number, characterHeight: number, dt: number): number
SkinnedHeightFilter.reset(): void
function skinnedContactWeight(footLift: number, height: number): number
class SkinnedGrounding — Authored body height and automatic contacts for real skins. No ray hit or
SkinnedGrounding.footPlants
SkinnedGrounding.constructor(private readonly root: THREE.Object3D, private readonly hips: THREE.Object3D | null, private readonly feet: readonly THREE.Object3D[])
SkinnedGrounding.place(groundY: number, footLift: number, height: number, controller: CharacterAnimationController | null, world: PhysicsWorld | null | undefined, facingObject: THREE.Object3D, authoredHipsOffset: number | null = null): void
SkinnedGrounding.reset(): void

## engine/loaders/SkinnedRigRetarget.ts
interface RigBindPose — Bind-pose facts about a skinned rig, read once from its skin.
RigBindPose.rotations: Map<string, THREE.Quaternion>
function captureRigBindPose(root: THREE.Object3D): RigBindPose | null
function buildRetargetDeltas(rigBind: Map<string, THREE.Quaternion>, sourceRest: Map<string, THREE.Quaternion>, resolveSource: (rigBoneName: string) => string | null): Map<string, THREE.Quaternion>
interface ClipRestCorrection — What re-expresses ONE clip skeleton in a rig's reference rest as its bones are
ClipRestCorrection.readonly rotations: ReadonlyMap<string, THREE.Quaternion> | null
ClipRestCorrection.readonly hipsShift: THREE.Vector3 | null
class SkinnedRetargetSpace — One skinned rig's retarget corrections across EVERY clip skeleton that plays
SkinnedRetargetSpace.constructor(private readonly rigBind: ReadonlyMap<string, THREE.Quaternion>)
SkinnedRetargetSpace.hasReference(): boolean
SkinnedRetargetSpace.getReferenceRest(): ReadonlyMap<string, THREE.Quaternion>
SkinnedRetargetSpace.getReferenceHipsRest(): THREE.Vector3 | null
SkinnedRetargetSpace.getRigDeltas(): ReadonlyMap<string, THREE.Quaternion>
SkinnedRetargetSpace.getClipCorrection(clip: object): ClipRestCorrection | null | undefined
SkinnedRetargetSpace.addClip(clip: object, clipRest: ReadonlyMap<string, THREE.Quaternion>, clipHipsRest: THREE.Vector3 | null, rigBoneNames: Iterable<string>, resolveSource: (rigBoneName: string) => string | null): ClipRestCorrection | null
class ClipBoneReader — Reads one clip skeleton's bones in a rig's reference rest for a frame: world
ClipBoneReader.begin(correction: ClipRestCorrection | null, facing: THREE.Quaternion | null): this
ClipBoneReader.position(bone: THREE.Object3D, out: THREE.Vector3): THREE.Vector3
ClipBoneReader.rotation(bone: THREE.Object3D, rigBoneName: string, out: THREE.Quaternion): THREE.Quaternion
function retargetedWorldRotation(clipWorld: THREE.Quaternion, delta: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion
const MAX_AUTHORED_FOOT_LIFT_M = 1.5
function authoredFootLift(rawLift: number | null): number
const MAX_HIPS_SWAY_M = 1.0
function authoredHipsSway(blendedHips: THREE.Vector3, restHipsWorld: THREE.Vector3, out: THREE.Vector3): THREE.Vector3

## engine/loaders/SkyboxFollow.ts
function attachSkyboxCameraFollow(mesh: THREE.Mesh): void

## engine/loaders/SkyboxFragmentShader.ts
const SkyboxFragmentShader = ` precision mediump float; #define PI 3.1415926 uniform samp

## engine/loaders/SkyboxLoader.ts
class SkyboxLoader
static SkyboxLoader.SKYBOX_NAME
SkyboxLoader.constructor(engine: EngineLike, worldProfileData: WorldProfileData)
SkyboxLoader.on<K extends keyof SkyboxLoaderEvents>(type: K, cb: SkyboxLoaderEvents[K]): () => void
SkyboxLoader.off<K extends keyof SkyboxLoaderEvents>(type: K, cb: SkyboxLoaderEvents[K]): void
SkyboxLoader.updateWorldProfileData(worldProfileData: WorldProfileData): void
SkyboxLoader.loadSkybox(worldProfileData?: WorldProfileData): Promise<void>

## engine/loaders/SkyboxMaterialHelper.ts
type SkyboxUniforms = { skyboxTexture: Uni<THREE.Texture>; texelSize: Uni<THREE.Vector2>; mainRotation: Uni<number>; seamFeather: Uni<number>; seamWidthMin: Uni<number>; seamWidthMax: Uni<number>; contrastLow: Uni<number>; contrastHigh: Uni<number>; screenSize: Uni<THREE.Vector2>; brightness: Uni<number>; }
type SkyboxOptions = { texelSize?: THREE.Vector2; rotationDeg?: number; seamFeather?: number; seamWidthMin?: number; seamWidthMax?: number; contrastLow?: number; contrastHigh?: number; screenSize?: THREE.Vector2; linearTexture?: boolean; /** Sky brightness multiplier (worldProfileData.lightingConfig.skyboxIntensity). 1 = authored image brightness. */ brightness?: number; }
class SkyboxMaterialHelper
static SkyboxMaterialHelper.createMaterial(tex: THREE.Texture, opts: SkyboxOptions = {}): { material: THREE.Material; uniforms: SkyboxUniforms }
static SkyboxMaterialHelper.createMesh(tex: THREE.Texture, opts: SkyboxOptions = {}): { mesh: THREE.Mesh; material: THREE.Material; uniforms: SkyboxUniforms }
static SkyboxMaterialHelper.setRotation(uniforms: SkyboxUniforms, deg: number): void
static SkyboxMaterialHelper.setBrightness(uniforms: SkyboxUniforms, brightness: number): void
static SkyboxMaterialHelper.getUniformsFromMesh(mesh: THREE.Object3D | null | undefined): SkyboxUniforms | null
static SkyboxMaterialHelper.disposeSkybox(mesh: THREE.Object3D | null | undefined): void

## engine/loaders/SkyboxVertexShader.ts
const SkyboxVertexShader = ` precision mediump float; varying vec3 vWorldPos; void main

## engine/loaders/VxlCharacterEyes.ts
interface VxlEyeLook — The COLOURS of an eye, separate from its shape (which the `.vxl` record
VxlEyeLook.sclera: number
VxlEyeLook.pupil: number
VxlEyeLook.pupilGlow: number
const DEFAULT_VXL_EYE_LOOK: VxlEyeLook
const DARK_VXL_EYE_LOOK: VxlEyeLook
const EVIL_VXL_EYE_LOOK: VxlEyeLook
function tickVxlCharacterEyesAlong(root: THREE.Object3D, deltaTime: number, direction: THREE.Vector3): void
function tickVxlCharacterEyesFromView(root: THREE.Object3D, deltaTime: number, camera: THREE.Camera | null): void
type VxlEyeBoundsMin = Pick<VxlV3Bounds, 'minX' | 'minY' | 'minZ'>
interface VxlEyeSpec — Everything needed to (re)build a character's eyes, as PLAIN DATA.
VxlEyeSpec.eyes: EyeMeta
VxlEyeSpec.bounds: VxlEyeBoundsMin
VxlEyeSpec.minVoxelSize: number
function getVxlEyeSpec(root: THREE.Object3D): VxlEyeSpec | null
function applyVxlEyeSpec(root: THREE.Object3D, spec: VxlEyeSpec): AnimalEyeController | null
function setVxlCharacterEyeLook(root: THREE.Object3D, look: VxlEyeLook): boolean
function getVxlEyeController(root: THREE.Object3D): AnimalEyeController | null
function tickVxlCharacterEyes(root: THREE.Object3D, deltaTime: number, selfPosition: THREE.Vector3, gazeTarget: THREE.Vector3 | null): void

## engine/loaders/VxlCharacterLoader.ts
interface VxlCharacterMeasurements
VxlCharacterMeasurements.height: number
VxlCharacterMeasurements.radius: number
VxlCharacterMeasurements.feetOffset: number
interface VxlCharacterTemplate
VxlCharacterTemplate.url: string
VxlCharacterTemplate.decoded: DecodedVxlV3
VxlCharacterTemplate.columns: VxlCharacterColumns
VxlCharacterTemplate.measurements: VxlCharacterMeasurements
VxlCharacterTemplate.bindBox: THREE.Box3
VxlCharacterTemplate.lod: number
VxlCharacterTemplate.materials: THREE.Material[]
interface VxlCharacterModel — A loaded character in the shape the engine's GLB path hands back.
VxlCharacterModel.scene: THREE.Object3D
VxlCharacterModel.animations: THREE.AnimationClip[]
function isVxlCharacterUrl(url: string): boolean
function measureVxlCharacter(decoded: DecodedVxlV3): VxlCharacterMeasurements
function loadVxlCharacterTemplate(url: string, lod: number = 0): Promise<VxlCharacterTemplate>
function buildVxlColumnsAtLod(decoded: DecodedVxlV3, requestedLod: number, options: Omit<BuildVxlCharacterOptions, 'lod'> = {}): { columns: VxlCharacterColumns; lod: number }
interface InstantiateVxlOptions
InstantiateVxlOptions.rigidJointMeshes?: boolean
function instantiateVxlCharacter(template: VxlCharacterTemplate, options: InstantiateVxlOptions = {}): VxlCharacterModel
function clearVxlCharacterTemplateCache(): void
