import * as THREE from 'three';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';

/**
 * Default vertical offset from an NPC's root to its face/focus point, in world units.
 * 1.6 matches a standing human's eye height. Behaviors with non-standard poses
 * (sitting, prone, tiny creatures, giants) should override via `focusOffsetY`.
 */
export const DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y = 1.6;

/**
 * Engine-pure helper: compute an NPC's focus point (where a conversation camera,
 * speech bubble, or targeting reticle should aim) from its root position and a
 * configured Y offset.
 */
export function createNpcFocusTarget(
    npcPosition: THREE.Vector3,
    focusOffsetY: number
): THREE.Vector3 {
    return npcPosition.clone().add(new THREE.Vector3(0, focusOffsetY, 0));
}

/**
 * Interface for pluggable NPC behavior systems.
 * Allows different AI behaviors (patrol, follow, hostile, idle, shopkeeper) to be
 * swapped easily, following the Strategy Pattern similar to IPlayerMovement and IPlayerAttack.
 *
 * ## Architecture
 * - **NpcController**: Handles rendering, animations, physics, collision
 * - **INpcBehavior**: Handles decision-making, target selection, interaction logic
 *
 * ## Usage Example
 */
export interface INpcBehavior {
    /**
     * Vertical offset from the NPC's root position to its face/focus point.
     * Used by conversation cameras, speech bubbles, and aim assist to target the
     * face instead of the feet. Defaults to `DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y`
     * (standing human eye height); set lower for sitting / small NPCs, higher for giants.
     */
    focusOffsetY: number;

    /**
     * Initialize behavior with NPC controller reference
     * Called once when behavior is assigned to an NPC
     *
     * @param controller - Reference to the NPC controller
     */
    initialize(controller: ICharacterContext): void;

    /**
     * Update behavior logic and determine movement targets
     * Called every frame by the NPC controller
     *
     * @param deltaTime - Time since last frame in seconds
     * @param currentPosition - Current NPC world position
     * @param currentTarget - Current target position (if any)
     * @returns New target position or null to stop moving
     */
    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null;

    /** Optional visual attachment correction after the live skeleton and block
     * parts are posed. Omitted by older behaviors; no work is done by default.
     * Use this for hand-relative visuals, not AI or physics updates. */
    onPoseUpdated?(): void;

    /**
     * Called when NPC detects player or other entity within detection range
     * Optional hook for behaviors that need to respond to nearby entities
     *
     * @param entity - Detected entity object
     * @param distance - Distance to entity in world units
     */
    onEntityDetected?(entity: THREE.Object3D, distance: number): void;

    /**
     * Called when NPC is hit by melee attack or projectile
     * Behavior can override default hit response
     *
     * @param impactDirection - Direction of impact (normalized vector)
     * @returns true if behavior handled the hit (skip default response), false for default response
     */
    onHit?(impactDirection?: THREE.Vector3): boolean;

    /**
     * Called when NPC dies (before explosion/removal).
     * Use this to handle cleanup that should happen immediately on death,
     * such as transferring in-flight projectiles to continue flying.
     */
    onNpcDeath?(): void;

    /**
     * Called when NPC reaches current movement target
     * Useful for waypoint systems, patrol behaviors, etc.
     */
    onTargetReached?(): void;

    /**
     * Called when player interacts with NPC (e.g., presses interact key)
     * Used by friendly NPCs like shopkeepers, quest givers, etc.
     *
     * @returns true if behavior handled interaction (e.g., opened shop UI)
     */
    onPlayerInteract?(): boolean;

    /**
     * Get behavior display name for debugging and UI
     *
     * @returns Human-readable behavior name (e.g., "Shopkeeper", "Hostile Enemy")
     */
    getName(): string;

    /**
     * Get whether this NPC is hostile to the player
     * Affects collision responses (hostile NPCs explode on hit, friendly NPCs don't)
     *
     * NOTE: this is about HIT RESPONSE, not about having something to do. Do not
     * read it as "this NPC always has a goal" — doing so pins every enemy to the
     * VIRTUAL sim class forever and makes HIBERNATED unreachable, which is what
     * `isEngaged` below exists to answer instead.
     *
     * @returns true if NPC should attack player / explode on hit
     */
    isHostile(): boolean;

    /**
     * Whether this NPC is ACTIVELY pursuing something right now — chasing,
     * attacking, fleeing, running an errand. Distinct from `isHostile()`: an
     * enemy that has never seen the player is hostile but not engaged.
     *
     * The simulation-tier scheduler uses this to decide whether a far, off-screen
     * crowd NPC can drop to `HIBERNATED` (frozen, costing nothing) or must stay
     * `VIRTUAL` (still progressing toward its goal). Returning true when nothing
     * is happening is the expensive mistake: it keeps the NPC simulating forever.
     *
     * Optional - defaults to "engaged whenever the NPC holds a navigation target",
     * which is correct for behaviours that only set a target when they have a
     * reason to move.
     *
     * @returns true if the NPC is pursuing something that must keep progressing
     */
    isEngaged?(): boolean;

    /**
     * Get whether this NPC can talk to the player
     * Affects the interaction prompt text:
     * - true: "[E] Talk to [name]"
     * - false: "[E] Interact with [name]"
     *
     * Optional - defaults to !isHostile() if not implemented
     *
     * @returns true if NPC can engage in dialog with player
     */
    canTalkToPlayer?(): boolean;

    /**
     * Compute the NPC's focus point (face/eye height) given its current root position.
     * Templates should call this when aiming conversation cameras, anchoring speech
     * bubbles, or positioning interaction prompts — never hand-roll a hardcoded Y offset.
     *
     * @param npcPosition - Current NPC root position (not mutated)
     * @returns A new Vector3 at the NPC's face/focus height
     */
    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3;

    /**
     * Cleanup behavior resources (timers, event listeners, etc.)
     * Called when behavior is removed or NPC is disposed
     */
    dispose(): void;

    /**
     * Whether this behavior emits short-range direct movement targets (e.g.
     * goal-field gradient steps) that must NOT be expanded into A* paths.
     * When true, the controller switches its navigation component to
     * straight-line paths on attach. Optional — omitting it means normal
     * pathfinding (backward compatible with shipped behaviors).
     */
    usesDirectTargets?(): boolean;

    /**
     * Clone the behavior for a new NPC instance
     * IMPORTANT: If this returns undefined, the same behavior instance is shared!
     * Always implement this if your behavior stores per-NPC state (controllers, weapons, etc.)
     *
     * @returns A fresh clone of this behavior with same config, or undefined to share instance
     */
    clone?(): INpcBehavior;
}
