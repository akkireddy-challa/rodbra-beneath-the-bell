import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { INpcVisualSystem } from 'engine/npc/visual/INpcVisualSystem.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { BaseAnimationDefinition } from 'types/game.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { getDefaultAnimationConfig } from 'engine/CharacterConfig.js';
import { WalkingAndJumpingMovement } from 'engine/WalkingAndJumpingMovement.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { buildAnimationList } from 'engine/AnimationPacks.js';

/**
 * Humanoid Visual System
 * 
 * Implements visual system for bipedal humanoid NPCs (the default NPC type).
 * Uses humanoid animations (idle, walk, run, jump, attack) and bipedal movement.
 * 
 * ## 🎬 Dynamic Animation Loading (Same as Player!)
 * 
 * NPCs load animations dynamically, just like the player character.
 * If no `baseAnimations` are provided (or an empty array), the system
 * automatically uses `buildAnimationList()` to load core locomotion animations.
 */
export class HumanoidVisualSystem implements INpcVisualSystem {
    private engine: EngineLike;
    private gltf: any | null = null;
    private baseAnimations: BaseAnimationDefinition[];
    private characterLoader: CharacterLoader;
    private animationController: CharacterAnimationController | null = null;

    constructor(
        engine: EngineLike,
        gltf: any, // Pre-loaded GLTF (typically playerGLTF)
        baseAnimations: BaseAnimationDefinition[]
    ) {
        this.engine = engine;
        this.gltf = gltf;
        this.baseAnimations = baseAnimations;
        this.characterLoader = new CharacterLoader(engine);
    }

    async loadModel(): Promise<any> {
        // Model is already loaded (passed in constructor)
        if (!this.gltf) {
            throw new Error('HumanoidVisualSystem: GLTF not provided');
        }
        return this.gltf;
    }

    getModel(): any {
        if (!this.gltf) {
            throw new Error('HumanoidVisualSystem: Model not loaded');
        }
        return this.gltf;
    }

    createAnimationController(): CharacterAnimationController {
        this.animationController = new CharacterAnimationController(getDefaultAnimationConfig());
        return this.animationController;
    }

    async initializeAnimations(
        character: THREE.Object3D,
        gltf: any,
        loader: any,
        baseAnimations: BaseAnimationDefinition[]
    ): Promise<void> {
        if (!this.animationController) {
            this.animationController = this.createAnimationController();
        }

        // NPCs load animations dynamically just like the player!
        // Use provided animations if available, otherwise fall back to core animations
        let animationsToUse = baseAnimations;
        if (!animationsToUse || animationsToUse.length === 0) {
            console.log('🎬 HumanoidVisualSystem: No baseAnimations provided, loading core animations dynamically');
            animationsToUse = buildAnimationList();
        }

        await this.animationController.initializeWithCharacter(character, gltf, loader, animationsToUse, () => {
            const gd = this.engine.getGameData?.();
            return gd ? { assets: gd.assets, scene: this.engine.scene } : null;
        });
        console.log(`✅ HumanoidVisualSystem: Animations initialized (${animationsToUse.length} animations)`);
    }

    createMovementSystem(moveSpeed: number): IPlayerMovement {
        const movement = new WalkingAndJumpingMovement(moveSpeed, {
            gravity: -35.0,
            terminalVelocity: 53.0,
            jumpHeight: 2.2,
            airControlMultiplier: 0.5,
            groundFriction: 0.9,
            airFriction: 0.98
        });
        // Disable stuck detection for NPCs - it's only meant for players
        movement.enableStuckDetection = false;
        return movement;
    }

    createBlockCharacterFactory(): IBlockCharacterFactory {
        // Use the default humanoid block character factory
        // This will be provided by NpcController via characterCreator parameter
        // For now, return a placeholder - actual factory comes from NpcManager
        throw new Error('HumanoidVisualSystem: Block character factory must be provided via NpcController');
    }

    getRootBoneName(): string | string[] {
        return ['mixamorigHips', 'Hips', 'pelvis']; // Common humanoid root bone names (Mixamo, generic, UE-style)
    }

    adjustSkeletonPosition(skeleton: THREE.Object3D): void {
        // Use CharacterLoader's standard humanoid positioning
        this.characterLoader.adjustSkeletonPosition(skeleton);
    }

    getDisplayName(): string {
        return 'Humanoid';
    }

    getBaseAnimations(): BaseAnimationDefinition[] {
        // NPCs load animations dynamically just like the player!
        // Return stored animations if available, otherwise return core animations
        if (this.baseAnimations && this.baseAnimations.length > 0) {
            return this.baseAnimations;
        }
        return buildAnimationList();
    }

    /**
     * Get the CharacterLoader instance (used by NpcController)
     */
    getCharacterLoader(): CharacterLoader {
        return this.characterLoader;
    }

    /**
     * Get the animation controller instance (used by NpcController)
     */
    getAnimationController(): CharacterAnimationController | null {
        return this.animationController;
    }
}

