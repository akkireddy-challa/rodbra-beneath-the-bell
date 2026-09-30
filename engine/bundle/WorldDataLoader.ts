// Bundle-specific world data loader
// This file uses static imports that viteSingleFile can inline
// game.json contains metadata (gameId, gameGenre, characterUrl, gameName, etc.) - read-only for AI
// world.json contains AI-editable runtime configuration only
// Both are merged at load time - metadata goes to top-level GameData fields

import * as THREE from 'three';
// Imported through the `work/` ALIAS, never a relative path. This file sits at src/bundle/ in the
// monorepo but at engine/bundle/ in a scaffolded project, where the creator's game is at src/work/
// — so `../work/` resolves to engine/work/, a directory that does not exist, and Rollup fails with
// "Could not resolve ../work/world.json". An alias resolves correctly in both layouts; a relative
// path cannot, because no alias can rewrite a relative specifier.
//
// `declare module '*.json'` (types/global.d.ts) means tsc types either form without complaint and
// exits 0, so this only ever failed at bundle time — which is why it survived to a released CLI.
import worldData from 'work/world.json';
import gameMetadataRaw from 'work/game.json';
import ASSET_MAP from './BundledAssetData.js';
import type { GameData, GameMetadata } from '../types/game.js';
import { mergeGameData } from '../types/game.js';

// game.json is required for bundled games (created during publish)
const gameMetadata = gameMetadataRaw as GameMetadata;

// Register bundled assets so Three.js loads them from inline base64 data instead of CDN.
// In standalone builds, ASSET_MAP contains URL → data URL entries; in normal builds it's empty.
if (ASSET_MAP.size > 0) {
    THREE.DefaultLoadingManager.setURLModifier(url => ASSET_MAP.get(url) ?? url);
}

export function getBundledWorldData(): GameData {
    // world.json doesn't have gameName - it's added by mergeGameData from game.json.
    //
    // Cast THROUGH `unknown`, deliberately. A checked `as Partial<GameData>` buys nothing — an
    // assertion validates nothing at runtime — but it CAN fail to compile on perfectly valid game
    // data, in a file neither a creator nor the coding agent is allowed to edit. Any tuple in
    // GameData is the trigger: `Asset.vehicleFitment.bodyBounds` is `{ min: [number, number,
    // number] }`, and tsc infers `number[]` from a JSON array, which is not COMPARABLE to a
    // 3-tuple. So the first vehicle asset written into a game's world.json turned every later
    // type check red here with TS2352, the session outcome gate rolled back every turn that
    // touched code, and the game could not be edited again at all.
    //
    // world.json's real gate is the ajv schema GENERATED from this same GameData type
    // (shared/world-forger `validateWorldData`), which runs on every tool write and in
    // validateWorldJsonTool. That checks values, which is what actually protects the engine.
    // game.json keeps its checked cast below: GameMetadata is a flat, closed, engine-written
    // shape, not the arbitrary creator content that lands here.
    const data = worldData as unknown as Partial<GameData>;

    // Ensure worldProfileData has required fields
    if (data.worldProfileData) {
        if (!data.worldProfileData.playerSpawnPosition) {
            data.worldProfileData.playerSpawnPosition = { x: 0, y: 0, z: 0 };
        }
    }

    // Merge game.json metadata with world data (sets gameName and other metadata at top level)
    return mergeGameData(gameMetadata, data);
}