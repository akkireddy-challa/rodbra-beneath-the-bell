import * as THREE from 'three';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';

/**
 * State for shopkeeper behavior
 */
enum ShopkeeperState {
    Idle = 'idle',
    Aware = 'aware',       // Player in greeting range
    Greeting = 'greeting', // Playing greeting animation
    Ready = 'ready'        // Facing player, ready for interaction
}

/**
 * NpcShopkeeperBehavior - Friendly shopkeeper with greeting and interaction
 * 
 * ## Behavior
 * - Stay at fixed shop position
 * - Face player when in range
 * - Greet player when approaching (with cooldown)
 * - Provide interaction hooks for shop/dialogue UI
 * - Cycle through idle animations
 * - Non-hostile (doesn't explode when hit)
 * 
 * ## Configuration
 * @param shopPosition - Fixed position (shop counter/stall)
 * @param greetingRange - Distance to trigger greeting (default: 5.0)
 * @param interactionRange - Distance for shop interaction (default: 2.0)
 * @param greetingCooldown - Time between greetings in seconds (default: 10.0)
 * @param onPlayerInteract - Callback for shop UI/dialogue
 * @param shopkeeperName - For dialogue/UI display (default: "Shopkeeper")
 * @param idleAnimations - Custom idle animation names (default: [])
 */
export class NpcShopkeeperBehavior implements INpcBehavior {
    public focusOffsetY: number;
    private controller: ICharacterContext | null = null;
    private shopPosition: THREE.Vector3;
    private greetingRange: number;
    private interactionRange: number;
    private greetingCooldown: number;
    private onPlayerInteractCallback?: () => void;
    private shopkeeperName: string;
    private idleAnimations: string[];

    private state: ShopkeeperState = ShopkeeperState.Idle;
    private greetingCooldownTimer: number = 0;
    private hasGreetedRecently: boolean = false;

    constructor(config: {
        shopPosition: THREE.Vector3;
        greetingRange?: number;
        interactionRange?: number;
        greetingCooldown?: number;
        onPlayerInteract?: () => void;
        shopkeeperName?: string;
        idleAnimations?: string[];
        focusOffsetY?: number;
    }) {
        this.shopPosition = config.shopPosition;
        this.greetingRange = config.greetingRange ?? 5.0;
        this.interactionRange = config.interactionRange ?? 2.0;
        this.greetingCooldown = config.greetingCooldown ?? 10.0;
        this.onPlayerInteractCallback = config.onPlayerInteract;
        this.shopkeeperName = config.shopkeeperName ?? 'Shopkeeper';
        this.idleAnimations = config.idleAnimations ?? [];
        this.focusOffsetY = config.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
    }

    getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
        return createNpcFocusTarget(npcPosition, this.focusOffsetY);
    }

    initialize(controller: ICharacterContext): void {
        this.controller = controller;
        this.state = ShopkeeperState.Idle;
        this.greetingCooldownTimer = 0;
        this.hasGreetedRecently = false;
    }

    update(
        deltaTime: number,
        currentPosition: THREE.Vector3,
        currentTarget: THREE.Vector3 | null
    ): THREE.Vector3 | null {
        if (!this.controller) return null;

        // Update greeting cooldown
        if (this.hasGreetedRecently) {
            this.greetingCooldownTimer += deltaTime;
            if (this.greetingCooldownTimer >= this.greetingCooldown) {
                this.hasGreetedRecently = false;
                this.greetingCooldownTimer = 0;
            }
        }

        // Ensure we're at shop position. HORIZONTAL distance only — the
        // navigation arrives in 2D and a config-supplied shopPosition often
        // carries y=0 while the standing NPC sits at its body height; a 3D
        // distanceTo() would stay above the threshold from the Y term alone and
        // the shopkeeper would endlessly try to "return" to a spot it is already
        // standing on.
        const distanceFromShop = Math.hypot(
            currentPosition.x - this.shopPosition.x,
            currentPosition.z - this.shopPosition.z,
        );
        if (distanceFromShop > 0.5) {
            // Return to shop position
            return this.shopPosition;
        }

        // Get player position
        const playerPos = this.getPlayerPosition();
        if (!playerPos) {
            this.state = ShopkeeperState.Idle;
            return null;
        }

        const distanceToPlayer = currentPosition.distanceTo(playerPos);

        // State machine
        if (distanceToPlayer <= this.greetingRange) {
            // Player in greeting range
            if (this.state === ShopkeeperState.Idle) {
                this.state = ShopkeeperState.Aware;
                // TODO: Turn to face player
            }

            // Greet player if not greeted recently
            if (!this.hasGreetedRecently && this.state === ShopkeeperState.Aware) {
                this.greetPlayer();
            }

            // Check if in interaction range
            if (distanceToPlayer <= this.interactionRange) {
                this.state = ShopkeeperState.Ready;
                // Ready for player interaction (E key press)
            }
        } else {
            // Player left greeting range
            if (this.state !== ShopkeeperState.Idle) {
                this.state = ShopkeeperState.Idle;
                // TODO: Return to forward-facing position
            }
        }

        // Stay at shop position (no movement)
        return null;
    }

    /**
     * Greet the player with a message
     */
    private greetPlayer(): void {
        this.state = ShopkeeperState.Greeting;
        this.hasGreetedRecently = true;
        this.greetingCooldownTimer = 0;

        console.log(`👋 ${this.shopkeeperName}: Welcome!`);
        // TODO: Trigger greeting animation (wave, nod, etc.)
        
        // Return to ready state after greeting
        setTimeout(() => {
            if (this.state === ShopkeeperState.Greeting) {
                this.state = ShopkeeperState.Ready;
            }
        }, 1000);
    }

    /**
     * Get player position from engine (if available)
     */
    private getPlayerPosition(): THREE.Vector3 | null {
        const playerController = this.controller?.getEngine().getPlayerController();
        return playerController?.getPosition?.() ?? null;
    }

    onPlayerInteract(): boolean {
        if (this.state === ShopkeeperState.Ready || this.state === ShopkeeperState.Greeting) {
            console.log(`🛒 ${this.shopkeeperName}: Opening shop...`);
            
            // Call custom interaction callback if provided
            if (this.onPlayerInteractCallback) {
                this.onPlayerInteractCallback();
            } else {
                console.log('💬 Shop UI not yet implemented');
            }

            return true; // Handled interaction
        }

        return false; // Player too far away
    }

    onHit(impactDirection?: THREE.Vector3): boolean {
        // Shopkeeper reacts to being hit but doesn't fight back
        console.log(`😱 ${this.shopkeeperName}: Hey! Stop that!`);
        // Could trigger hurt/scared animation here
        return false; // Use default damage/knockback response (no explosion)
    }

    getName(): string {
        return `Shopkeeper (${this.shopkeeperName})`;
    }

    isHostile(): boolean {
        return false; // Shopkeepers are friendly
    }

    dispose(): void {
        this.controller = null;
    }
}

