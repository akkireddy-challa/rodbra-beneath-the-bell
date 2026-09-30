/**
 * @jest-environment jsdom
 *
 * Launch parameters are UNTRUSTED input off a URL, and three places act on
 * them — the level resolver at boot, the ghost subsystem when it lines up
 * opponents, and game code deciding whether to show a menu. These pin the one
 * reader they all go through.
 */

import { getLaunchParams, NO_LAUNCH_PARAMS } from 'engine/LaunchParams.js';

const search = (query: string): void => {
    window.history.replaceState({}, '', query ? `/?${query}` : '/');
};

describe('getLaunchParams', () => {
    afterEach(() => search(''));

    it('reads the track and the ghost a race link carries', () => {
        search('ghost=entry-1&track=circuit-2');
        expect(getLaunchParams()).toEqual({ ghostEntryId: 'entry-1', trackLevelId: 'circuit-2' });
    });

    it('reports nothing for an ordinary visit', () => {
        search('');
        expect(getLaunchParams()).toEqual(NO_LAUNCH_PARAMS);
    });

    it('reads either parameter without the other', () => {
        search('track=circuit-2');
        expect(getLaunchParams()).toEqual({ ghostEntryId: null, trackLevelId: 'circuit-2' });
        search('ghost=entry-1');
        expect(getLaunchParams()).toEqual({ ghostEntryId: 'entry-1', trackLevelId: null });
    });

    it('drops values that are not shaped like an id', () => {
        for (const bad of ['', '../other', 'has space', '<script>', 'x'.repeat(65)]) {
            search(`ghost=${encodeURIComponent(bad)}&track=${encodeURIComponent(bad)}`);
            expect(getLaunchParams()).toEqual(NO_LAUNCH_PARAMS);
        }
    });

    it('ignores everything else on the URL', () => {
        search('ghost=entry-1&utm_source=discord&admin=1');
        expect(getLaunchParams().ghostEntryId).toBe('entry-1');
    });

    // The Creator reloads games in place, so a value frozen at import time
    // would describe the previous load rather than this one.
    it('re-reads the URL on every call', () => {
        search('track=first');
        expect(getLaunchParams().trackLevelId).toBe('first');
        search('track=second');
        expect(getLaunchParams().trackLevelId).toBe('second');
    });
});
