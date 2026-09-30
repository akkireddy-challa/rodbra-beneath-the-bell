import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { getGlobalGoalFields, GOAL_FIELD_DEFAULTS } from 'engine/npc/nav/GoalField.js';

/**
 * NpcChaseBehavior - Goal-field-driven hostile chase behavior
 *
 * Chases the player via the shared GoalField instead of per-NPC A*: every NPC
 * chasing the same target samples one flood-filled cost field (O(1) per NPC),
 * which is what makes 200+ simultaneous chasers affordable. The behavior
 * returns short step-ahead targets along the field gradient; because it
 * declares `usesDirectTargets()`, NpcController switches the navigation
 * component to straight-line paths so these small steps never invoke A*.
 *
 * ## Behavior
 * - Sets the shared goal field's goal to the player position each update
 * - Walks the field gradient in stepAheadM increments
 * - Falls back to the raw player position when outside the field window or
 *   before the field is built (ordinary navigation takes over transitionally)
 * - Stops when within stopDistanceM of the player
 *
 * ## Configuration
 * @param target - Chase target; only 'player' is supported
 * @param fieldKey - Shared goal-field key; chasers of the same target must share it (default: 'player')
 * @param stopDistanceM - Stop when this close to the target, in meters (default: 1.5)
 * @param stepAheadM - Distance of each gradient step target, in meters (default: 2.5)
 */
export class NpcChaseBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private readonly target: 'player';
    private readonly fieldKey: string;
    private readonly stopDistanceM: number;
    private readonly stepAheadM: number;

    constructor(config: {
        target: 'player';
        fieldKey?: string;
        stopDistanceM?: number;
        stepAheadM?: number;
        focusOffsetY?: number;
    }) {
        this.target = config.target;
        this.fieldKey = config.fieldKey ?? 'player';
        this.stopDistanceM = config.stopDistanceM ?? 1.5;
        this.stepAheadM = config.stepAheadM ?? 2.5;
        this.focusOffsetY = config.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
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
        return new NpcChaseBehavior({
            target: this.target,
            fieldKey: this.fieldKey,
            stopDistanceM: this.stopDistanceM,
            stepAheadM: this.stepAheadM,
            focusOffsetY: this.focusOffsetY,
        });
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        _currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        void deltaTime;
        if (!this.controller) return null;

        const playerPos = this.resolvePlayerPosition();
        if (!playerPos) return null;
        if (currentPosition.distanceToSquared(playerPos) <= this.stopDistanceM * this.stopDistanceM) {
            return null;
        }

        const field = getGlobalGoalFields().getOrCreate(this.fieldKey, GOAL_FIELD_DEFAULTS.radiusM);
        field.setGoal(playerPos);
        const dir = field.sampleDirection(currentPosition.x, currentPosition.z, currentPosition.y);
        if (dir) {
            return new THREE.Vector3(
                currentPosition.x + dir.x * this.stepAheadM,
                currentPosition.y,
                currentPosition.z + dir.z * this.stepAheadM
            );
        }
        // Outside the field window / field not built yet: fall back to ordinary
        // pathfinding toward the player (transitional; re-enters the field soon).
        return playerPos.clone();
    }

    /** Player visual position via the engine's registered player controller. */
    private resolvePlayerPosition(): THREE.Vector3 | null {
        const playerController = this.controller?.getEngine().getPlayerController();
        return playerController?.getPosition?.() ?? null;
    }

    getName(): string {
        return 'Chase';
    }

    isHostile(): boolean {
        return true;
    }

    /** Field steps are short direct targets — navigation must not run A* on them. */
    usesDirectTargets(): boolean {
        return true;
    }

    dispose(): void {
        this.controller = null;
    }
}
