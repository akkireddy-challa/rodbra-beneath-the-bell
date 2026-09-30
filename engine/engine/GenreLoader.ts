// Type checking enabled

// Genre loader that dynamically loads genres at runtime from available files
// This handles the case where genre files may not exist at compile time

import { genreRegistry } from 'engine/GenreRegistry.js';
import type { GenreConstructor } from 'engine/GenreRegistry.js';
import { isStandaloneMode } from 'engine/CreatorMode.js';

// Registry name → the class the genre exports. Every genre loads from the same
// generated entry file (work/Game.js), so the export name is all that differs.
// Single source of truth for which genres exist.
const GENRE_CLASS_NAMES: Record<string, string> = {
    'Voxel': 'VoxelGame',
    'Physics2D': 'Physics2DGame'
};

export class GenreLoader {
    private static loadedGenres = new Set<string>();

    // Load all available genres (for backwards compatibility)
    static async loadAvailableGenres(): Promise<void> {
        for (const genreRegistryName of Object.keys(GENRE_CLASS_NAMES)) {
            await this.loadGenre(genreRegistryName);
        }

        console.log(`Genre loader complete. Registered genres: ${genreRegistry.getAvailableGenres().join(', ')}`);
    }
    
    // Force reload a genre (for hot reload scenarios)
    // Returns the loaded class directly to avoid module identity issues with the registry
    static async forceReloadGenre(genreRegistryName: string): Promise<GenreConstructor | null> {
        console.log(`[GenreLoader] Force reloading genre: ${genreRegistryName}`);
        this.loadedGenres.delete(genreRegistryName);
        return this.loadGenre(genreRegistryName);
    }
    
    // Clear all loaded genre cache (for hot reload scenarios)
    static clearCache(): void {
        console.log(`[GenreLoader] Clearing genre cache for hot reload`);
        this.loadedGenres.clear();
    }
    
    // Load a specific genre by registry name
    // Returns the loaded class directly to avoid module identity issues with the registry
    static async loadGenre(genreRegistryName: string): Promise<GenreConstructor | null> {
        const className = GENRE_CLASS_NAMES[genreRegistryName];
        if (!className) {
            console.warn(`Unknown genre: ${genreRegistryName}. Available: ${Object.keys(GENRE_CLASS_NAMES).join(', ')}`);
            return null;
        }

        let GameClass: GenreConstructor | undefined;
        let gameModule: Record<string, unknown> = {};

        try {
            if (isStandaloneMode) {
                // In standalone mode, use static imports that get bundled
                console.log(`[Standalone] Loading genre ${genreRegistryName} via static import`);

                // IMPORTANT: `work/` is a generated directory. For tooling/typecheck we intentionally
                // avoid having TypeScript resolve it (which would pull in stale `src/work/**` files).
                gameModule = await import('work/Game.js' as string) as unknown as Record<string, unknown>;
                GameClass = gameModule[className] as GenreConstructor | undefined;
                console.log(`Loaded genre: ${genreRegistryName} from work/Game.js (standalone mode)`);
            } else {
                // In iframe mode, use dynamic imports with cache busting
                console.log(`[iframe] Loading genre ${genreRegistryName} via dynamic import`);

                // Simple import with cache busting
                const cacheBuster = `?v=${Date.now()}`;
                const importPath = `work/Game.js${cacheBuster}`;
                console.log(`[iframe] Attempting import('${importPath}')...`);

                gameModule = await import(/* @vite-ignore */ importPath) as unknown as Record<string, unknown>;
                GameClass = gameModule[className] as GenreConstructor | undefined;
                console.log(`[iframe] ✅ Successfully loaded genre: ${genreRegistryName} from work/Game.js`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`Could not load genre ${genreRegistryName}: ${errorMessage}`);
            // Throw a clear error indicating this is likely a temporary loading issue
            throw new Error(`Failed to load game module for ${genreRegistryName}. This may be a temporary issue during reload - try reloading the game. Details: ${errorMessage}`);
        }

        if (!GameClass) {
            const exportedKeys = Object.keys(gameModule);
            console.error(`[GenreLoader] Module exports: [${exportedKeys.join(', ')}], expected: ${className}`);
            throw new Error(`Genre module loaded but did not export ${className}. Exports found: [${exportedKeys.join(', ')}]`);
        }

        // Mark as loaded
        this.loadedGenres.add(genreRegistryName);

        // Also register in the registry for backwards compatibility
        if (!genreRegistry.getGenre(genreRegistryName)) {
            console.log(`Registering ${genreRegistryName} genre in registry`);
            genreRegistry.registerGenre(genreRegistryName, GameClass);
        }

        return GameClass;
    }
}

console.log('Genre loader module initialized');