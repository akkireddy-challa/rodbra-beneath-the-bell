import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';

/**
 * 🗣️ NPC Speech Bubble System
 * 
 * Displays speech bubbles above NPCs with text messages.
 * Speech bubbles automatically position themselves above the NPC and fade out after a duration.
 * 
 * ## Usage Example
 */
export class NpcSpeechBubble {
    private npcObject: THREE.Object3D;
    private engine: EngineLike;
    private bubbleElement: HTMLDivElement | null = null;
    private offset: THREE.Vector3;
    private duration: number;
    private fadeOutTimer: number | null = null;
    private updateTimer: number | null = null;

    /**
     * Create a speech bubble above an NPC
     * 
     * @param npcObject - The NPC's THREE.Object3D (use controller.getCharacter())
     * @param engine - Game engine reference
     * @param message - Text to display in the bubble
     * @param durationMs - How long to show the bubble in milliseconds (default: 3000)
     * @param offset - Offset above NPC head (default: (0, 1.8, 0) - just above head)
     */
    constructor(
        npcObject: THREE.Object3D,
        engine: EngineLike,
        message: string,
        durationMs: number = 3000,
        offset?: THREE.Vector3
    ) {
        this.npcObject = npcObject;
        this.engine = engine;
        this.duration = durationMs;
        this.offset = offset || new THREE.Vector3(0, 1.8, 0);

        this.createBubble(message);
        this.startUpdateLoop();
        this.scheduleFadeOut();
    }

    /**
     * Create the speech bubble HTML element. Visual styling lives in
     * .hud-npc-speech-bubble (hud-base.css) so the bubble follows the active
     * theme — surface, text, font, radius, and the tail color all come from
     * theme tokens. Only positioning stays inline (set each frame from the
     * world-projected NPC position in update()).
     */
    private createBubble(message: string): void {
        this.bubbleElement = document.createElement('div');
        this.bubbleElement.className = 'hud-npc-speech-bubble';

        const tail = document.createElement('div');
        tail.className = 'hud-npc-speech-bubble__tail';
        this.bubbleElement.appendChild(tail);

        const messageDiv = document.createElement('div');
        messageDiv.textContent = message;
        this.bubbleElement.appendChild(messageDiv);

        document.body.appendChild(this.bubbleElement);

        // Fade in next frame so the opacity transition has both sides.
        requestAnimationFrame(() => {
            if (this.bubbleElement) {
                this.bubbleElement.dataset.visible = 'true';
            }
        });
    }

    /**
     * Update bubble position to follow NPC
     */
    private update(): void {
        if (!this.npcObject || !this.bubbleElement || !this.engine.camera || !this.engine.renderer) {
            return;
        }

        // Calculate world position with offset
        const bubblePosition = new THREE.Vector3();
        this.npcObject.getWorldPosition(bubblePosition);
        bubblePosition.add(this.offset);

        // Convert to screen coordinates
        const screenPosition = bubblePosition.clone();
        screenPosition.project(this.engine.camera);

        // Convert normalized device coordinates to screen pixels
        const widthHalf = this.engine.renderer.domElement.clientWidth / 2;
        const heightHalf = this.engine.renderer.domElement.clientHeight / 2;

        const x = (screenPosition.x * widthHalf) + widthHalf;
        const y = -(screenPosition.y * heightHalf) + heightHalf;

        // Update element position
        this.bubbleElement.style.left = `${x}px`;
        this.bubbleElement.style.top = `${y}px`;

        // Hide if behind camera or too far
        const visible = screenPosition.z > 0 && screenPosition.z < 1;
        this.bubbleElement.style.display = visible ? 'block' : 'none';
    }

    /**
     * Start update loop to keep bubble positioned above NPC
     */
    private startUpdateLoop(): void {
        const update = () => {
            if (this.bubbleElement) {
                this.update();
                this.updateTimer = requestAnimationFrame(update);
            }
        };
        this.updateTimer = requestAnimationFrame(update);
    }

    /**
     * Schedule fade out and disposal
     */
    private scheduleFadeOut(): void {
        this.fadeOutTimer = window.setTimeout(() => {
            this.dispose();
        }, this.duration);
    }

    /**
     * Dispose of the speech bubble
     */
    dispose(): void {
        if (this.fadeOutTimer !== null) {
            clearTimeout(this.fadeOutTimer);
            this.fadeOutTimer = null;
        }

        if (this.updateTimer !== null) {
            cancelAnimationFrame(this.updateTimer);
            this.updateTimer = null;
        }

        if (this.bubbleElement) {
            // Fade out via data-visible toggle (CSS handles the opacity transition).
            delete this.bubbleElement.dataset.visible;

            // Remove from DOM after fade
            setTimeout(() => {
                if (this.bubbleElement && this.bubbleElement.parentNode) {
                    this.bubbleElement.parentNode.removeChild(this.bubbleElement);
                }
                this.bubbleElement = null;
            }, 300);
        }
    }
}

