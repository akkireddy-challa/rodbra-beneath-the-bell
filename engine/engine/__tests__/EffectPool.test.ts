import { EffectPool, type PooledEffect } from 'engine/effects/EffectPool.js';

/** Synthetic effect: plays for `life` seconds, records every lifecycle call. */
class FakeEffect implements PooledEffect {
    readonly capacity: number;
    age = 0;
    life: number;
    hidden = false;
    disposed = false;
    rearms = 0;

    constructor(capacity: number, life: number) {
        this.capacity = capacity;
        this.life = life;
    }

    get isFinished(): boolean {
        return this.age >= this.life;
    }

    update(deltaTime: number): void {
        this.age += deltaTime;
    }

    rearm(life: number): void {
        this.age = 0;
        this.life = life;
        this.hidden = false;
        this.rearms++;
    }

    retire(): void {
        this.hidden = true;
    }

    dispose(): void {
        this.disposed = true;
    }
}

function spawnOf(pool: EffectPool<FakeEffect>, capacity: number, life: number): FakeEffect {
    return pool.spawn({
        fits: (e) => e.capacity >= capacity,
        rearm: (e) => e.rearm(life),
        create: () => new FakeEffect(capacity, life),
    });
}

describe('EffectPool', () => {
    it('creates when nothing is idle, retires on finish, and reuses the retired effect', () => {
        const pool = new EffectPool<FakeEffect>();
        const first = spawnOf(pool, 10, 1);
        expect(pool.activeCount).toBe(1);
        expect(pool.idleCount).toBe(0);

        pool.update(0.5);
        expect(first.hidden).toBe(false);
        pool.update(0.6);
        expect(first.hidden).toBe(true);
        expect(first.disposed).toBe(false);
        expect(pool.activeCount).toBe(0);
        expect(pool.idleCount).toBe(1);

        const second = spawnOf(pool, 10, 2);
        expect(second).toBe(first);
        expect(second.rearms).toBe(1);
        expect(second.hidden).toBe(false);
        expect(pool.idleCount).toBe(0);
    });

    it('skips idle effects that do not fit and builds a new one', () => {
        const pool = new EffectPool<FakeEffect>();
        const small = spawnOf(pool, 4, 0);
        pool.update(0);
        expect(pool.idleCount).toBe(1);

        const big = spawnOf(pool, 8, 1);
        expect(big).not.toBe(small);
        expect(pool.idleCount).toBe(1);
        expect(pool.activeCount).toBe(1);

        // A later small spawn takes the small idle one, not a new instance.
        expect(spawnOf(pool, 4, 1)).toBe(small);
    });

    it('retireOldest hides the longest-running effects first', () => {
        const pool = new EffectPool<FakeEffect>();
        const a = spawnOf(pool, 1, 10);
        const b = spawnOf(pool, 1, 10);
        const c = spawnOf(pool, 1, 10);
        pool.retireOldest(2);
        expect(a.hidden && b.hidden).toBe(true);
        expect(c.hidden).toBe(false);
        expect(pool.activeCount).toBe(1);
        expect(pool.idleCount).toBe(2);

        pool.retireAll();
        expect(c.hidden).toBe(true);
        expect(pool.activeCount).toBe(0);
    });

    it('dispose frees active and idle effects and refuses further spawns', () => {
        const pool = new EffectPool<FakeEffect>();
        const idle = spawnOf(pool, 1, 0);
        pool.update(0);
        const active = spawnOf(pool, 2, 5);

        pool.dispose();
        expect(idle.disposed).toBe(true);
        expect(active.disposed).toBe(true);
        expect(pool.activeCount + pool.idleCount).toBe(0);
        expect(() => spawnOf(pool, 1, 1)).toThrow(/disposed/);
        pool.dispose(); // idempotent
    });
});
