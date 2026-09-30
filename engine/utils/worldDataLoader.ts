// Utility for loading game.json and world.json data
// Tries bundle loader first (for published games), falls back to fetch (for dev mode)

import type { GameData, GameMetadata } from 'types/game.js';
import { mergeGameData, extractMetadataFromWorldData } from 'types/game.js';

/**
 * Load game.json and world.json data, merging them into a single GameData object.
 * In bundle mode: uses static import via WorldDataLoader
 * In dev mode: falls back to fetch
 *
 * Backwards compatibility: if game.json doesn't exist, extracts metadata from world.json
 */
export async function loadWorldData(): Promise<GameData> {
    // Only published single-file builds inline world.json/game.json (via viteSingleFile,
    // which sets __BUNDLED__ = true). In live-edit mode — localhost AND the deployed
    // creator (beta.creator.bitmagic.cloud / creator.bitmagic.ai) — the assets are
    // served as separate files and __BUNDLED__ is undefined; importing them as ES
    // modules then triggers a "MIME type application/json" error, so we fetch instead.
    // The typeof guard is required because /dist is served raw (no define substitution)
    // outside the publish bundle, so the identifier is genuinely undeclared there.
    const isBundled = typeof __BUNDLED__ !== 'undefined' && __BUNDLED__;

    // Try bundle loader first (for published/bundled games)
    if (isBundled) {
        try {
            const { getBundledWorldData } = await import('bundle/WorldDataLoader.js');
            const worldData = getBundledWorldData();
            console.log('✅ Loaded world data from bundle');
            return worldData;
        } catch (importError) {
            // Bundle loader not available - fall through to fetch
            console.log('📄 Bundle loader not available, trying fetch...');
        }
    }

    // Fetch mode (dev, or bundle not available)
    const cacheBuster = `?v=${Date.now()}`;

    // Load game.json (metadata) - may not exist for legacy games
    let metadata: GameMetadata | null = null;
    try {
        let gameJsonPath = 'src/work/game.json';
        let gameResponse = await fetch(`${gameJsonPath}${cacheBuster}`, {
            method: 'GET',
            cache: 'no-store'
        });

        if (!gameResponse.ok) {
            gameJsonPath = 'dist/work/game.json';
            gameResponse = await fetch(`${gameJsonPath}${cacheBuster}`, {
                method: 'GET',
                cache: 'no-store'
            });
        }

        if (gameResponse.ok) {
            const contentType = gameResponse.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                metadata = await gameResponse.json() as GameMetadata;
                console.log('✅ Loaded game.json metadata');
            }
        }
    } catch {
        // game.json not found - will use legacy fallback
        console.log('📄 game.json not found, using legacy mode');
    }

    // Load world.json (required)
    let worldFilePath = 'src/work/world.json';
    let response = await fetch(`${worldFilePath}${cacheBuster}`, {
        method: 'GET',
        cache: 'no-store'
    });

    if (!response.ok) {
        worldFilePath = 'dist/work/world.json';
        response = await fetch(`${worldFilePath}${cacheBuster}`, {
            method: 'GET',
            cache: 'no-store'
        });
    }

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('world.json not found (neither bundle nor fetch available)');
        }
        throw new Error(`Failed to load world.json: ${response.statusText}`);
    }

    // Check content type to ensure it's JSON, not HTML error page
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        throw new Error(`Invalid content type: expected JSON, got ${contentType}`);
    }

    const worldData = await response.json() as GameData;
    console.log('✅ Loaded world.json');

    // If no game.json, extract metadata from world.json (backwards compatibility)
    if (!metadata) {
        metadata = extractMetadataFromWorldData(worldData);
    }

    // Merge metadata with world data
    const mergedData = mergeGameData(metadata, worldData);
    console.log('✅ Merged game data ready');
    return mergedData;
}
