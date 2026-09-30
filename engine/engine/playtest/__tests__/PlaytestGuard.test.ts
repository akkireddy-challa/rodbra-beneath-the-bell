/**
 * @jest-environment jsdom
 */
/**
 * The play-test page runs the user's game on the same origin as their preview
 * with nobody at the controls: it must not persist anything or write to any
 * server. Reads keep working so the game still loads.
 */
import { installPlaytestGuard, isReadOnlyMethod, MemoryStorage, PLAYTEST_TAG } from 'engine/playtest/PlaytestGuard.js';

describe('isReadOnlyMethod', () => {
    it('allows only GET and HEAD', () => {
        expect(isReadOnlyMethod(undefined)).toBe(true);
        expect(isReadOnlyMethod('get')).toBe(true);
        expect(isReadOnlyMethod('HEAD')).toBe(true);
        expect(isReadOnlyMethod('POST')).toBe(false);
        expect(isReadOnlyMethod('PUT')).toBe(false);
    });
});

describe('installPlaytestGuard', () => {
    const ok = { ok: true };
    const realFetch = jest.fn(() => Promise.resolve(ok));

    beforeAll(() => {
        window.localStorage.setItem('user-save', 'precious');
        window.fetch = realFetch as unknown as typeof window.fetch;
        installPlaytestGuard();
    });

    it('swaps storage for an empty in-memory store', () => {
        expect(window.localStorage).toBeInstanceOf(MemoryStorage);
        expect(window.localStorage.getItem('user-save')).toBeNull();
        window.localStorage.setItem('k', 'v');
        expect(window.localStorage.getItem('k')).toBe('v');
        expect(window.sessionStorage).toBeInstanceOf(MemoryStorage);
    });

    it('lets reads through and refuses writes', async () => {
        await expect(window.fetch('https://cdn.example.com/asset.glb')).resolves.toBe(ok);
        expect(realFetch).toHaveBeenCalledTimes(1);
        await expect(window.fetch('https://game-server.example.com/v1/saves', { method: 'POST' }))
            .rejects.toThrow(PLAYTEST_TAG);
        expect(realFetch).toHaveBeenCalledTimes(1);
    });

    it('refuses every WebSocket', () => {
        expect(() => new WebSocket('wss://game-server.example.com/ws')).toThrow(PLAYTEST_TAG);
    });

    it('turns blocking dialogs into logs', () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        window.alert('Failed to start game');
        expect(error).toHaveBeenCalledWith(expect.stringContaining(PLAYTEST_TAG));
        expect(window.confirm('?')).toBe(false);
        error.mockRestore();
    });

    it('makes pointer lock look unsupported', () => {
        expect('pointerLockElement' in document).toBe(false);
    });
});
