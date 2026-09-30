/**
 * `HQ_ASSET_GENERATING` from the creator: which assets are having a high-quality version
 * generated right now. Fans the set out to the shared state module (read by the Object
 * Inspector) and to the world highlight.
 *
 * Asset ids come in; the highlight works in environment TYPE names, so the two are bridged
 * through `environmentObjects` — the same mapping the inspector uses to find an instance's
 * asset. Types are re-resolved on every push (~4 s) rather than only on change, because a
 * click can UNPACK a type into individual meshes mid-generation and the freshly created
 * meshes need the highlight too.
 */

import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { HqGenerationGlow } from 'engine/HqGenerationGlow.js';
import { setGeneratingHqAssetIds } from 'engine/HqGenerationState.js';
import type { GameData } from 'types/game.js';

let glow: HqGenerationGlow | null = null;

/** Did the previous push resolve no types? Lets idle polls bail before touching the scene. */
let lastPushWasEmpty = true;

export function applyHqGeneratingAssets(assetIds: string[], gameData: GameData | null): void {
    setGeneratingHqAssetIds(assetIds);

    const envSystem = getActiveEnvironmentObjectSystem();
    if (!envSystem) return;

    const typeNames = new Set<string>();
    if (assetIds.length > 0) {
        const wanted = new Set(assetIds);
        for (const obj of gameData?.environmentObjects ?? []) {
            const assetId = (obj as { assetId?: string }).assetId;
            const type = (obj as { type?: string }).type;
            if (assetId && type && wanted.has(assetId)) typeNames.add(type);
        }
    }

    // Nothing to do when the set is empty and was already empty — avoids walking the
    // scene on every idle poll. A non-empty set is always re-applied (see the header).
    if (typeNames.size === 0 && lastPushWasEmpty) return;
    lastPushWasEmpty = typeNames.size === 0;

    if (!glow) {
        glow = new HqGenerationGlow({
            collectMeshesForTypes: (names) => envSystem.collectExportMeshesForTypes(names),
        });
    }
    glow.setGeneratingTypes(typeNames);
}

/** Drop the highlight and restore materials (game teardown). */
export function disposeHqGeneratingHighlight(): void {
    glow?.dispose();
    glow = null;
    lastPushWasEmpty = true;
}
