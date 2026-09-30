/**
 * The decorator that lets CloudSaveSync observe GamePersistence.
 *
 * Driven through a REAL GamePersistence so the contract these tests pin is the
 * one the frozen class actually exercises: every save (including the migration
 * re-save) and every delete reaches the hooks, reads pass straight through, and
 * reads count as "touched" while listing does not.
 */

import { GamePersistence } from 'engine/persistence/GamePersistence.js';
import type { StorageAdapter } from 'engine/persistence/StorageAdapter.js';
import { CloudSyncAdapter } from 'engine/persistence/CloudSyncAdapter.js';

function memoryAdapter(): StorageAdapter & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
        store,
        isAvailable: () => true,
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        hasItem: (key: string) => store.has(key),
        listKeys: (prefix?: string) => [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
    };
}

const GAME = 'GAME12345678';

function harness() {
    const inner = memoryAdapter();
    const writes: { slot: string; value: string }[] = [];
    const deletes: string[] = [];
    const adapter = new CloudSyncAdapter(inner, GAME, {
        onWrite: (slot, value) => writes.push({ slot, value }),
        onDelete: (slot) => deletes.push(slot),
    });
    const persistence = new GamePersistence(adapter, GAME, 2);
    persistence.setNotification({ enabled: false });
    return { inner, adapter, persistence, writes, deletes };
}

describe('CloudSyncAdapter', () => {
    it('reports every save with the exact bytes that landed locally', () => {
        const { inner, persistence, writes } = harness();
        expect(persistence.save({ score: 3 }, 'default').success).toBe(true);
        expect(writes).toHaveLength(1);
        expect(writes[0].slot).toBe('default');
        expect(writes[0].value).toBe(inner.store.get(`${GAME}:default`));
        expect(JSON.parse(writes[0].value)).toMatchObject({ gameId: GAME, slot: 'default', version: 2, data: { score: 3 } });
    });

    it('reports the migration re-save, which carries the new version', () => {
        const { inner, persistence, writes } = harness();
        // An old v1 envelope written behind the decorator's back (another session).
        inner.store.set(`${GAME}:default`, JSON.stringify({ gameId: GAME, version: 1, savedAt: 1, slot: 'default', data: { score: 1 } }));
        persistence.registerMigrations({ 2: (old) => ({ ...(old as { score: number }), highScore: 9 }) });
        const loaded = persistence.load<{ score: number; highScore: number }>('default');
        expect(loaded.migrated).toBe(true);
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0].value)).toMatchObject({ version: 2, data: { score: 1, highScore: 9 } });
    });

    it('reports deletes and passes reads and listings through', () => {
        const { adapter, persistence, deletes } = harness();
        persistence.save({ a: 1 }, 'one');
        persistence.save({ b: 2 }, 'two');
        expect(persistence.listSlots().sort()).toEqual(['one', 'two']);
        expect(persistence.hasSave('one')).toBe(true);
        expect(persistence.load<{ a: number }>('one').data).toEqual({ a: 1 });
        persistence.deleteSave('one');
        expect(deletes).toEqual(['one']);
        expect(persistence.hasSave('one')).toBe(false);
        expect(adapter.isAvailable()).toBe(true);
    });

    it('marks slots touched on read or write, never on listing', () => {
        const { adapter, persistence } = harness();
        expect(persistence.listSlots()).toEqual([]);
        expect(adapter.touchedSlots().size).toBe(0);
        persistence.load('read-only');
        persistence.hasSave('checked');
        persistence.save({}, 'written');
        persistence.deleteSave('removed');
        expect([...adapter.touchedSlots()].sort()).toEqual(['checked', 'read-only', 'removed', 'written']);
        expect(adapter.hasTouched('read-only')).toBe(true);
        expect(adapter.hasTouched('never')).toBe(false);
    });

    it('ignores keys outside this game (reads and writes still delegate)', () => {
        const { adapter, inner, writes } = harness();
        adapter.setItem('OTHERGAME000:default', 'x');
        expect(inner.store.get('OTHERGAME000:default')).toBe('x');
        expect(writes).toHaveLength(0);
        expect(adapter.touchedSlots().size).toBe(0);
    });
});
