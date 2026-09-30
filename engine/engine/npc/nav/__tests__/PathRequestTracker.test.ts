import * as THREE from 'three';
import { PathRequestTracker } from 'engine/npc/nav/PathRequestTracker.js';
import { PathRequestQueue } from 'engine/npc/nav/PathRequestQueue.js';

describe('PathRequestTracker', () => {
    test('submit -> pending true -> land -> pending false', () => {
        const t = new PathRequestTracker();
        expect(t.isPending()).toBe(false);
        const seq = t.submit();
        expect(t.isPending()).toBe(true);
        t.land(seq);
        expect(t.isPending()).toBe(false);
    });

    test('landing an empty (unreachable) result still clears pending', () => {
        // Mirrors NavigationComponent.onResult: land() runs unconditionally,
        // BEFORE the path is inspected — an unreachable target (empty path)
        // must not leave the controller waiting forever.
        const t = new PathRequestTracker();
        const seq = t.submit();
        const emptyPath: THREE.Vector3[] = [];
        const current = t.isCurrent(seq);
        t.land(seq);
        expect(current).toBe(true);
        expect(emptyPath.length).toBe(0);
        expect(t.isPending()).toBe(false);
    });

    test('cancelAll clears pending (setTargetPosition(null)/clearPath/dispose)', () => {
        const t = new PathRequestTracker();
        t.submit();
        expect(t.isPending()).toBe(true);
        t.cancelAll();
        expect(t.isPending()).toBe(false);
    });

    test('a cancelled request that still lands is not current and stays not-pending', () => {
        const t = new PathRequestTracker();
        const seq = t.submit();
        t.cancelAll();
        expect(t.isCurrent(seq)).toBe(false); // stale result must be dropped
        t.land(seq);
        expect(t.isPending()).toBe(false);
    });

    test('superseded result keeps the newer request pending', () => {
        const t = new PathRequestTracker();
        const first = t.submit();
        const second = t.submit();
        expect(t.isCurrent(first)).toBe(false);
        t.land(first); // old result lands — newer request is still in flight
        expect(t.isPending()).toBe(true);
        expect(t.isCurrent(second)).toBe(true);
        t.land(second);
        expect(t.isPending()).toBe(false);
    });

    test('queue integration: pending clears when the queue serves the request, even with an empty path', () => {
        // Wired the same way NavigationComponent submits: land first, apply
        // only when current.
        const t = new PathRequestTracker();
        const q = new PathRequestQueue();
        let applied: THREE.Vector3[] | null = null;
        const seq = t.submit();
        q.submit({
            key: 'animal-1',
            start: new THREE.Vector3(),
            goal: new THREE.Vector3(5, 0, 5),
            hero: false,
            distSq: 100,
            onResult: (path) => {
                const current = t.isCurrent(seq);
                t.land(seq);
                if (!current) return;
                applied = path;
            },
        });
        expect(t.isPending()).toBe(true);
        q.update(() => []); // unreachable: finder returns an empty path
        expect(t.isPending()).toBe(false);
        expect(applied).toEqual([]);
    });
});
