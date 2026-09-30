import { resolveVoxelAnimalFile, resolveVoxelAnimal } from 'engine/animal/VoxelAnimalRegistry.js';

describe('resolveVoxelAnimalFile', () => {
    it('resolves close matches to a voxel GLB (canonical _01, synonyms, variants)', () => {
        expect(resolveVoxelAnimalFile('dog')).toBe('Dog_01.glb');
        expect(resolveVoxelAnimalFile('wolf')).toBe('Wolf_01.glb');
        expect(resolveVoxelAnimalFile('penguin')).toMatch(/^Pinguin_/);
        expect(resolveVoxelAnimalFile('lion cub')).toBe('Lion_Cub_01.glb');
    });

    it('resolves sea creatures now that the fish pack is voxelized', () => {
        expect(resolveVoxelAnimalFile('clownfish')).toBe('Clownfish.glb');
        expect(resolveVoxelAnimalFile('fish')).not.toBeNull();   // matches a *fish
        expect(resolveVoxelAnimalFile('shark')).toMatch(/Shark/);
        expect(resolveVoxelAnimalFile('seahorse')).toMatch(/Seahorse/);
    });

    it('matches multi-word names on the head noun (not just the joined key)', () => {
        // Regression: "Sea Turtle"/"Great White Shark" used to join to one string
        // and miss the pack entirely → block fallback. Match on the shared word.
        expect(resolveVoxelAnimalFile('Sea Turtle')).toMatch(/Turtle/);
        expect(resolveVoxelAnimalFile('SeaTurtle')).toMatch(/Turtle/); // camelCase, no space
        expect(resolveVoxelAnimalFile('Hammerhead Shark')).toMatch(/Shark/);
        expect(resolveVoxelAnimalFile('Great White Shark')).toBe('GreateWhiteShark.glb');
        expect(resolveVoxelAnimalFile('Manta Ray')).toBe('MantaRay.glb');
    });

    it('tags aquatic species as fish (swim) and land species as not', () => {
        expect(resolveVoxelAnimal('clownfish')?.isFish).toBe(true);
        expect(resolveVoxelAnimal('Sea Turtle')?.isFish).toBe(true);
        expect(resolveVoxelAnimal('shark')?.isFish).toBe(true);
        expect(resolveVoxelAnimal('dog')?.isFish).toBe(false);
        expect(resolveVoxelAnimal('tiger')?.isFish).toBe(false);
        expect(resolveVoxelAnimal('dragon')).toBeNull();
    });

    it('returns null when nothing in the pack is a close match → block fallback', () => {
        // No counterpart in the voxel pack → fall back to the procedural
        // block-composed animal system.
        expect(resolveVoxelAnimalFile('octopus')).toBeNull();
        expect(resolveVoxelAnimalFile('jellyfish')).toBeNull();
        expect(resolveVoxelAnimalFile('dragon')).toBeNull();
        expect(resolveVoxelAnimalFile('')).toBeNull();
    });
});
