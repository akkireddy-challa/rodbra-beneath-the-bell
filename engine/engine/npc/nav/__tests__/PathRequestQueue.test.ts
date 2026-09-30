import * as THREE from 'three';
import { PathRequestQueue, getGlobalPathQueue, disposeGlobalPathQueue, DEFAULT_PATH_QUEUE_BUDGET } from 'engine/npc/nav/PathRequestQueue.js';

type Finder = (start: THREE.Vector3, goal: THREE.Vector3, extras?: unknown, maxLen?: number) => THREE.Vector3[];

function req(key: string, hero: boolean, distSq: number, results: string[]): Parameters<PathRequestQueue['submit']>[0] {
    return {
        key, hero, distSq,
        start: new THREE.Vector3(), goal: new THREE.Vector3(1, 0, 1),
        extraObstacles: undefined, maxPathLength: undefined,
        onResult: () => results.push(key),
    };
}

describe('PathRequestQueue', () => {
    afterEach(() => disposeGlobalPathQueue());
    const finder: Finder = (_s, g) => [g.clone()];

    test('serves several cheap requests per update, up to the count cap', () => {
        const q = new PathRequestQueue();
        const done: string[] = [];
        for (let i = 0; i < DEFAULT_PATH_QUEUE_BUDGET.maxRequestsPerUpdate + 2; i++) {
            q.submit(req(`npc${i}`, false, 100 + i, done));
        }
        q.update(finder);
        expect(done.length).toBe(DEFAULT_PATH_QUEUE_BUDGET.maxRequestsPerUpdate);
    });

    test('a search that overruns the budget is paid for by later updates', () => {
        // An A* call cannot be interrupted once started, so the bound has to be
        // "do not START another search while overdrawn" — the property under test.
        const q = new PathRequestQueue({ msPerUpdate: 2, maxRequestsPerUpdate: 4, maxCarryOverMs: 60 });
        const done: string[] = [];
        const slowFinder: Finder = (_s, g) => {
            const until = performance.now() + 6;
            while (performance.now() < until) { /* emulate one expensive layered A* */ }
            return [g.clone()];
        };
        for (let i = 0; i < 4; i++) q.submit(req(`npc${i}`, false, 100 + i, done));

        q.update(slowFinder);
        expect(done.length).toBe(1);
        // ~6 ms spent against a 2 ms grant leaves the queue overdrawn.
        q.update(slowFinder);
        expect(done.length).toBe(1);
        // The debt clears at msPerUpdate per update, so the queue resumes.
        for (let i = 0; i < 4; i++) q.update(slowFinder);
        expect(done.length).toBe(2);
        expect(q.size()).toBe(2);
    });

    test('hero lane wins over nearer crowd', () => {
        const q = new PathRequestQueue();
        const done: string[] = [];
        q.submit(req('crowd-near', false, 1, done));
        q.submit(req('hero-far', true, 10000, done));
        q.update(finder);
        expect(done[0]).toBe('hero-far');
    });

    test('crowd ordered by distance', () => {
        const q = new PathRequestQueue();
        const done: string[] = [];
        q.submit(req('far', false, 900, done));
        q.submit(req('near', false, 4, done));
        q.update(finder);
        expect(done[0]).toBe('near');
    });

    test('coalesces by key: newer replaces queued', () => {
        const q = new PathRequestQueue();
        const done: string[] = [];
        const r1 = req('npc1', false, 100, done);
        const r2 = req('npc1', false, 100, done);
        let firstCalled = false;
        r1.onResult = () => { firstCalled = true; };
        q.submit(r1);
        q.submit(r2);
        q.update(finder);
        expect(firstCalled).toBe(false);
        expect(done).toEqual(['npc1']);
        expect(q.size()).toBe(0);
    });

    test('cancel removes pending', () => {
        const q = new PathRequestQueue();
        const done: string[] = [];
        q.submit(req('npc1', false, 100, done));
        q.cancel('npc1');
        q.update(finder);
        expect(done.length).toBe(0);
    });

    test('global accessor lazily creates and dispose resets', () => {
        const a = getGlobalPathQueue();
        expect(getGlobalPathQueue()).toBe(a);
        disposeGlobalPathQueue();
        expect(getGlobalPathQueue()).not.toBe(a);
    });
});
