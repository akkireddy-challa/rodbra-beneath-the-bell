import type { EngineLike, WorldProfileData } from 'types/game.js';
import { animationAssets, isDefaultCharacterUrl } from 'engine/AnimationAssets.js';
import { PlayerLoader } from 'engine/loaders/PlayerLoader.js';

/**
 * A characterUrl naming the built-in rig — today's default or the legacy default older
 * migrations stamped into every game.json — is not a custom character. PlayerLoader must
 * fall through to its default-rig path (brotli copy, then the uncompressed fallback)
 * rather than fetch the legacy URL as a no-fallback override: that URL is a 404, and
 * taking it literally aborted the load of every game carrying it.
 */
const LEGACY_DEFAULT = 'https://mini.bitmagic.ai/worlds/v3/BaseCharacter.glb';
const CUSTOM = 'https://magic-mesh-gen.sandbox.dev.bitmagic.cloud/worlds/v3/ABC/hero.glb';

function resolvedUrl(profileUrl: string | undefined, gameUrl: string | undefined): string | undefined {
    const engine = {
        getGameData: () => ({ characterUrl: gameUrl }),
    } as unknown as EngineLike;
    const loader = new PlayerLoader(engine, { characterUrl: profileUrl } as unknown as WorldProfileData);
    return (loader as unknown as { resolveCharacterUrl(): string | undefined }).resolveCharacterUrl();
}

describe('isDefaultCharacterUrl', () => {
    it('recognises both current copies and the legacy game.json default', () => {
        expect(isDefaultCharacterUrl(animationAssets.characterUrls.default)).toBe(true);
        expect(isDefaultCharacterUrl(animationAssets.characterUrls.defaultFallback)).toBe(true);
        expect(isDefaultCharacterUrl(LEGACY_DEFAULT)).toBe(true);
        expect(isDefaultCharacterUrl(CUSTOM)).toBe(false);
    });
});

describe('PlayerLoader character URL resolution', () => {
    it('treats the legacy default in game.json as no custom character', () => {
        expect(resolvedUrl(undefined, LEGACY_DEFAULT)).toBeUndefined();
    });

    it('treats the legacy default in world.json as no custom character', () => {
        expect(resolvedUrl(LEGACY_DEFAULT, undefined)).toBeUndefined();
    });

    it('still honours a real custom character from either file, world.json first', () => {
        expect(resolvedUrl(undefined, CUSTOM)).toBe(CUSTOM);
        expect(resolvedUrl(CUSTOM, LEGACY_DEFAULT)).toBe(CUSTOM);
        expect(resolvedUrl(LEGACY_DEFAULT, CUSTOM)).toBe(CUSTOM);
    });
});
