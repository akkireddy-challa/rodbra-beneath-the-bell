import { resolveNpcCharacterUrl, type GameData } from 'types/game.js';

const GLB_URL = 'https://forged-assets.bitmagic.cloud/JSOYOGFK/output-variant-2.glb';

function gameDataWithAssets(assets: GameData['assets']): GameData {
    return { assets } as GameData;
}

describe('resolveNpcCharacterUrl', () => {
    const gameData = gameDataWithAssets([
        { id: 'asset_123_mutant', name: 'mutant_enemy', url: GLB_URL, type: 'character' },
    ]);

    it('resolves characterAssetId to the asset url from gameData', () => {
        expect(resolveNpcCharacterUrl({ characterAssetId: 'asset_123_mutant' }, gameData))
            .toBe(GLB_URL);
    });

    it('prefers an explicit characterUrl over characterAssetId', () => {
        const direct = 'https://example.com/direct.glb';
        expect(resolveNpcCharacterUrl(
            { characterUrl: direct, characterAssetId: 'asset_123_mutant' },
            gameData,
        )).toBe(direct);
    });

    it('returns null when the asset id is not in gameData', () => {
        expect(resolveNpcCharacterUrl({ characterAssetId: 'asset_missing' }, gameData)).toBeNull();
    });

    it('returns null when neither characterUrl nor characterAssetId is set', () => {
        expect(resolveNpcCharacterUrl({}, gameData)).toBeNull();
        expect(resolveNpcCharacterUrl(undefined, gameData)).toBeNull();
    });

    it('returns null for characterAssetId when gameData is null', () => {
        expect(resolveNpcCharacterUrl({ characterAssetId: 'asset_123_mutant' }, null)).toBeNull();
    });
});
