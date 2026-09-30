import { getNpcSkeletonSource } from 'engine/npc/core/NpcSkeletonSource.js';
import { getDefaultCharacterUrl, getDefaultCharacterFallbackUrl } from 'engine/CharacterConfig.js';

interface LoadCall {
    url: string;
    onLoad: (gltf: unknown) => void;
    onError: ((err: unknown) => void) | undefined;
}

interface FakeEngine {
    loader?: {
        load: (
            url: string,
            onLoad: (gltf: unknown) => void,
            onProgress?: unknown,
            onError?: (err: unknown) => void,
        ) => void;
    };
    playerLoader?: { getLoadedGLTF?: () => unknown };
}

function makeEngine(): { engine: FakeEngine; loads: LoadCall[] } {
    const loads: LoadCall[] = [];
    const engine: FakeEngine = {
        loader: {
            load: (url, onLoad, _onProgress, onError) => {
                loads.push({ url, onLoad, onError });
            },
        },
    };
    return { engine, loads };
}

describe('NpcSkeletonSource', () => {
    it('loads the shared default rig on demand with NO playerLoader on the engine', () => {
        const { engine, loads } = makeEngine();
        const source = getNpcSkeletonSource(engine as never);

        expect(source.getSkeletonGLTF()).toBeNull();

        source.ensureLoaded();
        expect(loads).toHaveLength(1);
        expect(loads[0].url).toBe(getDefaultCharacterUrl());

        const gltf = { scene: 'shared-rig' };
        loads[0].onLoad(gltf);
        expect(source.getSkeletonGLTF()).toBe(gltf);

        // Idempotent: no second download once loaded.
        source.ensureLoaded();
        expect(loads).toHaveLength(1);
    });

    it('prefers the player\'s own loaded GLTF and never downloads a shared rig for it', () => {
        const { engine, loads } = makeEngine();
        const playerGltf = { scene: 'player-rig' };
        engine.playerLoader = { getLoadedGLTF: () => playerGltf };

        const source = getNpcSkeletonSource(engine as never);
        expect(source.getSkeletonGLTF()).toBe(playerGltf);

        source.ensureLoaded();
        expect(loads).toHaveLength(0);
    });

    it('reads the player GLTF dynamically — a loader installed later takes precedence over the shared rig', () => {
        const { engine, loads } = makeEngine();
        const source = getNpcSkeletonSource(engine as never);

        source.ensureLoaded();
        const shared = { scene: 'shared-rig' };
        loads[0].onLoad(shared);
        expect(source.getSkeletonGLTF()).toBe(shared);

        const playerGltf = { scene: 'player-rig' };
        engine.playerLoader = { getLoadedGLTF: () => playerGltf };
        expect(source.getSkeletonGLTF()).toBe(playerGltf);
    });

    it('falls back to the uncompressed rig URL when the brotli load fails', () => {
        const { engine, loads } = makeEngine();
        const source = getNpcSkeletonSource(engine as never);

        source.ensureLoaded();
        loads[0].onError?.(new Error('brotli 404'));

        expect(loads).toHaveLength(2);
        expect(loads[1].url).toBe(getDefaultCharacterFallbackUrl());

        const gltf = { scene: 'fallback-rig' };
        loads[1].onLoad(gltf);
        expect(source.getSkeletonGLTF()).toBe(gltf);
    });

    it('allows a retry after both brotli and fallback loads fail', () => {
        const { engine, loads } = makeEngine();
        const source = getNpcSkeletonSource(engine as never);

        source.ensureLoaded();
        loads[0].onError?.(new Error('brotli down'));
        loads[1].onError?.(new Error('fallback down'));

        source.ensureLoaded();
        expect(loads).toHaveLength(3);
    });

    it('is a no-op without engine.loader (spawn retry loop calls again later)', () => {
        const engine: FakeEngine = {};
        const source = getNpcSkeletonSource(engine as never);
        expect(() => source.ensureLoaded()).not.toThrow();
        expect(source.getSkeletonGLTF()).toBeNull();
    });

    it('returns one shared instance per engine', () => {
        const a = makeEngine().engine;
        const b = makeEngine().engine;
        expect(getNpcSkeletonSource(a as never)).toBe(getNpcSkeletonSource(a as never));
        expect(getNpcSkeletonSource(a as never)).not.toBe(getNpcSkeletonSource(b as never));
    });
});
