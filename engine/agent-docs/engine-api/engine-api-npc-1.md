# engine-api-npc-1

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/npc/INpcBehavior.ts
const DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y = 1.6
function createNpcFocusTarget(npcPosition: THREE.Vector3, focusOffsetY: number): THREE.Vector3
interface INpcBehavior — Interface for pluggable NPC behavior systems.
INpcBehavior.focusOffsetY: number
INpcBehavior.initialize(controller: ICharacterContext): void
INpcBehavior.update( deltaTime: number, currentPosition: THREE.Vector3, currentTarget: THREE.Vector3 | null ): THREE.Vector3 | null
INpcBehavior.onPoseUpdated?(): void
INpcBehavior.onEntityDetected?(entity: THREE.Object3D, distance: number): void
INpcBehavior.onHit?(impactDirection?: THREE.Vector3): boolean
INpcBehavior.onNpcDeath?(): void
INpcBehavior.onTargetReached?(): void
INpcBehavior.onPlayerInteract?(): boolean
INpcBehavior.getName(): string
INpcBehavior.isHostile(): boolean
INpcBehavior.isEngaged?(): boolean
INpcBehavior.canTalkToPlayer?(): boolean
INpcBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
INpcBehavior.dispose(): void
INpcBehavior.usesDirectTargets?(): boolean
INpcBehavior.clone?(): INpcBehavior

## engine/npc/INpcManagerBehavior.ts
interface INpcManagerBehavior — Interface for NPC manager behavior strategies
INpcManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void
INpcManagerBehavior.onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean
INpcManagerBehavior.onNpcDestroyed?(npc: NpcController, engine: EngineLike): void
INpcManagerBehavior.getRespawnDelay(): number
INpcManagerBehavior.shouldAutoRespawn(): boolean
INpcManagerBehavior.getName(): string
class BaseNpcManagerBehavior implements INpcManagerBehavior — Base class with default implementations for common behavior patterns
BaseNpcManagerBehavior.constructor(name: string, autoRespawn: boolean = false, respawnDelay: number = 0, npcBehavior: INpcBehavior | null = null)
BaseNpcManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void
BaseNpcManagerBehavior.onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean
BaseNpcManagerBehavior.onNpcDestroyed(npc: NpcController, engine: EngineLike): void
BaseNpcManagerBehavior.getRespawnDelay(): number
BaseNpcManagerBehavior.shouldAutoRespawn(): boolean
BaseNpcManagerBehavior.getName(): string
class SimpleNpcManagerBehavior extends BaseNpcManagerBehavior — SIMPLIFIED: Helper class for the simplest case - just pass NPC behavior!
SimpleNpcManagerBehavior.constructor(name: string, npcBehavior: INpcBehavior, autoRespawn: boolean = false, respawnDelay: number = 5.0)

## engine/npc/behaviors/NpcChaseBehavior.ts
class NpcChaseBehavior implements INpcBehavior — NpcChaseBehavior - Goal-field-driven hostile chase behavior
NpcChaseBehavior.focusOffsetY: number
NpcChaseBehavior.constructor(config: { target: 'player'; fieldKey?: string; stopDistanceM?: number; stepAheadM?: number; focusOffsetY?: number; })
NpcChaseBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
NpcChaseBehavior.clone(): INpcBehavior
NpcChaseBehavior.initialize(controller: ICharacterContext): void
NpcChaseBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, _currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
NpcChaseBehavior.getName(): string
NpcChaseBehavior.isHostile(): boolean
NpcChaseBehavior.usesDirectTargets(): boolean
NpcChaseBehavior.dispose(): void

## engine/npc/behaviors/NpcEnemyBehavior.ts
class NpcEnemyBehavior implements INpcBehavior — NpcEnemyBehavior - A roaming enemy: wanders near its spawn, chases and punches
NpcEnemyBehavior.focusOffsetY: number
NpcEnemyBehavior.constructor(config?: NpcMeleeAttackConfig & { worldBounds?: number; retargetInterval?: number; idleDuration?: number; focusOffsetY?: number; })
NpcEnemyBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
NpcEnemyBehavior.clone(): INpcBehavior
NpcEnemyBehavior.initialize(controller: ICharacterContext): void
NpcEnemyBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
NpcEnemyBehavior.usesDirectTargets(): boolean
NpcEnemyBehavior.onHit(): boolean
NpcEnemyBehavior.getName(): string
NpcEnemyBehavior.isHostile(): boolean
NpcEnemyBehavior.isEngaged(): boolean
NpcEnemyBehavior.dispose(): void

## engine/npc/behaviors/NpcFollowBehavior.ts
class NpcFollowBehavior implements INpcBehavior — NpcFollowBehavior - Follow a target entity (player or another NPC)
NpcFollowBehavior.focusOffsetY: number
NpcFollowBehavior.constructor(config: { target: THREE.Object3D | 'player'; minDistance?: number; maxDistance?: number; updateInterval?: number; focusOffsetY?: number; })
NpcFollowBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
NpcFollowBehavior.clone(): INpcBehavior
NpcFollowBehavior.initialize(controller: ICharacterContext): void
NpcFollowBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
NpcFollowBehavior.setTarget(target: THREE.Object3D | 'player'): void
NpcFollowBehavior.getName(): string
NpcFollowBehavior.isHostile(): boolean
NpcFollowBehavior.dispose(): void

## engine/npc/behaviors/NpcHostileBehavior.ts
class NpcHostileBehavior implements INpcBehavior — NpcHostileBehavior - Guard an area, chase the player on sight, punch them.
NpcHostileBehavior.focusOffsetY: number
NpcHostileBehavior.constructor(config?: NpcMeleeAttackConfig & { returnToOrigin?: boolean; updateInterval?: number; focusOffsetY?: number; })
NpcHostileBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
NpcHostileBehavior.clone(): INpcBehavior
NpcHostileBehavior.initialize(controller: ICharacterContext): void
NpcHostileBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
NpcHostileBehavior.onHit(): boolean
NpcHostileBehavior.getName(): string
NpcHostileBehavior.isHostile(): boolean
NpcHostileBehavior.dispose(): void

## engine/npc/behaviors/NpcIdleBehavior.ts
class NpcIdleBehavior implements INpcBehavior — NpcIdleBehavior - Stay in place (friendly/neutral NPC)
NpcIdleBehavior.focusOffsetY: number
NpcIdleBehavior.constructor(config?: { lookAtPlayer?: boolean; lookAtRange?: number; randomIdleMotions?: boolean; greetingMessage?: string; greetingMessages?: string[]; focusOffsetY?: number; })
NpcIdleBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
NpcIdleBehavior.clone(): INpcBehavior
NpcIdleBehavior.initialize(controller: ICharacterContext): void
NpcIdleBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
NpcIdleBehavior.onPlayerInteract(): boolean
NpcIdleBehavior.getName(): string
NpcIdleBehavior.isHostile(): boolean
NpcIdleBehavior.dispose(): void

## engine/npc/behaviors/NpcMeleeAttack.ts
interface NpcMeleeWeaponConfig — The weapon half of the config — see `NpcMeleeAttackConfig.weapon`.
NpcMeleeWeaponConfig.type: WeaponTypeId
interface NpcMeleeAttackConfig
NpcMeleeAttackConfig.detectionRange?: number
NpcMeleeAttackConfig.loseInterestRange?: number
NpcMeleeAttackConfig.attackRange?: number
NpcMeleeAttackConfig.attackCooldown?: number
NpcMeleeAttackConfig.damage?: number
NpcMeleeAttackConfig.chaseSpeed?: number
NpcMeleeAttackConfig.attacksPlayer?: boolean
NpcMeleeAttackConfig.weapon?: NpcMeleeWeaponConfig
NpcMeleeAttackConfig.findTargets?: () => readonly NpcMeleeTarget[]
type ResolvedNpcMeleeAttackConfig = Required<Omit<NpcMeleeAttackConfig, 'findTargets' | 'weapon'>> & Pick<NpcMeleeAttackConfig, 'findTargets' | 'weapon'>
const DEFAULT_NPC_MELEE_ATTACK: Readonly<Omit<ResolvedNpcMeleeAttackConfig, 'loseInterestRange' | 'findTargets' | 'weapon'>>
function resolveNpcMeleeAttackConfig(config?: NpcMeleeAttackConfig): ResolvedNpcMeleeAttackConfig
type NpcEngagement = | { readonly state: 'disengaged' } /** Target seen but out of reach — move toward `targetPosition` (already a clone, * safe to hand straight back from `update()`). */ | { readonly state: 'chase'; readonly targetPosition: THREE.Vector3; readonly target: NpcMeleeTarget } /** In reach or mid-strike — the behavior must return `null` so the NPC holds still. */ | { readonly state: 'attack'; readonly targetPosition: THREE.Vector3; readonly target: NpcMeleeTarget }
class NpcMeleeAttack
NpcMeleeAttack.constructor(config?: NpcMeleeAttackConfig)
NpcMeleeAttack.initialize(controller: ICharacterContext): void
NpcMeleeAttack.setWeapon(type: WeaponTypeId): boolean
NpcMeleeAttack.update(deltaTime: number, npcPosition: THREE.Vector3): NpcEngagement
NpcMeleeAttack.cancelSwing(): void
NpcMeleeAttack.dispose(): void

## engine/npc/behaviors/NpcMeleeTarget.ts
const DEFAULT_MELEE_TARGET_HEIGHT = 1.8
const DEFAULT_MELEE_TARGET_RADIUS = 0.4
interface NpcMeleeTarget
NpcMeleeTarget.readonly isPlayer: boolean
NpcMeleeTarget.getPosition(): THREE.Vector3 | null
NpcMeleeTarget.getFeetPosition(): THREE.Vector3 | null
NpcMeleeTarget.getCapsuleHeight(): number
NpcMeleeTarget.getCapsuleRadius(): number
NpcMeleeTarget.isDead(): boolean
NpcMeleeTarget.takeDamage(damage: number, source: string): void
function segmentHitsTarget(from: THREE.Vector3, to: THREE.Vector3, target: NpcMeleeTarget, extraRadius: number): boolean
function playerMeleeTarget(player: PlayerControllerLike | null | undefined): NpcMeleeTarget | null
function npcMeleeTarget(npc: NpcControllerLike): NpcMeleeTarget

## engine/npc/behaviors/NpcPatrolBehavior.ts
class NpcPatrolBehavior implements INpcBehavior — NpcPatrolBehavior - Patrol between predefined waypoints
NpcPatrolBehavior.focusOffsetY: number
NpcPatrolBehavior.constructor(config: { waypoints: THREE.Vector3[]; waitTimeAtWaypoint?: number; patrolMode?: 'circular' | 'ping-pong'; detectPlayerRange?: number; chaseBehaviorConfig?: { detectionRange?: number; attackRange?: number; chaseSpeed?: number; returnToOrigin?: boolean; updateInterval?: number; }; focusOffsetY?: number; })
NpcPatrolBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
NpcPatrolBehavior.clone(): INpcBehavior
NpcPatrolBehavior.initialize(controller: ICharacterContext): void
NpcPatrolBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
NpcPatrolBehavior.onTargetReached(): void
NpcPatrolBehavior.getName(): string
NpcPatrolBehavior.isHostile(): boolean
NpcPatrolBehavior.dispose(): void

## engine/npc/behaviors/NpcShopkeeperBehavior.ts
class NpcShopkeeperBehavior implements INpcBehavior — NpcShopkeeperBehavior - Friendly shopkeeper with greeting and interaction
NpcShopkeeperBehavior.focusOffsetY: number
NpcShopkeeperBehavior.constructor(config: { shopPosition: THREE.Vector3; greetingRange?: number; interactionRange?: number; greetingCooldown?: number; onPlayerInteract?: () => void; shopkeeperName?: string; idleAnimations?: string[]; focusOffsetY?: number; })
NpcShopkeeperBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
NpcShopkeeperBehavior.initialize(controller: ICharacterContext): void
NpcShopkeeperBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
NpcShopkeeperBehavior.onPlayerInteract(): boolean
NpcShopkeeperBehavior.onHit(impactDirection?: THREE.Vector3): boolean
NpcShopkeeperBehavior.getName(): string
NpcShopkeeperBehavior.isHostile(): boolean
NpcShopkeeperBehavior.dispose(): void

## engine/npc/behaviors/NpcVillagerBehavior.ts
class NpcVillagerBehavior implements INpcBehavior — NpcVillagerBehavior - Friendly villager with speech bubble interactions
NpcVillagerBehavior.focusOffsetY: number
NpcVillagerBehavior.constructor(config?: { greetingMessages?: string[]; greetingMessage?: string; lookAtPlayer?: boolean; lookAtRange?: number; followAfterInteraction?: boolean; followConfig?: { minDistance?: number; maxDistance?: number; updateInterval?: number; }; focusOffsetY?: number; })
NpcVillagerBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
NpcVillagerBehavior.clone(): INpcBehavior
NpcVillagerBehavior.initialize(controller: ICharacterContext): void
NpcVillagerBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
NpcVillagerBehavior.onPlayerInteract(): boolean
NpcVillagerBehavior.getName(): string
NpcVillagerBehavior.getInteractDisplayName(): string
NpcVillagerBehavior.isHostile(): boolean
NpcVillagerBehavior.dispose(): void

## engine/npc/core/NpcController.ts
class NpcController implements Interactable, IDamageable, ChunkManagedObject, ICharacterContext, LodManagedCharacter — NpcController - AI-controlled NPC character with physics and collision handling
NpcController.lodState: CharacterLodState
NpcController.onMeleeHitEffect: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void
NpcController.onProjectileHitEffect: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void
NpcController.get onDamage()
NpcController.set onDamage(cb: ((damage: number, currentHealth: number, maxHealth: number, source?: string) => void) | undefined)
NpcController.get onDeathEffect()
NpcController.set onDeathEffect(cb: ((killerDirection?: THREE.Vector3) => void) | undefined)
NpcController.onMeleeHit: (impactDirection?: THREE.Vector3, impulseStrength?: number) => void
static NpcController.create(scene: THREE.Scene, physicsWorld: PhysicsWorld, engine: EngineLike, spawnPosition: THREE.Vector3, playerGLTF: any, characterCreator: (characterGroup: THREE.Group) => { width: number; height: number; depth: number }, moveSpeed: number = 2.7, stunDuration: number = 0.5, baseAnimations?: any[], movementSystem?: IPlayerMovement, npcId?: string, renderSkinned: boolean = false, modelRotationY: number = 0, damageableConfig?: Partial<DamageableConfig>): Promise<NpcController>
static NpcController.createWithVisualSystem(scene: THREE.Scene, physicsWorld: PhysicsWorld, engine: EngineLike, spawnPosition: THREE.Vector3, visualSystem: INpcVisualSystem, blockCharacterFactory: IBlockCharacterFactory, moveSpeed: number = 2.7, stunDuration: number = 0.5, movementSystem?: IPlayerMovement, npcId?: string, renderSkinned: boolean = false, modelRotationY: number = 0, damageableConfig?: Partial<DamageableConfig>): Promise<NpcController>
NpcController.setBehavior(behavior: INpcBehavior): void
NpcController.requestBehaviorChange(newBehavior: INpcBehavior): void
NpcController.setTargetPosition(target: THREE.Vector3 | null, maxPathLength?: number): void
NpcController.getCurrentPath(): THREE.Vector3[]
NpcController.getEngine(): EngineLike
NpcController.getPhysicsWorld(): PhysicsWorld
NpcController.getNavMesh(): LegacyNavMesh | null
NpcController.setMaxStepUpHeight(height: number): void
NpcController.getMaxStepUpHeight(): number
NpcController.setStepHopEnabled(enabled: boolean): void
NpcController.isStepHopEnabled(): boolean
NpcController.setRotationSpeed(radiansPerSecond: number): void
NpcController.getRotationSpeed(): number
NpcController.setMoveSpeed(speed: number): void
NpcController.getMoveSpeed(): number
NpcController.buildSkiHost(): SkiMovementHost
NpcController.setMovementSystem(movementSystem: IPlayerMovement): void
NpcController.setArrivalRadius(radius: number): void
NpcController.getArrivalRadius(): number
NpcController.setAvoidanceEnabled(enabled: boolean): void
NpcController.isAvoidanceEnabled(): boolean
NpcController.setStraightLinePath(enabled: boolean): void
NpcController.isStraightLinePath(): boolean
NpcController.getCurrentSpeed(): number
NpcController.setDebrisLifetime(ms: number): void
NpcController.setBoneVoxelShatterOptions(options: Partial<BoneVoxelShatterOptions>): void
NpcController.shatterIntoVoxels(): boolean
NpcController.getExplodedDebris(): { mesh: THREE.Mesh; body: RAPIER.RigidBody }[]
NpcController.removeDebrisPiece(mesh: THREE.Mesh): boolean
NpcController.getPath(): THREE.Vector3[]
NpcController.getCurrentWaypointIndex(): number
NpcController.getCurrentWaypoint(): THREE.Vector3 | null
NpcController.isFollowingPath(): boolean
NpcController.hasReachedDestination(): boolean
NpcController.update(deltaTime: number): void
static NpcController.avoidanceMs
static NpcController.poseMs
static NpcController.moveMs
static NpcController.takeAvoidanceMs(): number
static NpcController.takePoseMs(): number
static NpcController.takeMoveMs(): number
NpcController.setRetreatFromPlayerOverlap(retreat: boolean): void
NpcController.onInteractStart(): boolean
NpcController.getInteractStartDisplayName(): string
NpcController.interactionEnabled(): boolean
NpcController.setInteractionEnabledOverride(callback: (() => boolean) | null): void
NpcController.hibernate(): void
NpcController.wake(): void
NpcController.isHibernating(): boolean
NpcController.holdPhysicsUntilReady(): void
NpcController.setImportance(importance: 'hero' | 'crowd'): void
NpcController.setPlaneLockEnabled(enabled: boolean): void
NpcController.getImportance(): 'hero' | 'crowd'
NpcController.resetLodToFull(): void
NpcController.hasActiveGoal(): boolean
NpcController.getCrowdX(): number
NpcController.getCrowdZ(): number
NpcController.getCrowdRadius(): number
NpcController.getCrowdMobility(): number
NpcController.isCrowdActive(): boolean
NpcController.applyCrowdSeparation(dx: number, dz: number): void
NpcController.getCrowdY(): number
NpcController.getCrowdYaw(): number
NpcController.getCrowdFrameRow(): number
NpcController.getCrowdColor(): THREE.Color
NpcController.getCrowdScale(): number
NpcController.isRenderedByCrowd(): boolean
NpcController.onLodChanged(prev: CharacterLodState, next: CharacterLodState): void
NpcController.isDeadOrRagdolled(): boolean
NpcController.getLodDebugInfo(): string
NpcController.setAlwaysActive(active: boolean): void
NpcController.isAlwaysActive(): boolean
NpcController.canHibernate(): boolean
NpcController.releasePhysics(): void
NpcController.dispose(): void
NpcController.getPhysicsBody(): RAPIER.RigidBody
NpcController.getPosition(): THREE.Vector3
NpcController.teleportTo(x: number, y: number, z: number): void
NpcController.hasFallenOffWorld(): boolean
NpcController.respawnAtSpawn(): void
NpcController.setAllVisualsVisible(visible: boolean): void
NpcController.getCharacter(): THREE.Object3D
NpcController.setEyeLook(look: VxlEyeLook): boolean
NpcController.isRenderingSkinnedMesh(): boolean
NpcController.getId(): string | null
NpcController.getAnimationController(): CharacterAnimationController | null
NpcController.getBlockCharacterRenderer(): BlockCharacterRenderer | null
NpcController.enableVoxelEffects(options?: { /** Death effect variant (default: 'normal') */ deathVariant?: VoxelDeathEffectConfig['variant']; /** Number of death fragments (default: 12) */ deathFragmentCount?: number; /** Enable chip-off fragments on damage (default: true) */ damageChipOff?: boolean; /** Full death config override (takes precedence over shorthand options) */ deathConfig?: Omit<VoxelDeathEffectConfig, 'getPosition' | 'getSourceMesh'>; /** Full damage config override (takes precedence over shorthand options) */ damageConfig?: DamageVisualConfig; }): void
NpcController.loadBlockCharacterVariant(variantIndex: number, factory: IBlockCharacterFactory): boolean
NpcController.setActiveBlockCharacterVariant(variantIndex: number): boolean
NpcController.redressBlockCharacter(factory: IBlockCharacterFactory): boolean
NpcController.getActiveBlockCharacterVariant(): number
NpcController.hasBlockCharacterVariant(variantIndex: number): boolean
NpcController.setStanceBoneOffsets(offsets: Map<string, THREE.Quaternion> | null): void
NpcController.setFootIkTargets(targets: LegIkTargets | null): void
NpcController.acquirePoseOverride(options: Partial<NpcPoseOverrideOptions> = {}): NpcPoseOverrideHandle | null
NpcController.getPoseOverride(): NpcPoseOverrideHandle | null
NpcController.attachToBodyPart(object: THREE.Object3D, bodyPartName: string, rotation?: THREE.Vector3 | { x: number; y: number; z: number } | null): boolean
NpcController.getBodyPartObject(bodyPartName: string): THREE.Object3D | null
NpcController.getCapsuleHeight(): number
NpcController.setSkinnedArmGrip(side: 'left' | 'right', target: THREE.Object3D, offset: THREE.Vector3, rotation: THREE.Euler): void
NpcController.clearSkinnedArmGrip(side: 'left' | 'right'): void
NpcController.detachFromBodyPart(object: THREE.Object3D): void
NpcController.getNpcId(): string | null
NpcController.getVelocity(): THREE.Vector3
NpcController.isStunned(): boolean
NpcController.isGrounded(): boolean
NpcController.get player(): THREE.Object3D
NpcController.get characterHeight(): number
NpcController.get capsuleRadius(): number
NpcController.get capsuleHeight(): number
NpcController.voxelBlockSize: number
NpcController.setStrikeTarget(target: NpcMeleeTarget | null): void
NpcController.equipMeleeWeapon(options: NpcMeleeWeaponOptions): boolean
NpcController.unequipMeleeWeapon(): void
NpcController.hasMeleeWeapon(): boolean
NpcController.getMeleeWeaponGrip(): 'one' | 'two'
NpcController.defaultMeleeHitHandler(impactDirection?: THREE.Vector3, impulseStrength: number = 8): void
NpcController.takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void
NpcController.prewarmShatter(): void
NpcController.isDead(): boolean
NpcController.getHealth(): number
NpcController.getMaxHealth(): number
NpcController.setMaxHealth(maxHealth: number): void
NpcController.heal(amount: number): boolean
NpcController.resetHealth(): void
NpcController.setStunDuration(seconds: number): void
NpcController.setCorpseLifetimeMs(ms: number): void
NpcController.setDamageFlashEnabled(enabled: boolean): void
NpcController.getDamageFlash(): import('engine/effects/DamageFlash.js').DamageFlash | null
NpcController.onProjectileHit(): void
NpcController.isExploded(): boolean
NpcController.onProjectileCollision(projectile: ProjectileLike): void

## engine/npc/core/NpcFactory.ts
class NpcFactory — NpcFactory - Easy NPC creation with behavior presets
static NpcFactory.createWanderingEnemy(engine: EngineLike, scene: THREE.Scene, physicsWorld: PhysicsWorld, spawnPosition: THREE.Vector3, playerGLTF: any, characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number }, config?: { moveSpeed?: number; stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling worldBounds?: number; retargetInterval?: number; detectionRange?: number; attackRange?: number; damage?: number; chaseSpeed?: number; baseAnimations?: any[]; movementSystem?: IPlayerMovement; }): Promise<NpcController>
static NpcFactory.createPatrolGuard(engine: EngineLike, scene: THREE.Scene, physicsWorld: PhysicsWorld, spawnPosition: THREE.Vector3, playerGLTF: any, characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number }, waypoints: THREE.Vector3[], config?: { moveSpeed?: number; stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling waitTimeAtWaypoint?: number; patrolMode?: 'circular' | 'ping-pong'; detectPlayerRange?: number; baseAnimations?: any[]; movementSystem?: IPlayerMovement; }): Promise<NpcController>
static NpcFactory.createFollowerCompanion(engine: EngineLike, scene: THREE.Scene, physicsWorld: PhysicsWorld, spawnPosition: THREE.Vector3, playerGLTF: any, characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number }, target: THREE.Object3D, config?: { moveSpeed?: number; stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling minDistance?: number; maxDistance?: number; updateInterval?: number; baseAnimations?: any[]; movementSystem?: IPlayerMovement; }): Promise<NpcController>
static NpcFactory.createHostileChaser(engine: EngineLike, scene: THREE.Scene, physicsWorld: PhysicsWorld, spawnPosition: THREE.Vector3, playerGLTF: any, characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number }, config?: { moveSpeed?: number; stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling detectionRange?: number; attackRange?: number; chaseSpeed?: number; returnToOrigin?: boolean; baseAnimations?: any[]; movementSystem?: IPlayerMovement; }): Promise<NpcController>
static NpcFactory.createIdleNPC(engine: EngineLike, scene: THREE.Scene, physicsWorld: PhysicsWorld, spawnPosition: THREE.Vector3, playerGLTF: any, characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number }, config?: { moveSpeed?: number; stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling lookAtPlayer?: boolean; lookAtRange?: number; randomIdleMotions?: boolean; baseAnimations?: any[]; movementSystem?: IPlayerMovement; }): Promise<NpcController>
static NpcFactory.createShopkeeper(engine: EngineLike, scene: THREE.Scene, physicsWorld: PhysicsWorld, shopPosition: THREE.Vector3, playerGLTF: any, characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number }, config?: { moveSpeed?: number; stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling greetingRange?: number; interactionRange?: number; greetingCooldown?: number; onPlayerInteract?: () => void; shopkeeperName?: string; idleAnimations?: string[]; baseAnimations?: any[]; movementSystem?: IPlayerMovement; }): Promise<NpcController>
static NpcFactory.createCustomNPC(engine: EngineLike, scene: THREE.Scene, physicsWorld: PhysicsWorld, spawnPosition: THREE.Vector3, playerGLTF: any, characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number }, behavior: any, config?: { moveSpeed?: number; stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling baseAnimations?: any[]; movementSystem?: IPlayerMovement; }): Promise<NpcController>

## engine/npc/core/NpcHandle.ts
interface NpcHandle
NpcHandle.spawn(x: number, z: number, y?: number): Promise<void>
NpcHandle.spawn(options: SpawnNpcRelativeOptions): Promise<void>
NpcHandle.setImportance(importance: 'hero' | 'crowd'): void
class NpcHandleImpl implements NpcHandle
NpcHandleImpl.constructor(private readonly name: string, private readonly manager: NpcManager)
NpcHandleImpl.spawn(xOrOptions: number | SpawnNpcRelativeOptions, z?: number, y?: number): Promise<void>
NpcHandleImpl.setImportance(importance: 'hero' | 'crowd'): void

## engine/npc/core/NpcLodComponent.ts
interface LodBodyHooks
LodBodyHooks.setBodyEnabled(enabled: boolean): void
LodBodyHooks.snapBodyToVisual(): void
LodBodyHooks.setShadowsEnabled(enabled: boolean): void
interface LodPathFollower — Minimal structural path access for advanceAlongPath. NavigationComponent
LodPathFollower.getCurrentWaypoint(): THREE.Vector3 | null
LodPathFollower.advanceWaypoint(): void
class NpcLodComponent — Per-character LOD bookkeeping: accumulators + transition side effects.
NpcLodComponent.state: CharacterLodState
NpcLodComponent.aiDtAccum
NpcLodComponent.animDtAccum
NpcLodComponent.avoidDtAccum
NpcLodComponent.lastStepVelocity
NpcLodComponent.constructor(hooks: LodBodyHooks, simClassClamp?: SimClass)
NpcLodComponent.beginFrame(deltaTime: number, state: CharacterLodState): void
NpcLodComponent.consumeAiTick(): number | null
NpcLodComponent.consumeAnimTick(): number | null
NpcLodComponent.consumeAvoidanceTick(): boolean
NpcLodComponent.dropAccumulators(): void
NpcLodComponent.noteCoarseStep(bodyX: number, bodyZ: number, dt: number, maxSpeed: number, bodyY?: number): void
NpcLodComponent.advanceAlongPath(character: THREE.Object3D, navigationComp: LodPathFollower, moveSpeed: number, dt: number): void

## engine/npc/core/NpcManager.ts
type CharacterFactory = | IBlockCharacterFactory | ((characterGroup: THREE.Group) => CharacterDimensions)
interface SpawnNpcRelativeOptions — Options for spawning an NPC relative to an object
SpawnNpcRelativeOptions.objectId: string
SpawnNpcRelativeOptions.relation?: SpawnRelation
SpawnNpcRelativeOptions.customPosition?: CustomPositionFn
SpawnNpcRelativeOptions.offset?: { x?: number; y?: number; z?: number }
SpawnNpcRelativeOptions.side?: 'left' | 'right'
SpawnNpcRelativeOptions.distance?: number
SpawnNpcRelativeOptions.characterFactory?: CharacterFactory
class NpcManager — NpcManager - Generic NPC lifecycle manager using Strategy Pattern
NpcManager.constructor(engine: EngineLike, managerBehavior: INpcManagerBehavior)
static NpcManager.createEnemy(engine: EngineLike, config?: { worldBounds?: number; retargetInterval?: number; autoRespawn?: boolean; respawnDelay?: number; }, characterFactory?: CharacterFactory): NpcManager
NpcManager.spawnNpc(spawnX?: number, spawnZ?: number, characterFactory?: CharacterFactory, retryCount: number = 0, spawnY?: number, positionAttempt: number = 0): Promise<string | null>
NpcManager.spawnMany(count: number, positions?: Array<{ x: number; z: number }>, characterFactory?: CharacterFactory): Promise<string[]>
NpcManager.ensureSpawned(spawnX?: number, spawnZ?: number, characterFactory?: CharacterFactory): Promise<void>
NpcManager.setAutoSpawnEnabled(enabled: boolean): void
NpcManager.despawnNpc(npcId?: string): void
NpcManager.toggleNpc(spawnX?: number, spawnZ?: number): Promise<void>
static NpcManager.advanceFrame(): void
NpcManager.update(deltaTime: number): void
NpcManager.getRosterGeneration(): number
NpcManager.isActive(): boolean
NpcManager.getNpc(npcId?: string): NpcController | null
NpcManager.getAllNpcs(): NpcController[]
NpcManager.requestRespawn(npcId: string, delay: number = 5.0): void
NpcManager.getCount(): number
NpcManager.getName(): string
NpcManager.forEach(callback: (npc: NpcController, id: string) => void): void
NpcManager.setManagerBehavior(behavior: INpcManagerBehavior): void
NpcManager.setCharacterFactory(factory: CharacterFactory): void
NpcManager.setNpcCharacterUrl(url: string | null): void
NpcManager.setNpcEyeLook(look: VxlEyeLook): void
NpcManager.setNpcModelRotationY(rotationY: number): void
NpcManager.setDamageableConfig(config: Partial<DamageableConfig>): void
NpcManager.setImportance(importance: 'hero' | 'crowd'): void
NpcManager.setPlaneLockEnabled(enabled: boolean): void
NpcManager.getImportance(): 'hero' | 'crowd'
NpcManager.setSkipAutoAnimationLoading(skip: boolean): void
NpcManager.setVoxelBlockSize(size: number): void
NpcManager.spawnNpcRelativeTo(options: SpawnNpcRelativeOptions): Promise<string>
NpcManager.dispose(): void
NpcManager.validateSetup(): { valid: boolean; issues: string[] }

## engine/npc/core/NpcManagerHelper.ts
function createNpcManager(engine: EngineLike, name: string, npcBehavior: INpcBehavior, autoRespawn: boolean = false): NpcManager

## engine/npc/core/NpcPoseOverride.ts
interface NpcPoseOverrideOptions — What a pose override owns when it is acquired. The part list is fixed here so
NpcPoseOverrideOptions.parts: string[]
NpcPoseOverrideOptions.weight: number
NpcPoseOverrideOptions.preserveRootHeight: boolean
NpcPoseOverrideOptions.preserveFeet: boolean
const DEFAULT_NPC_POSE_OVERRIDE_OPTIONS: NpcPoseOverrideOptions
class NpcPoseOverrideHandle — A held pose on one NPC: the parts it owns, an optional single-hand reach, and
NpcPoseOverrideHandle.constructor(renderer: BlockCharacterRenderer, options: NpcPoseOverrideOptions, onRelease: () => void)
NpcPoseOverrideHandle.getOwnedParts(): string[]
NpcPoseOverrideHandle.setPartOffset(part: string, offset: Partial<BlockPosePartOffset>): void
NpcPoseOverrideHandle.clearPartOffset(part: string): void
NpcPoseOverrideHandle.setHandTarget(side: 'left' | 'right', worldPosition: THREE.Vector3, rotation?: THREE.Quaternion): void
NpcPoseOverrideHandle.clearHandTarget(): void
NpcPoseOverrideHandle.setWeight(weight: number): void
NpcPoseOverrideHandle.getWeight(): number
NpcPoseOverrideHandle.isActive(): boolean
NpcPoseOverrideHandle.release(): void

## engine/npc/core/NpcRegistry.ts
type NpcDeathCallback = (npcId: string, npcType: string, position: THREE.Vector3) => void
interface RelativeSpawnConfig — Object-relative spawn configuration
RelativeSpawnConfig.objectId: string
RelativeSpawnConfig.relation?: SpawnRelation
RelativeSpawnConfig.customPosition?: CustomPositionFn
RelativeSpawnConfig.offset?: { x?: number; y?: number; z?: number }
RelativeSpawnConfig.side?: 'left' | 'right'
RelativeSpawnConfig.distance?: number
interface RegisterNpcOptions — Options for engine.registerNpc() — the simplified NPC API for templates and agents.
RegisterNpcOptions.characterFactory?: IBlockCharacterFactory | ((characterGroup: THREE.Group) => { width: number; height: number; depth: number })
RegisterNpcOptions.characterUrl?: string
RegisterNpcOptions.characterAssetId?: string
RegisterNpcOptions.characterModelRotationY?: number
RegisterNpcOptions.eyeLook?: VxlEyeLook
RegisterNpcOptions.autoRespawn?: boolean
RegisterNpcOptions.importance?: 'hero' | 'crowd'
RegisterNpcOptions.onDeath?: NpcDeathCallback
RegisterNpcOptions.damageable?: Partial<DamageableConfig>
RegisterNpcOptions.planeLock?: boolean
interface NpcRegisterOptions — Options for registering an NPC manager (engine-internal)
NpcRegisterOptions.x?: number
NpcRegisterOptions.z?: number
NpcRegisterOptions.relativeTo?: RelativeSpawnConfig
class NpcRegistry
NpcRegistry.onNpcDeath: NpcDeathCallback
NpcRegistry.constructor(engine: EngineLike)
NpcRegistry.register(name: string, manager: NpcManager, options?: NpcRegisterOptions): void
NpcRegistry.registerController(name: string, controller: NpcController): void
NpcRegistry.getController(name: string): NpcController | null
NpcRegistry.unregisterController(name: string, dispose: boolean = true): void
NpcRegistry.setSpawnPosition(name: string, spawnX: number, spawnZ: number): void
NpcRegistry.get(name: string): NpcManager | null
NpcRegistry.spawn(name: string, spawnX?: number, spawnZ?: number): Promise<void>
NpcRegistry.spawnAll(): Promise<void>
NpcRegistry.updateAll(deltaTime: number): void
NpcRegistry.setAllCharactersVisible(visible: boolean): void
NpcRegistry.disposeAll(): void
NpcRegistry.getCount(): number
NpcRegistry.getManagerCount(): number
NpcRegistry.getControllerCount(): number
NpcRegistry.getNames(): string[]
NpcRegistry.has(name: string): boolean
NpcRegistry.getAllControllers(): NpcController[]

## engine/npc/core/NpcSkeletonSource.ts
class NpcSkeletonSource — Engine-scoped source of the humanoid GLTF used as the skeleton when cloning
NpcSkeletonSource.constructor(engine: EngineLike)
NpcSkeletonSource.getSkeletonGLTF(): unknown
NpcSkeletonSource.ensureLoaded(): void
function getNpcSkeletonSource(engine: EngineLike): NpcSkeletonSource

## engine/npc/core/NpcWeaponComponent.ts
interface NpcMeleeWeaponOptions — What arming an NPC needs to know. Fill gaps from `DEFAULT_NPC_MELEE_WEAPON`.
NpcMeleeWeaponOptions.type: WeaponTypeId
NpcMeleeWeaponOptions.scale: number
NpcMeleeWeaponOptions.damage: number
NpcMeleeWeaponOptions.reach: number
const DEFAULT_NPC_MELEE_WEAPON: Readonly<Omit<NpcMeleeWeaponOptions, 'type'>>
interface NpcWeaponHost — The part of `NpcController` this component drives.
NpcWeaponHost.getCharacter(): THREE.Object3D
NpcWeaponHost.getBodyPartObject(bodyPartName: string): THREE.Object3D | null
NpcWeaponHost.attachToBodyPart(object: THREE.Object3D, bodyPartName: string): boolean
NpcWeaponHost.detachFromBodyPart(object: THREE.Object3D): void
NpcWeaponHost.isRenderingSkinnedMesh(): boolean
class NpcWeaponComponent
NpcWeaponComponent.constructor(private readonly host: NpcWeaponHost)
NpcWeaponComponent.equip(options: NpcMeleeWeaponOptions): boolean
NpcWeaponComponent.unequip(): void
NpcWeaponComponent.isArmed(): boolean
NpcWeaponComponent.getOptions(): NpcMeleeWeaponOptions | null
NpcWeaponComponent.getGrip(): 'one' | 'two'
NpcWeaponComponent.updateHold(isAttacking: boolean): void
NpcWeaponComponent.beginSwing(): void
NpcWeaponComponent.sweep(target: NpcMeleeTarget, damage: number, reach: number): boolean

## engine/npc/core/findValidatedSpawnPosition.ts
type SpawnPositionValidator = (x: number, z: number) => THREE.Vector3 | null
function findValidatedSpawnPosition(worldSizeX: number, worldSizeZ: number, spawnX: number | undefined, spawnZ: number | undefined, validate: SpawnPositionValidator, originX?: number, originZ?: number): THREE.Vector3 | null

## engine/npc/crowd/CrowdAgents.ts
interface CrowdMember — What the solver needs from a character, and the only surface it touches.
CrowdMember.getCrowdX(): number
CrowdMember.getCrowdZ(): number
CrowdMember.getCrowdRadius(): number
CrowdMember.getCrowdMobility(): number
CrowdMember.applyCrowdSeparation(dx: number, dz: number): void
CrowdMember.isCrowdActive(): boolean
class CrowdRegistry
CrowdRegistry.xs
CrowdRegistry.zs
CrowdRegistry.radii
CrowdRegistry.mobilities
CrowdRegistry.count
CrowdRegistry.add(member: CrowdMember): void
CrowdRegistry.remove(member: CrowdMember): void
CrowdRegistry.size(): number
CrowdRegistry.gather(): number
CrowdRegistry.scatter(epsilon = 1e-5): number
CrowdRegistry.clear(): void
function getGlobalCrowd(): CrowdRegistry

## engine/npc/crowd/CrowdAnimationBake.ts
interface BakedClipRange — One clip's slice of the table.
BakedClipRange.name: string
BakedClipRange.frameOffset: number
BakedClipRange.frameCount: number
BakedClipRange.duration: number
BakedClipRange.loop: boolean
interface BakedAnimationTable
BakedAnimationTable.data: Float32Array
BakedAnimationTable.clips: BakedClipRange[]
BakedAnimationTable.boneCount: number
BakedAnimationTable.frameCount: number
BakedAnimationTable.fps: number
interface BakeAnimationOptions
BakeAnimationOptions.fps: number
BakeAnimationOptions.loopingClipNames?: ReadonlyArray<string>
BakeAnimationOptions.onFrame: () => void
const DEFAULT_BAKE_ANIMATION_OPTIONS: BakeAnimationOptions
function bakeAnimationTable(root: THREE.Object3D, nodes: ReadonlyArray<THREE.Object3D>, clips: ReadonlyArray<THREE.AnimationClip>, options: BakeAnimationOptions = DEFAULT_BAKE_ANIMATION_OPTIONS): BakedAnimationTable
function resolveFrameRow(table: BakedAnimationTable, clipIndex: number, timeSeconds: number): number
function packAnimationTexture(table: BakedAnimationTable): THREE.DataTexture

## engine/npc/crowd/CrowdMeshBake.ts
interface MergedCharacterGeometry — One merged, GPU-poseable character variant.
MergedCharacterGeometry.geometry: THREE.BufferGeometry
MergedCharacterGeometry.boneNames: string[]
MergedCharacterGeometry.bindMatrices: THREE.Matrix4[]
MergedCharacterGeometry.triangleCount: number
MergedCharacterGeometry.sourceMeshCount: number
interface PartBinding — One posed part of a block character — a body-part GROUP, not a skeleton bone.
PartBinding.group: THREE.Object3D
function mergeBlockCharacter(bindings: ReadonlyArray<PartBinding>): MergedCharacterGeometry

## engine/npc/crowd/CrowdRenderer.ts
interface CrowdRenderMember — Live state the renderer reads for one instance each frame.
CrowdRenderMember.getCrowdX(): number
CrowdRenderMember.getCrowdY(): number
CrowdRenderMember.getCrowdZ(): number
CrowdRenderMember.getCrowdYaw(): number
CrowdRenderMember.getCrowdFrameRow(): number
CrowdRenderMember.getCrowdColor(): THREE.Color
CrowdRenderMember.getCrowdScale?(): number
interface CrowdSlot — Handle to one instance. Opaque: the index moves when other slots are released.
CrowdSlot.readonly variant: string
CrowdSlot.index: number
CrowdSlot.released: boolean
class CrowdRenderer
CrowdRenderer.registerVariant(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D): void
CrowdRenderer.hasVariant(name: string): boolean
CrowdRenderer.acquire(variant: string, member: CrowdRenderMember): CrowdSlot | null
CrowdRenderer.release(slot: CrowdSlot): void
CrowdRenderer.update(): void
CrowdRenderer.getStats(): Array<{ variant: string; count: number; capacity: number }>
CrowdRenderer.dispose(): void
function getGlobalCrowdRenderer(): CrowdRenderer
function resetGlobalCrowdRenderer(): void

## engine/npc/crowd/CrowdSeparation.ts
interface SeparationOptions — Tuning for one separation pass.
SeparationOptions.iterations: number
SeparationOptions.stiffness: number
SeparationOptions.slack: number
const DEFAULT_SEPARATION_OPTIONS: SeparationOptions
interface CrowdAgentArrays — Agent state the pass reads and writes, as parallel arrays.
CrowdAgentArrays.xs: Float32Array
CrowdAgentArrays.zs: Float32Array
CrowdAgentArrays.radii: Float32Array
CrowdAgentArrays.mobilities: Float32Array
CrowdAgentArrays.count: number
function separateCrowd(agents: CrowdAgentArrays, hash: SpatialHash, options: SeparationOptions = DEFAULT_SEPARATION_OPTIONS): number

## engine/npc/crowd/CrowdSkinnedMaterial.ts
const CROWD_INSTANCE_FRAME_ATTRIBUTE = 'instanceFrameRow'
const CROWD_BONE_INDEX_ATTRIBUTE = 'boneIndex'
const CROWD_INSTANCE_XFM_ATTRIBUTE = 'instanceCrowdXfm'
const CROWD_INSTANCE_YAW_ATTRIBUTE = 'instanceCrowdYaw'
interface CrowdSkinnedMaterialOptions
CrowdSkinnedMaterialOptions.boneTexture: THREE.DataTexture
CrowdSkinnedMaterialOptions.boneCount: number
CrowdSkinnedMaterialOptions.frameCount: number
function createCrowdSkinnedMaterial(options: CrowdSkinnedMaterialOptions): THREE.Material

## engine/npc/crowd/CrowdSolver.ts
interface CrowdSolveResult — What one solve did, for the debug HUD and for tests.
CrowdSolveResult.agents: number
CrowdSolveResult.corrections: number
CrowdSolveResult.moved: number
class CrowdSolver — Solve one frame of crowd separation.
CrowdSolver.solve(registry: CrowdRegistry, options: SeparationOptions = DEFAULT_SEPARATION_OPTIONS): CrowdSolveResult
CrowdSolver.getLastResult(): CrowdSolveResult
CrowdSolver.getStatsLine(): string
function getGlobalCrowdSolver(): CrowdSolver

## engine/npc/crowd/SpatialHash.ts
const CELL_SIZE_RADIUS_MULTIPLE = 2
class SpatialHash
SpatialHash.constructor(cellSize: number)
SpatialHash.getCellSize(): number
SpatialHash.setCellSize(cellSize: number): void
SpatialHash.build(xs: Float32Array, zs: Float32Array, count: number): void
SpatialHash.forEachNeighbor(i: number, radius: number, cb: (j: number) => void): void
SpatialHash.getOccupiedCellCount(): number

## engine/npc/crowd/VxlCrowdVariant.ts
interface VxlCrowdVariant — One body type, registered with the global CrowdRenderer under `key`.
VxlCrowdVariant.key: string
VxlCrowdVariant.geometry: THREE.BufferGeometry
VxlCrowdVariant.material: THREE.Material
VxlCrowdVariant.table: BakedAnimationTable
VxlCrowdVariant.clipIndexByMotionId: Map<string, number>
VxlCrowdVariant.idleClipIndex: number
VxlCrowdVariant.lod: number
type VxlCrowdGeometrySource = { decoded: DecodedVxlV3; bindBox: THREE.Box3 }
interface VxlCrowdClip — A clip to bake, and whether sampling wraps past its end.
VxlCrowdClip.motionId: string
VxlCrowdClip.duration: number
VxlCrowdClip.loop: boolean
const VXL_CROWD_TABLE_FPS = 30
function buildVxlCrowdGeometry(template: VxlCrowdGeometrySource, preferredLod = 1): { geometry: THREE.BufferGeometry; boneCount: number; lod: number }
function bakeVxlCrowdTable(skeleton: VxlBindSkeleton, clips: readonly VxlCrowdClip[], poseAt: (clipIndex: number, timeSeconds: number) => void, fps: number = VXL_CROWD_TABLE_FPS): BakedAnimationTable
function ensureVxlCrowdVariant(templateUrl: string, engine: EngineLike): Promise<VxlCrowdVariant | null>
function clearVxlCrowdVariantCache(): void

## engine/npc/customization/CostumePresets.ts
const CostumeType = { JEDI: 'jedi', SITH: 'sith', STORMTROOPER: 'stormtrooper',
type CostumeTypeId = typeof CostumeType[keyof typeof CostumeType]
const COSTUME_CONFIGS: Record<CostumeTypeId, NpcCustomizationConfig>
function createJediNpcFactory(): IBlockCharacterFactory
function createSithNpcFactory(): IBlockCharacterFactory
function createStormtrooperNpcFactory(): IBlockCharacterFactory
function createKnightNpcFactory(): IBlockCharacterFactory
function createSoldierNpcFactory(): IBlockCharacterFactory
function getCostumeFactory(costumeType: string): IBlockCharacterFactory | null
function createCustomCostume(baseCostume: CostumeTypeId, overrides: Partial<NpcCustomizationConfig>): IBlockCharacterFactory

## engine/npc/customization/NpcCustomization.ts
interface NpcColorConfig — Color configuration for NPC parts
NpcColorConfig.color: number
NpcColorConfig.roughness?: number
NpcColorConfig.metalness?: number
NpcColorConfig.emissive?: number
NpcColorConfig.emissiveIntensity?: number
interface NpcBodyShapeConfig — Body shape configuration
NpcBodyShapeConfig.height?: number
NpcBodyShapeConfig.width?: number
NpcBodyShapeConfig.depth?: number
NpcBodyShapeConfig.headSize?: number
NpcBodyShapeConfig.torsoSize?: number
NpcBodyShapeConfig.limbSize?: number
interface NpcEarConfig — Ear configuration
NpcEarConfig.type: 'pointed' | 'round' | 'floppy' | 'none'
NpcEarConfig.color: number
NpcEarConfig.size?: number
interface NpcHornConfig — Horn configuration
NpcHornConfig.type: 'small' | 'medium' | 'large' | 'curved' | 'none'
NpcHornConfig.color: number
NpcHornConfig.size?: number
interface NpcTailConfig — Tail configuration
NpcTailConfig.type: 'short' | 'medium' | 'long' | 'fluffy' | 'none'
NpcTailConfig.color: number
NpcTailConfig.size?: number
interface NpcBeardConfig — Beard configuration
NpcBeardConfig.type: 'short' | 'medium' | 'long' | 'goatee' | 'mustache' | 'full' | 'none'
NpcBeardConfig.color: number
NpcBeardConfig.size?: number
interface NpcBeltConfig — Belt configuration
NpcBeltConfig.color?: number
NpcBeltConfig.width?: number
interface NpcGlassesConfig — Glasses configuration
NpcGlassesConfig.type: 'round' | 'square' | 'aviator' | 'none'
NpcGlassesConfig.color: number
NpcGlassesConfig.lensColor?: number
interface NpcShoesConfig — Shoes configuration
NpcShoesConfig.color?: number
NpcShoesConfig.type?: 'sneakers' | 'boots' | 'sandals' | 'dress' | 'none'
interface NpcAccessoriesConfig — Accessories configuration
NpcAccessoriesConfig.glasses?: NpcGlassesConfig
NpcAccessoriesConfig.necklace?: number
NpcAccessoriesConfig.bracelet?: number
NpcAccessoriesConfig.watch?: number
NpcAccessoriesConfig.backpack?: number
NpcAccessoriesConfig.cape?: number
NpcAccessoriesConfig.scarf?: number
NpcAccessoriesConfig.gloves?: number
NpcAccessoriesConfig.shoulderPads?: number
NpcAccessoriesConfig.kneePads?: number
NpcAccessoriesConfig.elbowPads?: number
NpcAccessoriesConfig.bandana?: number
NpcAccessoriesConfig.mask?: number
NpcAccessoriesConfig.earrings?: number
NpcAccessoriesConfig.ring?: number
NpcAccessoriesConfig.badge?: number
NpcAccessoriesConfig.bandage?: number
interface NpcClothingConfig — Clothing configuration
NpcClothingConfig.shirtColor?: number
NpcClothingConfig.pantsColor?: number
NpcClothingConfig.hatColor?: number
NpcClothingConfig.hatType?: 'cap' | 'tophat' | 'crown' | 'helmet' | 'beanie' | 'hood' | 'bandana-hat' | 'cowboy' | 'beret' | 'visor'
NpcClothingConfig.bootsColor?: number
NpcClothingConfig.belt?: NpcBeltConfig
NpcClothingConfig.shoes?: NpcShoesConfig
NpcClothingConfig.accessories?: NpcAccessoriesConfig
interface NpcFeaturesConfig — Feature configuration
NpcFeaturesConfig.ears?: NpcEarConfig
NpcFeaturesConfig.horns?: NpcHornConfig
NpcFeaturesConfig.tail?: NpcTailConfig
NpcFeaturesConfig.beard?: NpcBeardConfig
NpcFeaturesConfig.eyeColor?: number
NpcFeaturesConfig.visorEyes?: boolean
NpcFeaturesConfig.sparkles?: boolean
interface NpcCustomizationConfig — Complete NPC customization configuration
NpcCustomizationConfig.skinColor: NpcColorConfig | number
NpcCustomizationConfig.clothing?: NpcClothingConfig
NpcCustomizationConfig.bodyShape?: NpcBodyShapeConfig
NpcCustomizationConfig.features?: NpcFeaturesConfig
NpcCustomizationConfig.accentColor?: number
function createCustomizedNpcFactory(config: NpcCustomizationConfig): IBlockCharacterFactory

## engine/npc/customization/NpcCustomizationExamples.ts
function createAdventurerNpcFactory(): IBlockCharacterFactory
function createCyberpunkNpcFactory(): IBlockCharacterFactory
function createNobleKnightNpcFactory(): IBlockCharacterFactory
function createCasualUrbanNpcFactory(): IBlockCharacterFactory
function createSurvivorNpcFactory(): IBlockCharacterFactory

## engine/npc/customization/NpcCustomizationPresets.ts
function createWarriorNpcFactory(): IBlockCharacterFactory
function createWizardNpcFactory(): IBlockCharacterFactory
function createElfNpcFactory(): IBlockCharacterFactory
function createDemonNpcFactory(): IBlockCharacterFactory
function createCuteCreatureNpcFactory(): IBlockCharacterFactory
function createRobotNpcFactory(): IBlockCharacterFactory
function createRoyalNpcFactory(): IBlockCharacterFactory
function createVillagerNpcFactory(): IBlockCharacterFactory
function createWerewolfNpcFactory(): IBlockCharacterFactory
function createRandomNpcFactory(): IBlockCharacterFactory

## engine/npc/customization/blockPartCaches.ts
function getSharedBoxGeometry(width: number, height: number, depth: number): THREE.BoxGeometry
interface SharedLambertOptions — Options mirroring the properties CharacterLoader's Lambert conversion preserves.
SharedLambertOptions.emissive?: number | THREE.Color
SharedLambertOptions.emissiveIntensity?: number
SharedLambertOptions.transparent?: boolean
SharedLambertOptions.opacity?: number
SharedLambertOptions.side?: THREE.Side
function getSharedLambertMaterial(color: number | THREE.Color, options: SharedLambertOptions = {}): THREE.MeshLambertMaterial
const CHARACTER_PART_CLASS = 'characterPartClass'
function classedPartStandardMaterial(className: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial
function getSharedClassedMaterial(className: string, color: number | THREE.Color, options: SharedLambertOptions = {}, quality?: MaterialQuality): ClassedPartMaterial
function convertBlockPartMaterial(mat: THREE.Material, cloneShared: boolean): THREE.Material
function clearBlockPartCaches(): void
function blockPartCacheStats(): { geometries: number; materials: number; classedMaterials: number }

## engine/npc/examples/EXAMPLE_CompleteNPCIntegration.ts
class ExampleCustomNPCManagerBehavior extends BaseNpcManagerBehavior — Example: Custom NPC Manager Behavior
ExampleCustomNPCManagerBehavior.constructor()
ExampleCustomNPCManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void
ExampleCustomNPCManagerBehavior.onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean
const COMPLETE_GAME_TS_INTEGRATION_EXAMPLE = ` // ============================================ // STEP 1:

## engine/npc/examples/EXAMPLE_CustomizedNPC.ts
class CustomizedNPCManagerBehavior extends BaseNpcManagerBehavior — Example: Custom NPC Manager Behavior with Customization
CustomizedNPCManagerBehavior.constructor()
CustomizedNPCManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void
CustomizedNPCManagerBehavior.onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean
const CUSTOMIZED_NPC_INTEGRATION_EXAMPLE = ` // ============================================ // METHOD

## engine/npc/examples/EXAMPLE_InteractableNPCs.ts
const EXAMPLE_SIMPLE_INTERACTABLE_VILLAGER = ` // Simple interactable villager const handle = engine.regi
const EXAMPLE_CUSTOM_INTERACTABLE_BEHAVIOR = ` // Custom behavior with speech bubble import { NpcIdleBeha
const EXAMPLE_MULTIPLE_MESSAGES = ` // Villager with multiple random messages const handle = e
const EXAMPLE_SHOPKEEPER_INTERACTION = ` // Shopkeeper with custom interaction callback const handl

## engine/npc/examples/EXAMPLE_MeleeNpcBehavior.ts
const DEFAULT_MELEE_NPC_AGGRO_RANGE = 25
const DEFAULT_MELEE_NPC_RETURN_TO_ORIGIN = true
interface MeleeNpcConfig — Configuration for melee NPC behavior
MeleeNpcConfig.weaponType?: string
MeleeNpcConfig.aggroRange?: number
MeleeNpcConfig.returnToOrigin?: boolean
MeleeNpcConfig.attackRange?: number
MeleeNpcConfig.attackCooldown?: number
MeleeNpcConfig.damage?: number
MeleeNpcConfig.chaseSpeed?: number
MeleeNpcConfig.weaponScale?: number
MeleeNpcConfig.bladeLength?: number
MeleeNpcConfig.createWeaponMesh?: () => THREE.Group
MeleeNpcConfig.focusOffsetY?: number
class MeleeNpcBehavior implements INpcBehavior — Generic melee combat NPC behavior
MeleeNpcBehavior.focusOffsetY: number
MeleeNpcBehavior.constructor(config: MeleeNpcConfig = {})
MeleeNpcBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
MeleeNpcBehavior.clone(): MeleeNpcBehavior
MeleeNpcBehavior.initialize(controller: ICharacterContext): void
MeleeNpcBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, _currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
MeleeNpcBehavior.onPoseUpdated(): void
MeleeNpcBehavior.isHostile(): boolean
MeleeNpcBehavior.getName(): string
MeleeNpcBehavior.dispose(): void
function createSwordNpcBehavior(damage: number = 25): MeleeNpcBehavior
function createAxeNpcBehavior(damage: number = 35): MeleeNpcBehavior
function createSpearNpcBehavior(damage: number = 20): MeleeNpcBehavior

## engine/npc/examples/EXAMPLE_MultipleNPCTypes.ts
const MULTIPLE_NPC_TYPES_EXAMPLE = ` // ============================================ // METHOD

## engine/npc/examples/EXAMPLE_NpcRegistryUsage.ts
const NPC_REGISTRY_INTEGRATION_EXAMPLE = ` // ============================================ // Just re

## engine/npc/examples/EXAMPLE_PatrolToChaseBehavior.ts
class ExamplePatrolEnemyManagerBehavior extends BaseNpcManagerBehavior — Example manager behavior for patrol-to-chase enemies
ExamplePatrolEnemyManagerBehavior.constructor()
ExamplePatrolEnemyManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void

## engine/npc/examples/EXAMPLE_RangedNpcBehavior.ts
type RangedNpcWeaponType = RangedWeaponTypeId
interface RangedNpcConfig
RangedNpcConfig.weaponType?: RangedNpcWeaponType
RangedNpcConfig.weaponScale?: number
RangedNpcConfig.attackRange?: number
RangedNpcConfig.aimSpread?: number
RangedNpcConfig.shotInterval?: number
RangedNpcConfig.projectileColor?: number
class RangedNpcBehavior extends NpcEnemyBehavior — Ranged NPC behavior - uses SAME approach as player RangedWeaponSystem!
RangedNpcBehavior.constructor(config: RangedNpcConfig = {})
RangedNpcBehavior.clone(): RangedNpcBehavior
RangedNpcBehavior.initialize(controller: ICharacterContext): void
RangedNpcBehavior.onPoseUpdated(): void
RangedNpcBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, _currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
RangedNpcBehavior.getProjectiles(): Projectile[]
RangedNpcBehavior.onNpcDeath(): void
RangedNpcBehavior.dispose(): void

## engine/npc/examples/EXAMPLE_UnarmedNpcBehavior.ts
interface UnarmedNpcConfig
UnarmedNpcConfig.attackRange?: number
UnarmedNpcConfig.attackCooldown?: number
UnarmedNpcConfig.damage?: number
UnarmedNpcConfig.chaseSpeed?: number
UnarmedNpcConfig.fightingStance?: boolean
UnarmedNpcConfig.focusOffsetY?: number
class UnarmedNpcBehavior implements INpcBehavior — Hand-to-hand combat NPC: chases, squares up, and throws the shared unarmed
UnarmedNpcBehavior.focusOffsetY: number
UnarmedNpcBehavior.constructor(config: UnarmedNpcConfig = {})
UnarmedNpcBehavior.getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3
UnarmedNpcBehavior.clone(): UnarmedNpcBehavior
UnarmedNpcBehavior.initialize(controller: ICharacterContext): void
UnarmedNpcBehavior.update(deltaTime: number, currentPosition: THREE.Vector3, _currentTarget: THREE.Vector3 | null): THREE.Vector3 | null
UnarmedNpcBehavior.isHostile(): boolean
UnarmedNpcBehavior.getName(): string
UnarmedNpcBehavior.dispose(): void

## engine/npc/examples/EXAMPLE_VillagerFollowBehavior.ts
class ExampleFollowerVillagerManagerBehavior extends BaseNpcManagerBehavior — Example manager behavior for villagers that follow after interaction
ExampleFollowerVillagerManagerBehavior.constructor()
ExampleFollowerVillagerManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void
class ExampleRegularVillagerManagerBehavior extends BaseNpcManagerBehavior — Example manager behavior for regular villagers (no follow)
ExampleRegularVillagerManagerBehavior.constructor()
ExampleRegularVillagerManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void

## engine/npc/examples/EXAMPLE_VillagerManagerBehavior.ts
class VillagerManagerBehavior extends BaseNpcManagerBehavior — Example: Villager Manager Behavior
VillagerManagerBehavior.constructor()
VillagerManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void
VillagerManagerBehavior.onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean

## engine/npc/examples/EXAMPLE_ZombieBehavior.ts
class ExampleZombieBehavior extends NpcEnemyBehavior — Example zombie behavior with one-shot kill and explosion effects
ExampleZombieBehavior.initialize(controller: ICharacterContext): void

## engine/npc/examples/EXAMPLE_ZombieFactory.ts
function createZombieNpcFactory(): IBlockCharacterFactory
function createSkeletonNpcFactory(): IBlockCharacterFactory
function createGhoulNpcFactory(): IBlockCharacterFactory

## engine/npc/examples/NpcRangedWeaponHold.ts
class NpcRangedWeaponHold — NPC placement is measured in world metres, even when its model root is scaled.
NpcRangedWeaponHold.constructor(private readonly controller: NpcController, private readonly weapon: ReturnType<typeof createRangedWeaponMesh>, weaponScale: number)
NpcRangedWeaponHold.onPoseUpdated(): void
NpcRangedWeaponHold.getNextMuzzlePosition(target: THREE.Vector3): THREE.Vector3
NpcRangedWeaponHold.attachToCorpseHands(): void
NpcRangedWeaponHold.dispose(): void

## engine/npc/manager-behaviors/NpcEnemyManagerBehavior.ts
class NpcEnemyManagerBehavior extends BaseNpcManagerBehavior
NpcEnemyManagerBehavior.constructor(config?: NpcEnemyConfig & { autoRespawn?: boolean; respawnDelay?: number; })
NpcEnemyManagerBehavior.onNpcCreated(npc: NpcController, engine: EngineLike): void

## engine/npc/nav/GoalField.ts
interface CellNavSource — Structural interface over VoxelNavMesh's cell API (lets tests fake it).
CellNavSource.isReady(): boolean
CellNavSource.getGridInfo(): { cols: number; rows: number; minX: number; minZ: number; cellSize: number } | null
CellNavSource.getCellGroundY(gx: number, gz: number, refY?: number): number | null
CellNavSource.canStepCells(fromGx: number, fromGz: number, toGx: number, toGz: number, fromRefY?: number): boolean
CellNavSource.worldToCell(x: number, z: number): { gx: number; gz: number } | null
CellNavSource.cellToWorld(gx: number, gz: number): { x: number; z: number }
CellNavSource.getCellMutationVersion(): number
CellNavSource.getStepLimits?(): { maxClimbUp: number; maxDropDown: number }
const GOAL_FIELD_DEFAULTS = { radiusM: 150, rebuildMoveCells: 2, rebuildMinIntervalS: 0.
class GoalField
GoalField.key: string
GoalField.constructor(key: string, radiusM: number = GOAL_FIELD_DEFAULTS.radiusM)
GoalField.advanceClock(deltaTime: number): void
GoalField.setGoal(pos: THREE.Vector3): void
GoalField.isComplete(): boolean
GoalField.updateSlice(nav: CellNavSource, maxExpansions: number): void
GoalField.sampleDirection(x: number, z: number, refY?: number): THREE.Vector3 | null
GoalField.getCost(x: number, z: number, refY?: number): number | null
GoalField.getExpandedNodeCount(): number
GoalField.checkInvalidation(nav: CellNavSource): void
class GoalFieldManager — Owns the active goal fields: LRU-capped at maxActiveFields, splits the
GoalFieldManager.getOrCreate(key: string, radiusM: number = GOAL_FIELD_DEFAULTS.radiusM): GoalField
GoalFieldManager.get(key: string): GoalField | null
GoalFieldManager.touch(key: string): void
GoalFieldManager.activeCount(): number
GoalFieldManager.update(deltaTime: number, nav: CellNavSource | null): void
function getGlobalGoalFields(): GoalFieldManager
function disposeGlobalGoalFields(): void
