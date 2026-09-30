/**
 * Vehicle body builders for creating custom car shapes.
 * 
 * These builders can be used by templates to create vehicles with custom body shapes
 * without modifying engine code.
 */

export { BoxCarBodyBuilder, BoxCarRenderer } from 'engine/builders/BoxCarBodyBuilder.js';
export type { BoxPartConfig, BoxCarBodyConfig } from 'engine/builders/BoxCarBodyBuilder.js';

export { VoxelCarBodyBuilder, VoxelCarRenderer } from 'engine/builders/VoxelCarBodyBuilder.js';
export type { VoxelBlockConfig, VoxelPartConfig, VoxelCarBodyConfig } from 'engine/builders/VoxelCarBodyBuilder.js';

