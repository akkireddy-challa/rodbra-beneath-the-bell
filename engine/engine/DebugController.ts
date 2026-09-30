import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { GoldenPathVisualizer } from 'engine/GoldenPathVisualizer.js';

/**
 * DebugController provides debug features that are only active in development.
 * In production, all methods become no-ops, allowing templates to safely
 * reference this class without code changes for different environments.
 */
export class DebugController {
    private engine: EngineLike;
    private debugMode: boolean;
    private debugMeshes: THREE.Mesh[];
    private onDebugKey?: (e: KeyboardEvent) => void;
    private game: any;
    private isDevelopment: boolean;
    private goldenPath: GoldenPathVisualizer;

    constructor(engine: EngineLike) {
        this.engine = engine;
        this.debugMode = false;
        this.debugMeshes = [];
        this.game = null;
        this.goldenPath = new GoldenPathVisualizer(engine);
        
        // Check if we're in development mode
        // In production builds, GAME_SERVER_URL won't be set to localhost
        const gameServerUrl = (window as any).GAME_SERVER_URL || '';
        this.isDevelopment = gameServerUrl.includes('localhost') || 
                            gameServerUrl.includes('127.0.0.1') ||
                            window.location.hostname === 'localhost' ||
                            window.location.hostname === '127.0.0.1';
        
        // Only set up debug key listeners in development
        if (this.isDevelopment) {
            this.onDebugKey = this.handleKeyDown.bind(this);
            document.addEventListener('keydown', this.onDebugKey);
        }
    }

    addDebugMesh(mesh: THREE.Mesh): void {
        if (!this.isDevelopment) return;
        
        this.debugMeshes.push(mesh);
        mesh.visible = this.debugMode;
        if (this.engine.scene) {
            this.engine.scene.add(mesh);
        }
    }

    getDebugMode(): boolean {
        return this.isDevelopment && this.debugMode;
    }

    setGame(game: any): void {
        this.game = game;
    }

    private handleKeyDown(event: KeyboardEvent): void {
        if (!this.isDevelopment) return;

        // F7 - Toggle the forger's GOLDEN PATH overlay (the intended route through a platformer level)
        if (event.key === 'F7') {
            event.preventDefault();
            this.goldenPath.toggle();
            return;
        }

        // F8 - Play custom animation
        if (event.key === 'F8') {
            event.preventDefault();
            this.playFirstCustomAnimation();
        }
    }

    /** Play the first available custom animation on the current game (F8 debug helper). */
    private playFirstCustomAnimation(): void {
        if (typeof this.game?.getAnimationController !== 'function') {
            console.warn('Custom animation not available');
            return;
        }
        const animController = this.game.getAnimationController();
        if (!animController?.getAvailableCustomAnimations) {
            console.warn('Animation controller not available');
            return;
        }
        const availableAnimations = animController.getAvailableCustomAnimations();
        if (availableAnimations.length === 0) {
            console.warn('No custom animations loaded. Add animations to the assets list');
            return;
        }
        const motionId = availableAnimations[0];
        console.log(`🥊 Playing custom animation (${motionId})!`);
        animController.playCustomAnimation(motionId, { fadeInDuration: 0.1, fadeOutDuration: 0.2 });
    }

    dispose(): void {
        if (this.onDebugKey) {
            document.removeEventListener('keydown', this.onDebugKey);
        }
        this.goldenPath.dispose();
        
        this.debugMeshes.forEach(mesh => {
            mesh.geometry?.dispose();
            const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
            if (mat) (Array.isArray(mat) ? mat : [mat]).forEach(m => m.dispose());
            this.engine.scene?.remove(mesh);
        });
        this.debugMeshes = [];
    }
}
