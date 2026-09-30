# engine-api-npc-2

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/npc/nav/PathRequestQueue.ts
interface PathRequest
PathRequest.key: string
PathRequest.start: THREE.Vector3
PathRequest.goal: THREE.Vector3
PathRequest.extraObstacles?: ReadonlyArray<{ x: number; z: number; radius: number }>
PathRequest.maxPathLength?: number
PathRequest.hero: boolean
PathRequest.distSq: number
PathRequest.onResult(path: THREE.Vector3[]): void
type PathFinder = ( start: THREE.Vector3, goal: THREE.Vector3, extraObstacles?: ReadonlyArray<{ x: number; z: number; radius: number }>, maxPathLength?: number, ) => THREE.Vector3[]
interface PathQueueBudget — Per-update drain budget. The binding constraint is TIME, not count: one
PathQueueBudget.msPerUpdate: number
PathQueueBudget.maxRequestsPerUpdate: number
PathQueueBudget.maxCarryOverMs: number
const DEFAULT_PATH_QUEUE_BUDGET: PathQueueBudget
class PathRequestQueue
PathRequestQueue.constructor(budget: PathQueueBudget = DEFAULT_PATH_QUEUE_BUDGET)
PathRequestQueue.submit(req: PathRequest): void
PathRequestQueue.cancel(key: string): void
PathRequestQueue.size(): number
PathRequestQueue.update(finder: PathFinder): void
function getGlobalPathQueue(): PathRequestQueue
function disposeGlobalPathQueue(): void

## engine/npc/nav/PathRequestTracker.ts
class PathRequestTracker — PathRequestTracker — sequence bookkeeping for async path requests.
PathRequestTracker.submit(): number
PathRequestTracker.land(seq: number): void
PathRequestTracker.cancelAll(): void
PathRequestTracker.isPending(): boolean
PathRequestTracker.isCurrent(seq: number): boolean

## engine/npc/utils/NpcIdNameplate.ts
class NpcIdNameplate — 🏷️ NPC ID Nameplate System
NpcIdNameplate.constructor(npcObject: THREE.Object3D, engine: EngineLike, npcId: string, offset?: THREE.Vector3)
NpcIdNameplate.update(): void
NpcIdNameplate.dispose(): void

## engine/npc/utils/NpcSpeechBubble.ts
class NpcSpeechBubble — 🗣️ NPC Speech Bubble System
NpcSpeechBubble.constructor(npcObject: THREE.Object3D, engine: EngineLike, message: string, durationMs: number = 3000, offset?: THREE.Vector3)
NpcSpeechBubble.dispose(): void

## engine/npc/visual/HumanoidVisualSystem.ts
class HumanoidVisualSystem implements INpcVisualSystem — Humanoid Visual System
HumanoidVisualSystem.constructor(engine: EngineLike, gltf: any, baseAnimations: BaseAnimationDefinition[])
HumanoidVisualSystem.loadModel(): Promise<any>
HumanoidVisualSystem.getModel(): any
HumanoidVisualSystem.createAnimationController(): CharacterAnimationController
HumanoidVisualSystem.initializeAnimations(character: THREE.Object3D, gltf: any, loader: any, baseAnimations: BaseAnimationDefinition[]): Promise<void>
HumanoidVisualSystem.createMovementSystem(moveSpeed: number): IPlayerMovement
HumanoidVisualSystem.createBlockCharacterFactory(): IBlockCharacterFactory
HumanoidVisualSystem.getRootBoneName(): string | string[]
HumanoidVisualSystem.adjustSkeletonPosition(skeleton: THREE.Object3D): void
HumanoidVisualSystem.getDisplayName(): string
HumanoidVisualSystem.getBaseAnimations(): BaseAnimationDefinition[]
HumanoidVisualSystem.getCharacterLoader(): CharacterLoader
HumanoidVisualSystem.getAnimationController(): CharacterAnimationController | null

## engine/npc/visual/INpcVisualSystem.ts
interface INpcVisualSystem — Interface for NPC visual systems
INpcVisualSystem.loadModel(): Promise<any>
INpcVisualSystem.getModel(): any
INpcVisualSystem.createAnimationController(): any
INpcVisualSystem.initializeAnimations( character: THREE.Object3D, gltf: any, loader: any, baseAnimations: BaseAnimationDefinition[] ): Promise<void>
INpcVisualSystem.createMovementSystem(moveSpeed: number): IPlayerMovement
INpcVisualSystem.createBlockCharacterFactory(): IBlockCharacterFactory
INpcVisualSystem.getRootBoneName(): string | string[]
INpcVisualSystem.adjustSkeletonPosition(skeleton: THREE.Object3D): void
INpcVisualSystem.getDisplayName(): string
INpcVisualSystem.getBaseAnimations(): BaseAnimationDefinition[]
