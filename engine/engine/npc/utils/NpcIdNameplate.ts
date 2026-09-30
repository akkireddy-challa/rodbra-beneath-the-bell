import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';

/**
 * 🏷️ NPC ID Nameplate System
 * 
 * Displays unique NPC IDs above NPCs in scene/debug mode only.
 * Nameplates automatically show/hide based on debug mode state.
 * 
 * ## Usage
 */
export class NpcIdNameplate {
    private npcObject: THREE.Object3D;
    private engine: EngineLike;
    private nameplateElement: HTMLDivElement | null = null;
    private npcId: string;
    private offset: THREE.Vector3;
    private updateTimer: number | null = null;
    private isVisible: boolean = false;

    /**
     * Create an ID nameplate for an NPC
     * 
     * @param npcObject - The NPC's THREE.Object3D (use controller.getCharacter())
     * @param engine - Game engine reference (for debug mode detection)
     * @param npcId - Unique ID to display (e.g., "VillagerNpc1", "PirateEnemy23")
     * @param offset - Offset above NPC head (default: (0, 2.0, 0))
     */
    constructor(
        npcObject: THREE.Object3D,
        engine: EngineLike,
        npcId: string,
        offset?: THREE.Vector3
    ) {
        this.npcObject = npcObject;
        this.engine = engine;
        this.npcId = npcId;
        this.offset = offset || new THREE.Vector3(0, 2.0, 0);

        this.createNameplate();
        this.startUpdateLoop();
    }

    /**
     * Create the nameplate HTML element
     */
    private createNameplate(): void {
        this.nameplateElement = document.createElement('div');
        this.nameplateElement.className = 'npc-id-nameplate';
        this.nameplateElement.style.cssText = `
            position: fixed;
            background: rgba(0, 0, 0, 0.8);
            color: #00ff00;
            padding: 4px 8px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 11px;
            font-weight: bold;
            pointer-events: none;
            text-align: center;
            border: 1px solid rgba(0, 255, 0, 0.5);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
            transform: translate(-50%, -100%);
            white-space: nowrap;
            z-index: 999;
            display: none;
            opacity: 0;
            transition: opacity 0.2s ease-in-out;
        `;

        // Set ID text
        this.nameplateElement.textContent = this.npcId;

        // Add to document
        document.body.appendChild(this.nameplateElement);
    }

    /**
     * Check if debug mode is enabled
     */
    private isDebugMode(): boolean {
        return !!(this.engine.editorManager && this.engine.editorManager.isEditorMode);
    }

    /**
     * Update nameplate position and visibility
     */
    update(): void {
        if (!this.npcObject || !this.nameplateElement || !this.engine.camera || !this.engine.renderer) {
            return;
        }

        const debugMode = this.isDebugMode();

        // Show/hide based on debug mode
        if (debugMode !== this.isVisible) {
            this.isVisible = debugMode;
            if (debugMode) {
                this.nameplateElement.style.display = 'block';
                requestAnimationFrame(() => {
                    if (this.nameplateElement) {
                        this.nameplateElement.style.opacity = '1';
                    }
                });
            } else {
                this.nameplateElement.style.opacity = '0';
                setTimeout(() => {
                    if (this.nameplateElement && !this.isVisible) {
                        this.nameplateElement.style.display = 'none';
                    }
                }, 200);
            }
        }

        // Only update position if visible
        if (!this.isVisible) {
            return;
        }

        // Calculate world position with offset
        const nameplatePosition = new THREE.Vector3();
        this.npcObject.getWorldPosition(nameplatePosition);
        nameplatePosition.add(this.offset);

        // Convert to screen coordinates
        const screenPosition = nameplatePosition.clone();
        screenPosition.project(this.engine.camera);

        // Convert normalized device coordinates to screen pixels
        const widthHalf = this.engine.renderer.domElement.clientWidth / 2;
        const heightHalf = this.engine.renderer.domElement.clientHeight / 2;

        const x = (screenPosition.x * widthHalf) + widthHalf;
        const y = -(screenPosition.y * heightHalf) + heightHalf;

        // Update element position
        this.nameplateElement.style.left = `${x}px`;
        this.nameplateElement.style.top = `${y}px`;

        // Hide if behind camera or too far (isVisible is already guaranteed true here)
        const visible = screenPosition.z > 0 && screenPosition.z < 1;
        this.nameplateElement.style.display = visible ? 'block' : 'none';
    }

    /**
     * Start update loop to keep nameplate positioned above NPC
     */
    private startUpdateLoop(): void {
        const update = () => {
            if (this.nameplateElement) {
                this.update();
                this.updateTimer = requestAnimationFrame(update);
            }
        };
        this.updateTimer = requestAnimationFrame(update);
    }

    /**
     * Dispose of the nameplate
     */
    dispose(): void {
        if (this.updateTimer !== null) {
            cancelAnimationFrame(this.updateTimer);
            this.updateTimer = null;
        }

        if (this.nameplateElement) {
            if (this.nameplateElement.parentNode) {
                this.nameplateElement.parentNode.removeChild(this.nameplateElement);
            }
            this.nameplateElement = null;
        }
    }
}

