/**
 * Who a run gets published as.
 *
 * The case these exist for: a signed-in player's laps appeared on the board
 * under a generated guest name, because promoting the identity was left to a
 * sign-in caller that never existed. `resolve()` owns the promotion now, and
 * these tests keep it owning it.
 */

import { GamePersistence } from 'engine/persistence/GamePersistence.js';
import type { StorageAdapter } from 'engine/persistence/StorageAdapter.js';
import { DEFAULT_GHOST_IDENTITY_OPTIONS, GhostIdentity } from 'engine/replay/GhostIdentity.js';
import { generatedNameFor } from 'engine/replay/GhostNames.js';

function memoryAdapter(): StorageAdapter {
    const store = new Map<string, string>();
    return {
        isAvailable: () => true,
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        hasItem: (key: string) => store.has(key),
        listKeys: (prefix?: string) => [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
    };
}

interface Calls {
    urls: string[];
    bodies: Record<string, unknown>[];
}

/** Stub the three endpoints an identity can touch, recording what was asked. */
function stubFetch(options: { accountId: string | null }): Calls {
    const calls: Calls = { urls: [], bodies: [] };
    let minted = 0;
    global.fetch = (async (url: string, init?: { body?: string }) => {
        calls.urls.push(url);
        calls.bodies.push(init?.body ? JSON.parse(init.body) as Record<string, unknown> : {});
        if (url.endsWith('/v1/identity/anon')) {
            minted++;
            return { ok: true, json: async () => ({ playerId: `g_anon${minted}`, verifier: 'guest-v' }) };
        }
        if (url.endsWith('/api/play/ghost-identity')) {
            return options.accountId
                ? { ok: true, json: async () => ({ playerId: options.accountId, verifier: 'acct-v' }) }
                : { ok: false, status: 401, json: async () => ({}) };
        }
        if (url.endsWith('/api/play/ghost-link')) return { ok: true, json: async () => ({ success: true }) };
        if (url.endsWith('/api/play/player-refs')) {
            return { ok: true, json: async () => ({ refs: [{ displayName: 'Jani' }] }) };
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    return calls;
}

function makeIdentity(token: () => Promise<string | null>): GhostIdentity {
    const store = new GamePersistence(memoryAdapter(), 'GAME12345678', 1);
    store.setNotification({ enabled: false });
    return new GhostIdentity(
        { ...DEFAULT_GHOST_IDENTITY_OPTIONS, gameId: 'GAME12345678' },
        store,
        token,
    );
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('GhostIdentity.resolve', () => {
    it('publishes a signed-in player under their account id, never a guest id', async () => {
        stubFetch({ accountId: 'jani' });
        const identity = makeIdentity(async () => 'play-token');

        const credential = await identity.resolve();

        expect(credential.playerId).toBe('jani');
        expect(identity.isGuest()).toBe(false);
    });

    it('uses the account name, not the generated one', async () => {
        stubFetch({ accountId: 'jani' });
        const identity = makeIdentity(async () => 'play-token');

        expect(await identity.displayName()).toBe('Jani');
    });

    it('mints a guest identity when there is no play token, and reuses it', async () => {
        const calls = stubFetch({ accountId: null });
        const identity = makeIdentity(async () => null);

        const first = await identity.resolve();
        const second = await identity.resolve();

        expect(first.playerId).toBe('g_anon1');
        expect(second.playerId).toBe('g_anon1');
        expect(calls.urls.filter((url) => url.endsWith('/v1/identity/anon'))).toHaveLength(1);
    });

    // The transition that produced the bug: the player races, THEN signs in.
    it('promotes an already-minted guest on the next resolve, and links the old id', async () => {
        const calls = stubFetch({ accountId: 'jani' });
        let token: string | null = null;
        const identity = makeIdentity(async () => token);

        const asGuest = await identity.resolve();
        expect(asGuest.playerId).toBe('g_anon1');

        token = 'play-token';
        const asAccount = await identity.resolve();

        expect(asAccount.playerId).toBe('jani');
        const linkIndex = calls.urls.findIndex((url) => url.endsWith('/api/play/ghost-link'));
        expect(linkIndex).toBeGreaterThanOrEqual(0);
        // Linking is what makes the runs recorded before sign-in resolve to the
        // account, so the anon id has to be the one that raced.
        expect(calls.bodies[linkIndex].anonId).toBe('g_anon1');
    });

    it('keeps racing as a guest when the account lookup fails, and retries later', async () => {
        stubFetch({ accountId: null });
        const identity = makeIdentity(async () => 'play-token');

        expect((await identity.resolve()).playerId).toBe('g_anon1');

        // The account service recovers; the next resolve promotes on its own.
        stubFetch({ accountId: 'jani' });
        expect((await identity.resolve()).playerId).toBe('jani');
    });
});

/**
 * The case these exist for: a high-score row written straight through
 * GameDataService carried no owner at all, so the website derived a generated
 * guest name from the ENTRY id and showed a signed-in player as a stranger.
 * `info()` is the one call that hands game code everything the write needs.
 */
describe('GhostIdentity.info', () => {
    it('gives a signed-in player their account id, credential and profile name', async () => {
        stubFetch({ accountId: 'jani' });

        const info = await makeIdentity(async () => 'play-token').info();

        expect(info).toEqual({
            playerId: 'jani',
            verifier: 'acct-v',
            displayName: 'Jani',
            isGuest: false,
        });
    });

    it('gives a guest a generated name derived from their own id', async () => {
        stubFetch({ accountId: null });

        const info = await makeIdentity(async () => null).info();

        expect(info.playerId).toBe('g_anon1');
        expect(info.isGuest).toBe(true);
        // Derived, not fetched: a guest costs no profile lookup.
        expect(info.displayName).toBe(generatedNameFor('g_anon1'));
    });
});
