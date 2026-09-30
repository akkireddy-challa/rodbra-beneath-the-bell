import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { NpcSpeechBubble } from 'engine/npc/utils/NpcSpeechBubble.js';

/**
 * NpcIdleBehavior - Stay in place (friendly/neutral NPC)
 * 
 * ## Behavior
 * - Stay at fixed position
 * - Optionally turn to face player when nearby
 * - Can respond to interactions with speech bubbles
 * - Optional random idle motions (small turns)
 * 
 * ## Configuration
 * @param lookAtPlayer - Turn to face player when nearby (default: true)
 * @param lookAtRange - Distance to start facing player (default: 5.0)
 * @param randomIdleMotions - Small random turns for variation (default: false)
 * @param greetingMessage - Message to show when player interacts (default: "Hello!")
 * @param greetingMessages - Array of random messages to pick from (optional)
 */
export class NpcIdleBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private lookAtPlayer: boolean;
    private lookAtRange: number;
    private randomIdleMotions: boolean;
    private greetingMessage: string | null;
    private greetingMessages: string[] | null;

    private idlePosition: THREE.Vector3 | null = null;
    private randomMotionTimer: number = 0;
    private randomMotionInterval: number = 3.0; // Random motion every 3 seconds
    private currentSpeechBubble: NpcSpeechBubble | null = null;

    constructor(config?: {
        lookAtPlayer?: boolean;
        lookAtRange?: number;
        randomIdleMotions?: boolean;
        greetingMessage?: string;
        greetingMessages?: string[];
        focusOffsetY?: number;
    }) {
        this.lookAtPlayer = config?.lookAtPlayer ?? true;
        this.lookAtRange = config?.lookAtRange ?? 5.0;
        this.randomIdleMotions = config?.randomIdleMotions ?? false;
        this.greetingMessage = config?.greetingMessage ?? null;
        this.greetingMessages = config?.greetingMessages ?? null;
        this.focusOffsetY = config?.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    /**
     * Fresh per-NPC instance with the same config. REQUIRED: holds per-NPC state
     * (controller, idlePosition) set in initialize(); without clone() the engine
     * shares one instance across every spawn of a handle, so the last spawn's
     * idlePosition wins and earlier NPCs walk onto the last one.
     */
    clone(): INpcBehavior {
        return new NpcIdleBehavior({
            lookAtPlayer: this.lookAtPlayer,
            lookAtRange: this.lookAtRange,
            randomIdleMotions: this.randomIdleMotions,
            greetingMessage: this.greetingMessage ?? undefined,
            greetingMessages: this.greetingMessages ?? undefined,
            focusOffsetY: this.focusOffsetY,
        });
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.idlePosition = controller.getPosition().clone();
        this.randomMotionTimer = 0;
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller) return null;

        // Handle random idle motions
        if (this.randomIdleMotions) {
            this.randomMotionTimer += deltaTime;
            if (this.randomMotionTimer >= this.randomMotionInterval) {
                this.randomMotionTimer = 0;
                // TODO: Trigger random idle animation or slight turn
                // This would be handled by the controller's animation system
            }
        }

        // Handle looking at player
        if (this.lookAtPlayer) {
            const playerPos = this.getPlayerPosition();
            if (playerPos) {
                const distanceToPlayer = currentPosition.distanceTo(playerPos);
                if (distanceToPlayer <= this.lookAtRange) {
                    // TODO: Make NPC face player
                    // This would require adding a lookAt method to NpcController
                    // For now, just log it
                    // console.log('Player nearby, facing player');
                }
            }
        }

        // Check if we've moved from idle position
        if (this.idlePosition) {
            const distanceFromIdle = currentPosition.distanceTo(this.idlePosition);
            if (distanceFromIdle > 0.5) {
                // Return to idle position
                return this.idlePosition;
            }
        }

        // Stay idle (no movement)
        return null;
    }

    /**
     * Get player position from engine (if available)
     */
    private getPlayerPosition(): THREE.Vector3 | null {
        const playerController = this.controller?.getEngine().getPlayerController();
        return playerController?.getPosition?.() ?? null;
    }

    onPlayerInteract(): boolean {
        if (!this.controller) return false;

        // Dispose existing speech bubble if any
        if (this.currentSpeechBubble) {
            this.currentSpeechBubble.dispose();
            this.currentSpeechBubble = null;
        }

        // Get message to display
        let message = 'Hello!';
        if (this.greetingMessages && this.greetingMessages.length > 0) {
            // Pick random message from array
            const randomIndex = Math.floor(Math.random() * this.greetingMessages.length);
            message = this.greetingMessages[randomIndex] || 'Hello!';
        } else if (this.greetingMessage) {
            message = this.greetingMessage;
        }

        // Show speech bubble
        const engine = this.controller.getEngine();
        const character = this.controller.getCharacter();
        this.currentSpeechBubble = new NpcSpeechBubble(
            character,
            engine,
            message,
            3000 // Show for 3 seconds
        );

        return true; // Handled interaction
    }

    getName(): string {
        return 'Idle';
    }

    isHostile(): boolean {
        return false;
    }

    dispose(): void {
        // Clean up speech bubble
        if (this.currentSpeechBubble) {
            this.currentSpeechBubble.dispose();
            this.currentSpeechBubble = null;
        }
        this.controller = null;
    }
}

