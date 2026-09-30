/**
 * Generic object pool to avoid create/destroy churn.
 *
 * Use for projectiles, particles, effects, or any object that is
 * frequently spawned and despawned.
 */
export class ObjectPool<T> {
    private pool: T[] = [];
    private active = new Set<T>();
    private factory: () => T;
    private resetFn: (obj: T) => void;

    /**
     * @param factory  - Creates a new instance when the pool is empty.
     * @param reset    - Called on release to prepare an object for reuse.
     * @param initialSize - Pre-warm this many instances on construction.
     */
    constructor(factory: () => T, reset: (obj: T) => void, initialSize = 0) {
        this.factory = factory;
        this.resetFn = reset;

        if (initialSize > 0) {
            this.prewarm(initialSize);
        }
    }

    /** Get an object from the pool, or create a new one if empty. */
    get(): T {
        const obj = this.pool.length > 0 ? (this.pool.pop() as T) : this.factory();
        this.active.add(obj);
        return obj;
    }

    /**
     * Return an object to the pool. Calls the reset function.
     * Double-release is safely ignored.
     */
    release(obj: T): void {
        if (!this.active.delete(obj)) return; // already released or never checked out
        this.resetFn(obj);
        this.pool.push(obj);
    }

    /** Release all currently active objects back to the pool. */
    releaseAll(): void {
        for (const obj of this.active) {
            this.resetFn(obj);
            this.pool.push(obj);
        }
        this.active.clear();
    }

    /** Number of objects currently checked out. */
    get activeCount(): number {
        return this.active.size;
    }

    /** Number of objects available in the pool. */
    get poolSize(): number {
        return this.pool.length;
    }

    /** Pre-create objects so they're ready when needed. */
    prewarm(count: number): void {
        for (let i = 0; i < count; i++) {
            const obj = this.factory();
            this.resetFn(obj);
            this.pool.push(obj);
        }
    }
}
