import * as THREE from 'three';
import { NpcController } from 'engine/npc/core/NpcController.js';
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import { NpcPatrolBehavior } from 'engine/npc/behaviors/NpcPatrolBehavior.js';
import { NpcFollowBehavior } from 'engine/npc/behaviors/NpcFollowBehavior.js';
import { NpcHostileBehavior } from 'engine/npc/behaviors/NpcHostileBehavior.js';
import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
import { NpcShopkeeperBehavior } from 'engine/npc/behaviors/NpcShopkeeperBehavior.js';
import type { EngineLike } from 'types/game.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * NpcFactory - Easy NPC creation with behavior presets
 * 
 * Provides convenient methods for creating NPCs with pre-configured behaviors.
 * Simplifies NPC spawning for common use cases.
 */
export class NpcFactory {
    /**
     * Create a roaming melee enemy
     * Uses NpcEnemyBehavior: wanders near its spawn, chases and punches the player.
     * Pass `damage`/`detectionRange`/`chaseSpeed` to tune the combat, and call
     * `engine.getHUD().showHealth()` so the player can see the damage.
     */
    static async createWanderingEnemy(
        engine: EngineLike,
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        spawnPosition: THREE.Vector3,
        playerGLTF: any,
        characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number },
        config?: {
            moveSpeed?: number;
            stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling
            worldBounds?: number;
            retargetInterval?: number;
            detectionRange?: number;
            attackRange?: number;
            damage?: number;
            chaseSpeed?: number;
            baseAnimations?: any[];
            movementSystem?: IPlayerMovement;
        }
    ): Promise<NpcController> {
        const npc = await NpcController.create(
            scene,
            physicsWorld,
            engine,
            spawnPosition,
            playerGLTF,
            characterFactory,
            config?.moveSpeed ?? 2.7,
            config?.stunDuration ?? 0.5, // ignored by NpcController (stun removed)
            config?.baseAnimations,
            config?.movementSystem
        );

        npc.setBehavior(new NpcEnemyBehavior({
            worldBounds: config?.worldBounds ?? 15,
            retargetInterval: config?.retargetInterval ?? 5.0,
            // Undefined is fine — the behavior resolves each field with `??`.
            detectionRange: config?.detectionRange,
            attackRange: config?.attackRange,
            damage: config?.damage,
            chaseSpeed: config?.chaseSpeed,
        }));

        return npc;
    }

    /**
     * Create a patrolling guard
     */
    static async createPatrolGuard(
        engine: EngineLike,
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        spawnPosition: THREE.Vector3,
        playerGLTF: any,
        characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number },
        waypoints: THREE.Vector3[],
        config?: {
            moveSpeed?: number;
            stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling
            waitTimeAtWaypoint?: number;
            patrolMode?: 'circular' | 'ping-pong';
            detectPlayerRange?: number;
            baseAnimations?: any[];
            movementSystem?: IPlayerMovement;
        }
    ): Promise<NpcController> {
        const npc = await NpcController.create(
            scene,
            physicsWorld,
            engine,
            spawnPosition,
            playerGLTF,
            characterFactory,
            config?.moveSpeed ?? 2.0,
            config?.stunDuration ?? 0.5, // ignored by NpcController (stun removed)
            config?.baseAnimations,
            config?.movementSystem
        );

        npc.setBehavior(new NpcPatrolBehavior({
            waypoints,
            waitTimeAtWaypoint: config?.waitTimeAtWaypoint ?? 2.0,
            patrolMode: config?.patrolMode ?? 'circular',
            detectPlayerRange: config?.detectPlayerRange
        }));

        return npc;
    }

    /**
     * Create a follower companion
     */
    static async createFollowerCompanion(
        engine: EngineLike,
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        spawnPosition: THREE.Vector3,
        playerGLTF: any,
        characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number },
        target: THREE.Object3D,
        config?: {
            moveSpeed?: number;
            stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling
            minDistance?: number;
            maxDistance?: number;
            updateInterval?: number;
            baseAnimations?: any[];
            movementSystem?: IPlayerMovement;
        }
    ): Promise<NpcController> {
        const npc = await NpcController.create(
            scene,
            physicsWorld,
            engine,
            spawnPosition,
            playerGLTF,
            characterFactory,
            config?.moveSpeed ?? 2.5,
            config?.stunDuration ?? 0.5, // ignored by NpcController (stun removed)
            config?.baseAnimations,
            config?.movementSystem
        );

        npc.setBehavior(new NpcFollowBehavior({
            target,
            minDistance: config?.minDistance ?? 2.0,
            maxDistance: config?.maxDistance ?? 20.0,
            updateInterval: config?.updateInterval ?? 0.5
        }));

        return npc;
    }

    /**
     * Create a hostile chaser enemy
     */
    static async createHostileChaser(
        engine: EngineLike,
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        spawnPosition: THREE.Vector3,
        playerGLTF: any,
        characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number },
        config?: {
            moveSpeed?: number;
            stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling
            detectionRange?: number;
            attackRange?: number;
            chaseSpeed?: number;
            returnToOrigin?: boolean;
            baseAnimations?: any[];
            movementSystem?: IPlayerMovement;
        }
    ): Promise<NpcController> {
        const npc = await NpcController.create(
            scene,
            physicsWorld,
            engine,
            spawnPosition,
            playerGLTF,
            characterFactory,
            config?.chaseSpeed ?? 3.0,
            config?.stunDuration ?? 0.5, // ignored by NpcController (stun removed)
            config?.baseAnimations,
            config?.movementSystem
        );

        npc.setBehavior(new NpcHostileBehavior({
            detectionRange: config?.detectionRange ?? 10.0,
            attackRange: config?.attackRange ?? 2.0,
            chaseSpeed: config?.chaseSpeed ?? 3.0,
            returnToOrigin: config?.returnToOrigin ?? true
        }));

        return npc;
    }

    /**
     * Create an idle friendly NPC
     */
    static async createIdleNPC(
        engine: EngineLike,
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        spawnPosition: THREE.Vector3,
        playerGLTF: any,
        characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number },
        config?: {
            moveSpeed?: number;
            stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling
            lookAtPlayer?: boolean;
            lookAtRange?: number;
            randomIdleMotions?: boolean;
            baseAnimations?: any[];
            movementSystem?: IPlayerMovement;
        }
    ): Promise<NpcController> {
        const npc = await NpcController.create(
            scene,
            physicsWorld,
            engine,
            spawnPosition,
            playerGLTF,
            characterFactory,
            config?.moveSpeed ?? 0.0, // Idle NPCs don't move
            config?.stunDuration ?? 0.5, // ignored by NpcController (stun removed)
            config?.baseAnimations,
            config?.movementSystem
        );

        npc.setBehavior(new NpcIdleBehavior({
            lookAtPlayer: config?.lookAtPlayer ?? true,
            lookAtRange: config?.lookAtRange ?? 5.0,
            randomIdleMotions: config?.randomIdleMotions ?? false
        }));

        return npc;
    }

    /**
     * Create a shopkeeper NPC
     */
    static async createShopkeeper(
        engine: EngineLike,
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        shopPosition: THREE.Vector3,
        playerGLTF: any,
        characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number },
        config?: {
            moveSpeed?: number;
            stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling
            greetingRange?: number;
            interactionRange?: number;
            greetingCooldown?: number;
            onPlayerInteract?: () => void;
            shopkeeperName?: string;
            idleAnimations?: string[];
            baseAnimations?: any[];
            movementSystem?: IPlayerMovement;
        }
    ): Promise<NpcController> {
        const npc = await NpcController.create(
            scene,
            physicsWorld,
            engine,
            shopPosition,
            playerGLTF,
            characterFactory,
            config?.moveSpeed ?? 0.0, // Shopkeepers don't move from their position
            config?.stunDuration ?? 0.5, // ignored by NpcController (stun removed)
            config?.baseAnimations,
            config?.movementSystem
        );

        npc.setBehavior(new NpcShopkeeperBehavior({
            shopPosition,
            greetingRange: config?.greetingRange ?? 5.0,
            interactionRange: config?.interactionRange ?? 2.0,
            greetingCooldown: config?.greetingCooldown ?? 10.0,
            onPlayerInteract: config?.onPlayerInteract,
            shopkeeperName: config?.shopkeeperName ?? 'Shopkeeper',
            idleAnimations: config?.idleAnimations ?? []
        }));

        return npc;
    }

    /**
     * Create a custom NPC with a specific behavior
     * Use this for non-preset behavior combinations
     */
    static async createCustomNPC(
        engine: EngineLike,
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        spawnPosition: THREE.Vector3,
        playerGLTF: any,
        characterFactory: (characterGroup: THREE.Group) => { width: number; height: number; depth: number },
        behavior: any, // INpcBehavior
        config?: {
            moveSpeed?: number;
            stunDuration?: number; // Ignored — stun-on-hit was removed; kept so shipped configs keep compiling
            baseAnimations?: any[];
            movementSystem?: IPlayerMovement;
        }
    ): Promise<NpcController> {
        const npc = await NpcController.create(
            scene,
            physicsWorld,
            engine,
            spawnPosition,
            playerGLTF,
            characterFactory,
            config?.moveSpeed ?? 2.7,
            config?.stunDuration ?? 0.5, // ignored by NpcController (stun removed)
            config?.baseAnimations,
            config?.movementSystem
        );

        npc.setBehavior(behavior);

        return npc;
    }
}

