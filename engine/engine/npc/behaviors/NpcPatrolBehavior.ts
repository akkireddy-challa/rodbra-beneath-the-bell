import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { NpcHostileBehavior } from 'engine/npc/behaviors/NpcHostileBehavior.js';

/**
 * NpcPatrolBehavior - Patrol between predefined waypoints
 * 
 * ## Behavior
 * - Patrol between waypoints in circular or ping-pong mode
 * - Wait at each waypoint for configurable duration
 * - Optional player detection to break patrol and switch to hostile behavior
 * 
 * ## Configuration
 * @param waypoints - Array of positions to patrol between
 * @param waitTimeAtWaypoint - Seconds to wait at each waypoint (default: 2)
 * @param patrolMode - 'circular' (0→1→2→0) or 'ping-pong' (0→1→2→1→0) (default: 'circular')
 * @param detectPlayerRange - If set, switches to hostile behavior when player in range
 * @param chaseBehaviorConfig - Configuration for the hostile behavior when switching (optional)
 * 
 * ## Usage Example
 */
export class NpcPatrolBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private waypoints: THREE.Vector3[];
    private currentWaypointIndex: number = 0;
    private waitTimeAtWaypoint: number;
    private patrolMode: 'circular' | 'ping-pong';
    private detectPlayerRange?: number;
    private chaseBehaviorConfig?: {
        detectionRange?: number;
        attackRange?: number;
        chaseSpeed?: number;
        returnToOrigin?: boolean;
        updateInterval?: number;
    };

    private waitTimer: number = 0;
    private isWaiting: boolean = false;
    private pingPongDirection: number = 1; // 1 = forward, -1 = backward
    private hasSwitchedToChase: boolean = false;

    constructor(config: {
        waypoints: THREE.Vector3[];
        waitTimeAtWaypoint?: number;
        patrolMode?: 'circular' | 'ping-pong';
        detectPlayerRange?: number;
        chaseBehaviorConfig?: {
            detectionRange?: number;
            attackRange?: number;
            chaseSpeed?: number;
            returnToOrigin?: boolean;
            updateInterval?: number;
        };
        focusOffsetY?: number;
    }) {
        if (!config.waypoints || config.waypoints.length === 0) {
            throw new Error('NpcPatrolBehavior requires at least one waypoint');
        }

        this.waypoints = config.waypoints;
        this.waitTimeAtWaypoint = config.waitTimeAtWaypoint ?? 2.0;
        this.patrolMode = config.patrolMode ?? 'circular';
        this.detectPlayerRange = config.detectPlayerRange;
        this.chaseBehaviorConfig = config.chaseBehaviorConfig;
        this.focusOffsetY = config.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    /**
     * Fresh per-NPC instance with the same config. REQUIRED: holds per-NPC state
     * (controller, currentWaypointIndex, wait/ping-pong state) set in initialize();
     * without clone() the engine shares one instance across every spawn of a
     * handle, so multiple patrollers would share a single waypoint cursor.
     */
    clone(): INpcBehavior {
        return new NpcPatrolBehavior({
            waypoints: this.waypoints,
            waitTimeAtWaypoint: this.waitTimeAtWaypoint,
            patrolMode: this.patrolMode,
            detectPlayerRange: this.detectPlayerRange,
            chaseBehaviorConfig: this.chaseBehaviorConfig,
            focusOffsetY: this.focusOffsetY,
        });
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.currentWaypointIndex = 0;
        this.waitTimer = 0;
        this.isWaiting = false;
        this.pingPongDirection = 1;
        this.hasSwitchedToChase = false;
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller || this.waypoints.length === 0) return null;

        // If already switched to chase, this behavior should not be active
        // (This is a safety check - the behavior should have been replaced)
        if (this.hasSwitchedToChase) {
            return null;
        }

        // Check for player detection (if enabled)
        if (this.detectPlayerRange !== undefined) {
            const playerPos = this.getPlayerPosition();
            if (playerPos) {
                const distanceToPlayer = currentPosition.distanceTo(playerPos);
                if (distanceToPlayer <= this.detectPlayerRange) {
                    // Switch to hostile behavior
                    this.switchToChaseBehavior();
                    return null; // Stop current patrol logic
                }
            }
        }

        // If waiting at waypoint
        if (this.isWaiting) {
            this.waitTimer += deltaTime;
            if (this.waitTimer >= this.waitTimeAtWaypoint) {
                // Done waiting, move to next waypoint
                this.isWaiting = false;
                this.waitTimer = 0;
                this.advanceToNextWaypoint();
            }
            return null; // Stay at current position while waiting
        }

        // Check if we've reached the current waypoint.
        // HORIZONTAL distance only — the navigation arrives in 2D (it ignores Y,
        // see NavigationComponent arrival check), and supplied waypoints often
        // carry y=0 while the standing NPC sits at its body height. A 3D
        // distanceTo() would never drop below the threshold from the Y term
        // alone, so the patrol would never register arrival and would freeze at
        // the first waypoint. Match the navigation: compare x/z only.
        const targetWaypoint = this.waypoints[this.currentWaypointIndex];
        if (targetWaypoint) {
            const distance = Math.hypot(
                currentPosition.x - targetWaypoint.x,
                currentPosition.z - targetWaypoint.z,
            );

            // If close enough to waypoint, start waiting
            if (distance < 0.5) {
                this.isWaiting = true;
                this.waitTimer = 0;
                return null; // Stop moving
            }
        }

        // Return current waypoint as target
        return targetWaypoint || null;
    }

    /**
     * Advance to the next waypoint based on patrol mode
     */
    private advanceToNextWaypoint(): void {
        if (this.patrolMode === 'circular') {
            // Circular mode: 0 → 1 → 2 → 0
            this.currentWaypointIndex = (this.currentWaypointIndex + 1) % this.waypoints.length;
        } else {
            // Ping-pong mode: 0 → 1 → 2 → 1 → 0
            this.currentWaypointIndex += this.pingPongDirection;

            // Check if we've reached the end
            if (this.currentWaypointIndex >= this.waypoints.length) {
                this.currentWaypointIndex = this.waypoints.length - 2;
                this.pingPongDirection = -1;
            } else if (this.currentWaypointIndex < 0) {
                this.currentWaypointIndex = 1;
                this.pingPongDirection = 1;
            }

            // Clamp to valid range
            this.currentWaypointIndex = Math.max(0, Math.min(this.waypoints.length - 1, this.currentWaypointIndex));
        }
    }

    /**
     * Switch to chase behavior when player detected
     * 
     * This method is only called when detectPlayerRange is defined and player is detected.
     * It creates a new NpcHostileBehavior and switches to it via requestBehaviorChange().
     */
    private switchToChaseBehavior(): void {
        if (!this.controller || this.hasSwitchedToChase) return;

        // Safety check: detectPlayerRange must be defined (should always be true when this is called)
        if (this.detectPlayerRange === undefined) {
            console.warn('⚠️ [NpcPatrolBehavior] Cannot switch to chase: detectPlayerRange not set');
            return;
        }

        this.hasSwitchedToChase = true;

        // Create hostile behavior with configured settings
        // Default detectionRange is 1.5x the detectPlayerRange to ensure smooth transition
        const hostileBehavior = new NpcHostileBehavior({
            detectionRange: this.chaseBehaviorConfig?.detectionRange ?? (this.detectPlayerRange * 1.5),
            attackRange: this.chaseBehaviorConfig?.attackRange ?? 2.0,
            chaseSpeed: this.chaseBehaviorConfig?.chaseSpeed ?? 3.0,
            returnToOrigin: this.chaseBehaviorConfig?.returnToOrigin ?? false, // Don't return to origin, keep chasing
            updateInterval: this.chaseBehaviorConfig?.updateInterval ?? 0.3
        });

        // Request behavior change through controller
        this.controller.requestBehaviorChange(hostileBehavior);

        console.log('🎯 Patrol NPC detected player! Switching to chase behavior...');
    }

    /**
     * Get player position from engine (if available)
     */
    private getPlayerPosition(): THREE.Vector3 | null {
        const playerController = this.controller?.getEngine().getPlayerController();
        return playerController?.getPosition?.() ?? null;
    }

    onTargetReached(): void {
        // Start waiting when target reached
        this.isWaiting = true;
        this.waitTimer = 0;
    }

    getName(): string {
        return `Patrol (${this.patrolMode})`;
    }

    isHostile(): boolean {
        return false; // Patrol NPCs are not hostile by default
    }

    dispose(): void {
        this.controller = null;
    }
}

