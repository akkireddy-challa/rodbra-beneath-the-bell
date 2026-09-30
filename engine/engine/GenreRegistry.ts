// Type checking enabled
import type { IGameHUD } from 'engine/IGameHUD.js';
import type { MobileActionSpec } from 'engine/MobileActionSpec.js';

export interface GenreGameInterface {
    load(gameId: string): Promise<void>;
    update(deltaTime: number): void;
    dispose(): void;
    onWindowResize(): void;
    getCurrentPlayer(): any | null;
    hud?: IGameHUD;

    /**
     * Optional: declare every mobile button this genre needs.
     * Called once after load() resolves but before game systems (shoot, build, etc.)
     * are wired. Each spec produces a desktop key binding + a mobile button in a
     * layout-managed slot.
     *
     * Return [] (or omit) if this genre only uses the default buttons.
     */
    declareMobileActions?(): MobileActionSpec[];

    /**
     * Optional: returns true if the given world-space point is inside the playable area.
     * Used by GaussianSplatExporter to filter camera positions. Templates can override
     * to exclude unreachable zones (e.g., inside walls, outside terrain boundaries).
     * Default behavior (when not implemented): simple AABB bounds check.
     */
    isPointInPlayableArea?(point: { x: number; y: number; z: number }): boolean;

    /**
     * Optional: return the NetworkManager the genre is using (if any). The engine
     * consults this when wiring up world-persistence (WorldShardSync) — if a
     * NetworkManager is present, the sync uses WS for live cross-client fan-out;
     * otherwise it falls back to HTTP-only persistence. Genres that don't use
     * multiplayer simply don't implement this.
     */
    getNetworkManager?(): import('engine/networking/NetworkManager.js').NetworkManager | null;
}

export type GenreConstructor = new (engine: any, worldProfileData: any, gameData?: any) => GenreGameInterface;

export class GenreRegistry {
    private static instance: GenreRegistry;
    private genres = new Map<string, GenreConstructor>();

    static getInstance(): GenreRegistry {
        if (!GenreRegistry.instance) {
            GenreRegistry.instance = new GenreRegistry();
        }
        return GenreRegistry.instance;
    }

    registerGenre(name: string, constructor: GenreConstructor): void {
        console.log(`Registering genre: ${name}`);
        this.genres.set(name, constructor);
    }

    getGenre(name: string): GenreConstructor | null {
        return this.genres.get(name) ?? null;
    }

    getAvailableGenres(): string[] {
        return Array.from(this.genres.keys());
    }

    createGenreGame(name: string, engine: any, worldProfileData: any, gameData?: any): GenreGameInterface | null {
        const GenreConstructor = this.getGenre(name);
        if (!GenreConstructor) {
            console.warn(`Genre not found: ${name}`);
            return null;
        }

        return new GenreConstructor(engine, worldProfileData, gameData);
    }
}

// Export the singleton instance
export const genreRegistry = GenreRegistry.getInstance();