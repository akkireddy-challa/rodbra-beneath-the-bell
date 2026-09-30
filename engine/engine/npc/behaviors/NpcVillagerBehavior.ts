import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { NpcSpeechBubble } from 'engine/npc/utils/NpcSpeechBubble.js';
import { NpcFollowBehavior } from 'engine/npc/behaviors/NpcFollowBehavior.js';

/**
 * NpcVillagerBehavior - Friendly villager with speech bubble interactions
 * 
 * ⚠️ EXAMPLE TEMPLATE: This shows how to create interactable NPCs with speech bubbles!
 * 
 * ## Behavior
 * - Stay at fixed position (idle)
 * - Face player when nearby
 * - Show speech bubble when player interacts (E key)
 * - Multiple greeting messages for variety
 * - Optional: Switch to follow behavior after interaction
 * 
 * ## Usage Example
 * 
 * ## Configuration
 * @param greetingMessages - Array of messages to randomly pick from when interacted with
 * @param greetingMessage - Single message to always show (if greetingMessages not provided)
 * @param lookAtPlayer - Turn to face player when nearby (default: true)
 * @param lookAtRange - Distance to start facing player (default: 5.0)
 * @param followAfterInteraction - Switch to follow behavior after player interacts (default: false)
 * @param followConfig - Configuration for follow behavior (used when followAfterInteraction is true)
 */
export class NpcVillagerBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private greetingMessages: string[];
    private lookAtPlayer: boolean;
    private lookAtRange: number;
    private followAfterInteraction: boolean;
    private followConfig?: {
        minDistance?: number;
        maxDistance?: number;
        updateInterval?: number;
    };

    private idlePosition: THREE.Vector3 | null = null;
    private currentSpeechBubble: NpcSpeechBubble | null = null;
    private hasSwitchedToFollow: boolean = false;

    constructor(config?: {
        greetingMessages?: string[];
        greetingMessage?: string;
        lookAtPlayer?: boolean;
        lookAtRange?: number;
        followAfterInteraction?: boolean;
        followConfig?: {
            minDistance?: number;
            maxDistance?: number;
            updateInterval?: number;
        };
        focusOffsetY?: number;
    }) {
        // Set greeting messages
        if (config?.greetingMessages && config.greetingMessages.length > 0) {
            this.greetingMessages = config.greetingMessages;
        } else if (config?.greetingMessage) {
            this.greetingMessages = [config.greetingMessage];
        } else {
            // Default messages
            this.greetingMessages = [
                'Hello!',
                'Greetings!',
                'How can I help you?',
                'Nice to meet you!'
            ];
        }

        this.lookAtPlayer = config?.lookAtPlayer ?? true;
        this.lookAtRange = config?.lookAtRange ?? 5.0;
        this.followAfterInteraction = config?.followAfterInteraction ?? false;
        this.followConfig = config?.followConfig;
        this.focusOffsetY = config?.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    /**
     * Fresh per-NPC instance with the same config. REQUIRED: this behaviour holds
     * per-NPC state (controller, idlePosition) set in initialize(); without clone()
     * the engine shares ONE instance across every spawn of a registered handle, so
     * the last spawn's idlePosition wins and earlier NPCs walk onto the last one.
     */
    clone(): INpcBehavior {
        return new NpcVillagerBehavior({
            greetingMessages: this.greetingMessages,
            lookAtPlayer: this.lookAtPlayer,
            lookAtRange: this.lookAtRange,
            followAfterInteraction: this.followAfterInteraction,
            followConfig: this.followConfig,
            focusOffsetY: this.focusOffsetY,
        });
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.idlePosition = controller.getPosition().clone();
        this.hasSwitchedToFollow = false;
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller) return null;

        // If already switched to follow, this behavior should not be active
        // (This is a safety check - the behavior should have been replaced)
        if (this.hasSwitchedToFollow) {
            return null;
        }

        // Handle looking at player
        if (this.lookAtPlayer) {
            const playerPos = this.getPlayerPosition();
            if (playerPos) {
                const distanceToPlayer = currentPosition.distanceTo(playerPos);
                if (distanceToPlayer <= this.lookAtRange) {
                    // TODO: Make NPC face player
                    // This would require adding a lookAt method to NpcController
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

    /**
     * Handle player interaction - show speech bubble
     * 
     * ⚠️ THIS IS THE KEY METHOD FOR MAKING NPCs INTERACTABLE!
     * 
     * When player presses E key near this NPC, this method is called.
     * Return true to indicate interaction was handled.
     * 
     * If followAfterInteraction is enabled, switches to follow behavior after showing message.
     */
    onPlayerInteract(): boolean {
        if (!this.controller || this.hasSwitchedToFollow) return false;

        // Dispose existing speech bubble if any
        if (this.currentSpeechBubble) {
            this.currentSpeechBubble.dispose();
            this.currentSpeechBubble = null;
        }

        // Pick random greeting message
        const randomIndex = Math.floor(Math.random() * this.greetingMessages.length);
        const message = this.greetingMessages[randomIndex] || 'Hello!';

        // Show speech bubble above NPC
        const engine = this.controller.getEngine();
        const character = this.controller.getCharacter();
        this.currentSpeechBubble = new NpcSpeechBubble(
            character,
            engine,
            message,
            3000 // Show for 3 seconds
        );

        // If configured to follow after interaction, switch behavior
        if (this.followAfterInteraction) {
            this.switchToFollowBehavior();
        }

        return true; // Interaction handled
    }

    /**
     * Switch to follow behavior after interaction
     * 
     * This method is only called when followAfterInteraction is enabled and player interacts.
     * It creates a new NpcFollowBehavior and switches to it via requestBehaviorChange().
     */
    private switchToFollowBehavior(): void {
        if (!this.controller || this.hasSwitchedToFollow) return;

        this.hasSwitchedToFollow = true;

        // Create follow behavior with configured settings
        const followBehavior = new NpcFollowBehavior({
            target: 'player', // Automatically follow player
            minDistance: this.followConfig?.minDistance ?? 2.0,
            maxDistance: this.followConfig?.maxDistance ?? 20.0,
            updateInterval: this.followConfig?.updateInterval ?? 0.5
        });

        // Request behavior change through controller
        this.controller.requestBehaviorChange(followBehavior);

        console.log('👋 Villager will now follow the player!');
    }

    getName(): string {
        return 'Villager';
    }

    /**
     * Optional: Customize the interaction prompt text
     * If not implemented, NpcController will generate a default based on getName()
     */
    getInteractDisplayName(): string {
        return 'talk to villager';
    }

    isHostile(): boolean {
        return false; // Villagers are friendly
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

