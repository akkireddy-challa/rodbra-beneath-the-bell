import { resolveBloomDefaults } from 'engine/BloomDefaults.js';
import { mergeGameData } from 'types/game.js';

describe('resolveBloomDefaults', () => {
    it('gives a voxel game its faint bloom', () => {
        expect(resolveBloomDefaults('voxel', undefined)).toEqual({ enabled: true, strength: 0.15, radius: 0.2, threshold: 0.98 });
        expect(resolveBloomDefaults('voxel', 'voxel')).toEqual(expect.objectContaining({ enabled: true }));
    });

    it('gives a low-poly voxel-genre game and every other genre none', () => {
        expect(resolveBloomDefaults('voxel', 'low-poly')).toEqual({ enabled: false });
        expect(resolveBloomDefaults('physics2d', undefined)).toEqual({ enabled: false });
    });
});

describe('mergeGameData artStyle', () => {
    const metadata = {
        gameId: 'g', gameGenre: 'Voxel', gameName: 'n', gameDescription: '', characterUrl: '', thumbnailUrl: '',
    };

    it('copies artStyle from game.json like physicsMode', () => {
        expect(mergeGameData({ ...metadata, artStyle: 'low-poly' }, {}).artStyle).toBe('low-poly');
    });

    it('leaves it absent when game.json says nothing', () => {
        expect(mergeGameData(metadata, {}).artStyle).toBeUndefined();
    });
});
