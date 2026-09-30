/**
 * 🐕🐎🐱🐻 ANIMAL SYSTEM - Block-Composed 4-Legged Creatures 🐕🐎🐱🐻
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Animals are composed from blocks. Define body parts (body, head, legs, tail)
 * using arrays of blocks, then create a factory and spawn the animal.
 * 
 * @see BlockAnimalBodyBuilder.ts for BlockAnimalBodyConfig interface and examples
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * ## 🚀 Quick Start
 * 
 * ## 🦬 Spawning Many Animals
 * 
 * ## 🎯 Kill Tracking
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 */

// Main exports
export { AnimalController, createAnimal, type RiderInput, type CreateAnimalOptions } from 'engine/animal/AnimalController.js';
export { AnimalRegistry, type RegistrableCreature } from 'engine/animal/AnimalRegistry.js';
export { BlockAnimalAnimationController, BlockAnimalAnimationState, type BlockAnimalGaitPhases } from 'engine/animal/BlockAnimalAnimationController.js';

// Free-volume locomotion (fish swim in water, birds fly)
export { AnimalMediumSensor } from 'engine/animal/AnimalMediumSensor.js';
export {
    Animal3DMovement,
    DEFAULT_SWIM_MOVEMENT_OPTIONS,
    DEFAULT_FLIGHT_MOVEMENT_OPTIONS,
    type Animal3DMovementOptions
} from 'engine/animal/AnimalLocomotion3D.js';

// Riding system
export { PlayerRidingAnimalMovement } from 'engine/animal/PlayerRidingAnimalMovement.js';
export { AnimalRidingCamera } from 'engine/animal/AnimalRidingCamera.js';
export { PlayerAnimalController } from 'engine/animal/PlayerAnimalController.js';

// Block animal composition - AI uses these to build animals from blocks
export {
    BlockAnimalBodyBuilder,
    createBlockAnimalFactory,
    type AnimalBlockConfig,
    type AnimalBodyPlan,
    type BlockAnimalBodyConfig,
    type AnimalDimensions
} from 'engine/animal/BlockAnimalBodyBuilder.js';

// Voxel-art detail for block animals (engine-generated; AI sets style knobs only)
export {
    DEFAULT_ANIMAL_DETAIL,
    resolveAnimalDetail,
    type AnimalDetailConfig,
    type AnimalPatternConfig,
    type AnimalDetailPartKind,
    type ResolvedAnimalDetail
} from 'engine/animal/BlockAnimalVoxelDetailer.js';

// Eye system - blinking and player tracking
export {
    AnimalEyeController,
    type AnimalEyeConfig,
    type EyeStyle,
    type EyePlacement
} from 'engine/animal/AnimalEyeController.js';

// Snake system - legless serpentine creatures
export { SnakeController, createSnake, type CreateSnakeOptions, type SnakeConfigOptions } from 'engine/animal/SnakeController.js';
export {
    SnakeBodyBuilder,
    createSnakeFactory,
    type SnakeConfig,
    type SnakeDimensions
} from 'engine/animal/SnakeBodyBuilder.js';
export {
    SnakeAnimationController,
    SnakeAnimationState,
    type SnakeTerrainConformOptions,
    type WaveParams,
    type SnakeBodyParts,
} from 'engine/animal/SnakeAnimationController.js';

// Re-export behaviors that work with animals
export { AnimalRoamBehavior } from 'engine/animal/AnimalRoamBehavior.js';
export { AnimalSwimBehavior } from 'engine/animal/AnimalSwimBehavior.js';
export { AnimalFlyBehavior } from 'engine/animal/AnimalFlyBehavior.js';
export { NpcIdleBehavior as AnimalIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
export { NpcFollowBehavior as AnimalFollowBehavior } from 'engine/npc/behaviors/NpcFollowBehavior.js';
export { NpcPatrolBehavior as AnimalPatrolBehavior } from 'engine/npc/behaviors/NpcPatrolBehavior.js';
