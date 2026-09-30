# engine-api-hero

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/hero/CharacterEyeController.ts
interface CharacterEyeFrame
CharacterEyeFrame.yaw: number
CharacterEyeFrame.pitch: number
CharacterEyeFrame.blinkLeft: number
CharacterEyeFrame.blinkRight: number
const NEUTRAL_CHARACTER_EYE_FRAME: Readonly<CharacterEyeFrame>
class CharacterEyeController — Explicit optical-eye nodes use local +Z forward, +Y up. Angles are radians.
CharacterEyeController.constructor(root: Object3D)
CharacterEyeController.get eyeCount(): number
CharacterEyeController.get lidBindingCount(): number
CharacterEyeController.setFrame(frame: Readonly<CharacterEyeFrame>): void
CharacterEyeController.reset(): void

## engine/hero/CharacterSurfaceMaterials.ts
function createCharacterSurfaceMaterial(source: THREE.Material, atlas?: THREE.Texture, transmission?: SkinTransmissionPass, expressionAtlas?: THREE.Texture, appearance = new SkinAppearanceState(), facial?: FacialDetailTextures): THREE.Material

## engine/hero/HeroCharacter.ts
class HeroCharacter — Opt-in adapter for an engine-loaded skinned root. Body animation remains engine-owned.
HeroCharacter.face: HeroFaceController
HeroCharacter.constructor(readonly root: THREE.Object3D, readonly definition: HeroCharacterDefinition)
HeroCharacter.dispose(): void

## engine/hero/HeroCharacterDefinition.ts
interface HeroCharacterDefinition — Independently versioned, opt-in contract. No MetaHuman/DNA dependency.
HeroCharacterDefinition.type: 'hero-character'
HeroCharacterDefinition.version: 1
HeroCharacterDefinition.id: string
HeroCharacterDefinition.surfaces: HeroSurface[]
HeroCharacterDefinition.controls: Record<string, HeroMorphBinding[]>
HeroCharacterDefinition.correctives: HeroCorrective[]
interface HeroSurface
HeroSurface.material: string
HeroSurface.kind: 'skin' | 'cloth' | 'leather' | 'hair' | 'fur' | 'eye' | 'teeth' | 'metal' | 'other'
HeroSurface.roughness: number
HeroSurface.specularIntensity: number
HeroSurface.scatter: { color: string; strength: number }
interface HeroMorphBinding
HeroMorphBinding.mesh: string
HeroMorphBinding.target: string
HeroMorphBinding.gain: number
interface HeroCorrective
HeroCorrective.drivers: string[]
HeroCorrective.binding: HeroMorphBinding
function validateHeroDefinition(d: HeroCharacterDefinition): void

## engine/hero/HeroFaceController.ts
class HeroFaceController — Call after the body's animation update. Owns only explicitly bound morph slots.
HeroFaceController.constructor(root: THREE.Object3D, definition: HeroCharacterDefinition)
HeroFaceController.setFrame(frame: Readonly<Record<string, number>>): void
HeroFaceController.advance(deltaSeconds: number, responseSeconds: number): void
HeroFaceController.reset(): void

## engine/hero/HeroMaterials.ts
function createHeroMaterial(source: THREE.MeshStandardMaterial, surface: HeroSurface): THREE.Material

## engine/hero/RealisticCharacter.ts
interface RealisticCharacterOptions
RealisticCharacterOptions.resolveTexture: (index: number) => Promise<THREE.Texture>
RealisticCharacterOptions.environment: THREE.Texture | null
RealisticCharacterOptions.environmentIntensity: number
RealisticCharacterOptions.detailEnabled: boolean
RealisticCharacterOptions.transmission: SkinTransmissionPass | undefined
RealisticCharacterOptions.appearance: SkinAppearanceState
class RealisticCharacter — Opt-in material/eye adoption for an already-loaded authored character.
RealisticCharacter.eyes: CharacterEyeController
RealisticCharacter.detailTextures
RealisticCharacter.hasExpressionMaps
static RealisticCharacter.create(root: THREE.Object3D, options: RealisticCharacterOptions): Promise<RealisticCharacter>
RealisticCharacter.dispose(): void

## engine/hero/SkinAppearanceState.ts
class SkinAppearanceState — Material-only appearance controls. A facial rig can drive these alongside its
SkinAppearanceState.weights
SkinAppearanceState.setFrame(frame: Readonly<Record<string, number>>): void

## engine/hero/SkinAtlasDetail.ts
interface FacialDetailTextures — Left half: facial detail RGBA; right half: expression RGBA. Replaces the
FacialDetailTextures.atlas: THREE.Texture
function copySkinAtlasBinding(source: THREE.Material, target: THREE.Material): void
function skinAtlasCoverageNode(material: THREE.Material): Node<'float'>
function configureSkinCoveragePass(source: THREE.Material, target: THREE.Material, channel: 'alpha' | 'color'): void
function configureSkinAtlasPigment(source: THREE.Material, target: THREE.Material): void
function configureSkinAtlasDetail(material: THREE.MeshPhysicalMaterial | MeshPhysicalNodeMaterial, atlas: THREE.Texture, heightRangeM: number, expression: THREE.Texture, state: SkinAppearanceState, facial?: FacialDetailTextures): void

## engine/hero/SkinDiffusionKernel.ts
interface SkinKernelTap — Adapted from iryoku/separable-sss Demo/Code/SeparableSSS.cpp (2012 demo).
SkinKernelTap.offset: number
SkinKernelTap.weight: [number, number, number]
function createSkinDiffusionKernel(falloff: readonly number[] = [1, 0.55, 0.3], strength: readonly number[] = [0.48, 0.41, 0.28], count = 25): SkinKernelTap[]

## engine/hero/SkinDiffusionPass.ts
class SkinDiffusionPass — Screen-space, depth-gated separable diffuse transport. World units are metres.
SkinDiffusionPass.radiusMm
SkinDiffusionPass.strength
SkinDiffusionPass.profile
SkinDiffusionPass.constructor()
SkinDiffusionPass.render(renderer: THREE.WebGLRenderer | WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void
SkinDiffusionPass.releaseMaterials(): void
SkinDiffusionPass.dispose(): void

## engine/hero/SkinMicroDetail.ts
function skinPoreTexture(): THREE.DataTexture
function configureSkinMicroDetail(material: THREE.MeshPhysicalMaterial | MeshPhysicalNodeMaterial): void

## engine/hero/SkinTransmission.ts
function skinTransmissionNode(pass: SkinTransmissionPass, light: Node<'vec3'>): Node<'vec3'>
const SKIN_TRANSMISSION_GLSL = ` uniform mat4 skinLightMatrix; uniform sampler2D skinEntryD

## engine/hero/SkinTransmissionPass.ts
class SkinTransmissionPass — Light-facing skin entry depth. One directional key light; other geometry is an
SkinTransmissionPass.target
SkinTransmissionPass.matrix
SkinTransmissionPass.direction
SkinTransmissionPass.camera
SkinTransmissionPass.enabled
SkinTransmissionPass.constructor()
SkinTransmissionPass.render(renderer: THREE.WebGLRenderer | WebGPURenderer, scene: THREE.Scene, character: THREE.Object3D, key: THREE.DirectionalLight): void
SkinTransmissionPass.releaseMaterials(): void
SkinTransmissionPass.dispose(): void
