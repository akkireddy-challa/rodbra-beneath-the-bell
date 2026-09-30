/**
 * PathRequestQueue — serializes navmesh A* work to a fixed budget per frame.
 *
 * NavigationComponent submits pathfinding requests here instead of calling
 * VoxelNavMesh.findPath synchronously; CharacterLodScheduler.evaluate drains
 * the queue once per frame. Two lanes: heroes always win, crowd requests are
 * served nearest-to-camera first. Requests coalesce by key (one pending
 * request per NPC), so a rapid re-target simply replaces the queued request.
 *
 * LOAD-BEARING: neither lane ages, so nothing here stops a steady stream of
 * hero (or nearer crowd) requests from starving a distant crowd NPC forever.
 * What prevents that is OUTSIDE the queue — NpcController re-submits while it
 * has no path, every REPATH_MIN_INTERVAL_S (0.3 s). Remove that resubmit and
 * this queue needs aging/priority decay to stay live.
 */
import * as THREE from 'three';

export interface PathRequest {
    /** Coalescing key — one pending request per key (use the NPC id). */
    key: string;
    start: THREE.Vector3;
    goal: THREE.Vector3;
    extraObstacles?: ReadonlyArray<{ x: number; z: number; radius: number }>;
    maxPathLength?: number;
    hero: boolean;
    /** Squared camera distance at submit time — crowd priority. */
    distSq: number;
    onResult(path: THREE.Vector3[]): void;
}

export type PathFinder = (
    start: THREE.Vector3, goal: THREE.Vector3,
    extraObstacles?: ReadonlyArray<{ x: number; z: number; radius: number }>,
    maxPathLength?: number,
) => THREE.Vector3[];

/**
 * Per-update drain budget. The binding constraint is TIME, not count: one
 * layered A* over a large level costs a median ~19 ms and up to ~29 ms, so
 * "one request per frame" is not a bound at all — it is one 20 ms hitch every
 * frame. Overspend is carried into later updates, which spreads a single
 * expensive search over the frames that follow instead of paying it again.
 */
export interface PathQueueBudget {
    /** Pathfinding milliseconds granted per update. */
    msPerUpdate: number;
    /** Hard cap on searches served per update, even when the budget still allows more. */
    maxRequestsPerUpdate: number;
    /** Largest overspend carried forward, so one very expensive search cannot mute the queue for seconds. */
    maxCarryOverMs: number;
}

export const DEFAULT_PATH_QUEUE_BUDGET: PathQueueBudget = {
    msPerUpdate: 2,
    maxRequestsPerUpdate: 4,
    maxCarryOverMs: 60,
};

export class PathRequestQueue {
    private heroLane = new Map<string, PathRequest>();
    private crowdLane = new Map<string, PathRequest>();
    private readonly budget: PathQueueBudget;
    /** Unspent (positive) or overspent (negative) milliseconds carried between updates. */
    private carriedMs = 0;

    constructor(budget: PathQueueBudget = DEFAULT_PATH_QUEUE_BUDGET) {
        this.budget = budget;
    }

    submit(req: PathRequest): void {
        this.heroLane.delete(req.key);
        this.crowdLane.delete(req.key);
        (req.hero ? this.heroLane : this.crowdLane).set(req.key, req);
    }

    cancel(key: string): void {
        this.heroLane.delete(key);
        this.crowdLane.delete(key);
    }

    size(): number { return this.heroLane.size + this.crowdLane.size; }

    /**
     * Spend this update's pathfinding budget. Call once per frame.
     *
     * A partially drained queue is correct: a path that arrives a few frames
     * late is invisible, a 29 ms hitch is not. An A* call cannot be interrupted
     * once started, so a search that overruns the budget is paid for by the
     * following updates (bounded by `maxCarryOverMs`) rather than by the frame
     * that happened to pop it.
     */
    // eslint-disable-next-line game-conventions/update-method-signature -- not a dt tick; consumes the queue with the caller-supplied pathfinder
    update(finder: PathFinder): void {
        this.carriedMs = Math.min(this.carriedMs + this.budget.msPerUpdate, this.budget.msPerUpdate);
        for (let i = 0; i < this.budget.maxRequestsPerUpdate; i++) {
            if (this.carriedMs <= 0) return;
            const req = this.pickNext();
            if (!req) {
                // Nothing to serve: an idle queue must not bank credit, or the
                // first frame after a lull would fire several searches at once.
                this.carriedMs = 0;
                return;
            }
            const startedAt = performance.now();
            const path = finder(req.start, req.goal, req.extraObstacles, req.maxPathLength);
            this.carriedMs = Math.max(this.carriedMs - (performance.now() - startedAt), -this.budget.maxCarryOverMs);
            req.onResult(path);
        }
    }

    private pickNext(): PathRequest | null {
        if (this.heroLane.size > 0) {
            const first = this.heroLane.keys().next().value as string;
            const req = this.heroLane.get(first) ?? null;
            if (req) this.heroLane.delete(first);
            return req;
        }
        let best: PathRequest | null = null;
        for (const req of this.crowdLane.values()) {
            if (!best || req.distSq < best.distSq) best = req;
        }
        if (best) this.crowdLane.delete(best.key);
        return best;
    }
}

let globalQueue: PathRequestQueue | null = null;

export function getGlobalPathQueue(): PathRequestQueue {
    if (!globalQueue) globalQueue = new PathRequestQueue();
    return globalQueue;
}

export function disposeGlobalPathQueue(): void {
    globalQueue = null;
}
