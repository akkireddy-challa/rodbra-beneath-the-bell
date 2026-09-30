import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import type { NpcMeleeAttackConfig, ResolvedNpcMeleeAttackConfig } from 'engine/npc/behaviors/NpcMeleeAttack.js';
import { NpcMeleeAttack, resolveNpcMeleeAttackConfig } from 'engine/npc/behaviors/NpcMeleeAttack.js';
import { getGlobalGoalFields, GOAL_FIELD_DEFAULTS } from 'engine/npc/nav/GoalField.js';

/**
 * Shared goal-field key for "everything chasing the player". Every enemy uses
 * the SAME key on purpose — one flood serves the whole horde. Splitting keys per
 * NPC type would rebuild the same field several times over.
 */
const CHASE_FIELD_KEY = 'player';
/** Length of one gradient step toward the player, in metres. Short enough that
 *  navigation treats it as a direct move and never runs A* on it. */
const CHASE_STEP_M = 2.5;

/**
 * NpcEnemyBehavior - A roaming enemy: wanders near its spawn, chases and punches
 * the player on sight, then goes back to roaming.
 *
 * ## Behavior
 * - Wanders to random points within `worldBounds` of **its own spawn point**,
 *   picking a new one every `retargetInterval` seconds
 * - Chases at `chaseSpeed` when the player comes within `detectionRange`
 * - Punches for `damage` every `attackCooldown` seconds once within `attackRange`
 * - Resumes wandering near its spawn once the player escapes
 *
 * The combat itself lives in `NpcMeleeAttack`, shared with `NpcHostileBehavior` — see
 * that file for the hit test, the attack animation, and the tuning fields inherited
 * from `NpcMeleeAttackConfig`. Use `NpcHostileBehavior` for a guard that holds its post
 * instead of roaming, or `MeleeNpcBehavior` for an enemy that swings a real weapon.
 *
 * **The player only sees the damage if the game shows a health bar** — call
 * `engine.getHUD().showHealth({ width: 200 })` when registering hostile NPCs.
 *
 * Pass `detectionRange: 0` for a harmless wanderer that ignores the player entirely,
 * or `attacksPlayer: false` for one that gives chase but never lands a hit.
 *
 * ## Configuration
 * @param worldBounds - Width of the wander box centred on the spawn point (default: 15)
 * @param retargetInterval - Seconds between picking new wander targets (default: 5)
 * @param idleDuration - Reserved; not currently used
 * @param detectionRange - Distance at which the player is noticed (default: 10); `0` to never aggro
 * @param attackRange - Distance to stop and punch (default: 2.0)
 * @param damage - Damage per landed punch (default: 10)
 * @param chaseSpeed - Movement speed while chasing (default: 4.0)
 */
export class NpcEnemyBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private retargetTimer: number = 0;
    private retargetInterval: number;
    private worldBounds: number;
    private idleDuration: number;

    /** Resolved once so `clone()` can forward every field already defaulted. */
    private readonly meleeConfig: ResolvedNpcMeleeAttackConfig;
    /**
     * Built in initialize(), never in the constructor: `RangedNpcBehavior` and
     * `ExampleZombieBehavior` extend this class and clone themselves by shallow-copying
     * fields, so a constructor-created helper would be shared across every spawn (one
     * cooldown, one controller for all of them).
     */
    private melee: NpcMeleeAttack | null = null;

    /** Spawn point — the centre of the wander box, captured in initialize(). */
    private originPosition: THREE.Vector3 | null = null;
    private wasEngaged: boolean = false;
    /** True while the current target is a goal-field gradient step (see chaseStep). */
    private chasingViaField: boolean = false;

    constructor(config?: NpcMeleeAttackConfig & {
        worldBounds?: number;
        retargetInterval?: number;
        idleDuration?: number;
        focusOffsetY?: number;
    }) {
        this.worldBounds = config?.worldBounds ?? 15;
        this.retargetInterval = config?.retargetInterval ?? 5;
        this.idleDuration = config?.idleDuration ?? 1.0;
        this.focusOffsetY = config?.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
        this.meleeConfig = resolveNpcMeleeAttackConfig(config);
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    /**
     * Fresh per-NPC instance with the same config. REQUIRED so the engine gives
     * each spawn of a registered handle its own behaviour (per-NPC state lives in
     * initialize()); without clone() one instance is shared across all spawns.
     */
    clone(): INpcBehavior {
        return new NpcEnemyBehavior({
            ...this.meleeConfig,
            worldBounds: this.worldBounds,
            retargetInterval: this.retargetInterval,
            idleDuration: this.idleDuration,
            focusOffsetY: this.focusOffsetY,
        });
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.retargetTimer = 0;
        this.wasEngaged = false;
        // Clone: getPosition() hands back the character's live position vector, so
        // without this the "spawn point" would follow the NPC around.
        this.originPosition = controller.getPosition().clone();
        this.melee = new NpcMeleeAttack(this.meleeConfig);
        this.melee.initialize(controller);
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller || !this.melee) return null;

        const engagement = this.melee.update(deltaTime, currentPosition);

        switch (engagement.state) {
            case 'attack':
                this.wasEngaged = true;
                // Hold still while punching; the helper keeps the NPC facing the player.
                return null;

            case 'chase':
                this.wasEngaged = true;
                // Only a chase after the PLAYER may use the shared goal field — it holds
                // exactly one goal for every enemy sampling it, so an NPC chasing another
                // NPC (a `findTargets` free-for-all) would drag the whole horde with it.
                // Those fall back to ordinary pathfinding on the raw target position.
                return engagement.target.isPlayer
                    ? this.chaseStep(currentPosition, engagement.targetPosition)
                    : engagement.targetPosition;

            case 'disengaged':
                return this.wander(deltaTime, currentTarget);
        }
    }

    /**
     * One step toward the player along the SHARED goal field.
     *
     * Every enemy chasing the player samples one flood-filled cost field — O(1)
     * per NPC — instead of each running its own A*. That is the difference
     * between a handful of chasers and a horde: a single layered A* over a
     * city-scale level costs a median ~19 ms (see PathRequestQueue), so 30
     * simultaneous re-plans cannot fit in a frame no matter how they are
     * budgeted, while 300 field samples are array reads.
     *
     * The returned target is deliberately SHORT (`CHASE_STEP_M`), so navigation
     * treats it as a direct step (see usesDirectTargets) and never invokes A*
     * on it. Before the field is built, or outside its window, we fall back to
     * the raw player position and ordinary pathfinding takes over until the
     * field catches up.
     */
    private chaseStep(currentPosition: THREE.Vector3, playerPosition: THREE.Vector3): THREE.Vector3 {
        const field = getGlobalGoalFields().getOrCreate(CHASE_FIELD_KEY, GOAL_FIELD_DEFAULTS.radiusM);
        field.setGoal(playerPosition);
        const dir = field.sampleDirection(currentPosition.x, currentPosition.z, currentPosition.y);
        if (!dir) {
            this.chasingViaField = false;
            return playerPosition;
        }
        this.chasingViaField = true;
        return new THREE.Vector3(
            currentPosition.x + dir.x * CHASE_STEP_M,
            currentPosition.y,
            currentPosition.z + dir.z * CHASE_STEP_M,
        );
    }

    /**
     * True only while stepping along the goal field. Wander targets still need
     * real pathfinding — they are metres away across arbitrary city geometry and
     * a straight line would walk through walls — so this answer changes with the
     * NPC's mode rather than being fixed at install.
     */
    usesDirectTargets(): boolean {
        return this.chasingViaField;
    }

    /** Random walk inside the spawn box. */
    private wander(deltaTime: number, currentTarget: THREE.Vector3 | null): THREE.Vector3 {
        // Leaving the chase: wander targets are pathfound, not stepped.
        this.chasingViaField = false;
        if (this.wasEngaged) {
            // Just lost the player. Head straight back into the wander box rather than
            // resuming the chase target we were walking toward when combat started.
            this.wasEngaged = false;
            this.retargetTimer = 0;
            return this.pickNewTarget();
        }

        this.retargetTimer += deltaTime;
        if (this.retargetTimer >= this.retargetInterval || !currentTarget) {
            this.retargetTimer = 0;
            return this.pickNewTarget();
        }
        return currentTarget;
    }

    /**
     * Pick a new random target within `worldBounds` of the SPAWN POINT, snapped to
     * world height. (Before the spawn point was tracked, every enemy wandered around
     * the world origin — an NPC spawned at the far end of the map walked to 0,0.)
     */
    private pickNewTarget(): THREE.Vector3 {
        const origin = this.originPosition;
        const x = (origin?.x ?? 0) + (Math.random() - 0.5) * this.worldBounds;
        const z = (origin?.z ?? 0) + (Math.random() - 0.5) * this.worldBounds;
        const y = this.controller?.getEngine().getWorldHeightAt?.(x, z) ?? 0;
        return new THREE.Vector3(x, y, z);
    }

    onHit(): boolean {
        // Taking a hit interrupts the wind-up rather than landing the punch anyway.
        this.melee?.cancelSwing();
        return false; // keep the default damage/knockback response
    }

    getName(): string {
        return 'Hostile Enemy';
    }

    isHostile(): boolean {
        return true;
    }

    /**
     * Engaged only while actually pursuing the player. A raider standing in a
     * ruin it has never left, with the player half a map away, is hostile but
     * has nothing to do — and must be allowed to hibernate, or a world full of
     * enemies simulates forever. `wasEngaged` is set by update() on the
     * `chase`/`attack` states and cleared when the wander resumes.
     */
    isEngaged(): boolean {
        return this.wasEngaged;
    }

    dispose(): void {
        this.melee?.dispose();
        this.melee = null;
        this.controller = null;
    }
}
