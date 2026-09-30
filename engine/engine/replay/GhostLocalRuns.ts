/**
 * Runs held on this device.
 *
 * THE source of truth for a player's own records. The shared board adds other
 * people's times; it is never what makes your own work. A run must save and
 * appear offline, on a slow connection, and when the service is down — so this
 * module owns the store and every reader goes through it.
 *
 * It is module-level state rather than a constructor dependency because
 * `fetchBoard()` is a free function that game code calls directly. Threading
 * persistence through every call site would leave the most common path — the
 * level selector asking for a board — unable to see the player's own records.
 */

import type { GamePersistence } from 'engine/persistence/GamePersistence.js';
import type { BoardEntry } from 'engine/replay/GhostBoard.js';

/** Slot holding the run payloads. Distinct from the times, which are cheap to read. */
const LOCAL_RUNS_SLOT = 'ghost-local-runs';

/**
 * Levels that keep runs. At roughly 20 KB of base64 per run this stays a few
 * hundred KB — comfortable in localStorage, and bounded so a game with dozens
 * of tracks cannot fill the quota. Oldest level is evicted first.
 */
const MAX_LOCAL_LEVELS = 8;

export interface LocalRun {
    encodedRun: string;
    timeMs: number;
    savedAt: number;
    /** Vehicle the lap was set with, so replaying it uses the right car. */
    assetId: string | null;
}

export type LocalRuns = Record<string, LocalRun[]>;

/** Entry id for the first device-local run. */
export const LOCAL_ENTRY_ID = 'local';

/**
 * Id for the Nth device-local run. `:` never appears in a Firestore auto-id, so
 * a server entry can never be mistaken for a local one.
 */
export function localEntryId(index: number): string {
    return index === 0 ? LOCAL_ENTRY_ID : `${LOCAL_ENTRY_ID}:${index}`;
}

/** True for any run held on this device rather than fetched from the board. */
export function isLocalEntryId(entryId: string): boolean {
    return entryId === LOCAL_ENTRY_ID || entryId.startsWith(`${LOCAL_ENTRY_ID}:`);
}

let store: GamePersistence | null = null;

/**
 * Install the store. Called once by `GameEngine` when ghost racing is created.
 *
 * The instance must have notifications disabled — this is internal bookkeeping,
 * and a "Progress saved" toast after every lap is not a save the player asked
 * for.
 */
export function setLocalRunStore(persistence: GamePersistence | null): void {
    store = persistence;
}

function isLocalRun(value: unknown): value is LocalRun {
    if (!value || typeof value !== 'object') return false;
    const run = value as Partial<LocalRun>;
    return typeof run.encodedRun === 'string'
        && run.encodedRun.length > 0
        && typeof run.timeMs === 'number'
        && Number.isFinite(run.timeMs);
}

/**
 * Read the stored runs, tolerating every shape this slot has ever held.
 *
 * ⚠ This is data on a PLAYER'S DEVICE. It outlives any single build, so a
 * reader that assumes the current shape crashes on the previous one — as this
 * did when a level went from holding one run to holding a list and
 * `runs.slice` met an object. Normalising in one place keeps that knowledge
 * here, and doubles as a guard against anything corrupt: a bad entry is
 * dropped, never thrown over.
 */
export function readLocalRuns(): LocalRuns {
    if (!store) return {};
    const stored = store.load<Record<string, unknown>>(LOCAL_RUNS_SLOT).data;
    if (!stored || typeof stored !== 'object') return {};

    const out: LocalRuns = {};
    for (const [levelId, value] of Object.entries(stored)) {
        // Pre-multi-run builds stored a single run object per level.
        const candidates = Array.isArray(value) ? value : [value];
        const runs = candidates.filter(isLocalRun);
        if (runs.length > 0) out[levelId] = runs.sort((a, b) => a.timeMs - b.timeMs);
    }
    return out;
}

export function readLocalRunsFor(levelId: string): LocalRun[] {
    return readLocalRuns()[levelId] ?? [];
}

/** Store a run, keeping the fastest `keep` for that level. */
export function writeLocalRun(levelId: string, run: LocalRun, keep: number): void {
    if (!store) return;
    const runs = readLocalRuns();
    const merged = [...(runs[levelId] ?? []), run].sort((a, b) => a.timeMs - b.timeMs);
    runs[levelId] = merged.slice(0, Math.max(1, keep));

    const levels = Object.keys(runs);
    if (levels.length > MAX_LOCAL_LEVELS) {
        const newest = (id: string): number => Math.max(0, ...(runs[id] ?? []).map((r) => r.savedAt));
        levels
            .sort((a, b) => newest(a) - newest(b))
            .slice(0, levels.length - MAX_LOCAL_LEVELS)
            .forEach((stale) => delete runs[stale]);
    }

    const saved = store.save(runs, LOCAL_RUNS_SLOT);
    if (!saved.success) {
        console.warn('[GhostLocalRuns] could not store the run locally:', saved.error);
    }
}

/**
 * This device's records as board rows.
 *
 * Merged into every board read, so a player who has driven the track always
 * sees their times — whatever the shared service is doing.
 */
export function localBoardRows(levelId: string): BoardEntry[] {
    return readLocalRunsFor(levelId).map((run, index) => ({
        entryId: localEntryId(index),
        playerId: '',
        name: index === 0 ? 'Your best' : `Your run ${index + 1}`,
        timeMs: run.timeMs,
        createdAt: '',
        assetId: run.assetId ?? null,
    }));
}
