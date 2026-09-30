/**
 * Timers that run on GAMEPLAY time, not wall-clock time.
 *
 * Melee hit checks used to ride `setTimeout`: a swing scheduled its contact
 * tests and the wall clock delivered them whether or not the game was still
 * simulating. The PLAYING gate inside each callback stopped hits landing in
 * menus — but a PAUSE mid-swing simply ATE the swing's remaining checks (the
 * timers fired into the gate and were discarded), so unpausing resumed the
 * animation with a strike that could no longer hit anything.
 *
 * These timers advance on `simulationDeltaTime`, which the engine zeroes while
 * paused — so a mid-swing pause holds the remaining hit checks and delivers
 * them when the swing actually continues.
 *
 * Module-level singleton, mirroring getGameStateManager(): timers are global
 * gameplay state, and the engine clears them on game load/dispose so nothing
 * scheduled in one game can fire into the next.
 */

interface GameplayTimer {
    remaining: number;
    callback: () => void;
}

let timers: GameplayTimer[] = [];

/** Run `callback` after `seconds` of GAMEPLAY time (pause-safe). */
export function scheduleGameplaySeconds(seconds: number, callback: () => void): void {
    timers.push({ remaining: Math.max(0, seconds), callback });
}

/** Advance all timers; called once per frame by GameEngine with simulationDeltaTime. */
export function advanceGameplayTimers(deltaSeconds: number): void {
    if (deltaSeconds <= 0 || timers.length === 0) return;
    // Swap-out before firing: a callback may schedule new timers, and those
    // must not be advanced (or dropped) by the tick that spawned them.
    const due: GameplayTimer[] = [];
    const keep: GameplayTimer[] = [];
    for (const t of timers) {
        t.remaining -= deltaSeconds;
        (t.remaining <= 0 ? due : keep).push(t);
    }
    timers = keep;
    for (const t of due) {
        try {
            t.callback();
        } catch (error) {
            console.warn('[GameplayTimers] callback threw:', error);
        }
    }
}

/** Drop every pending timer — called on game load/dispose. */
export function clearGameplayTimers(): void {
    timers = [];
}
