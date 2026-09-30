/**
 * Which assets are currently having a high-quality version generated.
 *
 * The creator owns the jobs (it polls the agent's job list) and pushes the set into the
 * game iframe as `HQ_ASSET_GENERATING`. Several places in the iframe need it — the world
 * highlight, the Object Inspector's button state, and the scene hierarchy — so it lives in
 * one module-level store with a change signal rather than being threaded through the
 * editor's constructor chain.
 *
 * Module scope is correct here: there is exactly one game and one creator per page, and
 * the state is display-only (losing it on a reload just means the UI re-learns it from the
 * next poll, ~4 s later).
 */

const generatingAssetIds = new Set<string>();
const listeners = new Set<() => void>();

/** Is a high-quality version of this asset being generated right now? */
export function isGeneratingHqAsset(assetId: string | undefined): boolean {
    return assetId !== undefined && generatingAssetIds.has(assetId);
}

export function getGeneratingHqAssetIds(): ReadonlySet<string> {
    return generatingAssetIds;
}

/**
 * Replace the set. Returns true when it actually changed, so callers can skip the
 * (mesh-walking, material-cloning) work on the steady-state polls that report no change.
 */
export function setGeneratingHqAssetIds(assetIds: Iterable<string>): boolean {
    const next = new Set(assetIds);
    if (next.size === generatingAssetIds.size && [...next].every((id) => generatingAssetIds.has(id))) {
        return false;
    }
    generatingAssetIds.clear();
    for (const id of next) generatingAssetIds.add(id);
    for (const fn of listeners) fn();
    return true;
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onGeneratingHqAssetsChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
