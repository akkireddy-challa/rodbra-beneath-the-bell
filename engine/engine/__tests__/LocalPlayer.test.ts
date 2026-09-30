/**
 * The local player (localhost identity) and its localStorage "account":
 * the transport must answer exactly like api-server's /api/play/saves so the
 * sync layer behaves the same on localhost, and a reset must leave nothing of
 * the player behind while sparing unrelated keys.
 */

import { jest } from '@jest/globals';
import { GamePersistence } from 'engine/persistence/GamePersistence.js';
import { LocalStorageAdapter, SAVE_KEY_PREFIX } from 'engine/persistence/StorageAdapter.js';
import {
    LocalAccountTransport, LOCAL_ACCOUNT_KEY_PREFIX, LOCAL_ACCOUNT_MAX_PAYLOAD_BYTES, type StorageLike,
} from 'engine/persistence/LocalAccountTransport.js';
import {
    getLocalPlayer, resetLocalPlayer, wipePlayerData, LOCAL_PLAYER_KEY,
} from 'engine/persistence/LocalPlayer.js';
import {
    CloudSaveSync, DEFAULT_CLOUD_SAVE_SYNC_OPTIONS, createLocalStorageJournalStore, createLocalStorageBackupStore,
    JOURNAL_KEY_PREFIX, BACKUP_KEY_PREFIX,
} from 'engine/persistence/CloudSaveSync.js';

const GAME = 'GAME12345678';

/** A Storage look-alike over a Map (jest runs in node: no localStorage). */
function fakeStorage(): StorageLike & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        get length() { return map.size; },
        key: (i: number) => [...map.keys()][i] ?? null,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
    };
}

const envelope = (slot: string, savedAt: number, data: unknown = {}) => JSON.stringify({ gameId: GAME, version: 1, savedAt, slot, data });

describe('LocalAccountTransport', () => {
    const now = () => 5_000;

    it('stores verbatim envelopes and lists them like the server index', async () => {
        const storage = fakeStorage();
        const t = new LocalAccountTransport(GAME, 'local:abc', storage, now);
        const payload = envelope('default', 100, { name: 'Zoë 🎮' });
        expect(await t.put('tok', 'default', { savedAt: 100, version: 2, payload }, { keepalive: false })).toMatchObject({ status: 200, stale: false, serverSavedAt: 100, serverNow: 5_000 });
        expect(await t.get('tok', 'default')).toEqual({ slot: 'default', savedAt: 100, version: 2, deleted: false, payload });
        expect(await t.get('tok', 'nope')).toBe('missing');
        expect(await t.list('tok')).toEqual({ serverNow: 5_000, accountKey: 'local:abc', saves: [{ slot: 'default', savedAt: 100, version: 2, deleted: false, size: expect.any(Number) }] });
        expect([...storage.map.keys()]).toEqual([`${LOCAL_ACCOUNT_KEY_PREFIX}${GAME}:default`]);
    });

    it('applies last-write-wins with stale answers and tombstones, exactly like api-server', async () => {
        const t = new LocalAccountTransport(GAME, 'local:abc', fakeStorage(), now);
        await t.put('tok', 'a', { savedAt: 200, version: 1, payload: envelope('a', 200) }, { keepalive: false });
        expect(await t.put('tok', 'a', { savedAt: 100, version: 1, payload: envelope('a', 100) }, { keepalive: false })).toMatchObject({ status: 200, stale: true, serverSavedAt: 200 });
        expect(await t.put('tok', 'a', { savedAt: 200, version: 1, payload: envelope('a', 200, { eq: true }) }, { keepalive: false })).toMatchObject({ stale: false });

        expect(await t.del('tok', 'a', 300, { keepalive: false })).toMatchObject({ stale: false, serverSavedAt: 300 });
        expect(await t.get('tok', 'a')).toMatchObject({ deleted: true, payload: null, savedAt: 300 });
        expect(await t.put('tok', 'a', { savedAt: 250, version: 1, payload: envelope('a', 250) }, { keepalive: false })).toMatchObject({ stale: true, serverSavedAt: 300 });
        expect(await t.put('tok', 'a', { savedAt: 400, version: 1, payload: envelope('a', 400) }, { keepalive: false })).toMatchObject({ stale: false });
        expect(await t.get('tok', 'a')).toMatchObject({ deleted: false, savedAt: 400 });
        expect(await t.del('tok', 'a', 350, { keepalive: false })).toMatchObject({ stale: true, serverSavedAt: 400 });
        // A delete of a slot that never existed still leaves a tombstone.
        await t.del('tok', 'ghostless', 10, { keepalive: false });
        expect((await t.list('tok'))?.saves.map((s) => s.slot)).toEqual(['a', 'ghostless']);
    });

    it('refuses oversize payloads with 413 like the server', async () => {
        const t = new LocalAccountTransport(GAME, 'local:abc', fakeStorage(), now);
        const big = envelope('big', 1, { blob: 'x'.repeat(LOCAL_ACCOUNT_MAX_PAYLOAD_BYTES) });
        expect(await t.put('tok', 'big', { savedAt: 1, version: 1, payload: big }, { keepalive: false })).toMatchObject({ status: 413 });
        expect(await t.get('tok', 'big')).toBe('missing');
    });
});

describe('local player', () => {
    it('is created once and kept until reset', () => {
        const storage = fakeStorage();
        const first = getLocalPlayer(storage);
        expect(first.id).toMatch(/^[a-z0-9]{12}$/);
        expect(getLocalPlayer(storage)).toEqual(first);
        const reset = resetLocalPlayer(storage);
        expect(reset.id).not.toBe(first.id);
        expect(getLocalPlayer(storage)).toEqual(reset);
        expect(storage.map.has(LOCAL_PLAYER_KEY)).toBe(true);
    });

    it('recovers from a corrupt record', () => {
        const storage = fakeStorage();
        storage.setItem(LOCAL_PLAYER_KEY, '{broken');
        expect(getLocalPlayer(storage).id).toMatch(/^[a-z0-9]{12}$/);
    });

    it('wipePlayerData removes saves, journal, backups and the local account — and nothing else', () => {
        const storage = fakeStorage();
        storage.setItem(`${SAVE_KEY_PREFIX}${GAME}:default`, 'save');
        storage.setItem(`${SAVE_KEY_PREFIX}${GAME}:ghost-identity`, 'ghost');
        storage.setItem(`${JOURNAL_KEY_PREFIX}${GAME}`, 'journal');
        storage.setItem(`${BACKUP_KEY_PREFIX}${GAME}:default`, 'backup');
        storage.setItem(`${LOCAL_ACCOUNT_KEY_PREFIX}${GAME}:default`, 'row');
        storage.setItem(`${SAVE_KEY_PREFIX}OTHERGAME000:default`, 'other game');
        storage.setItem(`${JOURNAL_KEY_PREFIX}OTHERGAME000`, 'other journal');
        storage.setItem('bitmagic-locale', 'en');
        storage.setItem(LOCAL_PLAYER_KEY, '{"id":"abcdefghijkl","createdAt":1}');

        expect(wipePlayerData(GAME, storage)).toBe(5);
        expect([...storage.map.keys()].sort()).toEqual([
            `${JOURNAL_KEY_PREFIX}OTHERGAME000`,
            `${SAVE_KEY_PREFIX}OTHERGAME000:default`,
            LOCAL_PLAYER_KEY,
            'bitmagic-locale',
        ].sort());
    });
});

describe('the local player end to end (CloudSaveSync over LocalAccountTransport)', () => {
    let storage: ReturnType<typeof fakeStorage>;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(console, 'info').mockImplementation(() => undefined);
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        storage = fakeStorage();
        // The real adapter/journal/backup stores read the global localStorage.
        Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    });
    afterEach(() => {
        Reflect.deleteProperty(globalThis, 'localStorage');
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    function boot(): { sync: CloudSaveSync; persistence: GamePersistence } {
        const player = getLocalPlayer(storage);
        const sync = new CloudSaveSync({
            inner: new LocalStorageAdapter(),
            gameId: GAME,
            client: new LocalAccountTransport(GAME, `local:${player.id}`, storage, () => Date.now()),
            getPlayerToken: async () => 'local',
            hasBridge: false,
            identity: { kind: 'local', id: player.id },
            journal: createLocalStorageJournalStore(GAME),
            backup: createLocalStorageBackupStore(GAME),
            now: () => Date.now(),
            options: DEFAULT_CLOUD_SAVE_SYNC_OPTIONS,
        });
        const persistence = new GamePersistence(sync.adapter, GAME, 1);
        persistence.setNotification({ enabled: false });
        sync.start();
        return { sync, persistence };
    }

    async function settle(sync: CloudSaveSync): Promise<void> {
        const p = sync.whenSettled(100);
        await jest.advanceTimersByTimeAsync(101);
        await p;
    }

    it('saves persist into the local account, survive a cleared save slot, and vanish on reset', async () => {
        const first = boot();
        await settle(first.sync);
        expect(first.sync.getStatus().player).toEqual({ kind: 'local', id: getLocalPlayer(storage).id });
        first.persistence.save({ level: 7 }, 'default');
        await jest.advanceTimersByTimeAsync(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.debounceMs + 10);
        expect(storage.map.has(`${LOCAL_ACCOUNT_KEY_PREFIX}${GAME}:default`)).toBe(true);
        first.sync.dispose();

        // "New browser": the save slot is gone but the local account still has it.
        storage.removeItem(`${SAVE_KEY_PREFIX}${GAME}:default`);
        const second = boot();
        await settle(second.sync);
        expect(second.persistence.load<{ level: number }>('default').data).toEqual({ level: 7 });
        second.sync.dispose();

        // Reset the local player: nothing comes back, and it is a new player.
        const before = getLocalPlayer(storage).id;
        wipePlayerData(GAME, storage);
        resetLocalPlayer(storage);
        const third = boot();
        await settle(third.sync);
        expect(third.persistence.load('default').data).toBeNull();
        expect(third.sync.getStatus().player.id).not.toBe(before);
        third.sync.dispose();
    });
});
