/**
 * The rule mapping declared game metadata (game.json `physicsMode` + genre) to
 * the physics world a game actually runs — and therefore the single Rapier
 * flavor its published bundle needs to ship.
 *
 * MIRRORED in `shared/world-forger/src/physics-mode.ts` — the canonical copy
 * the publish and CLI lanes import. This project cannot depend on shared
 * packages, so the rule lives twice; keep the two in lockstep. The parity test
 * in game-play-agent (`physics-mode-parity.test.ts`) truth-tables both
 * implementations and fails CI on drift.
 */
export type PhysicsMode = '3d' | '2d' | 'none';

export function effectivePhysicsMode(
    gameGenre: string,
    requested: PhysicsMode | undefined,
    /**
     * game.json `physics2d` — the game's own declaration that ITS TEMPLATE CODE
     * is written against the 2D physics world.
     *
     * This exists because `physicsMode` alone cannot be trusted to mean that. The
     * sidescroller template shipped `physicsMode: '2d'` on a Voxel game from
     * 2026-06-25, so a large population of EXISTING games declares 2D while
     * carrying frozen template code that calls `engine.physicsWorld` (3D) and
     * would throw on a null. Honouring `physicsMode` for them would break every
     * one of those games on next open. A brand-new field cannot appear in old
     * data, which is exactly the property needed.
     */
    physics2dCapable = false,
): PhysicsMode {
    const genreDefault: PhysicsMode = gameGenre === 'Physics2D' ? '2d' : '3d';
    const mode = requested ?? genreDefault;
    // 2D physics runs only where there is a 2D code path: the Physics2D genre,
    // or a game whose template opted in explicitly. Everything else is
    // downgraded so the game still works rather than crashing on a missing
    // physicsWorld.
    if (mode === '2d' && gameGenre !== 'Physics2D' && !physics2dCapable) return '3d';
    return mode;
}

/**
 * The Rapier flavor a published bundle must ship for an effective mode.
 * 'none' still bundles 3D: initPhysics() is public engine API, so frozen game
 * code may lazily init physics after boot — never ship zero flavors.
 */
export function rapierFlavorForPhysicsMode(mode: PhysicsMode): '2d' | '3d' {
    return mode === '2d' ? '2d' : '3d';
}
