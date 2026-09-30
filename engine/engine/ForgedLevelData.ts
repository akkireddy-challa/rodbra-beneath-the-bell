import type { GameData, ForgedLevelFeature, ForgedLevelMarkers, ForgedStreetGraph } from 'types/game.js';

/**
 * Reading the world-forger's gameplay features back off the level asset.
 *
 * Every caller used to hand-roll this scan: walk `gameData.assets`, reach into
 * `worldForgerFeatures`, and — because the asset arrived through a cast — re-declare
 * the feature shape locally. A local re-declaration compiles against the author's
 * GUESS, so a wrong guess survives the type check and fails at load instead.
 * Both halves of that have shipped: `worldForgerMarkers` read as an array gave
 * `s.find is not a function`, and a hardcoded feature name the designer happened
 * not to use that night gave "Forged SlalomGates feature was not found", thrown
 * out of a genre module's constructor.
 *
 * Hence one typed lookup that returns `null` instead of throwing. A feature's
 * `kind` and `name` are written by the designer on EVERY forge and differ between
 * forges of the same prompt, so a miss is a normal outcome to degrade through —
 * skip that mechanic, or fall back to {@link forgedPathFeature}, which every
 * designed path emits. Never make a match a precondition of loading: a throw in
 * a `load()` path is the one failure mode no check catches, and the player sees a
 * black screen rather than a game missing one feature.
 */

/**
 * What to match on. At least one of `kind`/`name` is required — an empty query
 * would just return the first feature, which is the index-based selection the
 * handoff docs tell callers not to do.
 *
 * Prefer `kind`: it is the coarser, more stable vocabulary (`path`, `spine`,
 * `skiLift`, `door`, `timeTrial`, …). Reach for `name` only to disambiguate
 * between several features of the same kind.
 */
export type ForgedFeatureQuery =
    | { kind: string; name?: string }
    | { kind?: string; name: string };

/** Names and kinds come from an LLM; casing drifts between forges, so compare folded. */
function sameToken(a: string | undefined, b: string): boolean {
    return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function matches(feature: ForgedLevelFeature, query: ForgedFeatureQuery): boolean {
    if (query.kind !== undefined && !sameToken(feature.kind, query.kind)) return false;
    if (query.name !== undefined && !sameToken(feature.name, query.name)) return false;
    return true;
}

/**
 * Every forged feature across all level assets, in the order the designer emitted
 * them. Empty for a game whose level was not forged — that is not an error.
 */
export function forgedFeatures(gameData: GameData | null | undefined): ForgedLevelFeature[] {
    return (gameData?.assets ?? []).flatMap(asset => asset.worldForgerFeatures ?? []);
}

/**
 * The first feature matching every field of `query`, or `null` when this forge
 * named things differently. Handle the `null` — see the module comment.
 */
export function findForgedFeature(
    gameData: GameData | null | undefined,
    query: ForgedFeatureQuery,
): ForgedLevelFeature | null {
    return forgedFeatures(gameData).find(f => matches(f, query)) ?? null;
}

/** Every feature matching `query` — for kinds a level can carry more than one of. */
export function findForgedFeatures(
    gameData: GameData | null | undefined,
    query: ForgedFeatureQuery,
): ForgedLevelFeature[] {
    return forgedFeatures(gameData).filter(f => matches(f, query));
}

/** One named world-space marker, flat `{ name, x, y, z }` exactly as the forge persists it. */
export type ForgedMarker = NonNullable<ForgedLevelMarkers['named']>[number];

/**
 * The named marker the designer placed (`Bow`, `FinishLine`, `SummitStation`, …)
 * on any forged level asset, or `null` when this forge did not place one. World
 * space. `worldForgerMarkers` is an OBJECT whose `named` holds the markers — read
 * it through here rather than guessing its shape (see the module comment).
 */
export function findForgedMarker(
    gameData: GameData | null | undefined,
    name: string,
): ForgedMarker | null {
    for (const asset of gameData?.assets ?? []) {
        for (const marker of asset.worldForgerMarkers?.named ?? []) {
            if (sameToken(marker.name, name)) return marker;
        }
    }
    return null;
}

/**
 * The level's intended route: the `kind: 'path'` feature the forge emits for every
 * designed path, carrying ordered world-space `points` plus `start`/`finish`/
 * `checkpoints`. This is the reliable fallback when a more specific feature is
 * missing — a race timer, a reset-to-track, a progress bar and a minimap can all
 * be built from the path alone.
 */
export function forgedPathFeature(gameData: GameData | null | undefined): ForgedLevelFeature | null {
    return findForgedFeature(gameData, { kind: 'path' });
}

/**
 * The street network of the first forged CITY level, in world space, or `null`
 * when no level asset carries one (a non-city forge, or a game that was not
 * forged at all) — not an error, just no streets to drive.
 */
export function forgedStreetGraph(gameData: GameData | null | undefined): ForgedStreetGraph | null {
    for (const asset of gameData?.assets ?? []) {
        const graph = asset.worldForgerStreetGraph;
        if (graph && graph.nodes.length > 0 && graph.segments.length > 0) return graph;
    }
    return null;
}
