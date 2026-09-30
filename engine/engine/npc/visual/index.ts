/**
 * NPC Visual Systems (HUMANOIDS ONLY!)
 * 
 * Provides visual system abstractions for humanoid NPC character types.
 * Separates visual representation (model, animations, movement, block character) from behavior logic.
 * 
 * ⚠️ FOR AI AGENTS:
 * - For HUMANOIDS (2-legged): Use this module with HumanoidVisualSystem
 * - For ANIMALS (4-legged): Use the Animal system instead: `engine/animal/index.js`
 */

export type { INpcVisualSystem } from 'engine/npc/visual/INpcVisualSystem.js';
export { HumanoidVisualSystem } from 'engine/npc/visual/HumanoidVisualSystem.js';
