/**
 * @jest-environment jsdom
 *
 * `?terrainBudget=` is the instrument the mobile ceiling is measured WITH — a published
 * bundle is frozen, so every point on the loads/crashes curve otherwise costs a
 * republish. A parsing bug here does not break a game, it silently wastes a device
 * test cycle and hands back a number that means nothing, so the parse is pinned.
 */
import { readTerrainBudgetOverride } from 'engine/VxlSceneTerrainSystem.js';

function withSearch(query: string, fn: () => void): void {
    const original = window.location.search;
    const set = (search: string): void => {
        Object.defineProperty(window, 'location', {
            value: { ...window.location, search },
            writable: true,
            configurable: true,
        });
    };
    set(query);
    try { fn(); } finally { set(original); }
}

const MB = 1024 * 1024;

describe('readTerrainBudgetOverride', () => {
    it('returns undefined when absent, so the platform budget stays in charge', () => {
        withSearch('', () => expect(readTerrainBudgetOverride()).toBeUndefined());
        withSearch('?warmup=light', () => expect(readTerrainBudgetOverride()).toBeUndefined());
    });

    it('reads megabytes, because that is the unit the measurements are in', () => {
        withSearch('?terrainBudget=240', () => expect(readTerrainBudgetOverride()).toBe(240 * MB));
        withSearch('?terrainBudget=316', () => expect(readTerrainBudgetOverride()).toBe(316 * MB));
        withSearch('?terrainBudget=0.5', () => expect(readTerrainBudgetOverride()).toBe(0.5 * MB));
    });

    it('reads 0 as UNCAPPED, so the no-ceiling case is reachable from a device', () => {
        // null is a distinct outcome from undefined here: undefined means "no override",
        // null means "override says no ceiling".
        withSearch('?terrainBudget=0', () => expect(readTerrainBudgetOverride()).toBeNull());
    });

    it('falls back rather than inventing a ceiling from junk', () => {
        withSearch('?terrainBudget=abc', () => expect(readTerrainBudgetOverride()).toBeUndefined());
        withSearch('?terrainBudget=', () => expect(readTerrainBudgetOverride()).toBeUndefined());
        withSearch('?terrainBudget=-40', () => expect(readTerrainBudgetOverride()).toBeUndefined());
    });

    it('coexists with the other params a device test carries', () => {
        withSearch('?platform=mobile&warmup=light&terrainBudget=400&dpr=3', () => {
            expect(readTerrainBudgetOverride()).toBe(400 * MB);
        });
    });
});
