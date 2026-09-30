/**
 * @fileoverview A pool for short-lived visual effects that keeps their GPU
 * resources alive between uses.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The obvious way to write a burst, trail or arc is to build a mesh when the
 * effect starts and dispose it when the effect fades. That disposes the last
 * material (and geometry) using a shader program, and three.js then deletes
 * the program — on WebGL when the last material referencing it is disposed,
 * on WebGPU when the render object built from that material and geometry is
 * disposed. The NEXT spawn compiles it again, synchronously, on its first
 * draw. Measured in a melee game: 160–210 ms per swing and per hit in a
 * headless profile, a visible hitch on every attack on real hardware.
 *
 * The fix is to never let the program's last user go away: a finished effect
 * is HIDDEN and kept, then re-armed for the next spawn. This pool owns that
 * lifecycle so an effect class only has to implement four members.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 * The owning system holds one pool per effect class and calls `spawn` with a
 * `fits` / `rearm` / `create` triple, ticks the pool from its own `update`,
 * and disposes it from its own `dispose` — the only place GPU resources go.
 * Worked example: agent-docs/performance-best-practices.md, "Effects with a
 * lifetime". Engine users: `WeaponSlashArc`, `HitDebrisSystem`, `AttackVFX`.
 *
 * Register the effect's material with `ShaderKeepAlive` from the owning
 * system's constructor as well, so the program compiles with the scene at
 * load rather than on the first spawn. A `PerfStatsCollector` running in the
 * Creator warns when a program is deleted and compiled again during play —
 * that warning means an effect is bypassing both.
 */

/** What an effect must implement to live in an `EffectPool`. */
export interface PooledEffect {
    /** True once the effect has played out. The pool retires it on its next `update`. */
    readonly isFinished: boolean;
    /** Advance the effect by `deltaTime` seconds. Called only while active. */
    update(deltaTime: number): void;
    /**
     * Hide the effect but KEEP its mesh, geometry and material. The pool will
     * re-arm it later; the program stays cached in the meantime.
     */
    retire(): void;
    /** Free GPU resources. The pool calls this only from its own `dispose()`. */
    dispose(): void;
}

/** How to serve one spawn: reuse an idle effect that fits, else build a new one. */
export interface EffectSpawn<T extends PooledEffect> {
    /**
     * Whether an idle effect can serve this spawn — typically a buffer
     * capacity check. Return `true` when every idle effect is interchangeable.
     */
    fits: (effect: T) => boolean;
    /** Re-arm an idle effect that `fits` for this spawn. */
    rearm: (effect: T) => void;
    /** Build a fresh, already-armed effect when nothing idle fits. */
    create: () => T;
}

/**
 * Active effects are ticked in spawn order and retired when finished; retired
 * effects wait in an idle list until a spawn they fit comes along. The pool
 * only grows to the peak number of simultaneous effects.
 */
export class EffectPool<T extends PooledEffect> {
    private active: T[] = [];
    private idle: T[] = [];
    private disposed = false;

    /** Effects currently playing. */
    get activeCount(): number {
        return this.active.length;
    }

    /** Retired effects waiting for reuse. */
    get idleCount(): number {
        return this.idle.length;
    }

    /** Start an effect, reusing an idle one when possible. Returns the effect. */
    spawn(spawn: EffectSpawn<T>): T {
        if (this.disposed) throw new Error('EffectPool.spawn: pool is disposed');
        let effect: T | null = null;
        for (let i = 0; i < this.idle.length; i++) {
            if (spawn.fits(this.idle[i]!)) {
                effect = this.idle.splice(i, 1)[0]!;
                break;
            }
        }
        if (effect) {
            spawn.rearm(effect);
        } else {
            effect = spawn.create();
        }
        this.active.push(effect);
        return effect;
    }

    /** Tick every active effect and retire the ones that have finished. */
    update(deltaTime: number): void {
        for (let i = this.active.length - 1; i >= 0; i--) {
            const effect = this.active[i]!;
            effect.update(deltaTime);
            if (effect.isFinished) {
                effect.retire();
                this.idle.push(effect);
                this.active.splice(i, 1);
            }
        }
    }

    /**
     * Retire the `count` longest-running active effects now. For hard caps on
     * live effects: retiring the oldest keeps a chaotic burst bounded without
     * refusing to show the newest one.
     */
    retireOldest(count: number): void {
        for (const effect of this.active.splice(0, count)) {
            effect.retire();
            this.idle.push(effect);
        }
    }

    /** Retire every active effect now (level reset). Nothing is disposed. */
    retireAll(): void {
        this.retireOldest(this.active.length);
    }

    /** Free every effect's GPU resources. The pool cannot be used afterwards. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const effect of this.active) effect.dispose();
        for (const effect of this.idle) effect.dispose();
        this.active = [];
        this.idle = [];
    }
}
