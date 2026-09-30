/**
 * window.__bmDebug — the engine's stable debug surface for external observers
 * (read-only but for `setSplatViewMode`), and the `?eventlog=1` boot flag that
 * feeds it.
 *
 * The consumer is `bitmagic verify`, which drives the game headlessly and asks
 * questions a screenshot cannot answer ("did the player die three times in the
 * first ten seconds?"). It reads this namespace through `page.evaluate` and
 * feature-detects every field, because published games carry frozen vendored
 * engines that may predate any of this — so the shape here can grow, but
 * existing members must keep their meaning (bump `version` when they cannot).
 *
 * Everything returned is plain JSON: it crosses a structured-clone boundary
 * out of the page. That is why events are re-projected here (dropping the
 * open-ended `data` payload — HUD ops carry raw HTML through it) and why
 * entities are reduced to id/type/name/position instead of live THREE objects.
 *
 * Every function is safe to call at any moment, including before a game has
 * loaded: the singletons it reads exist independently of GameEngine, an idle
 * log simply yields empty arrays, and a game with no splat reports a null view
 * mode rather than failing.
 */

import * as THREE from 'three';
import { getActiveQualityController, type QualityDebugInfo, type RenderStatsDebugInfo } from 'engine/quality/QualityController.js';
import { getGameEventLog, type TimelineGameEvent, type TimelineSession } from 'engine/recording/GameEventLog.js';
import { getObjectIdService, type ObjectType, type RegisteredObject } from 'engine/ObjectIdService.js';
import { activeSplatViewController, isSplatViewMode, type SplatViewMode } from 'engine/SplatViewMode.js';

// Guard for non-browser module loading (node-environment unit tests import
// engine modules that transitively reach this file); browsers are unchanged.
const urlParams = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

/** True when the embedder asked for a passive gameplay event session
 *  (?eventlog=1 — bitmagic verify). GameTemplate starts/ends the session. */
export const isEventLogRequested: boolean = urlParams.get('eventlog') === '1';

/** An entity as __bmDebug reports it — the JSON-safe projection of a registered object. */
export interface BmDebugEntity {
    id: string;
    type: ObjectType;
    name: string;
    /** Rounded world position, or null when it could not be computed. */
    position: [number, number, number] | null;
}

/** All registered ObjectType values, for the counts projection. */
const OBJECT_TYPES: ObjectType[] = ['asset', 'inst', 'marker', 'object', 'env'];

/** Unless asked otherwise, cap entity listings — computing world positions for
 *  every object of a huge world is not what a debug probe should cost. */
export const DEFAULT_ENTITY_LIMIT = 100;

/**
 * The timeline's game events with only the fields an external observer needs:
 * frame/type/intensity/position/actor. `data` is deliberately dropped — call
 * sites put arbitrary payloads there (up to raw HTML in HUD ops), and nothing
 * verify asks needs it.
 */
export function projectEvents(session: TimelineSession): TimelineGameEvent[] {
    return session.events.map((event) => {
        const projected: TimelineGameEvent = {
            frame: event.frame,
            type: event.type,
            intensity: event.intensity,
        };
        if (event.position !== undefined) projected.position = event.position;
        if (event.actor !== undefined) projected.actor = event.actor;
        return projected;
    });
}

/**
 * Registered objects reduced to their JSON-safe identity. World position via
 * getWorldPosition (an object's local position says nothing under parenting),
 * rounded to 2 decimals to match the timeline's precision; null when
 * non-finite (an object mid-teleport or never placed).
 */
export function projectEntities(
    objects: RegisteredObject[],
    type?: ObjectType,
    limit: number = DEFAULT_ENTITY_LIMIT,
): BmDebugEntity[] {
    const filtered = type === undefined ? objects : objects.filter((entry) => entry.type === type);
    return filtered.slice(0, Math.max(0, limit)).map((entry) => ({
        id: entry.id,
        type: entry.type,
        name: entry.object.name,
        position: worldPosition(entry.object),
    }));
}

function worldPosition(object: THREE.Object3D): [number, number, number] | null {
    const position = object.getWorldPosition(new THREE.Vector3());
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
        return null;
    }
    return [
        Math.round(position.x * 100) / 100,
        Math.round(position.y * 100) / 100,
        Math.round(position.z * 100) / 100,
    ];
}

function countEvents(events: TimelineGameEvent[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of events) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
    }
    return counts;
}

/**
 * Install the namespace. Called once from GameTemplate, module-level, next to
 * the `window.gameTemplate` install — so the surface answers (with empties)
 * even while a game is still loading, or never loads at all.
 */
export function installBmDebug(): void {
    (window as unknown as { __bmDebug?: unknown }).__bmDebug = {
        /** Bump when an existing member changes meaning; adding members is free. */
        version: 1,
        eventLogActive: (): boolean => getGameEventLog().isActive(),
        getEvents: (): TimelineGameEvent[] => projectEvents(getGameEventLog().getSnapshot()),
        getEventCounts: (): Record<string, number> =>
            countEvents(projectEvents(getGameEventLog().getSnapshot())),
        getEntityCounts: (): Record<string, number> => {
            const service = getObjectIdService();
            const counts: Record<string, number> = {};
            for (const type of OBJECT_TYPES) {
                counts[type] = service.getCountByType(type);
            }
            return counts;
        },
        getEntities: (options?: { type?: ObjectType; limit?: number }): BmDebugEntity[] =>
            projectEntities(getObjectIdService().getAll(), options?.type, options?.limit),
        /**
         * The device quality tier this session settled on, where it came from, and what the
         * auto-tuner has seen. Read-only, like everything else here: `?quality=` is how a
         * rung is forced, so a mutating setter would be a second way to do one thing.
         * Returns null before an engine exists.
         */
        getQuality: (): QualityDebugInfo | null => getActiveQualityController()?.debugInfo() ?? null,
        /** The renderer's draw calls, triangles and live geometries/textures for the last frame. Null before an engine exists. */
        getRenderStats: (): RenderStatsDebugInfo | null => getActiveQualityController()?.renderStats() ?? null,
        /**
         * The only MUTATING member of this namespace, and a deliberate exception to its
         * read-only rule. A splat scene holds two representations of one place — the
         * photographic splat and the collider geometry under it — and the single question worth
         * asking is whether they line up, which needs flipping between them on a live frame.
         * `?splats=` sets the initial mode but costs a reload to change, and this used to be a
         * `V` key that shipped to players. Returns whether the mode was applied so a caller can
         * tell a rejected value from a game with no splat.
         */
        setSplatViewMode: (mode: SplatViewMode): boolean => {
            const controller = activeSplatViewController();
            if (!isSplatViewMode(mode) || !controller) return false;
            controller.setMode(mode);
            return true;
        },
        /** The mode in force, or null when this game has no splat. */
        getSplatViewMode: (): SplatViewMode | null => activeSplatViewController()?.getMode() ?? null,
    };
}
